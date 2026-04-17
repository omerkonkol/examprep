// =====================================================
// Vercel Serverless Function — POST /api/lab/generate-questions
// =====================================================
// AI question generator for the Lab: given topics, count, difficulty,
// and course name, generates MCQ questions using Gemini.
// =====================================================

import { checkIpThrottle } from '../../lib/ipThrottle.mjs';
import { getGeminiKeys, isQuotaError } from '../_lib/gemini-key.mjs';

export const config = {
  api: { bodyParser: true },
  maxDuration: 60,
};

async function callGemini(prompt) {
  const { primaryKey, fallbackKey, hasPaid } = getGeminiKeys();
  const models = (process.env.GEMINI_MODEL || 'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash,gemini-flash-latest').split(',');
  if (!primaryKey) {
    throw Object.assign(new Error('GEMINI_API_KEY not configured'), { http: 503, code: 'no_api_key' });
  }
  console.log(`[lab] using ${hasPaid ? 'paid' : 'free'} key as primary`);

  async function tryCall(apiKey, m) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 55_000);
    try {
      const aiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.85,
            topP: 0.95,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: controller.signal,
      });
      return { aiRes, bodyText: null };
    } finally { clearTimeout(t); }
  }

  let lastErr = null;
  for (const model of models) {
    const m = model.trim();
    let aiRes;
    try {
      ({ aiRes } = await tryCall(primaryKey, m));
      if (isQuotaError(aiRes.status, null) && fallbackKey) {
        console.warn(`[lab] ${m} primary quota exceeded — switching to fallback key`);
        ({ aiRes } = await tryCall(fallbackKey, m));
      }
    } catch (e) {
      lastErr = Object.assign(new Error(e?.name === 'AbortError' ? 'AI timeout' : 'AI fetch: ' + e?.message), { http: e?.name === 'AbortError' ? 504 : 502 });
      continue;
    }

    if (aiRes.status === 503 || aiRes.status === 429) {
      console.warn(`[lab] ${m} returned ${aiRes.status}, trying next`);
      lastErr = Object.assign(new Error(`Model ${m} unavailable`), { http: 503 });
      continue;
    }
    if (!aiRes.ok) {
      const txt = await aiRes.text().catch(() => '');
      console.error(`[lab] ${m} HTTP ${aiRes.status}:`, txt.slice(0, 300));
      lastErr = Object.assign(new Error('AI error'), { http: 502 });
      continue;
    }

    const payload = await aiRes.json();
    const text = payload?.candidates?.[0]?.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '';
    if (!text) { lastErr = Object.assign(new Error('Empty AI response'), { http: 502 }); continue; }

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(cleaned); }
    catch (e) {
      console.error(`[lab] JSON parse from ${m}:`, e?.message, cleaned.slice(0, 300));
      lastErr = Object.assign(new Error('Invalid AI JSON'), { http: 502 });
      continue;
    }
  }
  throw lastErr || Object.assign(new Error('All models failed'), { http: 502 });
}

const ALLOWED_ORIGINS = new Set([
  'https://try-examprep.com',
  'https://www.try-examprep.com',
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Per-IP throttle: 30/day, 100/week, 24h block on breach
  const throttle = await checkIpThrottle(req, 'lab_generate_questions', { maxDay: 30, maxWeek: 100, blockHours: 24 });
  if (!throttle.allowed) {
    return res.status(429).json({ error: 'הגעת למכסת הבקשות. נסה שוב מאוחר יותר.', reason: throttle.reason });
  }

  try {
    const { topics, count, difficulty, courseName, language } = req.body || {};

    if (!Array.isArray(topics) || topics.length === 0 || topics.length > 8) {
      return res.status(400).json({ error: 'בחר לפחות נושא אחד (עד 8)' });
    }

    const n = Math.min(Math.max(parseInt(count, 10) || 5, 1), 10);
    const diff = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'hard';
    const course = (typeof courseName === 'string' && courseName.length <= 80) ? courseName : 'תוכנה 1 (Java)';
    const lang = language === 'en' ? 'English' : 'Hebrew';

    const difficultyHint = {
      easy: 'תרגול בסיסי - שאלות מבוא ברורות',
      medium: 'שאלות אמצעיות - דורשות הבנה אך לא טריקים',
      hard: 'שאלות ברמת מבחן אוניברסיטאי - טריקיות, דרגת קושי גבוהה, חייבות הבנה עמוקה',
    }[diff];

    const prompt = `אתה מרצה בקורס "${course}" באוניברסיטה. עליך לחבר ${n} שאלות אמריקאיות חדשות לחלוטין ברמת ${difficultyHint}.

הנושאים שעליהם להתמקד (לפי תדירות החזרה במבחנים אמיתיים מהשנים האחרונות):
${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}

דרישות פורמט (חובה):
- כל השאלות ב${lang === 'Hebrew' ? 'עברית' : 'English'} (חוץ מקטעי קוד שיהיו ב-Java).
- כל שאלה חייבת לכלול קטע קוד Java קצר אך מציאותי, או תרחיש קוד אמיתי.
- 4 אופציות בדיוק לכל שאלה.
- אופציה נכונה אחת בלבד.
- הסבר מפורט (3-6 משפטים) למה האופציה הנכונה נכונה ולמה כל אחת מהשגויות שגויה.
- אסור לחזור על שאלה מוכרת מספר לימוד או מהאינטרנט - חבר חדשות.
- אסור לחזור על אותה שאלה פעמיים בתוך הסט.

החזר אך ורק JSON תקין בפורמט הבא, ללא שום טקסט נוסף, ללא markdown wrapper, ללא הסברים מחוץ ל-JSON:
{
  "questions": [
    {
      "topic": "Generics + Wildcards",
      "difficulty": "hard",
      "code": "List<? extends Number> nums = new ArrayList<Integer>();\\nnums.add(5);",
      "stem": "מה יקרה כאשר מנסים להריץ את הקוד?",
      "options": [
        "מתקמפל ומדפיס 5",
        "שגיאת קומפילציה: לא ניתן להוסיף איברים ל-? extends",
        "ClassCastException בזמן ריצה",
        "מתקמפל אך לא מדפיס דבר"
      ],
      "correctIdx": 2,
      "explanationGeneral": "הסבר כללי...",
      "optionExplanations": [
        "הסבר אופציה 1...",
        "הסבר אופציה 2...",
        "הסבר אופציה 3...",
        "הסבר אופציה 4..."
      ]
    }
  ]
}`;

    console.log(`[lab] generating ${n} questions for "${course}" topics: ${topics.join(', ')}`);
    const parsed = await callGemini(prompt);

    if (!parsed?.questions || !Array.isArray(parsed.questions)) {
      return res.status(502).json({ error: 'הבינה המלאכותית לא החזירה שאלות תקינות. נסה שוב.' });
    }

    const safe = parsed.questions
      .filter(q => q && typeof q.stem === 'string' && Array.isArray(q.options) && q.options.length === 4)
      .map((q, i) => ({
        id: `gemini_${Date.now()}_${i}`,
        topic: String(q.topic || topics[0] || '').slice(0, 120),
        difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : diff,
        code: typeof q.code === 'string' ? q.code.slice(0, 4000) : '',
        stem: String(q.stem).slice(0, 1000),
        options: q.options.map(o => String(o).slice(0, 500)),
        correctIdx: Math.min(Math.max(parseInt(q.correctIdx, 10) || 1, 1), 4),
        explanationGeneral: typeof q.explanationGeneral === 'string' ? q.explanationGeneral.slice(0, 4000) : '',
        optionExplanations: Array.isArray(q.optionExplanations)
          ? q.optionExplanations.slice(0, 4).map(e => String(e || '').slice(0, 2000))
          : [],
      }))
      .slice(0, n);

    if (!safe.length) {
      return res.status(502).json({ error: 'לא נוצרו שאלות תקינות. נסה שוב.' });
    }

    console.log(`[lab] success: ${safe.length} questions generated`);
    return res.status(200).json({ ok: true, questions: safe });
  } catch (err) {
    console.error('[lab] handler error:', err?.message || err);
    if (err?.code === 'no_api_key') {
      return res.status(503).json({ error: 'מפתח API לא מוגדר בשרת.', reason: 'no_api_key' });
    }
    return res.status(err?.http || 500).json({
      error: 'שגיאה ביצירת שאלות. נסה שוב בעוד כמה שניות.',
    });
  }
}
