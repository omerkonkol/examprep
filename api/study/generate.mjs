// =====================================================
// Vercel Serverless Function — POST /api/study/generate
// =====================================================
// Smart Study from Summary: takes a PDF (multipart) or pasted text (JSON),
// extracts the text, asks the Gemini model to produce a full study pack
// (questions, flashcards, outline, glossary, open questions, self-test),
// and returns the JSON to the client.
//
// Notes for the Vercel runtime:
// - bodyParser is disabled so we can stream multipart uploads ourselves.
// - busboy parses multipart without buffering the whole request.
// - pdfjs-dist (legacy build) is used for text extraction; we run it with
//   disableWorker so it works in a single Node process.
// - GEMINI_API_KEY must be set in the Vercel project's env vars.
// =====================================================

import Busboy from 'busboy';

export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB hard ceiling for serverless
const MAX_PDF_PAGES = 30;
const MIN_TEXT = 300;
const MAX_TEXT = 60_000;

// ----- Multipart parsing -----------------------------------------------------

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 10 },
    });
    const fields = {};
    let pdfBuffer = null;
    let pdfMime = null;
    let pdfName = null;
    let truncated = false;

    busboy.on('file', (name, file, info) => {
      if (name !== 'pdf') {
        file.resume();
        return;
      }
      pdfMime = info.mimeType || info.mime;
      pdfName = info.filename;
      const chunks = [];
      file.on('data', (c) => chunks.push(c));
      file.on('limit', () => { truncated = true; });
      file.on('end', () => { pdfBuffer = Buffer.concat(chunks); });
    });
    busboy.on('field', (name, val) => { fields[name] = val; });
    busboy.on('error', (err) => reject(err));
    busboy.on('finish', () => {
      if (truncated) {
        return reject(Object.assign(new Error('PDF too large'), { http: 413 }));
      }
      resolve({ fields, pdfBuffer, pdfMime, pdfName });
    });

    req.pipe(busboy);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > 200 * 1024) {
        reject(Object.assign(new Error('JSON body too large'), { http: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON body'), { http: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ----- PDF magic check -------------------------------------------------------

function isPdfMagic(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;
}

// ----- PDF text extraction (pdfjs-dist legacy build) -------------------------

async function extractPdfText(pdfBuffer, maxPages = MAX_PDF_PAGES) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdfDoc = await loadingTask.promise;
  const pageCount = Math.min(pdfDoc.numPages, maxPages);
  const chunks = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDoc.getPage(i);
    const tc = await page.getTextContent();
    const lineMap = new Map();
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      const list = lineMap.get(y) || [];
      list.push({ x: it.transform[4], str: it.str });
      lineMap.set(y, list);
    }
    const sortedYs = [...lineMap.keys()].sort((a, b) => b - a); // top → bottom
    for (const y of sortedYs) {
      const line = lineMap.get(y).sort((a, b) => b.x - a.x); // RTL: rightmost first
      const text = line.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (text) chunks.push(text);
    }
    chunks.push('');
    page.cleanup();
  }
  await pdfDoc.cleanup();
  await pdfDoc.destroy();
  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ----- AI prompt + call ------------------------------------------------------

function buildPrompt(summaryText, title) {
  const safe = summaryText.length > 30000
    ? summaryText.slice(0, 30000) + '\n[...truncated]'
    : summaryText;
  return `אתה מורה מומחה שיוצר חומרי לימוד איכותיים בעברית מסיכום של סטודנט.

הסיכום (כותרת: "${title}"):
"""
${safe}
"""

צור חבילת לימוד שלמה שעוזרת לסטודנט להבין את החומר ברמה גבוהה. עליך להחזיר אך ורק JSON תקני (ללא markdown, ללא טקסט נוסף, ללא הסברים מחוץ ל-JSON) בפורמט הבא:

{
  "summary": "סקירה תמציתית של הסיכום ב-2-3 משפטים",
  "questions": [
    {
      "stem": "שאלה אמריקאית ברמת מבחן",
      "options": ["אופציה 1", "אופציה 2", "אופציה 3", "אופציה 4"],
      "correctIdx": 1,
      "explanation": "הסבר קצר למה התשובה הזו נכונה"
    }
  ],
  "flashcards": [
    { "front": "מושג / שאלה קצרה", "back": "הגדרה / תשובה ברורה" }
  ],
  "outline": [
    {
      "title": "פרק עליון 1",
      "items": [
        { "title": "תת-נושא 1.1", "items": ["נקודה", "נקודה"] },
        { "title": "תת-נושא 1.2", "items": ["נקודה"] }
      ]
    }
  ],
  "glossary": [
    { "term": "מושג מפתח", "definition": "הגדרה ברורה ב-1-2 משפטים" }
  ],
  "openQuestions": [
    { "question": "שאלה פתוחה לחשיבה עמוקה", "modelAnswer": "תשובה מומלצת מפורטת" }
  ],
  "selfTest": [
    { "type": "mcq", "stem": "...", "options": ["..","..","..",".."], "correctIdx": 1 },
    { "type": "flashcard", "front": "..", "back": ".." }
  ]
}

דרישות:
- 8-12 שאלות אמריקאיות ב-questions, ברמה אקדמית, עם 4 אופציות, הסבר למה הנכונה נכונה.
- 12-20 כרטיסיות ב-flashcards, מושג→הגדרה.
- 3-6 פרקים ב-outline, כל אחד עם 2-4 תת-נושאים.
- 10-20 מושגים ב-glossary.
- 4-8 שאלות פתוחות ב-openQuestions, עם תשובות מומלצות מפורטות (3-5 משפטים כל אחת).
- 8-10 פריטים ב-selfTest (ערבוב mcq + flashcard).
- correctIdx הוא 1-בסיסי (1, 2, 3, או 4).
- הכל בעברית. אם הסיכום באנגלית - כתוב את כל החומר באנגלית במקום.
- אסור להמציא עובדות שלא בסיכום. הסתמך על מה שהמשתמש כתב.`;
}

async function callGemini(summaryText, title) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (!apiKey) {
    throw Object.assign(new Error('GEMINI_API_KEY not configured'), { http: 503, code: 'no_api_key' });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 55_000);
  let aiRes;
  try {
    aiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(summaryText, title) }] }],
        generationConfig: {
          temperature: 0.6,
          topP: 0.95,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw Object.assign(new Error('AI timeout'), { http: 504 });
    }
    throw Object.assign(new Error('AI fetch failed: ' + (e?.message || e)), { http: 502 });
  } finally {
    clearTimeout(t);
  }

  if (!aiRes.ok) {
    const txt = await aiRes.text().catch(() => '');
    console.error('[study] Gemini HTTP', aiRes.status, txt.slice(0, 400));
    throw Object.assign(new Error('AI provider error'), { http: 502 });
  }
  const payload = await aiRes.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw Object.assign(new Error('Empty AI response'), { http: 502 });

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    console.error('[study] JSON parse failed:', e?.message, 'sample:', cleaned.slice(0, 400));
    throw Object.assign(new Error('Invalid AI JSON'), { http: 502 });
  }

  // Sanitize + clamp
  const clampStr = (s, n) => String(s || '').slice(0, n);
  const safe = {
    summary: clampStr(parsed.summary, 800),
    questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 12)
      .filter(q => q && typeof q.stem === 'string' && Array.isArray(q.options) && q.options.length === 4)
      .map(q => ({
        stem: clampStr(q.stem, 800),
        options: q.options.slice(0, 4).map(o => clampStr(o, 400)),
        correctIdx: Math.min(Math.max(parseInt(q.correctIdx, 10) || 1, 1), 4),
        explanation: clampStr(q.explanation, 1000),
      })) : [],
    flashcards: Array.isArray(parsed.flashcards) ? parsed.flashcards.slice(0, 25)
      .filter(c => c && (c.front || c.back))
      .map(c => ({ front: clampStr(c.front, 400), back: clampStr(c.back, 800) })) : [],
    outline: Array.isArray(parsed.outline) ? parsed.outline.slice(0, 8)
      .map(s => ({
        title: clampStr(s?.title, 200),
        items: Array.isArray(s?.items) ? s.items.slice(0, 8).map(it => {
          if (typeof it === 'string') return { title: clampStr(it, 200), items: [] };
          return {
            title: clampStr(it?.title, 200),
            items: Array.isArray(it?.items) ? it.items.slice(0, 8).map(p => clampStr(p, 300)) : [],
          };
        }) : [],
      })) : [],
    glossary: Array.isArray(parsed.glossary) ? parsed.glossary.slice(0, 25)
      .filter(g => g && g.term)
      .map(g => ({ term: clampStr(g.term, 150), definition: clampStr(g.definition, 600) })) : [],
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.slice(0, 10)
      .filter(q => q && q.question)
      .map(q => ({ question: clampStr(q.question, 600), modelAnswer: clampStr(q.modelAnswer, 1500) })) : [],
    selfTest: Array.isArray(parsed.selfTest) ? parsed.selfTest.slice(0, 12)
      .map(it => {
        if (it?.type === 'mcq' && Array.isArray(it.options) && it.options.length === 4) {
          return {
            type: 'mcq',
            stem: clampStr(it.stem, 800),
            options: it.options.slice(0, 4).map(o => clampStr(o, 400)),
            correctIdx: Math.min(Math.max(parseInt(it.correctIdx, 10) || 1, 1), 4),
          };
        }
        if (it?.type === 'flashcard') {
          return { type: 'flashcard', front: clampStr(it.front, 400), back: clampStr(it.back, 800) };
        }
        return null;
      }).filter(Boolean) : [],
  };

  if (!safe.questions.length && !safe.flashcards.length) {
    throw Object.assign(new Error('AI returned empty study pack'), { http: 502 });
  }
  return safe;
}

// ----- Main handler ----------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const ct = String(req.headers['content-type'] || '');
    let summaryText = '';
    let title = '';
    let kind = 'paste';

    if (ct.startsWith('multipart/form-data')) {
      const parsed = await parseMultipart(req);
      if (!parsed.pdfBuffer) {
        return res.status(400).json({ error: 'חסר קובץ PDF' });
      }
      if (!isPdfMagic(parsed.pdfBuffer)) {
        return res.status(400).json({ error: 'הקובץ אינו PDF תקני' });
      }
      try {
        summaryText = await extractPdfText(parsed.pdfBuffer);
      } catch (e) {
        console.error('[study] pdf extract:', e?.message || e);
        return res.status(400).json({ error: 'לא הצלחנו לקרוא את ה-PDF. נסה להדביק את הטקסט ידנית.' });
      }
      kind = 'pdf';
      title = String(parsed.fields.title || parsed.pdfName || 'סיכום ללא שם')
        .replace(/\.pdf$/i, '')
        .slice(0, 120) || 'סיכום ללא שם';
    } else {
      const body = await readJsonBody(req);
      if (typeof body.text !== 'string') {
        return res.status(400).json({ error: 'חסר טקסט סיכום' });
      }
      summaryText = body.text;
      title = String(body.title || 'סיכום ללא שם').slice(0, 120);
      kind = 'paste';
    }

    summaryText = String(summaryText || '').trim();
    if (summaryText.length < MIN_TEXT) {
      return res.status(400).json({ error: 'הסיכום קצר מדי. צריך לפחות 300 תווים כדי ליצור חומרי לימוד איכותיים.' });
    }
    if (summaryText.length > MAX_TEXT) {
      summaryText = summaryText.slice(0, MAX_TEXT);
    }

    const materials = await callGemini(summaryText, title);
    return res.status(200).json({
      ok: true,
      pack_id: null,
      title,
      source_kind: kind,
      materials,
    });
  } catch (err) {
    const status = err?.http || 500;
    console.error('[study] handler error:', err?.message || err);
    if (err?.code === 'no_api_key') {
      return res.status(503).json({
        error: 'הפיצ\'ר עוד לא מוגדר בשרת. צור קשר עם המנהל.',
        reason: 'no_api_key',
      });
    }
    return res.status(status).json({
      error: err?.message?.startsWith('הסיכום') || err?.message?.startsWith('הקובץ')
        ? err.message
        : 'שגיאה ביצירת חבילת הלימוד. נסה שוב.',
    });
  }
}
