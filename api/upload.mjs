// =====================================================
// Vercel Serverless Function — POST /api/upload
// =====================================================
// Pipeline:
//  1. Upload exam PDF to Cloudinary (as PDF; we use pg_ / c_crop to serve pages)
//  2. Extract text-layer positions via unpdf (pdf.js) — locate "שאלה N" headings
//  3. Filter to MCQs (regions with א./ב./ג./ד. or 1./2./3./4. options)
//  4. Compute exact Cloudinary crop pixels from the REAL page dimensions
//     (fixes the old hardcoded RENDER_H=2070 that broke A4 PDFs)
//  5. In parallel, send solution PDF to Gemini to extract {question → answer}
//  6. Fallback: if text layer found no MCQs (image-only / scanned PDF) — use
//     Gemini Vision on the exam PDF
// =====================================================

import { createClient } from '@supabase/supabase-js';
import { extractPositions, buildLines } from './_lib/pdf-positions.mjs';
import {
  findQuestionRange,
  findSectionHeadings,
  findStandaloneQuestions,
  findBottomBoundary,
  classifyRegion,
  extractRegionText,
  detectMCQsFromPositions,
} from './_lib/pdf-mcq-detect.mjs';
import { applyGroupContextToCrops, extractContextText } from './_lib/pdf-group-context.mjs';
import { extractAnchorsFromSolutionText, crossValidateAnswers } from './_lib/anchor-matcher.mjs';
import {
  analyzeExamWithGemini,
  classifyPdfWithGemini,
  analyzeSolutionPdf,
  scanExamHighlights,
  normalizeGeminiMcqs,
  verifySolutionMatchesExam,
  detectSolutionPages,
} from './_lib/gemini-solution.mjs';
import { MODEL_CHAIN } from './_lib/gemini-models.mjs';
import { getGeminiKeys } from './_lib/gemini-key.mjs';
import { getQuota } from './_lib/quotas.mjs';
import { checkBurst, checkGlobalBudget } from './_lib/burst-check.mjs';
import { assertNotModelim } from './_lib/seed-guard.mjs';

export const config = { api: { bodyParser: false }, maxDuration: 300 };

const MAX_PDF_BYTES = 15 * 1024 * 1024;

// Cloudinary renders the PDF at this width. Height is computed per-page
// from the actual page dimensions, so A4 vs Letter no longer matters.
const CLOUDINARY_RENDER_W = 1600;
// PDF-coordinate margins around each question so the crop isn't flush to text.
// Kept MODEST — upload.mjs runs a clampYBottomToNextMcq pass that further
// shrinks yBottom so it never bleeds into the next question's crop.
const CROP_MARGIN_TOP_PT = 18;
const CROP_MARGIN_BOTTOM_PT = 18;

// ===== Supabase =====
let _admin = null;
function getAdmin() {
  if (!_admin && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    _admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  }
  return _admin;
}
function userClient(jwt) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ===== Auth =====
async function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.substring(7);
  const client = getAdmin() || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id, db: userClient(token) };
}

// ===== Multipart parsing =====
function rawBody(req, limit = MAX_PDF_BYTES + 512 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.body && Buffer.isBuffer(req.body)) return resolve(req.body);
    if (req.body && typeof req.body === 'string') return resolve(Buffer.from(req.body));
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('Body too large')); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Hardened multipart parser — enforces strict limits to prevent memory/DoS abuse.
const MAX_MULTIPART_PARTS = 10;
const MAX_MULTIPART_HEADER_BYTES = 8192;
const MAX_MULTIPART_BOUNDARY_BYTES = 256;

function parseMultipart(buf, contentType) {
  const bm = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!bm) throw new Error('No multipart boundary');
  const boundary = bm[1] || bm[2];
  if (boundary.length > MAX_MULTIPART_BOUNDARY_BYTES) {
    throw new Error('Multipart boundary exceeds maximum length');
  }
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(sep);
  while (start !== -1) {
    if (parts.length >= MAX_MULTIPART_PARTS) {
      throw new Error(`Too many multipart parts (limit ${MAX_MULTIPART_PARTS})`);
    }
    start += sep.length;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    const next = buf.indexOf(sep, start);
    if (next === -1) break;
    const part = buf.slice(start, next - 2);
    const hEnd = part.indexOf('\r\n\r\n');
    if (hEnd === -1) { start = next; continue; }
    if (hEnd > MAX_MULTIPART_HEADER_BYTES) {
      throw new Error('Multipart header exceeds maximum size');
    }
    const hdr = part.slice(0, hEnd).toString('utf8');
    parts.push({
      name: hdr.match(/name="([^"]+)"/)?.[1] || '',
      filename: hdr.match(/filename="([^"]+)"/)?.[1] || null,
      data: part.slice(hEnd + 4),
    });
    start = next;
  }
  return parts;
}

function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

// ===== Filename similarity matching =====
function normalizeFilename(filename) {
  if (!filename) return '';
  return filename
    .toLowerCase()
    .replace(/\.[^/.]+$/, '') // remove extension
    .replace(/\b(exam|test|solution|answers|answer key|מבחן|בחינה|פתרון|תשובות|מפתח)\b/gi, '')
    .replace(/[^\w\u0590-\u05FF]/g, ' ') // keep Hebrew/English alphanumerics, replace special chars with space
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .trim();
}

function filenamesSimilar(name1, name2, threshold = 0.55) {
  const norm1 = normalizeFilename(name1);
  const norm2 = normalizeFilename(name2);

  // If both normalize to empty, consider them unrelated
  if (!norm1 || !norm2) return false;

  // Extract tokens
  const tokens1 = new Set(norm1.split(/\s+/).filter(Boolean));
  const tokens2 = new Set(norm2.split(/\s+/).filter(Boolean));

  // Jaccard similarity: intersection / union
  const intersection = [...tokens1].filter(t => tokens2.has(t)).length;
  const union = new Set([...tokens1, ...tokens2]).size;

  return union === 0 ? false : (intersection / union) >= threshold;
}

// =====================================================
// PDF text-layer analysis (pdf.js via unpdf)
// =====================================================
// Helpers live in api/_lib/:
//   extractPositions, buildLines                 → pdf-positions.mjs
//   findQuestionRange, findSectionHeadings, findStandaloneQuestions,
//   findBottomBoundary, classifyRegion, extractRegionText,
//   detectMCQsFromPositions                      → pdf-mcq-detect.mjs
//   applyGroupContextToCrops, extractContextText → pdf-group-context.mjs
// =====================================================

// Build a Cloudinary URL that crops page `page` of `publicId` to exactly the
// rectangle containing this MCQ. `pageWidth` / `pageHeight` must be the real
// PDF page dimensions (in points) — we derive the rendered height from them
// instead of assuming a hardcoded 2070.
function buildCropUrl(cloudName, publicId, mcq) {
  const scale = CLOUDINARY_RENDER_W / mcq.pageWidth;
  const renderH = Math.round(CLOUDINARY_RENDER_W * (mcq.pageHeight / mcq.pageWidth));
  const yPx = Math.max(0, Math.round((mcq.yTop - CROP_MARGIN_TOP_PT) * scale));
  const rawH = Math.round((mcq.yBottom - mcq.yTop + CROP_MARGIN_TOP_PT + CROP_MARGIN_BOTTOM_PT) * scale);
  const hPx = Math.max(150, Math.min(renderH - yPx, rawH));
  return `https://res.cloudinary.com/${cloudName}/image/upload/pg_${mcq.page},w_${CLOUDINARY_RENDER_W}/c_crop,w_${CLOUDINARY_RENDER_W},h_${hPx},y_${yPx},g_north/q_auto/${publicId}.png`;
}

// Fallback URL when per-question bbox is unreliable (e.g. Gemini returned
// y_top=y_bottom=0 for a scanned PDF). Renders the whole page at the same
// width as crops — user sees the full page inside the question card, which
// is useful-ish instead of a blank strip.
function buildFullPageUrl(cloudName, publicId, page) {
  const safePage = Number.isFinite(page) && page >= 1 ? page : 1;
  return `https://res.cloudinary.com/${cloudName}/image/upload/pg_${safePage},w_${CLOUDINARY_RENDER_W}/q_auto/${publicId}.png`;
}

// Decide whether an MCQ's bbox is good enough to crop. If not, the caller
// falls back to buildFullPageUrl so the card never shows an empty strip.
function isBboxUsable(mcq, pdfPageCount) {
  if (!mcq) return false;
  if (mcq._bboxInvalid) return false;
  if (!(mcq.pageWidth > 0) || !(mcq.pageHeight > 0)) return false;
  if (!Number.isFinite(mcq.page) || mcq.page < 1) return false;
  if (pdfPageCount && mcq.page > pdfPageCount) return false;
  if (!(mcq.yBottom > mcq.yTop)) return false;
  const heightPt = mcq.yBottom - mcq.yTop;
  if (heightPt < 50) return false;
  if (heightPt / mcq.pageHeight > 0.95) return false;
  return true;
}

// =====================================================
// Cloudinary upload
// =====================================================
async function uploadPdfToCloudinary({ cloudName, apiKey, apiSecret, pdfBase64, publicId }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { createHash } = await import('node:crypto');
  const signature = createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file: `data:application/pdf;base64,${pdfBase64}`,
      public_id: publicId,
      api_key: apiKey,
      timestamp,
      signature,
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    console.error(`[cloudinary] ${r.status}:`, errText.slice(0, 200));
    return null;
  }
  const d = await r.json();
  return d.public_id;
}

// =====================================================
// Local solution-PDF parser (FREE, no Gemini!)
// =====================================================
// Extracts text from the solution PDF using unpdf, then walks through lines
// to find question headers and their associated solution text + answer key.
//
// Returns: { [qNumber]: { answer: 1-4|null, rawText: string } } or null if
// the PDF has no text layer (scanned).
async function parseSolutionPdf(solPdfBytes) {
  const pages = await extractPositions(solPdfBytes).catch(() => null);
  if (!pages || pages.length === 0) return null;

  // Flatten all pages into a single ordered stream of lines (across pages).
  const allLines = [];
  for (const page of pages) {
    const lines = buildLines(page);
    for (const l of lines) {
      allLines.push({ ...l, page: page.page });
    }
  }
  if (allLines.length === 0) return null;

  // Walk the lines looking for question headers. Recognize:
  //   "שאלה 1", "שאלה 2:", "שאלה 3 -", "פתרון לשאלה 4", "פתרון שאלה 5"
  //   "תשובה 1", "סעיף א"
  // NOTE: previously had `altHeaderRe` that matched "\\d+[.):]\\s" but that
  // caused false positives on exam-instruction lines like "3. חומר עזר מותר",
  // which polluted solution_text_raw with garbage. Removed.
  const headerRe = /(?:שאלה|פתרון(?:\s+ל?שאלה)?|סעיף|תשובה(?:\s+לשאלה)?)\s*(\d{1,3})\b/;

  const sections = []; // [{number, startIdx}]
  for (let i = 0; i < allLines.length; i++) {
    const text = allLines[i].text;
    if (text.length > 300) continue;
    const m = text.match(headerRe);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (!num || num < 1 || num > 100) continue;
    if (sections.find(s => s.number === num)) continue;
    sections.push({ number: num, startIdx: i });
  }

  if (sections.length === 0) return null;
  sections.sort((a, b) => a.startIdx - b.startIdx);

  // For each section, the raw text is everything from startIdx up to (but not
  // including) the next section's startIdx.
  const out = {};
  const answerMarkers = [
    /(?:תשובה(?:\s+נכונה)?|התשובה\s+(?:ה)?נכונה|תשובה\s+סופית|Answer)\s*[:=\-–]?\s*([א-ד1-4])/,
    /^\s*([א-ד1-4])\s*[.)]?\s*(?:זוהי|היא|-)\s+(?:התשובה|נכונה)/,
    /(?:הקיפו|סימון)\s+([א-ד1-4])/,
  ];
  const letterMap = { 'א': 1, 'ב': 2, 'ג': 3, 'ד': 4 };

  for (let s = 0; s < sections.length; s++) {
    const start = sections[s].startIdx;
    const end = s + 1 < sections.length ? sections[s + 1].startIdx : allLines.length;
    const sectionLines = allLines.slice(start, end);
    const rawText = sectionLines.map(l => l.text).join('\n').trim();

    // Find the answer marker in the first few lines (most likely location).
    let answer = null;
    for (let i = 0; i < Math.min(sectionLines.length, 12); i++) {
      const t = sectionLines[i].text;
      for (const re of answerMarkers) {
        const m = t.match(re);
        if (m) {
          const raw = m[1];
          if (/\d/.test(raw)) answer = parseInt(raw, 10);
          else answer = letterMap[raw] || null;
          if (answer >= 1 && answer <= 4) break;
          answer = null;
        }
      }
      if (answer) break;
    }

    // Fallback: look for a standalone אאבגד/1234 on its own line near the start.
    if (!answer) {
      for (let i = 0; i < Math.min(sectionLines.length, 8); i++) {
        const t = sectionLines[i].text.trim();
        const m = t.match(/^([א-ד])\s*[.)]?\s*$|^([1-4])\s*[.)]?\s*$/);
        if (m) {
          const raw = m[1] || m[2];
          if (/\d/.test(raw)) answer = parseInt(raw, 10);
          else answer = letterMap[raw] || null;
          if (answer >= 1 && answer <= 4) break;
          answer = null;
        }
      }
    }

    out[String(sections[s].number)] = { answer, rawText };
  }

  return out;
}

// =====================================================
// Pass 2 — Aggressive flat scan (FREE, no Gemini)
// =====================================================
// Extracts ALL text from solution PDF and scans for simple number→letter
// patterns like "1. ב", "1: ב", "1-ב" — catches answer tables that don't
// have section headers (which parseSolutionPdf requires).
async function flatScanAnswers(pdfBytes) {
  const pages = await extractPositions(pdfBytes).catch(() => null);
  if (!pages || pages.length === 0) return {};
  const allText = pages.flatMap(p => buildLines(p)).map(l => l.text).join('\n');
  console.log(`[flat-scan] text length: ${allText.length}, sample: ${allText.slice(0, 200)}`);
  const letterMap = { 'א': 1, 'ב': 2, 'ג': 3, 'ד': 4 };
  const answers = {};
  // Letter answers: "1. ב", "1: ב", "1-ב", "1 ב" — use matchAll to avoid undeclared `m` in strict mode
  for (const m of allText.matchAll(/\b(\d{1,2})\s*[.:\-–—]?\s*([א-ד])\b/g)) {
    const q = parseInt(m[1], 10); const ans = letterMap[m[2]];
    if (q >= 1 && q <= 60 && ans) answers[String(q)] = ans;
  }
  // Digit answers: "1. 2", "1: 3"
  for (const m of allText.matchAll(/\b(\d{1,2})\s*[.:\-–—]\s*([1-4])\b/g)) {
    const q = parseInt(m[1], 10); const ans = parseInt(m[2], 10);
    if (q >= 1 && q <= 60 && !answers[String(q)]) answers[String(q)] = ans;
  }
  const count = Object.keys(answers).length;
  console.log(`[flat-scan] found ${count} answers:`, JSON.stringify(answers));
  return count >= 2 ? answers : {};
}

// =====================================================
// Pass 3 — Gemini vision on SOLUTION PDF only (near-zero cost)
// =====================================================
// Sends ONLY the solution PDF (not the exam) — half the tokens, twice as
// fast, works for visual markings (yellow highlights, circles) and text.
// Uses MODEL_CHAIN.critical (strong → primary → fallback).
async function extractAnswersWithGemini(solutionPdfBase64, questionNumbers, plan = 'trial') {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!freeKey && !paidKey) return null;

  const list = questionNumbers.join(', ');
  const prompt = `This is a Hebrew university exam solution PDF.
Find the correct MCQ answer for each of these question numbers: ${list}

The answer key may appear in ANY of these formats:
- Table: "שאלה | תשובה" with rows like "1 | ב"
- List: "1. ב", "1: ב", "1-ב", "(1) ב"
- Inline: "תשובה לשאלה 1: ב" or "שאלה 1 — ב"
- Visual: highlighted/circled option on the exam itself
- Numbers: "1. 2" where 1=א, 2=ב, 3=ג, 4=ד

Return a JSON array — ONLY the array, no text, no explanation:
[{"q":1,"ans":2},{"q":2,"ans":1},...]
"ans" values: 1=א, 2=ב, 3=ג, 4=ד
Skip questions you cannot find. Include any answer you can identify, even if not 100% certain.`;

  const parts = [
    { text: prompt },
    { inlineData: { mimeType: 'application/pdf', data: solutionPdfBase64 } },
  ];

  // Returns { answers, quota_exceeded } or null
  async function callModel(model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.0,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
          // responseSchema removed — uppercase type names caused silent API failures
        },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[answer-extract] ${model} ${r.status}:`, errText.slice(0, 300));
      return r.status === 429 ? { quota_exceeded: true } : null;
    }
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    console.log(`[answer-extract] ${model} raw: ${text.slice(0, 300)}`);

    // Try direct parse first (responseMimeType: 'application/json' should give clean JSON)
    let parsed = null;
    try { parsed = JSON.parse(text.trim()); } catch {}
    // Fallback: extract first JSON array found anywhere in the response
    if (!parsed) {
      const jsonMatch = text.match(/(\[[\s\S]*?\])/);
      if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[1]); } catch {} }
    }
    if (!parsed) {
      console.warn(`[answer-extract] ${model} could not parse JSON from response`);
      return null;
    }

    const normalized = {};
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const q = parseInt(item?.q, 10);
        const ans = parseInt(item?.ans, 10);
        if (q > 0 && ans >= 1 && ans <= 4) normalized[String(q)] = ans;
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        const ans = parseInt(v, 10);
        if (ans >= 1 && ans <= 4) normalized[String(parseInt(k, 10))] = ans;
      }
    }
    return { answers: normalized };
  }

  // Answer extraction is user-visible accuracy — lead with the strongest model.
  const models = MODEL_CHAIN.critical;

  for (const model of models) {
    try {
      let res = freeKey ? await callModel(model, freeKey) : null;
      if (res?.quota_exceeded && paidKey) {
        console.warn(`[answer-extract] ${model} free quota exhausted — switching to paid key`);
        res = await callModel(model, paidKey);
      }
      const result = res?.answers;
      if (result && Object.keys(result).length > 0) {
        console.log(`[answer-extract] ${model} found ${Object.keys(result).length}/${questionNumbers.length} answers`);
        return { answers: result, model };
      }
      console.warn(`[answer-extract] ${model} returned empty`);
    } catch (e) {
      console.warn(`[answer-extract] ${model} exception:`, e.message);
    }
  }
  return null;
}

// =====================================================
// Gemini fallback — full exam extraction (scanned/image-only PDFs)
// analyzeExamWithGemini, classifyPdfWithGemini, analyzeSolutionPdf,
// normalizeGeminiMcqs, verifySolutionMatchesExam → imported from ./_lib/gemini-solution.mjs

// =====================================================
// REMOVED — now in api/_lib/gemini-solution.mjs
// async function analyzeExamWithGemini(examPdfBase64, solPdfBase64) {
//   const freeKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();

// =====================================================
// Gemini — batched solution generation (OPTIMIZED)
// =====================================================
// ONE Gemini call per exam (not per question). Sends exam PDF + solution PDF
// once, returns solutions for ALL questions in a single JSON array.
// Previous approach was 40+ calls per 10-question exam → this is 1 call.
// Cost reduction: ~6x (from ~$0.028/exam to ~$0.005/exam).

async function callGeminiJsonWithUsage(prompt, pdfParts, { temperature = 0.2, maxOutputTokens = 16384, timeoutMs = 60000 } = {}) {
  const { paidKey, freeKey } = getGeminiKeys();
  const primaryKey = paidKey || freeKey;
  const fallbackKey = paidKey && freeKey ? freeKey : null;
  if (!primaryKey) return { data: null, usage: null, error: 'no-api-key' };
  console.log(`[gemini-batch] using ${paidKey ? 'paid' : 'free'} key as primary`);
  const parts = [{ text: prompt }, ...pdfParts];
  const models = MODEL_CHAIN.extraction;
  let lastError = null;

  async function fetchWithKey(apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature,
          maxOutputTokens,
          responseMimeType: 'application/json',
          mediaResolution: 'MEDIA_RESOLUTION_HIGH',
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  for (const model of models) {
    try {
      let r = await fetchWithKey(primaryKey, model);
      if (r.status === 429 && fallbackKey) {
        console.warn(`[gemini-batch] ${model} primary quota exceeded — switching to fallback key`);
        r = await fetchWithKey(fallbackKey, model);
      }
      if (!r.ok) {
        lastError = `${model}:${r.status}`;
        const errBody = await r.text().catch(() => '');
        console.warn(`[gemini-batch] ${model} ${r.status}:`, errBody.slice(0, 200));
        continue;
      }
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      try {
        const data = JSON.parse(cleaned);
        const usage = j.usageMetadata || null;
        return { data, usage, model, error: null };
      } catch (e) {
        lastError = `${model}:parse`;
        continue;
      }
    } catch (e) {
      lastError = `${model}:${e.message}`;
    }
  }
  return { data: null, usage: null, error: lastError };
}

// Main batched generator — ONE call for the whole exam.
// Returns: { solutions: {[qNumber]: {correct, general_explanation, option_explanations}}, usage: {input_tokens, output_tokens, cost_usd}, error }
async function generateAllSolutions(mcqs, examBase64, solBase64, answers) {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!freeKey && !paidKey) {
    console.warn('[solutions] no GEMINI_API_KEY configured, skipping');
    return { solutions: {}, usage: null, error: 'no-api-key' };
  }

  const tStart = Date.now();
  const questionNumbers = mcqs.map(q => q.number).filter(Boolean);
  const answerHints = Object.entries(answers || {}).filter(([, v]) => v).map(([k, v]) => `Q${k}=${v}`).join(', ');

  const hasSolution = !!solBase64;
  const prompt = `You are reviewing a Hebrew university multiple-choice exam${hasSolution ? ' WITH its official solution key PDF' : ''}.

Your task: For EACH of the following questions in the exam PDF, produce a detailed Hebrew explanation.
Questions to solve: ${questionNumbers.join(', ')}
${answerHints ? `\nKnown correct answers from answer key extraction: ${answerHints}` : ''}
${hasSolution ? '\nUse the solution PDF as GROUND TRUTH for correct answers and reasoning. The solution PDF contains the official answers.' : '\nNo solution PDF provided — solve from first principles using the exam PDF.'}

Return a JSON array with EXACTLY one object per question, in this shape:
[
  {
    "n": <question number (integer)>,
    "correct": <correct option index (1–10; biology exams may have up to 10 options)>,
    "general_explanation": "<2-4 sentence Hebrew paragraph explaining the core concept and why the correct answer is correct>",
    "option_explanations": [
      {"idx": 1, "isCorrect": <bool>, "explanation": "<2+ Hebrew sentences: WHY this option is right/wrong>"},
      {"idx": 2, "isCorrect": <bool>, "explanation": "..."},
      ... (include ALL options for this question, up to 10)
    ]
  }
]

STRICT RULES:
- Return ONE entry per question in the questions-to-solve list. Do NOT skip any.
- Exactly ONE option per question must have isCorrect: true.
- Include ALL answer options for each question in option_explanations (some questions have 5–10 options).
- Each option_explanation must be at least 2 full Hebrew sentences explaining the WHY.
- Write in clean academic Hebrew. Do not copy verbatim from the solution PDF — synthesize.
- Output ONLY the JSON array. No markdown fences, no commentary.`;

  const examPart = { inlineData: { mimeType: 'application/pdf', data: examBase64 } };
  const parts = [examPart];
  if (solBase64) {
    parts.push({ text: '\n\n--- SOLUTION KEY PDF (use as ground truth) ---' });
    parts.push({ inlineData: { mimeType: 'application/pdf', data: solBase64 } });
  }

  const result = await callGeminiJsonWithUsage(prompt, parts, {
    temperature: 0.1,
    maxOutputTokens: 16384,
    timeoutMs: 90000,
  });

  if (!result.data || !Array.isArray(result.data)) {
    console.error(`[solutions] batched call failed: ${result.error || 'invalid response shape'}`);
    return { solutions: {}, usage: result.usage, error: result.error || 'invalid-shape' };
  }

  // Normalize the response into a {qNumber: solution} map
  // Find the corresponding MCQ to know how many options it has (up to 10).
  const mcqByNumber = new Map(mcqs.map(q => [q.number, q]));
  const out = {};
  for (const entry of result.data) {
    const n = parseInt(entry?.n, 10);
    if (!n || isNaN(n)) continue;
    const numOpts = mcqByNumber.get(n)?.numOptions || 4;
    const correct = Math.max(1, Math.min(numOpts, parseInt(entry.correct, 10) || 1));
    const rawOpts = Array.isArray(entry.option_explanations) ? entry.option_explanations : [];
    const normalizedOpts = Array.from({ length: numOpts }, (_, i) => {
      const idx = i + 1;
      const found = rawOpts.find(o => parseInt(o?.idx, 10) === idx);
      return {
        idx,
        isCorrect: idx === correct,
        explanation: (found?.explanation || '').toString().trim(),
      };
    });
    out[String(n)] = {
      correct,
      general_explanation: (entry.general_explanation || '').toString().trim(),
      option_explanations: normalizedOpts,
    };
  }

  // Cost calculation (Gemini 2.5 Flash pricing: $0.075/1M input, $0.30/1M output)
  const inputTokens = result.usage?.promptTokenCount || 0;
  const outputTokens = result.usage?.candidatesTokenCount || 0;
  const costUsd = (inputTokens * 0.075 + outputTokens * 0.30) / 1_000_000;

  console.log(
    `[solutions] batched: ${Object.keys(out).length}/${mcqs.length} questions in ${Date.now() - tStart}ms ` +
    `(model=${result.model}, in=${inputTokens}t, out=${outputTokens}t, ~$${costUsd.toFixed(5)})`
  );

  return {
    solutions: out,
    usage: { inputTokens, outputTokens, costUsd, model: result.model },
    error: null,
  };
}

// Quick document-type classifier — called only when 0 MCQs detected.
// Returns { type: 'exam'|'solution'|'notes'|'blank'|'other', reason: string } or null.
// =====================================================
// Cross-verify extracted answers with Groq (independent second opinion)
//
// For each answer that Gemini extracted from the solution PDF, ask Groq to
// solve the question independently (question text + options only, no solution
// PDF context). If Groq's answer matches Gemini's → 'agree'. If Groq picks a
// different option → 'disagree' (the UI will demote to 'uncertain'). If the
// question has no text (scanned PDF) or Groq fails → 'skip' (fall back to
// trusting Gemini alone).
//
// This catches the class of bugs where Gemini misread a colored-highlight or
// a table row and confidently committed the wrong option. Groq is free and
// fast (~2s per question in parallel), so the added cost is ~zero.
// =====================================================
async function crossVerifyAnswersWithGroq(mcqs, answers) {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey || Object.keys(answers).length === 0) return {};

  const results = {};

  // Process questions in parallel, with graceful per-question error handling
  const tasks = Object.entries(answers).map(async ([qNumStr, geminiAns]) => {
    try {
      const qNum = parseInt(qNumStr, 10);
      const mcq = mcqs.find(m => m.number === qNum);
      if (!mcq) { results[qNumStr] = 'skip'; return; }

      const stemText = String(mcq.questionStemText || '').trim();
      const opts = mcq.optionTexts || {};
      const optsArr = [1, 2, 3, 4].map(i => String(opts[i] || opts[String(i)] || '').trim());
      const nonEmptyOpts = optsArr.filter(o => o.length > 0);

      // Can't cross-verify without enough text to work with
      if (stemText.length < 10 || nonEmptyOpts.length < 2) {
        results[qNumStr] = 'skip';
        return;
      }

      const optionsList = optsArr.map((o, i) => `${i + 1}. ${o || '(ריק)'}`).join('\n');
      const prompt = `להלן שאלה אמריקאית מבחינה אקדמית בעברית. פתור אותה באופן עצמאי וחזיר את האפשרות הנכונה.

שאלה: ${stemText}

האפשרויות:
${optionsList}

נתח את השאלה בקפידה, שקול כל אפשרות, וקבע מהי האפשרות הנכונה. החזר JSON בלבד:
{
  "correct": <1|2|3|4>,
  "confidence": <0.0-1.0>,
  "reasoning": "<שתי משפטים קצרים>"
}

אם אינך בטוח בתשובה — החזר "confidence": 0.0 ו-"correct": null. עדיף לא לענות מאשר לטעות.`;

      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'אתה פרופסור מומחה שפותר שאלות אמריקאיות באקדמיה. אתה מדויק ולא מנחש.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 512,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (!r.ok) { results[qNumStr] = 'skip'; return; }
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content || '';
      let parsed;
      try { parsed = JSON.parse(text); } catch { results[qNumStr] = 'skip'; return; }

      const groqAns = parseInt(parsed?.correct, 10);
      const groqConf = typeof parsed?.confidence === 'number' ? parsed.confidence : 0;

      // If Groq isn't confident either, we can't use it as a veto — skip
      if (!(groqAns >= 1 && groqAns <= 4) || groqConf < 0.6) {
        results[qNumStr] = 'skip';
        return;
      }

      results[qNumStr] = (groqAns === geminiAns) ? 'agree' : 'disagree';
      if (results[qNumStr] === 'disagree') {
        console.warn(`[cross-verify] Q${qNum}: Gemini=${geminiAns}, Groq=${groqAns} → uncertain (Groq reasoning: ${(parsed?.reasoning || '').slice(0, 120)})`);
      }
    } catch (e) {
      results[qNumStr] = 'skip';
    }
  });

  await Promise.all(tasks);
  const agreeCount = Object.values(results).filter(v => v === 'agree').length;
  const disagreeCount = Object.values(results).filter(v => v === 'disagree').length;
  const skipCount = Object.values(results).filter(v => v === 'skip').length;
  console.log(`[cross-verify] ${agreeCount} agree / ${disagreeCount} disagree / ${skipCount} skip`);
  return results;
}

// =====================================================
// Handler
// =====================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  let examId = null;
  // Hoisted from inside the `if (mcqs.length > 0)` block so the post-insert
  // status gate (awaiting_review vs ready) can read it from the outer scope.
  let reviewCount = 0;
  let cloudinaryDeliveryBlocked = false;

  // preUploaded{Exam,Sol}Id are non-null only for the direct‑to‑Cloudinary
  // path: client already POSTed the PDFs to Cloudinary and is now sending us
  // JSON with the publicIds. When non-null we skip the server-side Cloudinary
  // upload step below and use these IDs as the cloudinaryId/solCloudinaryId.
  let preUploadedExamId = null;
  let preUploadedSolId = null;

  try {
    const buf = await rawBody(req);
    const ct = req.headers['content-type'] || '';
    let courseId, name, examFile, solFile, examFilename, solFilename;

    if (ct.includes('application/json')) {
      // ===== Direct-to-Cloudinary path =====
      // Client uploaded the PDFs straight to Cloudinary (see /api/upload-sign)
      // and is now sending us just the publicIds. We download the raw PDFs
      // from Cloudinary for text-layer + Gemini analysis.
      let body;
      try { body = JSON.parse(buf.toString('utf8')); }
      catch { return res.status(400).json({ error: 'Invalid JSON' }); }

      courseId = body.courseId;
      name = body.name;
      examFilename = body.examFilename || '';
      solFilename = body.solFilename || '';
      const examPublicId = body.examPublicId;
      const solPublicId = body.solPublicId || null;

      if (!courseId) return res.status(400).json({ error: 'חסר courseId' });
      if (!name || name.length < 2 || name.length > 200) return res.status(400).json({ error: 'שם מבחן לא תקין' });
      if (!examPublicId) return res.status(400).json({ error: 'חסר examPublicId' });

      // Lock publicIds to the authenticated user's scope — the sign endpoint
      // always issues `examprep/{userId}/pending_.../...`, and anything else
      // would be a client tampering attempt.
      const userPrefix = `examprep/${auth.userId}/`;
      if (!examPublicId.startsWith(userPrefix)) return res.status(400).json({ error: 'examPublicId invalid scope' });
      if (solPublicId && !solPublicId.startsWith(userPrefix)) return res.status(400).json({ error: 'solPublicId invalid scope' });

      const cloudNameEnv = (process.env.CLOUDINARY_CLOUD_NAME || '').replace(/\\n/g, '').replace(/\s+/g, '').trim();
      if (!cloudNameEnv) return res.status(500).json({ error: 'Cloudinary not configured' });

      const downloadPdf = async (publicId) => {
        const url = `https://res.cloudinary.com/${cloudNameEnv}/image/upload/${publicId}.pdf`;
        const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
        if (r.status === 401 || r.status === 403) {
          const err = new Error(`PDF delivery disabled (${r.status})`);
          err.pdfDeliveryDisabled = true;
          throw err;
        }
        if (!r.ok) throw new Error(`Cloudinary fetch ${r.status} for ${publicId}`);
        return Buffer.from(await r.arrayBuffer());
      };

      try {
        const [examBuf, solBuf] = await Promise.all([
          downloadPdf(examPublicId),
          solPublicId ? downloadPdf(solPublicId) : Promise.resolve(null),
        ]);
        examFile = { data: examBuf, filename: examFilename || 'exam.pdf' };
        solFile = solBuf ? { data: solBuf, filename: solFilename || 'solution.pdf' } : null;
      } catch (e) {
        console.error('[upload] cloudinary download failed:', e.message);
        if (e.pdfDeliveryDisabled) {
          return res.status(502).json({
            error: 'העלאת ה-PDF נחסמה ע״י Cloudinary',
            detail: 'הפעל "Allow delivery of PDF and ZIP files" בהגדרות Cloudinary ונסה שוב.',
          });
        }
        return res.status(502).json({ error: 'לא ניתן להוריד את הקובץ מהענן', detail: e.message });
      }

      preUploadedExamId = examPublicId;
      preUploadedSolId = solPublicId;
    } else if (ct.includes('multipart')) {
      // ===== Legacy multipart path (kept for backwards compatibility) =====
      const parts = parseMultipart(buf, ct);
      const getField = (n) => parts.find(p => p.name === n && !p.filename)?.data?.toString('utf8');
      const getFile = (n) => parts.find(p => p.name === n && p.filename);

      courseId = getField('courseId');
      name = getField('name');
      examFile = getFile('examPdf');
      solFile = getFile('solutionPdf');
      examFilename = examFile?.filename || '';
      solFilename = solFile?.filename || '';
    } else {
      return res.status(400).json({ error: 'Expected multipart/form-data or application/json' });
    }

    if (!courseId) return res.status(400).json({ error: 'חסר courseId' });
    const courseIdInt = parseInt(courseId, 10) || courseId;
    if (!name || name.length < 2 || name.length > 200) return res.status(400).json({ error: 'שם מבחן לא תקין' });
    if (!examFile) return res.status(400).json({ error: 'חסר קובץ PDF של המבחן' });
    if (!isPdf(examFile.data)) return res.status(400).json({ error: 'קובץ הבחינה אינו PDF תקני' });
    if (examFile.data.length > MAX_PDF_BYTES) return res.status(413).json({ error: 'הקובץ גדול מדי' });
    if (solFile && !isPdf(solFile.data)) return res.status(400).json({ error: 'קובץ הפתרון אינו PDF תקני' });

    // Verify course ownership. Use admin client so RLS can't silently hide
    // the row — the explicit user_id check below is the authoritative gate.
    // Splitting "row missing" from "wrong owner" so future 403s in the UI
    // point at the actual cause instead of a single opaque message.
    const courseClient = getAdmin() || auth.db;
    const { data: course, error: courseErr } = await courseClient.from('ep_courses')
      .select('id, user_id').eq('id', courseIdInt).maybeSingle();
    if (courseErr) {
      console.error('[upload] course lookup failed:', courseErr.message);
      return res.status(500).json({ error: 'שגיאה פנימית בבדיקת קורס' });
    }
    if (!course) {
      return res.status(404).json({ error: 'הקורס לא נמצא', detail: `courseId=${courseIdInt}` });
    }
    if (course.user_id !== auth.userId) {
      return res.status(403).json({ error: 'אין גישה לקורס' });
    }

    // ===== Per-user upload quota enforcement =====
    // Quotas come from the single source of truth in api/_lib/quotas.mjs.
    // Burst + global-budget checks happen here so Gemini money is never
    // spent on a request that would eventually be rate-limited.
    let userPlan = 'trial'; // default — overwritten below; used for model tiering
    try {
      const admin = getAdmin();
      if (admin) {
        // Reset daily/monthly counters AND expire trial if past due.
        // This RPC was extended in migrations/harden_trial_expiry.sql to
        // flip plan 'trial' → 'free' when plan_expires_at < now.
        try { await admin.rpc('reset_user_quotas_if_needed', { p_user_id: auth.userId }); } catch {}
        // Fetch profile AFTER the RPC so we see the fresh (possibly
        // downgraded) plan value.
        const { data: profile } = await admin.from('profiles')
          .select('plan, is_admin, trial_used').eq('id', auth.userId).maybeSingle();
        // Block modelim users early — they must never trigger Gemini.
        // Admins on the modelim plan are exempt (course owner managing content).
        if (assertNotModelim(res, profile)) return;
        const isAdmin = profile?.is_admin === true;

        // Global daily kill-switch — always enforced, even for admins.
        // A compromised admin account must not be able to bypass billing limits.
        const budget = await checkGlobalBudget();
        if (budget?.ok === false) {
          return res.status(503).json({
            error: 'השירות עמוס כרגע',
            guidance: 'ה-AI בעומס חריג. נסה שוב בעוד מספר שעות.',
          });
        }

        // Per-minute burst — admins get a higher cap (10/min vs 2/min) but are
        // never fully exempt. Prevents unbounded spending on a compromised account.
        const burstCap = isAdmin ? 10 : 2;
        const burst = await checkBurst(auth.userId, 'upload', burstCap);
        if (burst?.allowed === false) {
          return res.status(429).json({
            error: 'אנא המתן דקה בין העלאות',
            guidance: `ניתן להעלות עד ${burstCap} קבצים בדקה. המתן מעט ונסה שוב.`,
            retry_after_seconds: burst.retry_after_seconds,
          });
        }

        if (!isAdmin) {
          const plan = profile?.plan || 'free';
          userPlan = plan;
          const q = getQuota(plan);
          if (q.pdf_day === 0 && q.pdf_month === 0) {
            return res.status(402).json({
              error: 'התוכנית שלך לא כוללת העלאת בחינות',
              guidance: 'שדרג לתוכנית Trial או Basic כדי להעלות בחינות.',
              trial_expired: profile?.trial_used === true && plan === 'free',
            });
          }
          const { data: granted } = await admin.rpc('ep_reserve_pdf_slot', {
            p_user_id: auth.userId,
            p_max_today: q.pdf_day,
            p_max_month: q.pdf_month,
            p_max_total: -1, // no lifetime cap for non-free plans
            p_max_storage_bytes: q.storage_mb * 1024 * 1024,
          });
          if (granted === false) {
            return res.status(429).json({
              error: 'הגעת למגבלת ההעלאות',
              guidance: `התוכנית "${plan}" מאפשרת ${q.pdf_day} בחינות ליום ו-${q.pdf_month} לחודש. נסה שוב מחר או שדרג תוכנית.`
            });
          }
        } else {
          // Admins get a generous but finite daily cap to cap billing exposure.
          const { data: granted } = await admin.rpc('ep_reserve_pdf_slot', {
            p_user_id: auth.userId,
            p_max_today: 100,
            p_max_month: 1000,
            p_max_total: -1,
            p_max_storage_bytes: 500 * 1024 * 1024, // 500 MB
          });
          if (granted === false) {
            return res.status(429).json({
              error: 'הגעת למגבלת ההעלאות היומית',
              guidance: 'הגעת ל-100 העלאות היום. נסה שוב מחר.',
            });
          }
          userPlan = 'pro';
        }
      }
    } catch (e) {
      console.warn('[upload] quota check failed (allowing upload):', e?.message || e);
    }

    // Duplicate name check (active exams)
    const { count: dupCount } = await auth.db.from('ep_exams')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', courseIdInt).eq('name', name).is('deleted_at', null);
    if (dupCount > 0) return res.status(409).json({ error: `מבחן בשם "${name}" כבר קיים בקורס זה`, guidance: 'שנה את שם המבחן או מחק את המבחן הקיים מניהול הקבצים.' });

    // Trash duplicate check — if same name exists in recycle bin, purge it automatically before re-uploading
    let trashWarning = null;
    try {
      const { data: trashedDup } = await auth.db.from('ep_exams')
        .select('id').eq('course_id', courseIdInt).eq('name', name)
        .not('deleted_at', 'is', null).maybeSingle();
      if (trashedDup) {
        // Hard-delete the trashed exam and its questions to avoid duplicates
        await auth.db.from('ep_questions').delete().eq('exam_id', trashedDup.id).eq('course_id', courseIdInt);
        await auth.db.from('ep_exams').delete().eq('id', trashedDup.id).eq('course_id', courseIdInt);
        trashWarning = `מבחן קודם בשם "${name}" נמצא בסל המחזור ונמחק אוטומטית לפני ההעלאה החדשה.`;
        console.log(`[upload] purged trashed duplicate exam for "${name}"`);
      }
    } catch (e) {
      console.warn('[upload] trash-dup check failed:', e.message);
    }

    // Create exam record
    const { data: exam, error: examErr } = await auth.db.from('ep_exams')
      .insert({ course_id: courseIdInt, user_id: auth.userId, name, status: 'processing' })
      .select().single();
    if (examErr) {
      console.error('[upload] insert exam:', examErr.message);
      return res.status(500).json({ error: 'שגיאה ביצירת רשומת מבחן' });
    }
    examId = exam.id;

    // Prep Cloudinary creds
    const cleanEnv = s => (s || '').replace(/\\n/g, '').replace(/\s+/g, '').trim();
    const cloudName = cleanEnv(process.env.CLOUDINARY_CLOUD_NAME);
    const cloudKey = cleanEnv(process.env.CLOUDINARY_API_KEY);
    const cloudSecret = cleanEnv(process.env.CLOUDINARY_API_SECRET);
    const hasCloudinary = !!(cloudName && cloudKey && cloudSecret);
    const examBase64 = Buffer.from(examFile.data).toString('base64');
    const solBase64 = solFile ? Buffer.from(solFile.data).toString('base64') : null;

    // ===== Run in parallel: Cloudinary upload + text-layer analysis + Gemini verify =====
    // If the client used the direct-to-Cloudinary path, the PDFs are already on
    // Cloudinary under preUploaded{Exam,Sol}Id — skip the server-side upload
    // step and reuse those IDs directly.
    const cloudinaryPromise = preUploadedExamId
      ? Promise.resolve(preUploadedExamId)
      : (hasCloudinary
          ? uploadPdfToCloudinary({
              cloudName, apiKey: cloudKey, apiSecret: cloudSecret,
              pdfBase64: examBase64,
              publicId: `examprep/${auth.userId}/${exam.id}/exam`,
            }).catch(e => { console.error('[upload] cloudinary error:', e.message); return null; })
          : Promise.resolve(null));

    // Upload the solution PDF too so later per-question re-analysis can access
    // it. Uses a distinct publicId so it doesn't clobber the exam PDF.
    const solCloudinaryPromise = preUploadedSolId
      ? Promise.resolve(preUploadedSolId)
      : ((hasCloudinary && solBase64)
          ? uploadPdfToCloudinary({
              cloudName, apiKey: cloudKey, apiSecret: cloudSecret,
              pdfBase64: solBase64,
              publicId: `examprep/${auth.userId}/${exam.id}/solution`,
            }).catch(e => { console.error('[upload] solution cloudinary error:', e.message); return null; })
          : Promise.resolve(null));

    const positionsPromise = extractPositions(examFile.data)
      .catch(e => { console.error('[upload] positions error:', e.message); return null; });

    // Always run Gemini in parallel so it can fill any gaps the text-layer misses.
    // Send solution PDF so Gemini can set _geminiCorrect on each MCQ (primary answer source).
    const geminiVerifyPromise = analyzeExamWithGemini(examBase64, solBase64)
      .catch(e => { console.warn('[upload] gemini-verify failed:', e.message); return null; });

    // Start Pass 1 & 2 in parallel with Gemini — they only need solFile.data which is
    // already in memory, so they finish in ~2s while Gemini runs (free timing).
    const pass1Promise = solFile
      ? parseSolutionPdf(solFile.data).catch(e => { console.warn('[upload] pass1 parallel error:', e.message); return null; })
      : Promise.resolve(null);
    const pass2Promise = solFile
      ? flatScanAnswers(solFile.data).catch(e => { console.warn('[upload] pass2 parallel error:', e.message); return {}; })
      : Promise.resolve({});

    // Kick off the focused highlight scan HERE, in the same parallel phase,
    // against whichever PDF is most likely to hold marks (solution first,
    // else exam). It does not require the MCQ list — we filter its output
    // against detected MCQs later.
    const highlightScanPromise = scanExamHighlights(solBase64 || examBase64, [])
      .catch(e => { console.warn('[upload] highlight-scan parallel error:', e?.message || e); return {}; });

    // Run analyzeSolutionPdf in the SAME parallel phase — it doesn't need
    // MCQ detection to finish first (the question-numbers param is used
    // informationally). Passing [] lets Gemini extract answers for every
    // question it finds; we filter/match against actual MCQs later.
    // Skipping the pre-extraction wait cuts total time by ~60s.
    const solutionAnalysisPromise = solBase64
      ? analyzeSolutionPdf(examBase64, solBase64, [])
          .catch(e => { console.warn('[upload] analyzeSolutionPdf parallel error:', e?.message || e); return null; })
      : Promise.resolve(null);

    const [cloudinaryId, solCloudinaryId, positions, geminiVerifyRaw, pass1Result, pass2Result, earlyHighlightAnswers, earlySolutionAnalysis] = await Promise.all([
      cloudinaryPromise, solCloudinaryPromise, positionsPromise, geminiVerifyPromise, pass1Promise, pass2Promise, highlightScanPromise, solutionAnalysisPromise,
    ]);

    // ===== Detect MCQs: text-layer + Gemini verify/fill =====
    let mcqs = [];
    let mode = 'text-layer';
    let usedGeminiFallback = false;

    // Text-layer detection (free, accurate crop coords).
    let textLayerMcqs = [];
    let textLayerMode = 'none';
    if (positions && positions.length) {
      const detected = detectMCQsFromPositions(positions);
      textLayerMcqs = detected.mcqs;
      textLayerMode = detected.mode;
      console.log(`[upload] text-layer detected ${textLayerMcqs.length} MCQs via ${textLayerMode}`);
    }

    // Normalize Gemini results (ran in parallel above).
    console.log(`[upload] gemini-verify raw n-values: ${JSON.stringify((geminiVerifyRaw || []).map(q => q?.n))}`);
    const geminiMcqs = normalizeGeminiMcqs(geminiVerifyRaw);
    console.log(`[upload] gemini-verify found ${geminiMcqs.length} MCQs`);

    // Merge: text-layer is authoritative for coordinates; Gemini fills gaps + answers.
    if (textLayerMcqs.length > 0) {
      const geminiByNumber = new Map(geminiMcqs.map(q => [q.number, q]));
      const textNums = new Set(textLayerMcqs.map(q => q.number));
      const geminiFill = geminiMcqs.filter(q => !textNums.has(q.number));
      // Copy _geminiCorrect and group data from Gemini onto text-layer MCQs.
      // Without this, Gemini's answer data and group context are discarded when text-layer finds all questions.
      const enrichedTextLayer = textLayerMcqs.map(q => {
        const gq = geminiByNumber.get(q.number);
        if (!gq) return q;
        // Use Gemini's num_options when text-layer detected fewer (common for 5-10 option biology exams).
        const preferredNumOpts = (gq.numOptions && gq.numOptions > (q.numOptions || 4)) ? gq.numOptions : q.numOptions;
        return {
          ...q,
          ...(preferredNumOpts ? { numOptions: preferredNumOpts } : {}),
          ...(gq._geminiCorrect != null ? { _geminiCorrect: gq._geminiCorrect } : {}),
          ...(gq.groupId ? {
            groupId: gq.groupId,
            contextYTop: gq.contextYTop,
            contextPage: gq.contextPage,
            contextTextFromGemini: gq.contextTextFromGemini,
          } : {}),
        };
      });
      mcqs = [...enrichedTextLayer, ...geminiFill];
      mode = geminiFill.length > 0
        ? `text-layer:${textLayerMode}+gemini-fill(${geminiFill.length})`
        : `text-layer:${textLayerMode}`;
      const gcCount = enrichedTextLayer.filter(q => q._geminiCorrect != null).length;
      console.log(`[upload] merged: ${textLayerMcqs.length} text-layer + ${geminiFill.length} gemini-fill, gemini-correct: ${gcCount}`);
    } else if (geminiMcqs.length > 0) {
      // Scanned/image-only PDF — pure Gemini fallback.
      mcqs = geminiMcqs;
      mode = 'gemini-fallback';
      usedGeminiFallback = true;
      console.log(`[upload] pure gemini-fallback: ${mcqs.length} MCQs`);
    }

    // Dedup by number and sort
    const seen = new Set();
    mcqs = mcqs.filter(q => { const k = q.number; if (seen.has(k)) return false; seen.add(k); return true; });
    mcqs.sort((a, b) => (a.number || 0) - (b.number || 0));
    console.log(`[upload] ${mcqs.length} unique MCQs after dedup`);

    // Backfill group_id to same-page predecessors.
    //
    // Gemini frequently assigns group_id only to the questions that explicitly
    // back-reference (e.g. Q2, Q3 that start with "לפי התוצאות"), and misses
    // Q1 which sits right after the "סט N :" header on the same page as the
    // scenario. We fix this server-side: for every detected group, any MCQ
    // on the group's context_page whose yTop is BELOW context_y_top gets
    // adopted into the group (inherits groupId + context coords).
    //
    // This ensures Q1 of a set always shows the "📋 הקשר לסט" button and
    // gets its crop extended to include the scenario.
    const groupMetaByGid = new Map(); // gid → { contextPage, contextYTop, contextTextFromGemini }
    for (const q of mcqs) {
      if (!q.groupId || q.contextPage == null || q.contextYTop == null) continue;
      if (!groupMetaByGid.has(q.groupId)) {
        groupMetaByGid.set(q.groupId, {
          contextPage: q.contextPage,
          contextYTop: q.contextYTop,
          contextTextFromGemini: q.contextTextFromGemini || null,
        });
      }
    }
    let backfilled = 0;
    for (const q of mcqs) {
      if (q.groupId) continue; // already grouped
      for (const [gid, meta] of groupMetaByGid) {
        if (q.page !== meta.contextPage) continue;
        if (q.yTop <= meta.contextYTop) continue; // above the context — not part of set
        // Below context on same page → adopt into the group
        q.groupId = gid;
        q.contextPage = meta.contextPage;
        q.contextYTop = meta.contextYTop;
        if (!q.contextTextFromGemini) q.contextTextFromGemini = meta.contextTextFromGemini;
        backfilled++;
        break;
      }
    }
    if (backfilled > 0) console.log(`[upload] backfilled group_id on ${backfilled} same-page predecessor(s)`);

    // Extend crop bounds for grouped questions to include shared context (figure/passage/table)
    mcqs = applyGroupContextToCrops(mcqs);

    // Precisely set each MCQ's yBottom using actual text-layer line positions
    // (when available), then clamp so no crop overlaps the next MCQ on the
    // same page. This makes crops exactly match the visible question — no
    // matter whether the question is short (4 options) or long (10 options).
    //
    // Algorithm:
    //   1. For each page, sort MCQs top-to-bottom.
    //   2. For each MCQ, find the LAST actual text line that falls inside
    //      its vertical region (current.yTop → next.yTop). That line is the
    //      last option's text. Set yBottom = lastLine.yFromTop + 14pt (one
    //      line height of breathing room).
    //   3. Clamp so yBottom + CROP_MARGIN_BOTTOM_PT never reaches the next
    //      MCQ's yTop - CROP_MARGIN_TOP_PT (leaves a visual gap between
    //      crops even after margins are applied by buildCropUrl).
    //
    // For scanned PDFs (positions=null), only step 3 runs — Gemini's
    // yBottom is used as-is and only clamped if it overruns the next MCQ.
    const byPage = new Map();
    for (const m of mcqs) {
      if (!byPage.has(m.page)) byPage.set(m.page, []);
      byPage.get(m.page).push(m);
    }
    // Regex: detects OPTION labels — Hebrew letters א..י or digits 1-10,
    // optionally in parentheses, followed by .  )  :  or -.
    //   Matches: "א.", "(א)", "ב)", "1.", "(1)", "10.", "10)"
    //   Does NOT match the "בחרו את התשובה הנכונה:" instruction line.
    const OPTION_LINE = /^\s*[\(\[]?\s*(?:[א-י]|(?:10|[1-9]))\s*[\)\].:\-]/;

    // Regex: detects the HEADING of a new question — "שאלה 3", "3.", "3)", "(3)".
    // Used to cap the region of the CURRENT question when the next question
    // wasn't classified as an MCQ (LaTeX/scanned options) and therefore isn't
    // in `list`. Prevents one question's crop from spilling into the next.
    const HEADING_LINE = /^\s*[\(\[]?\s*(?:שאלה\s+)?(\d{1,2})\s*[\)\].]/;

    for (const [pageNum, list] of byPage) {
      list.sort((a, b) => (a.yTop || 0) - (b.yTop || 0));
      // Collect full lines (with text) for this page so we can distinguish
      // option rows from prose like "בחרו את התשובה הנכונה:".
      let pageLines = null;
      if (Array.isArray(positions)) {
        const pageData = positions.find(p => p.page === pageNum);
        if (pageData) {
          pageLines = buildLines(pageData).sort((a, b) => a.yFromTop - b.yFromTop);
        }
      }
      for (let i = 0; i < list.length; i++) {
        const current = list[i];
        const next = list[i + 1];

        // Compute an "effective next yTop" — prefer the real next MCQ on the
        // page, but fall back to a text-layer heading line if we find one.
        // This catches cases where Q3's options aren't in the text layer so
        // it got dropped from `list`, but its "3." heading still appears in
        // text and we can use it to cap Q2's crop.
        let virtualNextY = null;
        const curNum = parseInt(current.number, 10) || 0;
        if (pageLines) {
          for (const line of pageLines) {
            if (line.yFromTop <= current.yTop) continue;
            if (next && line.yFromTop >= next.yTop) break;
            const m = line.text.match(HEADING_LINE);
            if (!m) continue;
            const headingNum = parseInt(m[1], 10);
            // Strictly greater than current, within a plausible distance.
            if (headingNum > curNum && headingNum <= curNum + 20) {
              virtualNextY = line.yFromTop;
              break;
            }
          }
        }
        const effectiveNextY = (next?.yTop ?? virtualNextY ?? (current.pageHeight || 842));

        // Step 2: refine yBottom using the LAST OPTION LINE in the region.
        //
        // CRITICAL: only shrink yBottom when we can positively identify an
        // option row (א./ב./1./2.) in the text layer. Some exams render
        // options as LaTeX / special fonts / images, so PDF.js extracts only
        // prose lines like "בחרו את התשובה הנכונה:" and NO option text —
        // in that case the prior behavior (Math.min on every line) chopped
        // the crop off ABOVE the options. We now preserve yBottom whenever
        // we can't find option lines, and trust findBottomBoundary / Gemini.
        if (pageLines && pageLines.length > 0) {
          const regionStart = current.yTop;
          const regionEnd = effectiveNextY;
          let lastOptionY = null;
          let optionCount = 0;
          for (const line of pageLines) {
            if (line.yFromTop <= regionStart) continue;
            if (line.yFromTop >= regionEnd) break;
            if (OPTION_LINE.test(line.text)) {
              lastOptionY = line.yFromTop;
              optionCount++;
            }
          }
          // Require >=2 sequential-looking option rows so one stray "1." in
          // the question stem doesn't shrink the crop.
          if (lastOptionY != null && optionCount >= 2) {
            const refined = lastOptionY + 14;
            // Extend (never shrink) — if Gemini's yBottom already covered
            // everything, keep it. Only grow when text-layer sees options
            // below the current yBottom estimate.
            current.yBottom = Math.max(current.yBottom || refined, refined);
          }
          // If no options detected in text layer, leave yBottom alone.
        }
        // Step 3: hard clamp against next MCQ (or virtual heading) so the
        // crop doesn't spill into the next question's content.
        if (next || virtualNextY != null) {
          const combinedMargin = CROP_MARGIN_BOTTOM_PT + CROP_MARGIN_TOP_PT + 8;
          const maxAllowedBottom = Math.max(current.yTop + 40, effectiveNextY - combinedMargin);
          if (current.yBottom > maxAllowedBottom) current.yBottom = maxAllowedBottom;
        }
      }
    }

    // Hard stop: 0 MCQs detected — classify and give a specific error
    if (mcqs.length === 0) {
      const cls = await classifyPdfWithGemini(examBase64).catch(() => null);
      // Clean up the placeholder exam record
      await auth.db.from('ep_exams').delete().eq('id', exam.id);
      examId = null;
      const hint = cls?.type === 'solution'
        ? 'נראה שהעלית קובץ פתרון. השתמש בו בשדה "קובץ פתרון" ולא כקובץ הבחינה.'
        : cls?.type === 'notes'
        ? 'נראה שהעלית חומר לימוד ולא בחינה. העלה קובץ שמכיל שאלות רב-ברירה.'
        : 'הקובץ לא מכיל שאלות אמריקאיות שניתן לזהות. ודא שיש שאלות עם אפשרויות 1/2/3/4 או א/ב/ג/ד.';
      return res.status(422).json({ error: 'לא זוהו שאלות אמריקאיות בקובץ', guidance: hint });
    }

    // ===== Unified solution analysis: match verification + answer extraction =====
    // One Gemini call does both jobs. The upload ALWAYS succeeds — if the AI
    // cannot confidently match the solution, we drop the low-confidence answers
    // and attach a soft warning so the user can set answers manually.
    let answers = {};
    let answerCrossVerify = {}; // { qNumStr: 'agree' | 'disagree' | 'skip' } — set by Groq pass
    let answerExtractDebug = { tried: false, ok: false, matched: 0, model: null };
    let matchVerdict = null;     // 'match' | 'mismatch' | 'unknown'
    let matchConfidence = 0;
    let solutionWarning = null;  // populated when the AI couldn't verify the solution

    // Detect "rich" instructor solutions: per-question blocks that contain
    // MCQ-specific explanation text. We ONLY flag a block as rich when:
    //   1. The question number is actually an MCQ in this exam (not an open question)
    //   2. The text does NOT look like an open-ended proof/derivation
    // This prevents open-question solutions (proofs, derivations) from being
    // assigned to MCQs that share the same question number.
    const richSolutions = {}; // { [qNumber]: { text, isRich } }
    const mcqNumbers = new Set(mcqs.map(q => String(q.number)));
    if (pass1Result) {
      // Markers indicating open-ended proof/derivation (NOT an MCQ explanation).
      const openQuestionMarkers = /(?:נוכיח\s+ש|הוכח\s+ש|הוכחה\s*:|נדרש\s+להוכיח|תהי\s+[A-Z]|קבוצת\s+כל|בהינתן\s+ש|גרירה\s*:|אמ"מ|נ"ל|I\.H\.|induction|∀|∃|⊆|⊇|אינדוקציה|בסיס\s+האינדוקציה|צעד\s+האינדוקציה)/i;
      for (const [k, v] of Object.entries(pass1Result)) {
        // Skip if this question number is not an MCQ in the exam.
        if (!mcqNumbers.has(k)) continue;
        const raw = (v?.rawText || '').trim();
        if (!raw) continue;
        // Skip if this looks like an open-ended proof.
        if (openQuestionMarkers.test(raw)) continue;
        const textLen = raw.length;
        const lineCount = raw.split(/\r?\n/).filter(l => l.trim().length > 2).length;
        // Hebrew reasoning markers that indicate an MCQ explanation beyond a bare answer.
        const explainMarkers = /(?:כי |לכן|מכיוון|משום ש|נובע|הסבר|חישוב|מתקיים|לפיכך|על כן|ניתן לראות)/;
        const hasExplainKeywords = explainMarkers.test(raw);
        // Rich = substantive explanation, not a bare letter/number answer.
        // Cap at 800 chars — a real MCQ explanation shouldn't be a full proof.
        const isRich = textLen >= 80 && textLen <= 800 && lineCount >= 2 && hasExplainKeywords;
        if (isRich) {
          richSolutions[k] = { text: raw.slice(0, 800), isRich: true };
        }
      }
      if (Object.keys(richSolutions).length > 0) {
        console.log(`[upload] detected ${Object.keys(richSolutions).length} rich MCQ instructor solutions`);
      }
    }

    if (mcqs.length > 0) {
      const nums = mcqs.map(q => q.number).filter(Boolean);
      // Keep pass1/pass2 text-extract results as a free starting point (they already ran).
      if (pass1Result) {
        for (const [k, v] of Object.entries(pass1Result))
          if (v.answer >= 1 && v.answer <= 4) answers[k] = v.answer;
      }
      if (pass2Result && Object.keys(pass2Result).length > 0) {
        for (const [k, v] of Object.entries(pass2Result))
          if (!answers[k]) answers[k] = v;
      }

      // Both Gemini passes already ran IN PARALLEL during the initial phase
      // (see earlyHighlightAnswers + earlySolutionAnalysis). We just reuse
      // those results here — no additional waiting.
      answerExtractDebug.tried = true;
      const analysis = earlySolutionAnalysis || null;
      const highlightAnswers = earlyHighlightAnswers || {};

      // Track per-question disagreement between the two Gemini passes.
      // When both returned an answer for the same question and they differ,
      // we mark the question 'uncertain' in the DB so the UI shows a warning
      // badge instead of silently storing one version.
      var uncertainQNums = new Set();
      const solutionAnswers = (analysis && analysis.answers) || {};
      const hlAnswers = highlightAnswers || {};

      if (analysis) {
        matchVerdict = analysis.match;
        matchConfidence = analysis.confidence;
        answerExtractDebug.model = analysis.model;
        answerExtractDebug.rawItems = analysis.rawItems || [];
        if (Object.keys(solutionAnswers).length > 0) {
          for (const [k, v] of Object.entries(solutionAnswers)) answers[k] = v;
          answerExtractDebug.ok = true;
        }
        console.log(`[upload] unified analysis: match=${matchVerdict} conf=${(matchConfidence||0).toFixed(2)} answers=${Object.keys(answers).length}/${nums.length}`);
      }

      // ── Layer 3 anchor matcher (free regex fallback on solution text) ──
      // Fills Gemini gaps and flags conflicts. Only runs if we have a solution
      // PDF and at least one MCQ. Cheap: reuses text layer extraction.
      if (solBase64 && nums.length > 0) {
        try {
          const solPages = await extractPositions(solFile.data).catch(() => null);
          if (solPages && solPages.length) {
            const solText = solPages
              .flatMap(p => buildLines(p).map(l => l.text))
              .join('\n');
            const anchorResult = extractAnchorsFromSolutionText(solText, nums);
            const xv = crossValidateAnswers(solutionAnswers, anchorResult.answers);
            answerExtractDebug.anchor = {
              matched: anchorResult.matched,
              conflicts: xv.conflicts,
              fills: xv.fills,
              agreements: xv.agreements.length,
            };
            // Apply fills — regex answer for Q where Gemini had nothing.
            for (const qNum of xv.fills) {
              if (!answers[qNum]) {
                answers[qNum] = anchorResult.answers[qNum]?.idx;
                console.log(`[upload] anchor FILL Q${qNum} → ${anchorResult.answers[qNum]?.idx} (regex pattern ${anchorResult.answers[qNum]?.pattern})`);
              }
            }
            // Conflicts — mark uncertain so the Review screen asks the user.
            for (const qNum of xv.conflicts) {
              uncertainQNums.add(String(qNum));
              console.warn(`[upload] anchor CONFLICT Q${qNum}: gemini=${solutionAnswers[qNum]} vs regex=${anchorResult.answers[qNum]?.idx} → marked uncertain`);
            }
            if (xv.fills.length || xv.conflicts.length) {
              console.log(`[upload] anchor matcher: +${xv.fills.length} fills, ${xv.conflicts.length} conflicts, ${xv.agreements.length} agreements`);
            }
          }
        } catch (e) {
          console.warn('[upload] anchor matcher failed (non-fatal):', e.message);
        }
      }

      // Cross-validate: for every Q where BOTH passes returned an answer,
      // compare them. Disagreement → 'uncertain'. Off-by-one on 10-option
      // questions is the most common failure mode (e.g. ט/9 vs י/10).
      const hlDetails = (hlAnswers && hlAnswers._details) || {};
      for (const [k, hlAns] of Object.entries(hlAnswers)) {
        if (k === '_details') continue;
        const solAns = solutionAnswers[k];
        if (solAns != null && hlAns != null && solAns !== hlAns) {
          uncertainQNums.add(String(k));
          console.warn(`[upload] Q${k}: DISAGREEMENT — analyzeSolutionPdf=${solAns} vs highlightScan=${hlAns}. Marking uncertain. hlText="${(hlDetails[k]?.optionText || '').slice(0, 50)}"`);
          // If one is the LAST option in the set (per total_options) and the
          // other is second-to-last, PREFER the highlight scan — this is the
          // exact י/ט confusion we warned Gemini about. The highlight scan is
          // focused and more reliable for this edge case.
          const tot = hlDetails[k]?.totalOptions;
          if (tot && (hlAns === tot && solAns === tot - 1)) {
            console.warn(`[upload]   → highlight scan picked LAST option (${tot}), solution-analysis picked ${solAns}. Preferring highlight scan.`);
            answers[k] = hlAns;
          } else if (tot && (solAns === tot && hlAns === tot - 1)) {
            console.warn(`[upload]   → solution-analysis picked LAST option (${tot}). Preferring it.`);
            answers[k] = solAns;
          }
          // Otherwise leave answers[k] = solAns (analyzeSolutionPdf wins by
          // default) but it'll be marked uncertain below.
        }
      }

      // Fill remaining gaps from the focused highlight scan.
      for (const [k, v] of Object.entries(hlAnswers)) {
        if (k === '_details') continue;
        if (!answers[k] && v >= 1 && v <= 10) answers[k] = v;
      }
      console.log(`[upload] highlight scan added ${Object.keys(hlAnswers).filter(k => k !== '_details').length} candidates; total answers ${Object.keys(answers).length}/${nums.length}; uncertain=${uncertainQNums.size}`);
      answerExtractDebug.matched = Object.keys(answers).length;

      // Cross-verify extracted answers with Groq — catches cases where Gemini
      // confidently misread the solution PDF. Runs in parallel, free, ~2s total.
      try {
        answerCrossVerify = await crossVerifyAnswersWithGroq(mcqs, answers);
      } catch (e) {
        console.warn('[upload] cross-verify failed:', e?.message || e);
      }

      // NEVER hard-reject the upload. When the AI is not confident about the
      // solution we drop the unreliable answers and surface a soft warning so
      // the user can set answers manually. The highlight scan already ran in
      // parallel, so if it found answers they're already in `answers`.
      const answered = mcqs.filter(q => answers[String(q.number)]).length;

      if (solBase64 && matchVerdict === 'mismatch' && answered < Math.ceil(nums.length * 0.3)) {
        // AI is confident this is the WRONG solution file AND highlight scan
        // didn't save us — drop extracted answers from the solution PDF only.
        console.warn(`[upload] AI reported mismatch (conf=${matchConfidence.toFixed(2)}) — dropping solution-extracted answers, keeping highlight-scan answers`);
        const keptFromHighlights = {};
        for (const [k, v] of Object.entries(highlightAnswers || {})) {
          if (v >= 1 && v <= 10) keptFromHighlights[k] = v;
        }
        answers = keptFromHighlights;
        if (Object.keys(answers).length === 0) {
          solutionWarning = 'ה-AI חשד שקובץ הפתרון אינו שייך לבחינה. המבחן הועלה אבל לא סימנו תשובות נכונות — תצטרך לסמן אותן ידנית לכל שאלה.';
        }
      } else if (answered === 0) {
        console.warn(`[upload] zero answers after all scans — user will set manually`);
        solutionWarning = 'לא זיהינו תשובות אוטומטית — תצטרך לסמן את התשובה הנכונה לכל שאלה בעצמך.';
      } else {
        console.log(`[upload] answers accepted: answered=${answered}/${nums.length}`);
      }
    }

    // ===== NO upload-time Gemini solution generation =====
    // The tier-2 pipeline generates structured explanations lazily at
    // display-time (when user first opens a question). This makes uploads
    // FREE and ~6x faster, and free-tier-resilient.
    const solutions = {}; // always empty — filled lazily

    // ===== Build DB rows =====
    if (mcqs.length > 0) {
      // Pre-compute ONE shared context text + one context-only image crop per group.
      // For each groupId, find the question with the smallest yTopBeforeContext on
      // the group's contextPage — that's the "first question" of the set. The
      // context text is everything between setTop (contextYTop) and that first
      // question's original top. All members of the group get the SAME text AND
      // the SAME context_image_path, so cross-page members (set intro on p1,
      // question on p2) still show the scenario visually above their own crop.
      const groupContexts = {};     // { groupId: contextText | null }
      const groupCtxImages = {};    // { groupId: contextImagePath | null }
      for (const q of mcqs) {
        if (!q.groupId || q.contextPage == null || q.contextYTop == null) continue;
        if (groupContexts[q.groupId] !== undefined) continue;
        let firstInSet = null;
        for (const m of mcqs) {
          if (m.groupId !== q.groupId) continue;
          if (m.page !== q.contextPage) continue;
          const yOrig = m.yTopBeforeContext ?? m.yTop;
          if (!firstInSet || yOrig < (firstInSet.yTopBeforeContext ?? firstInSet.yTop)) firstInSet = m;
        }
        if (!firstInSet) {
          groupContexts[q.groupId] = q.contextTextFromGemini || null;
          groupCtxImages[q.groupId] = null;
          continue;
        }
        const firstY = firstInSet.yTopBeforeContext ?? firstInSet.yTop;
        // Prefer the accurate text-layer extraction; fall back to Gemini's verbatim
        // text for scanned PDFs (no text layer) or when extraction returned empty.
        const textExtracted = extractContextText(positions, q.contextPage, q.contextYTop, firstY);
        groupContexts[q.groupId] = textExtracted || q.contextTextFromGemini || null;

        // Build a context-only image crop (page `contextPage`, yTop → firstY).
        // Uses the same buildCropUrl helper as question crops.
        if (cloudinaryId && firstY > q.contextYTop) {
          groupCtxImages[q.groupId] = buildCropUrl(cloudName, cloudinaryId, {
            page: q.contextPage,
            yTop: q.contextYTop,
            yBottom: firstY,
            pageWidth: firstInSet.pageWidth || 595,
            pageHeight: firstInSet.pageHeight || 842,
          });
        } else {
          groupCtxImages[q.groupId] = null;
        }
      }

      const pdfPageCount = Array.isArray(positions) ? positions.length : null;
      // One-shot Cloudinary delivery sanity check — catches the "PDF & ZIP
      // delivery toggle is OFF" case where every crop URL will 401. We don't
      // block the upload (per-question repair still works), but we surface
      // the failure mode clearly in logs and on the exam record.
      // cloudinaryDeliveryBlocked is hoisted to the outer try-scope so the
      // examUpdate builder can read it.
      if (cloudinaryId && mcqs.length > 0) {
        const probeUrl = buildFullPageUrl(cloudName, cloudinaryId, mcqs[0].page || 1);
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 3000);
          const r = await fetch(probeUrl, { method: 'HEAD', signal: ctrl.signal }).catch(() => null);
          clearTimeout(t);
          if (r && (r.status === 401 || r.status === 403)) {
            cloudinaryDeliveryBlocked = true;
            console.error(`[upload] cloudinary PDF delivery disabled — status ${r.status} on ${probeUrl}`);
          } else if (r && !r.ok) {
            console.warn(`[upload] cloudinary probe returned ${r.status} on ${probeUrl}`);
          }
        } catch (e) {
          console.warn('[upload] cloudinary probe failed:', e.message);
        }
      }
      // Detect which page of the SOLUTION PDF contains each question's answer.
      // Stored per-question so the frontend "תקן תשובה" viewer opens the
      // correct page directly. FAST chain — one scan, not per-question.
      // Best-effort: when Gemini misses a question, we fall back to its exam
      // pdf_page at render time (best first guess), and the user can flip.
      let solutionPageMap = {};
      if (solBase64 && mcqs.length > 0) {
        try {
          const qNums = mcqs.map(q => q.number).filter(n => Number.isFinite(n));
          solutionPageMap = await detectSolutionPages(solBase64, qNums);
        } catch (e) {
          console.warn('[upload] detectSolutionPages failed:', e?.message || e);
        }
      }

      let fallbackCount = 0;
      const qRecords = mcqs.map((q, i) => {
        let imagePath = 'text-only';
        let imageMode = 'text-only';
        if (cloudinaryId) {
          if (isBboxUsable(q, pdfPageCount)) {
            imagePath = buildCropUrl(cloudName, cloudinaryId, q);
            imageMode = 'crop';
          } else {
            imagePath = buildFullPageUrl(cloudName, cloudinaryId, q.page || 1);
            imageMode = 'fullpage';
            fallbackCount++;
          }
        }
        console.log(`[upload] mcq Q${q.number}: page=${q.page} yTop=${Math.round(q.yTop || 0)} yBottom=${Math.round(q.yBottom || 0)} pw=${q.pageWidth || '?'} ph=${q.pageHeight || '?'} mode=${imageMode}`);
        // Answer sources — BOTH are 'confirmed' because the Gemini prompt
        // explicitly instructs it to set `correct` ONLY when a visible mark
        // (highlight / circle / check / handwritten) is present. It's not
        // guessing — it's reading what's physically there in the PDF.
        //   1. analyzeSolutionPdf → 'confirmed' (from explicit answer key in solution PDF)
        //   2. _geminiCorrect     → 'confirmed' (from visible mark on the exam itself —
        //                          biology exams often ship with yellow highlights
        //                          on the correct option)
        //   3. no answer          → 'unknown' (user sets manually)
        const answerFromSolution = answers[String(q.number)] ?? null;
        const answerFromGeminiMark = (q._geminiCorrect != null && q._geminiCorrect >= 1 && q._geminiCorrect <= 10)
          ? q._geminiCorrect : null;
        const crossVerified = answerCrossVerify?.[String(q.number)]; // set by Groq pass
        const hasSolutionAnswer = answerFromSolution !== null && answerFromSolution >= 1 && answerFromSolution <= 10;
        const hasGeminiMarkAnswer = answerFromGeminiMark !== null;
        const hasAnswer = hasSolutionAnswer || hasGeminiMarkAnswer;
        const finalAnswer = hasSolutionAnswer ? answerFromSolution : answerFromGeminiMark;
        // If the two Gemini passes disagreed for this Q, mark uncertain so
        // the UI shows a warning badge. Otherwise confirmed.
        const isUncertain = typeof uncertainQNums !== 'undefined' && uncertainQNums.has(String(q.number));
        const confidence = !hasAnswer ? 'unknown' : (isUncertain ? 'uncertain' : 'confirmed');
        const pdfPageVal = Number.isFinite(q.page) && q.page >= 1 ? q.page : null;
        const contextPageVal = (q.groupId && Number.isFinite(q.contextPage) && q.contextPage >= 1) ? q.contextPage : null;
        const solPageRaw = solutionPageMap[String(q.number)];
        const solPageVal = Number.isFinite(solPageRaw) && solPageRaw >= 1 ? solPageRaw : null;
        return {
          exam_id: exam.id,
          course_id: courseIdInt,
          user_id: auth.userId,
          question_number: q.number || (i + 1),
          section_label: q.section || null,
          image_path: imagePath,
          num_options: q.numOptions || 4,
          correct_idx: hasAnswer ? finalAnswer : 1, // 1 is a placeholder; UI shows warning via answer_confidence
          answer_confidence: confidence,
          option_labels: null,
          is_ai_generated: usedGeminiFallback,
          // Question text extracted by detectMCQsFromPositions (free, used by premium AI button)
          question_text: q.questionStemText || null,
          options_text: (q.optionTexts && Object.keys(q.optionTexts).length > 0) ? q.optionTexts : null,
          // solution_text_raw stays null — parseSolutionPdf side-task was removed (too unreliable)
          general_explanation: null,
          option_explanations: null,
          group_id: q.groupId || null,
          // PDF page numbers for the crop tool (reshoot / fix-answer / context).
          // *_confidence='detected' means set by upload pipeline; overwritten to
          // 'user_confirmed' when the user saves a crop from the viewer.
          pdf_page: pdfPageVal,
          pdf_page_confidence: pdfPageVal ? 'detected' : 'unknown',
          context_pdf_page: contextPageVal,
          solution_pdf_page: solPageVal,
          solution_pdf_page_confidence: solPageVal ? 'detected' : 'unknown',
          // Shared context text for the group (set intro / passage / code block).
          // Same text for every question in the set so users can reference it
          // from any question without re-reading the other questions' stems.
          context_text: q.groupId ? (groupContexts[q.groupId] || null) : null,
          // Cloudinary crop URL for the shared context region (e.g. the data
          // table on page 1 of a cross-page set).
          // Stored on EVERY group member so the file-manager UI can show a
          // "view set info" button next to each question thumbnail.
          // The quiz UI uses context_cross_page to decide whether to inline
          // the image above the question crop (same-page crops already
          // include it via applyGroupContextToCrops).
          context_image_path: q.groupId ? (groupCtxImages[q.groupId] || null) : null,
          context_cross_page: !!(q.groupId && q.contextPage != null && q.contextPage !== q.page),
          // If the solution PDF had a detailed per-question explanation, store
          // it so the UI can show it verbatim and skip Gemini generation.
          instructor_solution_text: richSolutions[String(q.number)]?.text || null,
          has_rich_solution: !!richSolutions[String(q.number)]?.isRich,
        };
      });
      if (cloudinaryId) {
        console.log(`[upload] image modes: ${fallbackCount}/${qRecords.length} fell back to full-page (bbox unusable)`);
      }

      // Count review-needed questions so the post-insert code can gate the
      // exam status ('awaiting_review' vs 'ready'). reviewCount is declared
      // at the top of the try-block (outer scope) so it's visible outside
      // this `if (mcqs.length > 0)` block.
      reviewCount = qRecords.filter(r =>
        r.answer_confidence === 'unknown' || r.answer_confidence === 'uncertain'
      ).length;
      console.log(`[upload] inserting ${qRecords.length} questions (mode=${mode})`);
      let { error: qErr } = await auth.db.from('ep_questions').insert(qRecords);
      // If a column from a pending migration doesn't exist yet, retry without it.
      if (qErr?.message?.includes('column') && qErr.message.includes('does not exist')) {
        console.warn('[upload] column missing — retrying without new columns:', qErr.message);
        const strip = r => {
          const {
            context_image_path, context_cross_page,
            pdf_page, pdf_page_confidence, context_pdf_page,
            solution_pdf_page, solution_pdf_page_confidence,
            ...rest
          } = r;
          return rest;
        };
        ({ error: qErr } = await auth.db.from('ep_questions').insert(qRecords.map(strip)));
      }
      if (qErr) {
        console.error('[upload] batch insert failed:', qErr.message);
        let ok = 0;
        for (const r of qRecords) { if (!(await auth.db.from('ep_questions').insert(r)).error) ok++; }
        console.log(`[upload] individual: ${ok}/${qRecords.length}`);
      }
    }

    // Update exam status. If any question came out with unknown/uncertain
    // answer_confidence, we gate to 'awaiting_review' instead of 'ready' so
    // the user must open the Review screen and confirm answers before
    // practice is unlocked. Clean exams (all confident) fast-track to 'ready'.
    const needsReview = reviewCount > 0;
    const suspicious = mcqs.length < 3 ||
      (geminiMcqs.length > 0 && mcqs.length < geminiMcqs.length);
    const debugLine = `tl=${textLayerMcqs.length}[${textLayerMcqs.map(q => q.number).join(',')}] ` +
                      `gem=${geminiMcqs.length}[${geminiMcqs.map(q => q.number).join(',')}] ` +
                      `mode=${mode}`;
    const examUpdate = {
      status: needsReview ? 'awaiting_review' : 'ready',
      question_count: mcqs.length,
      total_pages: positions?.length || null,
      processed_at: new Date().toISOString(),
      ...(cloudinaryId && { exam_pdf_path: cloudinaryId }),
      ...(solCloudinaryId && { solution_pdf_path: solCloudinaryId }),
      ...(cloudinaryDeliveryBlocked
        ? { error_message: 'cloudinary_pdf_delivery_disabled' }
        : (suspicious && { error_message: debugLine })),
    };
    const { error: examUpdateErr } = await auth.db.from('ep_exams').update(examUpdate).eq('id', exam.id);
    if (examUpdateErr?.message?.includes('does not exist')) {
      console.warn('[upload] ep_exams column missing — retrying without new columns:', examUpdateErr.message);
      const { exam_pdf_path, solution_pdf_path, ...examUpdateCompat } = examUpdate;
      await auth.db.from('ep_exams').update(examUpdateCompat).eq('id', exam.id);
    } else if (examUpdateErr?.message?.includes('ep_exams_status_check') && examUpdate.status === 'awaiting_review') {
      // Migration not applied yet — fall back to 'ready' so the upload still completes.
      console.warn('[upload] awaiting_review not in CHECK constraint — falling back to ready. Apply awaiting_review_status.sql migration.');
      await auth.db.from('ep_exams').update({ ...examUpdate, status: 'ready' }).eq('id', exam.id);
    }

    // Update course counters — MUST filter soft-deleted rows so counts don't
    // drift when the user deletes and re-uploads an exam (the old rows keep
    // `deleted_at` set but still live in the table).
    const [{ count: qCount }, { count: pdfCount }] = await Promise.all([
      auth.db.from('ep_questions').select('id', { count: 'exact', head: true }).eq('course_id', courseIdInt).is('deleted_at', null),
      auth.db.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', courseIdInt).is('deleted_at', null),
    ]);
    await auth.db.from('ep_courses').update({ total_questions: qCount, total_pdfs: pdfCount }).eq('id', courseIdInt);

    // Build warnings (per user rule: when files match, stay silent).
    // Only surface partial-extraction warnings when significantly incomplete.
    const warnings = [];
    if (mcqs.length === 0) {
      warnings.push('לא זוהו שאלות אמריקאיות בקובץ. ודא שהמבחן מכיל שאלות רב-ברירה בפורמט מוכר.');
    } else if (solBase64) {
      if (solutionWarning) {
        warnings.push(solutionWarning);
      } else {
        const answered = mcqs.filter(q => answers[String(q.number)]).length;
        if (answered > 0 && answered / mcqs.length < 0.5) {
          warnings.push(`זוהו תשובות רק ל-${answered} מתוך ${mcqs.length} שאלות. אם יש לך קובץ פתרון אחר — אפשר לחבר אותו מההגדרות של המבחן.`);
        } else if (answered > 0 && answered < mcqs.length) {
          // Partial extraction (50-99%) — quieter heads-up rather than a hard warning.
          const missing = mcqs.length - answered;
          if (missing >= 3) {
            warnings.push(`זוהו תשובות ל-${answered} מתוך ${mcqs.length} שאלות. השאלות שחסרות תופענה בסקירה לאישור ידני.`);
          }
        }
      }
    } else if (!solBase64 && mcqs.length > 0) {
      const answered = mcqs.filter(q => answers[String(q.number)]).length;
      if (answered === 0) {
        warnings.push('לא הועלה קובץ פתרון — כל התשובות יסומנו לאישור ידני במסך הסקירה.');
      }
    }

    res.json({
      ok: true,
      exam_id: exam.id,
      question_count: mcqs.length,
      status: examUpdate.status,
      review_count: reviewCount,
      mode,
      _debug: {
        textLayerCount: textLayerMcqs.length,
        geminiCount: geminiMcqs.length,
        geminiNumbers: geminiMcqs.map(q => q.number),
        textLayerNumbers: textLayerMcqs.map(q => q.number),
        extractedAnswers: answerExtractDebug.rawItems || [],
        finalAnswers: answers,
      },
      ...(warnings.length && { warnings }),
      ...(trashWarning && { trashWarning }),
    });
  } catch (err) {
    console.error('[upload] fatal:', err?.message || err, err?.stack?.split('\n')[1] || '');
    try {
      if (auth?.db) {
        const q = auth.db.from('ep_exams').update({ status: 'failed' });
        if (examId) {
          await q.eq('id', examId);
        } else {
          await q.eq('user_id', auth.userId).eq('status', 'processing');
        }
      }
    } catch {}
    // Surface a short diagnostic so we can see WHERE the pipeline broke
    // without having to tail Vercel logs live. Safe to return — no secrets.
    const diag = (err?.message || String(err || '')).slice(0, 240);
    res.status(500).json({ error: 'שגיאה פנימית בהעלאה', detail: diag });
  }
}
