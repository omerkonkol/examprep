// =====================================================
// Vercel Serverless Function — POST /api/questions/enhance-solution
// =====================================================
// Vision-first pipeline (optimal quality + cost):
//   1. Cache check — return immediately if already generated ($0)
//   2. Quota check — free users: 5 AI explanations/day
//   3. Gemini OCR — reads question image exactly as it appears,
//      handles mixed Hebrew/English/math correctly (~$0.0002, ~3s)
//   4. Groq 2-pass — draft + self-critique using OCR text +
//      solution PDF text as context (free, ~4s total)
//   5. Gemini fallback — if Groq unavailable or fails (~$0.001)
//
// Total cost: ~$0.0002/call. Cached forever in DB after first call.
// =====================================================

import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

// ── Supabase helpers ───────────────────────────────────────────────────────────
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

// ── Fetch image from URL → base64 ─────────────────────────────────────────────
async function fetchImageBase64(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`image fetch ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || 'image/png';
  return { base64: buf.toString('base64'), mimeType: ct.split(';')[0].trim() };
}

// ── Gemini: OCR the question image ────────────────────────────────────────────
// Reads exactly what appears in the image — handles Hebrew/English/math mix.
import { getGeminiKeys, isQuotaError } from '../_lib/gemini-key.mjs';

async function ocrQuestionImage(imageBase64, mimeType) {
  const { primaryKey, fallbackKey, hasPaid } = getGeminiKeys();
  if (!primaryKey) return null;
  console.log(`[enhance] OCR using ${hasPaid ? 'paid' : 'free'} key as primary`);

  const prompt = `You are reading a Hebrew university multiple-choice exam question image.
The question may contain Hebrew text, English terms, mathematical formulas, symbols, and numbers — preserve everything verbatim.

Extract the question content and return ONLY this JSON object:
{
  "question_text": "<full question stem, exactly as written including any Hebrew/English/math mix>",
  "options": ["<option 1 text verbatim>", "<option 2 text verbatim>", "<option 3 text verbatim>", "<option 4 text verbatim>"]
}

Rules:
- Keep all text exactly as it appears (do not translate or simplify)
- Include math notation, symbols, and formulas as they appear
- If fewer than 4 options are visible, fill the remaining slots with ""
- Output ONLY the JSON object, nothing else`;

  async function fetchWithKey(apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageBase64 } },
        ]}],
        generationConfig: { temperature: 0.0, maxOutputTokens: 1024, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(20000),
    });
  }

  for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
    try {
      let r = await fetchWithKey(primaryKey, model);
      if (isQuotaError(r.status, null) && fallbackKey) {
        console.warn(`[enhance] OCR ${model} primary quota exceeded — switching to fallback`);
        r = await fetchWithKey(fallbackKey, model);
      }
      if (!r.ok) continue;
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      let parsed = null;
      try { parsed = JSON.parse(text.trim()); } catch { continue; }
      if (!parsed || typeof parsed.question_text !== 'string' || !Array.isArray(parsed.options)) continue;
      while (parsed.options.length < 4) parsed.options.push('');
      console.log(`[enhance] OCR ok via ${model}, q_len=${parsed.question_text.length}`);
      return {
        question_text: parsed.question_text.trim(),
        options: parsed.options.slice(0, 4).map(o => String(o || '').trim()),
      };
    } catch (e) {
      console.warn(`[enhance] OCR ${model} error:`, e.message);
    }
  }
  return null;
}

// ── Groq: 2-pass explanation generation ───────────────────────────────────────
async function callGroq(messages, { temperature = 0.3, maxTokens = 2048, timeoutMs = 30000 } = {}) {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return null;
  try {
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
      console.warn('[enhance] Groq HTTP', r.status, err.slice(0, 200));
      return null;
    }
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || '';
    try { return { text, data: JSON.parse(text) }; } catch { return null; }
  } catch (e) {
    console.warn('[enhance] Groq exception:', e.message);
    return null;
  }
}

async function generateGroqExplanation(ocrData, correctIdx, solutionTextRaw) {
  const { question_text, options } = ocrData;
  const letters = ['א', 'ב', 'ג', 'ד'];
  const correctLetter = letters[(correctIdx || 1) - 1] || String(correctIdx);
  const optionsList = options.map((o, i) => `${letters[i]}. ${o || '(ריק)'}`).join('\n');

  const solBlock = solutionTextRaw
    ? `\n\nמהקובץ הפתרון (השתמש בזה כהסבר אמת):\n"""\n${solutionTextRaw.slice(0, 2500)}\n"""\n`
    : '';

  const systemMsg = {
    role: 'system',
    content: 'אתה מומחה אקדמי בעברית. משימתך לכתוב פתרונות מפורטים ומדויקים לשאלות אמריקאיות בעברית אקדמית ברורה.',
  };

  const pass1Prompt = `להלן שאלה אמריקאית מבחינה אוניברסיטאית:

שאלה:
${question_text}

האפשרויות:
${optionsList}

התשובה הנכונה: ${correctLetter} (אפשרות ${correctIdx})
${solBlock}
כתוב פתרון מלא ומפורט בעברית אקדמית. החזר JSON בלבד:
{
  "general_explanation": "<פסקה של 2-4 משפטים המסבירה את הנושא ומדוע ${correctLetter} נכונה>",
  "option_explanations": [
    {"idx": 1, "isCorrect": <bool>, "explanation": "<2 משפטים: מדוע נכונה/שגויה>"},
    {"idx": 2, "isCorrect": <bool>, "explanation": "<2 משפטים: מדוע נכונה/שגויה>"},
    {"idx": 3, "isCorrect": <bool>, "explanation": "<2 משפטים: מדוע נכונה/שגויה>"},
    {"idx": 4, "isCorrect": <bool>, "explanation": "<2 משפטים: מדוע נכונה/שגויה>"}
  ]
}`;

  const pass1 = await callGroq([systemMsg, { role: 'user', content: pass1Prompt }], { temperature: 0.3, maxTokens: 2048 });
  if (!pass1?.data) return null;

  // Self-critique: improve clarity and correctness
  const critiquePrompt = `בדוק ושפר את הפתרון שכתבת:
שאלה: ${question_text}
התשובה הנכונה: ${correctLetter}

ודא: (1) ההסבר הכללי מסביר בבירור מדוע ${correctLetter} נכונה, (2) כל הסבר שגוי מנמק מדוע האפשרות אינה נכונה, (3) השפה אקדמית, ברורה וקוהרנטית.
החזר JSON באותו מבנה בדיוק.`;

  const pass2 = await callGroq([
    systemMsg,
    { role: 'user', content: pass1Prompt },
    { role: 'assistant', content: pass1.text },
    { role: 'user', content: critiquePrompt },
  ], { temperature: 0.1, maxTokens: 2048 });

  const result = (pass2?.data?.general_explanation && pass2?.data?.option_explanations) ? pass2.data : pass1.data;
  return { data: result, engine: 'groq/llama-3.3-70b-versatile' };
}

// ── Gemini fallback: end-to-end from image ────────────────────────────────────
async function generateGeminiFallback(imageBase64, mimeType, correctIdx, solutionTextRaw) {
  const { primaryKey, fallbackKey, hasPaid } = getGeminiKeys();
  if (!primaryKey) return null;
  console.log(`[enhance] fallback using ${hasPaid ? 'paid' : 'free'} key as primary`);

  const solBlock = solutionTextRaw
    ? `\n\nSolution PDF text (use as reference):\n"""\n${solutionTextRaw.slice(0, 2000)}\n"""\n`
    : '';
  const correctHint = correctIdx ? `The official answer key says the correct answer is option ${correctIdx}. Trust this.` : '';

  const prompt = `You are analyzing a Hebrew university multiple-choice exam question image.
${correctHint}${solBlock}
Produce a detailed Hebrew solution. Return ONLY this JSON:
{
  "general_explanation": "<2-4 Hebrew sentences: core concept + why correct answer is right>",
  "option_explanations": [
    {"idx": 1, "isCorrect": <bool>, "explanation": "<2+ Hebrew sentences: why right/wrong>"},
    {"idx": 2, "isCorrect": <bool>, "explanation": "..."},
    {"idx": 3, "isCorrect": <bool>, "explanation": "..."},
    {"idx": 4, "isCorrect": <bool>, "explanation": "..."}
  ]
}
Exactly ONE isCorrect:true. Write in clean academic Hebrew.`;

  async function fetchWithKey(apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageBase64 } },
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 3000, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(40000),
    });
  }

  for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
    try {
      let r = await fetchWithKey(primaryKey, model);
      if (isQuotaError(r.status, null) && fallbackKey) {
        console.warn(`[enhance] fallback ${model} primary quota exceeded — switching to fallback key`);
        r = await fetchWithKey(fallbackKey, model);
      }
      if (!r.ok) continue;
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      let parsed = null;
      try { parsed = JSON.parse(text.trim()); } catch { continue; }
      if (!parsed?.general_explanation) continue;
      console.log(`[enhance] Gemini fallback ok via ${model}`);
      return { data: parsed, engine: model };
    } catch (e) {
      console.warn(`[enhance] Gemini fallback ${model} error:`, e.message);
    }
  }
  return null;
}

// ── Normalize output ───────────────────────────────────────────────────────────
function normalizeOutput(synth, correctIdx) {
  const correct = correctIdx || 1;
  const rawOpts = Array.isArray(synth.option_explanations) ? synth.option_explanations : [];
  const option_explanations = [1, 2, 3, 4].map(i => {
    const found = rawOpts.find(o => parseInt(o?.idx, 10) === i);
    return { idx: i, isCorrect: i === correct, explanation: (found?.explanation || '').toString().trim() };
  });
  return {
    general_explanation: (synth.general_explanation || '').toString().trim(),
    option_explanations,
  };
}

// ── Main handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const questionId = parseInt(body.questionId, 10);
  if (!questionId) return res.status(400).json({ error: 'questionId חסר' });

  // Fetch all fields needed for vision-first pipeline
  const { data: q, error: qErr } = await auth.db.from('ep_questions')
    .select('id, user_id, image_path, correct_idx, num_options, solution_text_raw, general_explanation, option_explanations')
    .eq('id', questionId).maybeSingle();
  if (qErr || !q) return res.status(404).json({ error: 'שאלה לא נמצאה' });
  if (q.user_id !== auth.userId) return res.status(403).json({ error: 'אין הרשאה' });

  // Cache check — return immediately if already generated
  if (q.general_explanation && Array.isArray(q.option_explanations) && q.option_explanations.length > 0) {
    return res.json({
      ok: true,
      cached: true,
      general_explanation: q.general_explanation,
      option_explanations: q.option_explanations,
      correct_idx: q.correct_idx,
    });
  }

  // ===== Plan check =====
  // Free plan (including expired trials) is blocked entirely. Trial + paid
  // plans proceed. Admin bypasses everything.
  const admin = getAdmin();
  if (admin) {
    try {
      // Run the quota/trial-expiry RPC FIRST so the profile we fetch next
      // reflects any just-expired trial.
      await admin.rpc('reset_user_quotas_if_needed', { p_user_id: auth.userId }).catch(() => {});
      const { data: profile } = await admin.from('profiles')
        .select('plan, is_admin, trial_used').eq('id', auth.userId).maybeSingle();
      const isAdmin = profile?.is_admin === true;
      const plan = profile?.plan || 'free';
      if (!isAdmin && plan === 'free') {
        return res.status(402).json({
          error: 'פיצ\'ר פרימיום',
          guidance: 'יצירת הסברים מפורטים עם AI זמינה רק בתוכניות בתשלום. שדרג לתוכנית Basic כדי להמשיך.',
          trial_expired: profile?.trial_used === true,
        });
      }
    } catch (e) {
      console.warn('[enhance] quota check failed (allowing):', e?.message);
    }
  }

  const t0 = Date.now();

  try {
    // ── Step 1: Fetch image from Cloudinary ──────────────────────────────────
    const hasImage = q.image_path && q.image_path !== 'text-only' && q.image_path.startsWith('http');
    let imageBase64 = null;
    let mimeType = 'image/png';

    if (hasImage) {
      try {
        const img = await fetchImageBase64(q.image_path);
        imageBase64 = img.base64;
        mimeType = img.mimeType;
        console.log(`[enhance] Q${q.id}: image fetched (${Math.round(imageBase64.length * 0.75 / 1024)}KB)`);
      } catch (e) {
        console.warn(`[enhance] Q${q.id}: image fetch failed:`, e.message);
      }
    }

    // ── Step 2: Gemini OCR — get accurate question text from image ───────────
    let ocrData = null;
    if (imageBase64) {
      ocrData = await ocrQuestionImage(imageBase64, mimeType);
    }

    // No image available — cannot generate explanation
    if (!ocrData && !imageBase64) {
      console.warn(`[enhance] Q${q.id}: no image available`);
      return res.status(422).json({ error: 'לא ניתן ליצור הסבר — לשאלה אין תמונה זמינה' });
    }

    // If OCR failed but we have the image, Gemini fallback will read it directly
    // (no text pre-extraction needed in that path)
    let synth = null;
    let engineModel = null;

    // ── Step 3: Groq 2-pass (if OCR succeeded) ───────────────────────────────
    if (ocrData) {
      const groqResult = await generateGroqExplanation(ocrData, q.correct_idx, q.solution_text_raw);
      if (groqResult?.data) {
        synth = groqResult.data;
        engineModel = groqResult.engine;
        console.log(`[enhance] Q${q.id}: Groq 2-pass ok (${Date.now() - t0}ms)`);
      } else {
        console.warn(`[enhance] Q${q.id}: Groq failed, trying Gemini`);
      }
    }

    // ── Step 4: Gemini fallback (reads image directly, no pre-OCR needed) ────
    if (!synth && imageBase64) {
      const gemResult = await generateGeminiFallback(imageBase64, mimeType, q.correct_idx, q.solution_text_raw);
      if (gemResult?.data) {
        synth = gemResult.data;
        engineModel = gemResult.engine;
        console.log(`[enhance] Q${q.id}: Gemini fallback ok (${Date.now() - t0}ms)`);
      }
    }

    if (!synth) {
      console.error(`[enhance] Q${q.id}: all engines failed`);
      return res.status(502).json({ error: 'יצירת פתרון נכשלה. נסה שוב.' });
    }

    const normalized = normalizeOutput(synth, q.correct_idx);

    if (!normalized.general_explanation || normalized.option_explanations.every(o => !o.explanation)) {
      console.error(`[enhance] Q${q.id}: empty explanations`);
      return res.status(502).json({ error: 'הפתרון שהתקבל ריק. נסה שוב.' });
    }

    // Save to DB
    const { error: updateErr } = await auth.db.from('ep_questions')
      .update(normalized)
      .eq('id', questionId).eq('user_id', auth.userId);
    if (updateErr) {
      console.error('[enhance] update failed:', updateErr.message);
      return res.status(500).json({ error: 'שגיאה בשמירת הפתרון' });
    }

    // Log cost (Groq = $0)
    const isGemini = engineModel && !engineModel.startsWith('groq');
    console.log(`[enhance] Q${q.id}: ok engine=${engineModel} ${Date.now() - t0}ms`);
    if (isGemini && admin) {
      admin.from('ep_ai_cost_log').insert({
        user_id: auth.userId,
        endpoint: 'enhance-solution',
        question_id: questionId,
        model: engineModel,
        input_tokens: 0, output_tokens: 0, cost_usd: 0.0003,
      }).then(() => {}, () => {});
    }

    return res.json({
      ok: true,
      cached: false,
      general_explanation: normalized.general_explanation,
      option_explanations: normalized.option_explanations,
      correct_idx: q.correct_idx,
    });

  } catch (e) {
    console.error('[enhance] exception:', e?.message || e);
    return res.status(500).json({ error: 'שגיאה ביצירת פתרון' });
  }
}
