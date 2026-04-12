// =====================================================
// Vercel Serverless Function — POST /api/lab/generate-mock-exam
// =====================================================
// AI mock-exam generator: receives topic distribution and sample
// questions from the client, then generates a full mock exam that
// mirrors the style, difficulty, and topic mix of real exams.
// =====================================================

import { checkIpThrottle } from '../../lib/ipThrottle.mjs';

export const config = {
  api: { bodyParser: true },
  maxDuration: 60,
};

async function callGemini(prompt, maxTokens = 16384) {
  const apiKey = process.env.GEMINI_API_KEY;
  const models = (process.env.GEMINI_MODEL || 'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash,gemini-flash-latest').split(',');
  if (!apiKey) {
    throw Object.assign(new Error('GEMINI_API_KEY not configured'), { http: 503, code: 'no_api_key' });
  }

  let lastErr = null;
  for (const model of models) {
    const m = model.trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 55_000);
    let aiRes;
    try {
      aiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.8,
            topP: 0.95,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(t);
      lastErr = Object.assign(new Error(e?.name === 'AbortError' ? 'AI timeout' : 'AI fetch: ' + e?.message), { http: e?.name === 'AbortError' ? 504 : 502 });
      continue;
    } finally { clearTimeout(t); }

    if (aiRes.status === 503 || aiRes.status === 429) {
      lastErr = Object.assign(new Error(`Model ${m} unavailable`), { http: 503 });
      continue;
    }
    if (!aiRes.ok) {
      const txt = await aiRes.text().catch(() => '');
      console.error(`[mock] ${m} HTTP ${aiRes.status}:`, txt.slice(0, 300));
      lastErr = Object.assign(new Error('AI error'), { http: 502 });
      continue;
    }

    const payload = await aiRes.json();
    const text = payload?.candidates?.[0]?.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '';
    if (!text) { lastErr = Object.assign(new Error('Empty AI response'), { http: 502 }); continue; }

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(cleaned); }
    catch (e) {
      console.error(`[mock] JSON parse from ${m}:`, e?.message, cleaned.slice(0, 300));
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

  // Mock exams are the most expensive Gemini call — tighter limit
  const throttle = await checkIpThrottle(req, 'lab_mock_exam', { maxDay: 10, maxWeek: 30, blockHours: 24 });
  if (!throttle.allowed) {
    return res.status(429).json({ error: 'הגעת למכסת הבקשות. נסה שוב מאוחר יותר.', reason: throttle.reason });
  }

  try {
    const { size, courseName, topicDistribution, sampleQuestions, style } = req.body || {};

    const n = Math.min(Math.max(parseInt(size, 10) || 20, 5), 40);
    const course = (typeof courseName === 'string' && courseName.length <= 80) ? courseName : 'תוכנה 1 (Java)';

    // topicDistribution: [{ name: "Generics", count: 6, percentage: 30 }, ...]
    const topics = Array.isArray(topicDistribution) ? topicDistribution.slice(0, 15) : [];
    // sampleQuestions: [{ topic: "...", stem: "...", options: [...], code: "..." }]
    const samples = Array.isArray(sampleQuestions) ? sampleQuestions.slice(0, 8) : [];

    const styleHints = {
      balanced: 'מבחן מאוזן — מערבב את כל הנושאים לפי תדירות ההופעה שלהם במבחנים אמיתיים',
      hard: 'מבחן קשה במיוחד — רק שאלות ברמת קושי גבוהה, עם מלכודות ומקרי קצה',
      weak: 'מבחן ממוקד חולשות — מתמקד בנושאים שהסטודנט מתקשה בהם',
    };
    const styleDesc = styleHints[style] || styleHints.balanced;

    // Build topic distribution description
    const topicDesc = topics.length > 0
      ? topics.map(t => `- ${t.name}: ${t.count || '?'} שאלות (${t.percentage || '?'}%)`).join('\n')
      : 'נושאים כלליים של הקורס';

    // Build sample questions reference
    const samplesDesc = samples.length > 0
      ? samples.map((s, i) => {
          let desc = `דוגמה ${i + 1} (${s.topic || 'כללי'}): "${s.stem}"`;
          if (s.code) desc += `\nקוד: ${s.code.slice(0, 200)}`;
          if (s.options?.length) desc += `\nאופציות: ${s.options.join(' | ')}`;
          return desc;
        }).join('\n\n')
      : '';

    const prompt = `אתה מרצה בקורס "${course}" באוניברסיטה ועליך לחבר מבחן דמה שלם עם ${n} שאלות אמריקאיות חדשות.

=== סוג המבחן ===
${styleDesc}

=== התפלגות נושאים (כפי שנמצאו במבחנים אמיתיים של הקורס) ===
${topicDesc}

חלק את ${n} השאלות לפי ההתפלגות הנ"ל — אם נושא מופיע ב-30% מהמבחנים, הקצה לו כ-30% מהשאלות.
${samples.length > 0 ? `
=== דוגמאות לשאלות מהמבחנים האמיתיים (לצורך הבנת הסגנון בלבד — אסור להעתיק!) ===
${samplesDesc}

חבר שאלות חדשות לחלוטין באותו סגנון ורמת קושי, אך עם תרחישים שונים לחלוטין.
` : ''}
=== דרישות חובה ===
1. כל השאלות בעברית (חוץ מקטעי קוד שיהיו ב-Java).
2. כל שאלה חייבת לכלול קטע קוד Java קצר אך מציאותי.
3. 4 אופציות בדיוק לכל שאלה. אופציה נכונה אחת בלבד.
4. לכל שאלה — הסבר כללי מפורט (4-8 משפטים) שמלמד את הסטודנט מדוע התשובה הנכונה היא הנכונה.
5. לכל אופציה — הסבר פרטני (2-4 משפטים):
   - לתשובה הנכונה: למה היא נכונה, מה הכלל שחל כאן.
   - לתשובות שגויות: למה הן שגויות, מה הטעות הנפוצה שגורמת לבחור בהן.
6. אסור לחזור על שאלה מוכרת מספר לימוד או מהאינטרנט.
7. אסור על שתי שאלות זהות או דומות מדי בתוך המבחן.
8. סדר הנושאים צריך להיות מעורבב (לא לקבץ את כל השאלות מאותו נושא ברצף).

החזר אך ורק JSON תקין בפורמט הבא:
{
  "examTitle": "מבחן דמה — ${course}",
  "questions": [
    {
      "questionNumber": 1,
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
      "explanationGeneral": "הסבר כללי מפורט של 4-8 משפטים...",
      "optionExplanations": [
        "הסבר מפורט למה אופציה 1 שגויה...",
        "הסבר מפורט למה אופציה 2 נכונה...",
        "הסבר מפורט למה אופציה 3 שגויה...",
        "הסבר מפורט למה אופציה 4 שגויה..."
      ]
    }
  ]
}`;

    console.log(`[mock-exam] generating ${n} questions for "${course}" style=${style || 'balanced'}`);
    const parsed = await callGemini(prompt, 16384);

    if (!parsed?.questions || !Array.isArray(parsed.questions)) {
      return res.status(502).json({ error: 'הבינה המלאכותית לא החזירה מבחן תקין. נסה שוב.' });
    }

    const safe = parsed.questions
      .filter(q => q && typeof q.stem === 'string' && Array.isArray(q.options) && q.options.length === 4)
      .map((q, i) => ({
        id: `mock_${Date.now()}_${i}`,
        questionNumber: i + 1,
        topic: String(q.topic || '').slice(0, 120),
        difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'hard',
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

    console.log(`[mock-exam] success: ${safe.length} questions generated`);
    return res.status(200).json({
      ok: true,
      examTitle: parsed.examTitle || `מבחן דמה — ${course}`,
      questions: safe,
    });
  } catch (err) {
    console.error('[mock-exam] handler error:', err?.message || err);
    if (err?.code === 'no_api_key') {
      return res.status(503).json({ error: 'מפתח API לא מוגדר בשרת.', reason: 'no_api_key' });
    }
    return res.status(err?.http || 500).json({
      error: 'שגיאה ביצירת מבחן הדמה. נסה שוב בעוד כמה שניות.',
    });
  }
}
