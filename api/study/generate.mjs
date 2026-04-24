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

import { createClient } from '@supabase/supabase-js';
import { checkIpThrottle } from '../../lib/ipThrottle.mjs';
import { getQuota } from '../_lib/quotas.mjs';
import { assertNotModelim } from '../_lib/seed-guard.mjs';

export const config = {
  api: { bodyParser: false },
  maxDuration: 120,
};

// ----- Supabase helpers -------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

function userClient(jwt) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.substring(7);
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE || SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id, userEmail: data.user.email, userJwt: token };
}

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

// ----- PDF text extraction (unpdf — serverless-safe, zero native deps) -------
async function extractPdfText(pdfBuffer) {
  const { extractText } = await import('unpdf');
  const result = await extractText(new Uint8Array(pdfBuffer), { mergePages: true });
  // unpdf returns { totalPages: number, text: string }
  const text = (result?.text || '').trim();
  console.log(`[study] unpdf extracted ${text.length} chars from ${result?.totalPages || '?'} pages`);
  if (!text) throw new Error('PDF contains no extractable text');
  return text;
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
- 5-7 שאלות אמריקאיות ב-questions, ברמה אקדמית, עם 4 אופציות, הסבר למה הנכונה נכונה.
- 8-12 כרטיסיות ב-flashcards, מושג→הגדרה.
- 2-4 פרקים ב-outline, כל אחד עם 2-4 תת-נושאים.
- 6-12 מושגים ב-glossary.
- 3-5 שאלות פתוחות ב-openQuestions, עם תשובות מומלצות מפורטות (3-5 משפטים כל אחת).
- 5-7 פריטים ב-selfTest (ערבוב mcq + flashcard).
- correctIdx הוא 1-בסיסי (1, 2, 3, או 4).
- הכל בעברית. אם הסיכום באנגלית - כתוב את כל החומר באנגלית במקום.
- אסור להמציא עובדות שלא בסיכום. הסתמך על מה שהמשתמש כתב.`;
}

import { getGeminiKeys, isQuotaError } from '../_lib/gemini-key.mjs';
import { MODEL_CHAIN } from '../_lib/gemini-models.mjs';

async function callGemini(summaryText, title) {
  const { primaryKey, fallbackKey, hasPaid } = getGeminiKeys();
  // Try models in order of preference; each has a separate daily quota pool
  const models = MODEL_CHAIN.extraction;
  if (!primaryKey) {
    throw Object.assign(new Error('GEMINI_API_KEY not configured'), { http: 503, code: 'no_api_key' });
  }
  console.log(`[study] using ${hasPaid ? 'paid' : 'free'} key as primary`);

  const prompt = buildPrompt(summaryText, title);
  let lastErr = null;

  async function tryCall(apiKey, m) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 22_000);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.6,
            topP: 0.95,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
          },
        }),
        signal: controller.signal,
      });
    } finally { clearTimeout(t); }
  }

  for (const model of models) {
    const m = model.trim();
    let aiRes;
    try {
      console.log(`[study] trying model: ${m}`);
      aiRes = await tryCall(primaryKey, m);
      if (isQuotaError(aiRes.status, null) && fallbackKey) {
        console.warn(`[study] ${m} primary quota exceeded — switching to fallback key`);
        aiRes = await tryCall(fallbackKey, m);
      }
    } catch (e) {
      if (e?.name === 'AbortError') {
        lastErr = Object.assign(new Error('AI timeout'), { http: 504 });
        continue;
      }
      lastErr = Object.assign(new Error('AI fetch: ' + (e?.message || e)), { http: 502 });
      continue;
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
// Restrict to our own origin(s). Wildcard CORS lets any site's JS burn our Gemini quota via a logged-in user's browser.
const ALLOWED_ORIGINS = new Set([
  'https://try.examprep.com',
  'https://www.try.examprep.com',
  'https://examprep.vercel.app',
]);

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Study pack generation is our most token-heavy endpoint — strict limit
  const throttle = await checkIpThrottle(req, 'study_generate', { maxDay: 8, maxWeek: 25, blockHours: 24 });
  if (!throttle.allowed) {
    return res.status(429).json({ error: 'הגעת למכסת הבקשות. נסה שוב מאוחר יותר.', reason: throttle.reason });
  }

  // Authenticate user (best-effort — used for DB save; generation continues even if anonymous)
  const authUser = await authenticate(req).catch(() => null);

  // Modelim plan check runs before any body validation so short/empty posts
  // still get the 403 instead of leaking a validation message.
  if (authUser) {
    try {
      const guardSvc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
      const { data: guardProf } = await guardSvc.from('profiles').select('plan, is_admin').eq('id', authUser.userId).maybeSingle();
      if (assertNotModelim(res, guardProf)) return;
    } catch (e) { console.warn('[study] modelim guard failed:', e?.message); }
  }

  // Enforce plan quota for authenticated users (IP throttle above covers anonymous)
  if (authUser) {
    try {
      const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
      await svc.rpc('reset_user_quotas_if_needed', { p_user_id: authUser.userId }).catch(() => {});
      const { data: prof } = await svc.from('profiles').select('plan,is_admin').eq('id', authUser.userId).single();
      const plan = prof?.plan || 'free';
      const isAdmin = !!prof?.is_admin;
      if (!isAdmin) {
        const q = getQuota(plan);
        if (q.pack_month === 0 && q.pack_total === 0) {
          return res.status(402).json({ error: 'הגעת למגבלת חבילות הלמידה.' });
        }
        const { data: granted } = await svc.rpc('ep_reserve_study_pack_slot', {
          p_user_id: authUser.userId,
          p_max_month: q.pack_month,
          p_max_total: q.pack_total,
          p_max_day: q.pack_day,
        }).catch(() => ({ data: true }));
        if (granted === false) {
          return res.status(429).json({ error: 'הגעת למגבלת חבילות הלמידה היומית. נסה שוב מחר.' });
        }
      }
    } catch (quotaErr) {
      console.warn('[study] quota check error (non-fatal):', quotaErr?.message);
    }
  }

  try {
    const ct = String(req.headers['content-type'] || '');
    let summaryText = '';
    let title = '';
    let kind = 'paste';
    let courseId = null;

    const body = await rawBody(req);
    console.log(`[study] received ${body.length} bytes, content-type: ${ct.slice(0, 60)}`);

    if (ct.startsWith('multipart/form-data')) {
      // Parse multipart from buffer
      const parts = parseMultipart(body, ct);
      const pdfPart = parts.find(p => p.name === 'pdf' && p.filename);
      const titlePart = parts.find(p => p.name === 'title');
      const courseIdPart = parts.find(p => p.name === 'courseId');

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
      const rawCourseId = courseIdPart?.data?.toString('utf8')?.trim();
      if (rawCourseId && /^\d+$/.test(rawCourseId)) courseId = parseInt(rawCourseId, 10);
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
      if (parsed.courseId && Number.isInteger(Number(parsed.courseId))) {
        courseId = parseInt(parsed.courseId, 10);
      }
    }

    summaryText = String(summaryText || '').trim();
    if (summaryText.length < MIN_TEXT) {
      return res.status(400).json({ error: `הסיכום קצר מדי (${summaryText.length} תווים). צריך לפחות ${MIN_TEXT} תווים.` });
    }
    if (summaryText.length > MAX_TEXT) {
      summaryText = summaryText.slice(0, MAX_TEXT);
    }

    console.log(`[study] calling AI with ${summaryText.length} chars, title: "${title}", courseId: ${courseId}`);
    const materials = await callGemini(summaryText, title);

    // Best-effort save to DB
    let packId = null;
    if (authUser) {
      try {
        const db = userClient(authUser.userJwt);
        const { data: dbData, error: dbErr } = await db
          .from('ep_study_packs')
          .insert({
            user_id: authUser.userId,
            title,
            source_kind: kind,
            course_id: courseId || null,
            materials,
            status: 'ready',
            processed_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        if (dbErr) {
          console.warn('[study] DB save failed (non-fatal):', dbErr.message);
        } else {
          packId = dbData?.id || null;
          console.log(`[study] saved pack to DB with id=${packId}`);
        }
      } catch (e) {
        console.warn('[study] DB save threw (non-fatal):', e?.message || e);
      }
    }

    return res.status(200).json({
      ok: true,
      pack_id: packId,
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
