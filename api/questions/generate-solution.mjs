// =====================================================
// Vercel Serverless Function — POST /api/questions/generate-solution
// =====================================================
// Pipeline:
//   1. Gemini (OCR only, cheap): image → { question_text, options[] }
//   2. Groq step 1 (free): text + correct answer → draft explanation
//   3. Groq step 2 (free): self-critique → refined explanation
// Falls back to all-Gemini if GROQ_API_KEY is not set.
// =====================================================

import { createClient } from '@supabase/supabase-js';
import { getQuota } from '../_lib/quotas.mjs';
import { checkBurst, checkGlobalBudget } from '../_lib/burst-check.mjs';
import { MODEL_CHAIN } from '../_lib/gemini-models.mjs';
import { validateExplanation, selectBestExplanation } from '../_lib/validate-explanation.mjs';
import { checkModelimBlock } from '../_lib/seed-guard.mjs';

export const config = { maxDuration: 60 };

function getAdmin() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  }
  return null;
}
function userClient(jwt) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
async function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.substring(7);
  const client = getAdmin() || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id, db: userClient(token) };
}

async function fetchImageBase64(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`image fetch ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || 'image/png';
  return { base64: buf.toString('base64'), mimeType: ct.split(';')[0].trim() };
}

// ── Gemini helper ──────────────────────────────────────────────────────────────
import { getGeminiKeys, isQuotaError } from '../_lib/gemini-key.mjs';

async function callGeminiJson(prompt, imageParts, { temperature = 0.1, maxOutputTokens = 1024, timeoutMs = 25000 } = {}) {
  const { primaryKey, fallbackKey, hasPaid } = getGeminiKeys();
  if (!primaryKey) return { data: null };
  const parts = [{ text: prompt }, ...imageParts];

  async function fetchWithKey(apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  console.log(`[gen-solution] using ${hasPaid ? 'paid' : 'free'} key as primary`);
  for (const model of MODEL_CHAIN.explain) {
    try {
      let r = await fetchWithKey(primaryKey, model);
      if (isQuotaError(r.status, null) && fallbackKey) {
        console.warn(`[gen-solution] ${model} primary quota exceeded — switching to fallback`);
        r = await fetchWithKey(fallbackKey, model);
      }
      if (!r.ok) continue;
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      const usage = j.usageMetadata || null;
      try { return { data: JSON.parse(text.trim()), usage, model }; } catch { continue; }
    } catch { continue; }
  }
  return { data: null };
}

// ── Step 1: Gemini OCR — extract question text + options from image ────────────
// Cheap call: only extracts structure, no explanation generation.
async function ocrQuestionImage(imageBase64, mimeType) {
  const prompt = `You are reading a Hebrew university multiple-choice exam question image.
Extract the question content and return ONLY this JSON object:
{
  "question_text": "<full question stem in Hebrew, verbatim>",
  "options": ["<option 1 text>", "<option 2 text>", "<option 3 text>", "<option 4 text>"]
}
Include all text exactly as written. If fewer than 4 options are visible, fill remaining with "".`;

  const result = await callGeminiJson(prompt, [{ inlineData: { mimeType, data: imageBase64 } }], {
    temperature: 0.0,
    maxOutputTokens: 1024,
    timeoutMs: 20000,
  });

  const d = result.data;
  if (!d || typeof d.question_text !== 'string' || !Array.isArray(d.options)) return null;
  // Normalize: ensure exactly 4 options
  while (d.options.length < 4) d.options.push('');
  return { question_text: d.question_text.trim(), options: d.options.slice(0, 4).map(o => String(o).trim()) };
}

// ── Step 2+3: Groq 2-pass explanation ─────────────────────────────────────────
async function callGroq(messages, { temperature = 0.3, maxTokens = 2048, timeoutMs = 30000 } = {}) {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return null;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!r.ok) {
    const err = await r.text().catch(() => '');
    console.warn('[groq] HTTP', r.status, err.slice(0, 200));
    return null;
  }
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content || '';
  try { return { text, data: JSON.parse(text) }; } catch { return null; }
}

async function generateGroqExplanation(questionData, correctIdx) {
  const { question_text, options } = questionData;
  const letters = ['א', 'ב', 'ג', 'ד'];
  const correctLetter = letters[correctIdx - 1] || String(correctIdx);
  const optionsList = options.map((o, i) => `${i + 1}. ${o || '(ריק)'}`).join('\n');

  const systemMsg = {
    role: 'system',
    content: 'אתה מומחה אקדמי בעברית. משימתך לכתוב פתרונות מפורטים ומדויקים לשאלות אמריקאיות בעברית אקדמית ברורה.',
  };

  // ── Pass 1: generate draft explanation ──────────────────────────────────────
  const pass1Prompt = `להלן שאלה אמריקאית מבחינה אוניברסיטאית בעברית:

שאלה: ${question_text}

האפשרויות:
${optionsList}

התשובה הנכונה: ${correctIdx} (${correctLetter})

כתוב פתרון מלא ומפורט. החזר JSON בלבד עם המבנה הבא:
{
  "general_explanation": "<פסקה של 2-3 משפטים המסבירה את הנושא ומדוע ${correctLetter} נכונה>",
  "option_explanations": [
    {"idx": 1, "isCorrect": <bool>, "explanation": "<2 משפטים: מדוע נכונה/שגויה>"},
    {"idx": 2, "isCorrect": <bool>, "explanation": "<2 משפטים: מדוע נכונה/שגויה>"},
    {"idx": 3, "isCorrect": <bool>, "explanation": "<2 משפטים: מדוע נכונה/שגויה>"},
    {"idx": 4, "isCorrect": <bool>, "explanation": "<2 משפטים: מדוע נכונה/שגויה>"}
  ]
}

פורמט הפלט (חובה — KaTeX ירנדר את זה ב-frontend):
- כל ביטוי מתמטי, משתנה בודד (n, x, k), סימן (∑, ∫, π, √), חזקה, שבר, לוגריתם, או סיבוכיות — חייב להיות עטוף ב-$...$ (inline) או $$...$$ (display).
  נכון: "חשב את $O(n \\log n)$ עבור $n \\geq 1$"
  לא נכון: "חשב את O(n log n) עבור n גדול מ-1"
- אל תעטוף מילים רגילות בעברית או באנגלית ב-$. רק טוקנים מתמטיים.
- בשורה נפרדת להדגשת נוסחה מורכבת: $$\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}$$
- מונחים מרכזיים: **מונח** (מודגש)
- בין רעיונות שונים — שורה ריקה`;

  const pass1 = await callGroq([systemMsg, { role: 'user', content: pass1Prompt }], {
    temperature: 0.3,
    maxTokens: 2048,
  });
  if (!pass1?.data) return null;
  const draft = pass1.data;

  // ── Pass 2: self-critique + improve ─────────────────────────────────────────
  const pass2Prompt = `בדוק את הפתרון שכתבת עבור השאלה הזו:

שאלה: ${question_text}
התשובה הנכונה: ${correctIdx} (${correctLetter})

הפתרון הנוכחי:
כללי: ${draft.general_explanation}
${(draft.option_explanations || []).map(o => `אפשרות ${o.idx}: ${o.explanation}`).join('\n')}

שפר את הפתרון:
1. ודא שההסבר הכללי מסביר בבירור מדוע ${correctLetter} היא הנכונה
2. ודא שכל הסבר שגוי מנמק מדוע האפשרות אינה נכונה
3. הפוך את השפה ברורה יותר ואקדמית יותר אם צריך
4. כל ביטוי מתמטי, משתנה, חזקה, שבר או סימן — חייב להיות ב-$...$ (inline) או $$...$$ (display). מונחים חשובים: **מונח**.
5. ודא שכל $...$ פתוח גם נסגר (מספר סימני $ זוגי).

החזר JSON באותו מבנה בדיוק.`;

  const pass2 = await callGroq(
    [
      systemMsg,
      { role: 'user', content: pass1Prompt },
      { role: 'assistant', content: pass1.text },
      { role: 'user', content: pass2Prompt },
    ],
    { temperature: 0.1, maxTokens: 2048 }
  );

  // Use refined version if valid, otherwise use draft
  const refined = pass2?.data;
  const result = (refined?.general_explanation && refined?.option_explanations) ? refined : draft;
  return { data: result, engine: 'groq' };
}

// ── Fallback: all-Gemini (used when GROQ_API_KEY not set) ─────────────────────
async function generateGeminiOnlySolution(imageBase64, mimeType, correctIdx) {
  const hint = correctIdx ? `\nThe official answer key says the correct answer is option ${correctIdx}. Trust this.` : '';
  const prompt = `You are looking at a Hebrew university multiple-choice exam question image.${hint}

Analyze the question and produce a detailed Hebrew solution. Return ONE JSON object:
{
  "correct": <integer 1-4>,
  "general_explanation": "<2-4 sentence Hebrew paragraph explaining the core concept and why the correct answer is right>",
  "option_explanations": [
    {"idx": 1, "isCorrect": <bool>, "explanation": "<2+ Hebrew sentences: WHY this option is right/wrong>"},
    {"idx": 2, "isCorrect": <bool>, "explanation": "..."},
    {"idx": 3, "isCorrect": <bool>, "explanation": "..."},
    {"idx": 4, "isCorrect": <bool>, "explanation": "..."}
  ]
}
Rules: exactly ONE isCorrect:true. Write in clean academic Hebrew. Output ONLY the JSON.
Formatting: use $formula$ for inline math, $$formula$$ for display math (LaTeX), **term** for key terms, blank line between ideas.`;

  const result = await callGeminiJson(prompt, [{ inlineData: { mimeType, data: imageBase64 } }], {
    temperature: 0.1, maxOutputTokens: 4096, timeoutMs: 45000,
  });
  if (!result.data || typeof result.data.correct !== 'number') return null;

  const correct = Math.max(1, Math.min(4, parseInt(result.data.correct, 10)));
  const opts = Array.isArray(result.data.option_explanations) ? result.data.option_explanations : [];
  const normalizedOpts = [1, 2, 3, 4].map(i => {
    const found = opts.find(o => parseInt(o?.idx, 10) === i);
    return { idx: i, isCorrect: i === correct, explanation: (found?.explanation || '').toString().trim() };
  });
  const inputTokens = result.usage?.promptTokenCount || 0;
  const outputTokens = result.usage?.candidatesTokenCount || 0;
  const costUsd = (inputTokens * 0.075 + outputTokens * 0.30) / 1_000_000;
  return {
    correct, engine: 'gemini',
    general_explanation: (result.data.general_explanation || '').toString().trim(),
    option_explanations: normalizedOpts,
    usage: { inputTokens, outputTokens, costUsd, model: result.model },
  };
}

// ── Normalize Groq output into same shape as Gemini output ───────────────────
function normalizeGroqResult(groqData, correctIdx) {
  const correct = correctIdx || 1;
  const opts = Array.isArray(groqData.option_explanations) ? groqData.option_explanations : [];
  const normalizedOpts = [1, 2, 3, 4].map(i => {
    const found = opts.find(o => parseInt(o?.idx, 10) === i);
    return { idx: i, isCorrect: i === correct, explanation: (found?.explanation || '').toString().trim() };
  });
  return {
    correct,
    general_explanation: (groqData.general_explanation || '').toString().trim(),
    option_explanations: normalizedOpts,
    concept_tag: groqData.concept_tag ? String(groqData.concept_tag).trim().slice(0, 80) : null,
    distractor_analysis: Array.isArray(groqData.distractor_analysis) ? groqData.distractor_analysis : null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: 'groq/llama-3.3-70b-versatile' },
  };
}

// ── Ensemble explainer (Layer 4 opt-in) ────────────────────────────────────
// Runs N parallel Groq explanation calls, validates each, picks the best.
// Adds concept_tag + distractor_analysis to the prompt. Used for the
// "פתרון מעמיק" button in the UI. Default path (non-ensemble) is unchanged.
async function generateEnsembleExplanation(questionData, correctIdx, { n = 3 } = {}) {
  const HEB = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];
  const correctLetter = HEB[(correctIdx || 1) - 1] || 'א';
  const { question_text, options } = questionData;
  const optionsList = (options || [])
    .map((txt, i) => `${HEB[i]}. ${txt}`)
    .join('\n');

  const systemMsg = {
    role: 'system',
    content: 'אתה מרצה אקדמי ישראלי. הסבריך קצרים, מדויקים, מבוססי תחביר LaTeX (KaTeX), וברמה של סטודנט אוניברסיטאי.',
  };
  const userPrompt = `זוהי שאלה אמריקאית מהאוניברסיטה. התשובה הנכונה ידועה — מטרתך לבנות הסבר אקדמי שמוכיח מדוע.

השאלה:
${question_text}

האפשרויות:
${optionsList}

התשובה הנכונה: ${correctIdx} (${correctLetter})

החזר JSON בלבד:
{
  "general_explanation": "<2-3 משפטים מסבירים את הנושא ומדוע ${correctLetter} נכונה. LaTeX ב-$...$>",
  "option_explanations": [
    {"idx": 1, "isCorrect": <bool>, "explanation": "<2 משפטים>"},
    {"idx": 2, "isCorrect": <bool>, "explanation": "<2 משפטים>"},
    {"idx": 3, "isCorrect": <bool>, "explanation": "<2 משפטים>"},
    {"idx": 4, "isCorrect": <bool>, "explanation": "<2 משפטים>"}
  ],
  "distractor_analysis": [
    {"idx": <wrong option idx>, "misconception": "<טעות נפוצה שמובילה לבחור בה>", "why_wrong": "<למה השיקול הזה שגוי>"}
  ],
  "concept_tag": "<תגית קצרה לנושא — עד 3 מילים בעברית>"
}

פורמט:
- כל ביטוי מתמטי חייב להיות ב-$...$ (inline) או $$...$$ (display). הקפד על מספר זוגי של סימני $.
- distractor_analysis: רק לאפשרויות הלא-נכונות. אם אין מסיחים רלוונטיים, החזר [].
- concept_tag: תגית תמציתית (לדוגמה "סיבוכיות זמן", "משפט בייס", "טבלת אמת").`;

  // Fire N parallel Groq calls. Moderate temperature for diversity.
  const calls = Array.from({ length: n }, (_, i) =>
    callGroq([systemMsg, { role: 'user', content: userPrompt }], {
      temperature: 0.4 + i * 0.05,
      maxTokens: 2048,
    })
  );
  const results = await Promise.all(calls.map(p => p.catch(() => null)));
  const candidates = results.filter(Boolean).map(r => r?.data).filter(Boolean);
  if (candidates.length === 0) return null;

  const picked = selectBestExplanation(candidates, { correctIdx });
  if (!picked.best) {
    console.warn(`[ensemble] no candidate passed validation (n=${candidates.length})`);
    return { data: null, candidates: candidates.length, picked: 0, engine: 'groq-ensemble' };
  }
  return {
    data: picked.best,
    candidates: candidates.length,
    picked: picked.totalValid,
    engine: 'groq-ensemble',
  };
}

// ── Main handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  if (await checkModelimBlock(res, getAdmin(), auth.userId)) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const questionId = parseInt(body.questionId, 10);
  if (!questionId) return res.status(400).json({ error: 'questionId חסר' });
  const ensembleMode = body.mode === 'ensemble';

  const { data: q, error: qErr } = await auth.db.from('ep_questions')
    .select('id, user_id, image_path, correct_idx, num_options, answer_confidence')
    .eq('id', questionId).maybeSingle();
  if (qErr || !q) return res.status(404).json({ error: 'שאלה לא נמצאה' });
  if (q.user_id !== auth.userId) return res.status(403).json({ error: 'אין הרשאה' });
  if (!q.image_path || q.image_path === 'text-only' || !q.image_path.startsWith('http')) {
    return res.status(422).json({ error: 'לא ניתן ליצור פתרון לשאלה ללא תמונה' });
  }

  // ── Quota check (per-user AI slot reservation) ────────────────────────────
  const admin = getAdmin();
  if (!admin) return res.status(500).json({ error: 'שירות לא זמין' });
  // Run the quota/trial-expiry RPC FIRST so the profile we fetch next
  // reflects any just-expired trial.
  try { await admin.rpc('reset_user_quotas_if_needed', { p_user_id: auth.userId }); } catch {}
  const { data: profile } = await admin.from('profiles')
    .select('plan, is_admin, trial_used').eq('id', auth.userId).maybeSingle();
  const isAdmin = profile?.is_admin === true;
  if (!isAdmin) {
    const plan = profile?.plan || 'free';
    const quota = getQuota(plan);
    if (quota.ai_day === 0) {
      return res.status(402).json({
        error: 'פיצ\'ר פרימיום',
        guidance: 'יצירת פתרונות מפורטים עם AI זמינה רק ללקוחות משלמים.',
        trial_expired: profile?.trial_used === true && plan === 'free',
      });
    }
    // Global daily kill-switch.
    const budget = await checkGlobalBudget();
    if (budget?.ok === false) {
      return res.status(503).json({
        error: 'השירות עמוס כרגע',
        guidance: 'ה-AI בעומס חריג. נסה שוב בעוד מספר שעות.',
      });
    }
    // Per-minute burst protection.
    const burst = await checkBurst(auth.userId, 'ai', 6);
    if (burst?.allowed === false) {
      return res.status(429).json({
        error: 'יותר מדי בקשות בזמן קצר',
        guidance: `המתן ${burst.retry_after_seconds || 30} שניות ונסה שוב.`,
        retry_after_seconds: burst.retry_after_seconds,
      });
    }
    // Ensemble is 3x the cost of a normal explain call (3 parallel LLM calls).
    // Reserve 3 slots and also enforce the per-plan explain_day cap.
    if (ensembleMode) {
      const explainCap = quota.explain_day ?? 0;
      if (explainCap === 0) {
        return res.status(402).json({
          error: 'פתרון מעמיק זמין רק בחבילות בתשלום',
          guidance: 'ensemble של 3 קריאות במקביל + ולידציה — זמין ב-Basic ומעלה.',
        });
      }
    }
    const slotsToReserve = ensembleMode ? 3 : 1;
    const { data: granted } = await admin.rpc('ep_reserve_ai_slots', {
      p_user_id: auth.userId, p_count: slotsToReserve, p_max_day: quota.ai_day, p_max_month: quota.ai_month,
    });
    if (granted === false) {
      return res.status(429).json({
        error: 'הגעת למגבלה היומית',
        guidance: `התוכנית "${plan}" מאפשרת ${quota.ai_day} יצירות ליום. נסה שוב מחר או שדרג.`,
      });
    }
  }

  try {
    const { base64, mimeType } = await fetchImageBase64(q.image_path);
    const groqKey = (process.env.GROQ_API_KEY || '').trim();
    let sol = null;

    if (groqKey) {
      const questionData = await ocrQuestionImage(base64, mimeType);
      if (questionData) {
        if (ensembleMode) {
          // ── Ensemble path: N parallel Groq calls + validation ──────────
          console.log(`[generate-solution] Q${q.id}: Groq ENSEMBLE (n=3)`);
          // Mark 'generating' so UI can show a spinner while we work.
          await auth.db.from('ep_questions')
            .update({ explanation_status: 'generating' })
            .eq('id', questionId).eq('user_id', auth.userId)
            .then(() => {}, () => {}); // best-effort; ignore failure if column not yet migrated
          const ens = await generateEnsembleExplanation(questionData, q.correct_idx, { n: 3 });
          if (ens?.data) {
            sol = normalizeGroqResult(ens.data, q.correct_idx);
            sol._ensemble = { candidates: ens.candidates, picked: ens.picked };
            sol._statusTarget = 'verified';
            console.log(`[generate-solution] Q${q.id}: ensemble ok (${ens.picked}/${ens.candidates} passed validation)`);
          } else {
            sol = null; // fall through to 2-pass / Gemini fallback below
            await auth.db.from('ep_questions')
              .update({ explanation_status: 'failed' })
              .eq('id', questionId).eq('user_id', auth.userId)
              .then(() => {}, () => {});
            console.warn(`[generate-solution] Q${q.id}: ensemble failed validation — falling back`);
          }
        }
        if (!sol) {
          // ── Default path: Gemini OCR → Groq 2-pass explanation ────────
          console.log(`[generate-solution] Q${q.id}: Gemini OCR + Groq 2-pass`);
          const groqResult = await generateGroqExplanation(questionData, q.correct_idx);
          if (groqResult?.data) {
            sol = normalizeGroqResult(groqResult.data, q.correct_idx);
            console.log(`[generate-solution] Q${q.id}: Groq ok (engine: groq)`);
          }
        }
      }
      if (!sol) {
        console.warn(`[generate-solution] Q${q.id}: Groq path failed, falling back to Gemini`);
      }
    }

    if (!sol) {
      // ── Gemini fallback ───────────────────────────────────────────────────
      console.log(`[generate-solution] Q${q.id}: Gemini single-call`);
      sol = await generateGeminiOnlySolution(base64, mimeType, q.correct_idx);
    }

    if (!sol) {
      console.error(`[generate-solution] Q${q.id}: all paths failed`);
      return res.status(502).json({ error: 'יצירת פתרון נכשלה. נסה שוב.' });
    }

    console.log(`[generate-solution] Q${q.id}: ok engine=${sol.usage?.model} cost=$${sol.usage?.costUsd?.toFixed(6) || '0'}`);

    // Never overwrite a confirmed answer with Gemini's OCR guess.
    // Only update correct_idx when the answer is unset or still uncertain.
    const answerIsLocked = q.answer_confidence === 'confirmed' && q.correct_idx != null;
    const updatePayload = {
      general_explanation: sol.general_explanation,
      option_explanations: sol.option_explanations,
    };
    if (!answerIsLocked) updatePayload.correct_idx = sol.correct;
    else console.log(`[generate-solution] Q${q.id}: answer_confidence=confirmed — skipping correct_idx overwrite`);

    // Layer 4 enrichment fields — only populated when ensemble produced them.
    if (sol.concept_tag) updatePayload.concept_tag = sol.concept_tag;
    if (sol.distractor_analysis) updatePayload.distractor_analysis = sol.distractor_analysis;
    if (sol._statusTarget) updatePayload.explanation_status = sol._statusTarget;

    let { error: updateErr } = await auth.db.from('ep_questions')
      .update(updatePayload)
      .eq('id', questionId).eq('user_id', auth.userId);
    // If the enrichment columns aren't migrated yet, retry without them.
    if (updateErr?.message?.includes('does not exist')) {
      console.warn(`[generate-solution] Q${q.id}: enrichment column missing — retrying without:`, updateErr.message);
      const { concept_tag, distractor_analysis, explanation_status, ...compat } = updatePayload;
      ({ error: updateErr } = await auth.db.from('ep_questions')
        .update(compat)
        .eq('id', questionId).eq('user_id', auth.userId));
    }
    if (updateErr) {
      console.error('[generate-solution] update failed:', updateErr.message);
      return res.status(500).json({ error: 'שגיאה בשמירת הפתרון' });
    }

    if (sol.usage?.costUsd > 0 && admin) {
      admin.from('ep_ai_cost_log').insert({
        user_id: auth.userId,
        endpoint: 'generate-solution',
        question_id: questionId,
        model: sol.usage.model,
        input_tokens: sol.usage.inputTokens,
        output_tokens: sol.usage.outputTokens,
        cost_usd: sol.usage.costUsd,
      }).then(() => {}, e => console.warn('[generate-solution] cost log:', e?.message));
    }

    return res.json({
      ok: true,
      general_explanation: sol.general_explanation,
      option_explanations: sol.option_explanations,
      correct_idx: answerIsLocked ? q.correct_idx : sol.correct,
      ...(sol.concept_tag && { concept_tag: sol.concept_tag }),
      ...(sol.distractor_analysis && { distractor_analysis: sol.distractor_analysis }),
      ...(sol._ensemble && { ensemble: sol._ensemble }),
    });
  } catch (e) {
    console.error('[generate-solution] exception:', e?.message || e);
    return res.status(500).json({ error: 'שגיאה ביצירת פתרון' });
  }
}
