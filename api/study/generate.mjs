// =====================================================
// Vercel Serverless Function — POST /api/study/generate
// =====================================================
// Smart Study: PDF or text → AI study pack (questions, flashcards, etc.)
//
// Two input modes:
//   multipart/form-data { pdf: File, title?: string }
//   application/json { kind: 'paste', text: string, title?: string }
//
// GEMINI_API_KEY must be set in Vercel env vars (free tier OK).
// =====================================================

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MIN_TEXT = 300;
const MAX_TEXT = 60_000;

// ----- Collect raw body as Buffer -------------------------------------------
function rawBody(req, limit = MAX_PDF_BYTES + 512 * 1024) {
  return new Promise((resolve, reject) => {
    // If Vercel already parsed the body into a Buffer
    if (req.body && Buffer.isBuffer(req.body)) return resolve(req.body);
    if (req.body && typeof req.body === 'string') return resolve(Buffer.from(req.body));

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(Object.assign(new Error('Body too large'), { http: 413 })); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ----- Parse multipart/form-data from a Buffer -----------------------------
function parseMultipart(buf, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!boundaryMatch) throw Object.assign(new Error('No multipart boundary'), { http: 400 });
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(sep);
  while (start !== -1) {
    start += sep.length;
    // Skip \r\n after boundary
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    // Check for closing boundary --
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    const nextBoundary = buf.indexOf(sep, start);
    if (nextBoundary === -1) break;
    // Part = headers + \r\n\r\n + body
    const partBuf = buf.slice(start, nextBoundary - 2); // -2 for trailing \r\n
    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = nextBoundary; continue; }
    const headerStr = partBuf.slice(0, headerEnd).toString('utf8');
    const body = partBuf.slice(headerEnd + 4);
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    parts.push({
      name: nameMatch?.[1] || '',
      filename: filenameMatch?.[1] || null,
      data: body,
      headers: headerStr,
    });
    start = nextBoundary;
  }
  return parts;
}

// ----- PDF magic check -------------------------------------------------------
function isPdfMagic(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

// ----- PDF text extraction ---------------------------------------------------
async function extractPdfText(pdfBuffer) {
  // Try multiple import paths for pdfjs-dist compatibility
  let pdfjsLib;
  try {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    try {
      pdfjsLib = await import('pdfjs-dist');
    } catch (e2) {
      console.error('[study] pdfjs import failed:', e2?.message);
      throw new Error('PDF library unavailable');
    }
  }

  const data = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdfDoc = await loadingTask.promise;
  const pageCount = Math.min(pdfDoc.numPages, 30);
  const chunks = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDoc.getPage(i);
    const tc = await page.getTextContent();
    const lineMap = new Map();
    for (const it of tc.items) {
      if (!it.str) continue;
      const y = Math.round(it.transform[5]);
      const list = lineMap.get(y) || [];
      list.push({ x: it.transform[4], str: it.str });
      lineMap.set(y, list);
    }
    const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);
    for (const y of sortedYs) {
      const line = lineMap.get(y).sort((a, b) => b.x - a.x);
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
  // Try models in order of preference: 2.5-flash > 2.0-flash > flash-lite
  const models = (process.env.GEMINI_MODEL || 'gemini-2.5-flash,gemini-2.0-flash,gemini-2.0-flash-lite').split(',');
  if (!apiKey) {
    throw Object.assign(new Error('GEMINI_API_KEY not configured'), { http: 503, code: 'no_api_key' });
  }

  const prompt = buildPrompt(summaryText, title);
  let lastErr = null;

  for (const model of models) {
    const m = model.trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 55_000);
    let aiRes;
    try {
      console.log(`[study] trying model: ${m}`);
      aiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.6,
            topP: 0.95,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(t);
      if (e?.name === 'AbortError') {
        lastErr = Object.assign(new Error('AI timeout'), { http: 504 });
        continue;
      }
      lastErr = Object.assign(new Error('AI fetch: ' + (e?.message || e)), { http: 502 });
      continue;
    } finally {
      clearTimeout(t);
    }

    if (aiRes.status === 503 || aiRes.status === 429) {
      const txt = await aiRes.text().catch(() => '');
      console.warn(`[study] ${m} returned ${aiRes.status}, trying next. ${txt.slice(0, 200)}`);
      lastErr = Object.assign(new Error(`Model ${m} unavailable (${aiRes.status})`), { http: 503 });
      continue;
    }
    if (!aiRes.ok) {
      const txt = await aiRes.text().catch(() => '');
      console.error(`[study] ${m} HTTP ${aiRes.status}:`, txt.slice(0, 400));
      lastErr = Object.assign(new Error('AI provider error'), { http: 502 });
      continue;
    }

    const payload = await aiRes.json();
    const text = payload?.candidates?.[0]?.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '';
    if (!text) {
      lastErr = Object.assign(new Error('Empty AI response'), { http: 502 });
      continue;
    }

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      console.error(`[study] JSON parse failed from ${m}:`, e?.message, 'sample:', cleaned.slice(0, 300));
      lastErr = Object.assign(new Error('Invalid AI JSON'), { http: 502 });
      continue;
    }

    // Sanitize
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
              type: 'mcq', stem: clampStr(it.stem, 800),
              options: it.options.slice(0, 4).map(o => clampStr(o, 400)),
              correctIdx: Math.min(Math.max(parseInt(it.correctIdx, 10) || 1, 1), 4),
            };
          }
          if (it?.type === 'flashcard') return { type: 'flashcard', front: clampStr(it.front, 400), back: clampStr(it.back, 800) };
          return null;
        }).filter(Boolean) : [],
    };

    if (!safe.questions.length && !safe.flashcards.length) {
      lastErr = Object.assign(new Error('AI returned empty pack'), { http: 502 });
      continue;
    }
    console.log(`[study] success with model ${m}: ${safe.questions.length} questions, ${safe.flashcards.length} flashcards`);
    return safe;
  }

  throw lastErr || Object.assign(new Error('All models failed'), { http: 502 });
}

// ----- Main handler ----------------------------------------------------------
export default async function handler(req, res) {
  // CORS for same-origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const ct = String(req.headers['content-type'] || '');
    let summaryText = '';
    let title = '';
    let kind = 'paste';

    const body = await rawBody(req);
    console.log(`[study] received ${body.length} bytes, content-type: ${ct.slice(0, 60)}`);

    if (ct.startsWith('multipart/form-data')) {
      // Parse multipart from buffer
      const parts = parseMultipart(body, ct);
      const pdfPart = parts.find(p => p.name === 'pdf' && p.filename);
      const titlePart = parts.find(p => p.name === 'title');

      if (!pdfPart || !pdfPart.data.length) {
        return res.status(400).json({ error: 'חסר קובץ PDF' });
      }
      if (pdfPart.data.length > MAX_PDF_BYTES) {
        return res.status(413).json({ error: 'הקובץ גדול מדי (מקסימום 10MB)' });
      }
      if (!isPdfMagic(pdfPart.data)) {
        return res.status(400).json({ error: 'הקובץ אינו PDF תקני' });
      }

      console.log(`[study] PDF file: ${pdfPart.filename}, ${pdfPart.data.length} bytes`);

      try {
        summaryText = await extractPdfText(pdfPart.data);
        console.log(`[study] extracted ${summaryText.length} chars from PDF`);
      } catch (e) {
        console.error('[study] PDF extract error:', e?.message || e);
        return res.status(400).json({ error: 'לא הצלחנו לקרוא את ה-PDF. נסה להדביק את הטקסט ידנית.' });
      }

      kind = 'pdf';
      title = (titlePart?.data?.toString('utf8')?.trim()) ||
              (pdfPart.filename || 'סיכום ללא שם').replace(/\.pdf$/i, '').slice(0, 120);
    } else {
      // JSON body
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return res.status(400).json({ error: 'Invalid JSON' }); }

      if (typeof parsed.text !== 'string') {
        return res.status(400).json({ error: 'חסר טקסט סיכום' });
      }
      summaryText = parsed.text;
      title = String(parsed.title || 'סיכום ללא שם').slice(0, 120);
    }

    summaryText = String(summaryText || '').trim();
    if (summaryText.length < MIN_TEXT) {
      return res.status(400).json({ error: `הסיכום קצר מדי (${summaryText.length} תווים). צריך לפחות ${MIN_TEXT} תווים.` });
    }
    if (summaryText.length > MAX_TEXT) {
      summaryText = summaryText.slice(0, MAX_TEXT);
    }

    console.log(`[study] calling AI with ${summaryText.length} chars, title: "${title}"`);
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
    console.error('[study] handler error:', err?.message || err, err?.stack?.split('\n')[1] || '');
    if (err?.code === 'no_api_key') {
      return res.status(503).json({ error: 'מפתח API לא מוגדר בשרת.', reason: 'no_api_key' });
    }
    return res.status(status).json({
      error: 'שגיאה ביצירת חבילת הלימוד. נסה שוב בעוד כמה שניות.',
    });
  }
}
