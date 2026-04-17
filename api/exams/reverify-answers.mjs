// =====================================================
// Vercel Serverless Function — POST /api/exams/reverify-answers
// =====================================================
// Cross-verification of ALL questions in an exam using AI vision.
// Processes every question regardless of current confidence level:
//   'unknown'   → AI tries to determine the correct answer
//   'uncertain' → AI re-evaluates; promotes to confirmed if it agrees
//   'confirmed' → AI validates; demotes to uncertain if it disagrees
//
// Uses Gemini (vision model) — works even for scanned questions with
// no extracted text, by reading the question image directly.
//
// Admin triggers this from the exam management modal.
// =====================================================

import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 120 };

const BATCH_SIZE = 5; // parallel questions per batch

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

// Ask Gemini to independently solve a question.
// Accepts an image URL (for scanned PDFs) and/or question text.
// Returns { correct: 1-4, confidence: 0-1, reasoning } or null if uncertain/failed.
import { getGeminiKeys, isQuotaError } from '../_lib/gemini-key.mjs';

async function askGemini(imageUrl, questionText, options, { timeoutMs = 25000 } = {}) {
  const { primaryKey, fallbackKey, hasPaid } = getGeminiKeys();
  if (!primaryKey) return null;
  console.log(`[reverify] using ${hasPaid ? 'paid' : 'free'} key as primary`);

  const optsArr = [1, 2, 3, 4].map(i => String(options[i] || options[String(i)] || '').trim());
  const hasRealOptions = optsArr.filter(o => o.length > 0).length >= 2;
  const optionsList = optsArr.map((o, idx) => `${idx + 1}. ${o || '(ריק)'}`).join('\n');

  const textSection = questionText
    ? `\nשאלה: ${questionText}${hasRealOptions ? `\n\nאפשרויות:\n${optionsList}` : ''}`
    : (hasRealOptions ? `\nאפשרויות:\n${optionsList}` : '\n(קרא את השאלה והאפשרויות מהתמונה)');

  const prompt = `להלן שאלה אמריקאית מבחינה אקדמית. פתור אותה באופן עצמאי וקבע מהי האפשרות הנכונה.${textSection}

החזר JSON בלבד:
{"correct": <1|2|3|4 או null>, "confidence": <0.0-1.0>, "reasoning": "<שתי משפטים קצרים>"}

אם אינך בטוח בתשובה, החזר "confidence": 0.0 ו-"correct": null. עדיף לא לענות מאשר לטעות.`;

  // Build parts: optional image + text prompt
  const parts = [];
  if (imageUrl) {
    try {
      const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const ct = imgRes.headers.get('content-type') || 'image/png';
        parts.push({ inlineData: { mimeType: ct.split(';')[0].trim(), data: buf.toString('base64') } });
      }
    } catch { /* no image — fall through to text-only */ }
  }
  parts.push({ text: prompt });

  async function fetchWithKey(apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  for (const model of ['gemini-2.0-flash', 'gemini-2.5-flash']) {
    try {
      let r = await fetchWithKey(primaryKey, model);
      if (isQuotaError(r.status, null) && fallbackKey) {
        console.warn(`[reverify] ${model} primary quota exceeded — switching to fallback key`);
        r = await fetchWithKey(fallbackKey, model);
      }
      if (!r.ok) {
        if (r.status === 429) break; // fallback also out — stop trying
        continue;
      }
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      try {
        const parsed = JSON.parse(text.trim());
        const ans = parseInt(parsed?.correct, 10);
        const conf = typeof parsed?.confidence === 'number' ? parsed.confidence : 0;
        if (!(ans >= 1 && ans <= 4) || conf < 0.6) return null;
        return { correct: ans, confidence: conf, reasoning: parsed?.reasoning || '' };
      } catch { continue; }
    } catch { continue; }
  }
  return null;
}

export default async function handler(req, res) {
  // Top-level guard: always return JSON, never let Vercel return HTML 500
  try {
    return await _handler(req, res);
  } catch (fatal) {
    console.error('[reverify] fatal unhandled:', fatal?.message || fatal);
    return res.status(500).json({ error: 'שגיאה פנימית בשרת', detail: String(fatal?.message || fatal).slice(0, 200) });
  }
}

async function _handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const examId = parseInt(body.examId, 10);
  if (!examId) return res.status(400).json({ error: 'examId חסר' });

  const admin = getAdmin();
  if (!admin) return res.status(500).json({ error: 'שירות לא זמין' });

  // Ownership check
  const { data: exam, error: examErr } = await admin.from('ep_exams')
    .select('id, user_id, name').eq('id', examId).maybeSingle();
  if (examErr || !exam) return res.status(404).json({ error: 'מבחן לא נמצא' });
  if (exam.user_id !== auth.userId) {
    const { data: profileAdmin } = await admin.from('profiles').select('is_admin').eq('id', auth.userId).maybeSingle();
    if (!profileAdmin?.is_admin) return res.status(403).json({ error: 'אין הרשאה' });
  }

  // Fetch ALL non-deleted questions (any confidence level)
  const { data: questions, error: qErr } = await admin.from('ep_questions')
    .select('id, question_number, correct_idx, answer_confidence, question_text, options_text, image_path')
    .eq('exam_id', examId).eq('user_id', exam.user_id).is('deleted_at', null)
    .order('question_number', { ascending: true });

  if (qErr) {
    console.error('[reverify] fetch:', qErr.message);
    return res.status(500).json({ error: 'שגיאה בטעינת שאלות', detail: qErr.message });
  }
  if (!questions || questions.length === 0) {
    return res.json({ ok: true, checked: 0, resolved: 0, promoted: 0, demoted: 0, message: 'אין שאלות לבדיקה' });
  }

  const tStart = Date.now();
  const allResults = [];

  // Process in batches — each question has its own .catch() so one failure
  // cannot crash the entire batch or the handler.
  for (let bi = 0; bi < questions.length; bi += BATCH_SIZE) {
    const batch = questions.slice(bi, bi + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (q) => {
      try {
        const stem = String(q.question_text || '').trim();
        const opts = q.options_text || {};
        const hasImage = !!(q.image_path && q.image_path.startsWith('http'));
        const hasText = stem.length >= 10 &&
          [1, 2, 3, 4].filter(n => String(opts[n] || opts[String(n)] || '').trim().length > 0).length >= 2;

        // Need at least an image or sufficient text
        if (!hasImage && !hasText) {
          return { id: q.id, qNum: q.question_number, skipped: true, reason: 'no_source' };
        }

        const gemini = await askGemini(hasImage ? q.image_path : null, stem, opts);
        if (!gemini) {
          return { id: q.id, qNum: q.question_number, skipped: true, reason: 'ai_uncertain' };
        }

        const confidence = q.answer_confidence;
        const storedIdx = q.correct_idx;

        // ── UNKNOWN: AI found an answer for a question that had none ──────────
        if (confidence === 'unknown') {
          if (gemini.confidence >= 0.75) {
            const { error: uErr } = await admin.from('ep_questions')
              .update({ correct_idx: gemini.correct, answer_confidence: 'confirmed' })
              .eq('id', q.id);
            if (uErr) {
              console.warn(`[reverify] resolve Q${q.question_number} failed:`, uErr.message);
              return { id: q.id, qNum: q.question_number, error: 'update_failed' };
            }
            console.log(`[reverify] Q${q.question_number}: unknown → resolved as ${gemini.correct} (conf ${gemini.confidence.toFixed(2)})`);
            return { id: q.id, qNum: q.question_number, resolved: true, aiIdx: gemini.correct };
          }
          return { id: q.id, qNum: q.question_number, skipped: true, reason: 'low_confidence' };
        }

        // ── UNCERTAIN: AI can promote if it agrees with the stored answer ─────
        if (confidence === 'uncertain') {
          if (gemini.correct === storedIdx && gemini.confidence >= 0.70) {
            const { error: uErr } = await admin.from('ep_questions')
              .update({ answer_confidence: 'confirmed' })
              .eq('id', q.id);
            if (uErr) {
              console.warn(`[reverify] promote Q${q.question_number} failed:`, uErr.message);
              return { id: q.id, qNum: q.question_number, error: 'update_failed' };
            }
            console.log(`[reverify] Q${q.question_number}: uncertain → promoted to confirmed (AI agrees)`);
            return { id: q.id, qNum: q.question_number, promoted: true };
          }
          return { id: q.id, qNum: q.question_number, agree: false };
        }

        // ── CONFIRMED: validate and demote if AI disagrees ───────────────────
        if (gemini.correct === storedIdx) {
          return { id: q.id, qNum: q.question_number, agree: true };
        }
        const { error: uErr } = await admin.from('ep_questions')
          .update({ answer_confidence: 'uncertain' })
          .eq('id', q.id);
        if (uErr) {
          console.warn(`[reverify] demote Q${q.question_number} failed:`, uErr.message);
          return { id: q.id, qNum: q.question_number, error: 'update_failed' };
        }
        console.log(`[reverify] Q${q.question_number}: confirmed stored=${storedIdx}, AI=${gemini.correct} → demoted to uncertain`);
        return { id: q.id, qNum: q.question_number, demoted: true, storedIdx, aiIdx: gemini.correct };
      } catch (qErr) {
        console.error(`[reverify] Q${q.question_number} uncaught:`, qErr?.message || qErr);
        return { id: q.id, qNum: q.question_number, error: 'uncaught' };
      }
    }));
    allResults.push(...batchResults);
  }

  const checked   = allResults.length;
  const resolved  = allResults.filter(r => r.resolved).length;
  const promoted  = allResults.filter(r => r.promoted).length;
  const agreed    = allResults.filter(r => r.agree === true).length;
  const demoted   = allResults.filter(r => r.demoted).length;
  const skipped   = allResults.filter(r => r.skipped).length;
  const elapsedMs = Date.now() - tStart;

  console.log(
    `[reverify] exam ${examId}: checked=${checked}, resolved=${resolved}, promoted=${promoted}, ` +
    `agreed=${agreed}, demoted=${demoted}, skipped=${skipped} in ${elapsedMs}ms`
  );

  return res.json({ ok: true, checked, resolved, promoted, agreed, demoted, skipped, elapsed_ms: elapsedMs });
}
