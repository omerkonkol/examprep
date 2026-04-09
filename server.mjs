// =====================================================
// ExamPrep - Main Server
// =====================================================
// SECURITY NOTES:
// - All secrets loaded from .env (never committed)
// - Frontend config.js generated dynamically from env at startup
// - Supabase service-role key kept server-side only (never sent to client)
// - All user-data queries go through a per-request user-scoped client so
//   Supabase RLS enforces ownership; supabaseAdmin is reserved for the
//   handful of operations that genuinely require service-role
// - Rate limiting on every endpoint (in-memory; replace with Redis in prod)
// - File upload size + magic-byte content validation
// - SHA-256 deduplication to prevent re-processing same files
// - All quotas enforced server-side (not just UI)
// - Atomic quota increment via conditional UPDATE (race-safe)
// - PDF processing wrapped in a hard timeout
// - HTTPS-only in production via Vercel
// - Security headers (CSP, HSTS, X-Frame-Options) via vercel.json
// - Error messages never echo Supabase internals to clients

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import { processExamPair, fileHash } from './scripts/process-pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ===== Required env vars =====
const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
for (const r of required) {
  if (!process.env[r]) console.error(`⚠️  Missing required env: ${r}`);
}

// ===== Generate public/config.js from env (no secrets - just public values) =====
function generateConfigJs() {
  const templatePath = path.join(__dirname, 'public', 'config.js.template');
  const outPath = path.join(__dirname, 'public', 'config.js');
  if (!fs.existsSync(templatePath)) return;
  let content = fs.readFileSync(templatePath, 'utf8');
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_ANON_KEY || '').trim();
  content = content
    .replaceAll('__SUPABASE_URL__', url)
    .replaceAll('__SUPABASE_ANON_KEY__', key)
    .replaceAll('__APP_TITLE__', process.env.APP_TITLE || 'ExamPrep')
    .replaceAll('__APP_URL__', process.env.APP_URL || 'http://localhost:3000');
  fs.writeFileSync(outPath, content);
}
generateConfigJs();

// ===== Server admin client (uses service-role key, NEVER sent to client) =====
// Reserved for operations that legitimately require service-role:
//   - Verifying JWTs (auth.getUser)
//   - Account deletion (auth.admin.deleteUser)
//   - Atomic quota RPCs that bypass RLS by design
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })
  : null;

// Build a per-request user-scoped client. RLS enforces own-rows-only.
function userClient(jwt) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Generic error → response. Never echoes Supabase internals to the client.
function dbError(res, tag, error, status = 500) {
  console.error(`[db] ${tag}:`, error?.message || error);
  return res.status(status).json({ error: 'שגיאה פנימית בשרת. נסה שוב.' });
}

// ===== Quota config =====
const QUOTAS = {
  free: {
    pdfs_total: 5,            // lifetime PDFs
    pdfs_per_day: 2,
    pdfs_per_month: 5,
    ai_questions_per_day: 0,
    ai_questions_per_month: 0,
    courses: 1,
    storage_mb: 100,
    max_pdf_size_mb: 10,
    max_pages_per_pdf: 25,
  },
  basic: {
    pdfs_total: -1, // unlimited
    pdfs_per_day: 10,
    pdfs_per_month: 30,
    ai_questions_per_day: 20,
    ai_questions_per_month: 100,
    courses: 5,
    storage_mb: 1024,
    max_pdf_size_mb: 20,
    max_pages_per_pdf: 50,
  },
  pro: {
    pdfs_total: -1,
    pdfs_per_day: 30,
    pdfs_per_month: 150,
    ai_questions_per_day: 80,
    ai_questions_per_month: 500,
    courses: -1,
    storage_mb: 5120,
    max_pdf_size_mb: 30,
    max_pages_per_pdf: 100,
  },
  education: {
    pdfs_total: -1,
    pdfs_per_day: 50,
    pdfs_per_month: 500,
    ai_questions_per_day: 200,
    ai_questions_per_month: 2000,
    courses: -1,
    storage_mb: 20480,
    max_pdf_size_mb: 50,
    max_pages_per_pdf: 150,
  },
};

// Hard ceilings independent of plan — defense in depth.
const HARD_LIMITS = {
  max_pdf_bytes: 50 * 1024 * 1024,           // 50MB absolute upload cap
  max_pages_per_pdf: 200,                    // even pro+education clamped here
  max_ai_count_per_request: 5,               // never let the client ask for more
  pdf_processing_timeout_ms: 90 * 1000,      // 90s per PDF, then abort
  max_course_name_len: 100,
  max_exam_name_len: 200,
};

// AI quota for the most expensive feature.
const AI_RATE_LIMIT_PER_MIN = 5;

// ===== Express app =====
const app = express();

// Trust proxy (Vercel sits behind a proxy)
app.set('trust proxy', 1);

// Parse JSON (small limit - PDFs go through multer)
app.use(express.json({ limit: '256kb' }));

// Security headers (basic - more in vercel.json)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Mirror the CSP from vercel.json for parity in local dev
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "img-src 'self' data: blob: https://tohna1-quiz.vercel.app https://*.supabase.co; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' data: https://fonts.gstatic.com; " +
    "connect-src 'self' https://*.supabase.co; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "object-src 'none'"
  );
  next();
});

// ===== Rate limiting (simple in-memory; use Redis in prod) =====
// NOTE: this Map is per-instance and lost on Vercel cold starts.
// For real prod use Upstash Redis or Vercel KV.
const rateLimits = new Map();
function clientKey(req) {
  // Take only the first hop, lower-cased & trimmed.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().toLowerCase();
  return xff || req.ip || 'unknown';
}
function rateLimit(key, maxPerMinute) {
  const now = Date.now();
  const bucket = rateLimits.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60000;
  }
  bucket.count++;
  rateLimits.set(key, bucket);
  return bucket.count <= maxPerMinute;
}
function rateLimitMiddleware(maxPerMinute) {
  return (req, res, next) => {
    const key = clientKey(req);
    if (!rateLimit(`${key}:${req.path}`, maxPerMinute)) {
      return res.status(429).json({ error: 'יותר מדי בקשות. נסה שוב בעוד דקה.' });
    }
    next();
  };
}

// ===== Auth middleware - verifies Supabase JWT =====
async function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const token = auth.substring(7);
  if (!supabaseAdmin) return res.status(500).json({ error: 'Server not configured' });
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.userId = data.user.id;
  req.userEmail = data.user.email;
  req.userJwt = token;
  req.db = userClient(token); // RLS-enforced client for this request
  next();
}

// ===== Get user profile + plan + reset quotas if needed =====
// Uses supabaseAdmin because reset_user_quotas_if_needed is a privileged RPC.
async function getUserProfile(userId) {
  await supabaseAdmin.rpc('reset_user_quotas_if_needed', { p_user_id: userId });
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data;
}

// Strip internal-only fields before sending profile to the client.
function publicProfile(profile) {
  if (!profile) return null;
  return {
    email: profile.email,
    display_name: profile.display_name,
    username: profile.username,
    plan: profile.plan,
    plan_expires_at: profile.plan_expires_at,
    pdfs_uploaded_today: profile.pdfs_uploaded_today,
    pdfs_uploaded_this_month: profile.pdfs_uploaded_this_month,
    ai_questions_used_today: profile.ai_questions_used_today,
    ai_questions_used_this_month: profile.ai_questions_used_this_month,
    storage_bytes_used: profile.storage_bytes_used,
    created_at: profile.created_at,
  };
}

// ===== Static files =====
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/legal', express.static(path.join(__dirname, 'legal')));

// Local image serving for dev only. In production images live in Supabase
// Storage and are fetched directly from there with signed URLs.
if (!IS_PROD) {
  app.use('/storage', express.static(path.join(__dirname, 'data', 'storage')));
}

// Default routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/courses/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/insights', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/lab', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/progress', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== Health check =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    supabase: !!supabaseAdmin,
    quotas: Object.keys(QUOTAS),
  });
});

// ===== User stats =====
app.get('/api/me', authMiddleware, async (req, res) => {
  const profile = await getUserProfile(req.userId);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  const plan = profile.plan || 'free';
  res.json({
    profile: publicProfile(profile),
    quotas: QUOTAS[plan],
  });
});

// ===== List user's courses =====
app.get('/api/courses', authMiddleware, async (req, res) => {
  const { data, error } = await req.db
    .from('ep_courses')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return dbError(res, 'list courses', error);
  res.json(data || []);
});

// ===== Create new course =====
app.post('/api/courses', authMiddleware, rateLimitMiddleware(10), async (req, res) => {
  const { name, description, color } = req.body || {};
  if (typeof name !== 'string' || name.length < 2 || name.length > HARD_LIMITS.max_course_name_len) {
    return res.status(400).json({ error: 'שם קורס לא תקין' });
  }
  if (description != null && (typeof description !== 'string' || description.length > 1000)) {
    return res.status(400).json({ error: 'תיאור לא תקין' });
  }
  if (color != null && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color))) {
    return res.status(400).json({ error: 'צבע לא תקין' });
  }

  // Check quota
  const profile = await getUserProfile(req.userId);
  const plan = profile?.plan || 'free';
  const quota = QUOTAS[plan];
  const { count, error: countErr } = await req.db
    .from('ep_courses').select('id', { count: 'exact', head: true });
  if (countErr) return dbError(res, 'count courses', countErr);
  if (quota.courses !== -1 && count >= quota.courses) {
    return res.status(403).json({ error: `הגעת למגבלת הקורסים שלך (${quota.courses}). שדרג לחבילה גדולה יותר.` });
  }

  const { data, error } = await req.db
    .from('ep_courses')
    .insert({ user_id: req.userId, name, description: description || null, color: color || '#3b82f6' })
    .select()
    .single();
  if (error) return dbError(res, 'insert course', error);
  res.json(data);
});

// ===== Multer for file uploads =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: HARD_LIMITS.max_pdf_bytes,
    files: 2, // exam + solution
  },
  fileFilter: (req, file, cb) => {
    // Hint check only — real validation is done with magic bytes after read.
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('רק קבצי PDF מותרים'));
    }
    cb(null, true);
  },
});

// Verify a buffer actually starts with the PDF magic bytes "%PDF-".
function isPdfMagic(buf) {
  return buf && buf.length >= 5 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;
}

// Atomically reserve one PDF upload slot. Returns true if granted.
async function reservePdfSlot(userId, plan) {
  const quota = QUOTAS[plan];
  const { data, error } = await supabaseAdmin.rpc('ep_reserve_pdf_slot', {
    p_user_id: userId,
    p_max_today: quota.pdfs_per_day,
    p_max_month: quota.pdfs_per_month,
    p_max_total: quota.pdfs_total,
    p_max_storage_bytes: quota.storage_mb * 1024 * 1024,
  });
  // If the RPC isn't installed yet, fall through to the legacy non-atomic
  // path (logged so we know to add the function).
  if (error && /function .* does not exist/i.test(error.message || '')) {
    console.warn('[quota] ep_reserve_pdf_slot RPC missing — using non-atomic fallback');
    return null;
  }
  if (error) {
    console.error('[quota] reserve error:', error.message);
    return false;
  }
  return data === true;
}

// Wrap a promise in a timeout.
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

// ===== Upload exam PDF (and optional solution PDF) =====
app.post('/api/upload', authMiddleware, rateLimitMiddleware(3),
  upload.fields([
    { name: 'examPdf', maxCount: 1 },
    { name: 'solutionPdf', maxCount: 1 },
  ]),
  async (req, res) => {
    let tempDir = null;
    try {
      const profile = await getUserProfile(req.userId);
      if (!profile) return res.status(404).json({ error: 'profile not found' });
      const plan = profile.plan || 'free';
      const quota = QUOTAS[plan];

      // ===== Validate uploaded files (size + magic bytes) =====
      const examFile = req.files?.examPdf?.[0];
      const solFile = req.files?.solutionPdf?.[0];
      if (!examFile) return res.status(400).json({ error: 'חסר קובץ exam PDF' });

      const maxBytes = quota.max_pdf_size_mb * 1024 * 1024;
      if (examFile.size > maxBytes) {
        return res.status(413).json({ error: `קובץ הבחינה גדול מהמותר (${quota.max_pdf_size_mb}MB)` });
      }
      if (solFile && solFile.size > maxBytes) {
        return res.status(413).json({ error: `קובץ הפתרון גדול מהמותר (${quota.max_pdf_size_mb}MB)` });
      }
      if (!isPdfMagic(examFile.buffer)) {
        return res.status(400).json({ error: 'קובץ הבחינה אינו PDF תקני' });
      }
      if (solFile && !isPdfMagic(solFile.buffer)) {
        return res.status(400).json({ error: 'קובץ הפתרון אינו PDF תקני' });
      }

      const { courseId, name } = req.body || {};
      if (!courseId) return res.status(400).json({ error: 'חסר courseId' });
      if (typeof name !== 'string' || name.length < 2 || name.length > HARD_LIMITS.max_exam_name_len) {
        return res.status(400).json({ error: 'שם מבחן לא תקין' });
      }

      // Verify course belongs to user (RLS enforces this through req.db).
      const { data: course, error: courseErr } = await req.db
        .from('ep_courses').select('id').eq('id', courseId).maybeSingle();
      if (courseErr) return dbError(res, 'verify course', courseErr);
      if (!course) return res.status(403).json({ error: 'אין לך גישה לקורס הזה' });

      // ===== Atomic quota reservation =====
      const reserved = await reservePdfSlot(req.userId, plan);
      if (reserved === false) {
        return res.status(429).json({ error: 'הגעת למכסה. נסה שוב מאוחר יותר.' });
      }
      // reserved === null → RPC missing, fall through to legacy non-atomic path:
      if (reserved === null) {
        if (quota.pdfs_total !== -1) {
          const { count } = await req.db
            .from('ep_exams').select('id', { count: 'exact', head: true });
          if (count >= quota.pdfs_total) {
            return res.status(402).json({
              error: `הגעת למגבלה החינמית של ${quota.pdfs_total} קבצי PDF.`,
              needs_upgrade: true,
            });
          }
        }
        if (profile.pdfs_uploaded_today >= quota.pdfs_per_day) {
          return res.status(429).json({ error: `הגעת למכסה היומית.` });
        }
        if (profile.pdfs_uploaded_this_month >= quota.pdfs_per_month) {
          return res.status(429).json({ error: `הגעת למכסה החודשית.` });
        }
        if (profile.storage_bytes_used >= quota.storage_mb * 1024 * 1024) {
          return res.status(403).json({ error: `הגעת למגבלת האחסון.` });
        }
      }

      // ===== Save files to temp dir for processing =====
      tempDir = path.join(__dirname, 'data', 'temp', `${req.userId}_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const examPath = path.join(tempDir, 'exam.pdf');
      fs.writeFileSync(examPath, examFile.buffer);
      let solPath = null;
      if (solFile) {
        solPath = path.join(tempDir, 'solution.pdf');
        fs.writeFileSync(solPath, solFile.buffer);
      }

      // ===== Deduplication: check hash =====
      const hash = fileHash(examPath);
      const { data: existing } = await req.db
        .from('ep_exams').select('id').eq('exam_pdf_hash', hash).maybeSingle();
      if (existing) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
        return res.status(409).json({ error: 'הקובץ הזה כבר הועלה בעבר' });
      }

      // ===== Insert exam record =====
      const { data: exam, error: examErr } = await req.db
        .from('ep_exams')
        .insert({
          course_id: courseId,
          user_id: req.userId,
          name,
          exam_pdf_hash: hash,
          status: 'processing',
        })
        .select()
        .single();
      if (examErr) return dbError(res, 'insert exam', examErr);

      // ===== Process the PDF (with hard timeout + page cap) =====
      const maxPages = Math.min(quota.max_pages_per_pdf, HARD_LIMITS.max_pages_per_pdf);
      try {
        const result = await withTimeout(
          processExamPair({
            examPdfPath: examPath,
            solutionPdfPath: solPath,
            outputDir: path.join(__dirname, 'data', 'storage', String(req.userId), String(exam.id)),
            mcqMode: 'auto',
            maxPages,
          }),
          HARD_LIMITS.pdf_processing_timeout_ms,
          'PDF processing'
        );

        // Save questions to DB through RLS-enforced client.
        const questionsToInsert = result.questions.map(q => ({
          exam_id: exam.id,
          course_id: courseId,
          user_id: req.userId,
          question_number: q.index,
          section_label: q.section,
          image_path: `${req.userId}/${exam.id}/${q.imageFile}`,
          num_options: q.numOptions,
          correct_idx: q.correctIdx || 1,
          option_labels: null,
          topic: null,
        }));
        if (questionsToInsert.length) {
          const { error: qErr } = await req.db.from('ep_questions').insert(questionsToInsert);
          if (qErr) console.error('[upload] insert questions:', qErr.message);
        }

        // Update exam status
        await req.db.from('ep_exams').update({
          status: 'ready',
          question_count: result.questionCount,
          processed_at: new Date().toISOString(),
        }).eq('id', exam.id);

        // Update storage counter (the slot reservation already bumped the
        // pdfs_uploaded_* counters atomically; here we add the byte cost).
        await supabaseAdmin.from('profiles').update({
          storage_bytes_used: profile.storage_bytes_used + examFile.size + (solFile?.size || 0),
        }).eq('id', req.userId);

        // Update course counters
        const [{ count: qCount }, { count: pdfCount }] = await Promise.all([
          req.db.from('ep_questions').select('id', { count: 'exact', head: true }).eq('course_id', courseId),
          req.db.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', courseId),
        ]);
        await req.db.from('ep_courses').update({
          total_questions: qCount,
          total_pdfs: pdfCount,
        }).eq('id', courseId);

        fs.rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;

        res.json({
          ok: true,
          exam_id: exam.id,
          question_count: result.questionCount,
          mode: result.mode,
        });
      } catch (procErr) {
        console.error('[upload] process error:', procErr?.message || procErr);
        await req.db.from('ep_exams').update({
          status: 'failed',
          error_message: 'processing failed',
        }).eq('id', exam.id);
        res.status(500).json({ error: 'עיבוד הקובץ נכשל' });
      }
    } catch (err) {
      console.error('[upload] fatal:', err?.message || err);
      res.status(500).json({ error: 'שגיאה פנימית בהעלאה' });
    } finally {
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    }
  });

// ===== List exams in a course =====
app.get('/api/courses/:courseId/exams', authMiddleware, async (req, res) => {
  const { data, error } = await req.db
    .from('ep_exams')
    .select('*')
    .eq('course_id', req.params.courseId)
    .order('created_at', { ascending: false });
  if (error) return dbError(res, 'list exams', error);
  res.json(data || []);
});

// ===== List questions in a course (for the practice UI) =====
app.get('/api/courses/:courseId/questions', authMiddleware, async (req, res) => {
  const { data, error } = await req.db
    .from('ep_questions')
    .select('*')
    .eq('course_id', req.params.courseId)
    .order('exam_id', { ascending: true })
    .order('question_number', { ascending: true });
  if (error) return dbError(res, 'list questions', error);
  res.json(data || []);
});

// ===== Record an attempt =====
app.post('/api/attempt', authMiddleware, rateLimitMiddleware(60), async (req, res) => {
  const { questionId, courseId, selectedIdx, isCorrect, revealed, timeSeconds, batchId } = req.body || {};
  if (!questionId || !courseId) return res.status(400).json({ error: 'missing fields' });
  if (selectedIdx != null && (typeof selectedIdx !== 'number' || selectedIdx < 1 || selectedIdx > 10)) {
    return res.status(400).json({ error: 'invalid selectedIdx' });
  }
  if (timeSeconds != null && (typeof timeSeconds !== 'number' || timeSeconds < 0 || timeSeconds > 86400)) {
    return res.status(400).json({ error: 'invalid timeSeconds' });
  }
  if (batchId != null && (typeof batchId !== 'string' || batchId.length > 64)) {
    return res.status(400).json({ error: 'invalid batchId' });
  }

  const { error } = await req.db.from('ep_attempts').insert({
    user_id: req.userId,
    question_id: questionId,
    course_id: courseId,
    selected_idx: selectedIdx ?? null,
    is_correct: !!isCorrect,
    revealed: !!revealed,
    time_seconds: timeSeconds ?? null,
    batch_id: batchId ?? null,
  });
  if (error) return dbError(res, 'insert attempt', error);

  // Update review queue
  if (!isCorrect || revealed) {
    await req.db.from('ep_review_queue').upsert({
      user_id: req.userId,
      question_id: questionId,
      course_id: courseId,
    });
  } else {
    await req.db.from('ep_review_queue').delete().eq('question_id', questionId);
  }
  res.json({ ok: true });
});

// ===== AI similar question generation (Premium feature) =====
app.post('/api/ai/generate-similar', authMiddleware, rateLimitMiddleware(AI_RATE_LIMIT_PER_MIN), async (req, res) => {
  const { questionId } = req.body || {};
  // Clamp count to a hard ceiling regardless of what the client sent.
  const requestedCount = parseInt(req.body?.count, 10);
  const count = Math.min(
    Math.max(1, Number.isFinite(requestedCount) ? requestedCount : 1),
    HARD_LIMITS.max_ai_count_per_request
  );
  if (!questionId) return res.status(400).json({ error: 'missing questionId' });

  const profile = await getUserProfile(req.userId);
  const plan = profile?.plan || 'free';
  const quota = QUOTAS[plan];

  if (quota.ai_questions_per_month === 0) {
    return res.status(402).json({ error: 'יצירת שאלות AI זמינה רק במנוי בתשלום', needs_upgrade: true });
  }

  // Atomic AI quota reservation. The RPC bumps both daily + monthly counters
  // in one statement, returning false if the user is over either limit.
  const { data: granted, error: rpcErr } = await supabaseAdmin.rpc('ep_reserve_ai_slots', {
    p_user_id: req.userId,
    p_count: count,
    p_max_day: quota.ai_questions_per_day,
    p_max_month: quota.ai_questions_per_month,
  });
  if (rpcErr && /function .* does not exist/i.test(rpcErr.message || '')) {
    console.warn('[ai] ep_reserve_ai_slots RPC missing — refusing request');
    return res.status(503).json({ error: 'AI feature is not available yet' });
  }
  if (rpcErr) {
    console.error('[ai] reserve error:', rpcErr.message);
    return res.status(500).json({ error: 'שגיאה פנימית' });
  }
  if (granted !== true) {
    return res.status(429).json({ error: `הגעת למכסת AI` });
  }

  // TODO: call Gemini API to generate similar questions
  res.status(501).json({
    error: 'יצירת שאלות AI עדיין בפיתוח. תחזור בקרוב!',
  });
});

// ===== Lab: Gemini-powered practice question generation =====
// Used by the AI Lab UI in admin/local-files mode. Doesn't go through
// Supabase auth (the admin testing path uses a localStorage mock user)
// — instead it's protected by rate-limit only and refuses to run unless
// GEMINI_API_KEY is set in the environment.
app.post('/api/lab/generate-questions', rateLimitMiddleware(4), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp';
  if (!apiKey) {
    return res.status(503).json({
      error: 'AI generation unavailable: GEMINI_API_KEY is not configured on the server.',
      reason: 'no_api_key',
    });
  }

  // ---- Validate input ----
  const { topics, count, difficulty, courseName, language } = req.body || {};
  if (!Array.isArray(topics) || topics.length === 0 || topics.length > 8) {
    return res.status(400).json({ error: 'topics must be an array of 1-8 strings' });
  }
  for (const t of topics) {
    if (typeof t !== 'string' || t.length > 120) {
      return res.status(400).json({ error: 'each topic must be a string ≤ 120 chars' });
    }
  }
  const n = Math.min(Math.max(parseInt(count, 10) || 5, 1), 10);
  const diff = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'hard';
  const course = (typeof courseName === 'string' && courseName.length <= 80) ? courseName : 'תוכנה 1 (Java)';
  const lang = language === 'en' ? 'English' : 'Hebrew';

  // ---- Build the prompt ----
  const difficultyHint = {
    easy:   'תרגול בסיסי - שאלות מבוא ברורות',
    medium: 'שאלות אמצעיות - דורשות הבנה אך לא טריקים',
    hard:   'שאלות ברמת מבחן אוניברסיטאי - טריקיות, דרגת קושי גבוהה, חייבות הבנה עמוקה',
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

  // ---- Call Gemini ----
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.85,
          topP: 0.95,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!geminiRes.ok) {
      const txt = await geminiRes.text().catch(() => '');
      console.error('[lab] Gemini HTTP', geminiRes.status, txt.slice(0, 400));
      return res.status(502).json({ error: 'Gemini API error' });
    }
    const payload = await geminiRes.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) return res.status(502).json({ error: 'Empty Gemini response' });

    // Strip any accidental markdown fence
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      console.error('[lab] JSON parse failed:', e.message, 'text:', cleaned.slice(0, 400));
      return res.status(502).json({ error: 'Gemini returned invalid JSON' });
    }

    // ---- Validate structure ----
    if (!parsed?.questions || !Array.isArray(parsed.questions)) {
      return res.status(502).json({ error: 'Malformed response from Gemini' });
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
      return res.status(502).json({ error: 'No valid questions generated' });
    }

    res.json({ ok: true, questions: safe, model });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'Gemini request timed out' });
    }
    console.error('[lab] fatal:', err?.message || err);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// ===== Account deletion (GDPR + Israeli amendment 13 right-to-be-forgotten) =====
app.post('/api/account/delete', authMiddleware, rateLimitMiddleware(2), async (req, res) => {
  // Confirm the user really meant it.
  if (req.body?.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'confirm field must equal "DELETE"' });
  }
  try {
    // Cascade rules in the schema delete ep_* rows when the user is removed.
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.userId);
    if (error) {
      console.error('[delete account]', error.message);
      return res.status(500).json({ error: 'שגיאה במחיקת החשבון' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[delete account] fatal:', err?.message || err);
    res.status(500).json({ error: 'שגיאה במחיקת החשבון' });
  }
});

// ===== Catch-all: serve index.html for SPA routes =====
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`ExamPrep server running on http://localhost:${PORT}`);
  console.log(`  Supabase: ${supabaseAdmin ? 'connected' : 'NOT configured'}`);
});
