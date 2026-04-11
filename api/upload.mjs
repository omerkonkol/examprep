// =====================================================
// Vercel Serverless Function — POST /api/upload
// =====================================================
// Upload exam PDF → extract questions via Gemini → store in DB
// =====================================================

import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false }, maxDuration: 120 };

const MAX_PDF_BYTES = 15 * 1024 * 1024;

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

// ===== Gemini Vision: send PDF directly, get MCQ data back =====
async function analyzeExamWithGemini(examPdfBase64, solPdfBase64) {
  const apiKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  if (!apiKey) return null;

  const prompt = `Analyze this Hebrew university exam PDF. Extract ONLY multiple-choice questions (שאלות סגורות / שאלות בחירה / שאלות אמריקאיות).

WHAT IS A MULTIPLE-CHOICE QUESTION:
- Has "שאלה X:" header
- Has exactly 4 options: א. ב. ג. ד.
- Student picks ONE answer

WHAT IS NOT A MULTIPLE-CHOICE QUESTION (SKIP THESE):
- Anything under "שאלות פתוחות" section
- Proof questions ("הוכיחו", "הראו", "הפריכו")
- Definition questions ("נגדיר", "תהא")
- Questions with blank answer lines or "תשובה ריקה"
- Instructions page (page 1)
- Sub-sections (סעיף א/ב) that are NOT multiple choice

IMPORTANT: If the exam has two versions (גרסה 1, גרסה 2), only use גרסה 1.

For EACH multiple-choice question, return:
{
  "n": question number as printed,
  "page": PDF page number (1-based),
  "y_top": percentage from top of page where the question HEADER starts (0-100),
  "y_bottom": percentage from top of page where the LAST option (ד.) ends (0-100),
  "correct": correct answer (1=א, 2=ב, 3=ג, 4=ד) or null if unknown,
  "explanation": "one line explanation in Hebrew"
}

The y_top and y_bottom MUST be precise — y_top starts AT the "שאלה X:" line, y_bottom ends right AFTER option ד. Do NOT include any content from neighboring questions.

Return ONLY a JSON array. If solution PDF attached, use it for answers.`;

  const parts = [{ text: prompt }];
  // Add exam PDF as inline data
  parts.push({
    inlineData: { mimeType: 'application/pdf', data: examPdfBase64 }
  });
  // Add solution PDF if provided
  if (solPdfBase64) {
    parts.push({ text: '\n\nSolution PDF:' });
    parts.push({
      inlineData: { mimeType: 'application/pdf', data: solPdfBase64 }
    });
  }

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      console.log(`[gemini-vision] trying ${model} with PDF...`);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 16384, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(55000),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.warn(`[gemini-vision] ${model} returned ${r.status}:`, errText.slice(0, 200));
        continue;
      }
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`[gemini-vision] ${model} found ${parsed.length} MCQs`);
        return parsed;
      }
    } catch (e) {
      console.warn(`[gemini-vision] ${model} failed:`, e.message);
      continue;
    }
  }
  return null;
}

// ===== File validation helpers =====
function extractYears(text) {
  const matches = text.match(/\b(20[1-3]\d)\b/g);
  return [...new Set(matches || [])];
}

function extractSemester(text) {
  if (/סמסטר\s*[אa'׳]/i.test(text)) return 'א';
  if (/סמסטר\s*[בb'׳]/i.test(text)) return 'ב';
  if (/סמסטר\s*(?:קיץ|ג|c)/i.test(text)) return 'קיץ';
  return null;
}

function extractMoed(text) {
  if (/מועד\s*[אa'׳]/i.test(text)) return 'א';
  if (/מועד\s*[בb'׳]/i.test(text)) return 'ב';
  if (/מועד\s*(?:מיוחד|ג|c)/i.test(text)) return 'מיוחד';
  return null;
}

function extractCourseName(text) {
  const patterns = [
    /(?:קורס|מקצוע|נושא)[:\s]+([^\n,]{3,40})/,
    /(?:בחינה|מבחן)\s+ב([^\n,]{3,40})/,
    /(?:course|subject)[:\s]+([^\n,]{3,40})/i,
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim(); }
  return null;
}

function extractQuestionCount(text) {
  const m = text.match(/(\d+)\s*(?:שאלות|questions)/i);
  return m ? parseInt(m[1]) : null;
}

function commonWords(a, b) {
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2));
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return wordsA.size > 0 ? common / wordsA.size : 0;
}

function validateFiles(name, examHeader, solHeader) {
  const warnings = [];

  const pdfYears = extractYears(examHeader);
  const nameYears = extractYears(name);
  const pdfMoed = extractMoed(examHeader);
  const nameMoed = extractMoed(name);
  const pdfCourse = extractCourseName(examHeader);

  // 1. Year mismatch: name vs PDF
  if (nameYears.length && pdfYears.length && !pdfYears.includes(nameYears[0])) {
    warnings.push(`שים לב: רשמת "${nameYears[0]}" בשם, אבל בקובץ מופיעה השנה ${pdfYears.join('/')}.`);
  }

  // 2. Moed mismatch: name vs PDF
  if (nameMoed && pdfMoed && nameMoed !== pdfMoed) {
    warnings.push(`שים לב: רשמת "מועד ${nameMoed}" בשם, אבל בקובץ כתוב "מועד ${pdfMoed}".`);
  }

  // 3. Solution vs exam validation
  if (solHeader) {
    const solYears = extractYears(solHeader);
    const solMoed = extractMoed(solHeader);
    const solSem = extractSemester(solHeader);
    const examSem = extractSemester(examHeader);
    const solCourse = extractCourseName(solHeader);

    // Year mismatch
    if (pdfYears.length && solYears.length && !pdfYears.some(y => solYears.includes(y))) {
      warnings.push(`שים לב: המבחן משנת ${pdfYears[0]} אבל הפתרון משנת ${solYears[0]}. ודא שהעלית את הפתרון הנכון.`);
    }
    // Moed mismatch
    if (pdfMoed && solMoed && pdfMoed !== solMoed) {
      warnings.push(`שים לב: המבחן ממועד ${pdfMoed} אבל הפתרון ממועד ${solMoed}.`);
    }
    // Semester mismatch
    if (examSem && solSem && examSem !== solSem) {
      warnings.push(`שים לב: המבחן מסמסטר ${examSem} אבל הפתרון מסמסטר ${solSem}.`);
    }
    // Course name mismatch — only warn if both names are clearly detected
    // and are completely different (not just different phrasing)
    if (pdfCourse && solCourse && pdfCourse.length > 5 && solCourse.length > 5
        && commonWords(pdfCourse, solCourse) === 0) {
      warnings.push(`שים לב: נראה שהמבחן בנושא "${pdfCourse}" אבל הפתרון בנושא "${solCourse}".`);
    }
  }

  return warnings;
}

// ===== Robust MCQ parser — works on full text, not line-by-line =====
// Handles messy PDF text extraction where line breaks may be missing or wrong.
// Strategy 1: Find "שאלה X" headers, then extract options (א./ב./ג./ד.) after each.
// Strategy 2: If no headers found, scan for groups of consecutive Hebrew-letter options.
function parseQuestionsFromText(examText, solText) {
  if (!examText || examText.length < 50) return [];
  const questions = [];

  // Strategy 1: Find "שאלה X" headers anywhere in text (not just line starts)
  const qHeaders = [...examText.matchAll(/שאלה\s*(\d+)\s*[:.?]?\s*/g)];
  console.log(`[parser] Found ${qHeaders.length} "שאלה" headers in ${examText.length} chars`);

  if (qHeaders.length > 0) {
    for (let i = 0; i < qHeaders.length; i++) {
      const qNum = parseInt(qHeaders[i][1]);
      const regionStart = qHeaders[i].index + qHeaders[i][0].length;
      const regionEnd = i + 1 < qHeaders.length ? qHeaders[i + 1].index : Math.min(regionStart + 3000, examText.length);
      const region = examText.slice(regionStart, regionEnd);

      // Find Hebrew-letter options: א. / ב. / ג. / ד. (with flexible punctuation)
      const opts = [];
      const HEB_LETTERS = 'אבגדהוזחט';
      for (const m of region.matchAll(/([א-ט])\s*[.)]\s*(.{2,}?)(?=\s*[א-ט]\s*[.)]|\s*שאלה\s*\d|$)/gs)) {
        const letter = m[1];
        const letterIdx = HEB_LETTERS.indexOf(letter);
        // Accept if it's the expected next letter (sequential: א then ב then ג...)
        if (letterIdx === opts.length) {
          opts.push(m[2].replace(/\n/g, ' ').trim());
        }
      }

      // Fallback: try numeric options (1. / 2. / 3. / 4.)
      if (opts.length < 2) {
        opts.length = 0;
        for (const m of region.matchAll(/([1-9])\s*[.)]\s*(.{2,}?)(?=\s*[1-9]\s*[.)]|\s*שאלה\s*\d|$)/gs)) {
          const num = parseInt(m[1]);
          if (num === opts.length + 1) {
            opts.push(m[2].replace(/\n/g, ' ').trim());
          }
        }
      }

      if (opts.length >= 3) { // MCQ needs at least 3 options (usually 4)
        // Filter out open questions: sub-items like "הוכיחו כי..." aren't MCQ options
        const openPatterns = /^(הוכיח|הפריכ|הראה|הראו|תנו דוגמ|הסביר|בנו מכונ|צייר|כתבו|מצאו|חשבו|הגדיר|נגדיר|תהא|נתון|פתרון|תאר|סדרו|ענו|פרקו|חשב)/;
        const isOpen = opts.some(o => openPatterns.test(o.trim()));
        if (isOpen) continue; // skip open questions
        // Also skip if options contain "תשובה ריקה" (answer boxes for open questions)
        if (opts.some(o => o.includes('תשובה ריקה'))) continue;

        // Extract question stem (text before first option)
        const firstOptMatch = region.match(/[א-ט]\s*[.)]/);
        const stemEnd = firstOptMatch ? firstOptMatch.index : 200;
        const stem = region.slice(0, stemEnd).replace(/\n/g, ' ').trim();

        questions.push({
          n: qNum,
          q: stem || `שאלה ${qNum}`,
          opts,
          correct: null,
        });
      }
    }
  }

  // Strategy 2: No "שאלה X" headers — find groups of consecutive א./ב./ג./ד. options
  if (questions.length === 0) {
    console.log('[parser] No headers found, trying option-group detection');
    const HEB = 'אבגד';
    // Find all Hebrew-letter option markers
    const allOpts = [...examText.matchAll(/([א-ד])\s*[.)]\s*(.{2,}?)(?=\s*[א-ד]\s*[.)]|\n\n|$)/gs)];
    let group = [];
    for (const m of allOpts) {
      const letterIdx = HEB.indexOf(m[1]);
      if (letterIdx === 0 && group.length >= 2) {
        // Start of new group — save previous
        questions.push({ n: questions.length + 1, q: `שאלה ${questions.length + 1}`, opts: group.map(g => g.text), correct: null });
        group = [{ letter: m[1], text: m[2].replace(/\n/g, ' ').trim() }];
      } else if (letterIdx === group.length) {
        group.push({ letter: m[1], text: m[2].replace(/\n/g, ' ').trim() });
      } else {
        if (group.length >= 2) {
          questions.push({ n: questions.length + 1, q: `שאלה ${questions.length + 1}`, opts: group.map(g => g.text), correct: null });
        }
        group = letterIdx === 0 ? [{ letter: m[1], text: m[2].replace(/\n/g, ' ').trim() }] : [];
      }
    }
    if (group.length >= 2) {
      questions.push({ n: questions.length + 1, q: `שאלה ${questions.length + 1}`, opts: group.map(g => g.text), correct: null });
    }
  }

  console.log(`[parser] Extracted ${questions.length} questions total`);

  // Try to find correct answers from solution text
  if (solText && questions.length > 0) {
    // Common patterns in Hebrew solution PDFs
    for (const q of questions) {
      const patterns = [
        new RegExp(`שאלה\\s*${q.n}\\s*[:.\\-–]\\s*(?:תשובה\\s*)?([1-9]|[א-ד])`, 'i'),
        new RegExp(`(?:^|\\n)\\s*${q.n}\\s*[.):]\\s*([א-ד])`, 'm'),
        new RegExp(`תשובה\\s*(?:נכונה\\s*)?(?:לשאלה\\s*)?${q.n}\\s*[:.\\-–]\\s*([1-9]|[א-ד])`, 'i'),
      ];
      for (const p of patterns) {
        const m = solText.match(p);
        if (m) {
          const ans = parseInt(m[1]) || ('אבגד'.indexOf(m[1]) + 1);
          if (ans >= 1 && ans <= q.opts.length) { q.correct = ans; break; }
        }
      }
    }
  }

  return questions;
}

function buildExtractionPrompt(text, hasSolution) {
  return `אתה מומחה בחילוץ שאלות אמריקאיות ממבחנים. חלץ את כל השאלות מהטקסט הבא.

עבור כל שאלה, החזר:
- מספר השאלה
- טקסט השאלה
- רשימת התשובות (מספר 1 עד N)
- ${hasSolution ? 'אינדקס התשובה הנכונה (1-based)' : 'אינדקס התשובה הנכונה אם ניתן לזהות, אחרת 1'}

החזר JSON בלבד, ללא markdown, בפורמט הבא:
[{"n":1,"q":"טקסט השאלה","opts":["תשובה 1","תשובה 2","תשובה 3","תשובה 4"],"correct":2}]

הטקסט:
${text.slice(0, 50000)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  try {
    // Parse multipart
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

    // ===== Run Cloudinary upload + Gemini Vision in PARALLEL =====
    const cleanEnv = s => (s || '').replace(/\\n/g, '').replace(/\s+/g, '').trim();
    const cloudName = cleanEnv(process.env.CLOUDINARY_CLOUD_NAME);
    const cloudKey = cleanEnv(process.env.CLOUDINARY_API_KEY);
    const cloudSecret = cleanEnv(process.env.CLOUDINARY_API_SECRET);
    let pdfCloudinaryId = null;
    const examBase64 = Buffer.from(examFile.data).toString('base64');
    const solBase64 = solFile ? Buffer.from(solFile.data).toString('base64') : null;

    // Start both tasks at the same time
    const cloudinaryPromise = (async () => {
      if (!cloudName || !cloudKey || !cloudSecret) return null;
      try {
        const publicId = `examprep/${auth.userId}/${exam.id}/exam`;
        const timestamp = String(Math.floor(Date.now() / 1000));
        const { createHash } = await import('node:crypto');
        const signature = createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${cloudSecret}`).digest('hex');
        console.log(`[upload] Cloudinary: uploading ${examFile.data.length} bytes...`);
        const r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: `data:application/pdf;base64,${examBase64}`, public_id: publicId, api_key: cloudKey, timestamp, signature }),
        });
        if (r.ok) { const d = await r.json(); console.log(`[upload] Cloudinary OK: ${d.public_id}`); return d.public_id; }
        console.error(`[upload] Cloudinary ${r.status}:`, (await r.text()).slice(0, 200));
        return null;
      } catch (e) { console.error('[upload] Cloudinary:', e.message); return null; }
    })();

    const geminiPromise = (async () => {
      try {
        const result = await analyzeExamWithGemini(examBase64, solBase64);
        if (result?.length) { console.log(`[upload] Gemini: ${result.length} MCQs found`); return result; }
      } catch (e) { console.error('[upload] Gemini error:', e.message); }
      // Fallback: regex
      try {
        console.log('[upload] Gemini failed, trying regex fallback...');
        const { extractText } = await import('unpdf');
        const examText = (await extractText(new Uint8Array(examFile.data), { mergePages: true }))?.text?.trim() || '';
        const solText = solFile ? (await extractText(new Uint8Array(solFile.data), { mergePages: true }))?.text?.trim() || '' : '';
        const qs = parseQuestionsFromText(examText, solText);
        console.log(`[upload] regex fallback: ${qs.length} questions`);
        return qs;
      } catch (e) { console.warn('[upload] regex fallback failed:', e.message); return []; }
    })();

    // Wait for both to complete
    const [cloudinaryId, questions_raw] = await Promise.all([cloudinaryPromise, geminiPromise]);
    pdfCloudinaryId = cloudinaryId;
    let questions = questions_raw || [];

    // ===== Step 3: USE GEMINI's y_top/y_bottom directly =====
    // No more unpdf text parsing — trust AI's visual analysis
    const RENDER_H = 2070; // Cloudinary renders letter PDF at w_1600 → ~2070px tall

    // Dedup by question number
    const seenNums = new Set();
    questions = questions.filter(q => { if (seenNums.has(q.n)) return false; seenNums.add(q.n); return true; });
    console.log(`[upload] ${questions.length} unique MCQs`);

    // Build image URLs using Gemini's y_top/y_bottom + store in DB
    if (questions.length > 0) {
      const qRecords = questions.map((q, i) => {
        const pageNum = q.page || 2;
        let imagePath = 'text-only';
        if (pdfCloudinaryId) {
          const yTop = q.y_top ?? 0;
          const yBottom = q.y_bottom ?? Math.min(yTop + 25, 100);
          const yPx = Math.max(0, Math.round((yTop / 100) * RENDER_H));
          const hPx = Math.max(Math.round(((yBottom - yTop) / 100) * RENDER_H), 150);
          imagePath = `https://res.cloudinary.com/${cloudName}/image/upload/pg_${pageNum},w_1600/c_crop,w_1600,h_${hPx},y_${yPx},g_north/q_auto/${pdfCloudinaryId}.png`;
          console.log(`[crop] q${q.n} p${pageNum}: ${yTop}%-${yBottom}% → y=${yPx} h=${hPx}`);
        }
        return {
          exam_id: exam.id, course_id: courseIdInt, user_id: auth.userId,
          question_number: q.n || (i + 1), image_path: imagePath,
          num_options: 4, correct_idx: q.correct || 1,
          option_labels: null, general_explanation: q.explanation || null, is_ai_generated: true,
        };
      });
      console.log(`[upload] inserting ${qRecords.length} questions`);
      const { error: qErr } = await auth.db.from('ep_questions').insert(qRecords);
      if (qErr) {
        console.error('[upload] batch insert failed:', qErr.message);
        let ok = 0;
        for (const r of qRecords) { if (!(await auth.db.from('ep_questions').insert(r)).error) ok++; }
        console.log(`[upload] individual: ${ok}/${qRecords.length}`);
      }
    }

    const fileWarnings = [];

    // Update exam status — always 'ready' after processing (even with 0 questions)
    await auth.db.from('ep_exams').update({
      status: 'ready',
      question_count: questions.length,
      processed_at: new Date().toISOString(),
    }).eq('id', exam.id);

    // Update course counters
    const [{ count: qCount }, { count: pdfCount }] = await Promise.all([
      auth.db.from('ep_questions').select('id', { count: 'exact', head: true })
        .eq('course_id', courseIdInt),
      auth.db.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', courseIdInt),
    ]);
    await auth.db.from('ep_courses').update({ total_questions: qCount, total_pdfs: pdfCount }).eq('id', courseIdInt);

    // Build warnings
    if (questions.length === 0) {
      fileWarnings.push('לא זוהו שאלות אמריקאיות בקובץ. ודא שהמבחן מכיל שאלות רב-ברירה בפורמט מוכר.');
    }

    res.json({
      ok: true,
      exam_id: exam.id,
      question_count: questions.length,
      mode: 'gemini-vision',
      ...(fileWarnings.length && { warnings: fileWarnings }),
    });
  } catch (err) {
    console.error('[upload] fatal:', err?.message || err, err?.stack?.split('\n')[1] || '');
    // Mark exam as failed so it can be deleted
    try {
      if (auth?.db) {
        const examId = err?._examId;
        // Try to find and update any 'processing' exam for this user
        await auth.db.from('ep_exams').update({ status: 'failed' }).eq('user_id', auth.userId).eq('status', 'processing');
      }
    } catch {}
    res.status(500).json({ error: 'שגיאה פנימית בהעלאה' });
  }
}
