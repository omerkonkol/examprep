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

export const config = { api: { bodyParser: false }, maxDuration: 120 };

const MAX_PDF_BYTES = 15 * 1024 * 1024;

// Cloudinary renders the PDF at this width. Height is computed per-page
// from the actual page dimensions, so A4 vs Letter no longer matters.
const CLOUDINARY_RENDER_W = 1600;
// PDF-coordinate margins around each question so the crop isn't flush to text.
const CROP_MARGIN_TOP_PT = 12;
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

function parseMultipart(buf, contentType) {
  const bm = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!bm) throw new Error('No multipart boundary');
  const boundary = bm[1] || bm[2];
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(sep);
  while (start !== -1) {
    start += sep.length;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    const next = buf.indexOf(sep, start);
    if (next === -1) break;
    const part = buf.slice(start, next - 2);
    const hEnd = part.indexOf('\r\n\r\n');
    if (hEnd === -1) { start = next; continue; }
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

// =====================================================
// PDF text-layer analysis (pdf.js via unpdf)
// =====================================================

// Extract per-item text positions for every page.
// Each item carries x, y in PDF native coords, and yFromTop (flipped so 0
// is at the top of the page, matching how we'll crop the rendered image).
async function extractPositions(pdfBytes) {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(pdfBytes));
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(it => it && it.str !== undefined)
      .map(it => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        yFromTop: viewport.height - it.transform[5],
        width: it.width,
        height: it.height,
      }));
    pages.push({ page: i, width: viewport.width, height: viewport.height, items });
  }
  return pages;
}

// Group items into visual lines (items whose yFromTop is within yTol of each
// other). Returns each line with its concatenated text + left/right X extents.
function buildLines(page, yTol = 3) {
  const items = page.items.filter(it => it.str && it.str.trim() !== '');
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.yFromTop - b.yFromTop);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find(l => Math.abs(l.yFromTop - it.yFromTop) < yTol);
    if (line) {
      line.items.push(it);
      line.yFromTop = (line.yFromTop * (line.items.length - 1) + it.yFromTop) / line.items.length;
    } else {
      lines.push({ yFromTop: it.yFromTop, items: [it] });
    }
  }
  for (const line of lines) {
    // RTL: rightmost item first when building visual text.
    line.items.sort((a, b) => b.x - a.x);
    const parts = [];
    let lastX = null;
    for (const it of line.items) {
      if (lastX !== null && lastX - (it.x + (it.width || 0)) > 2) parts.push(' ');
      parts.push(it.str);
      lastX = it.x;
    }
    line.text = parts.join('').replace(/\s+/g, ' ').trim();
    line.leftX = Math.min(...line.items.map(it => it.x));
    line.rightX = Math.max(...line.items.map(it => it.x + (it.width || 0)));
  }
  return lines;
}

// Find the page range for a parent question (used by sections mode).
function findQuestionRange(pages, parentQ) {
  let startPage = null, startY = null, endPage = null, endY = null;
  for (const page of pages) {
    const lines = buildLines(page);
    for (const line of lines) {
      const m = line.text.match(/שאלה\s*(\d+)|(\d+)\s*שאלה/);
      if (m) {
        const num = parseInt((m[1] || m[2]), 10);
        if (num === parentQ && startPage === null) {
          startPage = page.page; startY = line.yFromTop;
        } else if (num === parentQ + 1 && startPage !== null && endPage === null) {
          endPage = page.page; endY = line.yFromTop;
        }
      }
    }
  }
  return { startPage, startY, endPage, endY };
}

const ALL_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];

// Find sub-section headings (סעיף א/ב/ג...) within a parent question.
function findSectionHeadings(pages, parentQ) {
  const range = findQuestionRange(pages, parentQ);
  const results = [];
  if (range.startPage === null) return { headings: results, range };
  const seen = new Set();
  for (const page of pages) {
    if (page.page < range.startPage) continue;
    if (range.endPage !== null && page.page > range.endPage) break;
    const lines = buildLines(page);
    for (const line of lines) {
      if (range.endPage === page.page && line.yFromTop >= range.endY) continue;
      for (const letter of ALL_LETTERS) {
        if (seen.has(letter)) continue;
        const re1 = new RegExp(`(^|\\s)סעיף\\s*${letter}['\u2019\u05F3\`]?(\\s|$|\\()`);
        const re2 = new RegExp(`(^|\\s)${letter}['\u2019\u05F3\`]\\s*\\(\\s*\\d+\\s*נק`);
        if (re1.test(line.text) || re2.test(line.text)) {
          if (line.rightX > page.width - 110) {
            seen.add(letter);
            results.push({ section: letter, page: page.page, yFromTop: line.yFromTop });
            break;
          }
        }
      }
    }
  }
  results.sort((a, b) => a.page - b.page || a.yFromTop - b.yFromTop);
  return { headings: results, range };
}

// Find standalone numbered question headings ("שאלה 1", "שאלה 2", ...).
// Requires that the line STARTS with "שאלה" (not embedded in a paragraph)
// and sits near the right edge of the page (RTL heading position).
//
// Page 1 is scanned unless it's clearly an instructions page (has the word
// "הוראות" / "כללי" near the top and no "שאלה N" headings). We decide that
// per-PDF by actually looking at what page 1 contains.
function findStandaloneQuestions(pages) {
  const results = [];
  const seen = new Set();
  // Decide whether to skip page 1: only if it looks like an instructions page
  // AND has no שאלה-N heading on it. Otherwise include it.
  let skipPage1 = false;
  if (pages.length > 1) {
    const p1 = pages.find(p => p.page === 1);
    if (p1) {
      const lines = buildLines(p1);
      const hasQHeading = lines.some(l => /^\s*שאלה\s*\d/.test(l.text));
      const looksLikeInstructions = lines.slice(0, 15).some(l =>
        /(הוראות\s+כלליות|משך\s+הבחינה|חומר\s+עזר|מהלך\s+הבחינה)/.test(l.text));
      skipPage1 = !hasQHeading && looksLikeInstructions;
    }
  }
  for (const page of pages) {
    if (page.page === 1 && skipPage1) continue;
    const lines = buildLines(page);
    for (const line of lines) {
      // Skip only the absolute outliers — real headings can include the full
      // question stem on the same visual line ("שאלה 2 נאמר ששפה L מסכימה...").
      if (line.text.length > 300) continue;
      // Match "שאלה N" at line start. Don't use \b — Hebrew + digit boundary is
      // tricky; use an explicit "not a digit" lookahead instead.
      const m = line.text.match(/^\s*שאלה\s*(\d{1,3})(?!\d)/);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      if (num < 1 || num > 100 || seen.has(num)) continue;
      if (line.rightX <= page.width - 110) continue;
      seen.add(num);
      results.push({ section: String(num), page: page.page, yFromTop: line.yFromTop });
    }
  }
  results.sort((a, b) => a.page - b.page || a.yFromTop - b.yFromTop);
  return results;
}

// Given a heading and the following heading, find where the current question
// actually ends.
//
// The returned `yFromTop` is the PRE-MARGIN bottom — buildCropUrl will still
// add CROP_MARGIN_BOTTOM_PT on top. So we cap at (hardUpper - safety) where
// safety ≥ CROP_MARGIN_BOTTOM_PT to guarantee the crop never spills into the
// next heading after the aesthetic margin is added.
//
// Priority order:
//  A. A "נימוק" line (justification box) on the starting page — tohna1 sections
//     mode puts this after each MCQ.
//  B. The LAST option line (1./2./3./4. or א./ב./ג./ד.) on the starting page,
//     within the region before the next heading. This is the most reliable
//     signal for MCQs — stops us cropping into the next question when there's
//     no explicit structural marker.
//  C. The next heading on the same page (minus a safety margin).
//  D. The page bottom.
function findBottomBoundary(pages, fromHeading, nextHeading) {
  const startPage = fromHeading.page;
  const startY = fromHeading.yFromTop;
  const page = pages.find(p => p.page === startPage);
  if (!page) return null;

  // Upper Y bound — never scan past the next heading (if it's on the same page).
  const hardUpper = (nextHeading && nextHeading.page === startPage)
    ? nextHeading.yFromTop
    : page.height;

  // Safety margin between our returned bottom and the next heading. We need
  // at least CROP_MARGIN_BOTTOM_PT + a few points to absorb the crop padding.
  const SAFETY = CROP_MARGIN_BOTTOM_PT + 6;
  const safeCap = hardUpper - SAFETY;

  const lines = buildLines(page);

  // A. "נימוק" line
  for (const line of lines) {
    if (line.yFromTop <= startY || line.yFromTop >= hardUpper) continue;
    if (/^נימוק\s*[:.]?\s*$/.test(line.text)) {
      return { page: startPage, yFromTop: Math.min(safeCap, line.yFromTop - 10) };
    }
  }

  // B. Last sequential option line in the region
  let lastOptionY = null;
  let numSeen = 0, hebSeen = 0;
  for (const line of lines) {
    if (line.yFromTop <= startY || line.yFromTop >= hardUpper) continue;
    const t = line.text.replace(/^[\s•·]+/, '');
    const mNum = t.match(/^\.?\s*([1-9])\s*[.)]/);
    if (mNum) {
      const n = parseInt(mNum[1], 10);
      if (n === numSeen + 1 && n <= 6) {
        numSeen = n;
        lastOptionY = line.yFromTop;
        continue;
      }
    }
    const mHeb = t.match(/^\.?\s*([א-ט])\s*[.)]/);
    if (mHeb) {
      const idx = 'אבגדהוזח'.indexOf(mHeb[1]);
      if (idx === hebSeen && hebSeen < 6) {
        hebSeen = idx + 1;
        lastOptionY = line.yFromTop;
        continue;
      }
    }
  }
  if (lastOptionY !== null && Math.max(numSeen, hebSeen) >= 2) {
    // Extend past the last option marker to capture any wrapped continuation
    // lines — stop at the next structural element (new heading, new option,
    // נימוק) or a big vertical gap.
    let includeY = lastOptionY;
    const tail = lines
      .filter(l => l.yFromTop > lastOptionY && l.yFromTop < hardUpper)
      .sort((a, b) => a.yFromTop - b.yFromTop);
    for (const line of tail) {
      if (/^נימוק\s*[:.]?\s*$/.test(line.text)) break;
      if (/^\s*שאלה\s*\d/.test(line.text)) break;
      const t = line.text.replace(/^[\s•·]+/, '');
      if (/^\.?\s*[1-9]\s*[.)]/.test(t)) break;
      if (/^\.?\s*[א-ט]\s*[.)]/.test(t)) break;
      if (line.yFromTop - includeY > 25) break;
      includeY = line.yFromTop;
    }
    // +6pt accounts for the baseline → descender of the last included line;
    // CROP_MARGIN_BOTTOM_PT below adds the rest of the line height.
    return { page: startPage, yFromTop: Math.min(safeCap, includeY + 6) };
  }

  // C. Next heading on the same page
  if (nextHeading && nextHeading.page === startPage) {
    return { page: startPage, yFromTop: safeCap };
  }

  // D. Page bottom
  return { page: startPage, yFromTop: page.height - 30 };
}

// Does the region between heading and bottom look like an MCQ?
// Signals:
//   + "הקיפו" / "בחרו" / "איזו מהטענות" → explicit circle-one-answer = MCQ
//   + ≥3 sequential numbered (1.2.3.4) or lettered (א.ב.ג.ד.) option lines
//   - explicit open-question commands at sentence start (הוכיחו / השלימו / ...)
//
// `strict=true` (standalone mode) requires a concrete positive signal.
// `strict=false` (sections mode) defaults to MCQ — the parent question is
// typically dedicated to MCQs, so unclear cases are kept rather than dropped.
function classifyRegion(pages, heading, bottom, strict = false) {
  const page = pages.find(p => p.page === heading.page);
  if (!page) return { isMCQ: false, numOptions: 0 };
  const lines = buildLines(page);
  const regionLines = lines.filter(l =>
    l.yFromTop > heading.yFromTop && l.yFromTop < (bottom ? bottom.yFromTop : page.height));
  if (regionLines.length === 0) return { isMCQ: false, numOptions: 0 };

  const regionText = regionLines.map(l => l.text).join(' ');

  // Count sequential option markers (".1", "1.", ".א", "א." at line start).
  let num = 0, heb = 0;
  for (const l of regionLines) {
    const t = l.text.replace(/^[\s•·]+/, '');
    const mNum = t.match(/^\.?\s*([1-9])\s*[.)]?/);
    if (mNum) {
      const n = parseInt(mNum[1], 10);
      if (n === num + 1 && n <= 6) num = n;
    }
    const mHeb = t.match(/^\.?\s*([א-ט])\s*[.)]?/);
    if (mHeb) {
      const letterIdx = 'אבגדהוזח'.indexOf(mHeb[1]);
      if (letterIdx === heb && heb < 6) heb = letterIdx + 1;
    }
  }
  const numOptions = Math.max(num, heb);
  const hasCirclePhrase = /(הקיפו|איזו\s+מהטענות|איזה\s+מהבא|בחרו\s+את|סמנו\s+את)/.test(regionText);

  // Strong positive: explicit "circle" instruction — always an MCQ, even for
  // 2-option true/false variants like "הקיפו: מתקמפל / לא מתקמפל".
  if (hasCirclePhrase) {
    return { isMCQ: true, numOptions: Math.max(numOptions, 2) };
  }

  // Strong negative: the stem opens with a clear write-an-answer command.
  const openMarkers = /(הוכיחו|הפריכו|השלימו\s+את|כתבו\s+את|מימשו\s+את|ממשו\s+את|חשבו\s+את|תכננו\s+את|סרטטו|ציירו|תארו\s+את|הסבירו|פתרו\s+את|נמקו\s+את)/;
  if (openMarkers.test(regionText) && numOptions < 3) {
    return { isMCQ: false, numOptions: 0 };
  }

  // ≥3 numbered options is a reliable positive.
  if (numOptions >= 3) return { isMCQ: true, numOptions };

  // Standalone mode: require a concrete positive signal above. Unclear = reject.
  if (strict) return { isMCQ: false, numOptions };

  // Sections mode: default to MCQ (permissive — parent Q is typically MCQ-only).
  return { isMCQ: true, numOptions: numOptions || 4 };
}

// Top-level MCQ detection: auto-picks between sections mode (a single parent
// question with sub-sections) and standalone mode (each שאלה N is its own MCQ).
function detectMCQsFromPositions(pages) {
  // Sections mode: try parent questions 1..6 and keep the one with the most
  // sub-sections that actually look like MCQs.
  let best = { mode: 'none', mcqs: [] };
  for (let pq = 1; pq <= 6; pq++) {
    const { headings } = findSectionHeadings(pages, pq);
    if (headings.length < 3) continue;
    const mcqs = [];
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const next = headings[i + 1];
      const bottom = findBottomBoundary(pages, h, next);
      if (!bottom) continue;
      const cls = classifyRegion(pages, h, bottom);
      if (!cls.isMCQ) continue;
      const pageMeta = pages.find(p => p.page === h.page);
      mcqs.push({
        section: h.section,
        number: i + 1,
        page: h.page,
        yTop: h.yFromTop,
        yBottom: bottom.yFromTop,
        pageWidth: pageMeta.width,
        pageHeight: pageMeta.height,
        numOptions: cls.numOptions,
      });
    }
    if (mcqs.length > best.mcqs.length) {
      best = { mode: `sections(parent=${pq})`, mcqs };
    }
  }

  // Standalone mode: "שאלה N" at the right edge of the page.
  // Strict classifier — standalone "שאלה N" could easily be an open question
  // (proofs, design, programming), so we require concrete MCQ evidence.
  const standalone = findStandaloneQuestions(pages);
  if (standalone.length >= 3) {
    const mcqs = [];
    for (let i = 0; i < standalone.length; i++) {
      const h = standalone[i];
      const next = standalone[i + 1];
      const bottom = findBottomBoundary(pages, h, next);
      if (!bottom) continue;
      const cls = classifyRegion(pages, h, bottom, /* strict */ true);
      if (!cls.isMCQ) continue;
      const pageMeta = pages.find(p => p.page === h.page);
      mcqs.push({
        section: h.section,
        number: parseInt(h.section, 10),
        page: h.page,
        yTop: h.yFromTop,
        yBottom: bottom.yFromTop,
        pageWidth: pageMeta.width,
        pageHeight: pageMeta.height,
        numOptions: cls.numOptions,
      });
    }
    if (mcqs.length > best.mcqs.length) {
      best = { mode: 'standalone', mcqs };
    }
  }

  return best;
}

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
// Gemini — answer extraction from solution PDF
// =====================================================
// Returns { "1": 3, "2": 1, ... } or null on failure.
async function extractAnswersWithGemini(solutionPdfBase64, questionNumbers) {
  const apiKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  if (!apiKey) return null;

  const list = questionNumbers.join(', ');
  const prompt = `Below is a Hebrew exam solution PDF. For each multiple-choice question listed, find the correct answer.

Questions to find: ${list}

An MCQ has 4 options labeled either 1/2/3/4 or א/ב/ג/ד. The solution PDF may mark the correct answer with a circle, highlight, bullet, "תשובה: X", or similar.

Return ONLY a JSON object mapping question number (as string) to answer index (1-4, where 1=א, 2=ב, 3=ג, 4=ד). If you cannot find an answer for a question, omit it.

Example: {"1": 3, "2": 1, "3": 4}`;

  const parts = [
    { text: prompt },
    { inlineData: { mimeType: 'application/pdf', data: solutionPdfBase64 } },
  ];

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 1024, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.warn(`[gemini-answers] ${model} ${r.status}:`, errText.slice(0, 200));
        continue;
      }
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === 'object') {
        const normalized = {};
        for (const [k, v] of Object.entries(parsed)) {
          const n = parseInt(v, 10);
          if (n >= 1 && n <= 10) normalized[String(parseInt(k, 10))] = n;
        }
        console.log(`[gemini-answers] ${model} found ${Object.keys(normalized).length}/${questionNumbers.length} answers`);
        return normalized;
      }
    } catch (e) {
      console.warn(`[gemini-answers] ${model} failed:`, e.message);
    }
  }
  return null;
}

// =====================================================
// Gemini fallback — full exam extraction (scanned/image-only PDFs)
// =====================================================
async function analyzeExamWithGemini(examPdfBase64, solPdfBase64) {
  const apiKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  if (!apiKey) return null;

  const prompt = `Analyze this Hebrew university exam PDF. Find EVERY multiple-choice question (שאלות אמריקאיות / שאלות סגורות).

A multiple-choice question has ALL of:
1. A question number (e.g. "שאלה 1", "שאלה 2", or "סעיף א")
2. 3-5 answer options labeled either 1./2./3./4. OR א./ב./ג./ד.
3. The student picks ONE answer

BE EXHAUSTIVE. Return EVERY question that matches. This is CRITICAL:
- Do NOT skip a question because its stem contains words like הוכיחו, הראו, הפריכו, חשבו, השלימו, הסבירו — MCQs often use these words inside the stem or inside their answer options.
- Include questions even if you are only ~80% sure they are MCQs.
- Scan ALL pages, including page 1.
- If questions are numbered 1..N, you should generally return N objects.

ONLY skip a question if:
- It has NO answer options at all (just a blank writing space)
- It sits under an explicit "שאלות פתוחות" section header
- It is pure instructions / cover page with no question stem

For EACH MCQ return:
{
  "n": question number (integer as printed),
  "page": PDF page number (1-based integer),
  "y_top": percentage from top where the "שאלה N" LABEL LINE starts — must be AT or ABOVE the top edge of the "שאלה X" text itself, not below it. If unsure, subtract ~2% from your estimate to ensure the label is included. (0-100),
  "y_bottom": percentage from top where the LAST option ends (0-100),
  "correct": correct answer index (1-4) if known, else null,
  "page_w": page width in points (usually 595),
  "page_h": page height in points (usually 842)
}

Return ONLY a JSON array. Be complete — if the exam has 10 questions, return 10 objects.`;

  const parts = [
    { text: prompt },
    { inlineData: { mimeType: 'application/pdf', data: examPdfBase64 } },
  ];
  if (solPdfBase64) {
    parts.push({ text: '\n\nSolution PDF (use for correct answers):' });
    parts.push({ inlineData: { mimeType: 'application/pdf', data: solPdfBase64 } });
  }

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      console.log(`[gemini-fallback] trying ${model}...`);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 16384, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) { console.warn(`[gemini-fallback] ${model} ${r.status}`); continue; }
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`[gemini-fallback] ${model} found ${parsed.length} MCQs`);
        return parsed;
      }
    } catch (e) {
      console.warn(`[gemini-fallback] ${model} failed:`, e.message);
    }
  }
  return null;
}

// Normalize a raw Gemini MCQ array into the same shape used by the text-layer
// detector, so the two result sets can be merged cleanly.
function normalizeGeminiMcqs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    // Accept both number (7) and string ("7") — Gemini sometimes returns strings.
    .filter(q => q && (typeof q.n === 'number' || typeof q.n === 'string') && String(q.n).trim() !== '' && !isNaN(parseInt(q.n, 10)))
    .map(q => ({
      section: String(q.n),
      number: typeof q.n === 'number' ? q.n : parseInt(q.n, 10),
      page: q.page || 2,
      yTop: Math.max(0, ((q.y_top ?? 0) / 100) * (q.page_h || 842) - 25),
      yBottom: ((q.y_bottom ?? Math.min((q.y_top ?? 0) + 25, 100)) / 100) * (q.page_h || 842),
      pageWidth: q.page_w || 595,
      pageHeight: q.page_h || 842,
      numOptions: 4,
      _geminiCorrect: q.correct ?? null,
      _fromGemini: true,
    }));
}

// =====================================================
// Handler
// =====================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  let examId = null;

  try {
    const buf = await rawBody(req);
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart')) return res.status(400).json({ error: 'Expected multipart/form-data' });
    const parts = parseMultipart(buf, ct);

    const getField = (name) => parts.find(p => p.name === name && !p.filename)?.data?.toString('utf8');
    const getFile = (name) => parts.find(p => p.name === name && p.filename);

    const courseId = getField('courseId');
    const name = getField('name');
    const examFile = getFile('examPdf');
    const solFile = getFile('solutionPdf');

    if (!courseId) return res.status(400).json({ error: 'חסר courseId' });
    const courseIdInt = parseInt(courseId, 10) || courseId;
    if (!name || name.length < 2 || name.length > 200) return res.status(400).json({ error: 'שם מבחן לא תקין' });
    if (!examFile) return res.status(400).json({ error: 'חסר קובץ PDF של המבחן' });
    if (!isPdf(examFile.data)) return res.status(400).json({ error: 'קובץ הבחינה אינו PDF תקני' });
    if (examFile.data.length > MAX_PDF_BYTES) return res.status(413).json({ error: 'הקובץ גדול מדי' });
    if (solFile && !isPdf(solFile.data)) return res.status(400).json({ error: 'קובץ הפתרון אינו PDF תקני' });

    // Verify course ownership
    const { data: course } = await auth.db.from('ep_courses').select('id').eq('id', courseIdInt).maybeSingle();
    if (!course) return res.status(403).json({ error: 'אין גישה לקורס' });

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
    const cloudinaryPromise = hasCloudinary
      ? uploadPdfToCloudinary({
          cloudName, apiKey: cloudKey, apiSecret: cloudSecret,
          pdfBase64: examBase64,
          publicId: `examprep/${auth.userId}/${exam.id}/exam`,
        }).catch(e => { console.error('[upload] cloudinary error:', e.message); return null; })
      : Promise.resolve(null);

    const positionsPromise = extractPositions(examFile.data)
      .catch(e => { console.error('[upload] positions error:', e.message); return null; });

    // Always run Gemini in parallel so it can fill any gaps the text-layer misses.
    const geminiVerifyPromise = analyzeExamWithGemini(examBase64, solBase64)
      .catch(e => { console.warn('[upload] gemini-verify failed:', e.message); return null; });

    const [cloudinaryId, positions, geminiVerifyRaw] = await Promise.all([
      cloudinaryPromise, positionsPromise, geminiVerifyPromise,
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

    // Merge: text-layer is authoritative for coordinates; Gemini fills gaps.
    if (textLayerMcqs.length > 0) {
      const textNums = new Set(textLayerMcqs.map(q => q.number));
      const geminiFill = geminiMcqs.filter(q => !textNums.has(q.number));
      mcqs = [...textLayerMcqs, ...geminiFill];
      mode = geminiFill.length > 0
        ? `text-layer:${textLayerMode}+gemini-fill(${geminiFill.length})`
        : `text-layer:${textLayerMode}`;
      console.log(`[upload] merged: ${textLayerMcqs.length} text-layer + ${geminiFill.length} gemini-fill`);
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

    // ===== Answers: ask Gemini to parse the solution PDF in parallel =====
    // (Only when we have a solution and didn't already get answers from the fallback path.)
    let answers = {};
    if (mcqs.length > 0 && solBase64 && !usedGeminiFallback) {
      const nums = mcqs.map(q => q.number).filter(Boolean);
      try {
        const parsed = await extractAnswersWithGemini(solBase64, nums);
        if (parsed) answers = parsed;
      } catch (e) {
        console.warn('[upload] answer extraction failed:', e.message);
      }
    }

    // ===== Build DB rows =====
    if (mcqs.length > 0) {
      const qRecords = mcqs.map((q, i) => {
        let imagePath = 'text-only';
        if (cloudinaryId) {
          imagePath = buildCropUrl(cloudName, cloudinaryId, q);
        }
        const correct = answers[String(q.number)] ?? q._geminiCorrect ?? null;
        return {
          exam_id: exam.id,
          course_id: courseIdInt,
          user_id: auth.userId,
          question_number: q.number || (i + 1),
          section_label: q.section || null,
          image_path: imagePath,
          num_options: q.numOptions || 4,
          correct_idx: correct || 1,
          option_labels: null,
          is_ai_generated: usedGeminiFallback,
        };
      });

      console.log(`[upload] inserting ${qRecords.length} questions (mode=${mode})`);
      const { error: qErr } = await auth.db.from('ep_questions').insert(qRecords);
      if (qErr) {
        console.error('[upload] batch insert failed:', qErr.message);
        let ok = 0;
        for (const r of qRecords) { if (!(await auth.db.from('ep_questions').insert(r)).error) ok++; }
        console.log(`[upload] individual: ${ok}/${qRecords.length}`);
      }
    }

    // Update exam status — always 'ready' after processing (even with 0 questions).
    // If detection looks incomplete, persist a one-line debug summary so we can
    // diagnose post-hoc without relying on Vercel log surfacing.
    const suspicious = mcqs.length < 3 ||
      (geminiMcqs.length > 0 && mcqs.length < geminiMcqs.length);
    const debugLine = `tl=${textLayerMcqs.length}[${textLayerMcqs.map(q => q.number).join(',')}] ` +
                      `gem=${geminiMcqs.length}[${geminiMcqs.map(q => q.number).join(',')}] ` +
                      `mode=${mode}`;
    await auth.db.from('ep_exams').update({
      status: 'ready',
      question_count: mcqs.length,
      total_pages: positions?.length || null,
      processed_at: new Date().toISOString(),
      ...(suspicious && { error_message: debugLine }),
    }).eq('id', exam.id);

    // Update course counters
    const [{ count: qCount }, { count: pdfCount }] = await Promise.all([
      auth.db.from('ep_questions').select('id', { count: 'exact', head: true }).eq('course_id', courseIdInt),
      auth.db.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', courseIdInt),
    ]);
    await auth.db.from('ep_courses').update({ total_questions: qCount, total_pdfs: pdfCount }).eq('id', courseIdInt);

    // Build warnings
    const warnings = [];
    if (mcqs.length === 0) {
      warnings.push('לא זוהו שאלות אמריקאיות בקובץ. ודא שהמבחן מכיל שאלות רב-ברירה בפורמט מוכר.');
    } else if (solBase64) {
      const answered = mcqs.filter(q => answers[String(q.number)] || q._geminiCorrect).length;
      if (answered === 0) {
        warnings.push('לא זוהו תשובות מסומנות בקובץ הפתרון — ודא שהעלית את הפתרון הנכון.');
      } else if (answered / mcqs.length < 0.5) {
        warnings.push(`זוהו תשובות רק ל-${answered} מתוך ${mcqs.length} שאלות.`);
      }
    }

    res.json({
      ok: true,
      exam_id: exam.id,
      question_count: mcqs.length,
      mode,
      _debug: {
        textLayerCount: textLayerMcqs.length,
        geminiCount: geminiMcqs.length,
        geminiNumbers: geminiMcqs.map(q => q.number),
        textLayerNumbers: textLayerMcqs.map(q => q.number),
      },
      ...(warnings.length && { warnings }),
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
    res.status(500).json({ error: 'שגיאה פנימית בהעלאה' });
  }
}
