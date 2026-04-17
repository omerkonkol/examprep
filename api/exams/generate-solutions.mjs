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

export const config = { maxDuration: 120 };

const PLAN_QUOTAS = {
  trial:     { per_day:  3, per_month:  10 },
  free:      { per_day:  0, per_month:   0 },
  basic:     { per_day: 10, per_month:  50 },
  pro:       { per_day: 30, per_month: 200 },
  education: { per_day: 80, per_month: 500 },
};

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
async function ocrWithGemini(imageBase64, mimeType, apiKey) {
  const prompt = `You are reading a Hebrew university multiple-choice exam question image.
Preserve EVERYTHING exactly as written — Hebrew text, English terms, code, math, symbols.

Return ONLY this JSON (no markdown):
{
  "question_text": "<full question stem verbatim>",
  "options": ["<option 1>", "<option 2>", "<option 3>", "<option 4>"]
}

Rules: copy every character exactly; preserve code indentation; use plain text for math (e.g. "2^n"); fill missing option slots with "".`;

  for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
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
        while (parsed.options.length < 4) parsed.options.push('');
        return {
          question_text: parsed.question_text.trim(),
          options: parsed.options.slice(0, 4).map(o => String(o || '').trim()),
          model,
          usage: j.usageMetadata || null,
        };
      }
    } catch { continue; }
  }
  return null;
}

// ── Gemini: generate a full explanation for one question ──────────────────────
// Accepts text + optional image. Uses free key first, paid key as fallback.
async function explainWithGemini(questionText, options, correctIdx, imageBase64, mimeType, { timeoutMs = 35000 } = {}) {
  const freeKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  const paidKey = (process.env.GEMINI_API_KEY_PAID || '').replace(/\\n/g, '').trim();
  if (!freeKey && !paidKey) return null;

  const letters = ['א', 'ב', 'ג', 'ד'];
  const correctLetter = letters[(correctIdx || 1) - 1] || String(correctIdx);
  const optsList = options.map((o, i) => `${i + 1}. ${o || '(ריק)'}`).join('\n');

  const textSection = questionText
    ? `שאלה: ${questionText}\n\nאפשרויות:\n${optsList}`
    : 'קרא את השאלה והאפשרויות מהתמונה.';

  const prompt = `אתה מרצה אוניברסיטאי מומחה שמסביר שאלת בחינה רב-ברירה בעברית אקדמית.
התשובה הנכונה היא אפשרות ${correctIdx} (${correctLetter}) — זהו SOURCE OF TRUTH מוחלט.

${textSection}

החזר JSON תקין בלבד (ללא markdown, ללא ```):
{
  "general_explanation": "<3-5 משפטים: (1) הגדר את המושג/נושא הנדון. (2) הסבר בדיוק מדוע אפשרות ${correctLetter} נכונה עם נימוק תיאורטי. (3) ציין מלכודת נפוצה שגורמת לטעות בשאלה זו.>",
  "option_explanations": [
    {"idx": 1, "isCorrect": ${correctIdx === 1}, "explanation": "<2-3 משפטים: ${correctIdx === 1 ? 'הסבר מדוע אפשרות זו נכונה ומה ההגדרה/נימוק המדויק.' : 'הסבר מדוע אפשרות זו נראית נכונה אך שגויה — מה בדיוק לא מדויק בה.'}">},
    {"idx": 2, "isCorrect": ${correctIdx === 2}, "explanation": "<2-3 משפטים: ${correctIdx === 2 ? 'הסבר מדוע אפשרות זו נכונה ומה ההגדרה/נימוק המדויק.' : 'הסבר מדוע אפשרות זו נראית נכונה אך שגויה — מה בדיוק לא מדויק בה.'}">},
    {"idx": 3, "isCorrect": ${correctIdx === 3}, "explanation": "<2-3 משפטים: ${correctIdx === 3 ? 'הסבר מדוע אפשרות זו נכונה ומה ההגדרה/נימוק המדויק.' : 'הסבר מדוע אפשרות זו נראית נכונה אך שגויה — מה בדיוק לא מדויק בה.'}">},
    {"idx": 4, "isCorrect": ${correctIdx === 4}, "explanation": "<2-3 משפטים: ${correctIdx === 4 ? 'הסבר מדוע אפשרות זו נכונה ומה ההגדרה/נימוק המדויק.' : 'הסבר מדוע אפשרות זו נראית נכונה אך שגויה — מה בדיוק לא מדויק בה.'}">}
  ]
}

כללים: עברית אקדמית בלבד; מונחים טכניים — השאר באנגלית; אל תחזור על טקסט השאלה; JSON תקין ללא markdown.`;

  const parts = [];
  if (imageBase64 && mimeType) {
    parts.push({ inlineData: { mimeType, data: imageBase64 } });
  }
  parts.push({ text: prompt });

  async function tryKey(apiKey) {
    for (const model of ['gemini-2.0-flash', 'gemini-2.5-flash']) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: 'application/json' },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) { if (r.status === 429) return { quota: true }; continue; }
        const j = await r.json();
        const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        const parsed = JSON.parse(text.trim());
        if (typeof parsed.general_explanation === 'string' && Array.isArray(parsed.option_explanations)) {
          return { data: parsed };
        }
      } catch { continue; }
    }
    return { data: null };
  }

  let result = freeKey ? await tryKey(freeKey) : null;
  if (!result?.data && paidKey) result = await tryKey(paidKey);
  return result?.data || null;
}

// ── Per-question pipeline ─────────────────────────────────────────────────────
async function processOneQuestion(question, admin) {
  const qTag = `Q${question.question_number || question.id}`;
  const correctIdx = question.correct_idx || 1;

  let questionText = String(question.question_text || '').trim();
  let options = [1, 2, 3, 4].map(i =>
    String((question.options_text || {})[i] || (question.options_text || {})[String(i)] || '').trim()
  );
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
    const freeKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
    const paidKey = (process.env.GEMINI_API_KEY_PAID || '').replace(/\\n/g, '').trim();
    const ocrKey = freeKey || paidKey;
    if (ocrKey) {
      try {
        const ocr = await ocrWithGemini(imageBase64, imageMimeType, ocrKey);
        if (ocr) {
          questionText = ocr.question_text;
          options = ocr.options;
          const optsMap = options.reduce((acc, o, i) => { acc[i + 1] = o; return acc; }, {});
          await admin.from('ep_questions').update({
            question_text: questionText,
            options_text: optsMap,
          }).eq('id', question.id);
          console.log(`[exam-solutions] ${qTag}: OCR done via ${ocr.model}`);
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

  // Generate explanation with Gemini
  // Pass image along even if we have text — gives Gemini more context
  const explanation = await explainWithGemini(
    questionText, options, correctIdx,
    imageBase64, imageMimeType
  );

  if (!explanation) {
    console.warn(`[exam-solutions] ${qTag}: explanation failed (Gemini returned null)`);
    return { id: question.id, qNum: question.question_number, error: 'ai_failed' };
  }

  // Save to DB
  const { error: saveErr } = await admin.from('ep_questions').update({
    general_explanation: explanation.general_explanation,
    option_explanations: explanation.option_explanations,
  }).eq('id', question.id);

  if (saveErr) {
    console.error(`[exam-solutions] ${qTag}: save failed:`, saveErr.message);
    return { id: question.id, qNum: question.question_number, error: 'save_failed' };
  }

  console.log(`[exam-solutions] ${qTag}: done (correctIdx=${correctIdx})`);
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

  // Verify Gemini key exists
  const geminiKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  const geminiPaidKey = (process.env.GEMINI_API_KEY_PAID || '').replace(/\\n/g, '').trim();
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
  await admin.rpc('reset_user_quotas_if_needed', { p_user_id: auth.userId }).catch(() => {});
  const { data: profile } = await admin.from('profiles')
    .select('plan, is_admin, trial_used').eq('id', auth.userId).maybeSingle();
  const isAdmin = profile?.is_admin === true;

  if (!isAdmin) {
    const plan = profile?.plan || 'free';
    const quotas = PLAN_QUOTAS[plan] || PLAN_QUOTAS.free;
    if (quotas.per_day === 0) {
      return res.status(402).json({
        error: 'פיצ\'ר פרימיום',
        guidance: 'יצירת פתרונות מפורטים עם AI זמינה רק ללקוחות משלמים.',
        trial_expired: profile?.trial_used === true && plan === 'free',
      });
    }
    try {
      const { data: granted } = await admin.rpc('ep_reserve_ai_slots', {
        p_user_id: auth.userId, p_count: 1, p_max_day: quotas.per_day, p_max_month: quotas.per_month,
      });
      if (granted === false) {
        return res.status(429).json({
          error: 'הגעת למגבלה היומית',
          guidance: `התוכנית "${plan}" מאפשרת ${quotas.per_day} יצירות ליום. נסה שוב מחר.`,
        });
      }
    } catch (rpcErr) {
      console.warn('[exam-solutions] ep_reserve_ai_slots threw:', rpcErr?.message);
      // Continue — don't block on quota failure
    }
  }

  // Fetch questions — include group_id + instructor_solution_text so we can
  // (a) skip questions that already have a rich instructor solution and
  // (b) feed grouped questions together so explanations stay consistent.
  const { data: questions, error: qErr } = await admin.from('ep_questions')
    .select('id, user_id, exam_id, question_number, correct_idx, question_text, options_text, general_explanation, option_explanations, image_path, group_id, instructor_solution_text, has_rich_solution')
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
