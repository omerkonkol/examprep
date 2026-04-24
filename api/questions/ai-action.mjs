// =====================================================
// Consolidated per-question AI endpoint.
// =====================================================
// Handles TWO routes via URL-based dispatch (merged here to stay within the
// Vercel Hobby plan's 12-function limit):
//
//   POST /api/questions/:id/reanalyze         → re-run Gemini on one question
//                                              (fixes wrong crop / options /
//                                              correct_idx by re-reading the
//                                              original exam PDF from Cloudinary)
//   POST /api/questions/:id/regenerate-answer → re-generate the AI explanation
//                                              (general + per-option) using
//                                              group context + prior siblings
//                                              when the question is part of a set
//
// Both actions enforce the same AI quota (ep_reserve_ai_slots, 1 slot each).
// =====================================================

import { createClient } from '@supabase/supabase-js';
import { reanalyzeSingleQuestion } from '../_lib/gemini-solution.mjs';
import { buildGroupContextForQuestion } from '../_lib/group-context-helper.mjs';
import { MODEL_CHAIN } from '../_lib/gemini-models.mjs';
import { getGeminiKeys } from '../_lib/gemini-key.mjs';
import { getQuota } from '../_lib/quotas.mjs';
import { checkBurst, checkGlobalBudget } from '../_lib/burst-check.mjs';
import { buildExplainPrompt, EXPLAIN_GEN_CONFIG, EXPLAIN_SAFETY_SETTINGS, normalizeExplainResponse } from '../_lib/explain-prompt.mjs';
import { checkModelimBlock } from '../_lib/seed-guard.mjs';

// 180s — Pro-preview with thinkingBudget=16384 needs room (~60-90s per model
// attempt), plus headroom for fallback to flash if Pro times out. Was 120s
// but would cut off Pro's deep reasoning. Vercel Hobby allows up to 300s.
export const config = { maxDuration: 180 };

const HEBREW_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];
const CLOUDINARY_RENDER_W = 1600;
const CROP_MARGIN_TOP_PT = 18;
const CROP_MARGIN_BOTTOM_PT = 18;

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
  const hdr = req.headers['authorization'];
  if (!hdr || !hdr.startsWith('Bearer ')) return null;
  const token = hdr.substring(7);
  const client = getAdmin() || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id, db: userClient(token) };
}

// Download a PDF previously uploaded to Cloudinary. Returns
// { ok: true, base64 } or { ok: false, error } so callers can surface
// the real failure instead of a generic "download failed".
//
// Cloudinary accounts block public PDF delivery by default ("restricted
// media types" covers pdf). We try, in order:
//   1) Plain public URL          — works when the account allows PDF delivery
//   2) Signed URL (SHA1, 8-char) — legacy signature format
//   3) Signed URL (SHA256, 32)   — newer signature format for post-2023 accts
//   4) Admin API private download — signed request to api.cloudinary.com
//      which bypasses the public-CDN restriction entirely
async function fetchPdfBase64(cloudName, publicId, apiKey, apiSecret) {
  if (!cloudName || !publicId) return { ok: false, error: 'missing cloudName/publicId' };
  const errors = [];
  const { createHash } = await import('node:crypto');

  async function tryUrl(url, label, init) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000), ...(init || {}) });
      if (r.ok) return { ok: true, base64: Buffer.from(await r.arrayBuffer()).toString('base64') };
      const body = await r.text().catch(() => '');
      errors.push(`${label}: HTTP ${r.status}${body ? ` (${body.slice(0, 120).replace(/\s+/g, ' ')})` : ''}`);
      return null;
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      return null;
    }
  }

  // 1) Plain public URL
  let ok = await tryUrl(`https://res.cloudinary.com/${cloudName}/image/upload/${publicId}.pdf`, 'unsigned');
  if (ok) return ok;

  // 2/3) Signed delivery URLs. Cloudinary signs the path AFTER `s--...--/`
  //      WITHOUT the file extension — signing `publicId.pdf` returns 401.
  if (apiSecret) {
    const toSign = publicId + apiSecret; // path component is just the publicId
    const b64 = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const sig1 = b64(createHash('sha1').update(toSign).digest()).slice(0, 8);
    ok = await tryUrl(`https://res.cloudinary.com/${cloudName}/image/upload/s--${sig1}--/${publicId}.pdf`, 'sha1-8');
    if (ok) return ok;

    const sig2 = b64(createHash('sha256').update(toSign).digest()).slice(0, 32);
    ok = await tryUrl(`https://res.cloudinary.com/${cloudName}/image/upload/s--${sig2}--/${publicId}.pdf`, 'sha256-32');
    if (ok) return ok;
  }

  // 4) Admin API private download — always bypasses public-CDN restrictions.
  //    Endpoint: POST https://api.cloudinary.com/v1_1/{cloud}/image/download
  //    Signature = sha1(alphabetical(params_without_api_key) + api_secret)
  if (apiKey && apiSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { format: 'pdf', public_id: publicId, timestamp: String(timestamp), type: 'upload' };
    const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&') + apiSecret;
    const signature = createHash('sha1').update(toSign).digest('hex');
    const qs = new URLSearchParams({ ...params, api_key: apiKey, signature }).toString();
    ok = await tryUrl(`https://api.cloudinary.com/v1_1/${cloudName}/image/download?${qs}`, 'admin-dl');
    if (ok) return ok;
  } else {
    errors.push('admin-dl: skipped (no api key/secret)');
  }

  return { ok: false, error: errors.join(' | ') };
}

async function fetchImageBase64(url) {
  if (!url || !String(url).startsWith('http')) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || 'image/png';
    return { base64: buf.toString('base64'), mimeType: ct.split(';')[0].trim() };
  } catch { return null; }
}

function buildCropUrl(cloudName, publicId, mcq) {
  const scale = CLOUDINARY_RENDER_W / (mcq.pageWidth || 595);
  const renderH = Math.round(CLOUDINARY_RENDER_W * ((mcq.pageHeight || 842) / (mcq.pageWidth || 595)));
  const yPx = Math.max(0, Math.round(((mcq.yTop || 0) - CROP_MARGIN_TOP_PT) * scale));
  const rawH = Math.round(((mcq.yBottom || 0) - (mcq.yTop || 0) + CROP_MARGIN_TOP_PT + CROP_MARGIN_BOTTOM_PT) * scale);
  const hPx = Math.max(150, Math.min(renderH - yPx, rawH));
  return `https://res.cloudinary.com/${cloudName}/image/upload/pg_${mcq.page},w_${CLOUDINARY_RENDER_W}/c_crop,w_${CLOUDINARY_RENDER_W},h_${hPx},y_${yPx},g_north/q_auto/${publicId}.png`;
}

// Shared: check ownership, enforce AI quota. Returns null to continue, or a
// response-sending closure when we should abort.
async function checkOwnershipAndQuota(auth, q, res) {
  if (q.user_id !== auth.userId) {
    const admin = getAdmin();
    const { data: profileAdmin } = admin ? await admin.from('profiles').select('is_admin').eq('id', auth.userId).maybeSingle() : { data: null };
    if (!profileAdmin?.is_admin) {
      res.status(403).json({ error: 'אין הרשאה' });
      return true;
    }
  }
  const admin = getAdmin();
  if (!admin) { res.status(500).json({ error: 'שירות לא זמין' }); return true; }
  try { await admin.rpc('reset_user_quotas_if_needed', { p_user_id: auth.userId }); } catch {}
  const { data: profile } = await admin.from('profiles')
    .select('plan, is_admin, trial_used').eq('id', auth.userId).maybeSingle();
  const isAdmin = profile?.is_admin === true;
  if (isAdmin) return false;
  const plan = profile?.plan || 'free';
  const quota = getQuota(plan);
  if (quota.ai_day === 0) {
    res.status(402).json({
      error: 'פיצ\'ר פרימיום',
      guidance: 'פעולה זו דורשת תוכנית בתשלום.',
      trial_expired: profile?.trial_used === true && plan === 'free',
    });
    return true;
  }
  // Global daily kill-switch.
  const budget = await checkGlobalBudget();
  if (budget?.ok === false) {
    res.status(503).json({
      error: 'השירות עמוס כרגע',
      guidance: 'ה-AI בעומס חריג. נסה שוב בעוד מספר שעות.',
    });
    return true;
  }
  // Per-minute burst protection.
  const burst = await checkBurst(auth.userId, 'ai', 6);
  if (burst?.allowed === false) {
    res.status(429).json({
      error: 'יותר מדי בקשות בזמן קצר',
      guidance: `המתן ${burst.retry_after_seconds || 30} שניות ונסה שוב.`,
      retry_after_seconds: burst.retry_after_seconds,
    });
    return true;
  }
  try {
    const { data: granted } = await admin.rpc('ep_reserve_ai_slots', {
      p_user_id: auth.userId, p_count: 1, p_max_day: quota.ai_day, p_max_month: quota.ai_month,
    });
    if (granted === false) {
      res.status(429).json({
        error: 'הגעת למגבלה היומית',
        guidance: `התוכנית "${plan}" מאפשרת ${quota.ai_day} שימושים ביום.`,
      });
      return true;
    }
  } catch (e) { console.warn('[ai-action] reserve-slots:', e?.message); }
  return false;
}

// Extract Cloudinary exam PDF public_id from a question's image_path URL.
// The image_path is an on-the-fly crop of the exam PDF — they share the same public_id.
// Format: .../q_auto/{publicId}.png
function extractPdfPublicId(imageUrl) {
  if (!imageUrl) return null;
  const m = imageUrl.match(/\/q_auto\/(.+?)\.png(?:\?|$)/);
  if (m) return m[1];
  const idx = imageUrl.indexOf('/q_auto/');
  if (idx !== -1) return imageUrl.slice(idx + 8).replace(/\.png.*$/, '');
  return null;
}

// ───────────────────── action: reanalyze ─────────────────────────────────────
async function handleReanalyze(auth, q, req, res) {
  // mode: 'full' (default) | 'image_only' (skip answer) | 'answer_only' (skip image rebuild)
  const mode = (req.body?.mode || 'full').trim();
  const { data: exam } = await auth.db.from('ep_exams')
    .select('id, user_id, exam_pdf_path, solution_pdf_path').eq('id', q.exam_id).maybeSingle();
  if (!exam) return res.status(404).json({ error: 'מבחן לא נמצא' });

  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').replace(/\s+/g, '').trim();
  const cloudKey  = (process.env.CLOUDINARY_API_KEY    || '').replace(/\s+/g, '').trim();
  const cloudSec  = (process.env.CLOUDINARY_API_SECRET || '').replace(/\s+/g, '').trim();
  if (!cloudName) return res.status(500).json({ error: 'CLOUDINARY_CLOUD_NAME חסר' });

  // Determine exam PDF public_id — use stored path or extract from image_path
  let examPdfPath = exam.exam_pdf_path;
  if (!examPdfPath) {
    examPdfPath = extractPdfPublicId(q.image_path);
    if (!examPdfPath) {
      return res.status(409).json({
        error: 'לא ניתן לנתח מחדש',
        detail: 'קובץ המבחן לא נמצא בענן. מחק את המבחן והעלה שוב.',
      });
    }
    // Persist for future calls so we don't need to extract again
    const admin = getAdmin();
    if (admin) {
      admin.from('ep_exams').update({ exam_pdf_path: examPdfPath }).eq('id', exam.id)
        .then(() => {}, e => console.warn('[reanalyze] persist exam_pdf_path:', e?.message));
    }
    console.log(`[reanalyze] extracted exam_pdf_path from image_path: ${examPdfPath}`);
  }

  const [examRes, solRes] = await Promise.all([
    fetchPdfBase64(cloudName, examPdfPath, cloudKey, cloudSec),
    exam.solution_pdf_path
      ? fetchPdfBase64(cloudName, exam.solution_pdf_path, cloudKey, cloudSec)
      : Promise.resolve({ ok: false }),
  ]);
  const examBase64 = examRes?.ok ? examRes.base64 : null;
  const solBase64  = solRes?.ok  ? solRes.base64  : null;
  if (!examBase64) {
    console.error('[reanalyze] exam PDF fetch failed:', examRes?.error, 'path:', examPdfPath);
    return res.status(502).json({
      error: 'שגיאה בטעינת הקובץ',
      detail: `Cloudinary download failed: ${examRes?.error || 'unknown'}`,
    });
  }

  const groupCtx = await buildGroupContextForQuestion(auth.db, q);
  const contextPromptBlock = groupCtx?.contextPromptBlock || null;

  // Fetch existing image so Phase 1 (validate) can avoid unnecessary PDF scan.
  const existingImg = await fetchImageBase64(q.image_path);

  // Phase 2 uses a two-step approach: (a) find page number, (b) fetch rendered
  // page as PNG and locate the question in pixel space. This callback gives
  // reanalyzeSingleQuestion access to Cloudinary without coupling it to this module.
  const fetchPageImageFn = async (page) => {
    const url = `https://res.cloudinary.com/${cloudName}/image/upload/pg_${page},w_${CLOUDINARY_RENDER_W}/q_auto/${examPdfPath}.png`;
    return fetchImageBase64(url);
  };

  const result = await reanalyzeSingleQuestion(
    examBase64,
    mode === 'image_only' ? null : solBase64,   // skip Phase 3 answer extraction when image_only
    q.question_number, contextPromptBlock,
    existingImg?.base64 ?? null,
    q.num_options || 0,
    fetchPageImageFn,
  );
  if (!result) {
    return res.status(502).json({ error: 'ניתוח נכשל', detail: 'Gemini לא הצליח לאתר את השאלה בקובץ.' });
  }

  const update = {};

  // Only rebuild image_path when Phase 1 said the existing image is incomplete/broken.
  if (!result.image_ok) {
    if (result.pixel_coords === true && Number.isFinite(result.y_top_px) && Number.isFinite(result.y_bottom_px)) {
      // ── Pixel-coordinate path (preferred): Gemini measured bounding box on the
      //    rendered page image, so coordinates map directly to Cloudinary crop params.
      //    Use tight top margin (avoid grabbing context from preceding question) but
      //    generous bottom margin so short trailing options (e.g. ג. RE, ד. R) are never cut off.
      const MARGIN_TOP_PX    = 8;    // tiny: Gemini now anchors at the exact header line
      const MARGIN_BOTTOM_PX = 220; // generous: avoid cutting off short trailing options
      const estimatedPageH_px = Math.round(CLOUDINARY_RENDER_W * 1.414); // A4 ≈ 2263px
      const spanPx = result.y_bottom_px - result.y_top_px;
      if (spanPx >= 60 && spanPx < estimatedPageH_px * 0.95) {
        const yPx = Math.max(0, result.y_top_px - MARGIN_TOP_PX);
        const hPx = Math.min(
          estimatedPageH_px - yPx,
          Math.max(200, result.y_bottom_px + MARGIN_BOTTOM_PX - yPx),
        );
        update.image_path = `https://res.cloudinary.com/${cloudName}/image/upload/pg_${result.page},w_${CLOUDINARY_RENDER_W}/c_crop,w_${CLOUDINARY_RENDER_W},h_${hPx},y_${yPx},g_north/q_auto/${examPdfPath}.png`;
        console.log(`[reanalyze] Q${q.question_number}: pixel-coord crop page=${result.page} y=[${yPx}–${yPx + hPx}px] gemini-span=${spanPx}px`);
      } else {
        console.warn(`[reanalyze] Q${q.question_number}: pixel span unreasonable (${spanPx}px); keeping existing image`);
      }
    } else {
      // ── Percentage fallback path: convert Gemini % estimates to PDF points
      const pageH = result.page_h || 842;
      const pageW = result.page_w || 595;
      let yTopPct = Number(result.y_top);
      let yBotPct = Number(result.y_bottom);
      if (yTopPct > 100 || yBotPct > 100) {
        yTopPct = (yTopPct / pageH) * 100;
        yBotPct = (yBotPct / pageH) * 100;
      }
      const ySpanPct = yBotPct - yTopPct;
      const pValid = Number.isInteger(result.page) && result.page >= 1 && result.page <= 100;
      const yValid = Number.isFinite(yTopPct) && Number.isFinite(yBotPct) && ySpanPct >= 4 && ySpanPct <= 85;
      if (pValid && yValid) {
        const yTopPt    = Math.max(0,        (yTopPct / 100) * pageH);
        const yBottomPt = Math.min(pageH - 5, (yBotPct / 100) * pageH);
        update.image_path = buildCropUrl(cloudName, examPdfPath, {
          page: result.page, yTop: yTopPt, yBottom: yBottomPt, pageWidth: pageW, pageHeight: pageH,
        });
        console.log(`[reanalyze] Q${q.question_number}: pct-coord crop page=${result.page} y=[${yTopPct.toFixed(1)}%,${yBotPct.toFixed(1)}%]`);
      } else {
        console.warn(`[reanalyze] Q${q.question_number}: PDF coords out of range (span=${ySpanPct?.toFixed(1)}%); keeping existing image`);
      }
    }
  } else {
    console.log(`[reanalyze] Q${q.question_number}: existing image validated OK — skipping crop rebuild`);
  }

  if (typeof result.question_text === 'string' && result.question_text.trim().length >= 5) {
    update.question_text = result.question_text.trim().slice(0, 4000);
  }
  if (result.options && typeof result.options === 'object') {
    const opts = {};
    for (const [k, v] of Object.entries(result.options)) {
      const idx = parseInt(k, 10);
      if (Number.isFinite(idx) && idx >= 1 && idx <= 10 && typeof v === 'string') {
        opts[idx] = v.trim().slice(0, 600);
      }
    }
    if (Object.keys(opts).length >= 2) update.options_text = opts;
  }
  if (Number.isFinite(parseInt(result.num_options, 10))) {
    update.num_options = Math.max(2, Math.min(10, parseInt(result.num_options, 10)));
  }
  if (Number.isFinite(parseInt(result.correct_idx, 10))) {
    const ans = parseInt(result.correct_idx, 10);
    const maxOpts = result.num_options || update.num_options || q.num_options || 10;
    if (ans >= 1 && ans <= maxOpts) {
      update.correct_idx = ans;
      const conf = typeof result.confidence === 'number' ? result.confidence : 0.8;
      update.answer_confidence = conf >= 0.7 ? 'confirmed' : 'uncertain';
    }
  }

  // Apply mode filters before writing to DB
  if (mode === 'answer_only') delete update.image_path;
  if (mode === 'image_only')  { delete update.correct_idx; delete update.answer_confidence; }

  const { error: upErr } = await auth.db.from('ep_questions')
    .update(Object.keys(update).length ? update : { question_text: q.question_text ?? '' })
    .eq('id', q.id);
  if (upErr) return res.status(500).json({ error: 'עדכון נכשל', detail: upErr.message });

  console.log(`[reanalyze] Q${q.question_number} updated=${Object.keys(update).join(',') || 'none'}`);
  return res.json({ ok: true, action: 'reanalyze', updated: Object.keys(update), question: { ...q, ...update } });
}

// ───────────── action: regenerate-answer (context-aware) ─────────────────────
async function explainWithGemini(q, contextPromptBlock, questionImage, contextImage) {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!freeKey && !paidKey) {
    console.warn('[regen] no GEMINI_API_KEY configured');
    return { data: null, reason: 'no_api_key', detail: 'שירות ה-AI אינו מוגדר.' };
  }

  const numOptions = q.num_options || 4;
  const correctIdx = q.correct_idx;

  // Shared prompt builder — same prompt is used by the batch endpoint so
  // single-regen and full-exam-generation produce identical-quality output.
  const prompt = buildExplainPrompt({ q, contextPromptBlock });

  const parts = [];
  if (contextImage) parts.push({ inlineData: { mimeType: contextImage.mimeType, data: contextImage.base64 } });
  if (questionImage) parts.push({ inlineData: { mimeType: questionImage.mimeType, data: questionImage.base64 } });
  parts.push({ text: prompt });

  async function tryKey(apiKey, keyLabel) {
    let lastReason = 'unknown';
    let lastDetail = 'לא התקבלה תשובה מ-Gemini.';
    for (const model of MODEL_CHAIN.explain) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: EXPLAIN_GEN_CONFIG,
            safetySettings: EXPLAIN_SAFETY_SETTINGS,
          }),
          // Pro-preview with 16k thinking budget can take 60-90s; give room.
          signal: AbortSignal.timeout(110000),
        });
      } catch (netErr) {
        lastReason = 'network';
        lastDetail = `שגיאת רשת מול Gemini (${netErr?.name || 'Error'}).`;
        console.warn(`[regen] ${keyLabel}/${model} network error:`, netErr?.message || netErr);
        continue;
      }

      if (!r.ok) {
        const bodyText = await r.text().catch(() => '');
        console.warn(`[regen] ${keyLabel}/${model} http ${r.status}: ${bodyText.slice(0, 200)}`);
        if (r.status === 429) return { data: null, quota: true, reason: 'quota', detail: 'חריגה ממכסת Gemini — נסה שוב בעוד כמה דקות.' };
        lastReason = `http_${r.status}`;
        lastDetail = `שגיאת רשת מול Gemini (status ${r.status}).`;
        continue;
      }

      let j;
      try { j = await r.json(); }
      catch (e) {
        lastReason = 'response_not_json';
        lastDetail = 'Gemini החזיר תשובה לא תקינה.';
        console.warn(`[regen] ${keyLabel}/${model} response not JSON:`, e?.message);
        continue;
      }

      const cand = j.candidates?.[0];
      const finishReason = cand?.finishReason || null;
      const promptBlock = j.promptFeedback?.blockReason || null;
      const text = cand?.content?.parts?.map(p => p.text).join('') || '';
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

      if (!cleaned) {
        if (finishReason === 'SAFETY' || promptBlock) {
          lastReason = 'safety';
          lastDetail = 'המודל חסם את הבקשה (safety filter).';
        } else if (finishReason === 'MAX_TOKENS') {
          lastReason = 'truncated';
          lastDetail = 'התשובה נחתכה — נסה שוב.';
        } else {
          lastReason = 'empty';
          lastDetail = 'Gemini החזיר תשובה ריקה.';
        }
        console.warn(`[regen] ${keyLabel}/${model} empty text (finishReason=${finishReason}, block=${promptBlock})`);
        continue;
      }

      let parsed;
      try { parsed = JSON.parse(cleaned); }
      catch (e) {
        lastReason = 'parse_error';
        lastDetail = 'המודל החזיר JSON לא תקין — נסה שוב.';
        console.warn(`[regen] ${keyLabel}/${model} JSON.parse failed: ${e?.message}. First 200ch: ${cleaned.slice(0, 200)}`);
        continue;
      }

      const normalized = normalizeExplainResponse(parsed, { numOptions, correctIdx });
      if (!normalized) {
        lastReason = 'invalid_shape';
        lastDetail = 'המודל החזיר נתונים בצורה לא צפויה — נסה שוב.';
        console.warn(`[regen] ${keyLabel}/${model} invalid shape: keys=${Object.keys(parsed || {}).join(',')}`);
        continue;
      }

      console.log(`[regen] ${keyLabel}/${model} ok (concept_tag=${normalized.concept_tag ? 'yes' : 'no'}, distractors=${normalized.distractor_analysis?.length ?? 0})`);
      return { data: normalized };
    }
    return { data: null, reason: lastReason, detail: lastDetail };
  }

  const primary = paidKey || freeKey;
  const primaryLabel = paidKey ? 'paid' : 'free';
  const fallback = paidKey && freeKey ? freeKey : null;
  let out = await tryKey(primary, primaryLabel);
  if (!out?.data && !out?.quota && fallback) {
    console.log('[regen] primary exhausted — trying fallback key');
    const fbOut = await tryKey(fallback, 'free');
    if (fbOut?.data || fbOut?.quota) out = fbOut;
    else out = fbOut || out;
  }
  return out;
}

async function handleRegenerate(auth, q, res) {
  if (!q.correct_idx) {
    return res.status(409).json({ error: 'חסרה תשובה נכונה', detail: 'לא ניתן ליצור הסבר לפני שנקבעה תשובה נכונה לשאלה.' });
  }

  const groupCtx = await buildGroupContextForQuestion(auth.db, q);
  const contextPromptBlock = groupCtx?.contextPromptBlock || null;

  const [questionImage, contextImage] = await Promise.all([
    fetchImageBase64(q.image_path),
    (q.group_id && q.context_image_path) ? fetchImageBase64(q.context_image_path) : Promise.resolve(null),
  ]);
  if (!questionImage && !q.question_text) {
    return res.status(409).json({ error: 'אין מקור לניתוח', detail: 'לשאלה זו אין תמונה וגם אין טקסט.' });
  }

  const result = await explainWithGemini(q, contextPromptBlock, questionImage, contextImage);
  if (result?.quota) {
    return res.status(429).json({ error: 'חריגה ממכסת AI', detail: result.detail || 'חריגה ממכסת Gemini — נסה שוב בעוד כמה דקות.' });
  }
  const explanation = result?.data;
  if (!explanation) {
    const detail = result?.detail || 'Gemini לא החזיר תוצאה תקפה.';
    console.warn(`[regen] Q${q.id} failed: reason=${result?.reason || 'unknown'}`);
    // Mark status=failed so the UI can show a "retry" CTA if we add one later.
    auth.db.from('ep_questions').update({ explanation_status: 'failed' }).eq('id', q.id)
      .then(() => {}, e => console.warn('[regen] mark failed:', e?.message));
    return res.status(502).json({ error: 'יצירת הפתרון נכשלה', detail });
  }

  // explanation already passed through normalizeExplainResponse — safe to drop
  // straight into the DB update.
  const update = {
    general_explanation: explanation.general_explanation,
    option_explanations: explanation.option_explanations,
    concept_tag: explanation.concept_tag,           // may be null
    distractor_analysis: explanation.distractor_analysis, // may be null
    explanation_status: 'verified',
  };
  let { error: upErr } = await auth.db.from('ep_questions').update(update).eq('id', q.id);
  // If any of the enrichment columns are missing (migration not yet applied on
  // some environment), retry with only the baseline columns so the user still
  // sees *some* progress rather than a 500.
  if (upErr?.message?.includes('column') && upErr.message.includes('does not exist')) {
    console.warn('[regen] enrichment column missing — retrying without:', upErr.message);
    const fallback = { general_explanation: update.general_explanation, option_explanations: update.option_explanations };
    ({ error: upErr } = await auth.db.from('ep_questions').update(fallback).eq('id', q.id));
  }
  if (upErr) return res.status(500).json({ error: 'עדכון נכשל', detail: upErr.message });

  console.log(`[regen-answer] Q${q.question_number} updated (group=${q.group_id || 'none'}, ctx=${contextPromptBlock ? 'yes' : 'no'}, concept=${explanation.concept_tag || 'none'}, distractors=${explanation.distractor_analysis?.length ?? 0})`);
  return res.json({ ok: true, action: 'regenerate-answer', ...update });
}

// ───────────────────── action: recrop (manual user crop) ────────────────────
// User selected a rectangle on a PDF page in the frontend crop tool. We build
// a new Cloudinary crop URL from those normalized coordinates and update the
// question. NO Gemini call — this is a free, deterministic operation.
//
// Request body: { page, xNorm, yNorm, wNorm, hNorm }
//   page  = 1-based PDF page number the user cropped from (self-heal: we
//           always trust this over the stored pdf_page).
//   *Norm = rectangle in 0..1 space relative to the PDF page's rendered
//           viewport in the frontend (the exact scale doesn't matter — the
//           percentages map identically to any render width).
//
// Response: { ok: true, image_path, pdf_page }
async function handleRecrop(auth, q, req, res) {
  const body = req.body || {};
  const page   = parseInt(body.page, 10);
  const xNorm  = Number(body.xNorm);
  const yNorm  = Number(body.yNorm);
  const wNorm  = Number(body.wNorm);
  const hNorm  = Number(body.hNorm);
  if (!Number.isFinite(page) || page < 1 || page > 500) {
    return res.status(400).json({ error: 'מספר עמוד לא תקין' });
  }
  if (![xNorm, yNorm, wNorm, hNorm].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
    return res.status(400).json({ error: 'קואורדינטות חיתוך לא תקינות' });
  }
  if (wNorm < 0.02 || hNorm < 0.02) {
    return res.status(400).json({ error: 'אזור החיתוך קטן מדי' });
  }
  if (xNorm + wNorm > 1.01 || yNorm + hNorm > 1.01) {
    return res.status(400).json({ error: 'אזור החיתוך חורג מהעמוד' });
  }

  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  if (!cloudName) return res.status(500).json({ error: 'CLOUDINARY_CLOUD_NAME חסר' });

  // Resolve the exam PDF public_id (prefer stored, fallback to parsing image URL).
  const { data: exam } = await auth.db.from('ep_exams')
    .select('id, user_id, exam_pdf_path').eq('id', q.exam_id).maybeSingle();
  if (!exam) return res.status(404).json({ error: 'מבחן לא נמצא' });

  let examPdfPath = exam.exam_pdf_path || extractPdfPublicId(q.image_path);
  if (!examPdfPath) {
    return res.status(409).json({
      error: 'קובץ המבחן לא זמין',
      detail: 'הקובץ לא נמצא בענן. מחק את המבחן והעלה שוב.',
    });
  }

  // Cloudinary renders the PDF page at CLOUDINARY_RENDER_W px wide. We apply
  // `c_crop` AFTER `pg_{page},w_{W}` so crop pixels are relative to that
  // render width. Height = W * (aspectRatio) — we don't know the exact
  // aspect, but PDF pages are typically ~1.414 (A4). To stay independent of
  // the page's actual aspect ratio, apply w_ at the top then crop by
  // percentages via g_north with computed pixel heights. Cloudinary DOES
  // support fractional dimensions, so we can use pixel math here.
  //
  // We render at 1600px width (same as ai-action's reanalyze). Height is
  // derived from the front-end sending a rendered page — which always yields
  // normalized 0..1 box coordinates. We need to map y-norm against a render
  // height. Approximate: for a real render, height = Math.round(W * rendered-aspect).
  // Since we don't know the aspect here (varies per page), use a hardcoded
  // A4 factor ~1.414. This mirrors ai-action.mjs's estimatedPageH_px calc.
  const W = CLOUDINARY_RENDER_W;
  const H = Math.round(W * 1.414); // A4 approx; pixel math is consistent for both axes
  const cropW = Math.max(40, Math.round(wNorm * W));
  const cropH = Math.max(40, Math.round(hNorm * H));
  const cropX = Math.max(0, Math.round(xNorm * W));
  const cropY = Math.max(0, Math.round(yNorm * H));
  const newUrl = `https://res.cloudinary.com/${cloudName}/image/upload/pg_${page},w_${W}/c_crop,w_${cropW},h_${cropH},x_${cropX},y_${cropY}/q_auto/${examPdfPath}.png`;

  const update = {
    image_path: newUrl,
    pdf_page: page,
    pdf_page_confidence: 'user_confirmed',
  };
  const { error: upErr } = await auth.db.from('ep_questions').update(update).eq('id', q.id);
  // Retry without pdf_page columns if migration hasn't run yet — image_path
  // still gets persisted so the user's crop isn't lost.
  if (upErr?.message?.includes('column') && upErr.message.includes('does not exist')) {
    console.warn('[recrop] column missing — retrying without pdf_page fields');
    const { error: retryErr } = await auth.db.from('ep_questions')
      .update({ image_path: newUrl }).eq('id', q.id);
    if (retryErr) return res.status(500).json({ error: 'עדכון נכשל', detail: retryErr.message });
  } else if (upErr) {
    return res.status(500).json({ error: 'עדכון נכשל', detail: upErr.message });
  }

  console.log(`[recrop] Q${q.question_number} page=${page} crop=${cropX},${cropY} ${cropW}x${cropH}`);
  return res.json({ ok: true, action: 'recrop', image_path: newUrl, pdf_page: page });
}

// ───────────────────── handler (dispatches by URL) ───────────────────────────
export default async function handler(req, res) {
  try {
    return await _handler(req, res);
  } catch (fatal) {
    const diag = (fatal?.message || String(fatal)).slice(0, 240);
    console.error('[ai-action] fatal:', diag);
    return res.status(500).json({ error: 'שגיאה פנימית', detail: diag });
  }
}

async function _handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  if (await checkModelimBlock(res, getAdmin(), auth.userId)) return;

  // URL shape: /api/questions/:id/{reanalyze|regenerate-answer|recrop}
  const m = req.url?.match(/\/api\/questions\/([^/]+)\/(reanalyze|regenerate-answer|recrop)/);
  if (!m) return res.status(400).json({ error: 'Unknown action' });
  const questionId = parseInt(m[1], 10);
  const action = m[2];
  if (!Number.isFinite(questionId)) return res.status(400).json({ error: 'Missing questionId' });

  const { data: q, error: qErr } = await auth.db.from('ep_questions')
    .select('*').eq('id', questionId).maybeSingle();
  if (qErr || !q) return res.status(404).json({ error: 'שאלה לא נמצאה' });

  // recrop bypasses the AI-quota gate — it's a no-cost manual operation
  // (just builds a Cloudinary transform URL from user-provided coords).
  if (action !== 'recrop') {
    const aborted = await checkOwnershipAndQuota(auth, q, res);
    if (aborted) return;
  } else {
    // Still enforce ownership for recrop.
    if (q.user_id !== auth.userId) return res.status(403).json({ error: 'אין הרשאה' });
  }

  if (action === 'reanalyze') return handleReanalyze(auth, q, req, res);
  if (action === 'regenerate-answer') return handleRegenerate(auth, q, res);
  if (action === 'recrop') return handleRecrop(auth, q, req, res);
  return res.status(400).json({ error: 'Unknown action' });
}
