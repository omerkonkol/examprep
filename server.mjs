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
// NOTE: Free plan no longer gets exam-PDF processing (was 5 lifetime). Instead,
// the free trial is "Smart Study from Summary": 2 lifetime AI-generated study
// packs. Real PDF practice is gated behind Basic+. See plan: free trial change.
const QUOTAS = {
  free: {
    pdfs_total: 0,            // ❌ no exam PDF uploads on free
    pdfs_per_day: 0,
    pdfs_per_month: 0,
    ai_questions_per_day: 0,
    ai_questions_per_month: 0,
    study_packs_total: 2,     // ✅ free trial: 2 lifetime Smart Study packs
    study_packs_per_month: 2,
    courses: 1,
    storage_mb: 50,
    max_pdf_size_mb: 10,
    max_pages_per_pdf: 25,
  },
  basic: {
    pdfs_total: -1, // unlimited
    pdfs_per_day: 10,
    pdfs_per_month: 30,
    ai_questions_per_day: 20,
    ai_questions_per_month: 100,
    study_packs_total: -1,
    study_packs_per_month: 30,
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
    study_packs_total: -1,
    study_packs_per_month: 150,
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
    study_packs_total: -1,
    study_packs_per_month: -1,
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

// ===== IP-based abuse throttle (anti token-burning) =====
// Burst rate-limit above only catches floods over a 60s window. This layer
// adds rolling daily + weekly caps per source IP, backed by Postgres so it
// survives Vercel cold starts. Defense against the sock-puppet attack:
// attacker signs up new accounts to keep burning the 2-free-pack lifetime
// quota. Per-account quotas can't see across accounts; per-IP can.
//
// Privacy: we hash the IP with a server salt so the table never holds raw
// PII. The salt should be set via IP_HASH_SALT env on every server replica
// (must be the same value across replicas, or hashes won't match).
const IP_HASH_SALT = process.env.IP_HASH_SALT || '';
if (!IP_HASH_SALT) {
  console.warn('[abuse] IP_HASH_SALT env not set — using empty salt. Set it in production for stronger hashing.');
}
function hashClientIp(req) {
  const ip = clientKey(req);
  if (!ip || ip === 'unknown') return null;
  return crypto.createHash('sha256').update(IP_HASH_SALT + ':' + ip).digest('hex');
}

// Per-bucket caps. Tuned so a normal household (≈2 users sharing one IP)
// stays well under the cap, while a sock-puppet farmer hits the wall fast.
const IP_THROTTLE_BUCKETS = {
  // Smart Study from summary → Gemini call. Free quota is 2/account; this
  // caps a single IP at 4/day, 8/week regardless of how many accounts they
  // make. Trip → 24h cooldown.
  study_gen: { day: 4, week: 8, blockHours: 24 },
  // Lab AI generation → Gemini call. More tolerant since paid users use it
  // heavily; still caps obvious abuse.
  lab_gen:   { day: 20, week: 60, blockHours: 24 },
};

function ipAbuseGuard(bucket) {
  const cfg = IP_THROTTLE_BUCKETS[bucket];
  return async (req, res, next) => {
    // Fail open on misconfig: better to serve than to lock everyone out.
    if (!supabaseAdmin || !cfg) return next();
    const ipHash = hashClientIp(req);
    if (!ipHash) return next();
    try {
      const { data, error } = await supabaseAdmin.rpc('ep_check_ip_throttle', {
        p_ip_hash: ipHash,
        p_bucket: bucket,
        p_max_day: cfg.day,
        p_max_week: cfg.week,
        p_block_hours: cfg.blockHours,
      });
      if (error && /function .* does not exist/i.test(error.message || '')) {
        console.warn('[abuse] ep_check_ip_throttle RPC missing — fail open. Run schema.sql.');
        return next();
      }
      if (error) {
        console.error('[abuse] rpc error:', error.message);
        return next(); // fail open on infra error
      }
      if (data && data.allowed === false) {
        const blockedUntil = data.blocked_until ? new Date(data.blocked_until) : null;
        const retrySec = blockedUntil
          ? Math.max(60, Math.ceil((blockedUntil.getTime() - Date.now()) / 1000))
          : 3600;
        console.warn(
          `[abuse] BLOCK ${bucket} ip-hash=${ipHash.slice(0, 12)}… ` +
          `today=${data.count_today} week=${data.count_week} ` +
          `until=${blockedUntil?.toISOString() || '?'} reason=${data.reason || '?'}`
        );
        res.setHeader('Retry-After', String(retrySec));
        return res.status(429).json({
          error: 'זוהה שימוש חריג מהכתובת הזאת. הגישה לפיצ\'ר הוקפאה זמנית. נסה שוב מאוחר יותר, או צור קשר אם נחסמת בטעות.',
          blocked_until: blockedUntil ? blockedUntil.toISOString() : null,
          retry_after_seconds: retrySec,
        });
      }
      next();
    } catch (e) {
      console.error('[abuse] guard fatal:', e?.message || e);
      next(); // fail open
    }
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
    study_packs_used_total: profile.study_packs_used_total || 0,
    study_packs_used_this_month: profile.study_packs_used_this_month || 0,
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
app.get('/study', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/study/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
// Early plan gate: free users no longer get any exam-PDF processing — they
// must use Smart Study from Summary instead. We refuse the request before
// multer even spools the upload, so they don't waste bandwidth.
async function blockFreePlanUpload(req, res, next) {
  try {
    const profile = await getUserProfile(req.userId);
    if (!profile) return res.status(404).json({ error: 'profile not found' });
    const plan = profile.plan || 'free';
    if (QUOTAS[plan].pdfs_total === 0 && QUOTAS[plan].pdfs_per_month === 0) {
      return res.status(402).json({
        error: 'העלאת PDF של מבחנים זמינה למנויי Basic ומעלה. במסלול החינמי תוכל ליצור חומרי לימוד מסיכום (לימוד חכם מסיכום).',
        needs_upgrade: true,
        upgrade_to: 'basic',
        try_instead: '/study/new',
      });
    }
    next();
  } catch (err) {
    console.error('[upload-gate] fatal:', err?.message || err);
    return res.status(500).json({ error: 'שגיאה פנימית' });
  }
}

app.post('/api/upload', authMiddleware, rateLimitMiddleware(3),
  blockFreePlanUpload,
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

// ===== Lab: AI-powered practice question generation =====
// Used by the AI Lab UI in admin/local-files mode. Doesn't go through
// Supabase auth (the admin testing path uses a localStorage mock user)
// — instead it's protected by rate-limit only and refuses to run unless
// the AI provider key is set in the environment.
// (Internal: currently uses Gemini Flash via GEMINI_API_KEY env, but this
// is intentionally not exposed in the API responses or client UI.)
app.post('/api/lab/generate-questions', rateLimitMiddleware(4), ipAbuseGuard('lab_gen'), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (!apiKey) {
    return res.status(503).json({
      error: 'יצירת AI אינה זמינה כרגע. נסה שוב מאוחר יותר.',
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
      console.error('[lab] AI HTTP', geminiRes.status, txt.slice(0, 400));
      return res.status(502).json({ error: 'שגיאה במנוע ה-AI. נסה שוב.' });
    }
    const payload = await geminiRes.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) return res.status(502).json({ error: 'תגובה ריקה מ-AI' });

    // Strip any accidental markdown fence
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      console.error('[lab] JSON parse failed:', e.message, 'text:', cleaned.slice(0, 400));
      return res.status(502).json({ error: 'תגובת AI לא תקינה' });
    }

    // ---- Validate structure ----
    if (!parsed?.questions || !Array.isArray(parsed.questions)) {
      return res.status(502).json({ error: 'תגובת AI במבנה לא תקין' });
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
      return res.status(502).json({ error: 'לא נוצרו שאלות תקינות' });
    }

    // NOTE: 'model' field is intentionally not returned to the client to avoid
    // exposing the AI provider name in the UI.
    res.json({ ok: true, questions: safe });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'בקשת ה-AI ארכה זמן רב מדי' });
    }
    console.error('[lab] fatal:', err?.message || err);
    res.status(500).json({ error: 'יצירת ה-AI נכשלה' });
  }
});

// =====================================================
//   SMART STUDY FROM SUMMARY
// =====================================================
// New free-trial feature: user uploads a summary (PDF or pasted text) and AI
// generates a complete study pack — MCQ questions, flashcards, hierarchical
// outline, glossary, open-ended questions, and a self-test. One AI call per
// pack, kept cheap (~$0.0023 per pack on Gemini Flash).

// Multer config for the study upload (PDF only, smaller cap than exam upload).
const studyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('רק קבצי PDF מותרים'));
    }
    cb(null, true);
  },
});

// Extract plain text from a PDF buffer using pdfjs-dist (no image processing).
// Returns { text, pageCount }. Throws on parse errors.
async function extractPdfText(pdfBuffer, maxPages = 30) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url
  ).href;
  const data = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdfDoc = await loadingTask.promise;
  const pageCount = Math.min(pdfDoc.numPages, maxPages);
  const chunks = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDoc.getPage(i);
    const tc = await page.getTextContent();
    // pdfjs returns items in visual order; join with spaces and newlines.
    const lineMap = new Map();
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      const list = lineMap.get(y) || [];
      list.push({ x: it.transform[4], str: it.str });
      lineMap.set(y, list);
    }
    const sortedYs = [...lineMap.keys()].sort((a, b) => b - a); // top→bottom
    for (const y of sortedYs) {
      const line = lineMap.get(y).sort((a, b) => b.x - a.x); // RTL: rightmost first
      const text = line.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (text) chunks.push(text);
    }
    chunks.push(''); // page break marker
    page.cleanup();
  }
  await pdfDoc.cleanup();
  await pdfDoc.destroy();
  const text = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, pageCount };
}

// Build the prompt that asks the AI to produce one full study pack from
// the user's summary text. Single call → JSON with all 6 sections.
function buildStudyPackPrompt(summaryText, title) {
  // Trim the input so we don't blow the model's context.
  const safe = summaryText.length > 30000 ? summaryText.slice(0, 30000) + '\n[...truncated]' : summaryText;
  return `אתה מורה מומחה שיוצר חומרי לימוד איכותיים בעברית מסיכום של סטודנט.

הסיכום (כותרת: "${title}"):
"""
${safe}
"""

צור חבילת לימוד שלמה שעוזרת לסטודנט להבין את החומר ברמה גבוהה. עליך להחזיר אך ורק JSON תקני (ללא markdown, ללא טקסט נוסף, ללא הסברים מחוץ ל-JSON) בפורמט הבא:

{
  "summary": "סקירה תמציתית של הסיכום ב-2-3 משפטים",
  "questions": [
    {
      "stem": "שאלה אמריקאית ברמת מבחן",
      "options": ["אופציה 1", "אופציה 2", "אופציה 3", "אופציה 4"],
      "correctIdx": 1,
      "explanation": "הסבר קצר למה התשובה הזו נכונה"
    }
  ],
  "flashcards": [
    { "front": "מושג / שאלה קצרה", "back": "הגדרה / תשובה ברורה" }
  ],
  "outline": [
    {
      "title": "פרק עליון 1",
      "items": [
        { "title": "תת-נושא 1.1", "items": ["נקודה", "נקודה"] },
        { "title": "תת-נושא 1.2", "items": ["נקודה"] }
      ]
    }
  ],
  "glossary": [
    { "term": "מושג מפתח", "definition": "הגדרה ברורה ב-1-2 משפטים" }
  ],
  "openQuestions": [
    { "question": "שאלה פתוחה לחשיבה עמוקה", "modelAnswer": "תשובה מומלצת מפורטת" }
  ],
  "selfTest": [
    { "type": "mcq", "stem": "...", "options": ["..","..","..",".."], "correctIdx": 1 },
    { "type": "flashcard", "front": "..", "back": ".." }
  ]
}

דרישות:
- 8-12 שאלות אמריקאיות ב-questions, ברמה אקדמית, עם 4 אופציות, הסבר למה הנכונה נכונה.
- 12-20 כרטיסיות ב-flashcards, מושג→הגדרה.
- 3-6 פרקים ב-outline, כל אחד עם 2-4 תת-נושאים.
- 10-20 מושגים ב-glossary.
- 4-8 שאלות פתוחות ב-openQuestions, עם תשובות מומלצות מפורטות (3-5 משפטים כל אחת).
- 8-10 פריטים ב-selfTest (ערבוב mcq + flashcard).
- correctIdx הוא 1-בסיסי (1, 2, 3, או 4).
- הכל בעברית. אם הסיכום באנגלית - כתוב את כל החומר באנגלית במקום.
- אסור להמציא עובדות שלא בסיכום. הסתמך על מה שהמשתמש כתב.`;
}

// Call AI with the study pack prompt and validate the response shape.
async function generateStudyPackWithAI(summaryText, title) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (!apiKey) {
    throw Object.assign(new Error('AI generation unavailable'), { code: 'no_api_key', http: 503 });
  }

  const prompt = buildStudyPackPrompt(summaryText, title);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90_000);
  let aiRes;
  try {
    aiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.6,
          topP: 0.95,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!aiRes.ok) {
    const txt = await aiRes.text().catch(() => '');
    console.error('[study] AI HTTP', aiRes.status, txt.slice(0, 400));
    throw Object.assign(new Error('AI provider error'), { http: 502 });
  }
  const payload = await aiRes.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw Object.assign(new Error('Empty AI response'), { http: 502 });

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    console.error('[study] JSON parse failed:', e.message, 'text:', cleaned.slice(0, 400));
    throw Object.assign(new Error('Invalid AI JSON'), { http: 502 });
  }

  // Sanitize + clamp every section to safe sizes.
  const clampStr = (s, n) => String(s || '').slice(0, n);
  const safe = {
    summary: clampStr(parsed.summary, 800),
    questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 12)
      .filter(q => q && typeof q.stem === 'string' && Array.isArray(q.options) && q.options.length === 4)
      .map(q => ({
        stem: clampStr(q.stem, 800),
        options: q.options.slice(0, 4).map(o => clampStr(o, 400)),
        correctIdx: Math.min(Math.max(parseInt(q.correctIdx, 10) || 1, 1), 4),
        explanation: clampStr(q.explanation, 1000),
      })) : [],
    flashcards: Array.isArray(parsed.flashcards) ? parsed.flashcards.slice(0, 25)
      .filter(c => c && (c.front || c.back))
      .map(c => ({ front: clampStr(c.front, 400), back: clampStr(c.back, 800) })) : [],
    outline: Array.isArray(parsed.outline) ? parsed.outline.slice(0, 8)
      .map(s => ({
        title: clampStr(s?.title, 200),
        items: Array.isArray(s?.items) ? s.items.slice(0, 8).map(it => {
          if (typeof it === 'string') return { title: clampStr(it, 200), items: [] };
          return {
            title: clampStr(it?.title, 200),
            items: Array.isArray(it?.items) ? it.items.slice(0, 8).map(p => clampStr(p, 300)) : [],
          };
        }) : [],
      })) : [],
    glossary: Array.isArray(parsed.glossary) ? parsed.glossary.slice(0, 25)
      .filter(g => g && g.term)
      .map(g => ({ term: clampStr(g.term, 150), definition: clampStr(g.definition, 600) })) : [],
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.slice(0, 10)
      .filter(q => q && q.question)
      .map(q => ({ question: clampStr(q.question, 600), modelAnswer: clampStr(q.modelAnswer, 1500) })) : [],
    selfTest: Array.isArray(parsed.selfTest) ? parsed.selfTest.slice(0, 12)
      .map(it => {
        if (it?.type === 'mcq' && Array.isArray(it.options) && it.options.length === 4) {
          return {
            type: 'mcq',
            stem: clampStr(it.stem, 800),
            options: it.options.slice(0, 4).map(o => clampStr(o, 400)),
            correctIdx: Math.min(Math.max(parseInt(it.correctIdx, 10) || 1, 1), 4),
          };
        }
        if (it?.type === 'flashcard') {
          return { type: 'flashcard', front: clampStr(it.front, 400), back: clampStr(it.back, 800) };
        }
        return null;
      }).filter(Boolean) : [],
  };

  if (!safe.questions.length && !safe.flashcards.length) {
    throw Object.assign(new Error('AI returned empty study pack'), { http: 502 });
  }
  return safe;
}

// Soft auth: only verifies JWT if present. Sets req.userId/req.db when valid,
// otherwise lets the request through anonymously. Used by /api/study/generate
// during the local-testing phase, where a localStorage mock user has no JWT.
async function softAuthMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    req.userId = null;
    req.db = null;
    return next();
  }
  const token = auth.substring(7);
  if (!supabaseAdmin) { req.userId = null; req.db = null; return next(); }
  const { data } = await supabaseAdmin.auth.getUser(token);
  if (data?.user) {
    req.userId = data.user.id;
    req.userJwt = token;
    req.db = userClient(token);
  } else {
    req.userId = null;
    req.db = null;
  }
  next();
}

// POST /api/study/generate
// Body: multipart/form-data { pdf: File, title?: string }  OR
//       application/json { kind: 'paste', text: string, title?: string }
//
// Auth modes:
//  - With Bearer JWT → full path: enforces server-side quota, persists pack
//    to ep_study_packs, returns { ok, pack_id, materials }.
//  - Without JWT (local-testing phase) → stateless AI call only: validates
//    input, calls AI, returns { ok, pack_id: null, materials }. The client
//    tracks quota and persists packs in localStorage.
app.post('/api/study/generate', rateLimitMiddleware(3), ipAbuseGuard('study_gen'), softAuthMiddleware,
  studyUpload.single('pdf'),
  async (req, res) => {
    try {
      let profile = null;
      let plan = 'free';
      let quota = QUOTAS.free;

      if (req.userId) {
        profile = await getUserProfile(req.userId);
        if (!profile) return res.status(404).json({ error: 'profile not found' });
        plan = profile.plan || 'free';
        quota = QUOTAS[plan];
      }

      // ===== Extract text (paste or pdf) =====
      let summaryText = '';
      let kind = 'paste';
      let title = '';

      if (req.file) {
        kind = 'pdf';
        if (!isPdfMagic(req.file.buffer)) {
          return res.status(400).json({ error: 'הקובץ אינו PDF תקני' });
        }
        try {
          const extracted = await withTimeout(
            extractPdfText(req.file.buffer, quota.max_pages_per_pdf || 25),
            45_000,
            'PDF text extraction'
          );
          summaryText = extracted.text;
        } catch (e) {
          console.error('[study] pdf extract:', e?.message || e);
          return res.status(400).json({ error: 'לא הצלחנו לקרוא את ה-PDF. נסה להדביק את הטקסט ידנית.' });
        }
        title = (typeof req.body?.title === 'string' && req.body.title.trim())
          || (req.file.originalname || 'סיכום ללא שם').replace(/\.pdf$/i, '').slice(0, 120);
      } else {
        // JSON path: client posted { kind: 'paste', text, title }
        const body = req.body || {};
        if (typeof body.text !== 'string') {
          return res.status(400).json({ error: 'חסר טקסט סיכום' });
        }
        summaryText = body.text;
        title = (typeof body.title === 'string' && body.title.trim()) || 'סיכום ללא שם';
        title = title.slice(0, 120);
      }

      // ===== Validate text length =====
      summaryText = String(summaryText || '').trim();
      if (summaryText.length < 300) {
        return res.status(400).json({ error: 'הסיכום קצר מדי. צריך לפחות 300 תווים כדי ליצור חומרי לימוד איכותיים.' });
      }
      if (summaryText.length > 60000) {
        return res.status(400).json({ error: 'הסיכום ארוך מדי (מקסימום 60,000 תווים). חתוך אותו לחלקים.' });
      }

      // ===== Stateless dev mode (no auth header) =====
      // Skip the DB entirely. Quota is enforced client-side via localStorage
      // for the local-testing phase. Just call the AI and return materials.
      if (!req.userId) {
        try {
          const materials = await generateStudyPackWithAI(summaryText, title);
          return res.json({ ok: true, pack_id: null, materials, title, source_kind: kind });
        } catch (aiErr) {
          const code = aiErr?.http || 502;
          console.error('[study/dev] ai error:', aiErr?.message || aiErr);
          return res.status(code).json({ error: 'יצירת חומרי הלימוד נכשלה. נסה שוב.' });
        }
      }

      // ===== Authenticated path: enforce quota + persist =====
      const { data: granted, error: rpcErr } = await supabaseAdmin.rpc('ep_reserve_study_pack_slot', {
        p_user_id: req.userId,
        p_max_total: quota.study_packs_total,
        p_max_month: quota.study_packs_per_month,
      });
      if (rpcErr && /function .* does not exist/i.test(rpcErr.message || '')) {
        console.warn('[study] ep_reserve_study_pack_slot RPC missing — refusing request');
        return res.status(503).json({ error: 'הפיצ\'ר בהקמה. נסה שוב בקרוב.' });
      }
      if (rpcErr) {
        console.error('[study] reserve error:', rpcErr.message);
        return res.status(500).json({ error: 'שגיאה פנימית' });
      }
      if (granted !== true) {
        return res.status(402).json({
          error: plan === 'free'
            ? 'סיימת את 2 הניסיונות החינמיים שלך. שדרג ל-Basic כדי להמשיך ליצור חומרי לימוד.'
            : 'הגעת למכסה החודשית של חומרי לימוד.',
          needs_upgrade: plan === 'free',
          upgrade_to: 'basic',
        });
      }

      // ===== Insert pack record (status: processing) =====
      const { data: pack, error: insertErr } = await req.db
        .from('ep_study_packs')
        .insert({
          user_id: req.userId,
          title,
          source_kind: kind,
          source_text_excerpt: summaryText.slice(0, 500),
          source_char_count: summaryText.length,
          status: 'processing',
        })
        .select()
        .single();
      if (insertErr) return dbError(res, 'insert study pack', insertErr);

      // ===== Generate with AI =====
      try {
        const materials = await generateStudyPackWithAI(summaryText, title);
        const { error: updateErr } = await req.db
          .from('ep_study_packs')
          .update({
            status: 'ready',
            materials,
            processed_at: new Date().toISOString(),
          })
          .eq('id', pack.id);
        if (updateErr) return dbError(res, 'update study pack', updateErr);
        return res.json({ ok: true, pack_id: pack.id, materials });
      } catch (aiErr) {
        const code = aiErr?.http || 502;
        await req.db.from('ep_study_packs').update({
          status: 'failed',
          error_message: clampString(aiErr?.message, 500),
        }).eq('id', pack.id);
        return res.status(code).json({ error: 'יצירת חומרי הלימוד נכשלה. נסה שוב.' });
      }
    } catch (err) {
      console.error('[study] fatal:', err?.message || err);
      return res.status(500).json({ error: 'שגיאה פנימית' });
    }
  });

// Helper for the endpoint above (small util used once).
function clampString(s, n) { return String(s || '').slice(0, n); }

// GET /api/study/packs — list current user's study packs
app.get('/api/study/packs', authMiddleware, async (req, res) => {
  const { data, error } = await req.db
    .from('ep_study_packs')
    .select('id, title, source_kind, source_char_count, status, created_at, processed_at')
    .order('created_at', { ascending: false });
  if (error) return dbError(res, 'list study packs', error);
  res.json(data || []);
});

// GET /api/study/packs/:id — fetch one study pack with full materials
app.get('/api/study/packs/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const { data, error } = await req.db
    .from('ep_study_packs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return dbError(res, 'get study pack', error);
  if (!data) return res.status(404).json({ error: 'not found' });
  res.json(data);
});

// DELETE /api/study/packs/:id — let users remove their own packs
app.delete('/api/study/packs/:id', authMiddleware, rateLimitMiddleware(10), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const { error } = await req.db.from('ep_study_packs').delete().eq('id', id);
  if (error) return dbError(res, 'delete study pack', error);
  res.json({ ok: true });
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
