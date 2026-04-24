// =====================================================
// Vercel Serverless Function — POST /api/exams/generate-solutions
// =====================================================
// Generates detailed AI explanations for ALL questions in an exam.
// Called from the "צור פתרונות" button in the file-management modal.
//
// Pipeline (per question, 5 at a time in parallel):
//   1. If text+options already in DB → use them
//   2. If image exists → OCR with Gemini (caches result to DB)
//   3. Generate explanation with Gemini (vision if image available)
//   4. Save general_explanation + option_explanations to DB
//
// Uses Gemini only — works for scanned PDFs with or without extracted text.
// =====================================================

import { createClient } from '@supabase/supabase-js';
import { buildGroupContextForQuestion } from '../_lib/group-context-helper.mjs';
import { MODEL_CHAIN } from '../_lib/gemini-models.mjs';
import { getGeminiKeys } from '../_lib/gemini-key.mjs';
import { getQuota } from '../_lib/quotas.mjs';
import { checkBurst, checkGlobalBudget } from '../_lib/burst-check.mjs';
import { buildExplainPrompt, EXPLAIN_GEN_CONFIG, EXPLAIN_SAFETY_SETTINGS, normalizeExplainResponse } from '../_lib/explain-prompt.mjs';
import { checkModelimBlock } from '../_lib/seed-guard.mjs';

export const config = { maxDuration: 120 };

const BATCH_SIZE = 5;

function getAdmin() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  }
  return null;
}

async function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.substring(7);
  const client = getAdmin() || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id };
}

// ── Fetch image and convert to base64 ────────────────────────────────────────
async function fetchImageBase64(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`image fetch ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || 'image/png';
  return { base64: buf.toString('base64'), mimeType: ct.split(';')[0].trim() };
}

// ── Gemini: OCR a question image → text + options ────────────────────────────
async function ocrWithGemini(imageBase64, mimeType, apiKey, numOptions = 4) {
  const prompt = `You are reading a Hebrew university multiple-choice exam question image.
Preserve EVERYTHING exactly as written — Hebrew text, English terms, code, math, symbols.

The question may have between 2 and 10 answer options (biology/genetics exams often have 5–10).
Return ONLY this JSON (no markdown):
{
  "question_text": "<full question stem verbatim>",
  "options": ["<option 1>", "<option 2>", ..., "<option N>"]
}

Rules: copy every character exactly; preserve code indentation; use plain text for math (e.g. "2^n");
include ALL answer options you see, up to 10; fill missing slots with "".`;

  for (const model of MODEL_CHAIN.extraction) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) { if (r.status === 429) return null; continue; }
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      const parsed = JSON.parse(text.trim());
      if (typeof parsed.question_text === 'string' && Array.isArray(parsed.options)) {
        const maxOpts = Math.max(numOptions, parsed.options.length, 4);
        while (parsed.options.length < maxOpts) parsed.options.push('');
        return {
          question_text: parsed.question_text.trim(),
          options: parsed.options.slice(0, maxOpts).map(o => String(o || '').trim()),
          model,
          usage: j.usageMetadata || null,
        };
      }
    } catch { continue; }
  }
  return null;
}

// ── Gemini: generate a full explanation for one question ──────────────────────
// Uses the SHARED prompt + config from api/_lib/explain-prompt.mjs so batch
// output matches single-regen quality (Pro-preview → flash fallback, with
// concept_tag + distractor_analysis + LaTeX wrapping).
//
// Paid key first (GEMINI_PAID_ONLY=true by default), free key as fallback.
// Uses MODEL_CHAIN.explain (ACCURATE — pro-preview leads) instead of the old
// extraction chain (flash only). Tokens capped at 8192 because 5 of these run
// in parallel under a 120s Vercel maxDuration; 16384 × 5 blows the ceiling.
async function explainWithGemini(questionText, options, correctIdx, imageBase64, mimeType, { timeoutMs = 100000, contextPromptBlock = null, numOptions: numOptionsHint = null } = {}) {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!freeKey && !paidKey) return null;

  const numOptions = numOptionsHint || options.length || 4;

  // Build a synthetic question row so we can reuse the shared prompt builder.
  const optsMap = options.reduce((acc, txt, i) => { acc[i + 1] = txt; return acc; }, {});
  const pseudoQ = {
    question_text: questionText,
    options_text: optsMap,
    num_options: numOptions,
    correct_idx: correctIdx,
  };
  const prompt = buildExplainPrompt({ q: pseudoQ, contextPromptBlock });

  const parts = [];
  if (imageBase64 && mimeType) parts.push({ inlineData: { mimeType, data: imageBase64 } });
  parts.push({ text: prompt });

  // Batch-tuned generation config: cap output at 8192 (regen uses 16384, but
  // 5 × 16384 blows Vercel's 120s maxDuration). thinkingConfig is kept so
  // pro-preview still reasons before emitting JSON.
  const batchGenConfig = { ...EXPLAIN_GEN_CONFIG, maxOutputTokens: 8192 };

  async function tryKey(apiKey, keyLabel) {
    for (const model of MODEL_CHAIN.explain) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: batchGenConfig,
            safetySettings: EXPLAIN_SAFETY_SETTINGS,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) {
          if (r.status === 429) return { quota: true };
          console.warn(`[exam-solutions] ${keyLabel}/${model} http ${r.status}`);
          continue;
        }
        const j = await r.json();
        const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        if (!cleaned) continue;
        let parsed;
        try { parsed = JSON.parse(cleaned); } catch { continue; }
        const normalized = normalizeExplainResponse(parsed, { numOptions, correctIdx });
        if (!normalized) continue;
        return { data: normalized, model };
      } catch (e) {
        console.warn(`[exam-solutions] ${keyLabel}/${model} exception:`, e?.message);
        continue;
      }
    }
    return { data: null };
  }

  // Paid key FIRST (matches single-regen path + GEMINI_PAID_ONLY=true default).
  let result = paidKey ? await tryKey(paidKey, 'paid') : null;
  if (!result?.data && freeKey) result = await tryKey(freeKey, 'free');
  return result?.data || null;
}

// ── Per-question pipeline ─────────────────────────────────────────────────────
async function processOneQuestion(question, admin) {
  const qTag = `Q${question.question_number || question.id}`;
  const correctIdx = question.correct_idx || 1;
  const numOptions = question.num_options || 4;

  let questionText = String(question.question_text || '').trim();
  // Read all options up to num_options (supports biology exams with 5–10 options)
  let options = Array.from({ length: numOptions }, (_, i) => {
    const k = i + 1;
    return String((question.options_text || {})[k] || (question.options_text || {})[String(k)] || '').trim();
  });
  let imageBase64 = null;
  let imageMimeType = null;

  const hasTextInDb = questionText.length >= 10 && options.filter(o => o.length > 0).length >= 2;
  const hasImage = !!(question.image_path && question.image_path.startsWith('http'));

  // Fetch image if available (used for both OCR and explanation)
  if (hasImage) {
    try {
      const img = await fetchImageBase64(question.image_path);
      imageBase64 = img.base64;
      imageMimeType = img.mimeType;
    } catch (e) {
      console.warn(`[exam-solutions] ${qTag}: image fetch failed:`, e?.message);
    }
  }

  // OCR if text not in DB but image is available
  if (!hasTextInDb && imageBase64) {
    const { primaryKey: ocrKey } = getGeminiKeys();
    if (ocrKey) {
      try {
        const ocr = await ocrWithGemini(imageBase64, imageMimeType, ocrKey, numOptions);
        if (ocr) {
          questionText = ocr.question_text;
          options = ocr.options;
          const optsMap = options.reduce((acc, o, i) => { acc[i + 1] = o; return acc; }, {});
          await admin.from('ep_questions').update({
            question_text: questionText,
            options_text: optsMap,
          }).eq('id', question.id);
          console.log(`[exam-solutions] ${qTag}: OCR done via ${ocr.model} (${options.length} options)`);
        }
      } catch (e) {
        console.warn(`[exam-solutions] ${qTag}: OCR failed:`, e?.message);
      }
    }
  }

  // Need at least text OR image
  if (!questionText && !imageBase64) {
    return { id: question.id, qNum: question.question_number, error: 'no_source' };
  }

  // Build group-context block if this question is part of a set. Includes
  // the shared scenario + prior siblings' correct answers so the generated
  // explanation can reference chained logic.
  let contextPromptBlock = null;
  if (question.group_id) {
    try {
      const ctx = await buildGroupContextForQuestion(admin, question);
      contextPromptBlock = ctx?.contextPromptBlock || null;
    } catch (e) {
      console.warn(`[exam-solutions] ${qTag}: group-context build failed:`, e?.message);
    }
  }

  // Generate explanation with Gemini
  // Pass image along even if we have text — gives Gemini more context
  const explanation = await explainWithGemini(
    questionText, options, correctIdx,
    imageBase64, imageMimeType,
    { contextPromptBlock, numOptions }
  );

  if (!explanation) {
    console.warn(`[exam-solutions] ${qTag}: explanation failed (Gemini returned null)`);
    // Flag the row so a future retry UI can pick it up.
    admin.from('ep_questions').update({ explanation_status: 'failed' }).eq('id', question.id)
      .then(() => {}, e => console.warn(`[exam-solutions] ${qTag}: mark failed:`, e?.message));
    return { id: question.id, qNum: question.question_number, error: 'ai_failed' };
  }

  // Save to DB — include the enrichment fields when Gemini returned them.
  const updateRow = {
    general_explanation: explanation.general_explanation,
    option_explanations: explanation.option_explanations,
    concept_tag: explanation.concept_tag,                   // may be null
    distractor_analysis: explanation.distractor_analysis,   // may be null
    explanation_status: 'verified',
  };
  let { error: saveErr } = await admin.from('ep_questions').update(updateRow).eq('id', question.id);
  // Graceful degradation when the enrichment migration hasn't been applied.
  if (saveErr?.message?.includes('column') && saveErr.message.includes('does not exist')) {
    console.warn(`[exam-solutions] ${qTag}: enrichment column missing — retrying baseline only`);
    ({ error: saveErr } = await admin.from('ep_questions').update({
      general_explanation: explanation.general_explanation,
      option_explanations: explanation.option_explanations,
    }).eq('id', question.id));
  }

  if (saveErr) {
    console.error(`[exam-solutions] ${qTag}: save failed:`, saveErr.message);
    return { id: question.id, qNum: question.question_number, error: 'save_failed' };
  }

  console.log(`[exam-solutions] ${qTag}: done (correctIdx=${correctIdx}, concept=${explanation.concept_tag || 'none'}, distractors=${explanation.distractor_analysis?.length ?? 0})`);
  return { id: question.id, qNum: question.question_number, ok: true };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    return await _handler(req, res);
  } catch (fatal) {
    const stack = (fatal?.stack || fatal?.message || String(fatal)).slice(0, 800);
    console.error('[exam-solutions] fatal:', stack);
    return res.status(500).json({ error: 'שגיאה פנימית בשרת', detail: stack });
  }
}

async function _handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let _step = 'auth';
  const auth = await authenticate(req).catch(e => { throw Object.assign(new Error(`step:auth — ${e.message}`), { stack: e.stack }); });
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const examId = parseInt(body.examId, 10);
  if (!examId) return res.status(400).json({ error: 'examId חסר' });

  const admin = getAdmin();
  if (!admin) return res.status(500).json({ error: 'שירות לא זמין — SUPABASE_SERVICE_ROLE_KEY חסר' });

  if (await checkModelimBlock(res, admin, auth.userId)) return;

  // Verify Gemini key exists
  const { primaryKey: geminiPaidKey } = getGeminiKeys();
  const geminiKey = ''; // paid-only mode
  if (!geminiKey && !geminiPaidKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY לא מוגדר בסביבת ה-server' });
  }

  // Ownership check
  const { data: exam, error: examErr } = await admin.from('ep_exams')
    .select('id, user_id, name').eq('id', examId).maybeSingle();
  if (examErr || !exam) return res.status(404).json({ error: 'מבחן לא נמצא', detail: examErr?.message });
  if (exam.user_id !== auth.userId) {
    const { data: profileAdmin } = await admin.from('profiles').select('is_admin').eq('id', auth.userId).maybeSingle();
    if (!profileAdmin?.is_admin) return res.status(403).json({ error: 'אין הרשאה' });
  }

  // Quota check (admin bypasses)
  try { await admin.rpc('reset_user_quotas_if_needed', { p_user_id: auth.userId }); } catch {}
  const { data: profile } = await admin.from('profiles')
    .select('plan, is_admin, trial_used').eq('id', auth.userId).maybeSingle();
  const isAdmin = profile?.is_admin === true;

  const userPlan = profile?.plan || 'free';
  const userQuota = getQuota(userPlan);

  if (!isAdmin) {
    if (userQuota.ai_day === 0) {
      return res.status(402).json({
        error: 'פיצ\'ר פרימיום',
        guidance: 'יצירת פתרונות מפורטים עם AI זמינה רק ללקוחות משלמים.',
        trial_expired: profile?.trial_used === true && userPlan === 'free',
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
    // Per-minute burst protection — this endpoint is heavy so we rate-limit
    // harder at the bucket level (2/minute) even though each call consumes
    // many AI slots internally.
    const burst = await checkBurst(auth.userId, 'ai_batch', 2);
    if (burst?.allowed === false) {
      return res.status(429).json({
        error: 'יותר מדי בקשות בזמן קצר',
        guidance: `המתן ${burst.retry_after_seconds || 30} שניות ונסה שוב.`,
        retry_after_seconds: burst.retry_after_seconds,
      });
    }
    // Per-day/month reservation happens BELOW, once we know needsWork.length.
  }

  // Fetch questions — include num_options (for multi-option biology exams) and
  // optional columns that may not exist in older DB deployments.
  const { data: questions, error: qErr } = await admin.from('ep_questions')
    .select('id, user_id, exam_id, question_number, correct_idx, num_options, question_text, options_text, general_explanation, option_explanations, image_path, group_id, instructor_solution_text, has_rich_solution')
    .eq('exam_id', examId).eq('user_id', exam.user_id).is('deleted_at', null)
    .order('question_number', { ascending: true });

  if (qErr) {
    console.error('[exam-solutions] fetch questions:', qErr.message);
    return res.status(500).json({ error: 'שגיאה בטעינת השאלות', detail: qErr.message });
  }
  if (!questions || questions.length === 0) {
    return res.status(404).json({ error: 'לא נמצאו שאלות במבחן זה' });
  }

  // Skip questions that already have full explanations OR that the instructor
  // already wrote a rich solution for (we show instructor text directly).
  const needsWork = questions.filter(q => {
    if (q.has_rich_solution && q.instructor_solution_text) return false;
    const hasG = !!(q.general_explanation && String(q.general_explanation).trim());
    const hasO = Array.isArray(q.option_explanations) && q.option_explanations.some(o => o?.explanation);
    return !hasG || !hasO;
  });

  if (needsWork.length === 0) {
    return res.json({ ok: true, generated: 0, total: questions.length, message: 'כל השאלות כבר כוללות הסברים מפורטים.' });
  }

  // Reserve one AI slot per question we're about to process. If the user
  // doesn't have enough slots left, reject before spending any Gemini money.
  if (!isAdmin) {
    try {
      const { data: granted } = await admin.rpc('ep_reserve_ai_slots', {
        p_user_id: auth.userId,
        p_count: needsWork.length,
        p_max_day: userQuota.ai_day,
        p_max_month: userQuota.ai_month,
      });
      if (granted === false) {
        return res.status(429).json({
          error: 'אין מספיק מכסת AI',
          guidance: `נדרשות ${needsWork.length} יצירות, אבל המכסה היומית של תוכנית "${userPlan}" היא ${userQuota.ai_day}. נסה שוב מחר או שדרג.`,
          needed: needsWork.length,
          daily_cap: userQuota.ai_day,
        });
      }
    } catch (rpcErr) {
      console.warn('[exam-solutions] ep_reserve_ai_slots threw:', rpcErr?.message);
      // Continue — don't block on quota failure (fail-open).
    }
  }

  console.log(`[exam-solutions] exam ${examId}: ${needsWork.length}/${questions.length} questions need work`);

  const tStart = Date.now();
  const results = [];

  for (let bi = 0; bi < needsWork.length; bi += BATCH_SIZE) {
    const batch = needsWork.slice(bi, bi + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(q => processOneQuestion(q, admin).catch(e => {
        console.error(`[exam-solutions] Q${q.question_number} uncaught:`, e?.message || e);
        return { id: q.id, qNum: q.question_number, error: 'uncaught' };
      }))
    );
    results.push(...batchResults);
  }

  const saved = results.filter(r => r.ok).length;
  const failed = results.filter(r => r.error).length;
  const errors = results.filter(r => r.error).map(r => `Q${r.qNum}: ${r.error}`).slice(0, 10);
  const elapsedMs = Date.now() - tStart;

  console.log(`[exam-solutions] exam ${examId}: saved=${saved}/${needsWork.length}, failed=${failed} in ${elapsedMs}ms`);
  if (errors.length) console.warn('[exam-solutions] errors:', errors);

  return res.json({
    ok: true,
    generated: saved,
    total: needsWork.length,
    failed,
    elapsed_ms: elapsedMs,
    ...(errors.length > 0 ? { errors } : {}),
  });
}
