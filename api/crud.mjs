// =====================================================
// Vercel Serverless Catch-All — authenticated CRUD routes
// =====================================================
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { PLAN_QUOTAS as PLAN_QUOTAS_SRC, getQuota, legacyQuotaShape } from './_lib/quotas.mjs';
import { checkBurst, checkGlobalBudget } from './_lib/burst-check.mjs';
import { extractTopicsForCourse } from './_lib/topic-extractor.mjs';
import { getGeminiKeys } from './_lib/gemini-key.mjs';
import { isModelim } from './_lib/seed-guard.mjs';

// 60s so the synchronous Gemini topic-labeler (runs under /ai/extract-topics)
// has enough headroom for ~10 batches. All other routes return in < 2s.
export const config = { maxDuration: 60 };

// ===== Supabase clients =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _admin = null;
function getAdmin() {
  if (!_admin && SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
  }
  return _admin;
}

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
  const client = getAdmin() || createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id, userEmail: data.user.email, userJwt: token, db: userClient(token) };
}

function dbErr(res, tag, error) {
  console.error(`[db] ${tag}:`, error?.message || error);
  return res.status(500).json({ error: 'שגיאה פנימית בשרת. נסה שוב.' });
}

// Validate course image URLs are hosted on trusted CDNs only.
// Accepts Cloudinary and the configured Supabase project's storage host.
const SUPABASE_HOST = (() => {
  try { return SUPABASE_URL ? new URL(SUPABASE_URL).host : null; } catch { return null; }
})();
function isAllowedImageUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.host.toLowerCase();
  if (host === 'res.cloudinary.com' || host.endsWith('.cloudinary.com')) return true;
  if (SUPABASE_HOST && host === SUPABASE_HOST) return true;
  if (host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) return true;
  // Unsplash is used by the pre-built degree chooser.
  if (host === 'images.unsplash.com' || host.endsWith('.unsplash.com')) return true;
  return false;
}

// Strict positive-integer ID validator (for restore / soft-delete routes).
function validId(raw) {
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Legacy-shaped quota table — populated from the single source of truth
// at api/_lib/quotas.mjs so /api/me and server.mjs-style callers see the
// exact same numbers the AI endpoints enforce.
const QUOTAS = Object.fromEntries(
  Object.keys(PLAN_QUOTAS_SRC).map(plan => [plan, legacyQuotaShape(plan)])
);

// Routes a plan='modelim' user may reach. Everything else returns 403. Scope
// covers read-only listing + practice (batch start/end, attempt) + the
// whoami endpoint. No creation, no AI, no mutations of seeded data.
const MODELIM_ALLOWED_ROUTES = new Set([
  'health', 'me',
  'list-courses', 'get-course', 'list-sub-courses',
  'list-exams', 'list-questions', 'list-contexts',
  'list-batches', 'batch-start', 'batch-end', 'attempt',
  'stats-summary', 'review-queue',
  'list-trash', 'list-packs', 'get-pack',
  'account-delete',
]);

// Client-IP extraction for trial-farming protection. First X-Forwarded-For
// entry is the real client on Vercel.
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}
function hashIp(ip) {
  const salt = (process.env.IP_HASH_SALT || '').replace(/\\n/g, '').trim();
  if (!salt || !ip) return null;
  return createHash('sha256').update(salt + ip).digest('hex');
}

async function getUserProfile(userId, userDb, req = null) {
  const admin = getAdmin();
  if (admin) {
    try { await admin.rpc('reset_user_quotas_if_needed', { p_user_id: userId }); } catch {}
    // Trial-farming protection: claim the signup IP once. This is a no-op
    // after the first call (the RPC returns `already_set`). Must run BEFORE
    // we fetch the profile so we see the possibly-downgraded plan.
    if (req) {
      try {
        const ipHash = hashIp(getClientIp(req));
        await admin.rpc('ep_claim_trial_with_ip_check', {
          p_user_id: userId,
          p_ip_hash: ipHash,
        });
      } catch (e) {
        console.warn('[trial-ip-claim]', e?.message);
      }
    }
    const { data, error } = await admin.from('profiles').select('*').eq('id', userId).single();
    if (error) return null;
    if (data.plan === 'trial' && data.plan_expires_at && new Date(data.plan_expires_at) < new Date()) {
      await admin.from('profiles').update({ plan: 'free', trial_used: true }).eq('id', userId);
      data.plan = 'free'; data.trial_used = true;
    }
    return data;
  }
  // Fallback: use the user's own RLS-scoped client (skips quota reset and trial expiry enforcement)
  if (!userDb) return null;
  const { data } = await userDb.from('profiles').select('*').eq('id', userId).single();
  return data || null;
}

function publicProfile(p) {
  if (!p) return null;
  let daysLeft = null;
  if (p.plan === 'trial' && p.plan_expires_at)
    daysLeft = Math.max(0, Math.ceil((new Date(p.plan_expires_at) - Date.now()) / 86400000));
  return {
    email: p.email, display_name: p.display_name, username: p.username,
    plan: p.plan, plan_expires_at: p.plan_expires_at, is_admin: p.is_admin || false,
    trial_started_at: p.trial_started_at || null, trial_used: p.trial_used || false, days_left: daysLeft,
    pdfs_uploaded_today: p.pdfs_uploaded_today, pdfs_uploaded_this_month: p.pdfs_uploaded_this_month,
    ai_questions_used_today: p.ai_questions_used_today, ai_questions_used_this_month: p.ai_questions_used_this_month,
    study_packs_used_total: p.study_packs_used_total || 0, study_packs_used_this_month: p.study_packs_used_this_month || 0,
    storage_bytes_used: p.storage_bytes_used, created_at: p.created_at,
  };
}

// ===== Router =====
function matchRoute(method, url) {
  const p = url.split('?')[0].replace(/^\/api/, '').replace(/\/$/, '') || '/';
  const s = p.split('/').filter(Boolean);

  if (method === 'GET'  && p === '/health')  return { r: 'health' };
  if (method === 'GET'  && p === '/me')      return { r: 'me' };
  if (method === 'GET'  && p === '/courses') return { r: 'list-courses' };
  if (method === 'POST' && p === '/courses') return { r: 'create-course' };
  if (method === 'POST' && p === '/attempt') return { r: 'attempt' };
  if (method === 'POST' && p === '/batches/start') return { r: 'batch-start' };
  if (method === 'POST' && p === '/batches/end') return { r: 'batch-end' };
  if (method === 'GET'  && p === '/study/packs') return { r: 'list-packs' };
  if (method === 'GET'  && p === '/stats/summary') return { r: 'stats-summary' };
  if (method === 'POST' && p === '/admin/switch-plan') return { r: 'admin-switch-plan' };
  if ((method === 'POST' || method === 'DELETE') && p === '/account/delete') return { r: 'account-delete' };
  if (method === 'POST' && p === '/ai/generate-similar') return { r: 'ai-similar' };
  if (method === 'POST' && p === '/ai/extract-topics') return { r: 'ai-extract-topics' };
  if (method === 'POST' && p === '/exams/finalize-review') return { r: 'finalize-review' };
  if (method === 'POST' && p === '/upload-sign') return { r: 'upload-sign' };

  if (s[0] === 'courses' && s.length >= 2) {
    const cid = parseInt(s[1], 10) || s[1]; // integer for DB, fallback to string for safety
    if (s.length === 2 && method === 'GET') return { r: 'get-course', cid };
    if (s.length === 2 && method === 'DELETE') return { r: 'delete-course', cid };
    if (s.length === 2 && method === 'PATCH') return { r: 'update-course', cid };
    if (s.length === 3 && s[2] === 'courses' && method === 'GET') return { r: 'list-sub-courses', cid };
    if (s.length === 3 && s[2] === 'exams' && method === 'GET') return { r: 'list-exams', cid };
    if (s.length === 3 && s[2] === 'questions' && method === 'GET') return { r: 'list-questions', cid };
    if (s.length === 3 && s[2] === 'batches' && method === 'GET') return { r: 'list-batches', cid };
    if (s.length === 3 && s[2] === 'review-queue' && method === 'GET') return { r: 'review-queue', cid };
    if (s.length === 3 && s[2] === 'trash' && method === 'GET') return { r: 'list-trash', cid };
    if (s.length === 4 && s[2] === 'exams' && method === 'DELETE') return { r: 'delete-exam', cid, eid: parseInt(s[3], 10) || s[3] };
    if (s.length === 4 && s[2] === 'questions' && method === 'DELETE') return { r: 'delete-question', cid, qid: parseInt(s[3], 10) || s[3] };
    if (s.length === 4 && s[2] === 'questions' && method === 'PATCH') return { r: 'update-question', cid, qid: parseInt(s[3], 10) || s[3] };
    if (s.length === 4 && s[2] === 'trash' && s[3] === 'restore-exam' && method === 'POST') return { r: 'restore-exam', cid };
    if (s.length === 4 && s[2] === 'trash' && s[3] === 'restore-question' && method === 'POST') return { r: 'restore-question', cid };
  }

  // Shared-context endpoints: create/list under an exam, update/delete per group.
  //   POST   /api/exams/:examId/context           → create-context (new group)
  //   GET    /api/exams/:examId/context           → list-contexts (for the manage modal)
  //   PATCH  /api/exams/:examId/context/:groupId  → update-context (change questions / re-crop)
  //   DELETE /api/exams/:examId/context/:groupId  → delete-context (unlink everyone)
  if (s[0] === 'exams' && s.length >= 3 && s[2] === 'context') {
    const eid = parseInt(s[1], 10) || s[1];
    if (s.length === 3 && method === 'POST') return { r: 'create-context', eid };
    if (s.length === 3 && method === 'GET')  return { r: 'list-contexts', eid };
    if (s.length === 4 && method === 'PATCH')  return { r: 'update-context', eid, gid: decodeURIComponent(s[3]) };
    if (s.length === 4 && method === 'DELETE') return { r: 'delete-context', eid, gid: decodeURIComponent(s[3]) };
  }

  if (s[0] === 'study' && s[1] === 'packs' && s.length === 3) {
    const id = parseInt(s[2], 10);
    if (method === 'GET') return { r: 'get-pack', id };
    if (method === 'DELETE') return { r: 'delete-pack', id };
  }

  return null;
}

// ───────────────────── context (user-managed shared info) ───────────────────
// Four operations on ep_questions.group_id / context_image_path / *_pdf_page.
// There's no separate ep_groups table — groups are denormalized onto
// ep_questions (see supabase/migrations/question_group_id.sql). A "group" is
// simply: all rows in one exam that share the same group_id.
async function handleContextAction(m, req, res, auth) {
  const examId = parseInt(m.eid, 10);
  if (!Number.isFinite(examId)) return res.status(400).json({ error: 'examId לא תקין' });

  // Verify user owns this exam.
  const { data: exam, error: exErr } = await auth.db.from('ep_exams')
    .select('id, user_id, exam_pdf_path, course_id')
    .eq('id', examId).maybeSingle();
  if (exErr || !exam) return res.status(404).json({ error: 'מבחן לא נמצא' });
  if (exam.user_id !== auth.userId) return res.status(403).json({ error: 'אין הרשאה' });

  if (m.r === 'list-contexts') {
    const { data: rows, error } = await auth.db.from('ep_questions')
      .select('id, question_number, group_id, context_image_path, context_pdf_page, context_text')
      .eq('exam_id', examId).eq('user_id', auth.userId).is('deleted_at', null)
      .not('group_id', 'is', null);
    if (error) return dbErr(res, 'list contexts', error);
    // Group by group_id.
    const map = new Map();
    for (const r of rows || []) {
      if (!r.group_id) continue;
      if (!map.has(r.group_id)) {
        map.set(r.group_id, {
          group_id: r.group_id,
          context_image_path: r.context_image_path || null,
          context_pdf_page: r.context_pdf_page || null,
          context_text: r.context_text || null,
          question_ids: [],
          question_numbers: [],
        });
      }
      const g = map.get(r.group_id);
      g.question_ids.push(r.id);
      g.question_numbers.push(r.question_number);
      // A group's image comes from any member that has it set. Prefer non-null.
      if (!g.context_image_path && r.context_image_path) g.context_image_path = r.context_image_path;
      if (!g.context_pdf_page && r.context_pdf_page) g.context_pdf_page = r.context_pdf_page;
    }
    for (const g of map.values()) g.question_numbers.sort((a, b) => (a || 0) - (b || 0));
    return res.json({ ok: true, contexts: Array.from(map.values()) });
  }

  // create/update/delete all require exam_pdf_path lookup.
  const body = req.body || {};

  if (m.r === 'delete-context') {
    const gid = m.gid;
    if (!gid) return res.status(400).json({ error: 'group_id חסר' });
    const { error } = await auth.db.from('ep_questions')
      .update({ group_id: null, context_image_path: null, context_cross_page: false, context_pdf_page: null, context_text: null })
      .eq('exam_id', examId).eq('group_id', gid).eq('user_id', auth.userId);
    if (error) return dbErr(res, 'delete context', error);
    return res.json({ ok: true });
  }

  // create / update — both need a crop + questionIds.
  const questionIds = Array.isArray(body.questionIds)
    ? body.questionIds.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0)
    : [];
  if (m.r === 'create-context' && questionIds.length === 0) {
    return res.status(400).json({ error: 'בחר לפחות שאלה אחת לשייך למידע' });
  }

  // Build a Cloudinary crop URL only when we have fresh crop coords. For
  // update-context without coords, reuse the existing image_path.
  let contextImageUrl = null;
  let contextPage = null;
  const page   = body.page   !== undefined ? parseInt(body.page, 10) : null;
  const xNorm  = body.xNorm  !== undefined ? Number(body.xNorm)  : null;
  const yNorm  = body.yNorm  !== undefined ? Number(body.yNorm)  : null;
  const wNorm  = body.wNorm  !== undefined ? Number(body.wNorm)  : null;
  const hNorm  = body.hNorm  !== undefined ? Number(body.hNorm)  : null;
  const haveCrop = [page, xNorm, yNorm, wNorm, hNorm].every(v => v !== null && Number.isFinite(v));

  if (haveCrop) {
    if (page < 1 || page > 500) return res.status(400).json({ error: 'מספר עמוד לא תקין' });
    for (const v of [xNorm, yNorm, wNorm, hNorm]) {
      if (v < 0 || v > 1) return res.status(400).json({ error: 'קואורדינטות חיתוך לא תקינות' });
    }
    if (wNorm < 0.02 || hNorm < 0.02) return res.status(400).json({ error: 'אזור החיתוך קטן מדי' });

    const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
    if (!cloudName) return res.status(500).json({ error: 'CLOUDINARY_CLOUD_NAME חסר' });
    const examPdfPath = exam.exam_pdf_path;
    if (!examPdfPath) return res.status(409).json({ error: 'קובץ מבחן לא זמין בענן' });

    const W = 1600;
    const H = Math.round(W * 1.414);
    const cropW = Math.max(40, Math.round(wNorm * W));
    const cropH = Math.max(40, Math.round(hNorm * H));
    const cropX = Math.max(0, Math.round(xNorm * W));
    const cropY = Math.max(0, Math.round(yNorm * H));
    contextImageUrl = `https://res.cloudinary.com/${cloudName}/image/upload/pg_${page},w_${W}/c_crop,w_${cropW},h_${cropH},x_${cropX},y_${cropY}/q_auto/${examPdfPath}.png`;
    contextPage = page;
  }

  if (m.r === 'create-context') {
    if (!haveCrop) return res.status(400).json({ error: 'חסרות קואורדינטות חיתוך' });
    // Generate a fresh group_id. "U-" prefix distinguishes user-created from
    // Gemini-created ("A", "B", "C"). Short and URL-safe.
    const slug = body.group_id && typeof body.group_id === 'string'
      ? body.group_id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
      : ('U-' + Date.now().toString(36));
    if (!slug) return res.status(400).json({ error: 'group_id לא תקין' });

    // Fetch the selected questions to compute context_cross_page per row
    // (context page !== question's pdf_page).
    const { data: qs, error: qErr } = await auth.db.from('ep_questions')
      .select('id, pdf_page, group_id')
      .eq('exam_id', examId).eq('user_id', auth.userId).is('deleted_at', null)
      .in('id', questionIds);
    if (qErr) return dbErr(res, 'fetch target questions', qErr);

    // Update each question individually so context_cross_page can be per-row.
    const errors = [];
    for (const qRow of (qs || [])) {
      const update = {
        group_id: slug,
        context_image_path: contextImageUrl,
        context_pdf_page: contextPage,
        context_cross_page: Number.isFinite(qRow.pdf_page) ? (qRow.pdf_page !== contextPage) : true,
        context_text: typeof body.context_text === 'string' ? body.context_text.slice(0, 4000) : null,
      };
      let { error } = await auth.db.from('ep_questions').update(update).eq('id', qRow.id);
      if (error?.message?.includes('column') && error.message.includes('does not exist')) {
        const { context_pdf_page, ...stripped } = update;
        ({ error } = await auth.db.from('ep_questions').update(stripped).eq('id', qRow.id));
      }
      if (error) errors.push({ id: qRow.id, error: error.message });
    }
    if (errors.length) return res.status(500).json({ error: 'שגיאה בחלק מהעדכונים', errors });
    return res.json({ ok: true, group_id: slug, context_image_path: contextImageUrl, assigned: questionIds.length });
  }

  if (m.r === 'update-context') {
    const gid = m.gid;
    if (!gid) return res.status(400).json({ error: 'group_id חסר' });

    // 1) If new crop provided, update the image+page on every row in this group.
    if (haveCrop && contextImageUrl) {
      const { error } = await auth.db.from('ep_questions')
        .update({ context_image_path: contextImageUrl, context_pdf_page: contextPage })
        .eq('exam_id', examId).eq('group_id', gid).eq('user_id', auth.userId);
      if (error?.message?.includes('column') && error.message.includes('does not exist')) {
        await auth.db.from('ep_questions')
          .update({ context_image_path: contextImageUrl })
          .eq('exam_id', examId).eq('group_id', gid).eq('user_id', auth.userId);
      } else if (error) {
        return dbErr(res, 'update context image', error);
      }
    }

    // 2) If questionIds provided, reconcile membership.
    if (Array.isArray(body.questionIds)) {
      // Current members of this group:
      const { data: current } = await auth.db.from('ep_questions')
        .select('id, pdf_page, context_image_path')
        .eq('exam_id', examId).eq('group_id', gid).eq('user_id', auth.userId);
      const currentIds = new Set((current || []).map(r => r.id));
      const targetIds = new Set(questionIds);

      // Remove old members
      const toRemove = [...currentIds].filter(id => !targetIds.has(id));
      if (toRemove.length) {
        await auth.db.from('ep_questions')
          .update({ group_id: null, context_image_path: null, context_cross_page: false, context_pdf_page: null, context_text: null })
          .in('id', toRemove);
      }
      // Add new members — need image_path + page from any current member.
      const toAdd = [...targetIds].filter(id => !currentIds.has(id));
      if (toAdd.length) {
        const firstMember = (current || [])[0];
        const imgPath = contextImageUrl || firstMember?.context_image_path || null;
        const ctxPage = contextPage !== null ? contextPage : null;
        const { data: addRows } = await auth.db.from('ep_questions')
          .select('id, pdf_page').in('id', toAdd);
        for (const r of (addRows || [])) {
          const update = {
            group_id: gid,
            context_image_path: imgPath,
            context_pdf_page: ctxPage,
            context_cross_page: ctxPage != null && Number.isFinite(r.pdf_page) ? (r.pdf_page !== ctxPage) : true,
          };
          let { error } = await auth.db.from('ep_questions').update(update).eq('id', r.id);
          if (error?.message?.includes('column') && error.message.includes('does not exist')) {
            const { context_pdf_page, ...stripped } = update;
            await auth.db.from('ep_questions').update(stripped).eq('id', r.id);
          }
        }
      }
    }

    return res.json({ ok: true, group_id: gid });
  }

  return res.status(400).json({ error: 'Unknown context action' });
}

export default async function handler(req, res) {
  const m = matchRoute(req.method, req.url);
  if (!m) return res.status(404).json({ error: 'Not found' });

  if (m.r === 'health') {
    const admin = getAdmin();
    let storageStatus = 'no admin';
    if (admin) {
      try {
        // Auto-create exam-pages bucket if it doesn't exist
        const { data: buckets } = await admin.storage.listBuckets();
        const exists = buckets?.some(b => b.name === 'exam-pages');
        if (!exists) {
          const { error } = await admin.storage.createBucket('exam-pages', { public: false, fileSizeLimit: 52428800 });
          if (error) { console.error('[health] bucket create:', error.message); storageStatus = 'create failed'; }
          else storageStatus = 'bucket created';
        } else {
          storageStatus = 'bucket exists';
        }
      } catch (e) { console.error('[health]', e?.message || e); storageStatus = 'error'; }
    }
    return res.json({ status: 'ok', supabase: !!admin, storage: storageStatus });
  }

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  // ===== Modelim plan: read-only practice =====
  // Friends of the Computational Models course get pre-seeded data and must
  // never modify their account or trigger AI. Enforce a server-side route
  // whitelist so a forged client cannot bypass UI gating. Admin users are
  // exempt (a modelim-flagged admin is the course owner managing content).
  try {
    const { data: planRow } = await auth.db.from('profiles').select('plan, is_admin').eq('id', auth.userId).maybeSingle();
    if (!planRow?.is_admin && isModelim(planRow?.plan) && !MODELIM_ALLOWED_ROUTES.has(m.r)) {
      return res.status(403).json({
        error: 'התוכנית שלך לא מאפשרת פעולה זו',
        guidance: 'משתמשי "מודלים חישוביים" יכולים רק לתרגל שאלות אמריקאיות מתוך המבחנים שהועלו.',
        plan: 'modelim',
      });
    }
  } catch (e) {
    console.warn('[modelim-guard] plan lookup failed:', e?.message);
  }

  switch (m.r) {
    case 'me': {
      const profile = await getUserProfile(auth.userId, auth.db, req);
      if (!profile) return res.status(404).json({ error: 'profile not found' });
      return res.json({ profile: publicProfile(profile), quotas: QUOTAS[profile.plan || 'free'] });
    }
    case 'list-courses': {
      // Prefer top-level only (parent_id IS NULL). Falls back to all courses if
      // the column doesn't exist yet (migration not applied).
      let { data, error } = await auth.db.from('ep_courses').select('*').is('parent_id', null).order('created_at', { ascending: false });
      if (error) {
        // Column may not exist — fall back to returning everything
        ({ data, error } = await auth.db.from('ep_courses').select('*').order('created_at', { ascending: false }));
        if (error) return dbErr(res, 'list courses', error);
      }
      try {
        const [{ data: qRows }, { data: eRows }] = await Promise.all([
          auth.db.from('ep_questions').select('course_id').is('deleted_at', null),
          auth.db.from('ep_exams').select('course_id').is('deleted_at', null),
        ]);
        const qByCourse = {}, eByCourse = {};
        for (const r of qRows || []) qByCourse[r.course_id] = (qByCourse[r.course_id] || 0) + 1;
        for (const r of eRows || []) eByCourse[r.course_id] = (eByCourse[r.course_id] || 0) + 1;
        // child_count — only attempt if column exists (migration applied)
        let childCount = {};
        try {
          const { data: childRows } = await auth.db.from('ep_courses').select('parent_id').not('parent_id', 'is', null);
          for (const r of childRows || []) childCount[r.parent_id] = (childCount[r.parent_id] || 0) + 1;
        } catch {}
        for (const c of data || []) {
          c.total_questions = qByCourse[c.id] || 0;
          c.total_pdfs = eByCourse[c.id] || 0;
          c.child_count = childCount[c.id] || 0;
        }
      } catch (e) {
        console.warn('[list-courses] recompute failed:', e?.message || e);
      }
      return res.json(data || []);
    }
    case 'get-course': {
      // Single-course fetch — used by the frontend when the user lands
      // directly on /course/:id and the CourseRegistry cache doesn't have it
      // (common after page refresh on a sub-course URL). Returns the course
      // row (with ownership check via RLS) or 404.
      const { data, error } = await auth.db.from('ep_courses').select('*')
        .eq('id', m.cid).eq('user_id', auth.userId).maybeSingle();
      if (error) return dbErr(res, 'get-course', error);
      if (!data) return res.status(404).json({ error: 'קורס לא נמצא' });
      return res.json(data);
    }
    case 'list-sub-courses': {
      // Returns [] if parent_id column doesn't exist yet
      const { data, error } = await auth.db.from('ep_courses').select('*')
        .eq('parent_id', m.cid).eq('user_id', auth.userId)
        .order('created_at', { ascending: false });
      if (error) return res.json([]); // column may not exist yet
      try {
        const ids = (data || []).map(c => c.id);
        if (ids.length) {
          const [{ data: qRows }, { data: eRows }] = await Promise.all([
            auth.db.from('ep_questions').select('course_id').in('course_id', ids).is('deleted_at', null),
            auth.db.from('ep_exams').select('course_id').in('course_id', ids).is('deleted_at', null),
          ]);
          const qByCourse = {}, eByCourse = {};
          for (const r of qRows || []) qByCourse[r.course_id] = (qByCourse[r.course_id] || 0) + 1;
          for (const r of eRows || []) eByCourse[r.course_id] = (eByCourse[r.course_id] || 0) + 1;
          for (const c of data || []) {
            c.total_questions = qByCourse[c.id] || 0;
            c.total_pdfs = eByCourse[c.id] || 0;
          }
        }
      } catch (e) { console.warn('[list-sub-courses] recompute failed:', e?.message || e); }
      return res.json(data || []);
    }
    case 'create-course': {
      const { name, description, color, image_url, parent_id, is_degree } = req.body || {};
      if (typeof name !== 'string' || name.length < 2 || name.length > 100)
        return res.status(400).json({ error: 'שם קורס לא תקין' });
      if (description != null && (typeof description !== 'string' || description.length > 1000))
        return res.status(400).json({ error: 'תיאור לא תקין' });
      if (color != null && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)))
        return res.status(400).json({ error: 'צבע לא תקין' });
      if (image_url != null && !isAllowedImageUrl(image_url))
        return res.status(400).json({ error: 'כתובת תמונה לא תקינה — חייבת להיות מ-Cloudinary או Supabase' });
      if (parent_id != null) {
        const { data: parent, error: pe } = await auth.db
          .from('ep_courses').select('id, user_id, is_degree, parent_id')
          .eq('id', parent_id).maybeSingle();
        if (pe) return dbErr(res, `lookup parent_id=${parent_id}`, pe);
        if (!parent) {
          console.warn('[create-course] parent missing', { parent_id, userId: auth.userId });
          return res.status(400).json({ error: 'קורס האב לא נמצא' });
        }
        if (parent.user_id !== auth.userId) {
          console.warn('[create-course] parent wrong owner', { parent_id, userId: auth.userId, ownerId: parent.user_id });
          return res.status(400).json({ error: 'קורס האב לא נמצא' });
        }
      }

      const profile = await getUserProfile(auth.userId, auth.db, req);
      if (profile && !parent_id) {
        // Quota only counts top-level degrees/courses
        const quota = QUOTAS[profile.plan || 'free'];
        const { count, error: ce } = await auth.db.from('ep_courses').select('id', { count: 'exact', head: true }).is('parent_id', null);
        if (ce) return dbErr(res, 'count courses', ce);
        if (quota.courses !== -1 && count >= quota.courses)
          return res.status(403).json({ error: `הגעת למגבלת הקורסים (${quota.courses}). שדרג לחבילה גדולה יותר.` });
      }

      const insertData = { user_id: auth.userId, name, description: description || null, color: color || '#3b82f6', image_url: image_url || null };
      if (parent_id) insertData.parent_id = parent_id;
      if (is_degree) insertData.is_degree = true;
      const { data, error } = await auth.db.from('ep_courses').insert(insertData).select().single();
      if (error) return dbErr(res, 'insert course', error);
      return res.json(data);
    }
    case 'batch-start': {
      // Insert a new batch row at the start of a practice/exam session.
      const { id, courseId, examId, size, examMode, qids } = req.body || {};
      if (typeof id !== 'string' || id.length < 3 || id.length > 80) return res.status(400).json({ error: 'id חסר/לא תקין' });
      const cid = validId(courseId);
      if (!cid) return res.status(400).json({ error: 'courseId לא תקין' });
      const sizeInt = parseInt(size, 10);
      if (!Number.isInteger(sizeInt) || sizeInt <= 0 || sizeInt > 500) return res.status(400).json({ error: 'size לא תקין' });
      if (!Array.isArray(qids) || qids.length === 0 || qids.length > 500) return res.status(400).json({ error: 'qids לא תקין' });
      if (!qids.every(id => Number.isInteger(id) && id > 0)) return res.status(400).json({ error: 'qids חייב להכיל מספרים שלמים חיוביים בלבד' });
      const insert = {
        id, user_id: auth.userId, course_id: cid,
        exam_id: examId ? validId(examId) : null,
        size: sizeInt, exam_mode: !!examMode, qids,
      };
      const { error } = await auth.db.from('ep_batches').insert(insert);
      if (error) return dbErr(res, 'insert batch', error);
      return res.json({ ok: true });
    }
    case 'batch-end': {
      // Update a batch with final results at session end.
      const { id, correct, wrong, selections, correctMap, endedAt } = req.body || {};
      if (typeof id !== 'string' || id.length < 3 || id.length > 80) return res.status(400).json({ error: 'id חסר/לא תקין' });
      const sanitizeMap = (obj) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
        const entries = Object.entries(obj);
        if (entries.length > 500) return null;
        const out = {};
        for (const [k, v] of entries) {
          const qid = parseInt(k, 10);
          const ans = parseInt(v, 10);
          if (qid > 0 && ans >= 1 && ans <= 10) out[String(qid)] = ans;
        }
        return Object.keys(out).length > 0 ? out : null;
      };
      const update = {
        correct: Math.max(0, parseInt(correct, 10) || 0),
        wrong: Math.max(0, parseInt(wrong, 10) || 0),
        selections: sanitizeMap(selections),
        correct_map: sanitizeMap(correctMap),
        ended_at: endedAt || new Date().toISOString(),
      };
      const { error } = await auth.db.from('ep_batches').update(update)
        .eq('id', id).eq('user_id', auth.userId);
      if (error) return dbErr(res, 'update batch', error);
      return res.json({ ok: true });
    }
    case 'list-batches': {
      // Return up to 50 most recent batches for this course, newest first.
      const { data, error } = await auth.db.from('ep_batches')
        .select('*').eq('course_id', m.cid)
        .order('ended_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) return dbErr(res, 'list batches', error);
      return res.json(data || []);
    }
    case 'attempt': {
      const { questionId, courseId, selectedIdx, isCorrect, revealed, timeSeconds, batchId } = req.body || {};
      if (!questionId || !courseId) return res.status(400).json({ error: 'missing fields' });
      const { error } = await auth.db.from('ep_attempts').insert({
        user_id: auth.userId, question_id: questionId, course_id: courseId,
        selected_idx: selectedIdx ?? null, is_correct: !!isCorrect,
        revealed: !!revealed, time_seconds: timeSeconds ?? null, batch_id: batchId ?? null,
      });
      if (error) return dbErr(res, 'insert attempt', error);
      if (!isCorrect || revealed) {
        await auth.db.from('ep_review_queue').upsert({ user_id: auth.userId, question_id: questionId, course_id: courseId });
      } else {
        await auth.db.from('ep_review_queue').delete().eq('question_id', questionId);
      }
      return res.json({ ok: true });
    }
    case 'stats-summary': {
      // DB-authoritative per-course + aggregate stats. Used by the dashboard
      // so the four metric cards stay in sync with Supabase regardless of
      // which device the user logged in from. RLS scopes both reads.
      const [attemptsRes, reviewRes] = await Promise.all([
        auth.db.from('ep_attempts').select('course_id, question_id, is_correct, revealed'),
        auth.db.from('ep_review_queue').select('course_id'),
      ]);
      if (attemptsRes.error) return dbErr(res, 'stats attempts', attemptsRes.error);
      if (reviewRes.error) return dbErr(res, 'stats review', reviewRes.error);

      const perCourse = {}; // cid → { total, seen:Set, correct:Set, reviewCount }
      const get = cid => {
        const k = String(cid);
        if (!perCourse[k]) perCourse[k] = { total: 0, seen: new Set(), correct: new Set(), reviewCount: 0 };
        return perCourse[k];
      };
      for (const r of attemptsRes.data || []) {
        const b = get(r.course_id);
        b.total += 1;
        b.seen.add(r.question_id);
        if (r.is_correct && !r.revealed) b.correct.add(r.question_id);
      }
      for (const r of reviewRes.data || []) get(r.course_id).reviewCount += 1;

      const aggregate = { total: 0, unique: 0, correct: 0, wrong: 0, reviewCount: 0 };
      const aggSeen = new Set(), aggCorrect = new Set();
      const perCourseOut = {};
      for (const [cid, b] of Object.entries(perCourse)) {
        const correct = b.correct.size;
        const unique = b.seen.size;
        perCourseOut[cid] = {
          total: b.total, unique, correct, wrong: unique - correct, reviewCount: b.reviewCount,
        };
        aggregate.total += b.total;
        aggregate.reviewCount += b.reviewCount;
        for (const qid of b.seen) aggSeen.add(`${cid}:${qid}`);
        for (const qid of b.correct) aggCorrect.add(`${cid}:${qid}`);
      }
      aggregate.unique = aggSeen.size;
      aggregate.correct = aggCorrect.size;
      aggregate.wrong = aggregate.unique - aggregate.correct;
      return res.json({ aggregate, perCourse: perCourseOut });
    }
    case 'list-exams': {
      // Auto-purge items deleted more than 3 days ago
      const purgeDate = new Date(Date.now() - 3 * 86400000).toISOString();
      await auth.db.from('ep_exams').delete()
        .eq('course_id', m.cid).not('deleted_at', 'is', null).lt('deleted_at', purgeDate);
      const { data, error } = await auth.db.from('ep_exams').select('*')
        .eq('course_id', m.cid).is('deleted_at', null).order('created_at', { ascending: false });
      if (error) return dbErr(res, 'list exams', error);
      return res.json(data || []);
    }
    case 'list-questions': {
      try {
        // Auto-purge questions deleted more than 3 days ago
        const purgeDate = new Date(Date.now() - 3 * 86400000).toISOString();
        await auth.db.from('ep_questions').delete()
          .eq('course_id', m.cid).not('deleted_at', 'is', null).lt('deleted_at', purgeDate);
        const { data, error } = await auth.db.from('ep_questions')
          .select('*')
          .eq('course_id', m.cid).is('deleted_at', null)
          .order('exam_id', { ascending: true }).order('question_number', { ascending: true });
        if (error) return dbErr(res, 'list-questions', error);
        return res.json(data || []);
      } catch (e) {
        console.error('[list-questions] exception:', e?.message || e);
        return res.status(500).json({ error: 'שגיאה פנימית בשרת. נסה שוב.' });
      }
    }
    case 'list-trash': {
      const cutoff = new Date(Date.now() - 3 * 86400000).toISOString();
      const [examsRes, questionsRes] = await Promise.all([
        auth.db.from('ep_exams').select('id, name, question_count, deleted_at')
          .eq('course_id', m.cid).not('deleted_at', 'is', null).gte('deleted_at', cutoff)
          .order('deleted_at', { ascending: false }),
        auth.db.from('ep_questions').select('id, question_number, exam_id, deleted_at')
          .eq('course_id', m.cid).not('deleted_at', 'is', null).gte('deleted_at', cutoff)
          .order('deleted_at', { ascending: false }),
      ]);
      return res.json({
        exams: examsRes.data || [],
        questions: questionsRes.data || [],
      });
    }
    case 'review-queue': {
      const { data, error } = await auth.db.from('ep_review_queue').select('question_id').eq('course_id', m.cid);
      if (error) return dbErr(res, 'list review queue', error);
      return res.json((data || []).map(r => r.question_id));
    }
    case 'delete-exam': {
      try {
        const { data: exam, error: fe } = await auth.db.from('ep_exams').select('*')
          .eq('id', m.eid).eq('course_id', m.cid).eq('user_id', auth.userId).is('deleted_at', null).maybeSingle();
        if (fe) return dbErr(res, 'fetch exam', fe);
        if (!exam) return res.status(404).json({ error: 'מבחן לא נמצא' });
        // Soft-delete: mark exam and all its questions with deleted_at timestamp
        const now = new Date().toISOString();
        const [{ error: de }, { error: dq }] = await Promise.all([
          auth.db.from('ep_exams').update({ deleted_at: now }).eq('id', m.eid).eq('course_id', m.cid).eq('user_id', auth.userId),
          auth.db.from('ep_questions').update({ deleted_at: now }).eq('exam_id', m.eid).eq('course_id', m.cid).eq('user_id', auth.userId),
        ]);
        if (de) return dbErr(res, 'soft-delete exam', de);
        const [{ count: qc }, { count: pc }] = await Promise.all([
          auth.db.from('ep_questions').select('id', { count: 'exact', head: true }).eq('course_id', m.cid).is('deleted_at', null),
          auth.db.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', m.cid).is('deleted_at', null),
        ]);
        await auth.db.from('ep_courses').update({ total_questions: qc, total_pdfs: pc }).eq('id', m.cid);
        return res.json({ ok: true, deleted_questions: exam.question_count || 0 });
      } catch (err) {
        console.error('[delete exam]', err?.message || err);
        return res.status(500).json({ error: 'שגיאה במחיקת המבחן' });
      }
    }
    case 'restore-exam': {
      try {
        const examId = validId(req.body?.examId);
        if (!examId) return res.status(400).json({ error: 'examId לא תקין' });
        const { error: re } = await auth.db.from('ep_exams')
          .update({ deleted_at: null }).eq('id', examId).eq('course_id', m.cid).eq('user_id', auth.userId);
        if (re) return dbErr(res, 'restore exam', re);
        // Restore its questions too
        await auth.db.from('ep_questions').update({ deleted_at: null }).eq('exam_id', examId).eq('course_id', m.cid).eq('user_id', auth.userId);
        const [{ count: qc }, { count: pc }] = await Promise.all([
          auth.db.from('ep_questions').select('id', { count: 'exact', head: true }).eq('course_id', m.cid).is('deleted_at', null),
          auth.db.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', m.cid).is('deleted_at', null),
        ]);
        await auth.db.from('ep_courses').update({ total_questions: qc, total_pdfs: pc }).eq('id', m.cid);
        return res.json({ ok: true });
      } catch (err) {
        console.error('[restore exam]', err?.message || err);
        return res.status(500).json({ error: 'שגיאה בשחזור המבחן' });
      }
    }
    case 'delete-course': {
      try {
        const { data: course, error: fe } = await auth.db.from('ep_courses')
          .select('id, user_id').eq('id', m.cid).maybeSingle();
        if (fe) return dbErr(res, 'fetch course', fe);
        if (!course || course.user_id !== auth.userId) return res.status(404).json({ error: 'קורס לא נמצא' });
        // Cascade-delete sub-courses first (their exams/questions)
        const { data: subs } = await auth.db.from('ep_courses').select('id').eq('parent_id', m.cid).eq('user_id', auth.userId);
        for (const sub of subs || []) {
          await auth.db.from('ep_exams').delete().eq('course_id', sub.id).eq('user_id', auth.userId);
          await auth.db.from('ep_courses').delete().eq('id', sub.id).eq('user_id', auth.userId);
        }
        // Delete all direct exams
        await auth.db.from('ep_exams').delete().eq('course_id', m.cid).eq('user_id', auth.userId);
        const { error: de } = await auth.db.from('ep_courses').delete().eq('id', m.cid).eq('user_id', auth.userId);
        if (de) return dbErr(res, 'delete course', de);
        return res.json({ ok: true });
      } catch (err) {
        console.error('[delete course]', err?.message || err);
        return res.status(500).json({ error: 'שגיאה במחיקת הקורס' });
      }
    }
    case 'update-course': {
      const { archived, image_url: updImgUrl, name: updName, description: updDesc, color: updColor, is_degree: updIsDegree } = req.body || {};
      const update = {};
      if (typeof archived === 'boolean') update.archived = archived;
      if (updImgUrl !== undefined) {
        if (updImgUrl !== null && !isAllowedImageUrl(updImgUrl))
          return res.status(400).json({ error: 'כתובת תמונה לא תקינה — חייבת להיות מ-Cloudinary או Supabase' });
        update.image_url = updImgUrl || null;
      }
      if (updName !== undefined) {
        if (typeof updName !== 'string' || updName.length < 2 || updName.length > 100)
          return res.status(400).json({ error: 'שם לא תקין' });
        update.name = updName;
      }
      if (updDesc !== undefined) {
        if (updDesc !== null && (typeof updDesc !== 'string' || updDesc.length > 1000))
          return res.status(400).json({ error: 'תיאור לא תקין' });
        update.description = updDesc || null;
      }
      if (updColor !== undefined) {
        if (updColor !== null && (typeof updColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(updColor)))
          return res.status(400).json({ error: 'צבע לא תקין' });
        update.color = updColor || '#3b82f6';
      }
      if (typeof updIsDegree === 'boolean') update.is_degree = updIsDegree;
      if (!Object.keys(update).length) return res.status(400).json({ error: 'אין שדות לעדכון' });
      const { error } = await auth.db.from('ep_courses').update(update).eq('id', m.cid).eq('user_id', auth.userId);
      if (error) return dbErr(res, 'update course', error);
      return res.json({ ok: true });
    }
    case 'delete-question': {
      const now = new Date().toISOString();
      const { error } = await auth.db.from('ep_questions')
        .update({ deleted_at: now }).eq('id', m.qid).eq('course_id', m.cid).eq('user_id', auth.userId).is('deleted_at', null);
      if (error) return dbErr(res, 'delete question', error);
      const { count } = await auth.db.from('ep_questions').select('id', { count: 'exact', head: true })
        .eq('course_id', m.cid).is('deleted_at', null);
      await auth.db.from('ep_courses').update({ total_questions: count }).eq('id', m.cid).eq('user_id', auth.userId);
      return res.json({ ok: true });
    }
    case 'update-question': {
      // Manual override for correct_idx and/or solution_pdf_page.
      // correct_idx: accepts 1..10 (biology/genetics use up to 10 options).
      //   Sets answer_confidence='manual' AND clears cached explanations
      //   (they were written for the OLD answer and would now be misleading).
      // solution_pdf_page: records the page the user navigated to in the
      //   "תקן תשובה" solution viewer, so the next open goes there directly.
      //   Also flips its confidence to 'user_confirmed'.
      const body = req.body || {};
      const update = {};
      const responseExtras = {};

      if (body.correct_idx !== undefined && body.correct_idx !== null) {
        const correctIdx = parseInt(body.correct_idx, 10);
        if (!correctIdx || correctIdx < 1 || correctIdx > 10) {
          return res.status(400).json({ error: 'correct_idx חייב להיות 1-10' });
        }
        update.correct_idx = correctIdx;
        update.answer_confidence = 'manual';
        update.general_explanation = null;
        update.option_explanations = null;
        responseExtras.correct_idx = correctIdx;
        responseExtras.answer_confidence = 'manual';
        responseExtras.explanations_cleared = true;
      }

      if (body.solution_pdf_page !== undefined && body.solution_pdf_page !== null) {
        const solPage = parseInt(body.solution_pdf_page, 10);
        if (!solPage || solPage < 1 || solPage > 500) {
          return res.status(400).json({ error: 'solution_pdf_page לא תקין' });
        }
        update.solution_pdf_page = solPage;
        update.solution_pdf_page_confidence = 'user_confirmed';
        responseExtras.solution_pdf_page = solPage;
      }

      if (!Object.keys(update).length) {
        return res.status(400).json({ error: 'אין שדות לעדכון' });
      }

      let { error } = await auth.db.from('ep_questions')
        .update(update)
        .eq('id', m.qid).eq('course_id', m.cid).eq('user_id', auth.userId).is('deleted_at', null);
      // Retry without new-column fields if the migration hasn't run yet.
      if (error?.message?.includes('column') && error.message.includes('does not exist')) {
        const { solution_pdf_page, solution_pdf_page_confidence, ...stripped } = update;
        if (Object.keys(stripped).length) {
          ({ error } = await auth.db.from('ep_questions')
            .update(stripped)
            .eq('id', m.qid).eq('course_id', m.cid).eq('user_id', auth.userId).is('deleted_at', null));
        } else {
          error = null;
        }
      }
      if (error) return dbErr(res, 'update question', error);
      return res.json({ ok: true, ...responseExtras });
    }
    case 'create-context':
    case 'update-context':
    case 'delete-context':
    case 'list-contexts': {
      return handleContextAction(m, req, res, auth);
    }
    case 'restore-question': {
      try {
        const questionId = validId(req.body?.questionId);
        if (!questionId) return res.status(400).json({ error: 'questionId לא תקין' });
        // Fetch the question first to get its exam_id
        const { data: qRow, error: qFetch } = await auth.db.from('ep_questions')
          .select('id, exam_id').eq('id', questionId).eq('course_id', m.cid).eq('user_id', auth.userId).maybeSingle();
        if (qFetch) return dbErr(res, 'fetch question', qFetch);
        if (!qRow) return res.status(404).json({ error: 'שאלה לא נמצאה' });

        const { error: rq } = await auth.db.from('ep_questions')
          .update({ deleted_at: null }).eq('id', questionId).eq('course_id', m.cid).eq('user_id', auth.userId);
        if (rq) return dbErr(res, 'restore question', rq);

        // If the question belonged to a soft-deleted exam, restore that exam too
        let restoredExam = false;
        if (qRow.exam_id) {
          const { data: parentExam } = await auth.db.from('ep_exams')
            .select('id, deleted_at').eq('id', qRow.exam_id).eq('course_id', m.cid).eq('user_id', auth.userId).maybeSingle();
          if (parentExam?.deleted_at) {
            await auth.db.from('ep_exams').update({ deleted_at: null }).eq('id', qRow.exam_id).eq('course_id', m.cid).eq('user_id', auth.userId);
            // Also restore all other questions of this exam
            await auth.db.from('ep_questions').update({ deleted_at: null }).eq('exam_id', qRow.exam_id).eq('course_id', m.cid).eq('user_id', auth.userId);
            restoredExam = true;
          }
        }

        const [{ count: qc }, { count: pc }] = await Promise.all([
          auth.db.from('ep_questions').select('id', { count: 'exact', head: true }).eq('course_id', m.cid).is('deleted_at', null),
          auth.db.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', m.cid).is('deleted_at', null),
        ]);
        await auth.db.from('ep_courses').update({ total_questions: qc, total_pdfs: pc }).eq('id', m.cid);
        return res.json({ ok: true, restoredExam });
      } catch (err) {
        console.error('[restore question]', err?.message || err);
        return res.status(500).json({ error: 'שגיאה בשחזור השאלה' });
      }
    }
    case 'list-packs': {
      const courseId = parseInt(req.query.courseId, 10) || null;
      let query = auth.db.from('ep_study_packs')
        .select('id, title, source_kind, source_char_count, status, created_at, processed_at, course_id, materials')
        .order('created_at', { ascending: false });
      if (courseId) query = query.eq('course_id', courseId);
      const { data, error } = await query;
      if (error) return dbErr(res, 'list study packs', error);
      return res.json(data || []);
    }
    case 'get-pack': {
      if (!Number.isFinite(m.id)) return res.status(400).json({ error: 'invalid id' });
      const { data, error } = await auth.db.from('ep_study_packs').select('*').eq('id', m.id).maybeSingle();
      if (error) return dbErr(res, 'get study pack', error);
      if (!data) return res.status(404).json({ error: 'not found' });
      return res.json(data);
    }
    case 'delete-pack': {
      if (!Number.isFinite(m.id)) return res.status(400).json({ error: 'invalid id' });
      const { error } = await auth.db.from('ep_study_packs').delete().eq('id', m.id);
      if (error) return dbErr(res, 'delete study pack', error);
      return res.json({ ok: true });
    }
    case 'admin-switch-plan': {
      const profile = await getUserProfile(auth.userId, auth.db, req);
      if (!profile || !profile.is_admin) return res.status(403).json({ error: 'אין הרשאות מנהל' });
      const { plan: newPlan } = req.body || {};
      if (!QUOTAS[newPlan]) return res.status(400).json({ error: `תוכנית לא תקינה` });
      const update = { plan: newPlan, pdfs_uploaded_today: 0, pdfs_uploaded_this_month: 0, ai_questions_used_today: 0, ai_questions_used_this_month: 0, study_packs_used_total: 0, study_packs_used_this_month: 0, daily_reset_at: new Date().toISOString(), monthly_reset_at: new Date().toISOString() };
      if (newPlan === 'trial') { update.plan_expires_at = new Date(Date.now() + 14 * 86400000).toISOString(); update.trial_started_at = new Date().toISOString(); update.trial_used = false; }
      else if (newPlan === 'free') { update.plan_expires_at = null; update.trial_used = true; }
      else { update.plan_expires_at = null; }
      const admin = getAdmin();
      if (!admin) return res.status(500).json({ error: 'Server not configured' });
      const { error } = await admin.from('profiles').update(update).eq('id', auth.userId);
      if (error) return dbErr(res, 'admin switch plan', error);
      return res.json({ ok: true, plan: newPlan, quotas: QUOTAS[newPlan] });
    }
    case 'account-delete': {
      const admin = getAdmin();
      if (!admin) return res.status(500).json({ error: 'Server not configured' });
      // Cascade-delete all user data before removing auth entry
      try {
        await admin.from('ep_questions').delete().eq('user_id', auth.userId);
        await admin.from('ep_exams').delete().eq('user_id', auth.userId);
        await admin.from('ep_courses').delete().eq('user_id', auth.userId);
        await admin.from('ep_ai_cost_log').delete().eq('user_id', auth.userId);
        await admin.from('profiles').delete().eq('id', auth.userId);
      } catch (e) {
        console.warn('[delete account] partial data cleanup error:', e?.message);
      }
      const { error } = await admin.auth.admin.deleteUser(auth.userId);
      if (error) { console.error('[delete account]', error.message); return res.status(500).json({ error: 'שגיאה במחיקת החשבון' }); }
      return res.json({ ok: true });
    }
    case 'ai-similar': {
      return res.status(501).json({ error: 'יצירת שאלות AI עדיין בפיתוח. תחזור בקרוב!' });
    }
    case 'upload-sign': {
      // Return signed Cloudinary direct-upload params so the browser can PUT
      // large PDFs straight to Cloudinary (bypassing Vercel's ~4.5MB body
      // limit). /api/upload later downloads the PDFs back for processing.
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      if (!body || typeof body !== 'object') body = {};
      const courseId = body.courseId;
      if (!courseId) return res.status(400).json({ error: 'חסר courseId' });
      const courseIdInt = parseInt(courseId, 10) || courseId;

      const admin = getAdmin();
      if (!admin) return res.status(500).json({ error: 'שירות לא זמין' });
      const { data: course, error: courseErr } = await admin.from('ep_courses')
        .select('id, user_id').eq('id', courseIdInt).maybeSingle();
      if (courseErr) return dbErr(res, 'upload-sign/course', courseErr);
      if (!course) return res.status(404).json({ error: 'הקורס לא נמצא' });
      if (course.user_id !== auth.userId) return res.status(403).json({ error: 'אין גישה לקורס' });

      const cleanEnv = s => (s || '').replace(/\\n/g, '').replace(/\s+/g, '').trim();
      const cloudName = cleanEnv(process.env.CLOUDINARY_CLOUD_NAME);
      const apiKey = cleanEnv(process.env.CLOUDINARY_API_KEY);
      const apiSecret = cleanEnv(process.env.CLOUDINARY_API_SECRET);
      if (!cloudName || !apiKey || !apiSecret) return res.status(500).json({ error: 'Cloudinary not configured' });

      const sessionId = randomBytes(8).toString('hex');
      const timestamp = String(Math.floor(Date.now() / 1000));
      const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
      const examPublicId = `examprep/${auth.userId}/pending_${sessionId}/exam`;
      const solPublicId  = `examprep/${auth.userId}/pending_${sessionId}/solution`;
      const sign = (pid) => createHash('sha1').update(`public_id=${pid}&timestamp=${timestamp}${apiSecret}`).digest('hex');
      const pack = (pid) => ({ uploadUrl, publicId: pid, apiKey, cloudName, timestamp, signature: sign(pid) });
      return res.json({ sessionId, exam: pack(examPublicId), solution: pack(solPublicId) });
    }
    case 'finalize-review': {
      // Layer 1 — promote ep_exams from 'awaiting_review' → 'ready' once every
      // question has answer_confidence in (confirmed, manual). Refuses with 409
      // + pending_ids when anything is still unknown/uncertain.
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      if (!body || typeof body !== 'object') body = {};
      const examId = parseInt(body.exam_id, 10);
      if (!examId) return res.status(400).json({ error: 'exam_id חסר' });

      const admin = getAdmin();
      if (!admin) return res.status(500).json({ error: 'שירות לא זמין' });

      const { data: exam, error: examErr } = await admin
        .from('ep_exams')
        .select('id, user_id, status')
        .eq('id', examId)
        .maybeSingle();
      if (examErr) return dbErr(res, 'finalize-review/load', examErr);
      if (!exam) return res.status(404).json({ error: 'המבחן לא נמצא' });
      if (exam.user_id !== auth.userId) return res.status(403).json({ error: 'אין הרשאה' });

      if (exam.status === 'ready') return res.json({ ok: true, status: 'ready' });
      if (exam.status !== 'awaiting_review') {
        return res.status(409).json({ error: 'המבחן לא בסקירה', status: exam.status });
      }

      const { data: pending, error: pendErr } = await admin
        .from('ep_questions')
        .select('id, question_number, answer_confidence')
        .eq('exam_id', examId)
        .eq('user_id', auth.userId)
        .is('deleted_at', null)
        .in('answer_confidence', ['unknown', 'uncertain']);
      if (pendErr) return dbErr(res, 'finalize-review/pending', pendErr);
      if (pending && pending.length > 0) {
        return res.status(409).json({
          error: 'עדיין יש שאלות לבדיקה',
          pending_ids: pending.map(p => p.id),
          pending_numbers: pending.map(p => p.question_number),
        });
      }

      const { error: updErr } = await admin
        .from('ep_exams')
        .update({ status: 'ready' })
        .eq('id', examId);
      if (updErr) return dbErr(res, 'finalize-review/update', updErr);

      return res.json({ ok: true, status: 'ready' });
    }
    case 'ai-extract-topics': {
      // Auto-label every un-topic'd question in a course. Triggered from the
      // Insights page so the client can render a topic breakdown across any
      // uploaded exam set (biology, math, CS, …), not just the built-in
      // Java course that ships with pre-tagged topics.
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      if (!body || typeof body !== 'object') body = {};
      const courseId = parseInt(body.courseId, 10);
      if (!courseId) return res.status(400).json({ error: 'courseId חסר' });

      const admin = getAdmin();
      if (!admin) return res.status(500).json({ error: 'שירות לא זמין' });

      const { primaryKey: geminiPaidKey } = getGeminiKeys();
      if (!geminiPaidKey) {
        return res.status(500).json({ error: 'GEMINI_API_KEY_PAID לא מוגדר' });
      }

      // Ownership check. Admins may run it for any user's course (used by
      // internal repair scripts). Non-admins may only run it on their own.
      const { data: course, error: courseErr } = await admin.from('ep_courses')
        .select('id, user_id, name').eq('id', courseId).maybeSingle();
      if (courseErr || !course) return res.status(404).json({ error: 'קורס לא נמצא' });
      if (course.user_id !== auth.userId) {
        const { data: profileAdmin } = await admin.from('profiles').select('is_admin').eq('id', auth.userId).maybeSingle();
        if (!profileAdmin?.is_admin) return res.status(403).json({ error: 'אין הרשאה' });
      }

      const budget = await checkGlobalBudget();
      if (budget?.ok === false) {
        return res.status(503).json({ error: 'השירות עמוס כרגע' });
      }
      const burst = await checkBurst(auth.userId, 'topic_extract', 4);
      if (burst?.allowed === false) {
        return res.status(429).json({
          error: 'יותר מדי בקשות בזמן קצר',
          retry_after_seconds: burst.retry_after_seconds,
        });
      }

      const result = await extractTopicsForCourse({
        admin,
        courseId,
        ownerUserId: course.user_id,
        courseName: course.name,
      });
      if (!result.ok) {
        return res.status(500).json({ error: 'זיהוי הנושאים נכשל', detail: result.error });
      }
      return res.json(result);
    }
    default: return res.status(404).json({ error: 'Not found' });
  }
}
