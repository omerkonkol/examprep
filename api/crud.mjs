// =====================================================
// Vercel Serverless Catch-All — authenticated CRUD routes
// =====================================================
import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 15 };

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

const QUOTAS = {
  trial: { pdfs_total: -1, pdfs_per_day: 5, pdfs_per_month: 20, ai_questions_per_day: 5, ai_questions_per_month: 15, study_packs_total: 5, study_packs_per_month: 5, courses: 2, storage_mb: 200, max_pdf_size_mb: 15, max_pages_per_pdf: 30 },
  free: { pdfs_total: 0, pdfs_per_day: 0, pdfs_per_month: 0, ai_questions_per_day: 0, ai_questions_per_month: 0, study_packs_total: 0, study_packs_per_month: 0, courses: 0, storage_mb: 50, max_pdf_size_mb: 10, max_pages_per_pdf: 25 },
  basic: { pdfs_total: -1, pdfs_per_day: 10, pdfs_per_month: 30, ai_questions_per_day: 20, ai_questions_per_month: 100, study_packs_total: -1, study_packs_per_month: 30, courses: 5, storage_mb: 1024, max_pdf_size_mb: 20, max_pages_per_pdf: 50 },
  pro: { pdfs_total: -1, pdfs_per_day: 30, pdfs_per_month: 150, ai_questions_per_day: 80, ai_questions_per_month: 500, study_packs_total: -1, study_packs_per_month: 150, courses: -1, storage_mb: 5120, max_pdf_size_mb: 30, max_pages_per_pdf: 100 },
  education: { pdfs_total: -1, pdfs_per_day: 50, pdfs_per_month: 500, ai_questions_per_day: 200, ai_questions_per_month: 2000, study_packs_total: -1, study_packs_per_month: -1, courses: -1, storage_mb: 20480, max_pdf_size_mb: 50, max_pages_per_pdf: 150 },
};

async function getUserProfile(userId, userDb) {
  const admin = getAdmin();
  if (admin) {
    try { await admin.rpc('reset_user_quotas_if_needed', { p_user_id: userId }); } catch {}
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
    plan: p.plan, plan_expires_at: p.plan_expires_at,
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
  if (method === 'GET'  && p === '/study/packs') return { r: 'list-packs' };
  if (method === 'POST' && p === '/admin/switch-plan') return { r: 'admin-switch-plan' };
  if (method === 'POST' && p === '/account/delete') return { r: 'account-delete' };
  if (method === 'POST' && p === '/ai/generate-similar') return { r: 'ai-similar' };

  if (s[0] === 'courses' && s.length >= 2) {
    const cid = parseInt(s[1], 10) || s[1]; // integer for DB, fallback to string for safety
    if (s.length === 2 && method === 'DELETE') return { r: 'delete-course', cid };
    if (s.length === 2 && method === 'PATCH') return { r: 'update-course', cid };
    if (s.length === 3 && s[2] === 'exams' && method === 'GET') return { r: 'list-exams', cid };
    if (s.length === 3 && s[2] === 'questions' && method === 'GET') return { r: 'list-questions', cid };
    if (s.length === 3 && s[2] === 'review-queue' && method === 'GET') return { r: 'review-queue', cid };
    if (s.length === 4 && s[2] === 'exams' && method === 'DELETE') return { r: 'delete-exam', cid, eid: parseInt(s[3], 10) || s[3] };
    if (s.length === 4 && s[2] === 'questions' && method === 'DELETE') return { r: 'delete-question', cid, qid: parseInt(s[3], 10) || s[3] };
  }

  if (s[0] === 'study' && s[1] === 'packs' && s.length === 3) {
    const id = parseInt(s[2], 10);
    if (method === 'GET') return { r: 'get-pack', id };
    if (method === 'DELETE') return { r: 'delete-pack', id };
  }

  return null;
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
          storageStatus = error ? `create failed: ${error.message}` : 'bucket created';
        } else {
          storageStatus = 'bucket exists';
        }
      } catch (e) { storageStatus = `error: ${e.message}`; }
    }
    return res.json({ status: 'ok', supabase: !!admin, storage: storageStatus, quotas: Object.keys(QUOTAS) });
  }

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  switch (m.r) {
    case 'me': {
      const profile = await getUserProfile(auth.userId, auth.db);
      if (!profile) return res.status(404).json({ error: 'profile not found' });
      return res.json({ profile: publicProfile(profile), quotas: QUOTAS[profile.plan || 'free'] });
    }
    case 'list-courses': {
      const { data, error } = await auth.db.from('ep_courses').select('*').order('created_at', { ascending: false });
      if (error) return dbErr(res, 'list courses', error);
      return res.json(data || []);
    }
    case 'create-course': {
      const { name, description, color } = req.body || {};
      if (typeof name !== 'string' || name.length < 2 || name.length > 100)
        return res.status(400).json({ error: 'שם קורס לא תקין' });
      if (description != null && (typeof description !== 'string' || description.length > 1000))
        return res.status(400).json({ error: 'תיאור לא תקין' });
      if (color != null && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)))
        return res.status(400).json({ error: 'צבע לא תקין' });

      const profile = await getUserProfile(auth.userId, auth.db);
      if (profile) {
        const quota = QUOTAS[profile.plan || 'free'];
        const { count, error: ce } = await auth.db.from('ep_courses').select('id', { count: 'exact', head: true });
        if (ce) return dbErr(res, 'count courses', ce);
        if (quota.courses !== -1 && count >= quota.courses)
          return res.status(403).json({ error: `הגעת למגבלת הקורסים (${quota.courses}). שדרג לחבילה גדולה יותר.` });
      }

      const { data, error } = await auth.db.from('ep_courses')
        .insert({ user_id: auth.userId, name, description: description || null, color: color || '#3b82f6' })
        .select().single();
      if (error) return dbErr(res, 'insert course', error);
      return res.json(data);
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
    case 'list-exams': {
      const { data, error } = await auth.db.from('ep_exams').select('*')
        .eq('course_id', m.cid).order('created_at', { ascending: false });
      if (error) return dbErr(res, 'list exams', error);
      return res.json(data || []);
    }
    case 'list-questions': {
      try {
        const { data, error } = await auth.db.from('ep_questions')
          .select('id, exam_id, course_id, user_id, question_number, section_label, image_path, num_options, correct_idx, option_labels, general_explanation, topic, created_at')
          .eq('course_id', m.cid)
          .order('exam_id', { ascending: true }).order('question_number', { ascending: true });
        if (error) return dbErr(res, 'list-questions', error);
        return res.json(data || []);
      } catch (e) {
        console.error('[list-questions] exception:', e?.message || e);
        return res.status(500).json({ error: 'שגיאה פנימית בשרת. נסה שוב.' });
      }
    }
    case 'review-queue': {
      const { data, error } = await auth.db.from('ep_review_queue').select('question_id').eq('course_id', m.cid);
      if (error) return dbErr(res, 'list review queue', error);
      return res.json((data || []).map(r => r.question_id));
    }
    case 'delete-exam': {
      try {
        const { data: exam, error: fe } = await auth.db.from('ep_exams').select('*')
          .eq('id', m.eid).eq('course_id', m.cid).maybeSingle();
        if (fe) return dbErr(res, 'fetch exam', fe);
        if (!exam) return res.status(404).json({ error: 'מבחן לא נמצא' });
        // Allow deleting exams in any status (including stuck 'processing')
        const { error: de } = await auth.db.from('ep_exams').delete().eq('id', m.eid).eq('course_id', m.cid);
        if (de) return dbErr(res, 'delete exam', de);
        const [{ count: qc }, { count: pc }] = await Promise.all([
          auth.db.from('ep_questions').select('id', { count: 'exact', head: true }).eq('course_id', m.cid),
          auth.db.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', m.cid),
        ]);
        await auth.db.from('ep_courses').update({ total_questions: qc, total_pdfs: pc }).eq('id', m.cid);
        return res.json({ ok: true, deleted_questions: exam.question_count || 0 });
      } catch (err) {
        console.error('[delete exam]', err?.message || err);
        return res.status(500).json({ error: 'שגיאה במחיקת המבחן' });
      }
    }
    case 'delete-course': {
      try {
        const { data: course, error: fe } = await auth.db.from('ep_courses').select('id').eq('id', m.cid).maybeSingle();
        if (fe) return dbErr(res, 'fetch course', fe);
        if (!course) return res.status(404).json({ error: 'קורס לא נמצא' });
        // Delete all exams (CASCADE deletes questions, attempts, review_queue)
        await auth.db.from('ep_exams').delete().eq('course_id', m.cid);
        const { error: de } = await auth.db.from('ep_courses').delete().eq('id', m.cid);
        if (de) return dbErr(res, 'delete course', de);
        return res.json({ ok: true });
      } catch (err) {
        console.error('[delete course]', err?.message || err);
        return res.status(500).json({ error: 'שגיאה במחיקת הקורס' });
      }
    }
    case 'update-course': {
      const { archived } = req.body || {};
      const update = {};
      if (typeof archived === 'boolean') update.archived = archived;
      if (!Object.keys(update).length) return res.status(400).json({ error: 'אין שדות לעדכון' });
      const { error } = await auth.db.from('ep_courses').update(update).eq('id', m.cid);
      if (error) return dbErr(res, 'update course', error);
      return res.json({ ok: true });
    }
    case 'delete-question': {
      const { error } = await auth.db.from('ep_questions')
        .delete().eq('id', m.qid).eq('course_id', m.cid);
      if (error) return dbErr(res, 'delete question', error);
      const { count } = await auth.db.from('ep_questions').select('id', { count: 'exact', head: true })
        .eq('course_id', m.cid);
      await auth.db.from('ep_courses').update({ total_questions: count }).eq('id', m.cid);
      return res.json({ ok: true });
    }
    case 'list-packs': {
      const { data, error } = await auth.db.from('ep_study_packs')
        .select('id, title, source_kind, source_char_count, status, created_at, processed_at')
        .order('created_at', { ascending: false });
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
      const profile = await getUserProfile(auth.userId, auth.db);
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
      if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'confirm field must equal "DELETE"' });
      const admin = getAdmin();
      if (!admin) return res.status(500).json({ error: 'Server not configured' });
      const { error } = await admin.auth.admin.deleteUser(auth.userId);
      if (error) { console.error('[delete account]', error.message); return res.status(500).json({ error: 'שגיאה במחיקת החשבון' }); }
      return res.json({ ok: true });
    }
    case 'ai-similar': {
      return res.status(501).json({ error: 'יצירת שאלות AI עדיין בפיתוח. תחזור בקרוב!' });
    }
    default: return res.status(404).json({ error: 'Not found' });
  }
}
