// =====================================================
// ExamPrep - Frontend SPA
// =====================================================
// Vanilla JS, no framework. All-local mode for the admin
// testing phase: question data from /public/data/*.json,
// progress in localStorage. Cloud path comes later for
// real users.
// =====================================================
//
// TABLE OF CONTENTS — search for the "===== NAME =====" marker to jump.
// Line numbers are approximate; they drift as the file grows.
//
//   Error telemetry ................................ ~line 11
//   Globals ........................................ ~line 62
//   State .......................................... ~line 235
//   Course Registry ................................ ~line 246
//   Theme (light / dark / auto) .................... ~line 359
//   Auth (Supabase) ................................ ~line 398
//   Demo data seeder ............................... ~line 860
//   Local progress storage ......................... ~line 1002
//   Plans / quotas ................................. ~line 1182
//   Utility (escapeHtml, tmpl, etc.) ............... ~line 1191
//   Trial countdown banner ......................... ~line 1370
//   Router ......................................... ~line 1413
//   Course-scoped data helpers ..................... ~line 1514
//   Topic taxonomy + pattern analysis .............. ~line 1541
//   Streak / time / trend / tips ................... ~line 1688
//   RENDER: Landing ................................ ~line 1831
//   RENDER: Auth (login + signup) .................. ~line 2043
//   RENDER: Dashboard .............................. ~line 2338
//   RENDER: Degree Dashboard ....................... ~line 2732
//   Add-Course / Add-Sub-Course modals ............. ~line 2849
//   RENDER: Course Dashboard ....................... ~line 3080
//   Exam management modal .......................... ~line 3417
//   Onboarding tour ................................ ~line 4449
//   Upload PDF modal ............................... ~line 4576
//   Batch creation modal ........................... ~line 5033
//   Quiz session ................................... ~line 5100
//   RENDER: Summary ................................ ~line 5496
//   RENDER: Mistake Review ......................... ~line 5556
//   Synthetic mock-exam generator .................. ~line 5666
//   RENDER: Insights ............................... ~line 5757
//   RENDER: Lab .................................... ~line 5880
//   RENDER: Progress ............................... ~line 6220
//   Shared topbar + user menu + batches dropdown ... ~line 6484
//   Settings page .................................. search "Settings section"
// =====================================================

// ===== Error telemetry =====
// Captures uncaught errors and unhandled rejections and POSTs them to
// /api/client-error. Minimal, no deps, fire-and-forget. Max 20 reports per
// page load to prevent noise. This is the FIRST thing we set up — if anything
// below crashes during parse/execute, we still get visibility.
(function setupErrorReporter() {
  let sent = 0;
  const MAX = 20;
  function report(type, payload) {
    if (sent++ >= MAX) return;
    try {
      const body = JSON.stringify({
        type,
        ...payload,
        ua: navigator.userAgent || '',
        url: location.href || '',
        t: Date.now(),
      });
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon('/api/client-error', blob);
      } else {
        fetch('/api/client-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
  }
  window.addEventListener('error', (e) => {
    report('error', {
      msg: (e && e.message) || 'unknown error',
      stack: (e && e.error && e.error.stack) || '',
      extra: e && e.filename ? { file: e.filename, line: e.lineno, col: e.colno } : null,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    let msg = '';
    let stack = '';
    try {
      const reason = e.reason;
      msg = String(reason && reason.message ? reason.message : reason);
      stack = reason && reason.stack ? String(reason.stack) : '';
    } catch { msg = 'unhandledrejection'; }
    report('unhandled', { msg, stack });
  });
  // Expose for intentional one-off reports from elsewhere in the app.
  window.__reportClientError = report;
})();

// ===== Globals =====
const $app = document.getElementById('app');

// The landing page is pre-rendered as static HTML inside #app (see index.html).
// It is the single most-visited page — having it paint before JS runs means
// the user sees the real site on first paint, no matter what happens to the
// JS bundle, service worker, or cache. We snapshot its outerHTML at module
// load so renderLanding() can restore it after the user navigates away
// (e.g. to /login) and back to /. This MUST run before anything mutates #app.
let _landingHtmlCache = null;
(function captureLandingHtml() {
  try {
    const existing = $app && $app.querySelector && $app.querySelector('.landing');
    if (existing && existing.outerHTML) _landingHtmlCache = existing.outerHTML;
  } catch {}
})();

const Data = {
  // Per-course data cache. Each entry: { metadata, answers, explanations }
  _cache: {},

  // Compatibility getters — return the currently-active course's data so that
  // existing code like Data.metadata.exams keeps working unchanged.
  get metadata() { return (this._cache[state.course?.id || 'tohna1'] || {}).metadata || null; },
  get answers() { return (this._cache[state.course?.id || 'tohna1'] || {}).answers || {}; },
  get explanations() { return (this._cache[state.course?.id || 'tohna1'] || {}).explanations || {}; },

  _loadedSet: new Set(),
  // Per-exam explanation promise cache for tohna1. Each entry is a Promise<object>
  // keyed by the exam id (e.g. "moed_a_sem_a_2026"). When a quiz starts we call
  // ensureExplanationsForExam() so reveal() can access them synchronously via
  // the `explanations` getter.
  _explanationPromises: {},

  async ensureLoaded(courseId) {
    const cid = courseId || state.course?.id || 'tohna1';
    if (this._loadedSet.has(cid)) return;

    if (cid === 'tohna1') {
      // Built-in course: metadata + answers only. explanations.json was ~192KB
      // and used to block the dashboard — it's now loaded lazily per-exam via
      // ensureExplanationsForExam() just before a quiz reveal needs them.
      const [meta, ans] = await Promise.all([
        fetch('/public/data/metadata.json').then(r => r.json()),
        fetch('/public/data/answers.json').then(r => r.json()),
      ]);
      this._cache[cid] = { metadata: meta, answers: ans.answers || {}, explanations: {} };
    } else {
      // Cloud course: fetch questions + exams from API
      const token = await Auth.getToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const [examsRes, questionsRes] = await Promise.all([
        fetch(`/api/courses/${cid}/exams`, { headers }),
        fetch(`/api/courses/${cid}/questions`, { headers }),
      ]);
      const examsRaw = examsRes.ok ? await examsRes.json() : [];
      const questionsRaw = questionsRes.ok ? await questionsRes.json() : [];

      // Normalize into the same shape as the static JSON data
      const examMap = {};
      for (const ex of examsRaw) {
        examMap[ex.id] = { id: String(ex.id), label: ex.name, questions: [] };
      }
      const answers = {};
      const explanations = {};
      for (const q of questionsRaw) {
        const qid = String(q.id);
        const examId = String(q.exam_id);
        if (!examMap[q.exam_id]) {
          examMap[q.exam_id] = { id: examId, label: `מבחן ${q.exam_id}`, questions: [] };
        }
        const isTextOnly = q.image_path === 'text-only';
        examMap[q.exam_id].questions.push({
          id: qid, examId, image: q.image_path,
          section: String(q.question_number),
          answer_confidence: q.answer_confidence || null,
          _isCloud: true,
          ...(isTextOnly && { _isAi: true, _stem: q.general_explanation || `שאלה ${q.question_number}` }),
        });
        answers[qid] = {
          numOptions: q.num_options || 4,
          optionLabels: q.option_labels || null,
          correctIdx: q.correct_idx,
          topic: q.topic || null,
          groupId: q.group_id || null,
          contextText: q.context_text || null,
          contextImagePath: q.context_image_path || null,
          contextCrossPage: !!q.context_cross_page,
          questionNumber: q.question_number || null,
          instructorSolutionText: q.instructor_solution_text || null,
          hasRichSolution: !!q.has_rich_solution,
        };
        if (q.general_explanation || q.option_explanations) {
          explanations[qid] = {
            general: q.general_explanation || null,
            options: q.option_explanations || [],
            conceptTag: q.concept_tag || null,
            distractorAnalysis: Array.isArray(q.distractor_analysis) ? q.distractor_analysis : null,
          };
        }
      }
      const metadata = { exams: Object.values(examMap) };
      this._cache[cid] = { metadata, answers, explanations };
    }
    this._loadedSet.add(cid);
  },

  publicMeta(qid) {
    const a = this.answers[qid] || {};
    return {
      numOptions: a.numOptions,
      optionLabels: a.optionLabels || null,
      topic: a.topic || null,
      groupId: a.groupId || null,
      contextText: a.contextText || null,
      contextImagePath: a.contextImagePath || null,
      contextCrossPage: a.contextCrossPage || false,
    };
  },
  // Lazy-load explanations for a single tohna1 exam. Returns a Promise that
  // resolves once the per-exam map is merged into the main cache, so
  // reveal()/explanations-getter callers can access it synchronously.
  ensureExplanationsForExam(examId) {
    if (!examId) return Promise.resolve(null);
    const cid = 'tohna1'; // only built-in course uses per-exam shards today
    const entry = this._cache[cid];
    if (!entry) return Promise.resolve(null);
    // Already loaded? Check for any key prefixed with this examId.
    const prefix = examId + '__';
    for (const k of Object.keys(entry.explanations || {})) {
      if (k.startsWith(prefix)) return Promise.resolve(entry.explanations);
    }
    if (this._explanationPromises[examId]) return this._explanationPromises[examId];
    const p = fetch(`/public/data/explanations/${encodeURIComponent(examId)}.json`)
      .then(r => r.ok ? r.json() : {})
      .then(map => {
        // Merge under the full "<exam>__<num>" keys the rest of the app expects.
        for (const [num, val] of Object.entries(map || {})) {
          entry.explanations[`${examId}__${num}`] = val;
        }
        return entry.explanations;
      })
      .catch(() => entry.explanations);
    this._explanationPromises[examId] = p;
    return p;
  },
  // Prefetch explanations for every exam in a quiz batch. Called at quiz start
  // so the reveal button is instant for every question in the batch.
  prefetchExplanationsForQuestions(questions) {
    if (!Array.isArray(questions) || !questions.length) return Promise.resolve();
    const examIds = new Set();
    for (const q of questions) { if (q && q.examId) examIds.add(q.examId); }
    return Promise.all([...examIds].map(id => this.ensureExplanationsForExam(id)));
  },
  reveal(qid) {
    const a = this.answers[qid] || {};
    return {
      correctIdx: a.correctIdx,
      explanation: this.explanations[qid] || null,
      topic: a.topic || null,
      instructorSolutionText: a.instructorSolutionText || null,
      hasRichSolution: !!a.hasRichSolution,
    };
  },
  imageUrl(relImage, courseId) {
    if (!relImage) return '';
    // Root-relative paths (e.g. /public/images/tohna1/...) — use as-is
    if (relImage.startsWith('/')) return relImage;
    // Full URLs (Cloudinary, Supabase storage, etc.) — use as-is
    if (relImage.startsWith('http')) return relImage;
    const cid = courseId || state.course?.id || 'tohna1';
    // Built-in tohna1 images are shipped inside examprep itself at
    // /public/images/tohna1/<exam_id>/<file>.png.
    if (cid === 'tohna1') return `/public/images/tohna1/${encodeURI(relImage)}`;
    // Cloud courses: relative storage key
    return `/storage/${encodeURI(relImage)}`;
  },
  allQuestions() {
    if (!this.metadata) return [];
    return this.metadata.exams.flatMap(e => e.questions);
  },
  practiceQuestions() {
    return this.allQuestions().filter(
      q => q.answer_confidence !== 'uncertain' && q.answer_confidence !== 'unknown'
    );
  },
};

// Fallback-swap helper for thumbnail <img> elements. When a Cloudinary crop
// comes back usable-but-tiny (empty strip) or 404s, replace the image with
// the stem text stashed on data-fallback-text. Defined as a window global so
// inline onload/onerror attributes can reference it.
window.EmThumbFallback = {
  check(img) {
    if (!img) return;
    if (img.naturalHeight < 60 || img.naturalWidth < 30) this.swap(img);
  },
  swap(img) {
    if (!img || !img.parentElement) return;
    const text = img.dataset.fallbackText || '';
    const div = document.createElement('div');
    div.style.padding = '8px';
    div.textContent = text;
    img.parentElement.innerHTML = '';
    img.parentElement.appendChild(div);
  },
};

// ===== State =====
const state = {
  user: null, // { email, name, plan, isAdmin }
  course: null, // currently selected course { id, name, color, ... }
  courses: [], // top-level user courses/degrees (cached from API)
  subCourses: [], // cached sub-courses for the currently-open degree
  degree: null, // currently selected degree { id, name, color, ... }
  quiz: null, // current quiz session
  lastBatch: null, // for the mistake review screen
  statsSummary: null, // cached { aggregate, perCourse } from /api/stats/summary; null = re-fetch
};

// ===== Course Registry =====
// Manages the list of user courses. "tohna1" is a virtual built-in course
// backed by static JSON; all other courses live in Supabase via the API.
const CourseRegistry = {
  _loaded: false,

  // The built-in course that ships with the app (admin testing phase).
  BUILTIN: { id: 'tohna1', name: 'תוכנה 1', description: 'בנק שאלות אמריקאיות מבחינות עבר של תוכנה 1 — אונ\' תל אביב. כולל הסברים מפורטים בעברית לכל שאלה.', color: '#3b82f6', isBuiltin: true },

  async ensureLoaded() {
    if (this._loaded) return;
    try {
      const token = await Auth.getToken();
      if (token) {
        const res = await fetch('/api/courses', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) state.courses = await res.json();
      }
    } catch (e) { console.warn('[CourseRegistry] fetch failed:', e.message); }
    this._loaded = true;
  },

  list() {
    // Built-in tohna1 course is admin-only. Modelim-plan admins skip it — they
    // only manage the seeded course library for their friends.
    const isModelimAdmin = state.user?.isAdmin && state.user?.plan === 'modelim';
    if (state.user?.isAdmin && !isModelimAdmin) return [this.BUILTIN, ...state.courses];
    return [...state.courses];
  },

  get(courseId) {
    if (courseId === 'tohna1') return state.user?.isAdmin ? this.BUILTIN : null;
    return state.courses.find(c => String(c.id) === String(courseId))
      || state.subCourses.find(c => String(c.id) === String(courseId))
      || null;
  },

  async create(name, description, color, image_url, options = {}) {
    const token = await Auth.getToken();
    const body = { name, description, color, image_url: image_url || null };
    if (options.parent_id) body.parent_id = options.parent_id;
    if (options.is_degree) body.is_degree = true;
    const res = await fetch('/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 402) {
        showPaywallModal(err.trial_expired ? 'trial_ended' : 'course_limit');
        throw new Error('');
      }
      throw new Error(err.error || 'שגיאה ביצירת קורס');
    }
    const course = await res.json();
    if (options.parent_id) {
      state.subCourses.unshift(course);
    } else {
      state.courses.unshift(course);
    }
    return course;
  },

  async listSubCourses(degreeId) {
    const token = await Auth.getToken();
    if (!token) return [];
    const res = await fetch(`/api/courses/${degreeId}/courses`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const subs = await res.json();
    // Cache in state so setCourseContext can find sub-course objects
    for (const sc of subs) {
      if (!state.subCourses.find(c => String(c.id) === String(sc.id))) {
        state.subCourses.push(sc);
      } else {
        const idx = state.subCourses.findIndex(c => String(c.id) === String(sc.id));
        state.subCourses[idx] = sc;
      }
    }
    return subs;
  },

  invalidate() { this._loaded = false; },

  // Force a fresh fetch from the server so course stats (total_questions,
  // total_pdfs) reflect the current database state.
  async refresh() {
    this._loaded = false;
    await this.ensureLoaded();
  },
};

// Central helper: call this after ANY mutation that changes a course's
// questions, exams, or stats (upload, delete, restore, rename) so the UI
// picks up the new state from the database immediately.
//
// What it does, in order:
//   1. Drops the cached data for this course (forces re-fetch next time)
//   2. Re-fetches the courses list so total_questions/total_pdfs are live
//   3. Re-fetches this course's data so lists re-render from DB
//   4. If the user is currently looking at the global dashboard or this
//      course's dashboard, re-renders that view silently so it updates
//      without a page reload.
async function refreshCourseState(courseId) {
  const cid = String(courseId);
  try {
    Data._loadedSet.delete(cid);
    // A fresh upload likely introduced un-topic'd questions — let the next
    // Insights visit run the labeler again instead of trusting the session
    // flag set on the previous visit.
    try { _insightsTopicRequested.delete(cid); } catch {}
    await CourseRegistry.refresh();
    await Data.ensureLoaded(cid).catch(() => {});
  } catch (e) {
    console.warn('[refreshCourseState]', e?.message || e);
  }
  const route = getRoute();
  if (route === '/dashboard' || route === `/course/${cid}` || route === `/course/${cid}/dashboard`) {
    renderRoute();
  }
}

// ===== Theme (light / dark / auto) =====
// Persists in localStorage; applied to <html data-theme="..."> on boot. Auto
// mode follows the system color-scheme preference and re-applies on change.
const Theme = {
  KEY: 'ep_theme_v1',
  current() {
    try { return localStorage.getItem(this.KEY) || 'light'; } catch { return 'light'; }
  },
  set(theme) {
    if (!['light', 'dark', 'auto'].includes(theme)) theme = 'light';
    try { localStorage.setItem(this.KEY, theme); } catch {}
    this.apply();
  },
  resolved() {
    const t = this.current();
    if (t !== 'auto') return t;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  },
  apply() {
    const r = this.resolved();
    document.documentElement.setAttribute('data-theme', r);
    // Update meta theme-color so the mobile chrome bar matches
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', r === 'dark' ? '#0b1120' : '#1d4ed8');
    // Notify listeners
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: r, mode: this.current() } }));
  },
  init() {
    this.apply();
    // Listen to system preference changes for auto mode
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => { if (this.current() === 'auto') this.apply(); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else if (mq.addListener) mq.addListener(handler);
    }
  },
};

// ===== Auth via Supabase =====
const _sbConfig = window.APP_CONFIG || {};

// supabase-js is NEVER on the critical path. The hot paths (login, getToken,
// restoreSession, fetchProfile) go through raw fetch directly to GoTrue/REST.
// The library is only dynamically imported for: signup (signUp), Google OAuth
// (signInWithOAuth), password reset, and onAuthStateChange — all of which run
// AFTER first paint and/or only on user interaction.
let _sbClient = null;
let _sbClientPromise = null;
async function getSbClient() {
  if (_sbClient) return _sbClient;
  if (_sbClientPromise) return _sbClientPromise;
  if (!_sbConfig.SUPABASE_URL || !_sbConfig.SUPABASE_ANON_KEY) return null;
  _sbClientPromise = (async () => {
    const mod = await import('https://esm.sh/@supabase/supabase-js@2?bundle');
    _sbClient = mod.createClient(_sbConfig.SUPABASE_URL, _sbConfig.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // No-op lock bypasses navigator.locks deadlock on iOS Safari private mode.
        lock: (name, acquireTimeout, fn) => fn(),
      },
    });
    return _sbClient;
  })();
  return _sbClientPromise;
}

// Raw-fetch helpers — used by every hot path so we never touch supabase-js.
function _sbProjectRef() {
  return _sbConfig.SUPABASE_URL?.match(/https:\/\/([^.]+)\./)?.[1] || null;
}
function _sbStorageKey() {
  const ref = _sbProjectRef();
  return ref ? `sb-${ref}-auth-token` : null;
}
function _readSession() {
  try {
    const k = _sbStorageKey();
    if (!k) return null;
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // Normalize both shapes: current flat shape and legacy { currentSession }
    if (s?.currentSession) return s.currentSession;
    return s || null;
  } catch { return null; }
}
function _writeSession(s) {
  try {
    const k = _sbStorageKey();
    if (!k || !s) return;
    localStorage.setItem(k, JSON.stringify(s));
  } catch {}
}
function _clearSession() {
  try {
    const k = _sbStorageKey();
    if (k) localStorage.removeItem(k);
  } catch {}
}
async function _withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}
async function _sbRefreshToken(refreshToken) {
  if (!refreshToken) return null;
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${_sbConfig.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': _sbConfig.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${_sbConfig.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(killer);
    if (!res.ok) return null;
    const body = await res.json();
    const session = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (body.expires_in || 3600),
      expires_in: body.expires_in,
      token_type: body.token_type || 'bearer',
      user: body.user,
    };
    _writeSession(session);
    return session;
  } catch { clearTimeout(killer); return null; }
}
async function _sbFetchProfileRaw(accessToken, userId) {
  if (!accessToken || !userId) return null;
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${_sbConfig.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*`, {
      headers: {
        'apikey': _sbConfig.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
      },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(killer);
    if (!res.ok) return null;
    const arr = await res.json();
    return arr[0] || null;
  } catch { clearTimeout(killer); return null; }
}
// Parse OAuth callback (Google) from URL hash. Supabase normally does this via
// detectSessionInUrl; we replicate the minimum here so we don't need the library
// on the first paint path.
function _consumeOAuthHash() {
  try {
    const hash = window.location.hash || '';
    if (!hash.includes('access_token=')) return null;
    const params = new URLSearchParams(hash.replace(/^#\/?/, ''));
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    const expires_in = parseInt(params.get('expires_in') || '3600', 10);
    if (!access_token) return null;
    const session = {
      access_token, refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + expires_in,
      expires_in,
      token_type: params.get('token_type') || 'bearer',
      user: null,
    };
    _writeSession(session);
    // Strip the hash so we don't re-consume it on reload.
    history.replaceState(null, '', window.location.pathname + window.location.search + '#/');
    return session;
  } catch { return null; }
}

const Auth = {
  KEY: 'ep_user',
  _profileCache: null,

  current() {
    try { return JSON.parse(localStorage.getItem(this.KEY)); } catch { return null; }
  },
  save(user) { localStorage.setItem(this.KEY, JSON.stringify(user)); },
  // Local-only clear — removes cached user but does NOT call sb.auth.signOut().
  // Use from inside the onAuthStateChange('SIGNED_OUT') handler to avoid an
  // infinite loop (signOut → SIGNED_OUT → clear → signOut → ...).
  clearLocal() { localStorage.removeItem(this.KEY); },
  clear() {
    localStorage.removeItem(this.KEY);
    _clearSession();
    // Best-effort signOut to invalidate the refresh token server-side. Raw fetch
    // with a hard timeout — we never block UI on this.
    try {
      const cfg = window.APP_CONFIG || {};
      if (!cfg.SUPABASE_URL) return;
      const token = (function () { try { return _readSession()?.access_token; } catch { return null; } })();
      if (!token) return;
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 3000);
      fetch(`${cfg.SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          'apikey': cfg.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
        signal: ctrl.signal,
        cache: 'no-store',
      }).catch(() => {});
    } catch {}
  },

  async login(email, password) {
    // Direct REST call to GoTrue, bypassing supabase-js entirely. Any stale
    // service worker, gotrue navigator.locks deadlock, or session-restore
    // promise can't interfere with this path because it goes straight through
    // the browser's native fetch with an AbortController kill-switch.
    const cfg = window.APP_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
      throw new Error('מערכת האימות לא זמינה כרגע');
    }
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(`${cfg.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': cfg.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${cfg.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ email, password }),
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch (e) {
      clearTimeout(killer);
      if (e.name === 'AbortError') throw new Error('שרת האימות לא הגיב — נסה שוב');
      throw new Error('שגיאת רשת — בדוק חיבור לאינטרנט');
    }
    clearTimeout(killer);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body.error_description || body.msg || body.error || '').toLowerCase();
      if (msg.includes('invalid') || msg.includes('credentials')) {
        throw new Error('אימייל או סיסמה שגויים');
      }
      throw new Error(body.error_description || body.msg || 'שגיאת אימות');
    }
    // Persist the session into the same localStorage key supabase-js uses,
    // so subsequent getSession()/API calls pick it up automatically. The key
    // format is "sb-<project-ref>-auth-token".
    try {
      const ref = cfg.SUPABASE_URL.match(/https:\/\/([^.]+)\./)?.[1];
      if (ref) {
        const session = {
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + (body.expires_in || 3600),
          expires_in: body.expires_in,
          token_type: body.token_type || 'bearer',
          user: body.user,
        };
        localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(session));
      }
    } catch {}
    // Best-effort profile fetch via raw fetch too (5s cap)
    let profile = null;
    try {
      const profCtrl = new AbortController();
      const profKiller = setTimeout(() => profCtrl.abort(), 5000);
      const pRes = await fetch(`${cfg.SUPABASE_URL}/rest/v1/profiles?id=eq.${body.user.id}&select=*`, {
        headers: {
          'apikey': cfg.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${body.access_token}`,
        },
        signal: profCtrl.signal,
        cache: 'no-store',
      });
      clearTimeout(profKiller);
      if (pRes.ok) {
        const arr = await pRes.json();
        profile = arr[0] || null;
      }
    } catch (e) { console.warn('[auth] profile fetch failed:', e.message); }
    const u = {
      id: body.user.id,
      email: body.user.email,
      name: profile?.display_name || body.user.user_metadata?.username || email.split('@')[0],
      plan: profile?.plan || 'free',
      isAdmin: profile?.is_admin || false,
    };
    this.save(u);
    return u;
  },

  async signup(email, password, name) {
    // Raw fetch to /auth/v1/signup — keeps supabase-js off the critical path.
    const cfg = window.APP_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
      throw new Error('מערכת האימות לא זמינה כרגע');
    }
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(`${cfg.SUPABASE_URL}/auth/v1/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': cfg.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${cfg.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          email,
          password,
          data: { username: name },
        }),
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch (e) {
      clearTimeout(killer);
      if (e.name === 'AbortError') throw new Error('שרת האימות לא הגיב — נסה שוב');
      throw new Error('שגיאת רשת — בדוק חיבור לאינטרנט');
    }
    clearTimeout(killer);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body.error_description || body.msg || body.error || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered')) {
        throw new Error('שגיאה בהרשמה. אם כבר יש לך חשבון, נסה להתחבר.');
      }
      throw new Error(body.error_description || body.msg || 'שגיאת הרשמה');
    }
    // Persist session if signup returned tokens (confirm-off flow).
    const userId = body.user?.id || body.id;
    if (body.access_token) {
      const session = {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (body.expires_in || 3600),
        expires_in: body.expires_in,
        token_type: body.token_type || 'bearer',
        user: body.user,
      };
      _writeSession(session);
      // Best-effort profile upsert (raw fetch, 5s cap).
      try {
        const trialExpiry = new Date(Date.now() + 14 * 86400000).toISOString();
        const profCtrl = new AbortController();
        setTimeout(() => profCtrl.abort(), 5000);
        await fetch(`${cfg.SUPABASE_URL}/rest/v1/profiles`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': cfg.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${body.access_token}`,
            'Prefer': 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify({
            id: userId,
            email,
            display_name: name,
            plan: 'trial',
            is_admin: false,
            trial_started_at: new Date().toISOString(),
            plan_expires_at: trialExpiry,
          }),
          signal: profCtrl.signal,
          cache: 'no-store',
        });
      } catch {}
    }
    // No access_token = email confirmation required
    if (!body.access_token) {
      return { id: userId, email, name: name || email.split('@')[0], needsConfirmation: true };
    }
    const u = {
      id: userId,
      email,
      name: name || email.split('@')[0],
      plan: 'trial',
      isAdmin: false,
      daysLeft: 14,
    };
    this.save(u);
    return u;
  },

  async loginWithGoogle() {
    // Lazy-load supabase-js only when Google OAuth is actually requested — this
    // is a user interaction, so paying the dynamic-import cost is acceptable.
    const sb = await getSbClient();
    if (!sb) throw new Error('מערכת האימות לא זמינה כרגע');
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/' },
    });
    if (error) throw new Error(error.message);
  },

  async _fetchProfile(userId) {
    // Pure raw fetch — no library dependency.
    const s = _readSession();
    return _sbFetchProfileRaw(s?.access_token, userId);
  },

  // Restore session on page load — pure raw fetch, never touches supabase-js.
  async restoreSession() {
    // Consume OAuth hash fragment if we just came back from a Google redirect.
    _consumeOAuthHash();
    let session = _readSession();
    if (!session) { return this.current(); }
    // If token is expired or about to expire, refresh via raw fetch.
    const now = Math.floor(Date.now() / 1000);
    if ((session.expires_at || 0) < now + 60) {
      const refreshed = await _withTimeout(
        _sbRefreshToken(session.refresh_token),
        8000,
      ).catch(() => null);
      if (refreshed) session = refreshed;
      else {
        // Refresh failed — fall back to whatever we have in localStorage.
        return this.current();
      }
    }
    // Fetch profile with raw fetch (5s hard cap).
    let profile = null;
    try {
      profile = await _withTimeout(
        _sbFetchProfileRaw(session.access_token, session.user?.id),
        5000,
      );
    } catch {}
    if (!session.user) {
      // OAuth callback returned tokens but not a user object — decode it from
      // the JWT payload (base64 URL-safe, no verification needed client-side).
      try {
        const payload = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        session.user = { id: payload.sub, email: payload.email, user_metadata: payload.user_metadata || {} };
        _writeSession(session);
      } catch {}
    }
    if (!session.user) return this.current();
    let daysLeft = null;
    if (profile?.plan === 'trial' && profile?.plan_expires_at) {
      daysLeft = Math.max(0, Math.ceil((new Date(profile.plan_expires_at) - Date.now()) / 86400000));
    }
    const u = {
      id: session.user.id,
      email: session.user.email,
      name: profile?.display_name || session.user.user_metadata?.username || session.user.email?.split('@')[0],
      plan: profile?.plan || 'free',
      isAdmin: profile?.is_admin || false,
      daysLeft,
      planExpiresAt: profile?.plan_expires_at || null,
      trialUsed: profile?.trial_used || false,
      studyPacksUsedToday: profile?.study_packs_used_today || 0,
      studyPacksUsedThisMonth: profile?.study_packs_used_this_month || 0,
    };
    this.save(u);
    return u;
  },

  async getToken() {
    // Pure raw-fetch refresh — NO supabase-js, NO navigator.locks, NO hang risk.
    // This is on the hot path for every /api/* call, so it must never block.
    try {
      const session = _readSession();
      const token = session?.access_token;
      if (!token) return null;
      const expiresAt = session?.expires_at || 0;
      if (expiresAt && expiresAt * 1000 < Date.now() + 10000) {
        const refreshed = await _withTimeout(
          _sbRefreshToken(session.refresh_token),
          5000,
        ).catch(() => null);
        return refreshed?.access_token || token;
      }
      return token;
    } catch { return null; }
  },

  update(patch) {
    const cur = this.current();
    if (!cur) return null;
    const next = Object.assign({}, cur, patch);
    this.save(next);
    return next;
  },
};

// ===== Demo data seeder for the admin testing user =====
// On first admin login, plant a realistic ~10-day learning history so all the
// new screens (Progress, Insights, Lab) show a meaningful state immediately.
// Idempotent: skips if progress already exists.
const DemoSeed = {
  KEY_FLAG: 'ep_demo_seeded_v2',
  // Topic substrings the admin "struggles with" — generates more wrong/revealed
  // attempts. The remaining topics get high accuracy.
  WEAK_TOPIC_PATTERNS: [
    /wildcard.*super/i,
    /wildcard.*extends/i,
    /equals.*hashcode/i,
    /classcast/i,
    /method overriding.*private/i,
    /erasure/i,
    /design pattern/i,
  ],
  isWeakTopic(topic) {
    if (!topic) return false;
    return this.WEAK_TOPIC_PATTERNS.some(re => re.test(topic));
  },
  shouldSeed(uid) {
    // Re-seed when bumping the version flag.
    return localStorage.getItem(this.KEY_FLAG + ':' + uid) !== '1';
  },
  markSeeded(uid) {
    localStorage.setItem(this.KEY_FLAG + ':' + uid, '1');
  },
  // Build a deterministic-ish history covering ~10 days, ~70 attempts, 6 batches
  build(uid) {
    const allQs = Data.allQuestions();
    if (!allQs.length) return;

    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const attempts = [];
    const batches = [];
    const reviewQueue = [];

    // Helper: deterministic pseudo-random based on a string seed so the
    // same admin always sees the same demo.
    let rngState = 0;
    for (const ch of uid) rngState = (rngState * 31 + ch.charCodeAt(0)) & 0x7fffffff;
    function rand() {
      rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
      return rngState / 0x7fffffff;
    }
    function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
    function shuffle(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    // Create 6 batches over the past 10 days, getting progressively better
    const batchPlan = [
      { daysAgo: 10, size: 10, baselineCorrectness: 0.45 }, // first attempt - struggling
      { daysAgo: 8,  size: 15, baselineCorrectness: 0.55 },
      { daysAgo: 6,  size: 10, baselineCorrectness: 0.60 },
      { daysAgo: 4,  size: 20, baselineCorrectness: 0.70 }, // exam mode
      { daysAgo: 2,  size: 12, baselineCorrectness: 0.75 },
      { daysAgo: 1,  size: 15, baselineCorrectness: 0.82 }, // most recent - improving!
    ];

    for (const plan of batchPlan) {
      const batchId = `b_demo_${plan.daysAgo}_${Math.floor(rand() * 99999)}`;
      const batchTs = now - plan.daysAgo * oneDay - Math.floor(rand() * 4 * 60 * 60 * 1000);
      const sample = shuffle(allQs).slice(0, plan.size);
      let correct = 0, wrong = 0;
      const selections = {};
      const correctIdxByQ = {};
      const correctMap = {};
      for (const q of sample) {
        const reveal = Data.reveal(q.id);
        const meta = Data.publicMeta(q.id);
        const isWeak = DemoSeed.isWeakTopic(reveal.topic || '');
        // Weak topics: lower correctness; strong topics: bumped up
        const adjustedAcc = isWeak
          ? Math.max(0.25, plan.baselineCorrectness - 0.25)
          : Math.min(0.95, plan.baselineCorrectness + 0.15);
        const isCorrect = rand() < adjustedAcc;
        const numOpts = meta.numOptions || 4;
        const correctIdx = reveal.correctIdx || 1;
        let selectedIdx;
        if (isCorrect) {
          selectedIdx = correctIdx;
          correct++;
        } else {
          // Pick a wrong option
          do { selectedIdx = 1 + Math.floor(rand() * numOpts); }
          while (selectedIdx === correctIdx && numOpts > 1);
          wrong++;
        }
        const revealed = !isCorrect && rand() < 0.4; // sometimes peek at solution
        const timeSeconds = 30 + Math.floor(rand() * 90);
        const attemptTs = batchTs + Math.floor(rand() * 30 * 60 * 1000); // within 30min of batch start
        attempts.push({
          questionId: q.id,
          selectedIdx,
          isCorrect,
          revealed,
          timeSeconds,
          batchId,
          ts: attemptTs,
        });
        selections[q.id] = selectedIdx;
        correctIdxByQ[q.id] = correctIdx;
        correctMap[q.id] = isCorrect;
        if (!isCorrect && !reviewQueue.includes(q.id)) reviewQueue.push(q.id);
      }
      batches.push({
        batchId,
        size: plan.size,
        correct,
        wrong,
        revealed: 0,
        skipped: 0,
        examMode: plan.daysAgo === 4, // one batch in exam mode
        qids: sample.map(q => q.id),
        selections,
        correctIdxByQ,
        correctMap,
        startedAt: batchTs,
        endedAt: batchTs + 30 * 60 * 1000,
      });
    }

    // Sort attempts chronologically
    attempts.sort((a, b) => a.ts - b.ts);

    // Persist (demo seed is always for the built-in tohna1 course)
    Progress.save(uid, {
      attempts,
      batches,
      reviewQueue,
    }, 'tohna1');
    DemoSeed.markSeeded(uid);
  },
};

// ===== Local progress storage (per-course) =====
const Progress = {
  KEY(uid, courseId) { return `ep_progress_${uid}_${courseId || state.course?.id || 'tohna1'}`; },
  _migrated: new Set(),

  // One-time migration: move data from the old single-course key to the new per-course key.
  _migrate(uid) {
    if (this._migrated.has(uid)) return;
    this._migrated.add(uid);
    const oldKey = `ep_progress_${uid}`;
    try {
      const old = localStorage.getItem(oldKey);
      if (old && !localStorage.getItem(this.KEY(uid, 'tohna1'))) {
        localStorage.setItem(this.KEY(uid, 'tohna1'), old);
        localStorage.removeItem(oldKey);
      }
    } catch {}
  },

  load(uid, courseId) {
    this._migrate(uid);
    const key = this.KEY(uid, courseId);
    try { return JSON.parse(localStorage.getItem(key)) || {}; }
    catch { return { attempts: [], reviewQueue: [], batches: [] }; }
  },
  // Maximum number of attempts to keep per course. Beyond this we drop the
  // oldest entries on save. iOS Safari private mode has a ~5MB localStorage
  // quota and a heavy user could otherwise hit it and fail every subsequent
  // save silently.
  MAX_ATTEMPTS_PER_COURSE: 1000,
  MAX_BATCHES_PER_COURSE: 200,
  _trim(data) {
    if (data.attempts && data.attempts.length > this.MAX_ATTEMPTS_PER_COURSE) {
      data.attempts = data.attempts.slice(-this.MAX_ATTEMPTS_PER_COURSE);
    }
    if (data.batches && data.batches.length > this.MAX_BATCHES_PER_COURSE) {
      data.batches = data.batches.slice(-this.MAX_BATCHES_PER_COURSE);
    }
    return data;
  },
  save(uid, data, courseId) {
    const key = this.KEY(uid, courseId);
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(e.message || ''))) {
        // Trim progressively: first to the configured max, then half, then 1/4.
        const trims = [1, 0.5, 0.25];
        for (const factor of trims) {
          const trimmed = {
            ...data,
            attempts: (data.attempts || []).slice(-Math.floor(this.MAX_ATTEMPTS_PER_COURSE * factor)),
            batches: (data.batches || []).slice(-Math.floor(this.MAX_BATCHES_PER_COURSE * factor)),
          };
          try {
            localStorage.setItem(key, JSON.stringify(trimmed));
            if (typeof toast === 'function') {
              toast('זיכרון מקומי מתמלא — נמחקו נתוני תרגול ישנים', '');
            }
            if (window.__reportClientError) {
              window.__reportClientError('quota-trim', {
                msg: `Progress localStorage quota hit — trimmed to ${factor * 100}%`,
              });
            }
            return;
          } catch {}
        }
        // Last resort — silently drop the write. Never throw.
        if (window.__reportClientError) {
          window.__reportClientError('quota-fail', { msg: 'Progress.save: quota even at 25% trim' });
        }
        return;
      }
      throw e;
    }
  },
  recordAttempt(uid, attempt, courseId) {
    const cid = courseId || state.course?.id || 'tohna1';
    const p = this.load(uid, cid);
    p.attempts = p.attempts || [];
    p.attempts.push({ ...attempt, ts: Date.now() });
    if (!attempt.isCorrect || attempt.revealed) {
      p.reviewQueue = p.reviewQueue || [];
      if (!p.reviewQueue.includes(attempt.questionId)) p.reviewQueue.push(attempt.questionId);
    } else {
      p.reviewQueue = (p.reviewQueue || []).filter(id => id !== attempt.questionId);
    }
    this.save(uid, p, cid);

    // Dual-write to Supabase (fire-and-forget, non-blocking)
    if (cid !== 'tohna1') {
      Auth.getToken().then(token => {
        if (!token) return;
        fetch('/api/attempt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            questionId: attempt.questionId,
            courseId: cid,
            selectedIdx: attempt.selectedIdx,
            isCorrect: attempt.isCorrect,
            revealed: attempt.revealed,
            timeSeconds: attempt.timeSeconds,
            batchId: attempt.batchId,
          }),
        }).catch(() => {}); // silently fail — localStorage is the fallback
      });
    }
  },
  saveBatch(uid, batch, courseId) {
    const p = this.load(uid, courseId);
    p.batches = p.batches || [];
    p.batches.push(batch);
    this.save(uid, p, courseId);
    // The row was created at startQuiz() via /api/batches/start. Final totals
    // are pushed by finalizeBatch(). We intentionally don't POST here to avoid
    // a duplicate primary-key error.
  },
  finalizeBatch(uid, batch, courseId) {
    // Called when the session ends (user finishes or exits). Pushes final
    // totals to the server so the cloud-synced row has accurate numbers.
    if (!courseId || courseId === 'tohna1' || !batch?.batchId) return;
    Auth.getToken().then(token => {
      if (!token) return;
      fetch('/api/batches/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          id: batch.batchId,
          correct: batch.correct || 0,
          wrong: batch.wrong || 0,
          selections: batch.selections || {},
          correctMap: batch.correctMap || {},
          endedAt: batch.endedAt ? new Date(batch.endedAt).toISOString() : new Date().toISOString(),
        }),
      }).catch(() => {});
    });
  },
  async fetchRemoteBatches(courseId, limit = 10) {
    if (!courseId || courseId === 'tohna1') return [];
    try {
      const token = await Auth.getToken();
      if (!token) return [];
      const r = await fetch(`/api/courses/${encodeURIComponent(courseId)}/batches`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return [];
      const rows = await r.json();
      // Map server shape → client shape used by rendering.
      return (rows || []).slice(0, limit).map(b => ({
        batchId: b.id,
        size: b.size,
        correct: b.correct,
        wrong: b.wrong,
        examMode: !!b.exam_mode,
        qids: b.qids || [],
        selections: b.selections || {},
        correctMap: b.correct_map || {},
        startedAt: b.started_at ? +new Date(b.started_at) : null,
        endedAt: b.ended_at ? +new Date(b.ended_at) : null,
      }));
    } catch { return []; }
  },
  stats(uid, courseId) {
    const p = this.load(uid, courseId);
    const attempts = p.attempts || [];
    const seen = new Set(attempts.map(a => a.questionId));
    const correctIds = new Set(attempts.filter(a => a.isCorrect && !a.revealed).map(a => a.questionId));
    const wrong = [...seen].filter(id => !correctIds.has(id));
    return {
      total: attempts.length,
      unique: seen.size,
      correct: correctIds.size,
      wrong: wrong.length,
      reviewCount: (p.reviewQueue || []).length,
    };
  },
  // DB-authoritative stats for the dashboard. Returns the last known summary
  // immediately if cached; always kicks off a fresh fetch and updates state
  // once it lands. The dashboard awaits this so it re-renders with live data.
  async fetchSummary() {
    try {
      const token = await Auth.getToken();
      if (!token) return null;
      const r = await fetch('/api/stats/summary', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return state.statsSummary; // keep prior cache on transient error
      const data = await r.json();
      state.statsSummary = data;
      return data;
    } catch {
      return state.statsSummary;
    }
  },
  invalidateSummary() { state.statsSummary = null; },
  history(uid, courseId) { return (this.load(uid, courseId).attempts || []); },
};

// ===== Plans / quotas (mirrors server.mjs intent) =====
const PLANS = {
  trial: { name: 'ניסיון (14 ימים)', canPractice: true, canAI: true, maxCourses: 5 },
  free:  { name: 'Free', canPractice: true, canAI: true, maxCourses: 5 },
  basic: { name: 'Basic', canPractice: true, canAI: true, maxCourses: 10 },
  pro:   { name: 'Pro', canPractice: true, canAI: true, maxCourses: -1 },
  education: { name: 'Education', canPractice: true, canAI: true, maxCourses: -1 },
};

// ===== Utility =====
function tmpl(id) {
  const t = document.getElementById(id);
  if (!t) throw new Error('Missing template: ' + id);
  return t.content.cloneNode(true);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Render solution text: supports $inline$ and $$display$$ LaTeX via KaTeX,
// **bold**, and newlines as <br>. When KaTeX isn't available yet we emit a
// placeholder span that the observer below auto-upgrades once KaTeX loads.
// Convert common Unicode math characters + inline math patterns (like L_1,
// U/∪/∩, ∈, ⊆ etc.) into $...$-wrapped LaTeX so renderSolutionText can hand
// them off to KaTeX. Idempotent — if the text already uses $...$ wrapping
// we leave it alone.
const _UNI_TO_TEX = {
  '∈': '\\in', '∉': '\\notin',
  '∪': '\\cup', '∩': '\\cap',
  '⊆': '\\subseteq', '⊂': '\\subset', '⊇': '\\supseteq', '⊃': '\\supset',
  '≠': '\\neq', '≥': '\\geq', '≤': '\\leq',
  '×': '\\times', '÷': '\\div', '·': '\\cdot',
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow',
  '∧': '\\land', '∨': '\\lor', '¬': '\\neg',
  '∀': '\\forall', '∃': '\\exists', '∅': '\\emptyset',
  '∞': '\\infty', '√': '\\surd',
  'Σ': '\\Sigma', 'Π': '\\Pi', 'Δ': '\\Delta', 'Ω': '\\Omega', 'Φ': '\\Phi',
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
  'ε': '\\varepsilon', 'θ': '\\theta', 'λ': '\\lambda', 'μ': '\\mu',
  'π': '\\pi', 'ρ': '\\rho', 'σ': '\\sigma', 'τ': '\\tau',
  'φ': '\\varphi', 'ψ': '\\psi', 'ω': '\\omega',
};
const _MATH_UNI_RE = /[∈∉∪∩⊆⊂⊇⊃≠≥≤×÷·→←↔⇒⇐⇔∧∨¬∀∃∅∞√ΣΠΔΩΦαβγδεθλμπρστφψω]/;
const _UNI_TO_TEX_RE = /[∈∉∪∩⊆⊂⊇⊃≠≥≤×÷·→←↔⇒⇐⇔∧∨¬∀∃∅∞√ΣΠΔΩΦαβγδεθλμπρστφψω]/g;
const _HEBREW_RE = /[֐-׿]/;
const _MATH_MARKER_RE = /[_^\\∈∉∪∩⊆⊂⊇⊃≠≥≤×÷·→←↔⇒⇐⇔∧∨¬∀∃∅∞√]/;
function autoMathify(text) {
  if (typeof text !== 'string' || !text) return text || '';
  // Respect existing $...$ wrapping — author already marked math explicitly.
  if (/\$[^$\n]+?\$/.test(text)) return text;

  // Walk char-by-char. Each maximal run of non-Hebrew chars that contains at
  // least one math marker gets Unicode → LaTeX-substituted and wrapped in $...$.
  // Hebrew runs and mark-free ASCII runs pass through untouched.
  const out = [];
  let buf = '';
  let bufHebrew = null;

  function flush() {
    if (!buf) return;
    if (bufHebrew === false && _MATH_MARKER_RE.test(buf)) {
      const leading  = buf.match(/^\s*/)[0];
      const trailing = buf.match(/\s*$/)[0];
      let inner = buf.slice(leading.length, buf.length - trailing.length);
      inner = inner.replace(_UNI_TO_TEX_RE, ch => ' ' + (_UNI_TO_TEX[ch] || ch) + ' ');
      // Treat common CS complexity classes as upright operator names so they
      // don't render as italic letter-by-letter (coRE → c·o·R·E). Ordered
      // longest-first so coRE matches before RE, coNP before NP, etc.
      const CS_OPS = ['coNPC', 'coNP', 'coRE', 'NPC', 'NP', 'RE', 'PSPACE', 'EXPTIME', 'EXPSPACE', 'LOGSPACE', 'NLOGSPACE', 'ACC'];
      for (const name of CS_OPS) {
        inner = inner.replace(new RegExp('\\b' + name + '\\b', 'g'), `\\mathrm{${name}}`);
      }
      inner = inner.replace(/\s+/g, ' ').trim();
      out.push(leading + '$' + inner + '$' + trailing);
    } else {
      out.push(buf);
    }
    buf = '';
  }

  for (const ch of text) {
    // Whitespace + most punctuation are "neutral" — they attach to the
    // current run instead of triggering a Hebrew/non-Hebrew split.
    const isNeutral = /[\s,.;:!?()\[\]{}\-"']/.test(ch);
    if (isNeutral) {
      if (bufHebrew === null) bufHebrew = false; // start a non-Hebrew run by default
      buf += ch;
      continue;
    }
    const isHebrew = _HEBREW_RE.test(ch);
    if (bufHebrew === null) { bufHebrew = isHebrew; buf = ch; continue; }
    if (isHebrew !== bufHebrew) { flush(); bufHebrew = isHebrew; buf = ch; }
    else buf += ch;
  }
  flush();
  return out.join('');
}

function renderSolutionText(raw) {
  if (!raw) return '';
  raw = autoMathify(raw);
  const tokens = raw.split(/((?:\$\$[\s\S]+?\$\$|\$[^$\n]+?\$))/);
  return tokens.map(tok => {
    if (tok.startsWith('$$') && tok.endsWith('$$') && tok.length > 4) {
      return renderTexToken(tok.slice(2, -2), true);
    }
    if (tok.startsWith('$') && tok.endsWith('$') && tok.length > 2) {
      return renderTexToken(tok.slice(1, -1), false);
    }
    let h = escapeHtml(tok);
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\n/g, '<br>');
    return h;
  }).join('');
}

function renderTexToken(tex, displayMode) {
  if (window.katex) {
    try { return window.katex.renderToString(tex, { displayMode, throwOnError: false }); }
    catch { /* fall through to pending placeholder */ }
  }
  const disp = displayMode ? '1' : '0';
  return `<span class="tex-pending" data-tex="${escapeHtml(tex)}" data-display="${disp}">${escapeHtml(displayMode ? '$$' + tex + '$$' : '$' + tex + '$')}</span>`;
}

function upgradePendingTex(root) {
  if (!window.katex) return;
  const scope = root || document;
  const nodes = scope.querySelectorAll ? scope.querySelectorAll('.tex-pending') : [];
  nodes.forEach(el => {
    const tex = el.getAttribute('data-tex') || '';
    const disp = el.getAttribute('data-display') === '1';
    try {
      const html = window.katex.renderToString(tex, { displayMode: disp, throwOnError: false });
      const wrap = document.createElement('span');
      wrap.innerHTML = html;
      el.replaceWith(...wrap.childNodes);
    } catch {
      el.classList.remove('tex-pending');
      el.classList.add('tex-failed');
    }
  });
}

(function wireKatexUpgrade() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const tryUpgrade = () => upgradePendingTex(document);
  if (window.katex) { tryUpgrade(); }
  else {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (window.katex) { clearInterval(iv); tryUpgrade(); }
      else if (tries > 200) { clearInterval(iv); } // ~10s
    }, 50);
  }
  try {
    const mo = new MutationObserver(muts => {
      if (!window.katex) return;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!n || n.nodeType !== 1) continue;
          if (n.classList?.contains('tex-pending')) { upgradePendingTex(n.parentNode || document); continue; }
          if (n.querySelector?.('.tex-pending')) upgradePendingTex(n);
        }
      }
    });
    const start = () => mo.observe(document.body, { childList: true, subtree: true });
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  } catch {}
})();

// Shared overlay that shows the set-context reference image (scenario / data
// table / code block) for a grouped question. Used by both quiz renderers
// (lightbox + slider) and the file-manager thumbnail button.
function openSetContextModal(url, text, qNum) {
  const hasImg = url && String(url).startsWith('http');
  const hasText = text && String(text).trim().length > 0;
  if (!hasImg && !hasText) return;
  const overlay = document.createElement('div');
  overlay.className = 'set-context-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:99999;display:grid;place-items:center;padding:20px;cursor:zoom-out;';
  overlay.innerHTML = `
    <div style="background:white;border-radius:12px;padding:16px;max-width:min(90vw,900px);max-height:90vh;overflow:auto;cursor:default;direction:rtl;" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div style="font-size:14px;font-weight:600;color:#1e40af;">מידע לסט השאלות${qNum ? ' — רפרנס לשאלה #' + escapeHtml(String(qNum)) : ''}</div>
        <button type="button" style="background:none;border:none;cursor:pointer;font-size:22px;color:#6b7280;" title="סגור">×</button>
      </div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">זהו המידע המשותף (תיאור הניסוי / טבלת נתונים / קוד / קטע) שמשמש את כל השאלות בסט.</div>
      ${hasImg ? `<img src="${url}" alt="רפרנס לסט" style="width:100%;display:block;border-radius:8px;border:1px solid #e5e7eb;${hasText ? 'margin-bottom:12px;' : ''}" />` : ''}
      ${hasText ? `<div style="font-size:15px;line-height:1.7;direction:rtl;color:#1e293b;">${renderSolutionText(String(text).trim())}</div>` : ''}
    </div>
  `;
  const close = () => overlay.remove();
  overlay.addEventListener('click', close);
  overlay.querySelector('button[title="סגור"]').addEventListener('click', close);
  const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  document.body.appendChild(overlay);
}
// Upload with real XHR byte-level progress tracking.
// Returns { ok, status, data }. The returned promise has an .abort() method.
function uploadWithProgress({ url, headers, body, onUploadProgress, onUploadDone, timeoutMs = 180000 }) {
  let xhrRef = null;
  const promise = new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef = xhr;
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers || {})) {
      if (k.toLowerCase() === 'content-type' && body instanceof FormData) continue;
      xhr.setRequestHeader(k, v);
    }
    let uploadFinished = false;
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onUploadProgress) onUploadProgress(e.loaded, e.total);
    });
    xhr.upload.addEventListener('load', () => {
      if (!uploadFinished) { uploadFinished = true; if (onUploadDone) onUploadDone(); }
    });
    xhr.addEventListener('load', () => {
      let json;
      try { json = JSON.parse(xhr.responseText); } catch { json = {}; }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: json });
    });
    xhr.addEventListener('error', () => reject(new Error('שגיאת רשת')));
    xhr.addEventListener('abort', () => reject(new Error('__aborted__')));
    xhr.addEventListener('timeout', () => reject(new Error('ההעלאה נמשכה יותר מדי זמן')));
    xhr.timeout = timeoutMs;
    xhr.send(body);
  });
  promise.abort = () => { if (xhrRef) xhrRef.abort(); };
  return promise;
}

// Render a PDF page to a canvas element using PDF.js (loaded from CDN as pdfjsLib global)
const _pdfDocCache = {};
const _pdfCanvasCache = {};
async function renderPdfPage(pdfUrl, pageNum, scale = 1.5) {
  const cacheKey = `${pdfUrl}:${pageNum}:${scale}`;
  if (_pdfCanvasCache[cacheKey]) {
    // Return a copy of the cached canvas as an image
    const img = document.createElement('img');
    img.src = _pdfCanvasCache[cacheKey];
    return img;
  }
  try {
    if (!window.pdfjsLib) { console.error('[renderPdfPage] pdfjsLib not loaded'); return null; }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    // Cache the PDF document to avoid re-downloading
    if (!_pdfDocCache[pdfUrl]) {
      _pdfDocCache[pdfUrl] = await window.pdfjsLib.getDocument(pdfUrl).promise;
    }
    const doc = _pdfDocCache[pdfUrl];
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    // Cache as data URL for reuse
    _pdfCanvasCache[cacheKey] = canvas.toDataURL('image/png');
    return canvas;
  } catch (e) {
    console.error('[renderPdfPage]', e.message, 'url:', pdfUrl, 'page:', pageNum);
    return null;
  }
}

// Build the PDF URL from Supabase for a given exam
function examPdfUrl(userId, examId) {
  const sbUrl = window._sbConfig?.SUPABASE_URL || window.APP_CONFIG?.SUPABASE_URL || '';
  return `${sbUrl}/storage/v1/object/public/exam-pages/exams/${userId}/${examId}/exam.pdf`;
}

// Derive the raw Cloudinary PDF URL from a question's image_path. The image_path
// is a Cloudinary crop transform over the original PDF — we strip the transforms
// and swap the extension to .pdf. Returns null when the URL doesn't match the
// expected Cloudinary pattern (e.g. text-only questions).
function cloudinaryPdfUrlFromImagePath(imagePath) {
  if (typeof imagePath !== 'string') return null;
  const cloudM = imagePath.match(/^https:\/\/res\.cloudinary\.com\/([^/]+)\//);
  if (!cloudM) return null;
  const idM = imagePath.match(/\/q_auto\/(.+?)\.(?:png|jpg|jpeg)(?:\?|$)/);
  if (!idM) return null;
  return `https://res.cloudinary.com/${cloudM[1]}/image/upload/${idM[1]}.pdf`;
}

// Build the solution-PDF URL by swapping the publicId segment to the one
// stored on the exam row. Callers that only have the question's image_path
// should pass the solution pdf publicId explicitly — see openSolutionViewer.
function cloudinaryPdfUrlFromPublicId(cloudName, publicId) {
  if (!cloudName || !publicId) return null;
  return `https://res.cloudinary.com/${cloudName}/image/upload/${publicId}.pdf`;
}

// =====================================================
// PdfCropTool — shared full-screen modal that renders a PDF page with PDF.js
// and lets the user drag out a rectangle to crop (mode='crop') or just view
// (mode='view'). Used by:
//   - "צלם מחדש" (reshoot question — mode='crop')
//   - "תקן תשובה" (solution viewer — mode='view', with right-side radios panel)
//   - "+ הוסף מידע נלווה" (context creation — mode='crop')
//
// API:
//   const tool = openPdfCropTool({
//     pdfUrl, initialPage=1, mode='crop', title='',
//     hint='', showConfidenceBanner=false,
//     rightPanel=null,  // optional DOM node rendered beside the viewer
//     saveLabel='שמור חיתוך', allowEmptySave=false,
//     onSave: async ({page, xNorm, yNorm, wNorm, hNorm, totalPages}) => void|false,
//     onCancel: () => void,
//   });
//   tool.close();  // programmatic close
//
// onSave returning `false` (sync or async) prevents the modal from closing —
// useful for showing validation errors inline.
// =====================================================
function openPdfCropTool(opts = {}) {
  const {
    pdfUrl,
    initialPage = 1,
    mode = 'crop',
    title = 'חיתוך',
    hint = '',
    showConfidenceBanner = false,
    rightPanel = null,
    saveLabel = 'שמור חיתוך',
    allowEmptySave = false,
    onSave,
    onCancel,
  } = opts;

  if (!pdfUrl) {
    toast('לא נמצא קובץ PDF לחיתוך', 'error');
    if (typeof onCancel === 'function') onCancel();
    return { close() {} };
  }
  if (!window.pdfjsLib) {
    toast('הכלי לחיתוך PDF עוד לא נטען — נסה שוב בעוד רגע', 'error');
    if (typeof onCancel === 'function') onCancel();
    return { close() {} };
  }

  // --- state ---
  let currentPage = Math.max(1, parseInt(initialPage, 10) || 1);
  let totalPages = null;
  let selRect = null; // { x, y, w, h } in canvas CSS pixels; null = no selection
  let isBusy = false;
  let zoom = 1; // 1 = auto-fit to stage width; user can zoom in/out via +/-

  // --- DOM ---
  const overlay = document.createElement('div');
  overlay.className = 'pdf-crop-overlay';
  overlay.innerHTML = `
    <div class="pdf-crop-shell">
      <header class="pdf-crop-header">
        <div class="pdf-crop-title">${escapeHtml(title)}</div>
        <button type="button" class="pdf-crop-close" title="סגור" aria-label="סגור">×</button>
      </header>
      ${showConfidenceBanner ? `
        <div class="pdf-crop-banner" role="alert">
          העמוד זוהה אוטומטית — אם לא רואים את הפריט הנכון, דפדפו בחצים.
        </div>` : ''}
      ${hint ? `<div class="pdf-crop-hint">${escapeHtml(hint)}</div>` : ''}
      <div class="pdf-crop-body">
        <div class="pdf-crop-stage">
          <div class="pdf-crop-canvas-wrap" tabindex="0">
            <div class="pdf-crop-loading">טוען עמוד...</div>
          </div>
        </div>
        ${rightPanel ? `<aside class="pdf-crop-side"></aside>` : ''}
      </div>
      <footer class="pdf-crop-footer">
        <div class="pdf-crop-pagenav">
          <button type="button" class="pdf-crop-prev" title="עמוד קודם">→</button>
          <span class="pdf-crop-pagelabel">עמוד <input type="number" class="pdf-crop-pageinp" min="1" value="${currentPage}" /> <span class="pdf-crop-pagetotal"></span></span>
          <button type="button" class="pdf-crop-next" title="עמוד הבא">←</button>
          <span class="pdf-crop-zoombar">
            <button type="button" class="pdf-crop-zoomout" title="הקטן">−</button>
            <span class="pdf-crop-zoomlabel">100%</span>
            <button type="button" class="pdf-crop-zoomin" title="הגדל">+</button>
          </span>
          ${mode === 'crop' ? '<button type="button" class="pdf-crop-reset" title="נקה חיתוך">אפס חיתוך</button>' : ''}
        </div>
        <div class="pdf-crop-actions">
          <button type="button" class="btn btn-ghost btn-sm pdf-crop-cancel">בטל</button>
          <button type="button" class="btn btn-primary btn-sm pdf-crop-save">${escapeHtml(saveLabel)}</button>
        </div>
      </footer>
    </div>
  `;
  if (rightPanel instanceof HTMLElement) {
    overlay.querySelector('.pdf-crop-side').appendChild(rightPanel);
  }

  const canvasWrap = overlay.querySelector('.pdf-crop-canvas-wrap');
  const stageEl    = overlay.querySelector('.pdf-crop-stage');
  const pageInp    = overlay.querySelector('.pdf-crop-pageinp');
  const pageTotal  = overlay.querySelector('.pdf-crop-pagetotal');
  const prevBtn    = overlay.querySelector('.pdf-crop-prev');
  const nextBtn    = overlay.querySelector('.pdf-crop-next');
  const resetBtn   = overlay.querySelector('.pdf-crop-reset');
  const saveBtn    = overlay.querySelector('.pdf-crop-save');
  const cancelBtn  = overlay.querySelector('.pdf-crop-cancel');
  const closeBtn   = overlay.querySelector('.pdf-crop-close');
  const zoomInBtn  = overlay.querySelector('.pdf-crop-zoomin');
  const zoomOutBtn = overlay.querySelector('.pdf-crop-zoomout');
  const zoomLabel  = overlay.querySelector('.pdf-crop-zoomlabel');

  let pdfDoc = null;
  let currentCanvas = null;

  function close() {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    overlay.remove();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
    else if (e.key === 'Enter' && e.target === document.body) { e.preventDefault(); saveBtn.click(); }
    else if (e.key === 'ArrowLeft')  { nextBtn.click(); }  // RTL: left = next
    else if (e.key === 'ArrowRight') { prevBtn.click(); }
  }

  async function loadPdf() {
    try {
      pdfDoc = await window.pdfjsLib.getDocument(pdfUrl).promise;
      totalPages = pdfDoc.numPages || 1;
      pageTotal.textContent = `מתוך ${totalPages}`;
      pageInp.max = String(totalPages);
      if (currentPage > totalPages) currentPage = totalPages;
      await renderCurrent();
    } catch (e) {
      console.error('[PdfCropTool] load failed', e);
      canvasWrap.innerHTML = `<div class="pdf-crop-err">שגיאה בטעינת ה-PDF (${escapeHtml(e?.message || 'unknown')}). נסה לרענן.</div>`;
    }
  }

  async function renderCurrent() {
    selRect = null;
    canvasWrap.innerHTML = '<div class="pdf-crop-loading">טוען עמוד...</div>';
    try {
      const page = await pdfDoc.getPage(currentPage);
      // Measure the STAGE container (not the wrap — wrap is inline-block
      // around a tiny placeholder so its clientWidth is near zero at this
      // moment). Stage is flex:1 and fills the body, so its clientWidth is
      // the real available viewport width.
      const stageRect = stageEl.getBoundingClientRect();
      const padding = 32; // matches .pdf-crop-stage padding on both sides
      const availW = Math.max(280, Math.floor(stageRect.width - padding));
      // On narrow screens, use nearly all available width. On wide screens,
      // cap at 1400 so ultra-wide monitors don't render a huge blurry PDF.
      const fitW = Math.min(availW, 1400);
      const viewport1 = page.getViewport({ scale: 1 });
      const cssScale = (fitW / viewport1.width) * zoom;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: cssScale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width  = (viewport1.width * cssScale) + 'px';
      canvas.style.height = (viewport1.height * cssScale) + 'px';
      canvas.className = 'pdf-crop-canvas';
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      canvasWrap.innerHTML = '';
      canvasWrap.appendChild(canvas);
      currentCanvas = canvas;
      if (mode === 'crop') attachCropOverlay();
      pageInp.value = String(currentPage);
      if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + '%';
    } catch (e) {
      console.error('[PdfCropTool] render failed', e);
      canvasWrap.innerHTML = `<div class="pdf-crop-err">שגיאה בטעינת עמוד ${currentPage}.</div>`;
    }
  }

  function attachCropOverlay() {
    // Interactive rectangle overlay over currentCanvas.
    const layer = document.createElement('div');
    layer.className = 'pdf-crop-layer';
    canvasWrap.appendChild(layer);

    const rectEl = document.createElement('div');
    rectEl.className = 'pdf-crop-rect';
    rectEl.style.display = 'none';
    layer.appendChild(rectEl);

    // 8 resize handles (corners + mid-edges).
    const handleKinds = ['nw','n','ne','e','se','s','sw','w'];
    const handles = {};
    for (const k of handleKinds) {
      const h = document.createElement('div');
      h.className = `pdf-crop-handle pdf-crop-handle-${k}`;
      h.dataset.kind = k;
      rectEl.appendChild(h);
      handles[k] = h;
    }

    function bounds() {
      const r = currentCanvas.getBoundingClientRect();
      const lr = layer.getBoundingClientRect();
      return { w: r.width, h: r.height, lrLeft: lr.left, lrTop: lr.top };
    }

    function paintRect() {
      if (!selRect) { rectEl.style.display = 'none'; return; }
      rectEl.style.display = 'block';
      rectEl.style.left   = selRect.x + 'px';
      rectEl.style.top    = selRect.y + 'px';
      rectEl.style.width  = selRect.w + 'px';
      rectEl.style.height = selRect.h + 'px';
    }

    // ── pointer behavior ────────────────────────────────────────────────
    let drag = null;  // { mode:'new'|'move'|'resize', kind, startX, startY, origRect }
    function getXY(ev) {
      const b = bounds();
      return { x: ev.clientX - b.lrLeft, y: ev.clientY - b.lrTop, b };
    }
    function onDown(ev) {
      if (ev.button && ev.button !== 0) return;
      const t = ev.target;
      const { x, y } = getXY(ev);
      ev.preventDefault();
      layer.setPointerCapture?.(ev.pointerId);
      if (t.classList.contains('pdf-crop-handle')) {
        drag = { mode: 'resize', kind: t.dataset.kind, startX: x, startY: y, origRect: { ...selRect } };
      } else if (selRect && x >= selRect.x && x <= selRect.x + selRect.w && y >= selRect.y && y <= selRect.y + selRect.h) {
        drag = { mode: 'move', startX: x, startY: y, origRect: { ...selRect } };
      } else {
        selRect = { x, y, w: 0, h: 0 };
        drag = { mode: 'new', startX: x, startY: y };
      }
    }
    function onMove(ev) {
      if (!drag) return;
      const { x, y, b } = getXY(ev);
      if (drag.mode === 'new') {
        const nx = Math.min(drag.startX, x), ny = Math.min(drag.startY, y);
        const nw = Math.max(2, Math.abs(x - drag.startX)), nh = Math.max(2, Math.abs(y - drag.startY));
        selRect = clampRect({ x: nx, y: ny, w: nw, h: nh }, b);
      } else if (drag.mode === 'move') {
        const dx = x - drag.startX, dy = y - drag.startY;
        const r = { x: drag.origRect.x + dx, y: drag.origRect.y + dy, w: drag.origRect.w, h: drag.origRect.h };
        r.x = Math.max(0, Math.min(b.w - r.w, r.x));
        r.y = Math.max(0, Math.min(b.h - r.h, r.y));
        selRect = r;
      } else if (drag.mode === 'resize') {
        const o = drag.origRect;
        const k = drag.kind;
        let { x: nx, y: ny, w: nw, h: nh } = o;
        if (k.includes('e')) nw = Math.max(10, x - o.x);
        if (k.includes('s')) nh = Math.max(10, y - o.y);
        if (k.includes('w')) { const right = o.x + o.w; nx = Math.min(x, right - 10); nw = right - nx; }
        if (k.includes('n')) { const bot = o.y + o.h;   ny = Math.min(y, bot   - 10); nh = bot   - ny; }
        selRect = clampRect({ x: nx, y: ny, w: nw, h: nh }, b);
      }
      paintRect();
    }
    function onUp(ev) {
      drag = null;
      layer.releasePointerCapture?.(ev.pointerId);
      // If the user just clicked without dragging, discard trivial selection.
      if (selRect && (selRect.w < 10 || selRect.h < 10)) { selRect = null; paintRect(); }
    }
    function clampRect(r, b) {
      const x = Math.max(0, Math.min(b.w - 10, r.x));
      const y = Math.max(0, Math.min(b.h - 10, r.y));
      const w = Math.max(10, Math.min(b.w - x, r.w));
      const h = Math.max(10, Math.min(b.h - y, r.h));
      return { x, y, w, h };
    }
    layer.addEventListener('pointerdown', onDown);
    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerup',   onUp);
    layer.addEventListener('pointercancel', onUp);
  }

  // --- page nav ---
  function gotoPage(p) {
    if (!Number.isFinite(p) || p < 1 || (totalPages && p > totalPages)) return;
    currentPage = p;
    renderCurrent();
  }
  prevBtn.addEventListener('click', () => gotoPage(currentPage - 1));
  nextBtn.addEventListener('click', () => gotoPage(currentPage + 1));
  pageInp.addEventListener('change', () => gotoPage(parseInt(pageInp.value, 10)));
  if (resetBtn) resetBtn.addEventListener('click', () => { selRect = null; const rectEl = canvasWrap.querySelector('.pdf-crop-rect'); if (rectEl) rectEl.style.display = 'none'; });

  // Zoom controls — each step is 25%, clamped [0.5, 3].
  if (zoomInBtn) zoomInBtn.addEventListener('click', () => {
    zoom = Math.min(3, +(zoom + 0.25).toFixed(2));
    renderCurrent();
  });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => {
    zoom = Math.max(0.5, +(zoom - 0.25).toFixed(2));
    renderCurrent();
  });

  // Re-render on viewport resize so the fit-to-width math updates (e.g. user
  // rotates their phone). Debounced to avoid thrash while dragging windows.
  let resizeT = null;
  const onResize = () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (pdfDoc) renderCurrent(); }, 160);
  };
  window.addEventListener('resize', onResize);

  // --- actions ---
  async function doSave() {
    if (isBusy) return;
    let payload;
    if (mode === 'crop') {
      if (!selRect && !allowEmptySave) {
        toast('סמן אזור לחיתוך עם העכבר לפני השמירה', 'error');
        return;
      }
      let norm = null;
      if (selRect && currentCanvas) {
        const rect = currentCanvas.getBoundingClientRect();
        norm = {
          xNorm: selRect.x / rect.width,
          yNorm: selRect.y / rect.height,
          wNorm: selRect.w / rect.width,
          hNorm: selRect.h / rect.height,
        };
      }
      payload = { page: currentPage, totalPages, ...(norm || {}) };
    } else {
      payload = { page: currentPage, totalPages };
    }
    if (typeof onSave !== 'function') { close(); return; }
    isBusy = true;
    saveBtn.disabled = true;
    const origText = saveBtn.textContent;
    saveBtn.innerHTML = '<span class="qv-spinner"></span> שומר...';
    try {
      const result = await onSave(payload);
      if (result === false) { // caller wants us to stay open
        isBusy = false; saveBtn.disabled = false; saveBtn.textContent = origText;
        return;
      }
      close();
    } catch (e) {
      console.error('[PdfCropTool] onSave threw', e);
      toast('שגיאה בשמירה', 'error');
      isBusy = false; saveBtn.disabled = false; saveBtn.textContent = origText;
    }
  }
  saveBtn.addEventListener('click', doSave);
  cancelBtn.addEventListener('click', () => { close(); if (typeof onCancel === 'function') onCancel(); });
  closeBtn.addEventListener('click', () => { close(); if (typeof onCancel === 'function') onCancel(); });

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  loadPdf();

  return { close, gotoPage, getPage: () => currentPage, getTotalPages: () => totalPages };
}

// Helper: extract a 1-based page number from a Cloudinary crop URL (`pg_{N}`).
function parsePgFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/pg_(\d+)[,/]/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// ─────────────────────────────────────────────────────────────────
// Flow: צלם מחדש (reshoot question — manual crop)
// Replaces the old Gemini-powered reanalyze mode:'image_only' flow.
// Opens the exam PDF at the page where the question lives, lets the
// user drag out a new rectangle, persists it as a Cloudinary transform URL.
// Self-heals pdf_page: the page the user cropped from becomes the new
// stored page (user_confirmed), overriding any stale detected value.
// ─────────────────────────────────────────────────────────────────
async function openReshootCropTool(q, onUpdated) {
  const pdfUrl = cloudinaryPdfUrlFromImagePath(q.image_path);
  if (!pdfUrl) {
    toast('לשאלה זו אין קובץ מקור ב-Cloudinary — לא ניתן לחתוך ידנית', 'error');
    return;
  }
  const initialPage = q.pdf_page || parsePgFromUrl(q.image_path) || 1;
  const needsBanner = q.pdf_page_confidence !== 'user_confirmed';
  const preview = (q.question_text || '').toString().slice(0, 140);
  openPdfCropTool({
    pdfUrl,
    initialPage,
    mode: 'crop',
    title: `חיתוך שאלה #${q.question_number || ''}`,
    hint: preview ? `טקסט השאלה הצפוי: ${preview}` : 'גררו עם העכבר לסימון אזור החיתוך',
    showConfidenceBanner: needsBanner,
    saveLabel: 'שמור חיתוך',
    onSave: async ({ page, xNorm, yNorm, wNorm, hNorm }) => {
      const tk = await Auth.getToken();
      if (!tk) { toast('תוקף ההתחברות פג. התחבר שוב.', 'error'); return false; }
      const r = await fetch(`/api/questions/${encodeURIComponent(q.id)}/recrop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, xNorm, yNorm, wNorm, hNorm }),
      });
      let data = {};
      try { data = await r.json(); } catch {}
      if (!r.ok || !data.ok) {
        toast([data.error, data.detail].filter(Boolean).join(' — ') || `שגיאה (${r.status})`, 'error');
        return false;
      }
      // Mutate the question object in place so the caller's view updates.
      q.image_path = data.image_path;
      q.pdf_page = data.pdf_page;
      q.pdf_page_confidence = 'user_confirmed';
      toast('התמונה עודכנה בהצלחה', 'success');
      if (typeof onUpdated === 'function') onUpdated(q, data);
    },
  });
}

// ─────────────────────────────────────────────────────────────────
// Flow: תקן תשובה (fix answer — manual with solution viewer)
// Opens a two-pane modal: solution PDF on the left (opens on the
// auto-detected solution page; yellow banner + page nav if not
// user-confirmed), and a right panel with the question stem + option
// radios. Save persists correct_idx AND the current page as
// solution_pdf_page (self-heal, user_confirmed).
// ─────────────────────────────────────────────────────────────────
async function openFixAnswerModal(q, courseId, onUpdated) {
  // Solution PDF URL — prefer exam.solution_pdf_path, fallback to exam_pdf_path.
  const tk = await Auth.getToken();
  if (!tk) { toast('תוקף ההתחברות פג. התחבר שוב.', 'error'); return; }

  // We don't have the exam row on hand here. Fetch it via the Cloudinary
  // publicId embedded in the question's image_path as a fallback, but best
  // to get it from the exam API. For simplicity we derive both PDFs from
  // image_path — they share the same Cloudinary cloud, and the backend has
  // the public_id. Since we don't currently expose solution_pdf_path to the
  // frontend, we fall back to exam_pdf if no separate solution exists.
  //
  // Get exam metadata via list-exams filter (expensive for a single row).
  // Simpler: fetch through list-questions returns the exam-level path via
  // a separate call. We expose it through a lightweight GET. For now,
  // request the question's exam directly via a minimal fetch.
  let solutionPdfUrl = null;
  try {
    const rExam = await fetch(`/api/courses/${courseId}/exams`, {
      headers: { Authorization: `Bearer ${tk}` },
    });
    if (rExam.ok) {
      const list = await rExam.json();
      const ex = (list?.exams || list || []).find(e => e.id === q.exam_id);
      const cloud = (q.image_path || '').match(/^https:\/\/res\.cloudinary\.com\/([^/]+)\//)?.[1];
      if (ex?.solution_pdf_path && cloud) {
        solutionPdfUrl = cloudinaryPdfUrlFromPublicId(cloud, ex.solution_pdf_path);
      } else if (ex?.exam_pdf_path && cloud) {
        solutionPdfUrl = cloudinaryPdfUrlFromPublicId(cloud, ex.exam_pdf_path);
      }
    }
  } catch (e) {
    console.warn('[fix-answer] exam lookup failed', e);
  }
  if (!solutionPdfUrl) {
    solutionPdfUrl = cloudinaryPdfUrlFromImagePath(q.image_path);
  }
  if (!solutionPdfUrl) {
    toast('קובץ הפתרונות לא זמין — לא ניתן להציג', 'error');
    return;
  }

  const initialPage = q.solution_pdf_page || q.pdf_page || parsePgFromUrl(q.image_path) || 1;
  const needsBanner = (q.solution_pdf_page_confidence || 'unknown') !== 'user_confirmed';

  // Build the right-side panel — minimal. Just the question number + one
  // radio per option, labeled only with the Hebrew letter (א/ב/ג/ד/...).
  // The user reads the actual question text and options from the solution
  // PDF on the left, so repeating them here would add noise without value.
  const numOpts = q.num_options || 4;
  const letters = ['א','ב','ג','ד','ה','ו','ז','ח','ט','י'];
  const currentIdx = q.correct_idx;
  const panel = document.createElement('div');
  panel.innerHTML = `
    <h3 style="font-size:16px;margin:0 0 4px;font-weight:700;">שאלה #${escapeHtml(String(q.question_number || ''))}</h3>
    <div style="font-size:13px;color:var(--gray-600);margin-bottom:16px;">בחרו את התשובה הנכונה לפי הפתרון שבעמוד:</div>
    <div class="fa-radios" style="display:flex;flex-direction:column;gap:8px;">
      ${Array.from({length: numOpts}, (_, i) => {
        const idx = i + 1;
        const letter = letters[i] || String(idx);
        const checked = currentIdx === idx ? 'checked' : '';
        return `
          <label style="display:flex;align-items:center;gap:12px;padding:14px 16px;border:1.5px solid var(--gray-200);border-radius:10px;cursor:pointer;font-size:18px;font-weight:700;${checked ? 'background:#eff6ff;border-color:#3b82f6;color:#1d4ed8;' : 'color:var(--gray-800);'}">
            <input type="radio" name="fa-answer" value="${idx}" ${checked} style="flex-shrink:0;width:18px;height:18px;cursor:pointer;" />
            <span>${letter}</span>
          </label>`;
      }).join('')}
    </div>
  `;

  openPdfCropTool({
    pdfUrl: solutionPdfUrl,
    initialPage,
    mode: 'view',
    title: `תקן תשובה — שאלה #${q.question_number || ''}`,
    hint: 'סקרו את הפתרון בעמוד משמאל (דפדפו לעמוד הנכון אם צריך) ובחרו את התשובה הנכונה מימין.',
    showConfidenceBanner: needsBanner,
    rightPanel: panel,
    saveLabel: 'שמור תשובה',
    onSave: async ({ page }) => {
      const selected = panel.querySelector('input[name="fa-answer"]:checked');
      if (!selected) { toast('בחרו תשובה לפני השמירה', 'error'); return false; }
      const correctIdx = parseInt(selected.value, 10);
      const r = await fetch(`/api/courses/${courseId}/questions/${encodeURIComponent(q.id)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ correct_idx: correctIdx, solution_pdf_page: page }),
      });
      let data = {};
      try { data = await r.json(); } catch {}
      if (!r.ok || !data.ok) {
        toast(data.error || `שגיאה בשמירה (${r.status})`, 'error');
        return false;
      }
      q.correct_idx = correctIdx;
      q.answer_confidence = 'manual';
      q.solution_pdf_page = page;
      q.solution_pdf_page_confidence = 'user_confirmed';
      q.general_explanation = null;
      q.option_explanations = null;
      toast('התשובה נשמרה. צור הסבר מחדש כדי להתאים לתשובה החדשה.', 'success');
      if (typeof onUpdated === 'function') onUpdated(q, data);
    },
  });
}

// ─────────────────────────────────────────────────────────────────
// Flow: הוסף/חתוך-מחדש מידע נלווה (user-managed context image)
// Shared for two entry points:
//   - "+ הוסף מידע נלווה"           → opts = {} (new group_id)
//   - card action "חתוך מחדש"       → opts = { recropGroupId: 'U-abc' }
// After the user saves a crop, the question-picker modal opens to choose
// which exam questions this info applies to. Posts to /api/exams/:id/context.
// ─────────────────────────────────────────────────────────────────
function openContextCropTool(examId, examQs, opts, onDone) {
  const firstQ = (examQs || []).find(q => typeof q.image_path === 'string' && q.image_path.startsWith('http'));
  const pdfUrl = firstQ ? cloudinaryPdfUrlFromImagePath(firstQ.image_path) : null;
  if (!pdfUrl) {
    toast('קובץ המבחן לא זמין ב-Cloudinary — לא ניתן להוסיף מידע נלווה', 'error');
    return;
  }
  const initialPage = (firstQ && firstQ.pdf_page) || 1;

  openPdfCropTool({
    pdfUrl,
    initialPage,
    mode: 'crop',
    title: opts?.recropGroupId ? `חיתוך מחדש למידע: ${opts.recropGroupId}` : 'חיתוך מידע נלווה חדש',
    hint: 'סמנו את אזור המידע (טבלה / קטע / דיאגרמה) שרוצים לשתף בין מספר שאלות, ואז שמרו.',
    saveLabel: opts?.recropGroupId ? 'שמור חיתוך חדש' : 'המשך לבחירת שאלות',
    onSave: async ({ page, xNorm, yNorm, wNorm, hNorm }) => {
      if (opts?.recropGroupId) {
        // Recrop only — don't change question assignments.
        const tk = await Auth.getToken();
        const r = await fetch(`/api/exams/${examId}/context/${encodeURIComponent(opts.recropGroupId)}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ page, xNorm, yNorm, wNorm, hNorm }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) { toast(data.error || `שגיאה (${r.status})`, 'error'); return false; }
        toast('החיתוך של המידע עודכן', 'success');
        if (typeof onDone === 'function') onDone();
        return;
      }
      // New context: crop saved → proceed to question picker.
      openContextQuestionPicker(examId, examQs, null, async (questionIds) => {
        if (!questionIds || questionIds.length === 0) {
          toast('בחר לפחות שאלה אחת לשיוך', 'error');
          return false;
        }
        const tk = await Auth.getToken();
        const r = await fetch(`/api/exams/${examId}/context`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ page, xNorm, yNorm, wNorm, hNorm, questionIds }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) { toast(data.error || `שגיאה (${r.status})`, 'error'); return false; }
        toast(`נוסף מידע נלווה ושוייך ל-${data.assigned} שאלות`, 'success');
        if (typeof onDone === 'function') onDone();
      }, { pendingCrop: true });
    },
  });
}

// Question-picker modal. Pre-checks existing members if `existing` is provided
// (edit flow). `onSubmit` receives the new array of question IDs and may
// return `false` to keep the modal open on validation error.
function openContextQuestionPicker(examId, examQs, existing, onSubmit, options = {}) {
  const currentIds = new Set((existing?.question_ids || []).map(n => parseInt(n, 10)));
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,15,30,0.75);z-index:99999;display:grid;place-items:center;padding:20px;direction:rtl;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:520px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;">
      <header style="padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:700;font-size:15px;">${existing ? `ערוך שיוך לקבוצה "${escapeHtml(existing.group_id || '')}"` : (options.pendingCrop ? 'לאלו שאלות לשייך את המידע?' : 'בחר שאלות לשיוך')}</div>
        <button class="px-close" type="button" style="background:none;border:none;cursor:pointer;font-size:22px;color:#6b7280;">×</button>
      </header>
      <div style="padding:12px 18px;font-size:12.5px;color:#64748b;">סמנו את השאלות שמשתמשות במידע הזה. השאלות המסומנות יציגו כפתור "מידע לסט" בזמן התרגול.</div>
      <div class="ep-ctx-question-picker" style="margin:0 18px;">
        ${examQs.map(q => {
          const isChecked = currentIds.has(parseInt(q.id, 10));
          const preview = (q.question_text || '').toString().slice(0, 80) || 'שאלה ' + q.question_number;
          return `
            <label>
              <input type="checkbox" value="${q.id}" ${isChecked ? 'checked' : ''} />
              <span><strong>#${escapeHtml(String(q.question_number || ''))}</strong> ${escapeHtml(preview)}${q.group_id && q.group_id !== existing?.group_id ? ` <span style="color:#ea580c;font-size:10px;">(כבר בקבוצה: ${escapeHtml(q.group_id)})</span>` : ''}</span>
            </label>`;
        }).join('')}
      </div>
      <footer style="padding:14px 18px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;margin-top:10px;">
        <div style="font-size:12px;color:#64748b;" class="px-count">0 מסומנות</div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost btn-sm px-cancel" type="button">בטל</button>
          <button class="btn btn-primary btn-sm px-save" type="button">שמור שיוך</button>
        </div>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const countEl = overlay.querySelector('.px-count');
  const updateCount = () => {
    const n = overlay.querySelectorAll('input[type="checkbox"]:checked').length;
    countEl.textContent = `${n} מסומנות`;
  };
  updateCount();
  overlay.addEventListener('change', (e) => { if (e.target.matches('input[type="checkbox"]')) updateCount(); });
  overlay.querySelector('.px-close').addEventListener('click', close);
  overlay.querySelector('.px-cancel').addEventListener('click', close);

  overlay.querySelector('.px-save').addEventListener('click', async () => {
    const checked = [...overlay.querySelectorAll('input[type="checkbox"]:checked')]
      .map(cb => parseInt(cb.value, 10)).filter(Boolean);

    // Conflict detection — any checked question already in ANOTHER group?
    const conflicts = examQs.filter(q =>
      checked.includes(parseInt(q.id, 10)) && q.group_id && q.group_id !== (existing?.group_id || null)
    );
    if (conflicts.length) {
      const nums = conflicts.map(q => '#' + q.question_number).join(', ');
      const ok = confirm(`השאלות ${nums} כבר משוייכות לקבוצה קיימת (${conflicts.map(c => c.group_id).join(', ')}). המשך תחליף את השיוך. להמשיך?`);
      if (!ok) return;
    }

    // Edit flow uses PATCH; create flow delegates to onSubmit (which calls POST).
    if (existing && !options.pendingCrop) {
      const tk = await Auth.getToken();
      const r = await fetch(`/api/exams/${examId}/context/${encodeURIComponent(existing.group_id)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: checked }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) { toast(data.error || `שגיאה (${r.status})`, 'error'); return; }
      toast('השיוך עודכן', 'success');
      close();
      if (typeof onSubmit === 'function') onSubmit(checked);
      return;
    }
    // Create flow: pass the chosen IDs up; caller POSTs with the crop coords.
    const result = await (typeof onSubmit === 'function' ? onSubmit(checked) : null);
    if (result !== false) close();
  });
}

function pickRandom(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

// Keep questions that share a group_id (same passage/diagram/table) together,
// always in their original order. Individual questions are shuffled; groups
// are shuffled as a unit. Selects up to `n` questions total.
function pickRandomGrouped(arr, n) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const groups = new Map();   // group_id -> [questions in original order]
  const singles = [];          // questions with no group_id
  for (const q of arr) {
    const gid = q && (q.group_id || q.groupId);
    if (gid) {
      if (!groups.has(gid)) groups.set(gid, []);
      groups.get(gid).push(q);
    } else {
      singles.push(q);
    }
  }
  // Sort each group by numeric question number so Q5→Q6→Q7 stay in order.
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const an = parseInt(a?.question_number || a?.questionNumber || a?.number || 0, 10) || 0;
      const bn = parseInt(b?.question_number || b?.questionNumber || b?.number || 0, 10) || 0;
      return an - bn;
    });
  }
  // Build units: each group is a single unit; each single is also a unit.
  const units = [...groups.values(), ...singles.map(q => [q])];
  // Shuffle units
  for (let i = units.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [units[i], units[j]] = [units[j], units[i]];
  }
  // Flatten until we have at least `n` questions; do NOT split a group.
  const out = [];
  for (const u of units) {
    if (out.length >= n) break;
    // If adding this group would exceed n, still add it (grouped questions
    // must stay together, even if it means slightly overshooting the limit).
    out.push(...u);
  }
  return out;
}
function toast(msg, type = '', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
    if (!container.hasChildNodes()) container.remove();
  }, duration);
}

// Render explanation text with inline `code` and **bold** support
function renderExplanation(text) {
  if (text == null) return '';
  const s = String(text);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end === -1) { out += escapeHtml(s.slice(i)); break; }
      out += `<code>${escapeHtml(s.slice(i + 1, end))}</code>`;
      i = end + 1;
      continue;
    }
    if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end === -1) { out += escapeHtml(s.slice(i)); break; }
      out += `<strong>${renderExplanation(s.slice(i + 2, end))}</strong>`;
      i = end + 2;
      continue;
    }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}

// ===== Trial countdown banner =====
function renderTrialBanner(container) {
  if (!container || !state.user) return;
  const plan = state.user.plan;
  const isAdmin = state.user.isAdmin;
  if (isAdmin) return;
  if (plan === 'trial') {
    let daysLeft = (state.user.planExpiresAt)
      ? Math.max(0, Math.ceil((new Date(state.user.planExpiresAt) - Date.now()) / 86400000))
      : (state.user.daysLeft != null ? state.user.daysLeft : 14);
    const urgency = daysLeft <= 3 ? 'urgent' : (daysLeft <= 7 ? 'warning' : '');
    const clockIcon = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    // 14 pill segments — first daysLeft are "on" (remaining), rest are dim
    const segs = Array.from({ length: 14 }, (_, i) =>
      `<span class="trial-seg${i < daysLeft ? ' on' : ''}"></span>`
    ).join('');
    const banner = document.createElement('div');
    banner.className = `trial-banner ${urgency}`;
    banner.innerHTML = `
      <div class="trial-banner-content">
        <div class="trial-banner-info">
          <div class="trial-banner-title">${clockIcon}<strong>תקופת ניסיון חינם</strong></div>
          <div class="trial-banner-sub">נותרו <strong>${daysLeft}</strong> ימים</div>
        </div>
        <div class="trial-segs" role="img" aria-label="נותרו ${daysLeft} מתוך 14 ימים">${segs}</div>
        <span class="trial-banner-cta">שדרוג בקרוב</span>
      </div>
    `;
    container.prepend(banner);
  } else if (plan === 'free') {
    const banner = document.createElement('div');
    banner.className = 'trial-banner';
    banner.innerHTML = `
      <div class="trial-banner-content">
        <div class="trial-banner-info">
          <div class="trial-banner-title"><strong>פלאן חינמי פעיל</strong></div>
          <div class="trial-banner-sub">יש לך מגבלות יומיות — שדרג ל-Basic לפי הצורך</div>
        </div>
        <button class="trial-banner-cta" style="cursor:pointer;background:#2563eb;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:13px;font-weight:600;" onclick="location.hash='#pricing';navigate('/')">הצג תוכניות</button>
      </div>
    `;
    container.prepend(banner);
  }
}

// ===== Router =====
function getRoute() {
  const hash = location.hash || '#/';
  return hash.replace(/^#/, '');
}
function navigate(path) {
  location.hash = '#' + path;
}
window.addEventListener('hashchange', () => {
  // Reset mobile pinch-zoom when user navigates to a new page so each route
  // starts at fit-to-screen. Users can still zoom again per-page if needed.
  resetMobileZoom();
  renderRoute();
});

// Toggle the viewport to force the browser back to 100% zoom. Briefly swaps
// to a non-scalable viewport then restores the scalable one. Safari / Chrome
// on mobile both honor this sequence.
function resetMobileZoom() {
  try {
    const m = document.querySelector('meta[name="viewport"]');
    if (!m) return;
    const restore = 'width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover';
    m.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    requestAnimationFrame(() => {
      m.setAttribute('content', restore);
    });
  } catch {}
}

// Global event delegation for [data-route] links — always works regardless
// of whether individual render functions attach their own handlers.
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-route]');
  if (!link) return;
  const route = link.getAttribute('data-route');
  if (route) {
    e.preventDefault();
    navigate(route);
  }
});

// Global smooth-scroll for in-page anchors (href="#section")
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="#"]');
  if (!link || link.hasAttribute('data-route')) return;
  const href = link.getAttribute('href');
  if (!href || href.length < 2 || href.startsWith('#/')) return;
  const target = document.getElementById(href.slice(1));
  if (target) {
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// Helper: set state.course from a courseId (used by the router)
function setCourseContext(courseId) {
  const course = CourseRegistry.get(courseId);
  if (course) { state.course = course; return true; }
  // Not cached yet — use a neutral loading label (NOT "קורס {id}", which is
  // misleading when the row actually belongs to another user) and resolve
  // asynchronously. resolveCourseAsync will either populate the real name or
  // redirect back to the dashboard if the course doesn't exist / isn't ours.
  state.course = { id: courseId, name: 'טוען קורס...', color: '#3b82f6' };
  resolveCourseAsync(courseId);
  return true;
}

// Fetch a single course by id, populate the registry, update state.course,
// and re-render the current route if we're still on that course. If the row
// can't be fetched because the user doesn't own it (or it doesn't exist),
// bounce them back to the dashboard — otherwise they'd sit on a page with a
// placeholder title and any action (upload, practice) would 403.
async function resolveCourseAsync(courseId) {
  if (!courseId || courseId === 'tohna1') return;
  const bounceHome = (msg) => {
    if (state.course && String(state.course.id) !== String(courseId)) return; // user moved on
    toast(msg, 'warning');
    navigate('/dashboard');
  };
  try {
    const token = await Auth.getToken();
    if (!token) return;
    const r = await fetch(`/api/courses/${encodeURIComponent(courseId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 404 || r.status === 403) {
      return bounceHome('הקורס הזה לא שייך לחשבון שלך. מחזיר אותך לדשבורד.');
    }
    if (!r.ok) return;
    const course = await r.json();
    if (!course || !course.id) return bounceHome('הקורס לא נמצא.');
    // Cache in registry so subsequent navigations use the real name.
    const idStr = String(course.id);
    if (course.parent_id) {
      if (!state.subCourses.find(c => String(c.id) === idStr)) state.subCourses.push(course);
    } else {
      if (!state.courses.find(c => String(c.id) === idStr)) state.courses.push(course);
    }
    // Only update if we're still on this course (user hasn't navigated away).
    if (state.course && String(state.course.id) === idStr) {
      state.course = course;
      try { renderRoute(); } catch {}
    }
  } catch (e) {
    console.warn('[resolveCourseAsync]', e?.message || e);
  }
}

function renderRoute() {
  try {
    const route = getRoute();
    const path = route.split('?')[0];
    const params = new URLSearchParams(route.split('?')[1] || '');

    // ===== Modelim plan gating =====
    // Drive a body class so CSS can hide upload / lab / file-management UI in
    // one place. Plan='modelim' is set by the handle_new_user trigger when
    // seed_mode_enabled is on (see supabase/migrations/modelim_plan_and_seed.sql).
    // Admin users on the modelim plan are exempt — they need full access to
    // manage content for everyone else.
    const isModelim = state.user?.plan === 'modelim' && !state.user?.isAdmin;
    document.body.classList.toggle('plan-modelim', !!isModelim);
    if (isModelim) {
      // Route guards — these are all AI or creation flows the user can't reach.
      if (path === '/study' || path.startsWith('/study/')) return navigate('/dashboard');
      const courseMatch = path.match(/^\/course\/([^/]+)\/(lab|study)$/);
      if (courseMatch) return navigate(`/course/${courseMatch[1]}`);
    }

    if (path === '/' || path === '') return renderLanding();
    if (path === '/login') return renderAuth(params.get('signup') === '1');
    if (path === '/dashboard') return renderDashboard();
    if (path === '/settings') return renderSettings(params.get('tab') || 'profile');
    if (path === '/study') return renderStudyList();
    if (path === '/study/new') return renderStudyCreate();
    if (path.startsWith('/study/')) return renderStudyPack(path.split('/')[2]);

    // Degree dashboard: /degree/{degreeId}
    const degreeMatch = path.match(/^\/degree\/([^/]+)$/);
    if (degreeMatch) return renderDegreeDashboard(degreeMatch[1]);

    // Course-scoped routes: /course/{courseId}/{page}
    const courseMatch = path.match(/^\/course\/([^/]+)(?:\/(.*))?$/);
    if (courseMatch) {
      const courseId = courseMatch[1];
      const page = courseMatch[2] || '';
      setCourseContext(courseId);
      // Exam-scoped subroutes: /course/{courseId}/exam/{examId}/review
      const examReviewMatch = page.match(/^exam\/([^/]+)\/review$/);
      if (examReviewMatch) return renderExamReview(courseId, examReviewMatch[1]);
      if (page === '' || page === 'dashboard') return renderCourseDashboard();
      if (page === 'quiz') return state.quiz ? renderQuiz() : navigate(`/course/${courseId}`);
      if (page === 'summary') return renderSummary();
      if (page === 'review') return renderMistakeReview();
      if (page === 'insights') return renderInsights();
      if (page === 'lab') return renderLab();
      if (page === 'progress') return renderProgress();
      if (page === 'study') return renderStudyList();
      return renderCourseDashboard();
    }

  // Backward compat: old routes redirect to /course/tohna1/{page}
  if (path === '/quiz') { setCourseContext('tohna1'); return state.quiz ? renderQuiz() : navigate('/course/tohna1'); }
  if (path === '/summary') { setCourseContext('tohna1'); return renderSummary(); }
  if (path === '/review') { setCourseContext('tohna1'); return renderMistakeReview(); }
  if (path === '/insights') return navigate(`/course/${state.course?.id || 'tohna1'}/insights`);
  if (path === '/lab') return navigate(`/course/${state.course?.id || 'tohna1'}/lab`);
  if (path === '/progress') return navigate(`/course/${state.course?.id || 'tohna1'}/progress`);

  return renderLanding();
  } catch (err) {
    console.error('[renderRoute] crash:', err);
    try { window.__reportClientError?.('error', { msg: String(err?.message || err), stack: String(err?.stack || '') }); } catch {}
    // Prevent blank page — show a recovery message
    $app.innerHTML = `<div style="text-align:center;padding:60px 20px;direction:rtl;">
      <h2>משהו השתבש</h2>
      <p style="margin:16px 0;color:#666;">אירעה שגיאה בטעינת הדף.</p>
      <details style="margin:8px 0 16px;font-size:12px;color:#999;text-align:left;direction:ltr;"><summary>פרטי שגיאה</summary><pre style="white-space:pre-wrap;word-break:break-all">${String(err?.stack || err)}</pre></details>
      <button onclick="location.hash='#/dashboard';location.reload()" class="btn btn-primary">חזרה לדף הבית</button>
    </div>`;
  }
}

// ===== Course-scoped data helpers =====
// Every analysis function below works on a *course-scoped* slice of questions
// so the same code runs for each course the user adds in the future.
function questionsForCourse(courseId) {
  // Use the cache entry for this specific courseId rather than relying on
  // state.course as a side-channel — prevents stale cross-course data.
  const meta = Data._cache[courseId]?.metadata ?? Data._cache[String(courseId)]?.metadata;
  if (!meta) return [];
  return meta.exams.flatMap(e => e.questions);
}
function examsForCourse(courseId) {
  const meta = Data._cache[courseId]?.metadata ?? Data._cache[String(courseId)]?.metadata;
  if (!meta) return [];
  return meta.exams;
}
function attemptsForCourse(uid, courseId) {
  return Progress.history(uid, courseId);
}
function batchesForCourse(uid, courseId) {
  const p = Progress.load(uid, courseId);
  return p.batches || [];
}
function reviewQueueForCourse(uid, courseId) {
  const p = Progress.load(uid, courseId);
  return p.reviewQueue || [];
}

// ===== Topic taxonomy — dual-mode bucket resolver =====
// Two strategies run in order so Insights work for any subject:
//   1. FIXED BUCKETS — specialised regex overlay for the built-in tohna1 Java
//      course. answers.json ships with very granular topic strings ("Method
//      Overriding (private)", "Wildcards (extends/super)", …). Matching them
//      into ~14 themes keeps the UI tidy for that specific course.
//   2. DIRECT TOPIC STRINGS — for any cloud course (biology, chemistry, math,
//      …) the server-side Gemini labeler already produced short canonical
//      topic strings like "גנטיקה מנדלית", "Design Patterns", "פוטוסינתזה".
//      We bucket those by the string itself so the aggregate mirrors exactly
//      what appears in the user's exams — no hardcoded per-subject taxonomy.
const TOPIC_BUCKETS_TOHNA1 = [
  { id: 'generics',     name: 'Generics & Wildcards', icon: null, color: '#7c3aed', match: /generic|wildcard|<\?|extends |super /i },
  { id: 'streams',      name: 'Streams API',          icon: null, color: '#0ea5e9', match: /stream/i },
  { id: 'overriding',   name: 'Method Overriding',    icon: null, color: '#f59e0b', match: /overrid/i },
  { id: 'overloading',  name: 'Method Overloading',   icon: null, color: '#ec4899', match: /overload/i },
  { id: 'resolution',   name: 'Method Resolution',    icon: null, color: '#ef4444', match: /method resolution|resolution/i },
  { id: 'inner',        name: 'Inner Classes',        icon: null, color: '#8b5cf6', match: /inner class|nested/i },
  { id: 'exceptions',   name: 'Exceptions',           icon: null, color: '#f97316', match: /exception|try.?catch|throw/i },
  { id: 'equals',       name: 'equals & hashCode',    icon: null, color: '#10b981', match: /equals|hashcode|hashing/i },
  { id: 'iterators',    name: 'Iterators & Iterable', icon: null, color: '#06b6d4', match: /iterator|iterable/i },
  { id: 'lambdas',      name: 'Lambdas & Functional', icon: null, color: '#3b82f6', match: /lambda|functional|predicate|bifunction|comparator/i },
  { id: 'patterns',     name: 'Design Patterns',      icon: null, color: '#0d9488', match: /design pattern|observer|factory|bridge|singleton/i },
  { id: 'constructors', name: 'Constructors',         icon: null, color: '#65a30d', match: /constructor/i },
  { id: 'static',       name: 'Static / Instance',    icon: null, color: '#eab308', match: /static|instance field|instance method/i },
  { id: 'visibility',   name: 'Visibility / Access',  icon: null, color: '#64748b', match: /visibility|private|public|access/i },
  { id: 'casting',      name: 'Casting & Types',      icon: null, color: '#dc2626', match: /cast|classcast|inherit/i },
];

// Palette used for dynamically-clustered topics (any non-tohna1 course). Same
// topic string → same color across renders thanks to the hash below.
const DYNAMIC_TOPIC_PALETTE = [
  '#7c3aed', '#0ea5e9', '#f59e0b', '#ec4899', '#ef4444',
  '#8b5cf6', '#f97316', '#10b981', '#06b6d4', '#3b82f6',
  '#0d9488', '#65a30d', '#eab308', '#64748b', '#dc2626',
];
function colorForTopicKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return DYNAMIC_TOPIC_PALETTE[Math.abs(h) % DYNAMIC_TOPIC_PALETTE.length];
}
function bucketsForTopic(topicStr) {
  if (!topicStr) return [];
  const s = String(topicStr).trim();
  if (!s) return [];
  // tohna1 regex overlay first — collapses granular Java-specific topics
  // into 14 stable themes. Falls through for any other subject.
  const fixed = TOPIC_BUCKETS_TOHNA1.filter(b => b.match.test(s));
  if (fixed.length) return fixed;
  // Dynamic cluster: the Gemini labeler already produces short canonical
  // strings, so we trust them 1:1. Key is the normalized string; display
  // name is the original casing/spacing.
  const canon = s.replace(/\s+/g, ' ');
  const key = canon.toLowerCase();
  return [{ id: 'topic:' + key, name: canon, icon: null, color: colorForTopicKey(key) }];
}

// ===== Pattern analysis engine =====
// Returns an aggregate of every topic bucket: how many questions, which exams,
// how often the user got it right/wrong, and a "focus score" combining
// frequency × difficulty × user weakness.
function analyzeQuestionBank(questions, attempts) {
  const buckets = new Map(); // bucketId -> { name, icon, color, count, qids, examIds, correct, wrong, attempts, avgOptions }

  for (const q of questions) {
    const meta = Data.publicMeta(q.id);
    const reveal = Data.reveal(q.id);
    const topicStr = reveal.topic || '';
    const bs = bucketsForTopic(topicStr);
    for (const b of bs) {
      let bucket = buckets.get(b.id);
      if (!bucket) {
        bucket = {
          id: b.id, name: b.name, icon: b.icon, color: b.color,
          count: 0, qids: new Set(), examIds: new Set(),
          correct: 0, wrong: 0, attemptCount: 0,
          numOptionsTotal: 0, hardOptionCount: 0,
          rawTopics: new Set(),
        };
        buckets.set(b.id, bucket);
      }
      bucket.count++;
      bucket.qids.add(q.id);
      bucket.examIds.add(q.examId);
      bucket.numOptionsTotal += (meta.numOptions || 4);
      if ((meta.numOptions || 4) >= 6) bucket.hardOptionCount++;
      if (topicStr) bucket.rawTopics.add(topicStr);
    }
  }

  // Apply user attempts (latest per question wins for win/lose accounting)
  const lastByQ = new Map();
  for (const a of attempts) lastByQ.set(a.questionId, a);
  for (const [qid, a] of lastByQ.entries()) {
    const q = questions.find(qq => qq.id === qid);
    if (!q) continue;
    const reveal = Data.reveal(qid);
    const bs = bucketsForTopic(reveal.topic || '');
    for (const b of bs) {
      const bucket = buckets.get(b.id);
      if (!bucket) continue;
      bucket.attemptCount++;
      if (a.isCorrect && !a.revealed) bucket.correct++;
      else bucket.wrong++;
    }
  }

  // Compute derived metrics
  const list = [...buckets.values()].map(b => {
    const accuracy = b.attemptCount > 0 ? b.correct / b.attemptCount : null;
    const avgOptions = b.numOptionsTotal / Math.max(1, b.count);
    // Focus score = frequency-normalized + (1 - accuracy) weighted + difficulty weight
    const freqWeight = b.count;
    const weakness = accuracy == null ? 0.5 : (1 - accuracy); // unknown = neutral
    const difficulty = (avgOptions - 3) / 5; // normalized 0..1 (3 opts → 0, 8 opts → 1)
    const focusScore = (freqWeight * 1.5) + (weakness * 4) + (difficulty * 2);
    return {
      ...b,
      qids: [...b.qids],
      examIds: [...b.examIds],
      rawTopics: [...b.rawTopics],
      accuracy, avgOptions, focusScore,
    };
  });

  list.sort((a, b) => b.count - a.count);
  return list;
}

// ===== High-level / hard question identifier =====
function identifyHardQuestions(questions, attempts, limit = 20) {
  const lastByQ = new Map();
  for (const a of attempts) lastByQ.set(a.questionId, a);

  const scored = questions.map(q => {
    const meta = Data.publicMeta(q.id);
    const reveal = Data.reveal(q.id);
    const numOpts = meta.numOptions || 4;
    const lastAttempt = lastByQ.get(q.id);
    let score = 0;
    const reasons = [];
    if (numOpts >= 6) { score += 4; reasons.push(`${numOpts} אופציות`); }
    if (numOpts >= 8) { score += 2; reasons.push('8 אופציות מקסימום'); }
    if (lastAttempt && (!lastAttempt.isCorrect || lastAttempt.revealed)) {
      score += 5; reasons.push('טעית בעבר');
    }
    // Tricky topic boost
    const topic = reveal.topic || '';
    if (/wildcard.*super|wildcard.*extends|equals.*hashcode|classcast|method overriding.*private|erasure/i.test(topic)) {
      score += 3; reasons.push('נושא טריקי');
    }
    // Never attempted = mild boost (worth seeing)
    if (!lastAttempt) { score += 1; }
    return { q, score, reasons, topic, numOpts };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ===== Per-topic mastery for the Progress page =====
function computeTopicMastery(questions, attempts) {
  const analysis = analyzeQuestionBank(questions, attempts);
  return analysis
    .map(b => ({
      ...b,
      mastery: b.attemptCount === 0 ? null : (b.correct / b.attemptCount),
      coverage: b.attemptCount / Math.max(1, b.count),
    }))
    .sort((a, b) => {
      // Show known weaknesses first, then unknowns, then strengths
      if (a.mastery == null && b.mastery == null) return b.count - a.count;
      if (a.mastery == null) return 1;
      if (b.mastery == null) return -1;
      return a.mastery - b.mastery;
    });
}

// ===== Streak / time / trend =====
function computeStreak(attempts) {
  if (!attempts.length) return { currentStreak: 0, longestStreak: 0, daysActive: 0 };
  // Group by local-day strings
  const days = new Set(attempts.map(a => new Date(a.ts).toDateString()));
  const sorted = [...days].map(d => new Date(d).getTime()).sort((a, b) => b - a);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const oneDay = 24 * 60 * 60 * 1000;
  let currentStreak = 0;
  let cursor = today.getTime();
  for (const dayTs of sorted) {
    if (dayTs === cursor) { currentStreak++; cursor -= oneDay; }
    else if (dayTs === cursor + oneDay) { currentStreak++; cursor = dayTs - oneDay; } // grace for first hit
    else break;
  }
  // Longest streak
  let longest = 0, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1] - sorted[i] === oneDay) run++;
    else { longest = Math.max(longest, run); run = 1; }
  }
  longest = Math.max(longest, run);
  return { currentStreak, longestStreak: longest, daysActive: days.size };
}
function computeTotalTime(attempts) {
  const totalSec = attempts.reduce((sum, a) => sum + (a.timeSeconds || 0), 0);
  return {
    totalSeconds: totalSec,
    avgPerQuestion: attempts.length ? Math.round(totalSec / attempts.length) : 0,
  };
}
function computeAccuracyTrend(attempts, windowSize = 20) {
  if (attempts.length < windowSize) return { trend: null, recentAcc: null, oldAcc: null };
  const recent = attempts.slice(-windowSize);
  const older = attempts.slice(-windowSize * 2, -windowSize);
  const recAcc = recent.filter(a => a.isCorrect && !a.revealed).length / recent.length;
  const oldAcc = older.length ? older.filter(a => a.isCorrect && !a.revealed).length / older.length : recAcc;
  return {
    recentAcc: recAcc,
    oldAcc,
    trend: recAcc - oldAcc, // positive = improving
  };
}

// ===== Personalized tips engine =====
function generateTips(questions, attempts, batches, mastery) {
  const tips = [];
  const total = attempts.length;

  if (total === 0) {
    tips.push({
      icon: '🚀', tone: 'info', title: 'תתחיל מאיפשהו',
      body: 'לא תרגלת אף שאלה עדיין. הצעד הראשון הוא הכי חשוב — תפתח מקבץ קצר של 10 שאלות אקראיות ופשוט תנסה.',
      cta: 'התחל תרגול', ctaRoute: 'practice',
    });
    return tips;
  }

  // Topic-based tips
  const weakest = mastery.find(m => m.mastery != null && m.mastery < 0.5 && m.attemptCount >= 3);
  if (weakest) {
    tips.push({
      icon: '🎯', tone: 'warn', title: `החולשה הכי גדולה: ${weakest.name}`,
      body: `מתוך ${weakest.attemptCount} ניסיונות בנושא הזה, ענית נכון רק ב-${Math.round(weakest.mastery * 100)}%. תקדיש מקבץ יעודי לנושא הזה — עדיף 10 שאלות ממוקדות מאשר 50 פזורות.`,
      cta: 'סקור את הנושא', ctaRoute: 'insights',
    });
  }

  const strongest = mastery.find(m => m.mastery != null && m.mastery >= 0.85 && m.attemptCount >= 3);
  if (strongest) {
    tips.push({
      icon: '💪', tone: 'good', title: `אתה שולט ב-${strongest.name}`,
      body: `${Math.round(strongest.mastery * 100)}% הצלחה ב-${strongest.attemptCount} ניסיונות. אתה יכול להפסיק לתרגל את זה לזמן ולהשקיע את הזמן בנושאים החלשים יותר.`,
    });
  }

  // Coverage tip
  const uncovered = mastery.filter(m => m.attemptCount === 0);
  if (uncovered.length >= 2) {
    tips.push({
      icon: '🗺️', tone: 'info', title: `${uncovered.length} נושאים שעוד לא נגעת בהם`,
      body: `יש בקורס נושאים שלא ניסית אף שאלה מתוכם: ${uncovered.slice(0, 3).map(u => u.name).join(', ')}${uncovered.length > 3 ? '...' : ''}. שים לב — מבחן אמיתי יכול לחבר שאלה מכל אחד מהם.`,
      cta: 'הצג את כל הנושאים', ctaRoute: 'insights',
    });
  }

  // Streak tip
  const streak = computeStreak(attempts);
  if (streak.currentStreak >= 3) {
    tips.push({
      icon: '🔥', tone: 'good', title: `רצף של ${streak.currentStreak} ימים — תמשיך!`,
      body: 'מחקרי למידה מראים שתרגול יומי קצר טוב יותר מתרגול ארוך פעם בשבוע. המוח מקבע את החומר בזמן השינה. אל תשבור את הרצף.',
    });
  } else if (streak.daysActive >= 2 && streak.currentStreak === 0) {
    tips.push({
      icon: '⏰', tone: 'warn', title: 'הפסקה ארוכה מדי',
      body: 'לא תרגלת היום. אפילו 5 שאלות עכשיו ישמרו על העקביות. הזיכרון מתחיל להיחלש כבר אחרי יומיים בלי חזרה.',
    });
  }

  // Trend tip
  const trend = computeAccuracyTrend(attempts);
  if (trend.trend != null) {
    if (trend.trend > 0.1) {
      tips.push({
        icon: '📈', tone: 'good', title: 'אתה משתפר!',
        body: `הדיוק שלך ב-20 השאלות האחרונות (${Math.round(trend.recentAcc * 100)}%) גבוה ב-${Math.round(trend.trend * 100)}% מאשר ב-20 שלפניהן. אתה בכיוון הנכון.`,
      });
    } else if (trend.trend < -0.1) {
      tips.push({
        icon: '⚠️', tone: 'warn', title: 'הדיוק שלך יורד',
        body: `ב-20 השאלות האחרונות ענית פחות טוב מאשר קודם. אולי כדאי לעצור, לעשות סקירת טעויות מהמקבצים האחרונים, ורק אז להמשיך.`,
      });
    }
  }

  // Difficulty tip
  const wrongs = attempts.filter(a => !a.isCorrect || a.revealed);
  if (wrongs.length >= 5) {
    tips.push({
      icon: '🔍', tone: 'info', title: 'יש לך בנק טעויות',
      body: `${wrongs.length} שאלות שטעית או שראית את הפתרון. תפתח מקבץ "חזרה על שאלות שטעיתי בהן" — זו הדרך המהירה ביותר לכסות חורים.`,
      cta: 'תרגל טעויות', ctaRoute: 'practice',
    });
  }

  // Timing tip
  const time = computeTotalTime(attempts);
  if (time.avgPerQuestion > 0 && time.avgPerQuestion < 25) {
    tips.push({
      icon: '⏱', tone: 'info', title: 'אתה ממהר',
      body: `ממוצע ${time.avgPerQuestion} שניות לשאלה זה מהיר מאוד. בבחינה אמיתית של 90 דקות ל-30 שאלות, יש לך 3 דקות לכל שאלה. תקדיש יותר זמן לקרוא את הקוד לעומק.`,
    });
  } else if (time.avgPerQuestion > 180) {
    tips.push({
      icon: '🐢', tone: 'warn', title: 'אתה איטי בשאלות',
      body: `ממוצע ${Math.round(time.avgPerQuestion / 60)} דקות לשאלה זה הרבה. תתרגל עם טיימר אמיתי לפעם הבאה — זה יעזור לבנות אינסטינקט.`,
    });
  }

  return tips.slice(0, 8);
}

// ===== Render: Landing =====
function renderLanding() {
  // The landing is pre-rendered as static HTML in index.html inside #app.
  // First boot: .landing is already there — do nothing, just wire listeners.
  // After navigating away (/login replaces #app) and back: restore from cache.
  if (!$app.querySelector('.landing')) {
    if (_landingHtmlCache) {
      $app.innerHTML = _landingHtmlCache;
    } else {
      // No cache — should never happen unless index.html was modified in flight.
      // Fall back to empty #app; the page will still be navigable via hash routes.
      $app.innerHTML = '';
    }
  }

  // Wire up internal route links
  document.querySelectorAll('[data-route]').forEach(link => {
    link.addEventListener('click', (e) => {
      const route = link.getAttribute('data-route');
      if (route) {
        e.preventDefault();
        navigate(route);
      }
    });
  });

  // Mobile hamburger
  const hb = document.getElementById('hamburger');
  if (hb) hb.addEventListener('click', () => document.getElementById('navbar').classList.toggle('open'));

  // FAQ accordion
  document.querySelectorAll('.faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  // Smooth-scroll for in-page anchors
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    if (a.hasAttribute('data-route')) return;
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href').slice(1);
      const target = document.getElementById(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Mobile reviews carousel — must run AFTER template is in the DOM
  initReviewsCarousel();

  // PWA guide tabs
  const pwaTabIos = document.getElementById('pwa-tab-ios');
  const pwaTabAndroid = document.getElementById('pwa-tab-android');
  const pwaPanelIos = document.getElementById('pwa-panel-ios');
  const pwaPanelAndroid = document.getElementById('pwa-panel-android');
  if (pwaTabIos && pwaTabAndroid) {
    pwaTabIos.addEventListener('click', () => {
      pwaTabIos.classList.add('is-active');
      pwaTabAndroid.classList.remove('is-active');
      if (pwaPanelIos) pwaPanelIos.hidden = false;
      if (pwaPanelAndroid) pwaPanelAndroid.hidden = true;
    });
    pwaTabAndroid.addEventListener('click', () => {
      pwaTabAndroid.classList.add('is-active');
      pwaTabIos.classList.remove('is-active');
      if (pwaPanelAndroid) pwaPanelAndroid.hidden = false;
      if (pwaPanelIos) pwaPanelIos.hidden = true;
    });
  }

  // Contact form — float select label when option selected
  const contactSubject = document.getElementById('contact-subject');
  if (contactSubject) {
    contactSubject.addEventListener('change', () => {
      contactSubject.classList.toggle('has-value', contactSubject.value !== '');
    });
  }

  // Contact form
  const contactForm = document.getElementById('contact-form');
  if (contactForm) {
    contactForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = contactForm.querySelector('.contact-submit');
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'שולח...';
      const data = {
        name: contactForm.name.value.trim(),
        email: contactForm.email.value.trim(),
        subject: contactForm.subject.value,
        message: contactForm.message.value.trim(),
      };
      try {
        const res = await fetch('/api/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('send failed');
        contactForm.reset();
        if (contactSubject) contactSubject.classList.remove('has-value');
        const success = document.getElementById('contact-success');
        if (success) {
          success.hidden = false;
          setTimeout(() => { success.hidden = true; }, 5000);
        }
      } catch {
        alert('שגיאה בשליחה. אפשר לשלוח ישירות ל-support@try-examprep.com');
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }
}

function initReviewsCarousel() {
  const grid = document.querySelector('.reviews-grid');
  const stage = document.querySelector('[data-rm-stage]');
  const dotsWrap = document.querySelector('[data-rm-dots]');
  const mobile = document.querySelector('.reviews-mobile');
  if (!grid || !stage || !dotsWrap || !mobile) return;

  const cards = [...grid.querySelectorAll('[data-review]')];
  if (!cards.length) return;

  // Place all cards inside the stage as a horizontal strip
  stage.innerHTML = cards.map(c => c.outerHTML).join('');
  const total = cards.length;
  let idx = 0;
  let timer = null;
  const INTERVAL = 5000;

  // Build dots
  for (let i = 0; i < total; i++) {
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'rm-dot' + (i === 0 ? ' is-active' : '');
    d.setAttribute('aria-label', 'ביקורת ' + (i + 1));
    d.addEventListener('click', () => { goTo(i); startTimer(); });
    dotsWrap.appendChild(d);
  }
  const dots = [...dotsWrap.querySelectorAll('.rm-dot')];

  function slide(i) {
    // RTL: positive translateX to go "forward"
    const dir = getComputedStyle(mobile).direction === 'rtl' ? 1 : -1;
    stage.style.transform = `translateX(${dir * i * 100}%)`;
    dots.forEach((d, di) => d.classList.toggle('is-active', di === i));
  }

  function next() { idx = (idx + 1) % total; slide(idx); }
  function prev() { idx = (idx - 1 + total) % total; slide(idx); }
  function goTo(i) { idx = i; slide(idx); }
  function startTimer() { stopTimer(); timer = setInterval(next, INTERVAL); }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  slide(0);
  startTimer();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTimer(); else startTimer();
  });

  // ---- Swipe / touch support ----
  let startX = 0, startY = 0, deltaX = 0, swiping = false;
  const THRESHOLD = 40;

  mobile.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    deltaX = 0;
    swiping = false;
    stopTimer();
  }, { passive: true });

  mobile.addEventListener('touchmove', (e) => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    // Only start swiping if horizontal movement is dominant
    if (!swiping && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      swiping = true;
      stage.classList.add('is-dragging');
    }
    if (!swiping) return;
    deltaX = dx;
    const dir = getComputedStyle(mobile).direction === 'rtl' ? 1 : -1;
    const base = dir * idx * 100;
    const drag = (deltaX / mobile.offsetWidth) * 100;
    stage.style.transform = `translateX(${base + drag}%)`;
  }, { passive: true });

  mobile.addEventListener('touchend', () => {
    stage.classList.remove('is-dragging');
    if (swiping) {
      const isRTL = getComputedStyle(mobile).direction === 'rtl';
      if (deltaX < -THRESHOLD) { isRTL ? prev() : next(); }
      else if (deltaX > THRESHOLD) { isRTL ? next() : prev(); }
      else { slide(idx); }
    }
    startTimer();
    swiping = false;
  }, { passive: true });
}

// ===== Render: Auth (split-screen, with all auth UX features) =====
function renderAuth(signupMode = false) {
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-auth'));

  document.querySelectorAll('[data-route]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.getAttribute('data-route'));
    });
  });

  const tabs = document.querySelectorAll('.auth-tab');
  const submitBtn = document.getElementById('auth-submit');
  const nameField = document.getElementById('signup-name-field');
  const titleEl = document.getElementById('auth-title');
  const subEl = document.getElementById('auth-sub');
  const switchEl = document.getElementById('auth-switch');
  const passwordRules = document.getElementById('password-rules');
  const loginOptions = document.getElementById('login-options');
  const forgotLink = document.getElementById('forgot-link');
  const passInput = document.getElementById('auth-pass');
  const togglePass = document.getElementById('toggle-pass');
  const passConfirmField = document.getElementById('signup-pass-confirm-field');
  const passConfirmInput = document.getElementById('auth-pass-confirm');
  const togglePassConfirm = document.getElementById('toggle-pass-confirm');
  const passMatchEl = document.getElementById('pass-match');

  let mode = signupMode ? 'signup' : 'login';

  function applyMode() {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === mode));
    nameField.style.display = mode === 'signup' ? '' : 'none';
    submitBtn.textContent = mode === 'signup' ? 'יצירת חשבון' : 'כניסה';
    if (titleEl) titleEl.textContent = mode === 'signup' ? 'בואו נתחיל' : 'ברוך הבא חזרה';
    if (subEl) subEl.textContent = mode === 'signup'
      ? 'צור חשבון חדש בחינם — בלי כרטיס אשראי'
      : 'טוב לראות אותך שוב — תכנס כדי להמשיך לתרגל';
    if (switchEl) {
      switchEl.innerHTML = mode === 'signup'
        ? 'יש לך כבר חשבון? <a href="#" id="auth-switch-link">התחבר עכשיו</a>'
        : 'אין לך חשבון? <a href="#" id="auth-switch-link">הירשם עכשיו</a>';
      const newLink = document.getElementById('auth-switch-link');
      if (newLink) newLink.addEventListener('click', (e) => {
        e.preventDefault();
        mode = mode === 'signup' ? 'login' : 'signup';
        applyMode();
      });
    }
    if (passwordRules) passwordRules.style.display = mode === 'signup' ? 'flex' : 'none';
    if (loginOptions) loginOptions.style.display = mode === 'login' ? 'flex' : 'none';
    if (forgotLink) forgotLink.style.display = mode === 'login' ? '' : 'none';
    if (passConfirmField) passConfirmField.style.display = mode === 'signup' ? '' : 'none';
    if (passConfirmInput) {
      if (mode === 'signup') {
        passConfirmInput.setAttribute('required', '');
      } else {
        passConfirmInput.removeAttribute('required');
        passConfirmInput.value = '';
      }
    }
    if (passMatchEl) { passMatchEl.style.display = 'none'; passMatchEl.textContent = ''; passMatchEl.className = 'pass-match'; }
    passInput.placeholder = mode === 'signup' ? 'בחר סיסמה חזקה' : 'הזן סיסמה';
    passInput.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  }
  applyMode();

  tabs.forEach(t => t.addEventListener('click', () => {
    mode = t.dataset.tab;
    applyMode();
  }));

  // Real-time email validation hint
  const emailInput = document.getElementById('auth-email');
  const emailHint  = document.getElementById('email-hint');
  const EMAIL_RE   = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  function validateEmailField() {
    if (!emailInput || !emailHint) return;
    const v = emailInput.value.trim();
    if (!v) { emailHint.style.display = 'none'; return; }
    const ok = EMAIL_RE.test(v) && !v.includes('..');
    emailHint.style.display = 'flex';
    emailHint.textContent  = ok ? '✓ כתובת נראית תקינה' : '✗ כתובת אימייל לא תקינה';
    emailHint.className    = 'email-hint ' + (ok ? 'hint-ok' : 'hint-err');
  }
  if (emailInput) {
    emailInput.addEventListener('input', validateEmailField);
    emailInput.addEventListener('blur',  validateEmailField);
  }

  // Password show/hide (works for both password fields)
  const EYE_OPEN = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const EYE_OFF  = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  function bindEyeToggle(btn, input) {
    if (!btn || !input) return;
    // Icon reflects the CURRENT state: crossed eye = hidden, open eye = visible.
    // Paint the initial icon to match the input's starting type (password → hidden).
    btn.innerHTML = input.type === 'password' ? EYE_OFF : EYE_OPEN;
    btn.setAttribute('aria-label', input.type === 'password' ? 'הצג סיסמה' : 'הסתר סיסמה');
    btn.addEventListener('click', () => {
      const wasHidden = input.type === 'password';
      input.type = wasHidden ? 'text' : 'password';
      btn.innerHTML = wasHidden ? EYE_OPEN : EYE_OFF;
      btn.setAttribute('aria-label', wasHidden ? 'הסתר סיסמה' : 'הצג סיסמה');
    });
  }
  bindEyeToggle(togglePass, passInput);
  bindEyeToggle(togglePassConfirm, passConfirmInput);

  // Live match indicator for signup confirm field
  function updateMatchIndicator() {
    if (mode !== 'signup' || !passMatchEl) return;
    const a = passInput.value;
    const b = passConfirmInput.value;
    if (!b) {
      passMatchEl.style.display = 'none';
      passMatchEl.textContent = '';
      passMatchEl.className = 'pass-match';
      return;
    }
    passMatchEl.style.display = 'flex';
    if (a === b) {
      passMatchEl.textContent = '✓ הסיסמאות תואמות';
      passMatchEl.className = 'pass-match match';
    } else {
      passMatchEl.textContent = '✗ הסיסמאות לא תואמות';
      passMatchEl.className = 'pass-match mismatch';
    }
  }

  // Password rules live update (only in signup mode)
  passInput.addEventListener('input', () => {
    if (mode !== 'signup') return;
    const v = passInput.value;
    const rules = {
      len:    v.length >= 8,
      letter: /[A-Za-z]/.test(v),
      digit:  /\d/.test(v),
      symbol: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(v),
    };
    document.querySelectorAll('.password-rules .rule').forEach(r => {
      r.classList.toggle('met', !!rules[r.dataset.rule]);
    });
    updateMatchIndicator();
  });
  if (passConfirmInput) passConfirmInput.addEventListener('input', updateMatchIndicator);

  // Forgot password
  if (forgotLink) forgotLink.addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    if (!email || !/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email) || email.includes('..')) {
      toast('הזן כתובת אימייל תקינה בשדה למעלה ואז לחץ שוב.', '');
      return;
    }
    // Raw fetch to /auth/v1/recover — no library dependency.
    const cfg = window.APP_CONFIG || {};
    if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(`${cfg.SUPABASE_URL}/auth/v1/recover`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': cfg.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${cfg.SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            email,
            options: { redirectTo: window.location.origin + '/#/settings?tab=profile' },
          }),
          signal: ctrl.signal,
          cache: 'no-store',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          toast('שגיאה: ' + (body.error_description || body.msg || 'לא ניתן לשלוח קישור'), 'error');
          return;
        }
      } catch (e) {
        toast('שגיאת רשת — נסה שוב', 'error');
        return;
      }
    }
    toast('קישור לאיפוס סיסמה נשלח ל-' + email, 'success');
  });

  // Google OAuth
  const oauthBtn = document.getElementById('oauth-google');
  if (oauthBtn) oauthBtn.addEventListener('click', async () => {
    oauthBtn.disabled = true;
    const originalContent = oauthBtn.innerHTML;
    oauthBtn.innerHTML = '<span>מתחבר עם Google...</span>';
    try {
      await Auth.loginWithGoogle();
      // If redirect happens, button stays disabled — that's fine
    } catch (err) {
      oauthBtn.disabled = false;
      oauthBtn.innerHTML = originalContent;
      const errEl = document.getElementById('auth-error');
      showAuthError(err.message || 'שגיאה בכניסה עם Google');
    }
  });

  // Helper: shake the error element and highlight a specific input field
  function showAuthError(msg, fieldEl) {
    const errEl = document.getElementById('auth-error');
    errEl.textContent = msg;
    errEl.classList.remove('success', 'info', 'shake');
    void errEl.offsetWidth; // force reflow for animation restart
    errEl.classList.add('shake');
    if (fieldEl) {
      fieldEl.classList.add('input-error');
      fieldEl.addEventListener('input', () => fieldEl.classList.remove('input-error'), { once: true });
    }
  }

  // Form submit
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('auth-email');
    const nameInput = document.getElementById('auth-name');
    const email = emailInput.value.trim();
    const password = passInput.value;
    const name = nameInput.value.trim();
    const errEl = document.getElementById('auth-error');
    const btn = document.getElementById('auth-submit');
    errEl.textContent = '';
    errEl.classList.remove('success', 'shake');
    if (!email || !password) { showAuthError('חובה למלא אימייל וסיסמה', !email ? emailInput : passInput); return; }
    if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email) || email.includes('..')) { showAuthError('כתובת האימייל לא תקינה', emailInput); return; }
    if (mode === 'signup') {
      if (password.length < 8) { showAuthError('סיסמה חייבת להיות לפחות 8 תווים', passInput); return; }
      if (!/[A-Za-z]/.test(password)) { showAuthError('סיסמה חייבת להכיל לפחות אות אחת', passInput); return; }
      if (!/\d/.test(password)) { showAuthError('סיסמה חייבת להכיל לפחות ספרה אחת', passInput); return; }
      const passwordConfirm = passConfirmInput ? passConfirmInput.value : '';
      if (!passwordConfirm) { showAuthError('נא לאמת את הסיסמה', passConfirmInput); return; }
      if (password !== passwordConfirm) { showAuthError('הסיסמאות לא תואמות', passConfirmInput); return; }
      if (!name) { showAuthError('נא להזין שם מלא', nameInput); return; }
    } else {
      if (password.length < 6) { showAuthError('סיסמה לא תקינה', passInput); return; }
    }
    btn.disabled = true;
    btn.textContent = mode === 'signup' ? 'יוצר חשבון...' : 'מתחבר...';
    try {
      let user;
      if (mode === 'signup') {
        user = await Auth.signup(email, password, name);
      } else {
        user = await Auth.login(email, password);
      }
      if (user.needsConfirmation) {
        // Email confirmation required — show message, don't navigate
        errEl.classList.remove('shake');
        errEl.classList.add('info');
        errEl.textContent = 'שלחנו אימייל אימות לכתובת שציינת — לחצו על הקישור כדי להשלים את ההרשמה.';
        btn.disabled = false;
        btn.textContent = 'יצירת חשבון';
        return;
      }
      state.user = user;
      errEl.classList.remove('shake');
      errEl.classList.add('success');
      errEl.textContent = mode === 'signup'
        ? 'ברוכים הבאים ל-ExamPrep! מעבירים אותך לסביבת העבודה...'
        : 'התחברת בהצלחה. מעבירים אותך לסביבת העבודה...';
      // Seed demo data for admin — fire-and-forget so a slow JSON load can't
      // pin the login button. It runs after we navigate to the dashboard.
      if (user.isAdmin) {
        Data.ensureLoaded().then(() => {
          if (DemoSeed.shouldSeed(user.email)) DemoSeed.build(user.email);
        }).catch(e => console.warn('[auth] post-login demo seed skipped:', e.message));
      }
      setTimeout(() => navigate('/dashboard'), 300);
    } catch (err) {
      // Translate common Supabase server errors to Hebrew
      const msg = err.message || '';
      const hebrewMsg = msg.includes('rate limit') || msg.includes('too many')
        ? 'יותר מדי ניסיונות. נסה שוב בעוד מספר דקות.'
        : msg.includes('Email not confirmed') || msg.includes('not confirmed')
        ? 'יש לאשר את כתובת האימייל. בדוק את תיבת הדואר שלך.'
        : msg.includes('already registered') || msg.includes('User already')
        ? 'כתובת האימייל כבר רשומה. נסה להתחבר.'
        : msg.includes('Password should be') || msg.includes('password is too short')
        ? 'הסיסמה קצרה מדי. בחר סיסמה ארוכה יותר.'
        : msg || 'שגיאה לא ידועה';
      showAuthError(hebrewMsg);
    } finally {
      btn.disabled = false;
      btn.textContent = mode === 'signup' ? 'יצירת חשבון' : 'כניסה';
    }
  });
}

// ===== Render: Dashboard =====
async function renderDashboard() {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');

  await CourseRegistry.ensureLoaded();
  // Load data for all registered courses so per-course stats and progress bars
  // on the global dashboard are accurate across all courses.
  await Promise.all(
    CourseRegistry.list().map(c => Data.ensureLoaded(c.id).catch(() => {}))
  );

  // For the admin user, ensure demo data is seeded so the new screens have
  // realistic content even on the very first dashboard visit.
  if (state.user.isAdmin && DemoSeed.shouldSeed(state.user.email)) {
    DemoSeed.build(state.user.email);
  }

  // For demo@examprep.co: seed fake progress so dashboard stats look used
  if (state.user.email === 'demo@examprep.co') {
    seedDemoProgress(state.user.email, CourseRegistry.list());
  }

  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-dash'));
  $app.firstElementChild?.classList.add('page-enter');

  wireTopbar(null);   // null = global dashboard — hides course-specific nav items

  // Trial countdown banner
  renderTrialBanner(document.querySelector('.app-content'));

  // Daily motivational quotes (cycling by day)
  const QUOTES = [
    'כל שאלה שאתה פותר היום — היא בחינה שאתה עוקף מחר.',
    'חזרה קצרה כל יום שווה יותר ממרתון לימוד ביום אחד.',
    'אתה לא לומד לזכור — אתה לומד להבין.',
    'ההצלחה היא סכום של מאמצים קטנים, חוזרים ונשנים יום אחר יום.',
    'תרגל כאילו הבחינה מחר. תנוח כאילו עשית הכל.',
    'כל שאלה קשה היום הופכת לשאלה קלה בבחינה.',
    'המוח שלך מתחזק בכל שאלה שאתה פותר.',
  ];
  const todayQuote = QUOTES[Math.floor(Date.now() / 86400000) % QUOTES.length];

  // Aggregate stats across ALL courses.
  // Source of truth: Supabase via /api/stats/summary. localStorage is only
  // consulted for the admin built-in `tohna1` course, whose attempts live
  // locally by design (see memory: project_admin_local_data.md).
  const allCourseIds = CourseRegistry.list().map(c => String(c.id));
  const summary = await Progress.fetchSummary();
  const dbAgg = summary?.aggregate || { total: 0, unique: 0, correct: 0, wrong: 0, reviewCount: 0 };
  const aggStats = { ...dbAgg };
  if (allCourseIds.includes('tohna1')) {
    const local = Progress.stats(state.user.email, 'tohna1');
    aggStats.total += local.total;
    aggStats.unique += local.unique;
    aggStats.correct += local.correct;
    aggStats.wrong += local.wrong;
    aggStats.reviewCount += local.reviewCount;
  }
  const accuracy = aggStats.unique > 0 ? Math.round((aggStats.correct / aggStats.unique) * 100) : 0;
  const hasActivity = aggStats.total > 0;
  const hasCourses = allCourseIds.length > 0;

  // Update greeting
  document.getElementById('dash-greet-title').textContent = `שלום ${state.user.name}`;
  const greetEl = document.querySelector('.dash-greet p');
  if (greetEl) greetEl.textContent = hasActivity
    ? `"${todayQuote}"`
    : 'ברוך הבא! בחר קורס כדי להתחיל לתרגל שאלות אמריקאיות.';
  if (greetEl && hasActivity) greetEl.style.cssText = 'font-style:italic;color:var(--text-muted);font-size:14px;margin-top:6px;max-width:600px;';

  const sg = document.getElementById('dash-stats');
  if (!hasCourses) {
    // Only show the welcome banner when the user has ZERO courses.
    // Showing it alongside existing courses was confusing users.
    sg.className = '';
    sg.innerHTML = `
      <div class="dash-welcome-banner">
        <div class="dash-welcome-content">
          <div class="dash-welcome-icon">
            <img src="/public/images/logo.png?v=20260410-8" alt="ExamPrep" class="dash-welcome-logo-img">
          </div>
          <h2>ברוך הבא ל-ExamPrep!</h2>
          <p>בחר תחום לימוד כדי להתחיל לתרגל שאלות אמריקאיות.</p>
          <button class="btn btn-primary btn-lg" id="btn-welcome-add-course">+ הוסף תחום לימוד</button>
        </div>
        <div class="dash-welcome-visual" aria-hidden="true">
          <img src="/public/images/marketing-hero.png" alt="" class="dash-welcome-hero-img">
        </div>
      </div>
    `;
    sg.querySelector('#btn-welcome-add-course')?.addEventListener('click', () => showAddDegreeModal());
  } else {
    sg.className = 'metric-grid dash-metric-grid';
    sg.innerHTML = `
      <div class="metric-card" style="--card-color:#3b82f6">
        <div class="metric-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          סך ניסיונות
        </div>
        <div class="metric-value">${aggStats.total}</div>
        <div class="metric-sub">${aggStats.unique} שאלות ייחודיות</div>
      </div>
      <div class="metric-card" style="--card-color:#22c55e">
        <div class="metric-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          תשובות נכונות
        </div>
        <div class="metric-value">${aggStats.correct}</div>
        <div class="metric-sub">דיוק כללי <strong>${accuracy}%</strong></div>
      </div>
      <div class="metric-card" style="--card-color:#f97316">
        <div class="metric-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          טעיתי / הוצגו
        </div>
        <div class="metric-value">${aggStats.wrong}</div>
        <div class="metric-sub">שאלות שצריך לחזור עליהן</div>
      </div>
      <div class="metric-card" style="--card-color:#a855f7">
        <div class="metric-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
          בתור החזרה
        </div>
        <div class="metric-value">${aggStats.reviewCount}</div>
        <div class="metric-sub">בהמתנה לתרגול חוזר</div>
      </div>
    `;
  }

  // Courses — dynamic list from CourseRegistry
  const cg = document.getElementById('dash-courses');
  const allCourses = CourseRegistry.list();
  // For admin: if a "מדעי המחשב" degree exists, hide the builtin tohna1 from the
  // top-level dashboard (it will appear inside the degree as a sub-course instead).
  // Modelim-plan admins (the course-library owner) don't want tohna1 anywhere —
  // they manage only the seeded modelim content.
  const isModelimAdmin = state.user?.isAdmin && state.user?.plan === 'modelim';
  const csDegreeForAdmin = state.user?.isAdmin && !isModelimAdmin
    ? allCourses.find(c => c.is_degree && c.name.includes('מדעי המחשב'))
    : null;
  const activeCourses = allCourses.filter(c => !c.archived && !(isModelimAdmin && c.id === 'tohna1') && !(csDegreeForAdmin && c.id === 'tohna1'));
  const archivedCourses = allCourses.filter(c => c.archived);

  function renderCourseCard(c) {
    let qCount = 0, eCount = 0;
    if (c.id === 'tohna1') {
      qCount = Data.allQuestions().length;
      eCount = Data.metadata?.exams?.length || 0;
    } else if (c.is_degree) {
      // Degree card: show sub-course count instead of question/exam counts
      qCount = 0; eCount = 0;
    } else {
      qCount = c.total_questions || 0;
      eCount = c.total_pdfs || 0;
    }
    const cid = String(c.id);
    // tohna1 stats live in localStorage (admin-only built-in); everything
    // else comes from the server-side summary so the card reflects the DB.
    const cStats = cid === 'tohna1'
      ? Progress.stats(state.user.email, cid)
      : (summary?.perCourse?.[cid] || { total: 0, unique: 0, correct: 0, wrong: 0, reviewCount: 0 });
    const covPct = qCount > 0 ? Math.min(100, Math.round((cStats.unique / qCount) * 100)) : 0;
    const accPct = cStats.unique > 0 ? Math.round((cStats.correct / cStats.unique) * 100) : 0;
    const hasProgress = cStats.total > 0;
    // Admin: CS degree shows builtin tohna1 as a synthetic sub-course, so add 1 to child_count.
    // Modelim-plan admins don't get that injection (they own only the seeded content).
    const childCount = (c.child_count || 0) + (state.user?.isAdmin && !isModelimAdmin && c.is_degree && c.name.includes('מדעי המחשב') ? 1 : 0);
    return `
      <div class="course-card${c.is_degree ? ' degree-card' : ''}" style="--course-color:${escapeHtml(c.color || '#3b82f6')}" data-course="${escapeHtml(cid)}" data-is-degree="${c.is_degree ? '1' : '0'}">
        ${!c.isBuiltin ? `<button class="course-menu-btn" data-course-id="${c.id}" data-course-name="${escapeHtml(c.name)}" data-archived="${c.archived || false}" title="אפשרויות">⋯</button>` : ''}
        ${c.is_degree ? `<div class="degree-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>תחום לימוד</div>` : ''}
        <div class="course-card-header">
          ${c.image_url ? `<img class="course-img" src="${escapeHtml(c.image_url)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
          <h3>${escapeHtml(c.name)}</h3>
        </div>
        <div class="desc">${escapeHtml(c.description || '')}</div>
        ${!c.is_degree && qCount > 0 ? `
        <div class="course-card-progress">
          <div class="course-card-progress-bar" style="width:${covPct}%;background:var(--course-color,#3b82f6);"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:2px;margin-bottom:6px;">
          <span>כיסוי: ${covPct}%</span>
          ${hasProgress ? `<span>דיוק: ${accPct}%</span>` : ''}
        </div>` : ''}
        ${!c.is_degree ? `<div class="ccard-batches" id="course-batches-${escapeHtml(cid)}"></div>` : ''}
        <div class="meta">
          ${c.is_degree
            ? `<span class="degree-courses-count">${childCount} קורסים</span><span class="ready-pill course-cta-pill">כנס לתחום ←</span>`
            : `<span>${qCount} שאלות</span><span>${eCount} מבחנים</span>${c.isBuiltin || qCount > 0 ? `<span class="ready-pill course-cta-pill">${hasProgress ? 'המשך ←' : 'התחל ←'}</span>` : '<span class="ready-pill empty">ריק</span>'}`}
        </div>
      </div>
    `;
  }

  function renderDashBatches(batches, cid) {
    if (!batches || batches.length === 0) return '';
    return batches.slice(0, 2).map((b, i) => {
      const score = b.size > 0 ? Math.round((b.correct / b.size) * 100) : 0;
      const cls = score >= 80 ? 'good' : score >= 60 ? 'mid' : 'bad';
      const date = b.endedAt ? new Date(b.endedAt).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' }) : '';
      return `<button type="button" class="ccard-batch ${cls}" data-batch-i="${i}" data-batch-cid="${escapeHtml(String(cid))}" title="לחץ לסקירה">
        <span class="ccard-batch-score">${score}%</span>
        <span class="ccard-batch-info">${b.correct}/${b.size} · ${date}</span>
      </button>`;
    }).join('');
  }

  // Cache of batches per course so click handlers can resolve a chip to its batch object.
  const dashBatchCache = {};

  function wireDashBatchClicks(cid) {
    document.querySelectorAll(`#course-batches-${cid} .ccard-batch`).forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const i = parseInt(chip.dataset.batchI, 10);
        const list = dashBatchCache[cid] || [];
        const b = list[i];
        if (!b) return;
        if (!setCourseContext(cid)) return;
        state.lastBatch = b;
        navigate(`/course/${cid}/summary`);
      });
    });
  }

  let coursesHtml = activeCourses.map(renderCourseCard).join('');
  coursesHtml += `
    <div class="course-card add" id="btn-add-course-card">
      <div class="add-card-content">
        <div class="add-icon">+</div>
        <strong>הוסף תחום לימוד</strong>
        <small>תואר, פסיכומטרי ועוד</small>
      </div>
    </div>
  `;

  // Archived courses
  if (archivedCourses.length) {
    coursesHtml += `
      <div style="grid-column:1/-1;margin-top:12px;">
        <button class="btn btn-ghost btn-sm" id="dash-show-archived" style="font-size:13px;color:var(--text-muted);">
          📦 ארכיון (${archivedCourses.length} קורסים) ▾
        </button>
        <div id="dash-archived" style="display:none;margin-top:12px;display:none;">
          <div class="courses-grid">${archivedCourses.map(renderCourseCard).join('')}</div>
        </div>
      </div>
    `;
  }

  cg.innerHTML = coursesHtml;

  // Async: populate recent batch chips for each active course card
  activeCourses.filter(c => !c.is_degree).forEach(c => {
    const cid = String(c.id);
    const el = document.getElementById(`course-batches-${cid}`);
    if (!el) return;
    const local = (Progress.load(state.user.email, cid).batches || []).slice(-2).reverse();
    dashBatchCache[cid] = local;
    el.innerHTML = renderDashBatches(local, cid);
    wireDashBatchClicks(cid);
    if (state.user?.email && cid !== 'tohna1') {
      Progress.fetchRemoteBatches(cid, 2).then(remote => {
        if (!remote?.length) return;
        const seen = new Set(local.map(b => b.batchId));
        const merged = [...local, ...remote.filter(b => !seen.has(b.batchId))].sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 2);
        const stillEl = document.getElementById(`course-batches-${cid}`);
        if (stillEl) {
          dashBatchCache[cid] = merged;
          stillEl.innerHTML = renderDashBatches(merged, cid);
          wireDashBatchClicks(cid);
        }
      }).catch(() => {});
    }
  });

  // "מה ללמוד היום?" widget — find weakest course with questions.
  // Same DB-first rule as the per-course cards above.
  const studyCourses = CourseRegistry.list().filter(c => !c.archived).map(c => {
    const cid = String(c.id);
    const qCount = c.id === 'tohna1' ? Data.allQuestions().length : (c.total_questions || 0);
    if (qCount === 0) return null;
    const s = cid === 'tohna1'
      ? Progress.stats(state.user.email, cid)
      : (summary?.perCourse?.[cid] || { total: 0, unique: 0, correct: 0 });
    const acc = s.unique > 0 ? Math.round((s.correct / s.unique) * 100) : (s.total > 0 ? 0 : -1);
    return { c, qCount, acc, total: s.total };
  }).filter(Boolean);

  const appContent = document.querySelector('.app-content');
  const existingWidget = document.getElementById('dash-study-tip');
  if (existingWidget) existingWidget.remove();

  if (studyCourses.length > 0 && appContent) {
    // Pick: lowest accuracy if has activity, else first course
    const withActivity = studyCourses.filter(x => x.total > 0);
    const pick = withActivity.length > 0
      ? withActivity.sort((a, b) => a.acc - b.acc)[0]
      : studyCourses[0];
    const tipEl = document.createElement('div');
    tipEl.id = 'dash-study-tip';
    tipEl.className = 'dash-study-tip';
    tipEl.innerHTML = `
      <div class="dash-study-tip-inner">
        <div class="dash-study-tip-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg></div>
        <div class="dash-study-tip-text">
          <strong>מה ללמוד היום?</strong>
          <span>${pick.c.name} — ${pick.total > 0 ? `דיוק ${pick.acc}%, יש מה לשפר` : 'טרם התחלת, זה הזמן!'}</span>
        </div>
        <button class="btn btn-primary dash-study-tip-btn" data-course="${escapeHtml(String(pick.c.id))}">תרגל עכשיו ←</button>
      </div>
    `;
    appContent.appendChild(tipEl);
    tipEl.querySelector('.dash-study-tip-btn').addEventListener('click', () => {
      navigate(`/course/${pick.c.id}/quiz`);
    });
  }

  // Toggle archived
  document.getElementById('dash-show-archived')?.addEventListener('click', () => {
    const el = document.getElementById('dash-archived');
    if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
  });

  // Course/degree card click → navigate with instant visual feedback
  cg.querySelectorAll('.course-card:not(.add)').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.course-menu-btn')) return;
      card.style.transition = 'opacity 0.1s';
      card.style.opacity = '0.6';
      const isDegree = card.dataset.isDegree === '1';
      navigate(isDegree ? `/degree/${card.dataset.course}` : `/course/${card.dataset.course}`);
    });
  });

  // Course menu buttons (archive/delete)
  cg.querySelectorAll('.course-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const courseId = btn.dataset.courseId;
      const courseName = btn.dataset.courseName;
      const isArchived = btn.dataset.archived === 'true';

      // Simple action menu — appended to body to escape card's overflow:hidden
      const menu = document.createElement('div');
      menu.className = 'course-action-menu';
      menu.innerHTML = `
        <button class="course-action-item" data-act="${isArchived ? 'unarchive' : 'archive'}">
          ${isArchived ? '📂 הוצא מארכיון' : '📦 העבר לארכיון'}
        </button>
        <button class="course-action-item danger" data-act="delete">🗑️ מחק קורס</button>
      `;
      const r = btn.getBoundingClientRect();
      menu.style.cssText = `position:fixed;top:${r.bottom + 4}px;left:${r.left}px;z-index:9999;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-lg);padding:4px;min-width:160px;`;
      document.body.appendChild(menu);

      const closeMenu = () => menu.remove();
      setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 10);

      menu.querySelectorAll('.course-action-item').forEach(item => {
        item.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          closeMenu();
          const act = item.dataset.act;
          const tk = await Auth.getToken();
          if (act === 'archive' || act === 'unarchive') {
            const r = await fetch(`/api/courses/${courseId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
              body: JSON.stringify({ archived: act === 'archive' }),
            });
            if (r.ok) {
              const c = state.courses.find(x => String(x.id) === String(courseId));
              if (c) c.archived = (act === 'archive');
              toast(act === 'archive' ? 'הקורס הועבר לארכיון' : 'הקורס הוחזר מהארכיון', 'success');
              renderDashboard();
            } else toast('שגיאה', 'error');
          } else if (act === 'delete') {
            showConfirmModal({
              title: 'מחיקת קורס',
              body: `למחוק את "${courseName}"? כל המבחנים, השאלות והנתונים יימחקו לצמיתות. לא ניתן לשחזר.`,
              confirmLabel: 'מחק לצמיתות', danger: true,
              onConfirm: async () => {
                const dr = await fetch(`/api/courses/${courseId}`, {
                  method: 'DELETE', headers: { Authorization: `Bearer ${tk}` },
                });
                if (dr.ok) {
                  state.courses = state.courses.filter(x => String(x.id) !== String(courseId));
                  toast('הקורס נמחק', 'success');
                  renderDashboard();
                } else toast('שגיאה במחיקה', 'error');
              },
            });
          }
        });
      });
    });
  });

  document.getElementById('btn-add-course-card')?.addEventListener('click', () => showAddDegreeModal());
  document.getElementById('btn-add-course')?.addEventListener('click', () => showAddDegreeModal());

  // Show onboarding tour every visit while the user has no degrees/courses
  if (!hasCourses && !sessionStorage.getItem('ep_onboarding_skip')) {
    setTimeout(() => showOnboardingTour(), 600);
  }

  // Admin-only: button to preview the onboarding tour as a new user would see it
  if (state.user.isAdmin) {
    const demoBtn = document.createElement('button');
    demoBtn.className = 'admin-demo-btn';
    demoBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      תצוגת משתמש חדש
    `;
    demoBtn.addEventListener('click', () => {
      sessionStorage.removeItem('ep_onboarding_skip');
      showOnboardingTour();
    });
    document.querySelector('.app-content')?.appendChild(demoBtn);
  }
}

// ===== Degree Dashboard =====
async function renderDegreeDashboard(degreeId) {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');

  await CourseRegistry.ensureLoaded();
  const degree = CourseRegistry.get(degreeId);
  if (!degree) return navigate('/dashboard');

  state.degree = degree;
  let subCourses = await CourseRegistry.listSubCourses(degreeId);

  // For admin: inject the builtin tohna1 course as the first sub-course of any
  // "מדעי המחשב" degree so its data appears inside the degree hierarchy.
  // Modelim-plan admins don't want tohna1 — they manage only the seeded content.
  const isModelimAdmin = state.user?.isAdmin && state.user?.plan === 'modelim';
  if (state.user?.isAdmin && !isModelimAdmin && degree.name.includes('מדעי המחשב')) {
    subCourses = [CourseRegistry.BUILTIN, ...subCourses];
  }

  // Seed demo progress for sub-courses
  if (state.user.email === 'demo@examprep.co') seedDemoProgress(state.user.email, subCourses);

  // Load data for sub-courses so progress bars are accurate
  await Promise.all(subCourses.map(c => Data.ensureLoaded(c.id).catch(() => {})));

  // DB-authoritative stats (same source the global dashboard reads).
  const summary = await Progress.fetchSummary();

  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-degree-dash'));
  $app.firstElementChild?.classList.add('page-enter');
  wireTopbar(null);

  document.getElementById('degree-dash-title').textContent = degree.name;
  document.getElementById('degree-dash-desc').textContent = degree.description || '';
  document.getElementById('degree-color-bar').style.background = degree.color || '#3b82f6';

  const cg = document.getElementById('degree-courses');

  function renderSubCourseCard(c) {
    const qCount = c.total_questions || 0;
    const eCount = c.total_pdfs || 0;
    const cid = String(c.id);
    const cStats = cid === 'tohna1'
      ? Progress.stats(state.user.email, cid)
      : (summary?.perCourse?.[cid] || { total: 0, unique: 0, correct: 0, wrong: 0, reviewCount: 0 });
    const covPct = qCount > 0 ? Math.min(100, Math.round((cStats.unique / qCount) * 100)) : 0;
    const accPct = cStats.unique > 0 ? Math.round((cStats.correct / cStats.unique) * 100) : 0;
    const hasProgress = cStats.total > 0;
    return `
      <div class="course-card" style="--course-color:${escapeHtml(c.color || degree.color || '#3b82f6')}" data-course="${escapeHtml(cid)}" data-is-degree="0">
        <div class="course-card-header">
          ${c.image_url ? `<img class="course-img" src="${escapeHtml(c.image_url)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
          <h3>${escapeHtml(c.name)}</h3>
        </div>
        <div class="desc">${escapeHtml(c.description || '')}</div>
        ${qCount > 0 ? `
        <div class="course-card-progress">
          <div class="course-card-progress-bar" style="width:${covPct}%;background:var(--course-color,#3b82f6);"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:2px;margin-bottom:6px;">
          <span>כיסוי: ${covPct}%</span>
          ${hasProgress ? `<span>דיוק: ${accPct}%</span>` : ''}
        </div>` : ''}
        <div class="meta">
          <span>${qCount} שאלות</span>
          <span>${eCount} מבחנים</span>
          ${qCount > 0 ? `<span class="ready-pill course-cta-pill">${hasProgress ? 'המשך ←' : 'התחל ←'}</span>` : '<span class="ready-pill empty">ריק</span>'}
        </div>
      </div>`;
  }

  let html = subCourses.filter(c => !c.archived).map(renderSubCourseCard).join('');
  html += `
    <div class="course-card add" id="btn-add-sub-course-card">
      <div class="add-card-content">
        <div class="add-icon">+</div>
        <strong>הוסף קורס</strong>
        <small>הוסף קורס לתחום זה</small>
      </div>
    </div>`;
  cg.innerHTML = html;

  cg.querySelectorAll('.course-card:not(.add)').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.course-menu-btn')) return;
      card.style.transition = 'opacity 0.1s';
      card.style.opacity = '0.6';
      navigate(`/course/${card.dataset.course}`);
    });
  });

  const addSubCourseFn = () => showAddSubCourseModal(degree);
  document.getElementById('btn-add-sub-course')?.addEventListener('click', addSubCourseFn);
  document.getElementById('btn-add-sub-course-card')?.addEventListener('click', addSubCourseFn);
}

// ===== Demo progress seeding (only for demo@examprep.co) =====
function seedDemoProgress(email, courses) {
  if (email !== 'demo@examprep.co') return;
  const FLAG = 'ep_demo_seeded_v2';
  if (localStorage.getItem(FLAG)) return;
  const fakeUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
  for (const course of (courses || [])) {
    const totalQ = course.total_questions || 0;
    if (totalQ === 0) continue;
    const coverage = 0.35 + Math.random() * 0.40;
    const accuracy = 0.58 + Math.random() * 0.22;
    const uniqueAttempted = Math.max(1, Math.floor(totalQ * coverage));
    const qids = Array.from({ length: uniqueAttempted }, () => fakeUUID());
    const attempts = [];
    for (const qid of qids) {
      const correct = Math.random() < accuracy;
      attempts.push({ qid, correct, revealed: false, ts: Date.now() - Math.floor(Math.random() * 10 * 86400000) });
      if (Math.random() < 0.25) {
        attempts.push({ qid, correct: Math.random() < (accuracy + 0.08), revealed: false, ts: Date.now() - Math.floor(Math.random() * 4 * 86400000) });
      }
    }
    const key = `ep_progress_${email}_${course.id}`;
    if (!localStorage.getItem(key)) {
      try { localStorage.setItem(key, JSON.stringify({ attempts, reviewQueue: [], batches: [] })); } catch {}
    }
  }
  localStorage.setItem(FLAG, '1');
}

// ===== Add Degree Modal (pre-built chooser) =====
const _UNS = (id) => `https://images.unsplash.com/photo-${id}?w=88&h=88&fit=crop&auto=format`;
const DEGREE_CATEGORIES = [
  {
    label: 'פסיכומטרי', icon: '🧠',
    degrees: [
      { name: 'הסקה כמותית',       desc: 'מתמטיקה, אלגברה, גאומטריה',  color: '#2563eb', image: _UNS('1635070041078-e363dbe005cb') },
      { name: 'אנגלית (פסיכומטרי)',desc: 'אוצר מילים, הבנת הנקרא',      color: '#0891b2', image: _UNS('1456513080510-7bf3a84b82f8') },
      { name: 'חשיבה מילולית',     desc: 'אנלוגיות, השלמת משפטים',      color: '#7c3aed', image: _UNS('1512820790803-83ca734da794') },
    ],
  },
  {
    label: 'אמירם', icon: '✍️',
    degrees: [
      { name: 'לשון ודקדוק',        desc: 'תחביר, מורפולוגיה, כתיב',  color: '#dc2626', image: _UNS('1456735190827-d1262f71b8a3') },
      { name: 'הבנת הנקרא (עברית)', desc: 'ניתוח טקסטים, הסקה',       color: '#16a34a', image: _UNS('1481627834876-b7833e8f5570') },
    ],
  },
  {
    label: 'לימודים אקדמיים', icon: '🎓',
    degrees: [
      { name: 'מדעי המחשב',        desc: 'תכנות, אלגוריתמים, מבנה נתונים',     color: '#2563eb', image: _UNS('1461749280684-dccba630e2f6') },
      { name: 'מתמטיקה',           desc: 'חשבון אינפיניטסימלי, אלגברה לינארית, משוואות דיפרנציאליות', color: '#0ea5e9', image: _UNS('1635070041078-e363dbe005cb') },
      { name: 'פיזיקה',            desc: 'מכניקה, קוונטים, אלקטרומגנטיות',     color: '#d97706', image: _UNS('1636466497217-26a8cbeaf0aa') },
      { name: 'כימיה',             desc: 'כימיה אורגנית, אנאורגנית ופיזיקלית', color: '#7c3aed', image: _UNS('1532187863486-abf9dbad1b69') },
      { name: 'ביולוגיה',          desc: 'גנטיקה, מיקרוביולוגיה, אנטומיה',    color: '#16a34a', image: _UNS('1518152006812-edab29b069ac') },
      { name: 'משפטים',            desc: 'דיני חוזים, נזיקין, מנהלי',          color: '#dc2626', image: _UNS('1589829545856-d10d557cf95f') },
      { name: 'כלכלה',             desc: 'מיקרואקונומיה, מאקרו, פיננסים',      color: '#0891b2', image: _UNS('1611974789855-9c2a0a7236a3') },
      { name: 'פסיכולוגיה',        desc: 'קוגניציה, פרסונליות, מחקר',          color: '#ec4899', image: _UNS('1559757148-5c350d0d3c56') },
      { name: 'ניהול ומנהל עסקים', desc: 'שיווק, חשבונאות, ניהול',             color: '#f59e0b', image: _UNS('1454165804606-c3d57bc86b40') },
      { name: 'הנדסה',             desc: 'מתמטיקה הנדסית, פיזיקה, תכנות',      color: '#64748b', image: _UNS('1518770660439-4636190af475') },
      { name: 'רפואה',             desc: 'אנטומיה, פיזיולוגיה, ביוכימיה',      color: '#ef4444', image: _UNS('1505751172876-fa1923c5c528') },
      { name: 'סוציולוגיה',        desc: 'חברה, תרבות, מחקר חברתי',           color: '#8b5cf6', image: _UNS('1529156069898-49953e39b3ac') },
      { name: 'תקשורת',            desc: 'מדיה, עיתונאות, תקשורת שיווקית',    color: '#06b6d4', image: _UNS('1495020689067-958852a7765e') },
    ],
  },
];

function showAddDegreeModal() {
  const plan = state.user?.plan || 'free';
  // Free plan now has courses=5; server enforces the limit
  const planDef = PLANS[plan] || PLANS.free;
  if (planDef.maxCourses !== -1 && state.courses.length >= planDef.maxCourses) {
    showPaywallModal('course_limit');
    return;
  }

  const wrap = document.createElement('div');
  wrap.appendChild(tmpl('tmpl-add-degree'));
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('add-degree-modal');
  const close = () => modal.remove();
  document.getElementById('add-degree-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  function showStep(step) {
    ['choose', 'request', 'custom'].forEach(s => {
      document.getElementById(`add-degree-step-${s}`).style.display = s === step ? '' : 'none';
    });
  }

  // Render categories
  const catEl = document.getElementById('degree-categories');
  catEl.innerHTML = DEGREE_CATEGORIES.map(cat => `
    <div class="degree-category">
      <div class="degree-category-label">${cat.icon} ${escapeHtml(cat.label)}</div>
      <div class="degree-options">
        ${cat.degrees.map(d => `
          <button class="degree-option-btn" data-name="${escapeHtml(d.name)}" data-desc="${escapeHtml(d.desc)}" data-color="${escapeHtml(d.color)}" data-image="${escapeHtml(d.image || '')}">
            ${d.image ? `<img src="${escapeHtml(d.image)}" alt="" width="22" height="22" style="border-radius:5px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">` : `<span class="degree-option-dot" style="background:${escapeHtml(d.color)}"></span>`}
            ${escapeHtml(d.name)}
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');

  // Preset degree click → create immediately
  catEl.querySelectorAll('.degree-option-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      const desc = btn.dataset.desc;
      const color = btn.dataset.color;
      const image = btn.dataset.image || null;
      btn.disabled = true;
      btn.textContent = 'יוצר...';
      try {
        const degree = await CourseRegistry.create(name, desc, color, image, { is_degree: true });
        close();
        toast(`התחום "${degree.name}" נוצר בהצלחה!`, 'success');
        navigate(`/degree/${degree.id}`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = name;
        toast(err.message || 'שגיאה ביצירת תחום', 'error');
      }
    });
  });

  document.getElementById('btn-degree-request').addEventListener('click', () => showStep('request'));
  document.getElementById('btn-degree-custom').addEventListener('click', () => showStep('custom'));
  document.getElementById('btn-degree-req-back').addEventListener('click', () => showStep('choose'));
  document.getElementById('btn-dc-back').addEventListener('click', () => showStep('choose'));

  // Request form
  document.getElementById('btn-degree-req-send').addEventListener('click', async () => {
    const degName = document.getElementById('degree-req-name').value.trim();
    const reqEmail = document.getElementById('degree-req-email').value.trim();
    const errEl = document.getElementById('degree-req-error');
    errEl.textContent = '';
    if (!degName || degName.length < 2) { errEl.textContent = 'אנא הזן שם תחום'; return; }
    const btn = document.getElementById('btn-degree-req-send');
    btn.disabled = true; btn.textContent = 'שולח...';
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: reqEmail || 'משתמש ExamPrep',
          email: reqEmail || 'no-reply@examprep.co',
          subject: 'other',
          message: `בקשה להוספת תחום לימוד:\n\nתחום: ${degName}\nאימייל: ${reqEmail || 'לא צוין'}`,
        }),
      });
      if (!res.ok) throw new Error('שגיאה בשליחה');
      close();
      toast('הבקשה נשלחה! נוסיף את התחום בקרוב.', 'success');
    } catch {
      btn.disabled = false; btn.textContent = 'שלח בקשה';
      errEl.textContent = 'שגיאה בשליחה, נסה שוב';
    }
  });

  // Custom degree form
  let customColor = '#3b82f6';
  document.querySelectorAll('#dc-colors .color-swatch').forEach(sw => {
    sw.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('#dc-colors .color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      customColor = sw.dataset.color;
    });
  });
  document.getElementById('dc-submit').addEventListener('click', async () => {
    const name = document.getElementById('dc-name').value.trim();
    const desc = document.getElementById('dc-desc').value.trim();
    const errEl = document.getElementById('dc-error');
    errEl.textContent = '';
    if (!name || name.length < 2) { errEl.textContent = 'שם התחום חייב להיות לפחות 2 תווים'; return; }
    const btn = document.getElementById('dc-submit');
    btn.disabled = true; btn.textContent = 'יוצר...';
    try {
      const degree = await CourseRegistry.create(name, desc || null, customColor, null, { is_degree: true });
      close();
      toast(`התחום "${degree.name}" נוצר בהצלחה!`, 'success');
      if (getRoute() === '/dashboard') renderDashboard();
      navigate(`/degree/${degree.id}`);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'צור תחום';
      errEl.textContent = err.message || 'שגיאה ביצירת תחום';
    }
  });
}

// ===== Add Sub-Course Modal =====
function showAddSubCourseModal(degree) {
  const wrap = document.createElement('div');
  wrap.appendChild(tmpl('tmpl-add-sub-course'));
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('add-sub-course-modal');
  const close = () => modal.remove();
  document.getElementById('asc-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('asc-degree-name').textContent = `בתוך התחום: ${degree.name}`;

  let selectedColor = degree.color || '#3b82f6';
  // Pre-select the swatch closest to degree color
  document.querySelectorAll('#asc-colors .color-swatch').forEach(sw => {
    if (sw.dataset.color === selectedColor) sw.classList.add('active');
    else sw.classList.remove('active');
    sw.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('#asc-colors .color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      selectedColor = sw.dataset.color;
    });
  });

  document.getElementById('asc-submit').addEventListener('click', async () => {
    const name = document.getElementById('asc-name').value.trim();
    const desc = document.getElementById('asc-desc').value.trim();
    const errEl = document.getElementById('asc-error');
    errEl.textContent = '';
    if (!name || name.length < 2) { errEl.textContent = 'שם הקורס חייב להיות לפחות 2 תווים'; return; }
    const btn = document.getElementById('asc-submit');
    btn.disabled = true; btn.textContent = 'יוצר קורס...';
    try {
      // Refresh the course list from the server first. Without this, a stale
      // state.courses (e.g. degree deleted in another tab, or a cached client
      // after a partial create) would cause /api/courses to reject the insert
      // with the misleading "קורס האב לא נמצא" error.
      await CourseRegistry.refresh();
      const liveDegree = CourseRegistry.get(degree.id);
      if (!liveDegree) {
        close();
        toast('התחום אינו זמין יותר — רענן את הדף', 'error');
        navigate('/dashboard');
        return;
      }
      const course = await CourseRegistry.create(name, desc || null, selectedColor, null, { parent_id: liveDegree.id });
      close();
      toast(`הקורס "${course.name}" נוצר בהצלחה!`, 'success');
      renderDegreeDashboard(liveDegree.id);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'צור קורס';
      errEl.textContent = err.message || 'שגיאה ביצירת קורס';
    }
  });
}

// ===== Course actions modal =====
function showCourseActionsModal(course) {
  const wrap = document.createElement('div');
  wrap.appendChild(tmpl('tmpl-course-actions'));
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('course-actions-modal');
  document.getElementById('ca-title').textContent = course.name;
  const close = () => modal.remove();
  document.getElementById('ca-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelectorAll('.action-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const action = tile.dataset.action;
      const cid = course.id || state.course?.id || 'tohna1';
      close();
      if (action === 'practice') showBatchModal();
      else if (action === 'lab') navigate(`/course/${cid}/lab`);
      else if (action === 'insights') navigate(`/course/${cid}/insights`);
      else if (action === 'progress') navigate(`/course/${cid}/progress`);
      else if (action === 'study') navigate(`/course/${cid}/study`);
    });
  });
}

// ===== Render: Course Dashboard =====
async function renderCourseDashboard() {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');
  if (!state.course) state.course = CourseRegistry.BUILTIN;

  // Ensure courses are loaded (critical after page refresh)
  await CourseRegistry.ensureLoaded();
  // Re-resolve course from registry to get real name/color
  const registryCourse = CourseRegistry.get(state.course.id);
  if (registryCourse) state.course = registryCourse;

  const cid = state.course.id;
  try { await Data.ensureLoaded(cid); } catch (e) { console.warn('[course] data load failed:', e.message); }

  // Seed realistic tohna1 history for demo user so explanations and history are visible
  if (state.user.email === 'demo@examprep.co' && cid === 'tohna1' && DemoSeed.shouldSeed(state.user.email)) {
    try { DemoSeed.build(state.user.email); } catch {}
  }

  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-course-dash'));
  $app.firstElementChild?.classList.add('page-enter');
  wireTopbar();

  // Trial countdown banner
  renderTrialBanner(document.querySelector('.app-content'));

  // Header
  const headerEl = document.getElementById('cd-header');
  headerEl.style.setProperty('--course-color', state.course.color || '#3b82f6');
  document.getElementById('cd-title').textContent = state.course.name;
  document.getElementById('cd-desc').textContent = state.course.description || '';

  // Stats
  const uid = state.user.email;
  const questions = questionsForCourse(cid);
  const exams = examsForCourse(cid);
  const stats = Progress.stats(uid, cid);
  const accuracy = stats.unique > 0 ? Math.round((stats.correct / stats.unique) * 100) : 0;
  const coverage = questions.length > 0 ? Math.round((stats.unique / questions.length) * 100) : 0;
  document.getElementById('cd-stats').innerHTML = `
    <div class="metric-card">
      <div class="metric-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        שאלות בקורס
      </div>
      <div class="metric-value">${questions.length}</div>
      <div class="metric-sub">${exams.length} מבחנים</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        דיוק
      </div>
      <div class="metric-value">${accuracy}%</div>
      <div class="metric-sub">${stats.correct} מתוך ${stats.unique} שאלות</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
        כיסוי
      </div>
      <div class="metric-value">${coverage}%</div>
      <div class="metric-sub">${stats.unique} מתוך ${questions.length}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
        בתור החזרה
      </div>
      <div class="metric-value">${stats.reviewCount}</div>
      <div class="metric-sub">שאלות לחזור עליהן</div>
    </div>
  `;

  // Quick actions — 6 tiles, consistent for all courses
  const isUserCourse = !state.course.isBuiltin;
  const examCount = questions.length;
  const examFileCount = exams.length;
  document.getElementById('cd-actions').innerHTML = `
    <button class="action-tile action-tile-featured" data-action="practice">
      <span class="action-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg></span>
      <strong>תרגול חופשי</strong>
      <small>בחר גודל מקבץ והתחל לתרגל</small>
    </button>
    <button class="action-tile ${isUserCourse ? 'action-tile-upload' : ''}" data-action="${isUserCourse ? 'upload' : 'exams'}">
      <span class="action-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>
      <strong>${isUserCourse ? 'ניהול מבחנים' : 'בנק השאלות'}</strong>
      <small>${isUserCourse ? 'העלאה, צפייה ומחיקת מבחנים' : `${examFileCount} מבחנים · ${examCount} שאלות`}</small>
    </button>
    <button class="action-tile" data-action="lab">
      <span class="action-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v7.31"/><path d="M14 9.3V1.99"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/><path d="M5.58 16.5h12.85"/></svg></span>
      <strong>מעבדה חכמה</strong>
      <small>מבחני דמה + יוצר שאלות</small>
    </button>
    <button class="action-tile" data-action="insights">
      <span class="action-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></span>
      <strong>תובנות וניתוח</strong>
      <small>ניתוח חומר ומפת נושאים</small>
    </button>
    <button class="action-tile" data-action="progress">
      <span class="action-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></span>
      <strong>ההתקדמות שלי</strong>
      <small>סטטיסטיקה, רצף וטיפים</small>
    </button>
    <button class="action-tile" data-action="study">
      <span class="action-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></span>
      <strong>לימוד מסיכום</strong>
      <small>שאלות + כרטיסיות + מתאר</small>
    </button>
  `;

  document.querySelectorAll('#cd-actions .action-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const action = tile.dataset.action;
      if (action === 'upload') showExamManagementModal(cid);
      else if (action === 'exams') showExamManagementModal(cid);
      else if (action === 'practice') showBatchModal();
      else if (action === 'lab') navigate(`/course/${cid}/lab`);
      else if (action === 'insights') navigate(`/course/${cid}/insights`);
      else if (action === 'progress') navigate(`/course/${cid}/progress`);
      else if (action === 'study') navigate(`/course/${cid}/study`);
    });
  });

  // ===== Recent batches section =====
  // First render whatever is in localStorage immediately. Then asynchronously
  // pull remote batches from Supabase and merge — so users see history even
  // on a fresh device / browser after login.
  const batchesEl = document.getElementById('cd-batches');
  const batchesHeader = document.getElementById('cd-batches-header');
  renderRecentBatches(batchesForCourse(uid, cid), batchesEl, batchesHeader, cid);
  Progress.fetchRemoteBatches(cid, 10).then(remote => {
    if (!remote?.length) return;
    // Merge by batchId — prefer remote (source of truth for completed batches).
    const local = batchesForCourse(uid, cid);
    const byId = new Map();
    for (const b of local) if (b?.batchId) byId.set(b.batchId, b);
    for (const b of remote) if (b?.batchId) byId.set(b.batchId, b);
    const merged = [...byId.values()].sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
    renderRecentBatches(merged, batchesEl, batchesHeader, cid);
  }).catch(() => {});
}

function renderRecentBatches(batches, batchesEl, batchesHeader, cid) {
  if (!batchesEl) return;
  if (!batches?.length) {
    if (batchesHeader) batchesHeader.style.display = 'none';
    batchesEl.innerHTML = '';
    return;
  }
  if (batchesHeader) batchesHeader.style.display = '';
  const recent = batches.slice(-10).reverse();
  batchesEl.innerHTML = recent.map((b, i) => {
    const score = b.size > 0 ? Math.round((b.correct / b.size) * 100) : 0;
    const date = b.endedAt ? new Date(b.endedAt).toLocaleDateString('he-IL') : '';
    return `
      <div class="batch-row batch-clickable" data-batch-i="${i}" style="cursor:pointer">
        <div class="batch-score">${score}%</div>
        <div class="batch-info">
          <div class="batch-summary">${b.correct} מתוך ${b.size} נכון${b.examMode ? ' · מצב מבחן' : ''}</div>
          <div class="batch-date">${date}</div>
        </div>
        <svg class="batch-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </div>
    `;
  }).join('');
  batchesEl.querySelectorAll('.batch-clickable').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.batchI);
      state.lastBatch = recent[idx];
      navigate(`/course/${cid}/summary`);
    });
  });
}

// Load and render exam list for a course
async function loadCourseExams(courseId, containerEl) {
  const pdfsEl = containerEl || document.getElementById('cd-exams');
  if (!pdfsEl) return;
  try {
    const token = await Auth.getToken();
    const res = await fetch(`/api/courses/${courseId}/exams`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) { pdfsEl.innerHTML = '<p class="muted">לא ניתן לטעון מבחנים.</p>'; return; }
    const examsData = await res.json();
    if (!examsData.length) {
      pdfsEl.innerHTML = '<p class="muted">עדיין לא הועלו מבחנים לקורס זה. לחץ על "+ העלאת PDF" כדי להתחיל.</p>';
      return;
    }
    pdfsEl.innerHTML = examsData.map(ex => {
      const statusLabel = { pending: 'ממתין', processing: 'מעבד...', ready: 'מוכן', failed: 'נכשל' }[ex.status] || ex.status;
      const statusCls = ex.status === 'ready' ? 'success' : (ex.status === 'failed' ? 'error' : '');
      const canDelete = ex.status !== 'processing';
      const canExpand = ex.status === 'ready' && (ex.question_count || 0) > 0;
      return `
        <div class="exam-row" data-exam-id="${ex.id}">
          <div class="batch-row">
            <div class="batch-score" style="font-size:14px;">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <div class="batch-info" style="flex:1;">
              <div class="batch-summary">${escapeHtml(ex.name)}</div>
              <div class="batch-date">${ex.question_count || 0} שאלות · <span class="${statusCls}">${statusLabel}</span></div>
            </div>
            <div class="exam-actions">
              ${canExpand ? `<button class="btn-icon exam-expand-btn" data-exam-id="${ex.id}" title="ניהול שאלות"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>` : ''}
              ${canDelete ? `<button class="btn-icon exam-delete-btn" data-exam-id="${ex.id}" data-exam-name="${escapeHtml(ex.name)}" data-q-count="${ex.question_count || 0}" title="מחיקת מבחן"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>` : ''}
            </div>
          </div>
          <div class="exam-questions-grid" id="exam-q-grid-${ex.id}" style="display:none;"></div>
        </div>
      `;
    }).join('');

    // Wire delete buttons
    pdfsEl.querySelectorAll('.exam-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const examId = btn.dataset.examId;
        const examName = btn.dataset.examName;
        const qCount = btn.dataset.qCount;
        const plan = state.user?.plan || 'free';
        const daysLeft = state.user?.days_left;
        // Build warning for trial/limited plan users
        let deleteWarning = '';
        if (plan === 'trial' && typeof daysLeft === 'number') {
          deleteWarning = `\n\n⚠️ שים לב: נשארו לך ${daysLeft} ימים בתקופת הניסיון. מחיקת מבחן לא תחזיר את מכסת ההעלאות שנוצלה.`;
        } else if (plan === 'basic') {
          deleteWarning = '\n\n⚠️ שים לב: מחיקת מבחן לא תחזיר את מכסת ההעלאות שנוצלה.';
        }
        showConfirmModal({
          title: 'מחיקת מבחן',
          body: `למחוק את "${examName}"? ${qCount} שאלות וכל הנתונים שלהן (ניסיונות, סטטיסטיקות) יימחקו לצמיתות.${deleteWarning}`,
          confirmLabel: 'מחק לצמיתות',
          danger: true,
          onConfirm: async () => {
            const tk = await Auth.getToken();
            const r = await fetch(`/api/courses/${courseId}/exams/${examId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${tk}` },
            });
            if (r.ok) {
              toast('המבחן נמחק בהצלחה', 'success');
              // Refresh course data + stats from DB + re-render any open dashboard
              await refreshCourseState(courseId);
              loadCourseExams(courseId);
            } else {
              const d = await r.json().catch(() => ({}));
              toast(d.error || 'שגיאה במחיקה', 'error');
            }
          },
        });
      });
    });

    // Wire expand buttons (question thumbnails)
    pdfsEl.querySelectorAll('.exam-expand-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const examId = btn.dataset.examId;
        const grid = document.getElementById(`exam-q-grid-${examId}`);
        if (!grid) return;
        // Toggle
        if (grid.style.display !== 'none') {
          grid.style.display = 'none';
          btn.querySelector('svg').style.transform = '';
          return;
        }
        btn.querySelector('svg').style.transform = 'rotate(180deg)';
        grid.style.display = 'grid';
        grid.innerHTML = '<p class="muted" style="grid-column:1/-1;">טוען שאלות...</p>';
        try {
          const tk = await Auth.getToken();
          const qRes = await fetch(`/api/courses/${courseId}/questions`, {
            headers: tk ? { Authorization: `Bearer ${tk}` } : {},
          });
          if (!qRes.ok) { grid.innerHTML = '<p class="muted" style="grid-column:1/-1;">לא ניתן לטעון שאלות. נסה לרענן את הדף.</p>'; return; }
          const allQs = await qRes.json();
          if (!Array.isArray(allQs)) { grid.innerHTML = '<p class="muted" style="grid-column:1/-1;">לא ניתן לטעון שאלות.</p>'; return; }
          const examQs = allQs.filter(q => String(q.exam_id) === String(examId));
          if (!examQs.length) {
            grid.innerHTML = '<p class="muted" style="grid-column:1/-1;">אין שאלות במבחן זה.</p>';
            return;
          }
          grid.innerHTML = examQs.map(q => {
            const previewText = (q.question_text || q.general_explanation || ('שאלה ' + q.question_number)).toString().slice(0, 80);
            const safePreview = escapeHtml(previewText);
            return `
            <div class="exam-q-thumb" data-q-id="${q.id}">
              ${q.image_path === 'text-only'
                ? `<div class="exam-q-thumb-text">${safePreview}</div>`
                : `<img src="${Data.imageUrl(q.image_path)}" alt="שאלה ${q.question_number}" data-fallback-text="${safePreview}" loading="lazy" onload="EmThumbFallback.check(this)" onerror="EmThumbFallback.swap(this)" />`}
              <div class="exam-q-thumb-info">
                <span>#${q.question_number}</span>
                <button class="btn-icon-sm q-delete-btn" data-q-id="${q.id}" data-q-num="${q.question_number}" title="מחק שאלה">✕</button>
              </div>
            </div>
          `;
          }).join('');
          // Wire question delete buttons
          grid.querySelectorAll('.q-delete-btn').forEach(qBtn => {
            qBtn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              const qId = qBtn.dataset.qId;
              const qNum = qBtn.dataset.qNum;
              showConfirmModal({
                title: 'מחיקת שאלה',
                body: `למחוק את שאלה #${qNum}? לא ניתן לשחזר.`,
                confirmLabel: 'מחק',
                danger: true,
                onConfirm: async () => {
                  const tk2 = await Auth.getToken();
                  const dr = await fetch(`/api/courses/${courseId}/questions/${qId}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${tk2}` },
                  });
                  if (dr.ok) {
                    const thumb = grid.querySelector(`[data-q-id="${qId}"]`);
                    if (thumb) thumb.remove();
                    toast('שאלה נמחקה', 'success');
                  } else {
                    toast('שגיאה במחיקת שאלה', 'error');
                  }
                },
              });
            });
          });
        } catch {
          grid.innerHTML = '<p class="muted" style="grid-column:1/-1;">שגיאה בטעינת שאלות.</p>';
        }
      });
    });
  } catch (e) {
    pdfsEl.innerHTML = '<p class="muted">שגיאה בטעינת מבחנים.</p>';
  }
}

// Exam management modal — full CRUD: view questions, delete exams/questions, sort
function showExamManagementModal(courseId) {
  const isBuiltin = state.course?.isBuiltin;
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.id = 'exam-mgmt-modal';
  modal.innerHTML = `
    <div class="modal" style="max-width:640px;">
      <button class="modal-close" id="em-close">✕</button>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
        <h2 style="margin:0;">${isBuiltin ? 'בנק השאלות' : 'ניהול קבצים'}</h2>
        ${!isBuiltin ? `<button id="em-trash-btn" class="btn btn-ghost btn-sm" title="סל מחזור" style="font-family:inherit;display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-muted);">🗑️ סל מחזור</button>` : ''}
      </div>
      <p class="modal-sub">${isBuiltin ? 'לחץ על מבחן כדי לצפות בשאלות' : 'לחץ על מבחן לצפייה ועריכה'}</p>
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
        ${!isBuiltin ? `<button class="btn btn-primary btn-sm" id="em-upload-btn">📤 העלאת מבחן</button>` : ''}
        <select id="em-sort" class="btn btn-ghost btn-sm" style="font-family:inherit;border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:13px;">
          <option value="year-desc" selected>מיון: שנה (חדש → ישן)</option>
          <option value="year-asc">מיון: שנה (ישן → חדש)</option>
          <option value="name">מיון: לפי שם</option>
          <option value="questions">מיון: כמות שאלות</option>
        </select>
      </div>
      <div id="em-list" style="max-height:55vh;overflow-y:auto;"></div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  document.getElementById('em-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Upload button
  document.getElementById('em-upload-btn')?.addEventListener('click', () => { close(); showUploadPdfModal(courseId); });

  // Trash button
  document.getElementById('em-trash-btn')?.addEventListener('click', () => showTrashModal(courseId));

  const listEl = document.getElementById('em-list');

  // Helper: extract year from exam label like "מועד א, סמסטר א, 2024"
  function examYear(label) {
    const m = label.match(/\b(20[1-3]\d)\b/);
    return m ? parseInt(m[1]) : 0;
  }

  // Hidden exams (stored locally)
  const HIDDEN_KEY = `ep_hidden_exams_${courseId}`;
  function getHiddenExams() { try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'); } catch { return []; } }
  function setHiddenExams(arr) { localStorage.setItem(HIDDEN_KEY, JSON.stringify(arr)); }

  function renderBuiltinExams(sort) {
    const hidden = getHiddenExams();
    const allExams = [...(Data.metadata?.exams || [])];
    const exams = allExams.filter(ex => !hidden.includes(ex.id));

    // Sort
    if (sort === 'year-desc') exams.sort((a, b) => examYear(b.label) - examYear(a.label));
    else if (sort === 'year-asc') exams.sort((a, b) => examYear(a.label) - examYear(b.label));
    else if (sort === 'name') exams.sort((a, b) => a.label.localeCompare(b.label, 'he'));
    else if (sort === 'questions') exams.sort((a, b) => b.questions.length - a.questions.length);

    let html = exams.map((ex, i) => `
      <div class="em-exam-row" data-exam-idx="${i}" style="cursor:pointer;border-bottom:1px solid var(--border-soft);">
        <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;" class="em-row-header">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--brand-500)" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <div style="flex:1;">
            <div style="font-weight:600;font-size:14px;">${escapeHtml(ex.label)}</div>
            <div style="font-size:12px;color:var(--text-muted);">${ex.questions.length} שאלות</div>
          </div>
          <button class="em-hide-btn" data-exam-id="${ex.id}" title="הסר מהרשימה" style="flex-shrink:0;border:1px solid #fecaca;background:#fef2f2;color:#dc2626;border-radius:8px;padding:5px 8px;cursor:pointer;font-size:12px;font-family:inherit;">הסר</button>
          <svg class="em-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-muted)" stroke-width="2" style="transition:transform .2s;flex-shrink:0;"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="em-questions-grid" style="display:none;padding:0 14px 12px;"></div>
      </div>
    `).join('');

    // Show hidden count with restore option
    if (hidden.length) {
      html += `<div style="text-align:center;padding:12px;border-top:1px solid var(--border-soft);">
        <button id="em-restore-hidden" class="btn btn-ghost btn-sm" style="font-size:13px;">↩ שחזר ${hidden.length} מבחנים מוסתרים</button>
      </div>`;
    }

    listEl.innerHTML = html;

    // Wire hide buttons
    listEl.querySelectorAll('.em-hide-btn').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.examId;
        showConfirmModal({
          title: 'הסרת מבחן מהרשימה',
          body: 'המבחן יוסר מהרשימה שלך. ניתן לשחזרו בכל עת דרך "שחזר מוסתרים".',
          confirmLabel: 'הסר', danger: true,
          onConfirm: async () => {
            const h = getHiddenExams();
            h.push(id);
            setHiddenExams(h);
            toast('המבחן הוסר מהרשימה — לחץ "שחזר מוסתרים" להחזרתו', 'success', 6000);
            renderBuiltinExams(document.getElementById('em-sort').value);
          },
        });
      });
    });

    // Wire restore hidden
    document.getElementById('em-restore-hidden')?.addEventListener('click', () => {
      setHiddenExams([]);
      toast('כל המבחנים שוחזרו', 'success');
      renderBuiltinExams(document.getElementById('em-sort').value);
    });

    // Wire expand (click on row)
    listEl.querySelectorAll('.em-row-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.em-hide-btn')) return;
        const row = header.closest('.em-exam-row');
        const idx = parseInt(row.dataset.examIdx);
        const grid = row.querySelector('.em-questions-grid');
        const chevron = row.querySelector('.em-chevron');
        if (grid.style.display !== 'none') {
          grid.style.display = 'none';
          chevron.style.transform = '';
          return;
        }
        chevron.style.transform = 'rotate(180deg)';
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(80px, 1fr))';
        grid.style.gap = '8px';
        const ex = exams[idx];
        grid.innerHTML = ex.questions.map(q => `
          <div class="em-builtin-q" data-qid="${q.id}" style="border:1px solid var(--border-soft);border-radius:8px;overflow:hidden;aspect-ratio:1;display:grid;place-items:center;font-size:12px;color:var(--text-muted);cursor:pointer;" title="שאלה ${q.section}">
            <img src="${Data.imageUrl(q.image)}" alt="שאלה ${q.section}" style="width:100%;height:100%;object-fit:cover;" loading="lazy" onerror="this.parentElement.textContent='#${q.section}'" />
          </div>
        `).join('');
        grid.querySelectorAll('.em-builtin-q').forEach(thumb => {
          thumb.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const qid = thumb.dataset.qid;
            const idx = ex.questions.findIndex(x => x.id === qid);
            const normalizedQs = ex.questions.map(x => ({ image_path: x.image, question_number: x.section, id: x.id }));
            if (idx !== -1) showQuestionViewer(normalizedQs, idx, courseId);
          });
        });
      });
    });
  }

  async function renderUserExams(sort) {
    listEl.innerHTML = '<p class="muted" style="text-align:center;padding:20px;">טוען מבחנים...</p>';
    try {
      const tk = await Auth.getToken();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`/api/courses/${courseId}/exams`, {
        headers: tk ? { Authorization: `Bearer ${tk}` } : {},
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) { listEl.innerHTML = `<p class="muted" style="text-align:center;padding:20px;">שגיאה בטעינה (${res.status}). נסה לרענן.</p>`; return; }
      let examsData = await res.json();
      if (!Array.isArray(examsData) || !examsData.length) {
        listEl.innerHTML = '<p class="muted" style="text-align:center;padding:20px;">עדיין לא הועלו מבחנים. לחץ "העלאת מבחן" למעלה.</p>';
        return;
      }

      // Sort
      if (sort === 'year-desc') examsData.sort((a, b) => examYear(b.name) - examYear(a.name) || new Date(b.created_at) - new Date(a.created_at));
      else if (sort === 'year-asc') examsData.sort((a, b) => examYear(a.name) - examYear(b.name) || new Date(a.created_at) - new Date(b.created_at));
      else if (sort === 'name') examsData.sort((a, b) => a.name.localeCompare(b.name, 'he'));
      else if (sort === 'questions') examsData.sort((a, b) => (b.question_count || 0) - (a.question_count || 0));
      else examsData.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      listEl.innerHTML = examsData.map(ex => {
        const statusLabel = { pending: 'ממתין', processing: 'מעבד...', awaiting_review: 'ממתין לאישור', ready: 'מוכן', failed: 'נכשל' }[ex.status] || ex.status;
        const statusCls = ex.status === 'ready' ? 'color:var(--green-600)' : (ex.status === 'failed' ? 'color:var(--red-500)' : (ex.status === 'awaiting_review' ? 'color:#b45309;font-weight:600' : ''));
        const canExpand = ex.status === 'ready' && (ex.question_count || 0) > 0;
        const isAwaitingReview = ex.status === 'awaiting_review';
        return `
          <div class="em-exam-row" data-exam-id="${ex.id}" style="border-bottom:1px solid var(--border-soft);${isAwaitingReview ? 'background:#fffbeb;' : ''}">
            <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;cursor:pointer;" class="em-row-header">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--brand-500)" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(ex.name)}</div>
                <div style="font-size:12px;color:var(--text-muted);">${ex.question_count || 0} שאלות · <span style="${statusCls}">${statusLabel}</span></div>
              </div>
              ${isAwaitingReview ? `<button class="em-review-btn" data-exam-id="${ex.id}" type="button" style="flex-shrink:0;border:1px solid #fcd34d;background:#fffbeb;color:#92400e;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;font-family:inherit;font-weight:600;">פתח סקירה</button>` : ''}
              ${canExpand ? `<svg class="em-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-muted)" stroke-width="2" style="transition:transform .2s;flex-shrink:0;"><polyline points="6 9 12 15 18 9"/></svg>` : ''}
              <button class="em-delete-btn" data-exam-id="${ex.id}" data-exam-name="${escapeHtml(ex.name)}" data-q-count="${ex.question_count || 0}" title="מחק מבחן" style="flex-shrink:0;border:1px solid #fecaca;background:#fef2f2;color:#dc2626;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;font-family:inherit;display:flex;align-items:center;gap:4px;">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                מחק
              </button>
            </div>
            <div class="em-questions-grid" style="display:none;padding:0 14px 12px;"></div>
          </div>`;
      }).join('');

      // Wire review buttons for awaiting_review exams
      listEl.querySelectorAll('.em-review-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const examId = btn.dataset.examId;
          navigate(`/course/${courseId}/exam/${examId}/review`);
        });
      });

      // Wire expand (click on row header)
      listEl.querySelectorAll('.em-row-header').forEach(header => {
        header.addEventListener('click', async (e) => {
          if (e.target.closest('.em-delete-btn')) return;
          const row = header.closest('.em-exam-row');
          const examId = row.dataset.examId;
          const grid = row.querySelector('.em-questions-grid');
          const chevron = row.querySelector('.em-chevron');
          if (!grid || !chevron) return;

          if (grid.style.display !== 'none') {
            grid.style.display = 'none';
            chevron.style.transform = '';
            return;
          }
          chevron.style.transform = 'rotate(180deg)';
          grid.style.display = 'grid';
          grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(100px, 1fr))';
          grid.style.gap = '8px';
          grid.innerHTML = '<p class="muted" style="grid-column:1/-1;text-align:center;">טוען שאלות...</p>';

          try {
            // Fresh token for each expand (token from renderUserExams may be stale)
            const freshTk = await Auth.getToken();
            const qRes = await fetch(`/api/courses/${courseId}/questions`, { headers: freshTk ? { Authorization: `Bearer ${freshTk}` } : {} });
            if (!qRes.ok) {
              const errBody = await qRes.json().catch(() => ({}));
              console.error(`[expand] questions fetch failed: ${qRes.status}`, errBody);
              grid.innerHTML = `<p class="muted" style="grid-column:1/-1;">שגיאה בטעינת שאלות: ${errBody.detail || errBody.error || qRes.status}. נסה לרענן.</p>`;
              return;
            }
            const allQs = await qRes.json();
            const examQs = (Array.isArray(allQs) ? allQs : []).filter(q => String(q.exam_id) === String(examId));
            if (!examQs.length) { grid.innerHTML = '<p class="muted" style="grid-column:1/-1;">אין שאלות.</p>'; return; }

            // Count how many questions already have AI explanations
            const withExpl = examQs.filter(q => q.general_explanation && String(q.general_explanation).trim()).length;
            const allDone = withExpl === examQs.length;
            const noneDone = withExpl === 0;
            const genBtnLabel = allDone
              ? '✓ כל השאלות כוללות הסברים מפורטים'
              : noneDone
                ? `✨ צור הסברים מפורטים עם AI (${examQs.length} שאלות)`
                : `✨ צור הסברים מפורטים ל-${examQs.length - withExpl} שאלות נוספות`;
            const genBtnDisabled = allDone ? 'disabled' : '';
            const genBtnTitle = allDone ? '' : 'AI ינתח כל שאלה ויפיק הסבר מפורט לתשובה הנכונה ולכל התשובות הלא נכונות. כ-15 שניות.';

            const pendingCount = examQs.filter(q => q.answer_confidence === 'unknown' || q.answer_confidence === 'uncertain').length;
            const revBtnLabel = `🔍 בדוק תשובות עם AI${pendingCount > 0 ? ` (${pendingCount} לא ודאיות)` : ''}`;
            const pendingBar = pendingCount > 0 ? `
              <div style="grid-column:1/-1;display:flex;align-items:flex-start;gap:10px;padding:12px 14px;margin-bottom:8px;background:#fff7ed;border:1.5px solid #f97316;border-radius:10px;">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#c2410c;flex-shrink:0;margin-top:1px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                <div style="flex:1;font-size:13px;color:#7c2d12;">
                  <strong>${pendingCount} שאלות ממתינות לאישור תשובה</strong>
                  <div style="font-size:12px;margin-top:3px;color:#9a3412;">שאלות אלו <strong>לא יופיעו בתרגול</strong> עד שתעדכן את התשובה. לחץ על כל שאלה מסומנת ואשר / תקן את התשובה הנכונה.</div>
                </div>
              </div>` : '';

            const genBar = `
              <div class="em-gen-bar" style="grid-column:1/-1;display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:6px;background:linear-gradient(135deg,#fef3c7,#fde68a);border:1px solid #fcd34d;border-radius:10px;">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#92400e;flex-shrink:0;"><path d="M12 2l2.4 7.4H22l-6 4.6 2.4 7.4L12 17l-6.4 4.4L8 14 2 9.4h7.6z"/></svg>
                <div style="flex:1;font-size:13px;color:#78350f;">
                  <strong>פתרונות מפורטים עם AI</strong>
                  <div style="font-size:11px;color:#92400e;opacity:0.9;" title="${genBtnTitle}">ה-AI יצור הסבר מפורט לתשובה נכונה ולכל התשובות השגויות, על סמך קובץ הפתרון שהעלית.</div>
                </div>
                <button class="btn btn-primary btn-sm em-gen-btn" data-exam-id="${examId}" ${genBtnDisabled} style="white-space:nowrap;">${genBtnLabel}</button>
              </div>
            `;

            // Context bar — lets the user manually crop "accompanying info"
            // (passages / tables / diagrams) from the exam PDF and attach it
            // to one or more questions. Uses group_id / context_image_path
            // columns that already power the existing "מידע לסט" button.
            const contextBar = `
              <div class="ep-ctx-bar">
                <div style="display:flex;align-items:center;gap:8px;flex:1;">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#0369a1;"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
                  <div style="font-size:13px;color:#0c4a6e;"><strong>מידע נלווה</strong> — קטעי רקע שמשרתים מספר שאלות (טבלה, קטע קריאה, דיאגרמה).</div>
                </div>
                <button class="ep-ctx-add-btn" data-exam-id="${examId}" type="button">+ הוסף מידע נלווה</button>
              </div>
              <div class="ep-ctx-list" data-exam-id="${examId}" style="grid-column:1/-1;"></div>
            `;

            grid.innerHTML = pendingBar + genBar + contextBar + examQs.map(q => {
              const hasSolution = !!q.general_explanation;
              const needsReview = q.answer_confidence === 'unknown';
              const isUncertain = q.answer_confidence === 'uncertain';
              const badgeStyle = 'position:absolute;top:4px;right:4px;color:white;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:600;';
              const badge = needsReview
                ? `<div style="${badgeStyle}background:#dc2626;" title="תשובה לא זוהתה אוטומטית - לחץ על השאלה לקבוע ידנית">⚠ תשובה?</div>`
                : isUncertain
                  ? `<div style="${badgeStyle}background:#ea580c;" title="הזיהוי לא ודאי - לחץ על השאלה לאמת">⚠ לא ודאי</div>`
                  : (hasSolution ? `<div style="${badgeStyle}background:var(--green-500);">✓ פתרון</div>` : '');
              const borderColor = needsReview ? '#dc2626' : (isUncertain ? '#ea580c' : 'var(--border-soft)');
              // Set-context button — shown only for questions that are part
              // of a group (have context_image_path). Opens a modal preview
              // of the shared scenario/data/passage. Positioned top-left so
              // it doesn't collide with the top-right answer badge.
              const ctxBtn = (q.context_image_path && String(q.context_image_path).startsWith('http'))
                ? `<button class="em-q-ctx-btn" data-ctx-url="${escapeHtml(q.context_image_path)}" data-q-num="${q.question_number}" title="הצג את המידע לסט השאלות" style="position:absolute;top:4px;left:4px;background:#2563eb;color:white;border:none;border-radius:4px;padding:3px 7px;font-size:11px;font-weight:700;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.2);z-index:2;">מידע לסט</button>`
                : '';
              const hasRegenSolution = !!(q.general_explanation && String(q.general_explanation).trim());
              const regenLabel = hasRegenSolution ? 'רענן פתרון AI' : 'צור פתרון AI';
              // Preview text: prefer question_text (set at upload from text-layer
              // extraction) over general_explanation (null until AI solution runs).
              const previewText = (q.question_text || q.general_explanation || ('שאלה ' + q.question_number)).toString().slice(0, 80);
              const safePreview = escapeHtml(previewText);
              return `
              <div class="em-q-thumb" data-q-id="${q.id}" style="border:1px solid ${borderColor};border-radius:8px;overflow:hidden;position:relative;min-height:80px;background:var(--gray-50);">
                <div class="em-q-render" style="display:grid;place-items:center;min-height:70px;font-size:11px;color:var(--text-muted);">
                  ${q.image_path === 'text-only'
                    ? `<div style="padding:8px;">${safePreview}</div>`
                    : `<img src="${q.image_path.startsWith('http') ? q.image_path : Data.imageUrl(q.image_path)}" alt="שאלה ${q.question_number}" data-fallback-text="${safePreview}" style="width:100%;display:block;" loading="lazy" onload="EmThumbFallback.check(this)" onerror="EmThumbFallback.swap(this)" />`}
                </div>
                ${badge}
                ${ctxBtn}
                <div style="display:flex;flex-direction:column;gap:4px;padding:4px 8px;background:var(--gray-100);font-size:11px;">
                  <div style="display:flex;gap:4px;flex-wrap:wrap;">
                    <button class="em-q-retake-btn" data-q-id="${q.id}" data-q-num="${q.question_number}" title="צלם את תמונת השאלה מחדש" style="flex:1;border:1px solid #c7d2fe;background:#eef2ff;color:#3730a3;border-radius:4px;padding:3px 6px;cursor:pointer;font-size:10px;font-family:inherit;font-weight:600;">צלם מחדש</button>
                    <button class="em-q-chkans-btn" data-q-id="${q.id}" data-q-num="${q.question_number}" title="בדוק את התשובה הנכונה מול קובץ הפתרון" style="flex:1;border:1px solid #fcd34d;background:#fffbeb;color:#92400e;border-radius:4px;padding:3px 6px;cursor:pointer;font-size:10px;font-family:inherit;font-weight:600;">בדוק פתרון</button>
                    <button class="em-q-regen-btn" data-q-id="${q.id}" data-q-num="${q.question_number}" title="${hasRegenSolution ? 'צור פתרון AI חדש במקום הקיים' : 'צור פתרון AI מפורט לשאלה זו'}" style="flex:1;border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;border-radius:4px;padding:3px 6px;cursor:pointer;font-size:10px;font-family:inherit;font-weight:600;">${regenLabel}</button>
                  </div>
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:4px;">
                    <span style="display:flex;align-items:center;gap:4px;">#${q.question_number}${(needsReview || isUncertain) ? `<span style="font-size:9px;background:#fef2f2;color:#b91c1c;border:1px solid #fca5a5;border-radius:3px;padding:1px 5px;font-weight:700;">לא במאגר</span>` : ''}</span>
                    <button class="em-q-delete" data-q-id="${q.id}" data-q-num="${q.question_number}" title="מחק שאלה" style="border:none;background:none;cursor:pointer;color:var(--text-muted);font-size:14px;">✕</button>
                  </div>
                </div>
              </div>
            `;}).join('');

            // Wire the "נתח מחדש" and "צור/רענן פתרון AI" per-question buttons.
            const wirePerQBtn = (selector, endpointSuffix, labelWhileWorking, successMsg, bodyData = {}) => {
              grid.querySelectorAll(selector).forEach(btn => {
                btn.addEventListener('click', async (ev) => {
                  ev.stopPropagation();
                  if (btn.disabled) return;
                  const qId = btn.getAttribute('data-q-id');
                  const origHtml = btn.innerHTML;
                  btn.disabled = true;
                  btn.innerHTML = `<span class="qv-spinner"></span> ${labelWhileWorking}`;
                  const restore = () => { btn.disabled = false; btn.innerHTML = origHtml; };
                  try {
                    const tk = await Auth.getToken();
                    if (!tk) { toast('תוקף ההתחברות פג. התחבר שוב.', 'error'); restore(); return; }
                    const r = await fetch(`/api/questions/${encodeURIComponent(qId)}/${endpointSuffix}`, {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify(bodyData),
                    });
                    let data = {};
                    try { data = await r.json(); } catch {}
                    if (r.status === 401) { toast('תוקף ההתחברות פג. התחבר שוב.', 'error'); restore(); return; }
                    if (r.status === 402) { restore(); if (typeof showPaywallModal === 'function') showPaywallModal(data.trial_expired ? 'trial_ended' : 'ai_quota'); else toast(data.guidance || 'פיצ\'ר פרימיום', 'warning'); return; }
                    if (r.status === 429) { toast(data.guidance || 'הגעת למגבלה היומית', 'error'); restore(); return; }
                    if (!r.ok || !data.ok) {
                      const msg = [data.error, data.detail].filter(Boolean).join(' — ') || `שגיאה (${r.status})`;
                      toast(msg, 'error');
                      restore();
                      return;
                    }
                    toast(successMsg, 'success');
                    // Refresh this exam's grid so the updated row shows.
                    grid.style.display = 'none';
                    chevron.style.transform = '';
                    setTimeout(() => header.click(), 100);
                  } catch (e) {
                    console.error('[per-q-btn]', e);
                    toast('שגיאה לא צפויה', 'error');
                    restore();
                  }
                });
              });
            };
            // "צלם מחדש" — opens the manual PDF crop tool (no Gemini call).
            grid.querySelectorAll('.em-q-retake-btn').forEach(btn => {
              btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (btn.disabled) return;
                const qId = btn.getAttribute('data-q-id');
                const qRow = examQs.find(x => String(x.id) === String(qId));
                if (!qRow) { toast('שאלה לא נמצאה', 'error'); return; }
                openReshootCropTool(qRow, () => {
                  // Refresh the grid so the new image shows.
                  grid.style.display = 'none';
                  chevron.style.transform = '';
                  setTimeout(() => header.click(), 100);
                });
              });
            });
            // "בדוק פתרון" — opens the solution PDF viewer on the correct page.
            grid.querySelectorAll('.em-q-chkans-btn').forEach(btn => {
              btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (btn.disabled) return;
                const qId = btn.getAttribute('data-q-id');
                const qRow = examQs.find(x => String(x.id) === String(qId));
                if (!qRow) { toast('שאלה לא נמצאה', 'error'); return; }
                openFixAnswerModal(qRow, courseId, () => {
                  grid.style.display = 'none';
                  chevron.style.transform = '';
                  setTimeout(() => header.click(), 100);
                });
              });
            });
            wirePerQBtn('.em-q-regen-btn',   'regenerate-answer',  'יוצר...',  'פתרון ה-AI עודכן');

            // Wire the "מידע לסט" (set-context) buttons — open a modal with the context image.
            grid.querySelectorAll('.em-q-ctx-btn').forEach(btn => {
              btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                openSetContextModal(btn.getAttribute('data-ctx-url'), btn.getAttribute('data-q-num'));
              });
            });

            // Context management: list + create/edit/delete.
            const ctxListEl = grid.querySelector(`.ep-ctx-list[data-exam-id="${examId}"]`);
            const ctxAddBtn = grid.querySelector(`.ep-ctx-add-btn[data-exam-id="${examId}"]`);
            const refreshContextList = async () => {
              if (!ctxListEl) return;
              try {
                const tk = await Auth.getToken();
                const r = await fetch(`/api/exams/${examId}/context`, { headers: { Authorization: `Bearer ${tk}` } });
                const data = await r.json().catch(() => ({}));
                const contexts = Array.isArray(data.contexts) ? data.contexts : [];
                if (contexts.length === 0) { ctxListEl.innerHTML = ''; return; }
                ctxListEl.innerHTML = contexts.map(c => `
                  <div class="ep-ctx-card" data-group-id="${escapeHtml(c.group_id)}">
                    ${c.context_image_path ? `<img src="${c.context_image_path}" alt="מידע נלווה ${escapeHtml(c.group_id)}" />` : '<div style="background:#f1f5f9;padding:30px;text-align:center;font-size:11px;color:#64748b;border-radius:6px;margin-bottom:8px;">ללא תמונה</div>'}
                    <div class="ep-ctx-card-meta">קבוצה: ${escapeHtml(c.group_id)}${c.context_pdf_page ? ` • עמוד ${c.context_pdf_page}` : ''}</div>
                    <div class="ep-ctx-card-qs">שאלות: ${(c.question_numbers || []).map(n => '#' + n).join(', ') || '—'}</div>
                    <div class="ep-ctx-card-actions">
                      <button class="ep-ctx-edit"  data-group-id="${escapeHtml(c.group_id)}" type="button">ערוך שיוך</button>
                      <button class="ep-ctx-recrop" data-group-id="${escapeHtml(c.group_id)}" type="button">חתוך מחדש</button>
                      <button class="ep-ctx-del danger" data-group-id="${escapeHtml(c.group_id)}" type="button">מחק</button>
                    </div>
                  </div>
                `).join('');
                // Wire the action buttons on each card.
                ctxListEl.querySelectorAll('.ep-ctx-del').forEach(btn => {
                  btn.addEventListener('click', async () => {
                    const gid = btn.dataset.groupId;
                    if (!confirm(`למחוק את קבוצת המידע "${gid}"? השאלות המשוייכות יאבדו את הקישור למידע הזה.`)) return;
                    const tk2 = await Auth.getToken();
                    const r = await fetch(`/api/exams/${examId}/context/${encodeURIComponent(gid)}`, {
                      method: 'DELETE', headers: { Authorization: `Bearer ${tk2}` },
                    });
                    if (r.ok) { toast('מידע נלווה נמחק', 'success'); refreshContextList(); grid.style.display='none'; chevron.style.transform=''; setTimeout(() => header.click(), 100); }
                    else toast('שגיאה במחיקה', 'error');
                  });
                });
                ctxListEl.querySelectorAll('.ep-ctx-edit').forEach(btn => {
                  btn.addEventListener('click', () => {
                    const gid = btn.dataset.groupId;
                    const c = contexts.find(x => x.group_id === gid);
                    if (!c) return;
                    openContextQuestionPicker(examId, examQs, c, () => refreshContextList());
                  });
                });
                ctxListEl.querySelectorAll('.ep-ctx-recrop').forEach(btn => {
                  btn.addEventListener('click', () => {
                    const gid = btn.dataset.groupId;
                    openContextCropTool(examId, examQs, { recropGroupId: gid }, () => refreshContextList());
                  });
                });
              } catch (e) {
                console.warn('[context-list] failed', e);
              }
            };
            if (ctxAddBtn) {
              ctxAddBtn.addEventListener('click', () => {
                openContextCropTool(examId, examQs, {}, () => refreshContextList());
              });
            }
            refreshContextList();

            // Wire the "Generate AI solutions" button
            const genBtn = grid.querySelector('.em-gen-btn');
            if (genBtn && !allDone) {
              genBtn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                if (genBtn.disabled) return;
                genBtn.disabled = true;
                const origLabel = genBtn.textContent;
                const restoreBtn = () => { genBtn.disabled = false; genBtn.textContent = origLabel; };
                genBtn.innerHTML = '<span class="qv-spinner"></span> מייצר הסברים...';
                try {
                  const tk = await Auth.getToken();
                  if (!tk) {
                    toast('תוקף ההתחברות פג. התחבר שוב כדי להמשיך.', 'error');
                    restoreBtn();
                    return;
                  }
                  let r;
                  try {
                    r = await fetch('/api/exams/generate-solutions', {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify({ examId }),
                    });
                  } catch (netErr) {
                    console.error('[create-solutions] network:', netErr);
                    toast('שגיאת רשת. בדוק חיבור לאינטרנט ונסה שוב.', 'error');
                    restoreBtn();
                    return;
                  }
                  let data = {};
                  try {
                    data = await r.json();
                  } catch (parseErr) {
                    console.error('[create-solutions] json parse:', parseErr, 'status:', r.status);
                    toast(`השרת החזיר תשובה לא תקינה (${r.status}). נסה שוב בעוד דקה.`, 'error');
                    restoreBtn();
                    return;
                  }
                  if (r.status === 401) {
                    toast('תוקף ההתחברות פג. התחבר שוב.', 'error');
                    restoreBtn();
                    return;
                  }
                  if (r.status === 402) {
                    // Trial expired or plan doesn't include this feature → show paywall
                    restoreBtn();
                    showPaywallModal(data.trial_expired ? 'trial_ended' : 'ai_quota');
                    return;
                  }
                  if (r.status === 429) {
                    toast(data.guidance || 'הגעת למגבלה היומית', 'error');
                    restoreBtn();
                    return;
                  }
                  if (!r.ok || !data.ok) {
                    const msg = data.error || data.guidance || `שגיאה ביצירת הפתרונות (${r.status})`;
                    console.error('[create-solutions] api error:', r.status, data);
                    toast(msg, 'error');
                    restoreBtn();
                    return;
                  }
                  const elapsedSec = ((data.elapsed_ms || 0) / 1000).toFixed(1);
                  if (data.generated === 0) {
                    toast(data.message || 'כל השאלות כבר כוללות הסברים', 'info');
                  } else {
                    toast(`נוצרו ${data.generated} הסברים מפורטים (${elapsedSec} שניות)`, 'success');
                    if (data.errors && data.errors.length > 0) {
                      console.warn('[create-solutions] partial errors:', data.errors);
                    }
                  }
                  // Refresh the expansion so it reflects new state
                  grid.style.display = 'none';
                  chevron.style.transform = '';
                  setTimeout(() => header.click(), 100);
                } catch (e) {
                  console.error('[create-solutions] uncaught:', e);
                  toast('שגיאה לא צפויה ביצירת הפתרונות', 'error');
                  restoreBtn();
                }
              });
            }

            // Wire the "Verify answers" button
            const revBtn = grid.querySelector('.em-rev-btn');
            if (revBtn) {
              revBtn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                if (revBtn.disabled) return;
                revBtn.disabled = true;
                const origLabel = revBtn.textContent;
                const restoreRevBtn = () => { revBtn.disabled = false; revBtn.textContent = origLabel; };
                revBtn.innerHTML = '<span class="qv-spinner"></span> בודק תשובות...';
                try {
                  const tk = await Auth.getToken();
                  if (!tk) { toast('תוקף ההתחברות פג. התחבר שוב.', 'error'); restoreRevBtn(); return; }
                  let r, data = {};
                  try {
                    r = await fetch('/api/exams/reverify-answers', {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify({ examId }),
                    });
                    data = await r.json();
                  } catch (netErr) {
                    console.error('[reverify] network:', netErr);
                    toast('שגיאת רשת. בדוק חיבור לאינטרנט ונסה שוב.', 'error');
                    restoreRevBtn();
                    return;
                  }
                  if (!r.ok) { toast(data.error || `שגיאה (${r.status})`, 'error'); restoreRevBtn(); return; }
                  const parts = [];
                  if (data.resolved > 0)  parts.push(`${data.resolved} תשובות נפתרו`);
                  if (data.promoted > 0)  parts.push(`${data.promoted} אומתו`);
                  if (data.demoted > 0)   parts.push(`${data.demoted} הורדו לבדיקה`);
                  if (data.agreed > 0)    parts.push(`${data.agreed} אושרו`);
                  const summary = parts.length ? parts.join(' · ') : 'אין שינויים';
                  toast(`בדיקת תשובות הסתיימה — ${summary}`, data.demoted > 0 ? 'warning' : 'success');
                  // Refresh the expansion to show updated confidence badges
                  grid.style.display = 'none';
                  chevron.style.transform = '';
                  setTimeout(() => header.click(), 100);
                } catch (e) {
                  console.error('[reverify] uncaught:', e);
                  toast('שגיאה לא צפויה בבדיקת התשובות', 'error');
                  restoreRevBtn();
                }
              });
            }

            // Images load automatically via <img> tags — Cloudinary URLs are regular image URLs

            // Wire question click → open viewer with full array for navigation
            grid.querySelectorAll('.em-q-thumb').forEach(thumb => {
              thumb.style.cursor = 'pointer';
              thumb.addEventListener('click', (ev) => {
                if (ev.target.closest('.em-q-delete')) return;
                const qId = thumb.dataset.qId;
                const idx = examQs.findIndex(x => String(x.id) === String(qId));
                if (idx !== -1) showQuestionViewer(examQs, idx, courseId, (deletedIdx) => {
                  const thumbs = grid.querySelectorAll('.em-q-thumb');
                  if (thumbs[deletedIdx]) thumbs[deletedIdx].remove();
                });
              });
            });

            // Wire question delete (small ✕ button)
            grid.querySelectorAll('.em-q-delete').forEach(btn => {
              btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const qId = btn.dataset.qId;
                showConfirmModal({
                  title: 'הסרת שאלה',
                  body: `להסיר את שאלה #${btn.dataset.qNum}?\nהשאלה תועבר לסל המחזור ותימחק סופית לאחר 3 ימים.`,
                  confirmLabel: 'הסר לסל המחזור', danger: true,
                  onConfirm: async () => {
                    const t2 = await Auth.getToken();
                    const dr = await fetch(`/api/courses/${courseId}/questions/${qId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t2}` } });
                    if (dr.ok) {
                      btn.closest('.em-q-thumb')?.remove();
                      toast('השאלה הועברה לסל המחזור', 'success');
                    } else toast('שגיאה בהסרה', 'error');
                  },
                });
              });
            });
          } catch { grid.innerHTML = '<p class="muted" style="grid-column:1/-1;">שגיאה בטעינה.</p>'; }
        });
      });

      // Wire delete exam buttons
      listEl.querySelectorAll('.em-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const examId = btn.dataset.examId;
          const examName = btn.dataset.examName;
          const qCount = btn.dataset.qCount;
          showConfirmModal({
            title: 'הסרת מבחן',
            body: `להסיר את "${examName}"?\n${qCount} שאלות יועברו לסל המחזור ויימחקו סופית לאחר 3 ימים.`,
            confirmLabel: 'הסר לסל המחזור', danger: true,
            onConfirm: async () => {
              const t2 = await Auth.getToken();
              const r = await fetch(`/api/courses/${courseId}/exams/${examId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t2}` } });
              if (r.ok) {
                btn.closest('.em-exam-row')?.remove();
                toast('המבחן הועבר לסל המחזור — ניתן לשחזרו תוך 3 ימים', 'success', 6000);
                await refreshCourseState(courseId);
              } else toast('שגיאה בהסרה', 'error');
            },
          });
        });
      });
    } catch (e) {
      const msg = e?.name === 'AbortError' ? 'הטעינה לקחה יותר מדי זמן. נסה לרענן.' : 'שגיאה בטעינה. נסה לרענן.';
      listEl.innerHTML = `<p class="muted" style="text-align:center;padding:20px;">${msg}</p>`;
    }
  }

  // Initial render
  const sortEl = document.getElementById('em-sort');
  if (isBuiltin) renderBuiltinExams(sortEl.value);
  else renderUserExams(sortEl.value);

  // Re-render on sort change
  sortEl.addEventListener('change', () => {
    if (isBuiltin) renderBuiltinExams(sortEl.value);
    else renderUserExams(sortEl.value);
  });
}

// Trash/recycle bin modal — shows soft-deleted items for a course
async function showTrashModal(courseId) {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal" style="max-width:540px;">
      <button class="modal-close" id="trash-close">✕</button>
      <h2>🗑️ סל מחזור</h2>
      <p class="modal-sub">פריטים שנמחקו — ניתן לשחזר תוך 3 ימים</p>
      <div id="trash-list" style="max-height:55vh;overflow-y:auto;"></div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#trash-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  const listEl = modal.querySelector('#trash-list');
  listEl.innerHTML = '<p class="muted" style="text-align:center;padding:20px;">טוען...</p>';

  try {
    const tk = await Auth.getToken();
    const r = await fetch(`/api/courses/${courseId}/trash`, { headers: tk ? { Authorization: `Bearer ${tk}` } : {} });
    if (!r.ok) { listEl.innerHTML = '<p class="muted" style="text-align:center;padding:20px;">שגיאה בטעינה</p>'; return; }
    const { exams, questions } = await r.json();

    if (!exams.length && !questions.length) {
      listEl.innerHTML = '<p class="muted" style="text-align:center;padding:30px;">סל המחזור ריק</p>';
      return;
    }

    const daysLeft = (deletedAt) => {
      const d = Math.ceil((new Date(deletedAt).getTime() + 3 * 86400000 - Date.now()) / 86400000);
      return Math.max(0, d);
    };

    const examIds = new Set(exams.map(ex => String(ex.id)));
    const grouped = questions.filter(q => q.exam_id && examIds.has(String(q.exam_id)));
    const orphans = questions.filter(q => !q.exam_id || !examIds.has(String(q.exam_id)));

    // Group questions by exam
    const qByExam = {};
    grouped.forEach(q => {
      const key = String(q.exam_id);
      (qByExam[key] = qByExam[key] || []).push(q);
    });

    let html = '';
    if (exams.length) {
      html += `<div style="font-size:12px;font-weight:600;color:var(--text-muted);padding:8px 0 4px;text-transform:uppercase;letter-spacing:.5px;">מבחנים</div>`;
      html += exams.map(ex => {
        const eqs = qByExam[String(ex.id)] || [];
        const hasQs = eqs.length > 0;
        return `
        <div class="trash-exam-block" data-exam-id="${ex.id}">
          <div class="em-exam-row trash-exam-header" style="border-bottom:1px solid var(--border-soft);display:flex;align-items:center;gap:10px;padding:10px 4px;cursor:${hasQs ? 'pointer' : 'default'};" data-exam-id="${ex.id}">
            ${hasQs ? `<span class="trash-chevron" style="font-size:11px;color:var(--text-muted);transition:transform .2s;user-select:none;" data-exam-id="${ex.id}">▶</span>` : '<span style="width:14px;display:inline-block;"></span>'}
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <div style="flex:1;min-width:0;">
              <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(ex.name)}</div>
              <div style="font-size:12px;color:var(--text-muted);">${ex.question_count || 0} שאלות · נמחק ${daysLeft(ex.deleted_at)} ימים לפני מחיקה סופית${hasQs ? ` · לחץ לצפייה בשאלות` : ''}</div>
            </div>
            <button class="btn btn-sm trash-restore-exam" data-exam-id="${ex.id}" style="font-family:inherit;white-space:nowrap;">↩ שחזר</button>
          </div>
          ${hasQs ? `
          <div class="trash-exam-questions" data-exam-id="${ex.id}" style="display:none;border-bottom:1px solid var(--border-soft);background:var(--surface-alt,rgba(0,0,0,.03));border-radius:0 0 6px 6px;padding:4px 4px 4px 28px;">
            ${eqs.map(q => `
              <div class="trash-q-row" style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--border-soft);">
                <span style="font-size:13px;color:var(--text-muted);min-width:70px;">שאלה #${q.question_number}</span>
                <div style="flex:1;font-size:12px;color:var(--text-muted);">${daysLeft(q.deleted_at)} ימים לפני מחיקה סופית</div>
                <button class="btn btn-sm trash-restore-q" data-q-id="${q.id}" data-exam-id="${ex.id}" style="font-family:inherit;white-space:nowrap;">↩ שחזר</button>
              </div>
            `).join('')}
          </div>` : ''}
        </div>
        `;
      }).join('');
    }
    if (orphans.length) {
      html += `<div style="font-size:12px;font-weight:600;color:var(--text-muted);padding:12px 0 4px;text-transform:uppercase;letter-spacing:.5px;">שאלות שנמחקו בנפרד</div>`;
      html += orphans.map(q => `
        <div class="trash-q-row" style="border-bottom:1px solid var(--border-soft);display:flex;align-items:center;gap:12px;padding:10px 4px;">
          <span style="font-size:13px;color:var(--text-muted);min-width:70px;">שאלה #${q.question_number}</span>
          <div style="flex:1;font-size:12px;color:var(--text-muted);">${daysLeft(q.deleted_at)} ימים לפני מחיקה סופית</div>
          <button class="btn btn-sm trash-restore-q" data-q-id="${q.id}" style="font-family:inherit;white-space:nowrap;">↩ שחזר</button>
        </div>
      `).join('');
    }

    listEl.innerHTML = html;

    // Chevron toggle — expand/collapse questions under each exam
    listEl.querySelectorAll('.trash-exam-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.trash-restore-exam')) return; // don't toggle when clicking restore
        const eid = header.dataset.examId;
        const qBlock = listEl.querySelector(`.trash-exam-questions[data-exam-id="${eid}"]`);
        const chevron = listEl.querySelector(`.trash-chevron[data-exam-id="${eid}"]`);
        if (!qBlock) return;
        const isOpen = qBlock.style.display !== 'none';
        qBlock.style.display = isOpen ? 'none' : '';
        if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
      });
    });

    listEl.querySelectorAll('.trash-restore-exam').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'משחזר...';
        const t2 = await Auth.getToken();
        const r2 = await fetch(`/api/courses/${courseId}/trash/restore-exam`, {
          method: 'POST', headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ examId: btn.dataset.examId }),
        });
        if (r2.ok) {
          btn.closest('.trash-exam-block')?.remove();
          toast('המבחן שוחזר בהצלחה', 'success');
          await refreshCourseState(courseId);
          if (!listEl.querySelector('.trash-exam-block,.trash-q-row'))
            listEl.innerHTML = '<p class="muted" style="text-align:center;padding:30px;">סל המחזור ריק</p>';
        } else { btn.disabled = false; btn.textContent = '↩ שחזר'; toast('שגיאה בשחזור', 'error'); }
      });
    });

    listEl.querySelectorAll('.trash-restore-q').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'משחזר...';
        const t2 = await Auth.getToken();
        const r2 = await fetch(`/api/courses/${courseId}/trash/restore-question`, {
          method: 'POST', headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionId: btn.dataset.qId }),
        });
        if (r2.ok) {
          const resData = await r2.json().catch(() => ({}));
          // Remove the question row
          btn.closest('.trash-q-row')?.remove();
          const msg = resData.restoredExam ? 'השאלה והמבחן שוחזרו בהצלחה' : 'השאלה שוחזרה בהצלחה';
          toast(msg, 'success');
          await refreshCourseState(courseId);
          // If the parent exam block is now empty of questions, remove its questions block
          if (btn.dataset.examId) {
            const examQBlock = listEl.querySelector(`.trash-exam-questions[data-exam-id="${btn.dataset.examId}"]`);
            const examBlock = listEl.querySelector(`.trash-exam-block[data-exam-id="${btn.dataset.examId}"]`);
            if (resData.restoredExam && examBlock) examBlock.remove();
            else if (examQBlock && !examQBlock.querySelector('.trash-q-row')) examQBlock.remove();
          }
          if (!listEl.querySelector('.trash-exam-block,.trash-q-row'))
            listEl.innerHTML = '<p class="muted" style="text-align:center;padding:30px;">סל המחזור ריק</p>';
        } else { btn.disabled = false; btn.textContent = '↩ שחזר'; toast('שגיאה בשחזור', 'error'); }
      });
    });
  } catch {
    listEl.innerHTML = '<p class="muted" style="text-align:center;padding:20px;">שגיאה בטעינת סל המחזור</p>';
  }
}

// Question viewer lightbox — full-size image with prev/next navigation + keyboard arrows
// questions: array of question objects (all in same exam), startIndex: which one to open
function showQuestionViewer(qOrArr, courseIdOrStartIndex, onDeleteOrCourseId, maybeOnDelete) {
  // Normalize overloaded signature:
  // Old: showQuestionViewer(q, courseId, onDelete)
  // New: showQuestionViewer(questions[], startIndex, courseId, onDelete?)
  let questions, currentIndex, courseId, onDelete;
  if (Array.isArray(qOrArr)) {
    questions = qOrArr;
    currentIndex = typeof courseIdOrStartIndex === 'number' ? courseIdOrStartIndex : 0;
    courseId = onDeleteOrCourseId;
    onDelete = maybeOnDelete;
  } else {
    questions = [qOrArr];
    currentIndex = 0;
    courseId = courseIdOrStartIndex;
    onDelete = onDeleteOrCourseId;
  }

  const viewer = document.createElement('div');
  viewer.className = 'modal-backdrop';
  viewer.style.cssText = 'z-index:10000;display:flex;align-items:center;justify-content:center;';
  viewer.innerHTML = `
    <div style="background:#fff;border-radius:16px;max-width:90vw;max-height:90vh;overflow:hidden;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.3);padding:0;display:flex;flex-direction:column;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border-soft);background:#fff;z-index:1;border-radius:16px 16px 0 0;flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:8px;">
          <button id="qv-prev" class="btn btn-ghost btn-sm" style="font-family:inherit;font-size:18px;padding:4px 10px;" title="שאלה קודמת (←)">‹</button>
          <span id="qv-title" style="font-weight:600;font-size:15px;"></span>
          <button id="qv-next" class="btn btn-ghost btn-sm" style="font-family:inherit;font-size:18px;padding:4px 10px;" title="שאלה הבאה (→)">›</button>
          <button id="qv-ctx-btn" type="button" title="הצג מידע לסט השאלות" style="display:none;background:#2563eb;color:white;border:none;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">הקשר לסט</button>
        </div>
        <div style="display:flex;gap:8px;">
          <span id="qv-counter" style="font-size:12px;color:var(--text-muted);align-self:center;"></span>
          <button id="qv-delete" class="btn btn-sm" style="color:#dc2626;border:1px solid #fecaca;background:#fef2f2;font-family:inherit;display:none;">🗑️ הסר</button>
          <button id="qv-close" class="btn btn-ghost btn-sm" style="font-family:inherit;">✕</button>
        </div>
      </div>
      <div id="qv-body" style="overflow:auto;flex:1;"></div>
    </div>
  `;
  document.body.appendChild(viewer);

  const titleEl = viewer.querySelector('#qv-title');
  const counterEl = viewer.querySelector('#qv-counter');
  const bodyEl = viewer.querySelector('#qv-body');
  const prevBtn = viewer.querySelector('#qv-prev');
  const nextBtn = viewer.querySelector('#qv-next');
  const delBtn = viewer.querySelector('#qv-delete');

  function render() {
    const q = questions[currentIndex];
    const isTextOnly = q.image_path === 'text-only';
    const imgSrc = isTextOnly ? null : (q.image_path?.startsWith('http') ? q.image_path : Data.imageUrl(q.image_path, courseId));
    titleEl.textContent = `שאלה #${q.question_number || q.section || ''}`;
    counterEl.textContent = questions.length > 1 ? `${currentIndex + 1} / ${questions.length}` : '';
    // Set-context pill — shown when this question is part of a group.
    const ctxBtnEl = viewer.querySelector('#qv-ctx-btn');
    if (ctxBtnEl) {
      const ctxUrl = q.context_image_path;
      if (ctxUrl && String(ctxUrl).startsWith('http')) {
        ctxBtnEl.style.display = '';
        ctxBtnEl.onclick = () => openSetContextModal(ctxUrl, q.question_number);
      } else {
        ctxBtnEl.style.display = 'none';
        ctxBtnEl.onclick = null;
      }
    }
    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex === questions.length - 1;
    prevBtn.style.opacity = currentIndex === 0 ? '0.3' : '1';
    nextBtn.style.opacity = currentIndex === questions.length - 1 ? '0.3' : '1';
    const qvFallbackText = escapeHtml((q.question_text || q.general_explanation || 'שאלה ' + (q.question_number || '')).toString().slice(0, 500));
    const imageHtml = isTextOnly
      ? `<div style="padding:24px;font-size:15px;line-height:1.8;direction:rtl;">${escapeHtml(q.general_explanation || q.question_text || 'שאלה ללא תמונה')}</div>`
      : `<img src="${imgSrc}" alt="שאלה" data-fallback-text="${qvFallbackText}" style="width:100%;display:block;" onload="EmThumbFallback.check(this)" onerror="EmThumbFallback.swap(this)" />`;
    // Cross-page context image — page-2 sub-questions need the scenario from page 1.
    // Rendered ABOVE the question image with a small label so students don't miss it.
    // Same-page set members have the context baked into their own crop, so we skip
    // the extra image for them to avoid redundancy.
    const ctxImgHtml = (q.context_image_path && String(q.context_image_path).startsWith('http') && q.context_cross_page)
      ? `<div class="qv-ctx-image" style="margin:0 0 10px;padding:8px;border:1px solid #c7d2fe;border-radius:10px;background:#eff6ff;">
          <div style="font-size:12px;font-weight:600;color:#1e40af;margin-bottom:6px;direction:rtl;">מידע לסט השאלות (מעמוד קודם)</div>
          <img src="${q.context_image_path}" alt="הקשר לסט" style="width:100%;display:block;border-radius:6px;" />
        </div>`
      : '';
    const contextHtml = (q.context_text && String(q.context_text).trim())
      ? `<div class="quiz-context" style="margin:0 0 14px;">
          <button type="button" class="quiz-context-toggle" id="qv-ctx-toggle" aria-expanded="false">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            <span class="quiz-context-label">הקשר לשאלה — לחץ להצגה</span>
            <svg class="quiz-context-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="quiz-context-body" id="qv-ctx-body" hidden>${renderSolutionText(q.context_text)}</div>
        </div>`
      : '';
    bodyEl.innerHTML = `
      ${ctxImgHtml}
      ${contextHtml}
      <div class="qv-image-wrap">${imageHtml}</div>
      <div class="qv-solution-section">
        <button class="qv-solution-toggle" id="qv-sol-toggle" type="button">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1v.2h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/></svg>
          <span class="qv-sol-label">הצג פתרון מפורט</span>
          <svg class="qv-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="qv-solution-panel" id="qv-sol-panel" hidden></div>
      </div>
    `;
    // Wire context toggle
    const ctxToggle = bodyEl.querySelector('#qv-ctx-toggle');
    const ctxBody = bodyEl.querySelector('#qv-ctx-body');
    if (ctxToggle && ctxBody) {
      ctxToggle.addEventListener('click', () => {
        const open = ctxBody.hidden;
        ctxBody.hidden = !open;
        ctxToggle.setAttribute('aria-expanded', String(open));
        const label = ctxToggle.querySelector('.quiz-context-label');
        if (label) label.textContent = open ? 'הקשר לשאלה — לחץ להסתרה' : 'הקשר לשאלה — לחץ להצגה';
      });
    }
    if (onDelete) { delBtn.style.display = ''; } else { delBtn.style.display = 'none'; }
    wireSolutionToggle(q);
    // Auto-open solution panel immediately on question load
    setTimeout(() => {
      const toggleBtn = viewer.querySelector('#qv-sol-toggle');
      if (toggleBtn) toggleBtn.click();
    }, 0);
  }

  function wireSolutionToggle(q) {
    const toggleBtn = viewer.querySelector('#qv-sol-toggle');
    const panel = viewer.querySelector('#qv-sol-panel');
    const labelEl = viewer.querySelector('.qv-sol-label');
    if (!toggleBtn || !panel) return;
    toggleBtn.addEventListener('click', () => {
      const isOpen = !panel.hidden;
      if (isOpen) {
        panel.hidden = true;
        toggleBtn.classList.remove('open');
        if (labelEl) labelEl.textContent = 'הצג פתרון מפורט';
      } else {
        if (!panel.dataset.rendered) {
          panel.innerHTML = renderSolutionPanel(q);
          panel.dataset.rendered = '1';
          wireSolutionPanelActions(q, panel);
        }
        panel.hidden = false;
        toggleBtn.classList.add('open');
        if (labelEl) labelEl.textContent = 'הסתר פתרון מפורט';
      }
    });
  }

  function wireSolutionPanelActions(q, panel) {
    // "תקן תשובה" — opens the solution-PDF viewer modal with radios on the right.
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="correct-toggle"]');
      if (!btn) return;
      e.preventDefault();
      openFixAnswerModal(q, courseId, () => {
        // Re-render the solution panel with the new correct answer.
        panel.innerHTML = renderSolutionPanel(q);
        wireSolutionPanelActions(q, panel);
        // Refresh the question image at the top of the viewer too — the
        // reshoot flow also writes image_path, though fix-answer doesn't.
        if (q.image_path) {
          const imgEl = viewer.querySelector('.qv-image-wrap img');
          if (imgEl && !q.image_path.includes('?t=')) {
            const sep = q.image_path.includes('?') ? '&' : '?';
            imgEl.src = q.image_path + sep + 't=' + Date.now();
          }
        }
      });
    });

    // "צלם מחדש" inside the solution panel — opens the manual crop tool.
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="retake-image"]');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      openReshootCropTool(q, (updated) => {
        // Re-render solution panel so the new image_path takes effect if we
        // show a thumbnail anywhere. Also cache-bust the big question image
        // at the top of the viewer.
        if (updated?.image_path) {
          const imgEl = viewer.querySelector('.qv-image-wrap img');
          if (imgEl) {
            const sep = updated.image_path.includes('?') ? '&' : '?';
            imgEl.src = updated.image_path + sep + 't=' + Date.now();
          }
        }
        panel.innerHTML = renderSolutionPanel(q);
        wireSolutionPanelActions(q, panel);
      });
    });

    // "בדוק פתרון" — opens the same solution viewer as "תקן תשובה" so the
    // user can flip to the solution page and verify / correct the answer.
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="check-answer"]');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      openFixAnswerModal(q, courseId, () => {
        panel.innerHTML = renderSolutionPanel(q);
        wireSolutionPanelActions(q, panel);
      });
    });

    // Wire the remaining AI action buttons in the solution panel
    panel.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action="regen-solution"]');
      if (!btn || btn.disabled) return;
      const cfgMap = {
        'regen-solution': { endpoint: 'regenerate-answer', body: {},                       label: 'יוצר...',  success: 'הפתרון המפורט עודכן' },
      };
      const cfg = cfgMap[btn.dataset.action];
      if (!cfg) return;
      btn.disabled = true;
      const origText = btn.textContent;
      btn.innerHTML = `<span class="qv-spinner"></span> ${cfg.label}`;
      const restore = () => { btn.disabled = false; btn.textContent = origText; };
      try {
        const tk = await Auth.getToken();
        if (!tk) { toast('תוקף ההתחברות פג. התחבר שוב.', 'error'); restore(); return; }
        const r = await fetch(`/api/questions/${encodeURIComponent(q.id)}/${cfg.endpoint}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(cfg.body),
        });
        let data = {};
        try { data = await r.json(); } catch {}
        if (r.status === 401) { toast('תוקף ההתחברות פג. התחבר שוב.', 'error'); restore(); return; }
        if (r.status === 402) { restore(); showPaywallModal(data.trial_expired ? 'trial_ended' : 'ai_quota'); return; }
        if (r.status === 429) { toast(data.guidance || 'הגעת למגבלה היומית', 'error'); restore(); return; }
        if (!r.ok || !data.ok) { toast([data.error, data.detail].filter(Boolean).join(' — ') || `שגיאה (${r.status})`, 'error'); restore(); return; }
        // Merge updated fields into q
        if (data.question) {
          Object.assign(q, data.question);
        } else {
          if (data.general_explanation  != null) q.general_explanation  = data.general_explanation;
          if (data.option_explanations  != null) q.option_explanations  = data.option_explanations;
          // Enrichment fields from the upgraded prompt — pill + distractor panels
          // render automatically in renderSolutionPanel() when present.
          if (data.concept_tag         !== undefined) q.concept_tag         = data.concept_tag;
          if (data.distractor_analysis !== undefined) q.distractor_analysis = data.distractor_analysis;
        }
        // Refresh the on-screen question image if reanalyze produced a new
        // image_path. Without this the user sees "התמונה עודכנה בהצלחה" but
        // the same (bad) crop stays on screen — the solution panel below
        // re-renders but the question image above doesn't.
        if (data.question?.image_path) {
          const newSrc = data.question.image_path.startsWith('http')
            ? data.question.image_path
            : Data.imageUrl(data.question.image_path, courseId);
          const imgEl = viewer.querySelector('.qv-image-wrap img');
          if (imgEl) {
            const sep = newSrc.includes('?') ? '&' : '?';
            imgEl.src = newSrc + sep + 't=' + Date.now();
          }
        }
        panel.innerHTML = renderSolutionPanel(q);
        wireSolutionPanelActions(q, panel);
        toast(cfg.success, 'success');
      } catch (err) {
        console.error('[solution-panel-ai]', err);
        toast('שגיאה לא צפויה', 'error');
        restore();
      }
    });

    // Wire the manual answer save button (present in both 'unknown' and collapsible panel)
    const manualSaveBtn = panel.querySelector('#qv-manual-save');
    if (manualSaveBtn) {
      manualSaveBtn.addEventListener('click', async () => {
        const selected = panel.querySelector('input[name="qv-manual-answer"]:checked');
        if (!selected) { toast('בחר תשובה לפני השמירה', 'error'); return; }
        const newIdx = parseInt(selected.value, 10);
        manualSaveBtn.disabled = true;
        const orig = manualSaveBtn.textContent;
        manualSaveBtn.innerHTML = '<span class="qv-spinner"></span>';
        try {
          const tk = await Auth.getToken();
          const r = await fetch(`/api/courses/${courseId}/questions/${q.id}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ correct_idx: newIdx }),
          });
          const data = await r.json();
          if (!r.ok) {
            toast(data.error || 'שגיאה בשמירה', 'error');
            manualSaveBtn.disabled = false; manualSaveBtn.textContent = orig;
            return;
          }
          q.correct_idx = newIdx;
          q.answer_confidence = 'manual';
          // The old cached explanations were written for the PREVIOUS correct
          // answer; drop them so the user sees the "שפר הסבר עם AI" button and
          // regenerates with the new premise.
          q.general_explanation = null;
          q.option_explanations = null;
          panel.innerHTML = renderSolutionPanel(q);
          wireSolutionPanelActions(q, panel);
          toast('התשובה נשמרה. צור הסבר מחדש כדי להתאים לתשובה החדשה.', 'success');
        } catch (e) {
          toast('שגיאה בשמירה', 'error');
          manualSaveBtn.disabled = false; manualSaveBtn.textContent = orig;
        }
      });
    }

    // Wire the AI enhance button (not present when rich explanations already loaded)
    const enhanceBtn = panel.querySelector('#qv-sol-enhance');
    if (!enhanceBtn) return;
    const doEnhance = async (fromAuto = false) => {
      if (enhanceBtn.disabled) return;
      enhanceBtn.disabled = true;
      const orig = enhanceBtn.innerHTML;
      const restore = () => { enhanceBtn.disabled = false; enhanceBtn.innerHTML = orig; };
      enhanceBtn.innerHTML = '<span class="qv-spinner"></span> מייצר הסבר מפורט...';
      try {
        const tk = await Auth.getToken();
        if (!tk) {
          if (!fromAuto) toast('תוקף ההתחברות פג. התחבר שוב.', 'error');
          restore();
          return;
        }
        const callEndpoint = async (endpoint) => {
          let res, json;
          try {
            res = await fetch(endpoint, {
              method: 'POST',
              headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ questionId: q.id }),
            });
          } catch (netErr) {
            console.error('[enhance] network:', netErr);
            return { netError: true };
          }
          try {
            json = await res.json();
          } catch (parseErr) {
            console.error('[enhance] json parse:', parseErr, 'status:', res.status);
            return { parseError: true, status: res.status };
          }
          return { res, data: json };
        };
        // Tier-2 text-only endpoint (cheap, fast)
        let out = await callEndpoint('/api/questions/enhance-solution');
        if (out.netError) {
          if (!fromAuto) toast('שגיאת רשת. נסה שוב.', 'error');
          restore();
          return;
        }
        if (out.parseError) {
          if (!fromAuto) toast(`השרת החזיר תשובה לא תקינה (${out.status}).`, 'error');
          restore();
          return;
        }
        let { res: r, data } = out;
        // Fallback: if the question has no text (scanned PDF), use image-based tier-3
        if (r.status === 422 && data?.fallback === 'image') {
          console.log('[enhance] falling back to image-based generate-solution');
          out = await callEndpoint('/api/questions/generate-solution');
          if (out.netError || out.parseError) {
            if (!fromAuto) toast('שגיאת תקשורת. נסה שוב.', 'error');
            restore();
            return;
          }
          r = out.res;
          data = out.data;
        }
        if (r.status === 401) {
          if (!fromAuto) toast('תוקף ההתחברות פג. התחבר שוב.', 'error');
          restore();
          return;
        }
        if (r.status === 402) {
          // Trial expired or plan doesn't include AI enhancement — show paywall
          restore();
          if (!fromAuto) showPaywallModal(data.trial_expired ? 'trial_ended' : 'ai_quota');
          return;
        }
        if (!r.ok || !data.ok) {
          if (!fromAuto) toast(data.error || data.guidance || `שגיאה ביצירת הפתרון (${r.status})`, 'error');
          console.error('[enhance] api error:', r.status, data);
          restore();
          return;
        }
        q.general_explanation = data.general_explanation;
        q.option_explanations = data.option_explanations;
        if (data.correct_idx) q.correct_idx = data.correct_idx;
        panel.innerHTML = renderSolutionPanel(q);
        wireSolutionPanelActions(q, panel);
        if (!fromAuto) toast('הפתרון נוצר בהצלחה', 'success');
      } catch (e) {
        console.error('[enhance] uncaught:', e);
        if (!fromAuto) toast('שגיאה לא צפויה ביצירת הפתרון', 'error');
        restore();
      }
    };
    enhanceBtn.addEventListener('click', () => doEnhance(false));
  }

  render();

  prevBtn.addEventListener('click', () => { if (currentIndex > 0) { currentIndex--; render(); } });
  nextBtn.addEventListener('click', () => { if (currentIndex < questions.length - 1) { currentIndex++; render(); } });

  const close = () => { document.removeEventListener('keydown', onKey); viewer.remove(); };
  viewer.querySelector('#qv-close').addEventListener('click', close);
  viewer.addEventListener('click', (e) => { if (e.target === viewer) close(); });

  // Keyboard navigation
  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowLeft') { if (currentIndex < questions.length - 1) { currentIndex++; render(); } }
    if (e.key === 'ArrowRight') { if (currentIndex > 0) { currentIndex--; render(); } }
  }
  document.addEventListener('keydown', onKey);

  if (delBtn && onDelete) {
    delBtn.addEventListener('click', () => {
      const q = questions[currentIndex];
      close();
      showConfirmModal({
        title: 'הסרת שאלה',
        body: `להסיר את שאלה #${q.question_number}?\nהשאלה תועבר לסל המחזור ותימחק סופית לאחר 3 ימים.`,
        confirmLabel: 'הסר לסל המחזור', danger: true,
        onConfirm: async () => {
          const tk = await Auth.getToken();
          const r = await fetch(`/api/courses/${courseId}/questions/${q.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tk}` } });
          if (r.ok) { onDelete(currentIndex); toast('השאלה הועברה לסל המחזור', 'success'); }
          else toast('שגיאה בהסרה', 'error');
        },
      });
    });
  }
}

function renderSolutionPanel(q) {
  const hasGeneral = !!(q.general_explanation && String(q.general_explanation).trim());
  const opts = Array.isArray(q.option_explanations) ? q.option_explanations : [];
  const hasOpts = opts.length > 0 && opts.some(o => o && o.explanation);
  const letters = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];
  const numOptions = Math.max(2, Math.min(10, parseInt(q.num_options, 10) || 4));
  const correctIdx = parseInt(q.correct_idx, 10) || (opts.find(o => o?.isCorrect)?.idx) || 1;
  const correctLetter = letters[correctIdx - 1] || String(correctIdx);
  const needsReview = q.answer_confidence === 'unknown';
  const isUncertain = q.answer_confidence === 'uncertain';

  // Radio buttons — pre-select current answer when confidence is known.
  // Biology/genetics exams have up to 10 options (א..י).
  const radioBorderColor = needsReview ? '#fca5a5' : (isUncertain ? '#fed7aa' : 'var(--border-soft)');
  const indices = Array.from({ length: numOptions }, (_, i) => i + 1);
  const radios = indices.map(i => `
    <label style="display:flex;align-items:center;gap:4px;cursor:pointer;padding:6px 12px;border:1px solid ${radioBorderColor};border-radius:6px;background:white;">
      <input type="radio" name="qv-manual-answer" value="${i}" ${!needsReview && i === correctIdx ? 'checked' : ''} style="margin:0;" />
      <span>${letters[i-1] || i}</span>
    </label>
  `).join('');
  const saveBtn = `<button class="btn btn-primary btn-sm" id="qv-manual-save" type="button" data-q-id="${q.id}">שמור</button>`;
  const optionsPrompt = numOptions === 4 ? 'ארבעת האפשרויות' : `${numOptions} האפשרויות`;

  // Three states:
  //   'unknown'   — red warning, radios visible immediately, user MUST set manually
  //   'uncertain' — orange warning, AI picked an answer but second model disagreed;
  //                 radios visible, user should verify
  //   'confirmed'/'manual' — green badge, collapsed correction panel
  let answerBlock = '';
  if (needsReview) {
    answerBlock = `
      <div class="qv-answer-review" style="margin-bottom:16px;padding:14px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;">
        <p style="margin:0 0 10px;font-size:13px;color:#991b1b;font-weight:600;">⚠ התשובה הנכונה לא זוהתה אוטומטית</p>
        <p style="margin:0 0 10px;font-size:12px;color:#7f1d1d;">בחר את התשובה הנכונה מתוך ${optionsPrompt}:</p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${radios}${saveBtn}</div>
      </div>`;
  } else if (isUncertain) {
    answerBlock = `
      <div class="qv-answer-uncertain" style="margin-bottom:16px;padding:14px 16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;">
        <p style="margin:0 0 6px;font-size:13px;color:#9a3412;font-weight:600;">⚠️ הזיהוי האוטומטי לא ודאי</p>
        <p style="margin:0 0 10px;font-size:12px;color:#9a3412;">ה-AI זיהה את התשובה כ-<strong>${correctLetter}</strong>, אבל מודל אימות שני לא הסכים. אנא ודא שהתשובה הנכונה היא ${correctLetter}, או תקן לפי הצורך:</p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${radios}${saveBtn}</div>
      </div>`;
  } else {
    answerBlock = `
      <div class="qv-sol-correct" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
        <span class="qv-sol-badge">תשובה נכונה: ${correctLetter}</span>
        <div style="display:flex;gap:10px;align-items:center;">
          <button data-action="retake-image"  type="button" style="font-size:11px;border:1px solid #c7d2fe;background:#eef2ff;color:#3730a3;border-radius:4px;padding:3px 8px;cursor:pointer;font-family:inherit;font-weight:600;">צלם מחדש</button>
          <button data-action="check-answer"  type="button" style="font-size:11px;border:1px solid #fcd34d;background:#fffbeb;color:#92400e;border-radius:4px;padding:3px 8px;cursor:pointer;font-family:inherit;font-weight:600;" title="הצג את עמוד הפתרון הנכון מהקובץ">בדוק פתרון</button>
          <button data-action="regen-solution" type="button" style="font-size:11px;border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;border-radius:4px;padding:3px 8px;cursor:pointer;font-family:inherit;font-weight:600;">פתרון מפורט</button>
          <button data-action="correct-toggle" type="button" style="font-size:11px;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px 0;text-decoration:underline;">תקן תשובה</button>
        </div>
      </div>
      <div data-panel="correct" style="display:none;margin-bottom:16px;padding:12px 14px;background:var(--gray-50);border:1px solid var(--border-soft);border-radius:10px;">
        <p style="margin:0 0 8px;font-size:12px;color:var(--text-muted);">בחר תשובה נכונה:</p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${radios}${saveBtn}</div>
      </div>`;
  }

  // Cached rich explanations — show them immediately.
  if (hasGeneral || hasOpts) {
    // Layer 4/5: per-distractor misconception analysis (optional, nullable).
    const distractorAnalysis = Array.isArray(q.distractor_analysis) ? q.distractor_analysis : [];
    const distractorByIdx = {};
    for (const d of distractorAnalysis) {
      const i = parseInt(d?.idx, 10);
      if (i) distractorByIdx[i] = d;
    }

    const optsHtml = opts.length > 0 ? opts.map(o => {
      const idx = parseInt(o.idx, 10);
      const letter = letters[idx - 1] || String(idx);
      const isCorrect = idx === q.correct_idx;
      const cls = isCorrect ? 'qv-sol-opt--correct' : 'qv-sol-opt--wrong';
      const mark = isCorrect ? '✓ נכונה' : '✗ שגויה';
      const dist = !isCorrect ? distractorByIdx[idx] : null;
      const distHtml = (dist && (dist.misconception || dist.why_wrong)) ? `
        <details class="qv-distractor" style="margin-top:8px;border-top:1px dashed rgba(0,0,0,.1);padding-top:6px;">
          <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);font-weight:600;">מה עלול להטעות כאן?</summary>
          ${dist.misconception ? `<div class="sol-text" style="margin-top:6px;font-size:13px;"><strong>הטעיה:</strong> ${renderSolutionText(String(dist.misconception))}</div>` : ''}
          ${dist.why_wrong ? `<div class="sol-text" style="margin-top:4px;font-size:13px;"><strong>למה שגוי:</strong> ${renderSolutionText(String(dist.why_wrong))}</div>` : ''}
        </details>` : '';
      return `
        <div class="qv-sol-opt ${cls}">
          <div class="qv-sol-opt-head">
            <span class="qv-sol-opt-letter">${letter}</span>
            <span class="qv-sol-opt-mark">${mark}</span>
          </div>
          <div class="sol-text">${renderSolutionText(o.explanation || '')}</div>
          ${distHtml}
        </div>`;
    }).join('') : '';

    // Layer 5: concept pill (shows when ensemble populated concept_tag).
    const conceptPill = q.concept_tag
      ? `<span class="qv-concept-pill" style="display:inline-block;margin-right:8px;padding:2px 10px;font-size:11px;font-weight:600;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:999px;">${escapeHtml(q.concept_tag)}</span>`
      : '';

    return `
      ${answerBlock}
      ${hasGeneral ? `
        <div class="qv-sol-general">
          <h4 style="display:flex;align-items:center;gap:6px;">הסבר כללי ${conceptPill}</h4>
          <div class="sol-text">${renderSolutionText(q.general_explanation)}</div>
        </div>` : ''}
      ${optsHtml ? `
        <div class="qv-sol-options">
          <h4>ניתוח האפשרויות</h4>
          ${optsHtml}
        </div>` : ''}
    `;
  }

  // No rich explanation yet — show answer block + enhance button
  return `
    ${answerBlock}
    <div class="qv-enhance-wrap">
      <button class="btn btn-primary btn-sm" id="qv-sol-enhance" type="button">שפר הסבר עם AI</button>
      <p class="qv-no-solution-hint">ה-AI ייצר הסבר מפורט לכל אפשרות (כולל הלא-נכונות). כ-3-5 שניות.</p>
    </div>
  `;
}

// =====================================================
// New-user onboarding tour — 5-step spotlight walkthrough
// =====================================================
function showOnboardingTour() {

  const steps = [
    {
      title: 'ברוך הבא ל-ExamPrep',
      body: 'כאן תתרגל שאלות מבחינות אמיתיות ותעקוב אחר ההתקדמות שלך. הנה סיור קצר שיעזור לך להתחיל.',
      anchor: null,
      icon: `<img src="/public/images/logo.png?v=20260410-8" alt="ExamPrep" style="width:26px;height:auto;display:block;">`,
    },
    {
      title: 'בחר תחום לימוד',
      body: 'לחץ כאן כדי לבחור תחום: פסיכומטרי, אמירם, או קורסים אקדמיים. התחום הוא המסגרת — בתוכו תוסיף קורסים.',
      anchor: '#btn-add-course-card',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
    },
    {
      title: 'הוסף קורס בתוך התחום',
      body: 'לאחר בחירת תחום, תיכנס לדף התחום. שם תוכל להוסיף קורס ספציפי — למשל "חשבון" או "אנגלית".',
      anchor: null,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
    },
    {
      title: 'העלה מבחן PDF',
      body: 'לחץ על קורס ואז על "העלה מבחן PDF". ניתן להוסיף גם קובץ פתרון — ה-AI יחלץ שאלות ויזהה תשובות נכונות.',
      anchor: null,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>`,
    },
    {
      title: 'תרגל ועקוב אחר ההתקדמות',
      body: 'בתוך כל קורס תמצא: תרגול שאלות, ביקורת טעויות, תובנות אישיות ומבחן מדומה. בהצלחה!',
      anchor: null,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
    },
  ];

  let current = 0;
  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';

  function render() {
    const step = steps[current];
    const isLast = current === steps.length - 1;
    const progressPct = Math.round(((current + 1) / steps.length) * 100);

    // Spotlight target
    let spotlightStyle = '';
    let anchorRect = null;
    if (step.anchor) {
      const el = document.querySelector(step.anchor);
      if (el) {
        anchorRect = el.getBoundingClientRect();
        const pad = 8;
        spotlightStyle = `
          --sp-top:${anchorRect.top - pad}px;
          --sp-left:${anchorRect.left - pad}px;
          --sp-width:${anchorRect.width + pad * 2}px;
          --sp-height:${anchorRect.height + pad * 2}px;
        `;
      }
    }

    overlay.style.cssText = spotlightStyle;
    overlay.className = 'onboarding-overlay' + (anchorRect ? ' onboarding-has-spotlight' : '');

    // Compute tooltip position: prefer below anchor, flip above if off-screen,
    // center vertically on narrow mobile screens.
    let tipStyle = '';
    if (anchorRect) {
      const TIP_H = 270;
      const TIP_W = 340;
      const pad = 12;
      const isMobile = window.innerWidth < 520;
      if (isMobile) {
        // On mobile always center horizontally; place below or center vertically
        const tipLeft = pad;
        const spaceBelow = window.innerHeight - anchorRect.bottom - pad;
        const tipTop = spaceBelow >= TIP_H
          ? anchorRect.bottom + 14
          : Math.max(pad, Math.round((window.innerHeight - TIP_H) / 2));
        tipStyle = `style="top:${tipTop}px;left:${tipLeft}px;right:${pad}px;width:auto;"`;
      } else {
        const spaceBelow = window.innerHeight - anchorRect.bottom - pad;
        const spaceAbove = anchorRect.top - pad;
        let tipTop;
        if (spaceBelow >= TIP_H) {
          tipTop = anchorRect.bottom + 14;
        } else if (spaceAbove >= TIP_H) {
          tipTop = anchorRect.top - TIP_H - 10;
        } else {
          tipTop = Math.max(pad, Math.round((window.innerHeight - TIP_H) / 2));
        }
        const tipLeft = Math.max(pad, Math.min(anchorRect.left, window.innerWidth - TIP_W - pad));
        tipStyle = `style="top:${tipTop}px;left:${tipLeft}px;"`;
      }
    }

    overlay.innerHTML = `
      ${anchorRect ? `<div class="onboarding-spotlight" style="top:${anchorRect.top - 8}px;left:${anchorRect.left - 8}px;width:${anchorRect.width + 16}px;height:${anchorRect.height + 16}px;"></div>` : ''}
      <div class="onboarding-tooltip ${anchorRect ? 'onboarding-tooltip--anchored' : 'onboarding-tooltip--center'}"
           ${tipStyle}>
        <div class="onboarding-header">
          <div class="onboarding-step-icon">${step.icon}</div>
          <div class="onboarding-step-counter">שלב <span>${current + 1}</span> מתוך ${steps.length}</div>
        </div>
        <h3 class="onboarding-title">${escapeHtml(step.title)}</h3>
        <p class="onboarding-body">${escapeHtml(step.body)}</p>
        <div class="onboarding-footer">
          <div class="onboarding-progress">
            <div class="onboarding-progress-fill" style="width:${progressPct}%"></div>
          </div>
          <div class="onboarding-actions">
            <button class="btn btn-ghost btn-sm onboarding-skip">דלג</button>
            <button class="btn btn-primary onboarding-next">${isLast ? 'בוא נתחיל' : 'הבא ←'}</button>
          </div>
        </div>
      </div>
    `;

    overlay.querySelector('.onboarding-skip').onclick = done;
    overlay.querySelector('.onboarding-next').onclick = () => {
      if (isLast) { done(); } else { current++; render(); }
    };
  }

  function done() {
    sessionStorage.setItem('ep_onboarding_skip', '1');
    overlay.classList.add('onboarding-exit');
    setTimeout(() => overlay.remove(), 400);
  }

  render();
  document.body.appendChild(overlay);
}

// Generic confirmation modal
function showConfirmModal({ title, body, confirmLabel, danger, onConfirm }) {
  const html = `
    <div class="modal-backdrop" id="confirm-modal">
      <div class="modal" style="max-width:420px;">
        <h2 style="margin-bottom:12px;">${title}</h2>
        <p style="line-height:1.7; color:var(--text-2); margin-bottom:20px;">${body}</p>
        <div style="display:flex; gap:10px;">
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-yes">${confirmLabel || 'אישור'}</button>
          <button class="btn btn-ghost" id="confirm-no">ביטול</button>
        </div>
      </div>
    </div>
  `;
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container.firstElementChild);
  const modal = document.getElementById('confirm-modal');
  const close = () => modal.remove();
  document.getElementById('confirm-no').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('confirm-yes').addEventListener('click', async () => {
    const btn = document.getElementById('confirm-yes');
    btn.disabled = true;
    btn.textContent = 'מוחק...';
    try { await onConfirm(); } catch {}
    close();
  });
}

// Upload PDF modal
function showUploadPdfModal(courseId) {
  if (courseId === 'tohna1') {
    showConfirmModal({ title: 'העלאה לקורס מובנה', body: 'תוכן "תוכנה 1" מנוהל דרך קבצים מקומיים ולא ניתן להעלות אליו דרך הממשק.<br><br>לבדיקת זרימת ההעלאה — צור קורס חדש ועלה אליו.', confirmLabel: 'הבנתי', onConfirm: () => {} });
    return;
  }
  const html = `
    <div class="modal-backdrop" id="upload-pdf-modal">
      <div class="modal">
        <button class="modal-close" id="up-close">✕</button>
        <h2>העלאת מבחן PDF</h2>
        <p class="modal-sub">העלה קובץ PDF של מבחן (ואופציונלית גם פתרון)</p>
        <div class="auth-form">
          <div class="field">
            <label for="up-name">שם המבחן *</label>
            <input type="text" id="up-name" placeholder="למשל: מבחן מועד א 2024" maxlength="100" />
            <div class="up-name-suggest" id="up-name-suggest" style="display:none"></div>
          </div>
          <div class="upload-drop-zone" id="up-drop-exam">
            <input type="file" id="up-exam" accept=".pdf" style="display:none" />
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="var(--brand-400)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <strong>קובץ מבחן (PDF) *</strong>
            <span class="drop-hint">גרור לכאן או לחץ לבחירה</span>
            <span class="drop-file-name" id="up-exam-name"></span>
          </div>
          <div class="upload-drop-zone upload-drop-zone-sm" id="up-drop-sol">
            <input type="file" id="up-solution" accept=".pdf" style="display:none" />
            <strong>קובץ פתרון (אופציונלי)</strong>
            <span class="drop-hint">גרור לכאן או לחץ לבחירה</span>
            <span class="drop-file-name" id="up-sol-name"></span>
          </div>
          <p class="auth-error" id="up-error"></p>
          <div id="up-progress" style="display:none">
            <div class="phb-track"><div class="phb-fill" id="up-progress-fill" style="width:0%"></div></div>
            <p class="muted" id="up-status">מעלה ומעבד שאלות...</p>
          </div>
          <button class="btn btn-primary btn-block" id="up-submit">העלה מבחן</button>
        </div>
      </div>
    </div>
  `;
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container.firstElementChild);
  const modal = document.getElementById('upload-pdf-modal');
  let _uploading = false;
  let _uploadRequest = null; // holds the abort-able promise
  const close = () => { _uploading = false; modal.remove(); };

  // Guard: confirm before closing during upload
  function guardedClose() {
    if (!_uploading) return close();
    showConfirmModal({
      title: 'העלאה בתהליך',
      body: 'ההעלאה עדיין פעילה. אם תצא עכשיו, הקובץ לא יועלה והתהליך ייעצר. לצאת בכל זאת?',
      confirmLabel: 'כן, עצור העלאה',
      danger: true,
      onConfirm: () => {
        if (_uploadRequest?.abort) _uploadRequest.abort();
        close();
      },
    });
  }
  document.getElementById('up-close').addEventListener('click', guardedClose);
  modal.addEventListener('click', (e) => { if (e.target === modal) guardedClose(); });

  // Also warn on browser back/refresh during upload
  const beforeUnloadHandler = (e) => { if (_uploading) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnloadHandler);
  // Cleanup when modal is removed
  const observer = new MutationObserver(() => {
    if (!document.getElementById('upload-pdf-modal')) {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  // --- Drag & drop wiring ---
  function wireDropZone(zoneId, inputId, nameId) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    const nameEl = document.getElementById(nameId);
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.type === 'application/pdf') {
        const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
        input.dispatchEvent(new Event('change'));
      }
    });
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (file) {
        nameEl.textContent = file.name;
        zone.classList.add('has-file');
      } else {
        nameEl.textContent = '';
        zone.classList.remove('has-file');
      }
    });
    return input;
  }
  const examInput = wireDropZone('up-drop-exam', 'up-exam', 'up-exam-name');
  wireDropZone('up-drop-sol', 'up-solution', 'up-sol-name');

  // Build a clear, readable exam name from a messy filename.
  // Handles common Hebrew academic patterns:
  //   moed_aleph_24_25_no_ans_nom.pdf  → "מועד א' 2024-2025"
  //   semester_b_2023_final.pdf        → "סמסטר ב' 2023 — סופי"
  //   midterm_2024_clean.pdf           → "אמצע 2024"
  function smartName(filename) {
    let n = filename.replace(/\.pdf$/i, '');
    n = n.replace(/[_\-.]+/g, ' ').trim();

    // ── Year detection ──
    let yearTag = '';
    const yearRangeMatch = n.match(/\b(19|20)?(\d{2})\s+(19|20)?(\d{2})\b/);
    const singleYearMatch = !yearRangeMatch ? n.match(/\b(20\d{2}|19\d{2})\b/) : null;
    const twoDigitYear = !yearRangeMatch && !singleYearMatch ? n.match(/\b(\d{2})\b/) : null;
    if (yearRangeMatch) {
      const y1 = (yearRangeMatch[1] || '20') + yearRangeMatch[2];
      const y2 = (yearRangeMatch[3] || '20') + yearRangeMatch[4];
      yearTag = `${y1}-${y2.slice(-2)}`;
      n = n.replace(yearRangeMatch[0], ' ');
    } else if (singleYearMatch) {
      yearTag = singleYearMatch[1];
      n = n.replace(singleYearMatch[0], ' ');
    } else if (twoDigitYear) {
      const yy = parseInt(twoDigitYear[1], 10);
      if (yy >= 10 && yy <= 40) {
        yearTag = `20${twoDigitYear[1]}`;
        n = n.replace(twoDigitYear[0], ' ');
      }
    }

    // ── "Moed + letter" → "Moed A/B/C/D/E" (English output) ──
    const moedLetterMap = {
      aleph: 'A', alef: 'A', a: 'A',
      bet: 'B', beit: 'B', b: 'B',
      gimel: 'C', gimmel: 'C', c: 'C',
      dalet: 'D', daled: 'D', d: 'D',
      hei: 'E', he: 'E', e: 'E',
    };
    let moedTag = '';
    const moedMatch = n.match(/\bmoed\s+(\w+)\b/i);
    if (moedMatch) {
      const letter = moedLetterMap[moedMatch[1].toLowerCase()];
      if (letter) {
        moedTag = `Moed ${letter}`;
        n = n.replace(moedMatch[0], ' ');
      } else {
        moedTag = 'Moed';
        n = n.replace(/\bmoed\b/i, ' ');
      }
    } else {
      // Transliterate Hebrew "מועד א/ב/ג/ד/ה" → English
      const heToEn = { 'א': 'A', 'ב': 'B', 'ג': 'C', 'ד': 'D', 'ה': 'E' };
      const heMoed = n.match(/מועד\s*([א-ה])'?/);
      if (heMoed) {
        moedTag = `Moed ${heToEn[heMoed[1]] || heMoed[1]}`;
        n = n.replace(heMoed[0], ' ');
      }
    }

    // ── Semester tag ──
    let semTag = '';
    const semMatch = n.match(/\bsem(?:ester)?\s*([ab12])\b/i);
    if (semMatch) {
      const raw = semMatch[1].toLowerCase();
      semTag = `Semester ${raw === 'a' || raw === '1' ? 'A' : 'B'}`;
      n = n.replace(semMatch[0], ' ');
    } else {
      const heSem = n.match(/סמסטר\s*([אב12])/);
      if (heSem) {
        semTag = `Semester ${heSem[1] === 'א' || heSem[1] === '1' ? 'A' : 'B'}`;
        n = n.replace(heSem[0], ' ');
      }
    }

    // ── Midterm / final ──
    let stageTag = '';
    if (/\b(midterm|mid term|אמצע)\b/i.test(n)) { stageTag = 'Midterm'; n = n.replace(/\b(midterm|mid term|אמצע)\b/gi, ' '); }
    else if (/\b(final|סופי|סוף)\b/i.test(n)) { stageTag = 'Final'; n = n.replace(/\b(final|סופי|סוף)\b/gi, ' '); }

    // ── Strip noise words ──
    const NOISE = /\b(no\s*ans(?:wer)?s?|noans|without\s*ans(?:wer)?s?|with\s*ans(?:wer)?s?|answers?|ans|sol(?:ution)?|pitaron|pdf|nom(?:inal)?|scan(?:ned)?|clean|rev(?:ised)?|v\d+|final|exam|test|quiz|מבחן|פתרון|תשובות|מפתח|נקי|סרוק)\b/gi;
    n = n.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();

    // ── Assemble final label ──
    const parts = [];
    if (moedTag) parts.push(moedTag);
    if (semTag) parts.push(semTag);
    if (stageTag) parts.push(stageTag);
    if (yearTag) parts.push(yearTag);
    if (n) parts.push(n);
    const result = parts.join(' ').replace(/\s+/g, ' ').trim();
    return result || filename.replace(/\.pdf$/i, '').replace(/[_\-]+/g, ' ').trim();
  }

  // Toggle the "Apply suggestion" hint below the name input.
  function updateNameSuggestion() {
    const hint = document.getElementById('up-name-suggest');
    const nameInput = document.getElementById('up-name');
    const file = examInput.files[0];
    if (!file || !hint || !nameInput) { if (hint) hint.style.display = 'none'; return; }
    const suggestion = smartName(file.name);
    const current = (nameInput.value || '').trim();
    if (!suggestion || suggestion === current) { hint.style.display = 'none'; return; }
    hint.style.display = '';
    hint.innerHTML = `הצעה: <button type="button" class="up-suggest-link" id="up-suggest-apply">${escapeHtml(suggestion)}</button>`;
    document.getElementById('up-suggest-apply').addEventListener('click', () => {
      nameInput.value = suggestion;
      updateNameSuggestion();
    });
  }

  examInput.addEventListener('change', () => {
    const nameInput = document.getElementById('up-name');
    const file = examInput.files[0];
    if (file && !nameInput.value.trim()) {
      nameInput.value = smartName(file.name);
    }
    updateNameSuggestion();
  });
  document.getElementById('up-name').addEventListener('input', updateNameSuggestion);

  document.getElementById('up-submit').addEventListener('click', async () => {
    const nameInput = document.getElementById('up-name');
    let name = nameInput.value.trim();
    const examFile = document.getElementById('up-exam').files[0];
    const solFile = document.getElementById('up-solution').files[0];
    const errEl = document.getElementById('up-error');
    errEl.textContent = '';

    // Auto-fill name from filename if empty
    if ((!name || name.length < 2) && examFile) {
      name = smartName(examFile.name);
      nameInput.value = name;
    }
    if (!name || name.length < 2) { errEl.textContent = 'שם המבחן חייב להיות לפחות 2 תווים'; return; }
    if (!examFile) { errEl.textContent = 'חסר קובץ PDF של המבחן'; return; }
    // Client-side: warn if exam name contains solution keywords
    const SOLUTION_KW = ['פתרון', 'solution', 'תשובות', 'answers', 'answer key', 'מפתח'];
    if (SOLUTION_KW.some(k => name.toLowerCase().includes(k.toLowerCase()))) {
      errEl.textContent = 'שם המבחן נראה כמו פתרון — אם זה קובץ הבחינה, שנה את השם. קובץ פתרון מועלה בשדה הנפרד למטה.';
      return;
    }

    // Client-side file size check
    const plan = state.user?.plan || 'free';
    const maxMb = { trial: 15, free: 10, basic: 20, pro: 30, education: 50 }[plan] || 10;
    if (examFile.size > maxMb * 1024 * 1024) {
      errEl.textContent = `הקובץ גדול מדי (מקסימום ${maxMb}MB לחבילת ${plan})`; return;
    }
    if (solFile && solFile.size > maxMb * 1024 * 1024) {
      errEl.textContent = `קובץ הפתרון גדול מדי (מקסימום ${maxMb}MB)`; return;
    }

    // Server enforces pdf_day quota for all plans including free

    const btn = document.getElementById('up-submit');
    btn.disabled = true;
    btn.textContent = 'מעלה ומעבד...';
    document.getElementById('up-progress').style.display = '';
    const fill = document.getElementById('up-progress-fill');
    const statusEl = document.getElementById('up-status');

    // Phase 2: server-side processing (50-95%) — detailed step messages
    let processingInterval = null;
    let processingStart = null;
    const processingSteps = [
      { at: 0, text: 'ממיר עמודי PDF לתמונות...' },
      { at: 3, text: 'סורק את המסמך וקורא טקסט...' },
      { at: 6, text: 'מזהה מבנה שאלות בדף...' },
      { at: 10, text: 'חותך שאלות מהמבחן...' },
      { at: 15, text: 'מעבד תמונות שאלה באיכות גבוהה...' },
      { at: 20, text: 'מנתח קובץ פתרון עם AI...' },
      { at: 28, text: 'AI מחפש את התשובות הנכונות לכל שאלה...' },
      { at: 35, text: 'מתאים תשובות לשאלות...' },
      { at: 42, text: 'שומר שאלות ותמונות בענן...' },
      { at: 50, text: 'מעדכן סטטיסטיקות הקורס...' },
      { at: 60, text: 'מנקה קבצים זמניים...' },
      { at: 75, text: 'כמעט סיימנו, עוד שנייה...' },
    ];
    function startProcessingPhase() {
      processingStart = Date.now();
      fill.style.width = '50%';
      statusEl.textContent = processingSteps[0].text;
      processingInterval = setInterval(() => {
        const elapsed = (Date.now() - processingStart) / 1000;
        const procPct = 50 + Math.min(45, 45 * (1 - Math.exp(-elapsed / 25)));
        fill.style.width = procPct + '%';
        const step = [...processingSteps].reverse().find(s => elapsed >= s.at);
        if (step) statusEl.textContent = step.text;
      }, 500);
    }

    try {
      const token = await Auth.getToken();

      // ===== Direct-to-Cloudinary upload path =====
      // Browser → Cloudinary directly (bypasses Vercel's 4.5MB body limit so
      // any size PDF always works), then a tiny JSON POST to /api/upload with
      // the publicIds for server-side processing.
      const totalSize = examFile.size + (solFile?.size || 0);
      _uploading = true;

      statusEl.textContent = '📤 מכין העלאה מאובטחת...';
      const signResp = await fetch('/api/upload-sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ courseId }),
      });
      if (!signResp.ok) {
        let msg = 'לא ניתן להתחיל העלאה';
        try { const d = await signResp.json(); msg = d.error || msg; } catch {}
        if (signResp.status === 401) throw new Error('תוקף ההתחברות פג — התחבר שוב');
        throw new Error(msg);
      }
      const signData = await signResp.json();

      // Upload one file directly to Cloudinary with byte-level progress.
      function uploadOneToCloudinary(file, params, progressCb) {
        return new Promise((resolve, reject) => {
          const form = new FormData();
          form.append('file', file);
          form.append('public_id', params.publicId);
          form.append('api_key', params.apiKey);
          form.append('timestamp', params.timestamp);
          form.append('signature', params.signature);
          const xhr = new XMLHttpRequest();
          xhr.open('POST', params.uploadUrl);
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable && progressCb) progressCb(e.loaded, e.total);
          });
          xhr.addEventListener('load', () => {
            let data; try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
            if (xhr.status >= 200 && xhr.status < 300 && data.public_id) resolve(data.public_id);
            else reject(new Error(data.error?.message || `Cloudinary error ${xhr.status}`));
          });
          xhr.addEventListener('error', () => reject(new Error('שגיאת רשת בהעלאה לענן')));
          xhr.addEventListener('abort', () => reject(new Error('__aborted__')));
          xhr.addEventListener('timeout', () => reject(new Error('ההעלאה נמשכה יותר מדי זמן')));
          xhr.timeout = 300000;
          xhr.send(form);
          _uploadRequest = { abort: () => xhr.abort() };
        });
      }

      // Track combined progress across both parallel uploads (examFile + solFile)
      // so the 0-50% phase fills smoothly based on total bytes transferred.
      let examLoaded = 0, solLoaded = 0;
      const updateCombinedProgress = () => {
        const loaded = examLoaded + solLoaded;
        const uploadPct = (loaded / totalSize) * 50;
        fill.style.width = uploadPct + '%';
        const pctDone = Math.round((loaded / totalSize) * 100);
        const mbLoaded = (loaded / (1024 * 1024)).toFixed(1);
        const mbTotal = (totalSize / (1024 * 1024)).toFixed(1);
        if (pctDone < 30) statusEl.textContent = `📤 מעלה קובץ... ${mbLoaded}MB מתוך ${mbTotal}MB`;
        else if (pctDone < 60) statusEl.textContent = `📡 מעלה לענן... ${pctDone}%`;
        else if (pctDone < 90) statusEl.textContent = `📦 מסיים העלאה... ${pctDone}%`;
        else statusEl.textContent = `✅ ההעלאה כמעט הושלמה... ${pctDone}%`;
      };

      const examUploadP = uploadOneToCloudinary(examFile, signData.exam, (loaded) => {
        examLoaded = loaded; updateCombinedProgress();
      });
      const solUploadP = solFile
        ? uploadOneToCloudinary(solFile, signData.solution, (loaded) => {
            solLoaded = loaded; updateCombinedProgress();
          })
        : Promise.resolve(null);

      const [examPublicId, solPublicId] = await Promise.all([examUploadP, solUploadP]);
      startProcessingPhase();

      // Small JSON POST — the server downloads the PDFs back from Cloudinary.
      const r = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name, courseId,
          examPublicId, solPublicId,
          examFilename: examFile.name || '',
          solFilename: solFile?.name || '',
        }),
      });
      let resJson;
      try { resJson = await r.json(); } catch { resJson = {}; }
      const res = { ok: r.ok, status: r.status, data: resJson };

      _uploading = false;
      if (processingInterval) clearInterval(processingInterval);

      if (!res.ok) {
        if (res.status === 402) {
          close();
          showPaywallModal(res.data?.trial_expired ? 'trial_ended' : 'pdf_upload');
          return;
        }
        if (res.status === 429) {
          errEl.textContent = res.data?.guidance || res.data?.error || 'הגעת למגבלת ההעלאות היומית';
          throw new Error(errEl.textContent);
        }
        if ((res.status === 422 || res.status === 409) && res.data.guidance) {
          errEl.textContent = res.data.error;
          const guide = document.createElement('p');
          guide.className = 'upload-guidance';
          guide.textContent = res.data.guidance;
          errEl.insertAdjacentElement('afterend', guide);
          throw new Error(res.data.error);
        }
        // 403/404 on the course access check → this courseId doesn't belong
        // to the signed-in user. Close the modal and bounce home instead of
        // leaving them stuck on a page they can't actually upload to.
        if (res.status === 403 || res.status === 404) {
          close();
          toast(res.data.error || 'הקורס הזה לא שייך לחשבון שלך.', 'warning');
          navigate('/dashboard');
          return;
        }
        // Include server-side diagnostic if present (helps debug prod failures).
        const baseMsg = res.data.error || 'שגיאה בהעלאה';
        const fullMsg = res.data.detail ? `${baseMsg} — ${res.data.detail}` : baseMsg;
        throw new Error(fullMsg);
      }

      statusEl.textContent = '✅ הושלם!';
      fill.style.width = '100%';
      const needsReview = res.data.status === 'awaiting_review';
      const reviewCount = res.data.review_count || 0;
      if (needsReview) {
        toast(`המבחן הועלה. ${reviewCount} שאלות דורשות אישור — פותח מסך סקירה...`, 'warning', 4000);
      } else {
        toast(res.data.question_count ? `המבחן הועלה בהצלחה! ${res.data.question_count} שאלות זוהו.` : 'המבחן הועלה בהצלחה!', 'success');
      }
      if (res.data.warnings && res.data.warnings.length) {
        res.data.warnings.forEach((w, i) => setTimeout(() => toast(w, 'warning', 8000), 1500 + i * 2000));
      }
      if (res.data.trashWarning) {
        setTimeout(() => toast(res.data.trashWarning, 'info', 6000), 800);
      }

      // Brief pause so user sees "הושלם" before modal closes
      await new Promise(r => setTimeout(r, 600));
      close();

      // If the upload needs human review, navigate straight to the Review screen.
      if (needsReview && res.data.exam_id) {
        navigate(`/course/${courseId}/exam/${res.data.exam_id}/review`);
        return;
      }

      // Refresh data and reopen exam management modal.
      // refreshCourseState re-fetches the courses list (so total_questions /
      // total_pdfs on the dashboard are live) AND re-renders the dashboard or
      // course view if one of them is currently showing.
      await refreshCourseState(courseId);
      // Reopen the exam management modal to show the new exam
      showExamManagementModal(courseId);
      // Update stats on course page if visible
      const statsEl = document.getElementById('cd-stats');
      if (statsEl) {
        const qs = questionsForCourse(courseId);
        const exs = examsForCourse(courseId);
        const metricValues = statsEl.querySelectorAll('.metric-value');
        const metricSubs = statsEl.querySelectorAll('.metric-sub');
        if (metricValues[0]) metricValues[0].textContent = qs.length;
        if (metricSubs[0]) metricSubs[0].textContent = `${exs.length} מבחנים`;
      }
    } catch (err) {
      _uploading = false;
      if (processingInterval) clearInterval(processingInterval);
      document.getElementById('up-progress').style.display = 'none';
      if (err.message === '__aborted__') {
        toast('ההעלאה בוטלה', 'warning');
        return; // modal already closed by guardedClose
      }
      errEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'העלה מבחן';
    }
  });
}

// ===== Add Course Modal =====
function showAddCourseModal() {
  // Client-side course quota check
  const plan = state.user?.plan || 'free';
  // Free plan now has courses=5; server enforces the limit
  const planDef = PLANS[plan] || PLANS.free;
  if (planDef.maxCourses !== -1 && state.courses.length >= planDef.maxCourses) {
    showPaywallModal('course_limit');
    return;
  }

  const wrap = document.createElement('div');
  wrap.appendChild(tmpl('tmpl-add-course'));
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('add-course-modal');
  const close = () => modal.remove();
  document.getElementById('ac-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Color picker
  let selectedColor = '#3b82f6';
  document.querySelectorAll('#ac-colors .color-swatch').forEach(sw => {
    sw.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('#ac-colors .color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      selectedColor = sw.dataset.color;
    });
  });

  document.getElementById('ac-submit').addEventListener('click', async () => {
    const name = document.getElementById('ac-name').value.trim();
    const desc = document.getElementById('ac-desc').value.trim();
    const errEl = document.getElementById('ac-error');
    errEl.textContent = '';
    if (!name || name.length < 2) {
      errEl.textContent = 'שם הקורס חייב להיות לפחות 2 תווים';
      return;
    }
    const btn = document.getElementById('ac-submit');
    btn.disabled = true;
    btn.textContent = 'יוצר קורס...';
    try {
      const imageUrl = document.getElementById('ac-image-url')?.value.trim() || null;
      const course = await CourseRegistry.create(name, desc || null, selectedColor, imageUrl);
      close();
      toast(`הקורס "${course.name}" נוצר בהצלחה!`, 'success');
      // If the user is on the dashboard, re-render it so the new course card
      // appears (and the welcome banner disappears) BEFORE they navigate away.
      // This way if they hit back, they land on a correct dashboard.
      if (getRoute() === '/dashboard') renderDashboard();
      navigate(`/course/${course.id}`);
    } catch (err) {
      errEl.textContent = err.message || 'שגיאה ביצירת הקורס';
    } finally {
      btn.disabled = false;
      btn.textContent = 'צור קורס';
    }
  });
}

// ===== Batch creation modal =====
function showBatchModal() {
  // Inject modal
  const wrap = document.createElement('div');
  wrap.appendChild(tmpl('tmpl-batch-modal'));
  document.body.appendChild(wrap.firstElementChild);

  const modal = document.getElementById('batch-modal');
  const close = () => modal.remove();
  document.getElementById('batch-close').addEventListener('click', close);
  document.getElementById('batch-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Populate exam select
  const examSelect = document.getElementById('batch-exam');
  examSelect.innerHTML = Data.metadata.exams
    .map(ex => `<option value="${ex.id}">${escapeHtml(ex.label)} (${ex.questions.length} שאלות)</option>`)
    .join('');

  const READY = q => q.answer_confidence !== 'uncertain' && q.answer_confidence !== 'unknown';
  const SIZES = [
    { v: 5,  label: '5 שאלות (מהיר)' },
    { v: 10, label: '10 שאלות' },
    { v: 15, label: '15 שאלות' },
    { v: 20, label: '20 שאלות' },
    { v: 30, label: '30 שאלות (אתגר)' },
    { v: 50, label: '50 שאלות (מבחן ארוך)' },
  ];

  function updateAvailableSize() {
    const type = document.getElementById('batch-type').value;
    let pool, totalPool;
    if (type === 'exam') {
      const ex = Data.metadata.exams.find(e => e.id === examSelect.value);
      pool = ex ? ex.questions.filter(READY) : [];
      totalPool = ex ? ex.questions : [];
    } else if (type === 'review') {
      const rq = Progress.load(state.user.email, state.course?.id).reviewQueue || [];
      pool = Data.practiceQuestions().filter(q => rq.includes(q.id));
      totalPool = Data.allQuestions().filter(q => rq.includes(q.id));
    } else if (type === 'unanswered') {
      const seen = new Set(Progress.history(state.user.email, state.course?.id).map(a => a.questionId));
      pool = Data.practiceQuestions().filter(q => !seen.has(q.id));
      totalPool = Data.allQuestions().filter(q => !seen.has(q.id));
    } else {
      pool = Data.practiceQuestions();
      totalPool = Data.allQuestions();
    }

    const available = pool.length;
    const pending = totalPool.length - available;
    const sizeSelect = document.getElementById('batch-size');
    const prevVal = parseInt(sizeSelect.value, 10) || 20;

    // Standard sizes that fit + "כל X" when no exact standard match
    let html = '';
    let hasExact = false;
    for (const s of SIZES) {
      if (s.v < available) html += `<option value="${s.v}">${s.label}</option>`;
      else if (s.v === available) { html += `<option value="${s.v}">${s.label}</option>`; hasExact = true; }
    }
    if (!hasExact && available > 0) {
      html += `<option value="${available}">כל ${available} השאלות הזמינות</option>`;
    }
    if (!html) html = `<option value="0">אין שאלות זמינות</option>`;
    sizeSelect.innerHTML = html;

    // Keep previous if still fits, else auto-select all available
    if (prevVal <= available && sizeSelect.querySelector(`option[value="${prevVal}"]`)) {
      sizeSelect.value = String(prevVal);
    } else {
      sizeSelect.value = String(available);
    }

    // Info line about pending questions
    const infoEl = document.getElementById('batch-available-info');
    if (infoEl) {
      if (pending > 0) {
        infoEl.style.display = '';
        infoEl.innerHTML = `<span style="color:#9a3412;font-size:12px;display:flex;align-items:center;gap:4px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${available} שאלות זמינות (${pending} ממתינות לאישור תשובה)</span>`;
      } else {
        infoEl.style.display = 'none';
      }
    }
  }

  document.getElementById('batch-type').addEventListener('change', (e) => {
    document.getElementById('exam-row').style.display = e.target.value === 'exam' ? '' : 'none';
    updateAvailableSize();
  });
  examSelect.addEventListener('change', updateAvailableSize);
  updateAvailableSize(); // populate on open

  // Toggle for exam mode
  let examMode = false;
  const toggle = document.getElementById('exam-mode-toggle');
  toggle.addEventListener('click', () => {
    examMode = !examMode;
    toggle.classList.toggle('on', examMode);
  });

  document.getElementById('batch-start').addEventListener('click', () => {
    const size = parseInt(document.getElementById('batch-size').value, 10) || 20;
    const type = document.getElementById('batch-type').value;
    const timer = parseInt(document.getElementById('batch-timer').value, 10) || 0;

    let questions = [];
    if (type === 'random') {
      questions = pickRandomGrouped(Data.practiceQuestions(), size);
    } else if (type === 'exam') {
      const ex = Data.metadata.exams.find(e => e.id === examSelect.value);
      if (!ex) return;
      questions = pickRandomGrouped(ex.questions.filter(READY), size);
    } else if (type === 'review') {
      const rq = Progress.load(state.user.email, state.course?.id).reviewQueue || [];
      const all = Data.practiceQuestions().filter(q => rq.includes(q.id));
      if (!all.length) {
        toast('אין שאלות בתור החזרה. תרגל קצת ואז חזור!', '');
        return;
      }
      questions = pickRandomGrouped(all, size);
    } else if (type === 'unanswered') {
      const seen = new Set(Progress.history(state.user.email, state.course?.id).map(a => a.questionId));
      const all = Data.practiceQuestions().filter(q => !seen.has(q.id));
      if (!all.length) {
        toast('עברת על כל השאלות! נסה מקבץ אקראי.', 'success');
        return;
      }
      questions = pickRandomGrouped(all, size);
    }

    if (!questions.length) { toast('אין שאלות לתרגול.', 'error'); return; }
    close();
    startQuiz({ questions, timerSeconds: timer, examMode });
  });
}

// ===== Quiz session =====
function startQuiz({ questions, timerSeconds, examMode }) {
  state.quiz = {
    questions,
    idx: 0,
    timerSeconds,
    timerStart: Date.now(),
    examMode: !!examMode,
    selections: {},
    revealed: {},
    correct: {},
    flagged: {},
    correctIdxByQ: {},
    questionStartedAt: {},
    timeUsed: {},
    batchId: 'b_' + Date.now(),
    startedAt: Date.now(),
  };
  // Announce the new batch to the cloud so the row exists even if the user
  // abandons mid-session. Non-blocking.
  const cid = state.course?.id;
  if (cid && cid !== 'tohna1') {
    Auth.getToken().then(token => {
      if (!token) return;
      fetch('/api/batches/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          id: state.quiz.batchId,
          courseId: cid,
          size: questions.length,
          examMode: !!examMode,
          qids: questions.map(q => q.id),
        }),
      }).catch(() => {});
    });
  }
  // Prefetch per-exam explanation shards in the background so reveal() is
  // instant. Non-blocking — the quiz can start rendering immediately.
  try { Data.prefetchExplanationsForQuestions(questions); } catch {}
  navigate(`/course/${state.course?.id || 'tohna1'}/quiz`);
}

let timerInterval = null;

function renderQuiz() {
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-quiz'));

  const q = state.quiz.questions[state.quiz.idx];
  const ap = Data.publicMeta(q.id);
  const total = state.quiz.questions.length;
  const cur = state.quiz.idx + 1;

  document.getElementById('quiz-progress-label').textContent = `שאלה ${cur} / ${total}`;
  document.getElementById('quiz-progress-fill').style.width = Math.round((cur / total) * 100) + '%';
  const exam = Data.metadata.exams.find(e => e.id === q.examId);
  document.getElementById('quiz-exam-label').textContent = exam ? exam.label : 'תוכנה 1';
  document.getElementById('quiz-q-num').innerHTML = `שאלה ${cur}<small>${exam ? ' · ' + escapeHtml(exam.label) : ''}</small>`;

  // Image — or AI text/code stem
  const imgEl = document.getElementById('quiz-image');
  const wrap = imgEl.parentElement;
  if (q._isAi) {
    // Replace image with a text/code panel (also removes any overlay button inside)
    wrap.innerHTML = `
      <div class="ai-q-stem-card">
        <div class="ai-q-stem-text">${escapeHtml(q._stem || '')}</div>
        ${q._code ? `<pre class="ai-q-code"><code>${escapeHtml(q._code)}</code></pre>` : ''}
      </div>
    `;
  } else {
    // Restore image element if it was previously replaced
    if (!imgEl.isConnected) {
      wrap.innerHTML = '<img id="quiz-image" src="" alt="שאלה" />';
    }
    document.getElementById('quiz-image').src = Data.imageUrl(q.image);
  }

  // Set-context overlay button — shown on the image for grouped questions.
  // Replaces the old pill button; works for image-only, text-only, and both.
  document.getElementById('quiz-set-ctx-btn')?.remove();
  if (!q._isAi && ap.groupId && (ap.contextImagePath || ap.contextText)) {
    wrap.style.position = 'relative';
    const ctxBtn = document.createElement('button');
    ctxBtn.id = 'quiz-set-ctx-btn';
    ctxBtn.type = 'button';
    ctxBtn.title = 'הצג מידע לסט השאלות';
    ctxBtn.style.cssText = 'position:absolute;top:8px;left:8px;background:rgba(37,99,235,0.92);color:#fff;border:none;border-radius:20px;padding:4px 12px 4px 10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px;z-index:10;box-shadow:0 2px 6px rgba(0,0,0,0.25);';
    ctxBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> הקשר לסט`;
    ctxBtn.addEventListener('click', () => openSetContextModal(ap.contextImagePath, ap.contextText, ap.questionNumber || cur));
    wrap.appendChild(ctxBtn);
  }

  // Cross-page set: show the shared context (scenario/data table from an
  // earlier page) as an image ABOVE the question image. Only inlined for
  // cross-page members — same-page crops already include the context.
  const ctxImgUrl = (ap && ap.contextImagePath && String(ap.contextImagePath).startsWith('http') && ap.contextCrossPage)
    ? ap.contextImagePath : null;
  const existingCtxImg = document.getElementById('quiz-context-image-wrap');
  if (existingCtxImg) existingCtxImg.remove();
  if (ctxImgUrl && wrap && !q._isAi) {
    const ctxImgDiv = document.createElement('div');
    ctxImgDiv.id = 'quiz-context-image-wrap';
    ctxImgDiv.style.cssText = 'margin:0 0 10px;padding:8px;border:1px solid #c7d2fe;border-radius:10px;background:#eff6ff;';
    ctxImgDiv.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:#1e40af;margin-bottom:6px;direction:rtl;">מידע לסט השאלות (מעמוד קודם)</div>
      <img src="${ctxImgUrl}" alt="הקשר לסט" style="width:100%;display:block;border-radius:6px;" />
    `;
    wrap.parentElement.insertBefore(ctxImgDiv, wrap);
  }

  // Context panel — for questions that are part of a "set" sharing a passage/
  // diagram/data block. Click toggles; content is the same across all members
  // of the group so users can reference the set intro from any question.
  const ctxWrap = document.getElementById('quiz-context');
  const ctxToggle = document.getElementById('quiz-context-toggle');
  const ctxBody = document.getElementById('quiz-context-body');
  const ctxText = (ap && ap.contextText) ? ap.contextText : '';
  if (ctxWrap && ctxToggle && ctxBody) {
    if (ctxText && ctxText.trim().length > 0) {
      ctxWrap.classList.remove('hidden');
      ctxBody.innerHTML = renderSolutionText(ctxText);
      ctxBody.hidden = true;
      ctxToggle.setAttribute('aria-expanded', 'false');
      const label = ctxToggle.querySelector('.quiz-context-label');
      if (label) label.textContent = 'הקשר לשאלה — לחץ להצגה';
      ctxToggle.onclick = () => {
        const open = ctxBody.hidden;
        ctxBody.hidden = !open;
        ctxToggle.setAttribute('aria-expanded', String(open));
        if (label) label.textContent = open ? 'הקשר לשאלה — לחץ להסתרה' : 'הקשר לשאלה — לחץ להצגה';
      };
    } else {
      ctxWrap.classList.add('hidden');
    }
  }

  // Flag button
  const flagBtn = document.getElementById('btn-flag');
  flagBtn.classList.toggle('flagged', !!state.quiz.flagged[q.id]);
  flagBtn.textContent = state.quiz.flagged[q.id] ? '🚩 מסומן לחזרה' : '🚩 סמן לחזרה';
  flagBtn.addEventListener('click', () => {
    state.quiz.flagged[q.id] = !state.quiz.flagged[q.id];
    flagBtn.classList.toggle('flagged', state.quiz.flagged[q.id]);
    flagBtn.textContent = state.quiz.flagged[q.id] ? '🚩 מסומן לחזרה' : '🚩 סמן לחזרה';
    renderQuizNav();
  });

  // Answer buttons
  const ansBar = document.getElementById('quiz-answers');
  ansBar.innerHTML = '';
  const numOpts = ap.numOptions || 4;
  const labels = ap.optionLabels || [];
  const isBinary = numOpts === 2 && labels.length === 2;
  for (let i = 1; i <= numOpts; i++) {
    const btn = document.createElement('button');
    btn.className = 'quiz-ans';
    btn.dataset.idx = i;
    if (isBinary) {
      btn.classList.add('binary');
      btn.innerHTML = `<span>${escapeHtml(labels[i - 1])}</span>`;
    } else {
      btn.innerHTML = `<span class="num">${i}</span>${labels[i - 1] ? `<span>${escapeHtml(labels[i - 1])}</span>` : ''}`;
    }
    btn.addEventListener('click', () => selectAnswer(i));
    ansBar.appendChild(btn);
  }
  refreshAnswerVisual();

  // Reveal button — user clicks to see the solution. Hidden once revealed
  // (in practice mode) or always hidden in exam mode.
  const revealBtn = document.getElementById('btn-reveal');
  if (state.quiz.examMode || state.quiz.revealed[q.id]) {
    revealBtn.classList.add('hidden');
  } else {
    revealBtn.classList.remove('hidden');
    revealBtn.onclick = () => revealSolution();
  }

  // Nav buttons
  const prevBtn = document.getElementById('btn-prev');
  prevBtn.disabled = state.quiz.idx === 0;
  prevBtn.addEventListener('click', () => navQuiz(-1));
  document.getElementById('btn-next').addEventListener('click', () => navQuiz(1));
  document.getElementById('btn-quit').addEventListener('click', () => {
    if (confirm('לסיים את המקבץ? התקדמות תישמר.')) endQuiz();
  });

  // Timer
  const timerWrap = document.getElementById('quiz-timer-wrap');
  if (state.quiz.timerSeconds > 0) {
    timerWrap.classList.remove('hidden');
    startTimerTick();
  } else {
    timerWrap.classList.add('hidden');
  }

  // Track question start time
  if (!state.quiz.questionStartedAt[q.id]) state.quiz.questionStartedAt[q.id] = Date.now();

  // Show solution if already revealed (and not in exam mode). The per-exam
  // explanation shard may not be loaded yet on direct navigation — we fire the
  // fetch and re-render the panel when it arrives.
  if (state.quiz.revealed[q.id] && !state.quiz.examMode) {
    showSolutionPanel(q);
    if (q.examId && !Data.explanations?.[q.id]) {
      Data.ensureExplanationsForExam(q.examId).then(() => {
        // Only re-render if we're still on this question
        if (state.quiz && state.quiz.questions[state.quiz.idx]?.id === q.id) {
          showSolutionPanel(q);
        }
      }).catch(() => {});
    }
  }

  renderQuizNav();
}

function refreshAnswerVisual() {
  const q = state.quiz.questions[state.quiz.idx];
  const sel = state.quiz.selections[q.id];
  const revealed = state.quiz.revealed[q.id] && !state.quiz.examMode;
  const correctIdx = state.quiz.correctIdxByQ[q.id];
  document.querySelectorAll('.quiz-ans').forEach(b => {
    const i = parseInt(b.dataset.idx, 10);
    b.classList.remove('selected', 'correct', 'wrong');
    if (sel === i) b.classList.add('selected');
    if (revealed) {
      if (correctIdx === i) b.classList.add('correct');
      else if (sel === i && correctIdx !== i) b.classList.add('wrong');
    }
  });
}

function renderQuizNav() {
  const grid = document.getElementById('quiz-nav-grid');
  grid.innerHTML = '';
  state.quiz.questions.forEach((qq, i) => {
    const cell = document.createElement('div');
    cell.className = 'nav-cell';
    cell.textContent = i + 1;
    if (i === state.quiz.idx) cell.classList.add('current');
    else if (state.quiz.revealed[qq.id] && !state.quiz.examMode) {
      const c = state.quiz.correct[qq.id];
      cell.classList.add(c ? 'correct' : 'wrong');
    } else if (state.quiz.selections[qq.id] != null) {
      cell.classList.add('answered');
    }
    if (state.quiz.flagged[qq.id]) cell.classList.add('flagged');
    cell.addEventListener('click', () => jumpToQuestion(i));
    grid.appendChild(cell);
  });
}

async function jumpToQuestion(target) {
  if (target === state.quiz.idx) return;
  // Auto-save if needed
  saveCurrentSelectionAsAttempt();
  state.quiz.idx = target;
  renderQuiz();
}

function selectAnswer(i) {
  const q = state.quiz.questions[state.quiz.idx];
  if (state.quiz.revealed[q.id] && !state.quiz.examMode) return;
  state.quiz.selections[q.id] = i;
  refreshAnswerVisual();
  renderQuizNav();
  // Do NOT auto-reveal. User must explicitly click "הצג פתרון" to see the solution.
  // This prevents giving away whether the answer was correct before the user
  // is ready to see it — useful for self-testing and exam simulation.
}

async function revealSolution() {
  if (state.quiz.examMode) return; // disabled in exam mode
  const q = state.quiz.questions[state.quiz.idx];
  if (state.quiz.revealed[q.id]) return;
  // Ensure the per-exam explanation shard is loaded. The background prefetch
  // at quiz start usually covers this, so the await resolves instantly from
  // cache; on the first click it may wait ~100ms for the network.
  try { await Data.ensureExplanationsForExam(q.examId); } catch {}
  const data = Data.reveal(q.id);
  state.quiz.revealed[q.id] = true;
  state.quiz.correctIdxByQ[q.id] = data.correctIdx;
  const sel = state.quiz.selections[q.id];
  // If correct answer is unknown (null), don't penalize — mark as correct by default
  const answerKnown = data.correctIdx != null;
  state.quiz.correct[q.id] = answerKnown ? sel === data.correctIdx : true;
  refreshAnswerVisual();
  showSolutionPanel(q);
  renderQuizNav();
  // Save attempt
  const tsec = Math.round((Date.now() - state.quiz.questionStartedAt[q.id]) / 1000);
  state.quiz.timeUsed[q.id] = tsec;
  Progress.recordAttempt(state.user.email, {
    questionId: q.id,
    selectedIdx: sel ?? null,
    isCorrect: state.quiz.correct[q.id],
    revealed: true,
    timeSeconds: tsec,
    batchId: state.quiz.batchId,
  }, state.course?.id);
}

function showSolutionPanel(q, dataParam) {
  const panel = document.getElementById('solution-panel');
  panel.classList.remove('hidden');
  const data = dataParam || Data.reveal(q.id);
  const ap = Data.publicMeta(q.id);
  const exp = data.explanation;
  const exam = Data.metadata.exams.find(e => e.id === q.examId);
  const labels = ap.optionLabels || [];
  const numOpts = ap.numOptions || 4;
  const userSel = state.quiz.selections[q.id];

  let html = '';
  if (exam) html += `<div class="solution-source">📍 ${escapeHtml(exam.label)} · שאלה ${escapeHtml(q.section)}</div>`;
  if (data.topic) html += `<div class="solution-topic">📌 ${escapeHtml(data.topic)}</div>`;
  // If the instructor's own solution text is rich enough, show it verbatim
  // (we skip AI-generated explanations for these questions on the server).
  if (data.instructorSolutionText && data.hasRichSolution) {
    html += `<div class="solution-general solution-instructor"><strong>פתרון המרצה:</strong>${renderSolutionText(data.instructorSolutionText)}</div>`;
  } else if (exp?.general) {
    html += `<div class="solution-general"><strong>הסבר כללי:</strong>${renderSolutionText(exp.general)}</div>`;
  }
  for (let i = 1; i <= numOpts; i++) {
    const isCorrect = i === data.correctIdx;
    const isUserSel = userSel === i;
    const optExp = (exp?.options || []).find(o => o.idx === i);
    const labelTxt = labels[i - 1] || `אפשרות ${i}`;
    const expTxt = optExp?.explanation || (isCorrect ? 'זו התשובה הנכונה.' : 'זו אינה התשובה הנכונה.');
    const cls = ['opt-explain', isCorrect ? 'correct' : 'wrong'];
    if (isUserSel) cls.push('user-selected');
    html += `
      <div class="${cls.join(' ')}">
        <span class="opt-num">${i}.</span><span class="opt-label">${escapeHtml(labelTxt)}${isUserSel && !isCorrect ? ' — הבחירה שלך' : ''}${isUserSel && isCorrect ? ' ← הבחירה הנכונה שלך!' : ''}</span>
        <div>${renderSolutionText(expTxt)}</div>
      </div>
    `;
  }
  if (data.correctIdx == null) {
    html += `<p class="muted" style="margin-top:12px;">⚠️ התשובה הנכונה לא זוהתה אוטומטית. ודא שקובץ הפתרון מסומן בצהוב.</p>`;
  } else if (!exp) {
    html += `<p class="muted" style="margin-top:12px;">הסבר מפורט לשאלה זו טרם נכתב.</p>`;
  }
  document.getElementById('solution-content').innerHTML = html;
}

function saveCurrentSelectionAsAttempt() {
  const q = state.quiz.questions[state.quiz.idx];
  const sel = state.quiz.selections[q.id];
  if (sel == null) return;
  if (state.quiz.revealed[q.id]) return; // already saved
  const data = Data.reveal(q.id);
  state.quiz.correctIdxByQ[q.id] = data.correctIdx;
  const answerKnown = data.correctIdx != null;
  state.quiz.correct[q.id] = answerKnown ? sel === data.correctIdx : true;
  state.quiz.revealed[q.id] = true; // mark internally as decided
  const tsec = Math.round((Date.now() - state.quiz.questionStartedAt[q.id]) / 1000);
  state.quiz.timeUsed[q.id] = tsec;
  Progress.recordAttempt(state.user.email, {
    questionId: q.id,
    selectedIdx: sel,
    isCorrect: state.quiz.correct[q.id],
    revealed: false,
    timeSeconds: tsec,
    batchId: state.quiz.batchId,
  }, state.course?.id);
}

function navQuiz(delta) {
  saveCurrentSelectionAsAttempt();
  const newIdx = state.quiz.idx + delta;
  if (newIdx < 0) return;
  if (newIdx >= state.quiz.questions.length) return endQuiz();
  state.quiz.idx = newIdx;
  renderQuiz();
}

function startTimerTick() {
  if (timerInterval) clearInterval(timerInterval);
  const total = state.quiz.timerSeconds;
  const start = state.quiz.timerStart;
  const wrap = document.getElementById('quiz-timer-wrap');
  function tick() {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const remain = Math.max(0, total - elapsed);
    const mm = Math.floor(remain / 60);
    const ss = remain % 60;
    const el = document.getElementById('quiz-timer');
    if (!el) { clearInterval(timerInterval); return; }
    el.textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
    if (remain < 60) wrap?.classList.add('danger'); else wrap?.classList.remove('danger');
    if (remain === 0) {
      clearInterval(timerInterval);
      toast('הזמן נגמר! עוברים לסיכום.', '');
      setTimeout(endQuiz, 800);
    }
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

function endQuiz() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  saveCurrentSelectionAsAttempt();

  // Compute final correctness for ALL questions (need to know in exam mode too)
  state.quiz.questions.forEach(qq => {
    if (state.quiz.correctIdxByQ[qq.id] == null) {
      const data = Data.reveal(qq.id);
      state.quiz.correctIdxByQ[qq.id] = data.correctIdx;
      const sel = state.quiz.selections[qq.id];
      state.quiz.correct[qq.id] = sel === data.correctIdx;
    }
  });

  let correct = 0, wrong = 0, revealed = 0, skipped = 0;
  for (const qq of state.quiz.questions) {
    if (state.quiz.selections[qq.id] == null) skipped++;
    else if (state.quiz.examMode) {
      // In exam mode, "revealed" doesn't apply mid-batch — count by correctness
      if (state.quiz.correct[qq.id]) correct++;
      else wrong++;
    } else if (state.quiz.revealed[qq.id] && state.quiz.timeUsed[qq.id] != null && !state.quiz.correct[qq.id]) {
      // Was revealed via the reveal button OR auto-saved as wrong
      if (state.quiz.correct[qq.id]) correct++;
      else wrong++;
    } else if (state.quiz.correct[qq.id]) {
      correct++;
    } else {
      wrong++;
    }
  }

  const batchSummary = {
    batchId: state.quiz.batchId,
    size: state.quiz.questions.length,
    correct, wrong, revealed, skipped,
    examMode: state.quiz.examMode,
    qids: state.quiz.questions.map(q => q.id),
    selections: { ...state.quiz.selections },
    correctIdxByQ: { ...state.quiz.correctIdxByQ },
    correctMap: { ...state.quiz.correct },
    startedAt: state.quiz.startedAt,
    endedAt: Date.now(),
  };
  Progress.saveBatch(state.user.email, batchSummary, state.course?.id);
  // Push final totals to the cloud so remote history shows the outcome.
  Progress.finalizeBatch(state.user.email, batchSummary, state.course?.id);
  // Next dashboard render must re-fetch from DB so the new attempts show up.
  Progress.invalidateSummary();
  state.lastBatch = batchSummary;
  navigate(`/course/${state.course?.id || 'tohna1'}/summary`);
}

// ===== Render: Summary =====
function renderSummary() {
  if (!state.lastBatch) return navigate('/dashboard');
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-summary'));

  const b = state.lastBatch;
  const cid = state.course?.id || 'tohna1';

  // Reconstruct questions array when coming from history (state.quiz not set).
  // Use questionsForCourse so user courses work, not just tohna1.
  const batchQuestions = state.quiz?.questions || (() => {
    const allQs = questionsForCourse(cid);
    const qMap = Object.fromEntries(allQs.map(q => [q.id, q]));
    return (b.qids || []).map(id => qMap[id]).filter(Boolean);
  })();

  const score = b.size > 0 ? Math.round((b.correct / b.size) * 100) : 0;
  document.getElementById('summary-score-num').textContent = score + '%';

  // Title based on score
  let title = 'מצוין!';
  if (score >= 90) title = 'מושלם!';
  else if (score >= 75) title = 'מצוין!';
  else if (score >= 60) title = 'יפה מאוד!';
  else if (score >= 40) title = 'יש מה לתרגל';
  else title = 'בוא נלמד מהטעויות';
  document.getElementById('summary-title').textContent = title;
  document.getElementById('summary-sub').textContent = `${b.correct} מתוך ${b.size} שאלות נכונות${b.examMode ? ' · מצב מבחן' : ''}`;

  document.getElementById('summary-stats').innerHTML = `
    <div class="stat-card success"><div class="label">נכון</div><div class="value">${b.correct}</div></div>
    <div class="stat-card danger"><div class="label">לא נכון</div><div class="value">${b.wrong}</div></div>
    <div class="stat-card warn"><div class="label">דילגתי</div><div class="value">${b.skipped}</div></div>
    <div class="stat-card brand"><div class="label">מספר שאלות</div><div class="value">${b.size}</div></div>
  `;

  // Pills
  const pillsEl = document.getElementById('summary-pills');
  pillsEl.innerHTML = '';
  batchQuestions.forEach((qq, i) => {
    const p = document.createElement('div');
    p.className = 'q-pill';
    if (b.selections[qq.id] == null) p.classList.add('skipped');
    else if (b.correctMap[qq.id]) p.classList.add('correct');
    else p.classList.add('wrong');
    p.textContent = i + 1;
    pillsEl.appendChild(p);
  });

  document.getElementById('btn-mistake-review').addEventListener('click', (e) => { e.preventDefault(); navigate(`/course/${cid}/review`); });
  document.getElementById('btn-summary-home').addEventListener('click', (e) => { e.preventDefault(); navigate(`/course/${cid}`); });

  // If no mistakes, hide review button
  if (b.wrong === 0 && b.skipped === 0) {
    document.getElementById('btn-mistake-review').style.display = 'none';
  }
}

// ===== Render: Mistake Review =====
function renderMistakeReview() {
  if (!state.lastBatch) return navigate('/dashboard');
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-review'));

  const b = state.lastBatch;
  const cid = state.course?.id || 'tohna1';
  // Reconstruct questions array when coming from history (state.quiz not set).
  // Use questionsForCourse so user courses work, not just tohna1.
  const batchQuestions = state.quiz?.questions || (() => {
    const allQs = questionsForCourse(cid);
    const qMap = Object.fromEntries(allQs.map(q => [q.id, q]));
    return (b.qids || []).map(id => qMap[id]).filter(Boolean);
  })();
  // Ensure explanations are loaded (may not be if coming from history)
  try { Data.prefetchExplanationsForQuestions(batchQuestions); } catch {}
  // Get all questions that were wrong or skipped
  const wrongQs = batchQuestions.filter(q => {
    const sel = b.selections[q.id];
    return sel == null || !b.correctMap[q.id];
  });

  if (!wrongQs.length) {
    const backRoute = `/course/${state.course?.id || 'tohna1'}`;
    $app.innerHTML = `<div class="loader-screen"><div><h2>אין טעויות לסקור! 🎉</h2><p style="margin-top:14px"><a href="#${backRoute}" class="btn btn-primary" data-route="${backRoute}">חזרה לקורס</a></p></div></div>`;
    document.querySelectorAll('[data-route]').forEach(link => {
      link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.getAttribute('data-route')); });
    });
    return;
  }

  let idx = 0;

  function renderOne() {
    const q = wrongQs[idx];
    const data = Data.reveal(q.id);
    const ap = Data.publicMeta(q.id);
    const labels = ap.optionLabels || [];
    const numOpts = ap.numOptions || 4;
    const sel = b.selections[q.id];
    const correctIdx = data.correctIdx ?? (b.correctIdxByQ?.[q.id]);
    const exam = Data.metadata?.exams?.find(e => e.id === q.examId);
    const exp = data.explanation;

    document.getElementById('review-pos').textContent = `שאלה ${idx + 1} מתוך ${wrongQs.length}`;
    document.getElementById('review-sub').textContent = sel == null ? 'שאלה שדילגת עליה' : 'שאלה שטעית בה';

    const yourLabel = sel == null ? 'דילגת' : (labels[sel - 1] || `אפשרות ${sel}`);
    const correctLabel = correctIdx != null ? (labels[correctIdx - 1] || `אפשרות ${correctIdx}`) : '—';

    let html = `
      <div class="review-question-card">
        <div class="review-meta">
          ${exam ? `<span class="review-meta-pill exam">${escapeHtml(exam.label)} · שאלה ${escapeHtml(q.section)}</span>` : ''}
          ${data.topic ? `<span class="review-meta-pill topic">${escapeHtml(data.topic)}</span>` : ''}
          <span class="review-meta-pill wrong">${sel == null ? '⏭ דילגת' : '✕ טעות'}</span>
        </div>
        <div class="review-image">
          <img src="${Data.imageUrl(q.image)}" alt="שאלה" />
        </div>
        <div class="review-answer-summary">
          <div class="review-answer-box your-wrong">
            <div class="label">${sel == null ? 'דילגת על השאלה' : 'הבחירה שלך'}</div>
            <div class="value">${escapeHtml(yourLabel)}</div>
            <div class="value-sub">${sel == null ? 'לא בחרת תשובה' : `בחרת באפשרות ${sel}`}</div>
          </div>
          <div class="review-answer-box correct">
            <div class="label">התשובה הנכונה</div>
            <div class="value">${escapeHtml(correctLabel)}</div>
            <div class="value-sub">אפשרות ${correctIdx}</div>
          </div>
        </div>

        <div class="review-explanation">
          <h4>הסבר מפורט</h4>
          ${exp?.general ? `<div class="general">${renderSolutionText(exp.general)}</div>` : ''}
          <div class="review-options">
            <h5>הסבר לכל אופציה:</h5>
    `;
    for (let i = 1; i <= numOpts; i++) {
      const isCorrect = i === correctIdx;
      const isUserSel = sel === i;
      const optExp = (exp?.options || []).find(o => o.idx === i);
      const labelTxt = labels[i - 1] || `אפשרות ${i}`;
      const expTxt = optExp?.explanation || (isCorrect ? 'זו התשובה הנכונה.' : 'זו אינה התשובה הנכונה.');
      const cls = ['opt-explain', isCorrect ? 'correct' : 'wrong'];
      if (isUserSel) cls.push('user-selected');
      html += `
        <div class="${cls.join(' ')}">
          <span class="opt-num">${i}.</span><span class="opt-label">${escapeHtml(labelTxt)}${isUserSel && !isCorrect ? ' — הבחירה שלך' : ''}</span>
          <div>${renderSolutionText(expTxt)}</div>
        </div>
      `;
    }
    if (!exp) html += `<p class="muted">הסבר מפורט לשאלה זו טרם נכתב.</p>`;
    html += '</div></div></div>';

    document.getElementById('review-content').innerHTML = html;

    document.getElementById('review-prev').disabled = idx === 0;
    document.getElementById('review-next').disabled = idx === wrongQs.length - 1;
  }

  document.getElementById('review-prev').addEventListener('click', () => { if (idx > 0) { idx--; renderOne(); } });
  document.getElementById('review-next').addEventListener('click', () => { if (idx < wrongQs.length - 1) { idx++; renderOne(); } });
  document.getElementById('review-back').addEventListener('click', () => navigate(`/course/${state.course?.id || 'tohna1'}`));

  renderOne();
}

// ===== Synthetic mock-exam generator =====
// Builds a weighted, realistic practice exam from the existing course bank.
// Modes:
//   balanced — distribute questions across topics by frequency
//   hard     — only the hardest questions in the bank
//   weak     — only topics where the user has struggled
//   recent   — topics the user hasn't seen in a while
function buildMockExam(courseId, opts) {
  const { size = 20, style = 'balanced' } = opts || {};
  const uid = state.user.email;
  const questions = questionsForCourse(courseId);
  const attempts = attemptsForCourse(uid, courseId);
  const analysis = analyzeQuestionBank(questions, attempts);

  if (!questions.length) return [];

  if (style === 'hard') {
    const hard = identifyHardQuestions(questions, attempts, size * 2);
    return pickRandomGrouped(hard.map(h => h.q), size);
  }

  if (style === 'weak') {
    const weakBuckets = analysis.filter(b => b.accuracy != null && b.accuracy < 0.6);
    if (!weakBuckets.length) {
      // Fallback to hard if user has no weak buckets yet
      return buildMockExam(courseId, { size, style: 'hard' });
    }
    const pool = weakBuckets.flatMap(b => b.qids);
    const poolQs = questions.filter(q => pool.includes(q.id));
    return pickRandomGrouped(poolQs, size);
  }

  if (style === 'recent') {
    // Topics the user hasn't attempted in 7+ days, or never
    const lastSeenByQ = new Map();
    for (const a of attempts) {
      const prev = lastSeenByQ.get(a.questionId) || 0;
      if (a.ts > prev) lastSeenByQ.set(a.questionId, a.ts);
    }
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stale = questions.filter(q => {
      const t = lastSeenByQ.get(q.id);
      return !t || t < sevenDaysAgo;
    });
    return pickRandomGrouped(stale.length ? stale : questions, size);
  }

  // BALANCED: distribute slots across topic buckets proportionally to frequency
  const totalCount = analysis.reduce((s, b) => s + b.count, 0);
  if (totalCount === 0) return pickRandomGrouped(questions, size);
  const slots = analysis.map(b => ({
    bucket: b,
    target: Math.max(1, Math.round((b.count / totalCount) * size)),
  }));
  // Pick from each bucket
  const used = new Set();
  const picked = [];
  for (const slot of slots) {
    if (picked.length >= size) break;
    const pool = slot.bucket.qids.filter(id => !used.has(id));
    const take = pickRandom(pool, slot.target);
    for (const qid of take) {
      used.add(qid);
      const q = questions.find(qq => qq.id === qid);
      if (q) picked.push(q);
      if (picked.length >= size) break;
    }
  }
  // Fill remainder if rounding left gaps
  if (picked.length < size) {
    const remaining = questions.filter(q => !used.has(q.id));
    picked.push(...pickRandom(remaining, size - picked.length));
  }
  // Ensure any question belonging to a group has its siblings included,
  // so grouped questions (sharing a diagram/passage) stay together.
  const pickedIds = new Set(picked.map(q => q.id));
  for (const q of [...picked]) {
    const gid = q.group_id || q.groupId;
    if (!gid) continue;
    for (const sibling of questions) {
      const sgid = sibling.group_id || sibling.groupId;
      if (sgid === gid && !pickedIds.has(sibling.id)) {
        picked.push(sibling);
        pickedIds.add(sibling.id);
      }
    }
  }
  // Final shuffle that preserves group rigidity
  return pickRandomGrouped(picked, picked.length);
}

// ===== Render: Insights =====
// Tracks which courses have already fired a topic-extraction call in this
// browser session so opening/closing Insights repeatedly doesn't thrash the
// Gemini labeler. The server still self-terminates (returns 0) when every
// question already has a topic, so this is just a UX-latency optimization.
const _insightsTopicRequested = new Set();

async function renderInsights() {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');
  if (!state.course) return navigate('/dashboard');

  await CourseRegistry.ensureLoaded();
  const _regCourse = CourseRegistry.get(state.course.id);
  if (_regCourse) state.course = _regCourse;

  await Data.ensureLoaded(state.course.id);
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-insights'));
  $app.firstElementChild?.classList.add('page-enter');
  wireTopbar();

  const uid = state.user.email;
  const courseId = state.course.id;
  let questions = questionsForCourse(courseId);
  let exams = examsForCourse(courseId);

  // AUTO TOPIC EXTRACTION: any cloud course (non-tohna1) where the user has
  // uploaded 3+ exams gets its questions labeled with canonical topic strings
  // before we compute insights. Without topics the analysis output is empty —
  // so we block until the labeler finishes, then re-enter this render with
  // populated data. Runs at most once per course per session.
  const isCloudCourse = String(courseId) !== 'tohna1';
  const missingTopicCount = isCloudCourse
    ? questions.filter(q => !(Data.reveal(q.id).topic)).length
    : 0;
  // Modelim plan never triggers AI topic extraction — they only see whatever
  // topics were baked into the template account during seeding.
  const skipAiTopics = state.user?.plan === 'modelim';
  if (!skipAiTopics && isCloudCourse && exams.length >= 3 && missingTopicCount > 0 && !_insightsTopicRequested.has(String(courseId))) {
    _insightsTopicRequested.add(String(courseId));
    const banner = document.getElementById('insights-banner');
    if (banner) {
      banner.className = 'insights-banner ok';
      banner.innerHTML = `<strong>מזהה נושאים אוטומטית…</strong> מנתח ${missingTopicCount} שאלות כדי לבנות את מפת הנושאים של "${escapeHtml(state.course.name)}". זה לוקח כ-15 שניות.`;
    }
    try {
      const token = await Auth.getToken();
      const res = await fetch('/api/ai/extract-topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ courseId }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.labeled > 0) {
          // Topics were just written to the DB — invalidate the course cache
          // so Data.ensureLoaded re-fetches with the new topic column values.
          Data._loadedSet.delete(courseId);
          delete Data._cache[courseId];
        }
      } else {
        console.warn('[insights] topic extraction HTTP', res.status);
      }
    } catch (e) {
      console.warn('[insights] topic extraction failed:', e?.message);
    }
    // Re-render with fresh data. The session flag we just set prevents
    // recursion (the next pass sees it and skips the auto-trigger branch).
    return renderInsights();
  }

  const attempts = attemptsForCourse(uid, courseId);
  const analysis = analyzeQuestionBank(questions, attempts);
  const hard = identifyHardQuestions(questions, attempts, 12);

  // Banner
  const minRecommended = 3;
  const banner = document.getElementById('insights-banner');
  const examCount = exams.length;
  if (examCount < minRecommended) {
    banner.className = 'insights-banner warn';
    banner.innerHTML = `<strong>הניתוח יעבוד טוב יותר עם יותר מבחנים.</strong> כרגע יש בקורס "${escapeHtml(state.course.name)}" רק <strong>${examCount}</strong> מבחנים. המלצה: לפחות <strong>${minRecommended}</strong> מבחנים שונים — ברגע שתעלה עוד, מפת הנושאים תיבנה אוטומטית.`;
  } else if (analysis.length === 0) {
    banner.className = 'insights-banner warn';
    banner.innerHTML = `<strong>${examCount} מבחנים</strong> בקורס "${escapeHtml(state.course.name)}" — אבל עדיין לא הצלחנו לזהות נושאי ליבה. ייתכן שחסר טקסט בשאלות (למשל סריקות ללא OCR). נסה לצור פתרונות AI לאחד המבחנים — זה מחלץ טקסט ומאפשר לנו לזהות דפוסים.`;
  } else {
    banner.className = 'insights-banner ok';
    banner.innerHTML = `<strong>${examCount} מבחנים</strong> בקורס "${escapeHtml(state.course.name)}" — מספיק כדי לזהות דפוסים אמיתיים. ${questions.length} שאלות נותחו · ${analysis.length} נושאי ליבה זוהו.`;
  }

  // Topic map — clean, color dots instead of emoji icons
  const topicMap = document.getElementById('topic-map');
  const maxCount = Math.max(...analysis.map(b => b.count), 1);
  topicMap.innerHTML = analysis.map(b => {
    const pct = Math.round((b.count / maxCount) * 100);
    const accPct = b.accuracy != null ? Math.round(b.accuracy * 100) : null;
    return `
      <div class="topic-row" style="--bar-color:${b.color}">
        <div class="topic-row-head">
          <span class="color-dot" style="--dot-color:${b.color}"></span>
          <span class="topic-name">${escapeHtml(b.name)}</span>
          <span class="topic-meta">${b.count} שאלות · ${b.examIds.length} מבחנים${accPct != null ? ` · דיוק שלך ${accPct}%` : ' · לא תרגלת'}</span>
        </div>
        <div class="topic-bar"><div class="topic-bar-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join('');

  // Focus areas — top 5 by focus score (no emoji icons, clean restrained typography)
  const focusList = [...analysis].sort((a, b) => b.focusScore - a.focusScore).slice(0, 5);
  const focusGrid = document.getElementById('focus-grid');
  focusGrid.innerHTML = focusList.map((b, i) => {
    const accPct = b.accuracy != null ? Math.round(b.accuracy * 100) : null;
    let reason = '';
    if (b.accuracy != null && b.accuracy < 0.6) reason = `אתה מסתבך כאן (${accPct}% הצלחה)`;
    else if (b.count >= 5) reason = `מופיע ב-${b.count} שאלות שונות`;
    else if (b.avgOptions >= 5) reason = `שאלות עם הרבה אופציות — קושי גבוה`;
    else reason = 'נושא מרכזי בקורס';
    return `
      <div class="focus-card" style="--accent:${b.color}">
        <div class="focus-rank">תעדוף #${i + 1}</div>
        <h3><span class="color-dot" style="--dot-color:${b.color}"></span> ${escapeHtml(b.name)}</h3>
        <p class="focus-reason">${escapeHtml(reason)}</p>
        <div class="focus-stats">
          <span><strong>${b.count}</strong> שאלות</span>
          <span><strong>${b.examIds.length}</strong> מבחנים</span>
          ${accPct != null ? `<span><strong>${accPct}%</strong> דיוק</span>` : '<span class="muted">לא תרגלת</span>'}
        </div>
        <button class="btn btn-soft btn-sm focus-practice" data-bucket="${b.id}">תרגל נושא זה →</button>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.focus-practice').forEach(btn => {
    btn.addEventListener('click', () => {
      const bucketId = btn.dataset.bucket;
      const bucket = analysis.find(b => b.id === bucketId);
      if (!bucket) return;
      const qs = questions.filter(q => bucket.qids.includes(q.id));
      const picked = pickRandom(qs, Math.min(qs.length, 15));
      startQuiz({ questions: picked, timerSeconds: 0, examMode: false });
    });
  });

  // Hard questions
  const hardList = document.getElementById('hard-q-list');
  hardList.innerHTML = hard.map((h, i) => {
    const exam = exams.find(e => e.id === h.q.examId);
    return `
      <div class="hard-q-row" data-qid="${h.q.id}">
        <div class="hard-q-num">${i + 1}</div>
        <div class="hard-q-thumb"><img src="${Data.imageUrl(h.q.image)}" alt="thumbnail" loading="lazy" /></div>
        <div class="hard-q-info">
          <div class="hard-q-title">${escapeHtml(h.topic || 'שאלה')}</div>
          <div class="hard-q-meta">
            ${exam ? `<span>${escapeHtml(exam.label)}</span>` : ''}
            <span>${h.numOpts} אופציות</span>
            ${h.reasons.map(r => `<span class="reason-pill">${escapeHtml(r)}</span>`).join('')}
          </div>
        </div>
        <button class="btn btn-soft btn-sm hard-q-practice">תרגל →</button>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.hard-q-practice').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      const q = hard[i].q;
      startQuiz({ questions: [q], timerSeconds: 0, examMode: false });
    });
  });

  document.getElementById('btn-practice-hard').addEventListener('click', () => {
    startQuiz({ questions: hard.map(h => h.q), timerSeconds: 0, examMode: false });
  });
}

// ===== Render: Exam Review (awaiting_review) =====
// Side-by-side screen shown for exams with status='awaiting_review'.
// Lists every question that Gemini flagged as unknown/uncertain; the user
// picks the correct answer (PATCH correct_idx → answer_confidence=manual)
// and then clicks "סיים סקירה" to promote the exam to 'ready'.
async function renderExamReview(courseId, examId) {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');
  if (!state.course || String(state.course.id) !== String(courseId)) setCourseContext(courseId);

  $app.innerHTML = `
    <div class="container" style="padding:20px 16px 60px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
        <button class="btn btn-soft btn-sm" data-route="/course/${courseId}" type="button">← חזרה לקורס</button>
        <h1 style="margin:0;font-size:20px;">סקירת מבחן</h1>
      </div>
      <div id="exr-body"><p class="muted" style="padding:40px;text-align:center;">טוען...</p></div>
    </div>
  `;

  const bodyEl = document.getElementById('exr-body');
  const tk = await Auth.getToken();
  if (!tk) { bodyEl.innerHTML = '<p class="muted" style="text-align:center;padding:40px;">נדרש להתחבר.</p>'; return; }

  // Fetch exam + questions in parallel.
  let exam, allQs;
  try {
    const [examRes, qRes] = await Promise.all([
      fetch(`/api/courses/${courseId}/exams`, { headers: { Authorization: `Bearer ${tk}` } }),
      fetch(`/api/courses/${courseId}/questions`, { headers: { Authorization: `Bearer ${tk}` } }),
    ]);
    if (!examRes.ok || !qRes.ok) throw new Error('fetch failed');
    const exams = await examRes.json();
    const qs = await qRes.json();
    exam = (Array.isArray(exams) ? exams : []).find(e => String(e.id) === String(examId));
    allQs = (Array.isArray(qs) ? qs : []).filter(q => String(q.exam_id) === String(examId));
  } catch (err) {
    bodyEl.innerHTML = `<p class="muted" style="text-align:center;padding:40px;">שגיאה בטעינה: ${escapeHtml(err.message || String(err))}</p>`;
    return;
  }

  if (!exam) {
    bodyEl.innerHTML = '<p class="muted" style="text-align:center;padding:40px;">מבחן לא נמצא.</p>';
    return;
  }

  // If the exam was already finalized, redirect back to course view.
  if (exam.status === 'ready') {
    toast('המבחן כבר אושר ומוכן לתרגול', 'success');
    navigate(`/course/${courseId}`);
    return;
  }

  const letters = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];
  const pending = allQs.filter(q => q.answer_confidence === 'unknown' || q.answer_confidence === 'uncertain');
  const total = allQs.length;
  const doneCount = total - pending.length;

  if (pending.length === 0) {
    // Nothing to review — offer to finalize immediately.
    renderReviewEmptyState(bodyEl, courseId, examId, total);
    return;
  }

  const headerHtml = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:14px 16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;">
      <div>
        <div style="font-weight:600;font-size:15px;color:#78350f;">${escapeHtml(exam.name || 'מבחן')}</div>
        <div style="font-size:13px;color:#92400e;margin-top:2px;">${pending.length} שאלות דורשות אישור · ${doneCount} מתוך ${total} מאושרות</div>
      </div>
      <button class="btn btn-primary" id="exr-finalize" type="button" disabled style="opacity:0.5;">סיים סקירה</button>
    </div>
  `;

  const cardsHtml = pending.map(q => renderReviewCard(q, letters)).join('');

  bodyEl.innerHTML = `
    <div id="exr-header">${headerHtml}</div>
    <div id="exr-cards" style="display:flex;flex-direction:column;gap:14px;">${cardsHtml}</div>
  `;

  // Wire save buttons for each pending card.
  pending.forEach(q => {
    const card = document.querySelector(`[data-exr-qid="${q.id}"]`);
    if (!card) return;
    const saveBtn = card.querySelector('.exr-save-btn');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', () => saveReviewAnswer(courseId, examId, total, q, card));
  });

  // Finalize button — updated live as cards are approved.
  document.getElementById('exr-finalize').addEventListener('click', () => finalizeReviewAndGo(courseId, examId));
  updateFinalizeButtonState();
}

// Swap the review body for the "all approved" empty-state — green banner
// with the big "סיים סקירה ופתח לתרגול" button. Called both on initial
// load when pending is already 0, and dynamically after the user approves
// the last remaining card (so the screen doesn't look stuck).
function renderReviewEmptyState(bodyEl, courseId, examId, total) {
  if (!bodyEl) return;
  bodyEl.innerHTML = `
    <div style="max-width:640px;margin:40px auto;padding:28px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:14px;text-align:center;">
      <h2 style="margin:0 0 10px;font-size:20px;color:#065f46;">כל השאלות מאושרות</h2>
      <p style="margin:0 0 18px;color:#065f46;">${total} שאלות עברו אימות. סיים סקירה כדי לפתוח את המבחן לתרגול.</p>
      <button class="btn btn-primary" id="exr-finalize" type="button" style="font-size:15px;padding:12px 28px;">סיים סקירה ופתח לתרגול</button>
    </div>
  `;
  document.getElementById('exr-finalize').addEventListener('click', () => finalizeReviewAndGo(courseId, examId));
}

// Heuristic: text layer extraction mangles LaTeX/math PDFs (CID font encoding).
// Detect obvious garbage so we can suppress it and rely on the image crop.
function looksGarbled(txt) {
  if (!txt || typeof txt !== 'string') return true;
  const s = txt.trim();
  if (s.length < 3) return true;
  // Unicode replacement char → definite corruption.
  if (s.indexOf('�') !== -1) return true;
  // Long runs of the same Latin letter (e.g. "RRRR", "MMMM") → CID font
  // duplication bug. Hebrew letters don't suffer this pattern.
  if (/([A-Za-z])\1{3,}/.test(s)) return true;
  // Heavy non-alphabetic ratio — likely symbol garbage.
  const letters = s.match(/[\p{L}]/gu)?.length || 0;
  if (letters > 0 && letters / s.length < 0.25) return true;
  return false;
}

function renderReviewCard(q, letters) {
  const numOptions = Math.max(2, Math.min(10, parseInt(q.num_options, 10) || 4));
  const currentIdx = parseInt(q.correct_idx, 10) || null;
  const isUncertain = q.answer_confidence === 'uncertain';
  const isUnknown = q.answer_confidence === 'unknown';
  const bgColor = isUnknown ? '#fef2f2' : '#fff7ed';
  const borderColor = isUnknown ? '#fecaca' : '#fed7aa';
  const badgeText = isUnknown ? 'תשובה לא זוהתה' : 'זיהוי לא ודאי';
  const badgeColor = isUnknown ? '#991b1b' : '#9a3412';

  // The image crop (when available) is the AUTHORITATIVE visual — math
  // formulas, RTL layout, everything. When we have it, skip the raw text
  // that unpdf extracted, which is often garbled for LaTeX PDFs.
  const imgSrc = q.image_path && q.image_path !== 'text-only'
    ? (q.image_path.startsWith('http') ? q.image_path : Data.imageUrl(q.image_path))
    : null;
  const hasImage = !!imgSrc;

  // Show question_text only when it's legible AND there's no image — image
  // alone is better than an image + mangled text duplicate.
  const stemHtml = (!hasImage && q.question_text && !looksGarbled(q.question_text))
    ? `<div style="margin-bottom:10px;font-size:14px;line-height:1.6;">${renderSolutionText(q.question_text)}</div>`
    : '';

  // Build options: when the image is shown, render just letter chips (א/ב/ג/ד)
  // so the user picks by letter. When there's no image, include the extracted
  // option text (but only if it's legible — otherwise fall back to letters).
  const optsMap = q.options_text || {};
  const showOptionTexts = !hasImage && Object.values(optsMap).every(t => !looksGarbled(String(t || '')));
  const optsHtml = Array.from({ length: numOptions }, (_, i) => {
    const idx = i + 1;
    const letter = letters[i] || String(idx);
    const txt = showOptionTexts ? (optsMap[idx] || optsMap[String(idx)] || '') : '';
    const checked = idx === currentIdx && !isUnknown ? 'checked' : '';
    const display = txt ? renderSolutionText(`${letter}. ${txt}`) : `<strong style="font-size:16px;">${letter}</strong>`;
    return `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid var(--border-soft);border-radius:8px;background:white;cursor:pointer;min-height:44px;">
        <input type="radio" name="exr-ans-${q.id}" value="${idx}" ${checked} />
        <div style="flex:1;font-size:14px;line-height:1.5;">${display}</div>
      </label>
    `;
  }).join('');

  const hintHtml = hasImage
    ? '<div style="margin-bottom:10px;font-size:12px;color:var(--text-muted);">קרא את השאלה מהתמונה ובחר את התשובה הנכונה.</div>'
    : '';

  return `
    <div class="exr-card" data-exr-qid="${q.id}" data-exr-conf="${q.answer_confidence}" style="padding:16px;background:${bgColor};border:1px solid ${borderColor};border-radius:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div style="font-weight:600;font-size:15px;">שאלה ${q.question_number}</div>
        <span style="font-size:12px;color:${badgeColor};font-weight:600;">${badgeText}</span>
      </div>
      ${imgSrc ? `<div style="margin-bottom:12px;border:1px solid var(--border-soft);border-radius:8px;overflow:hidden;background:white;"><img src="${escapeHtml(imgSrc)}" alt="שאלה ${q.question_number}" style="width:100%;display:block;" loading="lazy" /></div>` : ''}
      ${stemHtml}
      ${hintHtml}
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">${optsHtml}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button class="btn btn-primary btn-sm exr-save-btn" type="button">אשר תשובה</button>
      </div>
    </div>
  `;
}

async function saveReviewAnswer(courseId, examId, total, q, card) {
  const selected = card.querySelector(`input[name="exr-ans-${q.id}"]:checked`);
  if (!selected) { toast('בחר תשובה לפני השמירה', 'error'); return; }
  const newIdx = parseInt(selected.value, 10);
  const btn = card.querySelector('.exr-save-btn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.innerHTML = '<span class="qv-spinner"></span>';
  try {
    const tk = await Auth.getToken();
    const r = await fetch(`/api/courses/${courseId}/questions/${q.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ correct_idx: newIdx }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(data.error || 'שגיאה בשמירה', 'error');
      btn.disabled = false; btn.textContent = orig;
      return;
    }
    // Fade the card out of the pending list.
    card.style.transition = 'opacity .3s, height .3s, margin .3s';
    card.style.opacity = '0';
    setTimeout(() => {
      card.remove();
      // If this was the last card, swap the whole body to the empty-state
      // banner so the user sees the big finalize button immediately.
      const remaining = document.querySelectorAll('#exr-cards .exr-card').length;
      if (remaining === 0) {
        const bodyEl = document.getElementById('exr-body');
        renderReviewEmptyState(bodyEl, courseId, examId, total);
      } else {
        updateReviewProgress();
      }
    }, 300);
    toast('תשובה נשמרה', 'success', 1500);
  } catch (e) {
    toast('שגיאה בשמירה', 'error');
    btn.disabled = false; btn.textContent = orig;
  }
}

function updateReviewProgress() {
  const cardsContainer = document.getElementById('exr-cards');
  const remaining = cardsContainer ? cardsContainer.querySelectorAll('.exr-card').length : 0;
  const header = document.getElementById('exr-header');
  if (header) {
    const metaEl = header.querySelector('div > div:last-child');
    if (metaEl) {
      const current = metaEl.textContent.match(/(\d+) מתוך (\d+)/);
      if (current) {
        const total = parseInt(current[2], 10);
        metaEl.textContent = `${remaining} שאלות דורשות אישור · ${total - remaining} מתוך ${total} מאושרות`;
      }
    }
  }
  updateFinalizeButtonState();
}

function updateFinalizeButtonState() {
  const remaining = document.querySelectorAll('#exr-cards .exr-card').length;
  const btn = document.getElementById('exr-finalize');
  if (!btn) return;
  if (remaining === 0) {
    btn.disabled = false;
    btn.style.opacity = '1';
  } else {
    btn.disabled = true;
    btn.style.opacity = '0.5';
  }
}

async function finalizeReviewAndGo(courseId, examId) {
  const btn = document.getElementById('exr-finalize');
  if (btn) { btn.disabled = true; btn.textContent = 'שומר...'; }
  try {
    const tk = await Auth.getToken();
    const r = await fetch('/api/exams/finalize-review', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ exam_id: Number(examId) }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 409 && Array.isArray(data.pending_numbers)) {
        toast(`עדיין לא אושרו שאלות: ${data.pending_numbers.join(', ')}`, 'error', 6000);
      } else {
        toast(data.error || 'שגיאה בסגירת הסקירה', 'error');
      }
      if (btn) { btn.disabled = false; btn.textContent = 'סיים סקירה'; }
      return;
    }
    toast('המבחן אושר ומוכן לתרגול', 'success');
    await refreshCourseState(courseId);
    navigate(`/course/${courseId}`);
  } catch (e) {
    toast('שגיאה ברשת', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'סיים סקירה'; }
  }
}

// ===== Render: Lab =====
async function renderLab() {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');
  if (!state.course) return navigate('/dashboard');

  await CourseRegistry.ensureLoaded();
  const _regCourse = CourseRegistry.get(state.course.id);
  if (_regCourse) state.course = _regCourse;

  await Data.ensureLoaded(state.course.id);
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-lab'));
  $app.firstElementChild?.classList.add('page-enter');
  wireTopbar();

  const uid = state.user.email;
  const courseId = state.course.id;
  const questions = questionsForCourse(courseId);
  const exams = examsForCourse(courseId);
  const attempts = attemptsForCourse(uid, courseId);
  const analysis = analyzeQuestionBank(questions, attempts);

  // Lab card 1: Mock exam
  let mockMode = 'learn';
  let mockSource = 'existing';
  document.querySelectorAll('.mode-pill[data-mode]').forEach(p => {
    p.addEventListener('click', () => {
      mockMode = p.dataset.mode;
      const parent = p.closest('.lab-mode-pills');
      parent.querySelectorAll('.mode-pill').forEach(x => x.classList.toggle('active', x === p));
    });
  });
  document.querySelectorAll('.source-pill').forEach(p => {
    p.addEventListener('click', () => {
      mockSource = p.dataset.source;
      const parent = p.closest('.lab-mode-pills');
      parent.querySelectorAll('.source-pill').forEach(x => x.classList.toggle('active', x === p));
      refreshMockPreview();
    });
  });

  function refreshMockPreview() {
    const size = parseInt(document.getElementById('lab-mock-size').value, 10) || 20;
    const style = document.getElementById('lab-mock-style').value;
    const preview = document.getElementById('lab-mock-preview');
    const mockResult = document.getElementById('mock-ai-result');
    mockResult.innerHTML = '';

    if (mockSource === 'ai') {
      // Build topic distribution for AI preview
      const totalCount = analysis.reduce((s, b) => s + b.count, 0);
      const topBuckets = analysis.slice(0, 8).map(b => ({
        name: b.name,
        count: b.count,
        percentage: totalCount > 0 ? Math.round((b.count / totalCount) * 100) : 0,
      }));
      preview.innerHTML = `
        <div class="lab-preview-title">AI ייצור ${size} שאלות חדשות לפי התפלגות הנושאים:</div>
        <div class="lab-preview-buckets">
          ${topBuckets.map(b => `<span class="lab-preview-pill">${escapeHtml(b.name)} ${b.percentage}%</span>`).join('')}
        </div>
      `;
      return;
    }

    const sample = buildMockExam(courseId, { size, style });
    if (!sample.length) {
      preview.innerHTML = '<p class="muted">אין מספיק שאלות במצב הזה. נסה סגנון אחר.</p>';
      return;
    }
    const bucketCounts = new Map();
    for (const q of sample) {
      const bs = bucketsForTopic(Data.reveal(q.id).topic || '');
      for (const b of bs) bucketCounts.set(b.name, (bucketCounts.get(b.name) || 0) + 1);
    }
    const topBuckets = [...bucketCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    preview.innerHTML = `
      <div class="lab-preview-title">תצוגה מקדימה של המבחן (${sample.length} שאלות)</div>
      <div class="lab-preview-buckets">
        ${topBuckets.map(([name, n]) => `<span class="lab-preview-pill">${escapeHtml(name)} x${n}</span>`).join('')}
      </div>
    `;
  }
  document.getElementById('lab-mock-size').addEventListener('change', refreshMockPreview);
  document.getElementById('lab-mock-style').addEventListener('change', refreshMockPreview);
  refreshMockPreview();

  document.getElementById('btn-mock-start').addEventListener('click', async () => {
    const size = parseInt(document.getElementById('lab-mock-size').value, 10) || 20;
    const style = document.getElementById('lab-mock-style').value;
    const timer = parseInt(document.getElementById('lab-mock-timer').value, 10) || 0;

    // Existing questions mode
    if (mockSource === 'existing') {
      const sample = buildMockExam(courseId, { size, style });
      if (!sample.length) {
        toast('אין מספיק שאלות לבנייה. נסה סגנון אחר.', 'error');
        return;
      }
      startQuiz({ questions: sample, timerSeconds: timer, examMode: mockMode === 'exam' });
      return;
    }

    // AI generation mode
    const btn = document.getElementById('btn-mock-start');
    const mockResult = document.getElementById('mock-ai-result');
    btn.disabled = true;
    btn.innerHTML = '<span class="ai-spinner"></span> AI בונה מבחן דמה... 20-40 שניות';
    mockResult.innerHTML = '';

    // Build topic distribution from analysis
    const totalCount = analysis.reduce((s, b) => s + b.count, 0);
    const topicDistribution = analysis.slice(0, 10).map(b => ({
      name: b.name,
      count: b.count,
      percentage: totalCount > 0 ? Math.round((b.count / totalCount) * 100) : 0,
    }));

    // Build sample questions for style reference
    const sampleQuestions = questions.slice(0, 8).map(q => {
      const r = Data.reveal(q.id);
      const m = Data.publicMeta(q.id);
      return {
        topic: r.topic || '',
        stem: m.optionLabels ? `שאלה עם ${m.numOptions || 4} אופציות` : 'שאלה אמריקאית',
        options: m.optionLabels || [],
      };
    });

    try {
      const res = await fetch('/api/lab/generate-mock-exam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          size,
          courseName: state.course.name,
          topicDistribution,
          sampleQuestions,
          style,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.reason === 'no_api_key') {
          mockResult.innerHTML = `<div class="ai-error"><strong>מפתח ה-API של הבינה המלאכותית עוד לא מוגדר.</strong><p>הוסף GEMINI_API_KEY לסביבת הייצור.</p></div>`;
        } else {
          mockResult.innerHTML = `<div class="ai-error">${escapeHtml(data?.error || 'שגיאה לא ידועה')}</div>`;
        }
        return;
      }

      // Show preview of generated questions, then let user start
      const aiQuestions = data.questions;
      mockResult.innerHTML = `
        <div class="ai-success">${escapeHtml(data.examTitle || 'מבחן דמה')} — ${aiQuestions.length} שאלות מוכנות</div>
        <div class="ai-questions">
          ${aiQuestions.map((q, i) => renderAiQuestion(q, i)).join('')}
        </div>
        <div class="ai-actions">
          <button class="btn btn-primary btn-lg" id="btn-start-ai-mock">התחל מבחן דמה (${aiQuestions.length} שאלות)</button>
        </div>
      `;
      wireAiQuestionInteractivity(mockResult);
      document.getElementById('btn-start-ai-mock').addEventListener('click', () => {
        startAiQuiz(aiQuestions, timer, mockMode === 'exam');
      });
    } catch (err) {
      mockResult.innerHTML = `<div class="ai-error">שגיאת רשת: ${escapeHtml(err.message || String(err))}</div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>התחל מבחן דמה';
    }
  });

  // Lab card 2: AI generator
  document.getElementById('ai-exam-count').textContent = exams.length;
  const topicPicker = document.getElementById('lab-topic-picker');
  // Default-select the top 3 by focus score
  const sortedByFocus = [...analysis].sort((a, b) => b.focusScore - a.focusScore);
  const defaultSelected = new Set(sortedByFocus.slice(0, 3).map(b => b.id));
  topicPicker.innerHTML = sortedByFocus.map(b => `
    <button type="button" class="topic-chip ${defaultSelected.has(b.id) ? 'selected' : ''}" data-bucket="${b.id}" style="--accent:${b.color}">
      <span>${b.icon}</span> ${escapeHtml(b.name)}
    </button>
  `).join('');
  topicPicker.querySelectorAll('.topic-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const selectedCount = topicPicker.querySelectorAll('.topic-chip.selected').length;
      if (chip.classList.contains('selected')) {
        chip.classList.remove('selected');
      } else if (selectedCount < 5) {
        chip.classList.add('selected');
      } else {
        toast('אפשר לבחור עד 5 נושאים.', '');
      }
    });
  });

  document.getElementById('btn-ai-generate').addEventListener('click', async () => {
    const selected = [...topicPicker.querySelectorAll('.topic-chip.selected')].map(c => {
      const id = c.dataset.bucket;
      const b = analysis.find(x => x.id === id);
      return b ? b.name : id;
    });
    if (!selected.length) {
      toast('בחר לפחות נושא אחד.', 'error');
      return;
    }
    const count = parseInt(document.getElementById('lab-ai-count').value, 10) || 5;
    const difficulty = document.getElementById('lab-ai-difficulty').value;
    const btn = document.getElementById('btn-ai-generate');
    const result = document.getElementById('ai-result');
    btn.disabled = true;
    btn.innerHTML = '<span class="ai-spinner"></span> המודל עובד... זה לוקח 10-30 שניות';
    result.innerHTML = '';
    try {
      const labToken = await Auth.getToken();
      const res = await fetch('/api/lab/generate-questions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(labToken ? { Authorization: `Bearer ${labToken}` } : {}),
        },
        body: JSON.stringify({
          topics: selected,
          count,
          difficulty,
          courseName: state.course.name,
          language: 'he',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 402 && data?.type === 'lab_quota') {
          showPaywallModal('lab_quota');
          return;
        }
        if (data?.reason === 'no_api_key') {
          result.innerHTML = `
            <div class="ai-error">
              <strong>מפתח ה-API של הבינה המלאכותית עוד לא מוגדר בשרת.</strong>
              <p>כדי להפעיל את הפיצ'ר הזה, הוסף <code>GEMINI_API_KEY</code> לקובץ ה-.env של השרת ואז הפעל מחדש.</p>
            </div>
          `;
        } else {
          result.innerHTML = `<div class="ai-error">${escapeHtml(data?.error || 'שגיאה לא ידועה')}</div>`;
        }
        return;
      }
      // Render generated questions with delete buttons + interactive options.
      let aiPool = [...data.questions];
      // Persist this batch so it survives navigation / reload.
      const savedLabel = `${selected.join(', ')} · ${difficulty} · ${aiPool.length} שאלות`;
      AI_POOL_STORAGE.add(state.course.id, {
        label: savedLabel,
        topics: selected,
        difficulty,
        questions: aiPool,
      });
      function renderAiPool() {
        if (!aiPool.length) {
          result.innerHTML = '<div class="ai-error">הסרת את כל השאלות. צור שאלות חדשות.</div>';
          renderAiHistory();
          return;
        }
        result.innerHTML = `
          <div class="ai-success">${aiPool.length} שאלות מוכנות לתרגול</div>
          <div class="ai-questions">
            ${aiPool.map((q, i) => renderAiQuestion(q, i)).join('')}
          </div>
          <div class="ai-actions">
            <button class="btn btn-primary btn-lg" id="btn-practice-ai">תרגל ${aiPool.length} שאלות</button>
          </div>
        `;
        document.getElementById('btn-practice-ai').addEventListener('click', () => {
          startAiQuiz(aiPool);
        });
        // Wire delete buttons
        result.querySelectorAll('[data-remove-ai-q]').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.removeAiQ, 10);
            aiPool.splice(idx, 1);
            renderAiPool();
          });
        });
        // Wire interactive options + "הצג תשובה" button
        wireAiQuestionInteractivity(result);
        renderAiHistory();
      }
      renderAiPool();
    } catch (err) {
      result.innerHTML = `<div class="ai-error">❌ שגיאת רשת: ${escapeHtml(err.message || String(err))}</div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '✨ צור שאלות חכמות';
    }
  });

  // Render the persistent "previously-generated" panel at the bottom of the
  // Lab page on every visit.
  renderAiHistory();
}

function renderAiQuestion(q, i) {
  // Interactive preview: clickable options + "הצג תשובה" button. The correct
  // answer + explanation are hidden until the user clicks the button, so the
  // preview functions as a real practice item. wireAiQuestionInteractivity()
  // attaches the click handlers after the HTML is inserted.
  const diffLabel = q.difficulty === 'hard' ? 'קשה' : q.difficulty === 'medium' ? 'בינוני' : 'קל';
  const correctIdx = Number.isFinite(parseInt(q.correctIdx, 10)) ? parseInt(q.correctIdx, 10) : 1;
  return `
    <div class="ai-q-card" data-ai-q-idx="${i}" data-ai-correct="${correctIdx}">
      <div class="ai-q-head">
        <span class="ai-q-num">שאלה ${i + 1}</span>
        <span class="ai-q-topic">${escapeHtml(q.topic || '')}</span>
        <span class="ai-q-diff ai-q-diff-${q.difficulty}">${diffLabel}</span>
        <button class="ai-q-remove" data-remove-ai-q="${i}" title="הסר שאלה">✕</button>
      </div>
      ${q.code ? `<pre class="ai-q-code"><code>${escapeHtml(q.code)}</code></pre>` : ''}
      <div class="ai-q-stem">${escapeHtml(q.stem)}</div>
      <ol class="ai-q-options ai-q-options-interactive">
        ${q.options.map((opt, j) => `
          <li class="ai-q-opt" data-opt-idx="${j + 1}" role="button" tabindex="0" style="cursor:pointer;">
            <span class="opt-num">${j + 1}</span>
            <span>${escapeHtml(opt)}</span>
          </li>
        `).join('')}
      </ol>
      <div class="ai-q-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        <button class="btn btn-sm ai-q-reveal" type="button" data-ai-q-idx="${i}">הצג תשובה</button>
      </div>
      <div class="ai-q-solution" data-ai-q-idx="${i}" hidden style="margin-top:12px;padding:12px;border-radius:8px;background:#f0fdf4;border:1px solid #bbf7d0;direction:rtl;">
        <div style="font-weight:700;color:#166534;margin-bottom:8px;">התשובה הנכונה: ${correctIdx}</div>
        ${q.explanationGeneral ? `<div style="margin-bottom:10px;font-size:13px;line-height:1.5;">${escapeHtml(q.explanationGeneral)}</div>` : ''}
        ${Array.isArray(q.optionExplanations) && q.optionExplanations.length > 0 ? `
          <ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;">
            ${q.optionExplanations.map((e, j) => {
              const isCorr = (j + 1) === correctIdx;
              return `<li style="padding:6px 8px;border-radius:6px;background:${isCorr ? '#dcfce7' : '#fef2f2'};font-size:12px;">
                <strong>${j + 1}${isCorr ? ' (נכונה)' : ''}:</strong> ${escapeHtml(e || '')}
              </li>`;
            }).join('')}
          </ul>
        ` : ''}
      </div>
    </div>
  `;
}

// Wire interactivity to each AI question card in the given container.
// Option-click = select (only one option selected at a time).
// "הצג תשובה" = reveal correct + color-code all options.
function wireAiQuestionInteractivity(container) {
  if (!container) return;
  container.querySelectorAll('.ai-q-card').forEach(card => {
    const correctIdx = parseInt(card.getAttribute('data-ai-correct'), 10);
    const opts = card.querySelectorAll('.ai-q-opt');
    const selectOpt = (li) => {
      opts.forEach(o => {
        o.classList.remove('selected');
        o.style.background = '';
        o.style.border = '';
      });
      li.classList.add('selected');
      li.style.background = '#eff6ff';
      li.style.border = '1px solid #3b82f6';
    };
    opts.forEach(li => {
      li.addEventListener('click', () => selectOpt(li));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectOpt(li); }
      });
    });
    const revealBtn = card.querySelector('.ai-q-reveal');
    const solPanel = card.querySelector('.ai-q-solution');
    if (revealBtn && solPanel) {
      revealBtn.addEventListener('click', () => {
        const isHidden = solPanel.hidden;
        if (isHidden) {
          solPanel.hidden = false;
          revealBtn.textContent = 'הסתר תשובה';
          opts.forEach(li => {
            const idx = parseInt(li.getAttribute('data-opt-idx'), 10);
            if (idx === correctIdx) {
              li.style.background = '#dcfce7';
              li.style.border = '1px solid #16a34a';
            } else if (li.classList.contains('selected')) {
              li.style.background = '#fee2e2';
              li.style.border = '1px solid #dc2626';
            }
          });
        } else {
          solPanel.hidden = true;
          revealBtn.textContent = 'הצג תשובה';
          opts.forEach(li => {
            if (!li.classList.contains('selected')) {
              li.style.background = '';
              li.style.border = '';
            } else {
              li.style.background = '#eff6ff';
              li.style.border = '1px solid #3b82f6';
            }
          });
        }
      });
    }
  });
}

// ── Persistent storage for AI-generated question pools ───────────────────────
// User wants their generated questions preserved across navigations (and
// across reloads). We store per-course in localStorage.
const AI_POOL_STORAGE = {
  KEY(courseId) { return `ep_ai_lab_pool_${courseId}`; },
  load(courseId) {
    try { return JSON.parse(localStorage.getItem(this.KEY(courseId))) || []; }
    catch { return []; }
  },
  save(courseId, history) {
    try {
      // Cap at 50 entries total, each with up to ~15 questions.
      const trimmed = (history || []).slice(-50);
      localStorage.setItem(this.KEY(courseId), JSON.stringify(trimmed));
    } catch (e) {
      // Quota exceeded → drop oldest half and retry once.
      try {
        const half = (history || []).slice(Math.floor((history || []).length / 2));
        localStorage.setItem(this.KEY(courseId), JSON.stringify(half));
      } catch {}
    }
  },
  add(courseId, batch) {
    const history = this.load(courseId);
    history.push({ id: `b_${Date.now()}`, createdAt: Date.now(), ...batch });
    this.save(courseId, history);
    return history;
  },
  removeBatch(courseId, batchId) {
    const history = this.load(courseId).filter(b => b.id !== batchId);
    this.save(courseId, history);
    return history;
  },
};

// Render the "שאלות שיצרת לאחרונה" persistent panel at the bottom of the Lab
// page. Shows each previously-generated batch with a timestamp, a list of
// interactive cards (same UX as a fresh generation), a "תרגל מחדש" button,
// and a delete button. Survives navigation via localStorage.
function renderAiHistory() {
  const holder = document.getElementById('ai-history');
  if (!holder) return;
  const courseId = state.course?.id;
  if (!courseId) { holder.innerHTML = ''; return; }
  const history = AI_POOL_STORAGE.load(courseId);
  if (!Array.isArray(history) || history.length === 0) {
    holder.innerHTML = '<div class="muted" style="text-align:center;padding:12px 0;font-size:13px;">עוד לא יצרת שאלות במעבדה.</div>';
    return;
  }
  // Newest first.
  const sorted = [...history].reverse();
  const fmtDate = (ts) => {
    try {
      const d = new Date(ts);
      const diffMs = Date.now() - ts;
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) return 'עכשיו';
      if (mins < 60) return `לפני ${mins} דק׳`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `לפני ${hrs} שעות`;
      const days = Math.floor(hrs / 24);
      if (days < 7) return `לפני ${days} ימים`;
      return d.toLocaleDateString('he-IL');
    } catch { return ''; }
  };
  holder.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <h3 style="margin:0;font-size:15px;">שאלות שיצרת לאחרונה</h3>
      <button type="button" id="ai-history-clear" class="btn btn-ghost btn-sm" style="font-family:inherit;font-size:11px;">נקה הכל</button>
    </div>
    <div id="ai-history-list" style="display:flex;flex-direction:column;gap:12px;">
      ${sorted.map(batch => `
        <details class="ai-history-batch" data-batch-id="${batch.id}" style="border:1px solid var(--border-soft);border-radius:8px;padding:10px;background:var(--surface);">
          <summary style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <span style="font-weight:600;font-size:13px;">${escapeHtml(batch.label || `${(batch.questions || []).length} שאלות`)}</span>
            <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${fmtDate(batch.createdAt)}</span>
          </summary>
          <div class="ai-questions" data-batch-id="${batch.id}" style="margin-top:10px;">
            ${(batch.questions || []).map((q, i) => renderAiQuestion(q, i)).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm ai-history-practice" data-batch-id="${batch.id}" type="button">תרגל את השאלות (${(batch.questions || []).length})</button>
            <button class="btn btn-ghost btn-sm ai-history-delete" data-batch-id="${batch.id}" type="button" style="color:#dc2626;">מחק סט</button>
          </div>
        </details>
      `).join('')}
    </div>
  `;
  // Wire per-batch interactions.
  holder.querySelectorAll('details.ai-history-batch').forEach(det => {
    det.addEventListener('toggle', () => {
      if (det.open) {
        const qsWrap = det.querySelector('.ai-questions');
        if (qsWrap && !qsWrap.dataset.wired) {
          wireAiQuestionInteractivity(qsWrap);
          qsWrap.dataset.wired = '1';
        }
      }
    });
  });
  holder.querySelectorAll('.ai-history-practice').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-batch-id');
      const batch = AI_POOL_STORAGE.load(courseId).find(b => b.id === id);
      if (batch && Array.isArray(batch.questions) && batch.questions.length) startAiQuiz(batch.questions);
    });
  });
  holder.querySelectorAll('.ai-history-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-batch-id');
      AI_POOL_STORAGE.removeBatch(courseId, id);
      renderAiHistory();
    });
  });
  const clearBtn = holder.querySelector('#ai-history-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!confirm('לנקות את כל הסטים שיצרת במעבדה?')) return;
      AI_POOL_STORAGE.save(courseId, []);
      renderAiHistory();
    });
  }
}

// Wrap AI-generated questions into a quiz session
function startAiQuiz(aiQuestions, timerSeconds = 0, examMode = false) {
  // Inject into Data so the existing quiz UI can render them transparently
  Data._aiInjected = Data._aiInjected || {};
  const wrapped = aiQuestions.map((aq, i) => {
    const qid = `ai_${Date.now()}_${i}`;
    // Stash answers + explanation in the Data layer so reveal() works
    Data.answers[qid] = {
      numOptions: 4,
      optionLabels: aq.options,
      correctIdx: aq.correctIdx,
      topic: aq.topic,
    };
    Data.explanations[qid] = {
      general: aq.explanationGeneral,
      options: aq.optionExplanations.map((e, j) => ({
        idx: j + 1,
        isCorrect: j + 1 === aq.correctIdx,
        explanation: e,
      })),
    };
    Data._aiInjected[qid] = { stem: aq.stem, code: aq.code };
    return {
      id: qid,
      examId: '__ai__',
      section: String(i + 1),
      orderIdx: i + 1,
      image: null,
      _isAi: true,
      _stem: aq.stem,
      _code: aq.code,
    };
  });
  startQuiz({ questions: wrapped, timerSeconds, examMode });
}

// ===== Render: Progress =====
async function renderProgress() {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');
  if (!state.course) return navigate('/dashboard');

  await CourseRegistry.ensureLoaded();
  const _regCourse = CourseRegistry.get(state.course.id);
  if (_regCourse) state.course = _regCourse;

  await Data.ensureLoaded(state.course.id);
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-progress'));
  $app.firstElementChild?.classList.add('page-enter');
  wireTopbar();

  const uid = state.user.email;
  const courseId = state.course.id;
  const questions = questionsForCourse(courseId);
  const attempts = attemptsForCourse(uid, courseId);
  const batches = batchesForCourse(uid, courseId);
  const mastery = computeTopicMastery(questions, attempts);
  const streak = computeStreak(attempts);
  const time = computeTotalTime(attempts);
  const trend = computeAccuracyTrend(attempts);
  const tips = generateTips(questions, attempts, batches, mastery);

  // Header text
  document.getElementById('progress-greet').textContent = `היי ${state.user.name}, הנה איפה אתה עומד`;
  document.getElementById('progress-sub').textContent = `סקירה ריאליסטית של ההתקדמות שלך בקורס "${state.course.name}" — מה למדת, איפה אתה חזק, ומה צריך עבודה.`;

  // Hero stats
  const stats = Progress.stats(uid, courseId);
  const overallAcc = stats.total > 0 ? Math.round((stats.correct / Math.max(1, stats.unique)) * 100) : 0;
  const coverage = Math.round((stats.unique / Math.max(1, questions.length)) * 100);
  const heroEl = document.getElementById('progress-hero');
  heroEl.innerHTML = `
    <div class="progress-hero-main">
      <div class="ph-block">
        <div class="ph-num">${overallAcc}%</div>
        <div class="ph-label">דיוק כללי</div>
        <div class="ph-sub">${stats.correct} מתוך ${stats.unique} שאלות שראית</div>
      </div>
      <div class="ph-block">
        <div class="ph-num">${coverage}%</div>
        <div class="ph-label">כיסוי הבנק</div>
        <div class="ph-sub">${stats.unique} מתוך ${questions.length} שאלות בקורס</div>
      </div>
      <div class="ph-block">
        <div class="ph-num">${stats.total}</div>
        <div class="ph-label">סך תשובות</div>
        <div class="ph-sub">${batches.length} מקבצים שביצעת</div>
      </div>
      <div class="ph-block">
        <div class="ph-num">${stats.reviewCount}</div>
        <div class="ph-label">בתור החזרה</div>
        <div class="ph-sub">שאלות שכדאי לחזור עליהן</div>
      </div>
    </div>
    <div class="progress-hero-bar">
      <div class="phb-label">
        <span>כיסוי הקורס</span>
        <strong dir="ltr">${stats.unique} / ${questions.length}</strong>
      </div>
      <div class="phb-track"><div class="phb-fill" style="width:${coverage}%"></div></div>
    </div>
  `;

  // Streak
  document.getElementById('streak-block').innerHTML = `
    <div class="big-num">${streak.currentStreak}<small>ימים</small></div>
    <div class="meta-line">
      <span>שיא: <strong>${streak.longestStreak}</strong> ימים</span>
      <span>סה"כ פעיל: <strong>${streak.daysActive}</strong> ימים</span>
    </div>
    ${streak.currentStreak >= 1 ? '<div class="badge-good">רצף פעיל</div>' : '<div class="badge-warn">לא תרגלת היום</div>'}
  `;

  // Time
  const totalMin = Math.round(time.totalSeconds / 60);
  const totalH = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  document.getElementById('time-block').innerHTML = `
    <div class="big-num">${totalH > 0 ? `${totalH}<small>שע'</small> ${remMin}` : totalMin}<small>${totalH > 0 ? 'דק\'' : 'דקות'}</small></div>
    <div class="meta-line">
      <span>ממוצע: <strong>${time.avgPerQuestion}</strong> שניות לשאלה</span>
    </div>
  `;

  // Trend
  if (trend.trend == null) {
    document.getElementById('trend-block').innerHTML = `
      <div class="big-num muted">—</div>
      <div class="meta-line muted">תרגל לפחות 40 שאלות כדי לראות מגמה.</div>
    `;
  } else {
    const arrow = trend.trend > 0.05 ? '↗' : trend.trend < -0.05 ? '↘' : '→';
    const cls = trend.trend > 0.05 ? 'good' : trend.trend < -0.05 ? 'bad' : '';
    document.getElementById('trend-block').innerHTML = `
      <div class="big-num ${cls}">${arrow} ${Math.round(trend.recentAcc * 100)}%</div>
      <div class="meta-line">
        <span>20 אחרונות לעומת ה-20 שלפניהן: ${trend.trend > 0 ? '+' : ''}${Math.round(trend.trend * 100)}%</span>
      </div>
      ${trend.trend > 0.1 ? '<div class="badge-good">משתפר</div>' : trend.trend < -0.1 ? '<div class="badge-warn">ירידה</div>' : '<div class="badge-info">יציב</div>'}
    `;
  }

  // Mastery — modern data table with inline accuracy bars and status pills
  const masteryEl = document.getElementById('mastery-grid');
  masteryEl.className = 'data-table-wrap';
  const masteryRows = mastery.map(m => {
    const pct = m.mastery == null ? null : Math.round(m.mastery * 100);
    const cov = Math.round(m.coverage * 100);
    let level = 'unknown';
    if (m.mastery == null) level = 'unknown';
    else if (m.mastery >= 0.85) level = 'master';
    else if (m.mastery >= 0.65) level = 'good';
    else if (m.mastery >= 0.4) level = 'mid';
    else level = 'weak';
    const levelText = {
      master: 'שולט', good: 'טוב', mid: 'בסדר', weak: 'חלש', unknown: 'לא תרגלת',
    }[level];
    const barClass = level === 'master' || level === 'good' ? 'bar-good'
                   : level === 'mid' ? 'bar-mid'
                   : level === 'weak' ? 'bar-bad' : '';
    return `
      <tr>
        <td>
          <div class="row-title">
            <span class="color-dot" style="--dot-color:${m.color}"></span>
            ${escapeHtml(m.name)}
          </div>
          <div class="row-sub">${m.count} שאלות בקורס · ${m.attemptCount} ניסיונות</div>
        </td>
        <td class="num">${cov}%</td>
        <td>
          ${pct != null ? `
            <div class="bar-cell">
              <div class="bar-track"><div class="bar-fill ${barClass}" style="width:${pct}%"></div></div>
              <span class="bar-num">${pct}%</span>
            </div>
          ` : '<span class="muted">—</span>'}
        </td>
        <td><span class="status-pill s-${level}">${levelText}</span></td>
        <td class="col-action">
          <button class="btn-row mastery-practice" data-bucket="${m.id}">תרגל</button>
        </td>
      </tr>
    `;
  }).join('');
  masteryEl.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>נושא</th>
          <th>כיסוי</th>
          <th>דיוק</th>
          <th>סטטוס</th>
          <th class="col-action"></th>
        </tr>
      </thead>
      <tbody>${masteryRows}</tbody>
    </table>
  `;

  document.querySelectorAll('.mastery-practice').forEach(btn => {
    btn.addEventListener('click', () => {
      const bucketId = btn.dataset.bucket;
      const bucket = mastery.find(b => b.id === bucketId);
      if (!bucket) return;
      const qs = questions.filter(q => bucket.qids.includes(q.id));
      const picked = pickRandom(qs, Math.min(qs.length, 12));
      startQuiz({ questions: picked, timerSeconds: 0, examMode: false });
    });
  });

  // Recent batches — modern data table
  const recent = [...batches].reverse().slice(0, 10);
  const batchEl = document.getElementById('recent-batches');
  if (!recent.length) {
    batchEl.className = '';
    batchEl.innerHTML = '<div class="empty-state">עוד לא ביצעת מקבצי תרגול. תתחיל ממסך הבית.</div>';
  } else {
    batchEl.className = 'data-table-wrap';
    const rows = recent.map(b => {
      const score = Math.round((b.correct / Math.max(1, b.size)) * 100);
      const dt = new Date(b.endedAt || b.startedAt || Date.now());
      const dateStr = dt.toLocaleDateString('he-IL') + ' ' + dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      const barClass = score >= 80 ? 'bar-good' : score >= 60 ? 'bar-mid' : 'bar-bad';
      const statusClass = score >= 80 ? 's-good' : score >= 60 ? 's-mid' : 's-weak';
      const modeLabel = b.examMode ? 'מצב מבחן' : 'מצב למידה';
      const modePill = b.examMode ? 's-info' : 's-unknown';
      return `
        <tr class="batch-row-clickable" data-batch-idx="${recent.indexOf(b)}">
          <td>
            <div class="row-title">${dateStr}</div>
            <div class="row-sub">${b.size} שאלות · ${b.correct} נכון · ${b.wrong} שגוי</div>
          </td>
          <td><span class="status-pill ${modePill}">${modeLabel}</span></td>
          <td class="num">${b.correct}/${b.size}</td>
          <td>
            <div class="bar-cell">
              <div class="bar-track"><div class="bar-fill ${barClass}" style="width:${score}%"></div></div>
              <span class="bar-num">${score}%</span>
            </div>
          </td>
          <td><span class="status-pill ${statusClass}">${score >= 80 ? 'מעולה' : score >= 60 ? 'בסדר' : 'דורש עבודה'}</span></td>
        </tr>
      `;
    }).join('');
    batchEl.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>תאריך</th>
            <th>סוג</th>
            <th>נכון/סך</th>
            <th>ציון</th>
            <th>סטטוס</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    // Click on a batch row → open its summary/review
    batchEl.querySelectorAll('.batch-row-clickable').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.batchIdx, 10);
        const b = recent[idx];
        if (!b) return;
        state.lastBatch = b;
        navigate(`/course/${state.course?.id || 'tohna1'}/summary`);
      });
    });
  }

  // Tips
  const tipsEl = document.getElementById('tips-grid');
  if (!tips.length) {
    tipsEl.innerHTML = '<div class="empty-state">תרגל קצת ואחזור עם המלצות אישיות.</div>';
  } else {
    tipsEl.innerHTML = tips.map(t => `
      <div class="tip-card tone-${t.tone}">
        <div class="tip-icon" aria-hidden="true"></div>
        <div class="tip-body">
          <h4>${escapeHtml(t.title)}</h4>
          <p>${escapeHtml(t.body)}</p>
          ${t.cta ? `<button class="btn btn-soft btn-sm tip-cta" data-route="${escapeHtml(t.ctaRoute || '')}">${escapeHtml(t.cta)} →</button>` : ''}
        </div>
      </div>
    `).join('');
    document.querySelectorAll('.tip-cta').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.route;
        const tipCid = state.course?.id || 'tohna1';
        if (r === 'practice') showBatchModal();
        else if (r === 'insights') navigate(`/course/${tipCid}/insights`);
        else if (r === 'progress') navigate(`/course/${tipCid}/progress`);
      });
    });
  }
}

// ===== Shared topbar wiring =====
function wireTopbar(cid) {
  // cid: explicit course id (string/number). Pass null from renderDashboard (global).
  // If omitted/undefined, fall back to state.course?.id.
  const activeCid = cid !== undefined ? cid : (state.course?.id ?? null);

  // Show/hide course-only nav items based on whether we're inside a course.
  document.querySelectorAll('[data-course-nav="1"]').forEach(el => {
    el.style.display = activeCid ? '' : 'none';
  });

  if (activeCid) {
    const courseRouteMap = {
      '/insights': `/course/${activeCid}/insights`,
      '/lab': `/course/${activeCid}/lab`,
      '/progress': `/course/${activeCid}/progress`,
    };
    document.querySelectorAll('[data-route]').forEach(link => {
      let r = link.getAttribute('data-route');
      if (courseRouteMap[r]) {
        r = courseRouteMap[r];
        link.setAttribute('data-route', r);
        link.setAttribute('href', '#' + r);
      }
      if (!link.dataset.wired) {
        link.dataset.wired = '1';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          if (r) navigate(r);
        });
      }
    });
  } else {
    document.querySelectorAll('[data-route]').forEach(link => {
      if (!link.dataset.wired) {
        link.dataset.wired = '1';
        const r = link.getAttribute('data-route');
        link.addEventListener('click', (e) => {
          e.preventDefault();
          if (r) navigate(r);
        });
      }
    });
  }

  // Wire "המקבצים שלי" button — only visible when inside a course, not on the main dashboard.
  document.querySelectorAll('.topbar-batches-btn').forEach(btn => {
    btn.style.display = activeCid ? '' : 'none';
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showBatchesDropdown(btn);
    });
  });

  // User info
  const planEl = document.getElementById('user-plan');
  const nameEl = document.getElementById('user-name');
  const avatarEl = document.getElementById('user-avatar');
  if (nameEl) nameEl.textContent = state.user.name;
  if (avatarEl) avatarEl.textContent = (state.user.name || 'U').slice(0, 1).toUpperCase();
  if (planEl) {
    planEl.textContent = state.user.plan === 'modelim' ? 'מודלים חישוביים' : state.user.plan;
    if (state.user.plan === 'pro' || state.user.plan === 'education') planEl.classList.add('pro');
  }
  // The whole .app-user block is now a dropdown trigger; the in-template
  // logout button moves into the dropdown so we hide its inline copy.
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.style.display = 'none';
  wireUserMenu();
  // Mobile nav toggle
  const toggle = document.getElementById('topbar-mobile-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      document.querySelector('.app-topbar').classList.toggle('mobile-open');
    });
  }
}

// ===== Batches dropdown (topbar "המקבצים שלי") =====
// Floating panel showing the last 15 batches across ALL courses. Clicking a
// row navigates to that batch's summary page so the user can review questions
// or enter mistake review. Local batches from the current device render first
// (fast), remote batches merge in from Supabase when the fetch resolves.
function showBatchesDropdown(anchor) {
  const existing = document.getElementById('batches-dropdown');
  if (existing) {
    existing.remove();
    document.removeEventListener('click', existing._closer, true);
    document.querySelectorAll('.topbar-batches-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
    return;
  }
  document.querySelectorAll('.topbar-batches-btn').forEach(b => b.setAttribute('aria-expanded', 'true'));
  const activeCid = String(state.course?.id || '');
  const courses = CourseRegistry.list().filter(c => !c.archived && !c.is_degree);
  const courseName = (cid) => courses.find(c => String(c.id) === String(cid))?.name || cid;

  const dd = document.createElement('div');
  dd.id = 'batches-dropdown';
  dd.className = 'batches-dropdown';
  dd.innerHTML = `
    <div class="bd-header">מקבצים אחרונים — ${escapeHtml(state.course?.name || courseName(activeCid))}</div>
    <div class="bd-body" id="bd-body"><div class="bd-empty">טוען...</div></div>
  `;
  document.body.appendChild(dd);
  const r = anchor.getBoundingClientRect();
  dd.style.cssText += `position:fixed;top:${r.bottom + 6}px;right:${Math.max(8, window.innerWidth - r.right)}px;z-index:9999;`;
  // Only show batches for the course currently open; fall back to all if context missing
  const scopedCourses = activeCid ? courses.filter(c => String(c.id) === activeCid) : courses;

  function render(rows) {
    const body = document.getElementById('bd-body');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = `<div class="bd-empty">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-muted);margin-bottom:10px;"><rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="9 12 11 14 15 10"/></svg>
        <div style="font-weight:600;font-size:14px;color:var(--text);margin-bottom:6px;">עדיין לא ביצעת מקבצים</div>
        <div style="font-size:12px;color:var(--text-muted);line-height:1.6;">התחל מקבץ תרגול מהכרטיסייה "תרגול" כדי לעקוב אחר ההתקדמות שלך כאן.</div>
      </div>`;
      return;
    }
    body.innerHTML = rows.map((item, i) => {
      const b = item.batch;
      const score = b.size > 0 ? Math.round((b.correct / b.size) * 100) : 0;
      const cls = score >= 80 ? 'good' : score >= 60 ? 'mid' : 'bad';
      const date = b.endedAt ? new Date(b.endedAt).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      return `<button type="button" class="bd-row" data-i="${i}">
        <span class="bd-score ${cls}">${score}%</span>
        <span class="bd-info">
          <span class="bd-course">${escapeHtml(courseName(item.cid))}</span>
          <span class="bd-meta">${b.correct}/${b.size} · ${date}${b.examMode ? ' · מבחן' : ''}</span>
        </span>
        <svg class="bd-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>`;
    }).join('');
    body.querySelectorAll('.bd-row').forEach(row => {
      row.addEventListener('click', () => {
        const i = parseInt(row.dataset.i, 10);
        const item = rows[i];
        if (!item) return;
        close();
        if (!setCourseContext(item.cid)) return;
        state.lastBatch = item.batch;
        navigate(`/course/${item.cid}/summary`);
      });
    });
  }

  // 1) Fast path: local batches for the current course only
  const localRows = [];
  for (const c of scopedCourses) {
    const cid = String(c.id);
    const list = (Progress.load(state.user.email, cid).batches || []);
    for (const b of list) if (b?.batchId) localRows.push({ cid, batch: b });
  }
  localRows.sort((a, b) => (b.batch.endedAt || 0) - (a.batch.endedAt || 0));
  render(localRows.slice(0, 15));

  // 2) Merge remote (cloud-synced) batches on top of local
  Promise.all(scopedCourses.filter(c => String(c.id) !== 'tohna1').map(c =>
    Progress.fetchRemoteBatches(String(c.id), 15)
      .then(rows => (rows || []).map(b => ({ cid: String(c.id), batch: b })))
      .catch(() => [])
  )).then(results => {
    if (!document.getElementById('batches-dropdown')) return;
    const byId = new Map();
    for (const r of localRows) if (r.batch?.batchId) byId.set(r.batch.batchId, r);
    for (const arr of results) for (const r of arr) if (r.batch?.batchId) byId.set(r.batch.batchId, r);
    const merged = [...byId.values()].sort((a, b) => (b.batch.endedAt || 0) - (a.batch.endedAt || 0)).slice(0, 15);
    render(merged);
  });

  function close() {
    dd.remove();
    document.removeEventListener('click', closer, true);
    document.querySelectorAll('.topbar-batches-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  function closer(ev) {
    if (!dd.contains(ev.target) && !anchor.contains(ev.target)) close();
  }
  dd._closer = closer;
  setTimeout(() => document.addEventListener('click', closer, true), 0);
}

// ===== User dropdown menu =====
// Click on .app-user (the avatar block in the topbar) opens a floating menu
// with profile info, quick links, theme toggle, and logout. The dropdown is
// injected on demand and removed on close to keep the DOM clean across
// route navigations.
function wireUserMenu() {
  const userBlock = document.querySelector('.app-user');
  if (!userBlock || userBlock.dataset.menuWired) return;
  userBlock.dataset.menuWired = '1';
  userBlock.classList.add('app-user-clickable');
  // Add a chevron caret so it visually reads as a button
  if (!userBlock.querySelector('.app-user-caret')) {
    const caret = document.createElement('span');
    caret.className = 'app-user-caret';
    caret.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
    userBlock.appendChild(caret);
  }
  userBlock.addEventListener('click', (e) => {
    // Avoid opening when clicking the (now-hidden) inline logout button
    if (e.target.closest('#btn-logout')) return;
    e.stopPropagation();
    toggleUserMenu(userBlock);
  });
}

function toggleUserMenu(anchor) {
  const existing = document.getElementById('user-menu-pop');
  if (existing) { existing.remove(); return; }
  if (!state.user) return;

  const planLabel = state.user.plan === 'modelim'
    ? 'מודלים חישוביים'
    : (state.user.plan || 'free').toUpperCase();
  const themeMode = Theme.current();
  const themeResolved = Theme.resolved();
  const themeIcon = themeResolved === 'dark'
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';

  const pop = document.createElement('div');
  pop.id = 'user-menu-pop';
  pop.className = 'user-menu-pop';
  pop.innerHTML = `
    <div class="user-menu-head">
      <div class="user-menu-avatar">${(state.user.name || 'U').slice(0, 1).toUpperCase()}</div>
      <div class="user-menu-id">
        <div class="user-menu-name">${escapeHtml(state.user.name || 'משתמש')}</div>
        <div class="user-menu-email">${escapeHtml(state.user.email || '')}</div>
      </div>
      <span class="user-menu-plan ${state.user.plan === 'pro' || state.user.plan === 'education' ? 'is-pro' : ''}">${planLabel}</span>
    </div>
    <div class="user-menu-divider"></div>
    <a class="user-menu-item" href="#/settings" data-menu-route="/settings">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
      <span>הגדרות חשבון</span>
    </a>
    <a class="user-menu-item" href="#/settings?tab=plan" data-menu-route="/settings?tab=plan">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
      <span>תוכנית ומנוי</span>
    </a>
    <a class="user-menu-item" href="#/progress" data-menu-route="/progress">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
      <span>ההתקדמות שלי</span>
    </a>
    <button class="user-menu-item user-menu-theme-toggle" id="user-menu-theme-toggle" type="button">
      ${themeIcon}
      <span>${themeResolved === 'dark' ? 'מצב בהיר' : 'מצב כהה'}</span>
    </button>
    <div class="user-menu-divider"></div>
    <button class="user-menu-item user-menu-logout" id="user-menu-logout" type="button">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      <span>יציאה</span>
    </button>
  `;
  anchor.appendChild(pop);

  // Wire menu actions
  pop.querySelectorAll('[data-menu-route]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      pop.remove();
      navigate(link.getAttribute('data-menu-route'));
    });
  });
  pop.querySelector('#user-menu-theme-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    Theme.set(Theme.resolved() === 'dark' ? 'light' : 'dark');
    pop.remove();
  });
  pop.querySelector('#user-menu-logout').addEventListener('click', () => {
    Auth.clear();
    state.user = null;
    navigate('/');
  });

  // Close on outside click / Escape
  setTimeout(() => {
    document.addEventListener('click', closeUserMenuOnClickOutside, { once: true });
  }, 0);
  document.addEventListener('keydown', closeUserMenuOnEsc);
}

function closeUserMenuOnClickOutside(e) {
  const pop = document.getElementById('user-menu-pop');
  if (!pop) return;
  if (pop.contains(e.target)) {
    document.addEventListener('click', closeUserMenuOnClickOutside, { once: true });
    return;
  }
  pop.remove();
  document.removeEventListener('keydown', closeUserMenuOnEsc);
}
function closeUserMenuOnEsc(e) {
  if (e.key !== 'Escape') return;
  const pop = document.getElementById('user-menu-pop');
  if (pop) pop.remove();
  document.removeEventListener('keydown', closeUserMenuOnEsc);
}

// ===== Settings page =====
const PLAN_INFO = {
  trial:     { label: 'TRIAL',     desc: '14 ימים · 7 PDFs · 6 סיכומים · 25 AI · 20 מעבדה ביום' },
  free:      { label: 'FREE',      desc: '5 PDFs · 4 סיכומים · 15 AI · 10 שאלות מעבדה ביום' },
  basic:     { label: 'BASIC',     desc: '10 PDFs · 8 סיכומים · 30 AI · 25 מעבדה · 10 קורסים' },
  pro:       { label: 'PRO',       desc: '20 PDFs · 20 סיכומים · 80 AI · 60 מעבדה · קורסים ללא הגבלה' },
  education: { label: 'EDUCATION', desc: 'הכל מ-Pro + 50 משתמשי משנה + לוח בקרה למורה' },
};

function renderSettings(initialTab) {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');
  const tpl = tmpl('tmpl-settings');
  $app.innerHTML = '';
  $app.appendChild(tpl);
  wireTopbar();

  // Highlight settings tab in topbar nav (no nav link for settings, but we
  // still want to clear active state on others)
  document.querySelectorAll('.topbar-nav a').forEach(a => a.classList.remove('active'));

  // Switch panels
  const tabs = document.querySelectorAll('.settings-nav-item');
  const panels = document.querySelectorAll('.settings-panel');
  function showTab(name) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach(p => p.toggleAttribute('hidden', p.dataset.panel !== name));
  }
  tabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
  showTab(initialTab && document.querySelector(`.settings-nav-item[data-tab="${initialTab}"]`) ? initialTab : 'profile');

  // Profile section
  const u = state.user;
  const initial = (u.name || 'U').slice(0, 1).toUpperCase();
  document.getElementById('settings-avatar').textContent = initial;
  document.getElementById('settings-name').textContent = u.name || '—';
  document.getElementById('settings-email').textContent = u.email || '—';
  document.getElementById('settings-name-input').value = u.name || '';
  document.getElementById('settings-save-profile').addEventListener('click', async () => {
    const newName = document.getElementById('settings-name-input').value.trim();
    if (!newName) return;
    const btn = document.getElementById('settings-save-profile');
    const status = document.getElementById('settings-save-status');
    btn.disabled = true;
    status.textContent = 'שומר...';
    status.className = 'settings-save-status';
    try {
      const token = await Auth.getToken();
      const cfg = _sbConfig;
      if (token && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && state.user?.id) {
        await fetch(`${cfg.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(state.user.id)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': cfg.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${token}`,
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ display_name: newName }),
        });
      }
      state.user = Auth.update({ name: newName });
      document.getElementById('settings-name').textContent = newName;
      document.getElementById('settings-avatar').textContent = newName.slice(0, 1).toUpperCase();
      status.textContent = 'נשמר ✓';
      status.classList.add('is-ok');
    } catch {
      status.textContent = 'שגיאה בשמירה';
      status.classList.add('is-err');
    }
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; status.className = 'settings-save-status'; }, 2200);
  });

  // Show password-change section only for email/password users (not Google OAuth)
  getSbClient().then(async (sb) => {
    if (!sb) return;
    const { data: { session } } = await sb.auth.getSession().catch(() => ({ data: { session: null } }));
    if (!session) return;
    const identities = session.user?.identities || [];
    const isOAuth = identities.some(id => id.provider !== 'email');
    const pwSection = document.getElementById('settings-password-section');
    if (!isOAuth && pwSection) {
      pwSection.removeAttribute('hidden');
      const pw1El     = document.getElementById('settings-new-password');
      const pw2El     = document.getElementById('settings-new-password2');
      const strengthEl = document.getElementById('settings-pw-strength');

      function pwStrength(pw) {
        if (!pw) return { score: 0, label: '', cls: '' };
        let s = 0;
        if (pw.length >= 8)  s++;
        if (pw.length >= 12) s++;
        if (/[A-Z]/.test(pw)) s++;
        if (/[a-z]/.test(pw)) s++;
        if (/[0-9]/.test(pw)) s++;
        if (/[^A-Za-z0-9]/.test(pw)) s++;
        if (s <= 2) return { score: s, label: 'חלשה', cls: 'pw-weak' };
        if (s <= 4) return { score: s, label: 'בינונית', cls: 'pw-medium' };
        return { score: s, label: 'חזקה', cls: 'pw-strong' };
      }

      pw1El.addEventListener('input', () => {
        const { label, cls } = pwStrength(pw1El.value);
        if (strengthEl) { strengthEl.textContent = pw1El.value ? `עוצמה: ${label}` : ''; strengthEl.className = `pw-strength-label ${cls}`; }
      });

      document.getElementById('settings-save-password').addEventListener('click', async () => {
        const pw1 = pw1El.value;
        const pw2 = pw2El.value;
        const status = document.getElementById('settings-password-status');
        const { score } = pwStrength(pw1);
        if (!pw1 || pw1.length < 8) { status.textContent = 'סיסמה חייבת להכיל לפחות 8 תווים'; status.className = 'settings-save-status'; return; }
        if (score < 3) { status.textContent = 'הסיסמה חלשה מדי — הוסף אותיות גדולות, מספרים או תווים מיוחדים'; status.className = 'settings-save-status'; return; }
        if (pw1 !== pw2) { status.textContent = 'הסיסמאות אינן תואמות'; status.className = 'settings-save-status'; return; }
        const btn = document.getElementById('settings-save-password');
        btn.disabled = true; btn.textContent = 'שומר...';
        try {
          const { error } = await sb.auth.updateUser({ password: pw1 });
          if (error) throw new Error(error.message);
          status.textContent = 'סיסמה שונתה בהצלחה ✓';
          status.className = 'settings-save-status is-ok';
          pw1El.value = ''; pw2El.value = '';
          if (strengthEl) { strengthEl.textContent = ''; strengthEl.className = 'pw-strength-label'; }
          setTimeout(() => { status.textContent = ''; status.className = 'settings-save-status'; }, 3500);
        } catch (err) {
          status.textContent = err.message || 'שגיאה בשמירת הסיסמה';
          status.className = 'settings-save-status';
        } finally {
          btn.disabled = false; btn.textContent = 'שנה סיסמה';
        }
      });
    }
  }).catch(() => {});

  // Plan section
  const planInfo = PLAN_INFO[u.plan] || PLAN_INFO.free;
  document.getElementById('settings-plan-name').textContent = planInfo.label;
  document.getElementById('settings-plan-meta').textContent = planInfo.desc;

  if (u.isAdmin) {
    // Admin: show all plans with real DB switching
    const planGrid = document.querySelector('.settings-plan-grid');
    if (planGrid) {
      const allPlans = ['trial', 'free', 'basic', 'pro', 'education'];
      planGrid.innerHTML = allPlans.map(p => {
        const info = PLAN_INFO[p] || { label: p, desc: '' };
        const isCurrent = p === u.plan;
        return `<button class="settings-plan-tile ${isCurrent ? 'is-current' : ''}" data-plan="${p}">
          <strong>${info.label}</strong>
          <small>${info.desc}</small>
          ${isCurrent ? '<span class="admin-current-badge">נוכחי</span>' : ''}
        </button>`;
      }).join('');
    }
    document.querySelectorAll('.settings-plan-tile').forEach(tile => {
      tile.addEventListener('click', async () => {
        const newPlan = tile.dataset.plan;
        if (newPlan === u.plan) return;
        const label = (PLAN_INFO[newPlan] || { label: newPlan }).label;
        if (!confirm(`[Admin] להחליף ל-${label}?\n\nזהו שינוי אמיתי ב-DB — כל הקוטות יתאפסו.`)) return;
        try {
          const token = await Auth.getToken();
          const res = await fetch('/api/admin/switch-plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ plan: newPlan }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'שגיאה');
          state.user = Auth.update({ plan: newPlan, daysLeft: newPlan === 'trial' ? 14 : null, trialUsed: newPlan === 'free' });
          toast(`Plan switched to ${label}`, 'success');
          renderSettings('plan');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  } else {
    // Non-admin: no upgrade path yet — show info only
    const planGrid = document.querySelector('.settings-plan-grid');
    if (planGrid) {
      planGrid.innerHTML = `
        <div style="grid-column:1/-1;background:var(--surface-alt,#f8f9fa);border-radius:12px;padding:20px 24px;text-align:center;border:1px solid var(--border-soft);">
          <div style="font-size:28px;margin-bottom:8px;">🚀</div>
          <strong style="font-size:15px;">מנוי ${planInfo.label}</strong>
          <p style="margin:8px 0 0;font-size:13px;color:var(--text-muted);">${planInfo.desc}</p>
          <p style="margin:12px 0 0;font-size:13px;color:var(--text-muted);">אפשרויות שדרוג יהיו זמינות בקרוב כשמערכת התשלומים תופעל.</p>
        </div>
      `;
    }
  }

  const upgradeBtn = document.getElementById('settings-upgrade-btn');
  if (upgradeBtn) {
    if (u.isAdmin) {
      upgradeBtn.addEventListener('click', (e) => { e.preventDefault(); });
    } else {
      upgradeBtn.style.display = 'none';
    }
  }
  document.getElementById('settings-manage-billing')?.addEventListener('click', () => {
    if (u.isAdmin) {
      alert('ניהול חיוב יתחבר ל-Stripe ב-Phase 2.\nכרגע אין נתוני חיוב אמיתיים.');
    } else {
      toast('ניהול חיוב יהיה זמין בקרוב', 'info');
    }
  });

  // Appearance / theme
  const themePicker = document.getElementById('theme-picker');
  function highlightTheme() {
    themePicker.querySelectorAll('.theme-option').forEach(opt => {
      opt.classList.toggle('is-active', opt.dataset.theme === Theme.current());
    });
  }
  themePicker.querySelectorAll('.theme-option').forEach(opt => {
    opt.addEventListener('click', () => {
      Theme.set(opt.dataset.theme);
      highlightTheme();
    });
  });
  highlightTheme();

  // Notifications — persisted to localStorage as a simple JSON object
  const PREFS_KEY = 'ep_prefs_v1';
  const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } })();
  document.querySelectorAll('[data-pref]').forEach(input => {
    const key = input.getAttribute('data-pref');
    if (typeof prefs[key] === 'boolean') input.checked = prefs[key];
    input.addEventListener('change', () => {
      prefs[key] = input.checked;
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
    });
  });

  // Privacy actions
  document.getElementById('settings-export-data').addEventListener('click', () => {
    const data = {
      user: state.user,
      progress: (typeof Progress !== 'undefined' && Progress.load) ? Progress.load(state.user.email, state.course?.id) : null,
      studyPacks: (typeof StudyStore !== 'undefined' && StudyStore.list) ? StudyStore.list() : null,
      prefs,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `examprep-export-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  document.getElementById('settings-clear-history').addEventListener('click', () => {
    if (!confirm('למחוק את כל היסטוריית התרגול שלך? פעולה זו לא ניתנת לביטול.')) return;
    try {
      const k = `ep_progress_${state.user.email}`;
      localStorage.removeItem(k);
    } catch {}
    alert('היסטוריית התרגול נמחקה.');
  });

  // Danger zone
  document.getElementById('settings-cancel-sub').addEventListener('click', () => {
    if (!confirm('האם לבטל את המנוי שלך?\nהמנוי יישאר פעיל עד סוף תקופת החיוב הנוכחית.')) return;
    state.user = Auth.update({ plan: 'free' });
    alert('המנוי בוטל. החשבון יחזור למצב חינמי.');
    renderSettings('plan');
  });
  document.getElementById('settings-delete-account').addEventListener('click', async () => {
    if (!confirm('למחוק לצמיתות את החשבון שלך וכל הנתונים?\nפעולה זו לא ניתנת לביטול.')) return;
    if (!confirm('זוהי הזדמנות אחרונה. למחוק לצמיתות?')) return;
    const btn = document.getElementById('settings-delete-account');
    btn.disabled = true;
    btn.textContent = 'מוחק...';
    try {
      const token = await Auth.getToken();
      const res = await fetch('/api/account/delete', {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(body.error || 'שגיאה במחיקת החשבון. נסה שוב.', 'error');
        btn.disabled = false;
        btn.textContent = 'מחק חשבון לצמיתות';
        return;
      }
    } catch (e) {
      toast('שגיאת תקשורת. נסה שוב.', 'error');
      btn.disabled = false;
      btn.textContent = 'מחק חשבון לצמיתות';
      return;
    }
    try {
      Object.keys(localStorage).filter(k => k.startsWith('ep_')).forEach(k => localStorage.removeItem(k));
    } catch {}
    Auth.clear();
    state.user = null;
    alert('החשבון נמחק. תועבר לדף הבית.');
    navigate('/');
  });
}

// ===== Keyboard shortcuts (during quiz) =====
const HEBREW_NUMS = { 'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6, 'ז': 7, 'ח': 8 };
document.addEventListener('keydown', (e) => {
  if (!state.quiz) return;
  if (location.hash !== '#/quiz') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key >= '1' && e.key <= '9') selectAnswer(parseInt(e.key, 10));
  else if (HEBREW_NUMS[e.key]) selectAnswer(HEBREW_NUMS[e.key]);
  else if (e.key === 't' || e.key === 'T' || e.key === 'ם') revealSolution();
  else if (e.key === 'ArrowRight') navQuiz(-1);
  else if (e.key === 'ArrowLeft') navQuiz(1);
});

// =====================================================
//   SMART STUDY FROM SUMMARY
// =====================================================
// Client-side store for study packs in the local-testing phase. Each pack is
// keyed by id and persisted in localStorage. Free-plan quota (2 lifetime) is
// also enforced here — server has dev mode that doesn't enforce, so it falls
// to the client. Once we move to real Supabase auth this will switch to
// server-backed CRUD via /api/study/packs.
const StudyStore = {
  KEY: 'ep_study_packs_v1',
  USED_KEY: 'ep_study_packs_used_v1',  // lifetime counter for free trial
  list() {
    try { return JSON.parse(localStorage.getItem(this.KEY)) || []; }
    catch { return []; }
  },
  get(id) {
    return this.list().find(p => String(p.id) === String(id)) || null;
  },
  save(pack) {
    const all = this.list();
    const idx = all.findIndex(p => String(p.id) === String(pack.id));
    if (idx >= 0) all[idx] = pack; else all.unshift(pack);
    try {
      localStorage.setItem(this.KEY, JSON.stringify(all));
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
        // Drop the oldest pack and retry once.
        const trimmed = all.slice(0, Math.max(1, Math.floor(all.length * 0.75)));
        try {
          localStorage.setItem(this.KEY, JSON.stringify(trimmed));
          if (typeof toast === 'function') toast('זיכרון מקומי מתמלא — נמחקו חבילות ישנות', '');
        } catch {}
        if (window.__reportClientError) {
          window.__reportClientError('quota-trim', { msg: 'StudyStore.save quota hit' });
        }
        return;
      }
      throw e;
    }
  },
  remove(id) {
    const all = this.list().filter(p => String(p.id) !== String(id));
    try { localStorage.setItem(this.KEY, JSON.stringify(all)); } catch {}
  },
  usedTotal() {
    return parseInt(localStorage.getItem(this.USED_KEY) || '0', 10) || 0;
  },
  bumpUsed() {
    localStorage.setItem(this.USED_KEY, String(this.usedTotal() + 1));
  },
  resetUsed() {
    localStorage.removeItem(this.USED_KEY);
  },
  // Per-day study pack limits by plan. Keep in sync with api/_lib/quotas.mjs.
  DAILY_LIMITS: { free: 0, trial: 4, basic: 5, pro: 15, education: -1 },
  quotaForUser(user) {
    const plan = (user && user.plan) || 'free';
    const dailyLimit = this.DAILY_LIMITS[plan] ?? 2;
    const used = user?.studyPacksUsedToday ?? 0;
    if (dailyLimit === -1) return { dailyLimit: -1, used, unlimited: true };
    return { dailyLimit, used, unlimited: false };
  },
};

function showPaywallModal(context) {
  const messages = {
    pdf_upload:   { title: 'הגעת למגבלת ההעלאות היומית', body: 'בפלאן החינמי ניתן להעלות עד 5 בחינות ביום. נסה שוב מחר, או שדרג ל-Basic לקבל 60 קבצים בחודש.' },
    ai_quota:     { title: 'הגעת למגבלת פעולות ה-AI היומית', body: 'בפלאן החינמי יש 15 פעולות AI ביום. נסה שוב מחר, או שדרג ל-Basic לקבל 200 בחודש.' },
    study_pack:   { title: 'הגעת למגבלת הסיכומים היומית', body: 'בפלאן החינמי ניתן לייצר עד 4 סיכומי PDF ביום. נסה שוב מחר, או שדרג ל-Basic לקבל 50 בחודש.' },
    lab_quota:    { title: 'הגעת למגבלת שאלות המעבדה היומית', body: 'בפלאן החינמי ניתן לייצר עד 10 שאלות מעבדה ביום. נסה שוב מחר, או שדרג ל-Basic לקבל 25 ביום.' },
    course_limit: { title: 'הגעת למגבלת הקורסים', body: 'בפלאן החינמי יש עד 5 קורסים פעילים. שדרג ל-Basic לקבל 10 קורסים, או ל-Pro ללא הגבלה.' },
    trial_ended:  { title: 'תקופת הניסיון המורחב הסתיימה', body: 'אתה כעת בפלאן החינמי עם מגבלות יומיות. שדרג ל-Basic כדי לקבל הרבה יותר.' },
  };
  const msg = messages[context] || { title: 'שדרג לחבילת Basic', body: 'קבל גישה מלאה לכל הפיצ\'רים: העלאת PDFs, שאלות AI, חבילות לימוד ועוד.' };

  const html = `
    <div class="modal-backdrop" id="paywall-modal">
      <div class="modal paywall-modal">
        <button class="modal-close" id="paywall-close">✕</button>
        <h2>${msg.title}</h2>
        <p class="modal-sub">${msg.body}</p>
        <div class="paywall-plan-highlight">
          <div class="price-name">Basic</div>
          <div class="price-amount">19.90<span class="currency">₪</span><span class="period">/חודש</span></div>
          <ul class="price-features">
            <li>30 קבצי PDF בחודש</li>
            <li>30 חבילות לימוד מסיכום</li>
            <li>100 שאלות AI בחודש</li>
            <li>5 קורסים פעילים</li>
            <li>תובנות + מעקב התקדמות מלאים</li>
          </ul>
        </div>
        <button class="btn btn-primary btn-block" id="paywall-upgrade">שדרג ל-Basic</button>
        <button class="btn btn-ghost btn-block btn-sm" id="paywall-cancel" style="margin-top:8px">אולי אחר כך</button>
      </div>
    </div>
  `;
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container.firstElementChild);
  const modal = document.getElementById('paywall-modal');
  const close = () => modal.remove();
  document.getElementById('paywall-close').addEventListener('click', close);
  document.getElementById('paywall-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('paywall-upgrade').addEventListener('click', () => {
    close();
    setTimeout(() => { location.hash = '#pricing'; navigate('/'); }, 0);
  });
}

async function renderStudyList() {
  if (!state.user) return navigate('/login');
  if (!state.course) return navigate('/dashboard');
  const tpl = tmpl('tmpl-study-list');
  $app.innerHTML = '';
  $app.appendChild(tpl);
  wireTopbar();

  document.querySelectorAll('[data-route]').forEach(link => {
    link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.getAttribute('data-route')); });
  });

  const quota = StudyStore.quotaForUser(state.user);
  const banner = document.getElementById('study-quota-banner');
  if (!quota.unlimited) {
    const left = Math.max(0, quota.dailyLimit - quota.used);
    const lockIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
    banner.innerHTML = `
      <div class="quota-pill ${left === 0 ? 'quota-pill-empty' : ''}">
        <span class="quota-pill-icon">${left === 0 ? lockIcon : ''}</span>
        <div>
          <strong>נשארו לך ${left} מתוך ${quota.dailyLimit} סיכומי PDF היום</strong>
          <small>${left === 0 ? 'הגעת למגבלה היומית. חדשות טובות: תוכל ליצור עוד מחר' : 'ניתן ליצור עד ' + quota.dailyLimit + ' חבילות לימוד ביום'}</small>
        </div>
      </div>`;
  } else {
    banner.innerHTML = `<div class="quota-pill quota-pill-unlimited"><span class="quota-pill-icon">⭐</span><div><strong>חבילות לימוד ללא הגבלה</strong><small>מסלול ${state.user.plan}</small></div></div>`;
  }

  function renderGrid(packs) {
    const grid = document.getElementById('study-list-grid');
    const empty = document.getElementById('study-empty');
    if (!grid) return;
    if (!packs.length) {
      grid.style.display = 'none';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    grid.style.display = '';
    grid.innerHTML = packs.map(p => `
      <a href="#/study/${p.id}" class="study-pack-card" data-route="/study/${p.id}">
        <div class="study-pack-card-icon">${p.source_kind === 'pdf' ? '📄' : '📝'}</div>
        <h3>${escapeHtml(p.title)}</h3>
        <div class="study-pack-card-meta">
          <span>${(p.materials?.questions || []).length} שאלות</span>
          <span>${(p.materials?.flashcards || []).length} כרטיסיות</span>
          <span>${(p.materials?.glossary || []).length} מושגים</span>
        </div>
        <div class="study-pack-card-date">${new Date(p.created_at).toLocaleDateString('he-IL')}</div>
        <button class="study-pack-card-delete" data-delete="${p.id}" aria-label="מחק">🗑</button>
      </a>
    `).join('');
    grid.querySelectorAll('[data-route]').forEach(link => {
      link.addEventListener('click', (e) => {
        if (e.target.dataset.delete) return;
        e.preventDefault();
        navigate(link.getAttribute('data-route'));
      });
    });
    grid.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!confirm('למחוק את החבילה?')) return;
        const packId = btn.dataset.delete;
        StudyStore.remove(packId);
        renderGrid(StudyStore.list().filter(p => String(p.courseId ?? p.course_id) === String(state.course.id)));
        if (/^\d+$/.test(packId)) {
          const token = await Auth.getToken().catch(() => null);
          if (token) fetch(`/api/study/packs/${packId}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
          }).catch(() => {});
        }
      });
    });
  }

  // Show local data immediately
  renderGrid(StudyStore.list().filter(p => String(p.courseId ?? p.course_id) === String(state.course.id)));

  // Fetch from server and merge (server is source of truth per course per user)
  const token = await Auth.getToken().catch(() => null);
  if (token && state.course?.id) {
    fetch(`/api/study/packs?courseId=${state.course.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.ok ? r.json() : null).then(serverPacks => {
      if (!Array.isArray(serverPacks)) return;
      serverPacks.forEach(p => StudyStore.save({ ...p, courseId: p.course_id ?? p.courseId }));
      renderGrid(StudyStore.list().filter(p => String(p.courseId ?? p.course_id) === String(state.course.id)));
    }).catch(() => {});
  }
}

async function renderStudyCreate() {
  if (!state.user) return navigate('/login');
  if (!state.course) return navigate('/dashboard');
  const tpl = tmpl('tmpl-study-create');
  $app.innerHTML = '';
  $app.appendChild(tpl);
  wireTopbar();

  document.querySelectorAll('[data-route]').forEach(link => {
    link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.getAttribute('data-route')); });
  });

  // Pre-flight quota check
  const quota = StudyStore.quotaForUser(state.user);
  if (!quota.unlimited && quota.used >= quota.lifetime) {
    document.getElementById('study-create-quota-hint').innerHTML = `
      <div class="quota-blocked">
        🔒 סיימת את ${quota.lifetime} החבילות החינמיות שלך. <a href="#pricing" id="quota-upgrade-link">שדרג ל-Basic</a> כדי להמשיך.
      </div>`;
    document.getElementById('study-create-submit').disabled = true;
  } else if (!quota.unlimited) {
    const left = quota.lifetime - quota.used;
    document.getElementById('study-create-quota-hint').innerHTML = `
      <small>נשארו לך ${left} מתוך ${quota.lifetime} חבילות חינמיות</small>`;
  }

  // Tab switching (paste / pdf)
  let activeTab = 'paste';
  document.querySelectorAll('.study-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      document.querySelectorAll('.study-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.getElementById('study-tab-paste').style.display = activeTab === 'paste' ? '' : 'none';
      document.getElementById('study-tab-pdf').style.display = activeTab === 'pdf' ? '' : 'none';
    });
  });

  // Live char counter on the textarea
  const textarea = document.getElementById('study-text');
  const counter = document.getElementById('study-text-count');
  textarea.addEventListener('input', () => {
    counter.textContent = textarea.value.length.toLocaleString('he-IL');
  });

  // PDF picker
  const fileInput = document.getElementById('study-pdf-file');
  const drop = document.getElementById('study-pdf-drop');
  const dropInner = drop.querySelector('.study-pdf-drop-inner');
  const dropSelected = document.getElementById('study-pdf-selected');
  const dropName = document.getElementById('study-pdf-name');
  document.getElementById('study-pdf-pick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) {
      dropName.textContent = fileInput.files[0].name;
      dropInner.style.display = 'none';
      dropSelected.style.display = '';
    }
  });
  document.getElementById('study-pdf-clear').addEventListener('click', (e) => {
    e.preventDefault();
    fileInput.value = '';
    dropInner.style.display = '';
    dropSelected.style.display = 'none';
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    const f = e.dataTransfer.files?.[0];
    if (f && f.type === 'application/pdf') {
      const dt = new DataTransfer();
      dt.items.add(f);
      fileInput.files = dt.files;
      dropName.textContent = f.name;
      dropInner.style.display = 'none';
      dropSelected.style.display = '';
    }
  });

  // Submit
  const submit = document.getElementById('study-create-submit');
  const errBox = document.getElementById('study-create-error');
  const btnLabel = submit.querySelector('.btn-label');
  const btnSpinner = submit.querySelector('.btn-spinner');
  submit.addEventListener('click', async () => {
    errBox.textContent = '';
    // Re-check quota right before submit
    const q = StudyStore.quotaForUser(state.user);
    if (!q.unlimited && q.used >= q.lifetime) {
      showPaywallModal('study_pack');
      return;
    }

    let body, headers = {};
    if (activeTab === 'paste') {
      const text = textarea.value.trim();
      const title = document.getElementById('study-title-paste').value.trim() || 'סיכום ללא שם';
      if (text.length < 300) {
        errBox.textContent = 'הסיכום קצר מדי — צריך לפחות 300 תווים.';
        return;
      }
      if (text.length > 60000) {
        errBox.textContent = 'הסיכום ארוך מדי — מקסימום 60,000 תווים.';
        return;
      }
      body = JSON.stringify({ kind: 'paste', text, title, courseId: state.course?.id || null });
      headers['Content-Type'] = 'application/json';
    } else {
      const file = fileInput.files?.[0];
      if (!file) {
        errBox.textContent = 'בחר קובץ PDF להעלאה.';
        return;
      }
      if (file.size > 15 * 1024 * 1024) {
        errBox.textContent = 'הקובץ גדול מדי (מקסימום 15MB).';
        return;
      }
      const fd = new FormData();
      fd.append('pdf', file);
      const t = document.getElementById('study-title-pdf').value.trim();
      if (t) fd.append('title', t);
      if (state.course?.id) fd.append('courseId', String(state.course.id));
      body = fd;
    }

    submit.disabled = true;
    btnLabel.style.display = 'none';
    btnSpinner.style.display = '';

    // Progress bar with real upload tracking
    const progressBar = document.createElement('div');
    progressBar.className = 'study-progress-wrap';
    progressBar.innerHTML = `
      <div class="study-progress-bar"><div class="study-progress-fill" style="width:0%"></div></div>
      <div class="study-progress-step">מתחיל...</div>
    `;
    submit.parentElement.insertBefore(progressBar, submit.nextSibling);
    const fill = progressBar.querySelector('.study-progress-fill');
    const stepLabel = progressBar.querySelector('.study-progress-step');

    // AI processing phase animation (runs after upload completes or for paste mode)
    let aiInterval = null;
    let aiStart = null;
    const aiSteps = [
      { at: 0, text: '📖 קורא ומנתח את הטקסט...' },
      { at: 4, text: '🔍 מזהה נושאים ומושגי מפתח...' },
      { at: 8, text: '🧠 הבינה המלאכותית מעבדת את החומר...' },
      { at: 14, text: '✍️ יוצר שאלות אמריקאיות מהסיכום...' },
      { at: 20, text: '📝 כותב הסברים לכל תשובה...' },
      { at: 28, text: '🃏 בונה כרטיסיות לימוד...' },
      { at: 35, text: '📋 יוצר מתאר נושאים ומילון מושגים...' },
      { at: 45, text: '🧪 בודק שהתוכן מדויק ואיכותי...' },
      { at: 55, text: '📊 מסדר את חבילת הלימוד...' },
      { at: 65, text: '✨ כמעט מוכן, עוד כמה שניות...' },
    ];
    function startAiPhase(fromPct) {
      aiStart = Date.now();
      aiInterval = setInterval(() => {
        const elapsed = (Date.now() - aiStart) / 1000;
        const aiPct = fromPct + Math.min(95 - fromPct, (95 - fromPct) * (1 - Math.exp(-elapsed / 25)));
        fill.style.width = aiPct + '%';
        const step = [...aiSteps].reverse().find(s => elapsed >= s.at);
        if (step) stepLabel.textContent = step.text;
      }, 500);
    }

    btnSpinner.textContent = '⏳ יוצר חבילת לימוד...';
    const isPdf = activeTab !== 'paste';

    try {
      let res;
      if (isPdf) {
        // PDF mode: real upload progress via XHR (0-40%), then AI processing (40-95%)
        const token = await Auth.getToken();
        const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
        res = await uploadWithProgress({
          url: '/api/study/generate',
          headers: authHeaders,
          body,
          timeoutMs: 180000,
          onUploadProgress(loaded, total) {
            const uploadPct = (loaded / total) * 40;
            fill.style.width = uploadPct + '%';
            const pctDone = Math.round((loaded / total) * 100);
            const mbLoaded = (loaded / (1024 * 1024)).toFixed(1);
            const mbTotal = (total / (1024 * 1024)).toFixed(1);
            if (pctDone < 50) stepLabel.textContent = `📤 מעלה קובץ... ${mbLoaded}MB מתוך ${mbTotal}MB`;
            else if (pctDone < 90) stepLabel.textContent = `📡 שולח נתונים... ${pctDone}%`;
            else stepLabel.textContent = `✅ ההעלאה כמעט הושלמה... ${pctDone}%`;
          },
          onUploadDone() { startAiPhase(40); },
        });
        if (!res.ok) {
          if (res.status === 402 && res.data.needs_upgrade) { showPaywallModal('study_pack'); return; }
          errBox.textContent = res.data.error || `שגיאה (${res.status})`;
          console.error('[study] error:', res.status, res.data);
          return;
        }
      } else {
        // Paste mode: no file to upload, go straight to AI processing
        startAiPhase(5);
        fill.style.width = '5%';
        const token = await Auth.getToken();
        const fetchRes = await fetch('/api/study/generate', {
          method: 'POST',
          headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body,
        });
        const data = await fetchRes.json();
        res = { ok: fetchRes.ok, status: fetchRes.status, data };
        if (!fetchRes.ok) {
          if (fetchRes.status === 402 && data.needs_upgrade) { showPaywallModal('study_pack'); return; }
          errBox.textContent = data.error || `שגיאה (${fetchRes.status})`;
          console.error('[study] error:', fetchRes.status, data);
          return;
        }
      }
      if (aiInterval) clearInterval(aiInterval);
      fill.style.width = '100%';
      stepLabel.textContent = '✅ הושלם!';

      const data = res.data;
      const packTitle = data.title || (activeTab === 'paste'
        ? (document.getElementById('study-title-paste').value.trim() || 'סיכום ללא שם')
        : (fileInput.files[0].name.replace(/\.pdf$/i, '') || 'סיכום ללא שם'));
      const pack = {
        id: data.pack_id ? String(data.pack_id) : ('local_' + Date.now()),
        title: packTitle,
        courseName: state.course?.name || packTitle,
        source_kind: data.source_kind || activeTab,
        courseId: state.course?.id || null,
        materials: data.materials || {},
        created_at: new Date().toISOString(),
      };
      StudyStore.save(pack);
      StudyStore.bumpUsed();
      navigate('/study/' + pack.id);
    } catch (err) {
      console.error('[study create]', err);
      errBox.textContent = 'שגיאת רשת. נסה שוב.';
    } finally {
      if (aiInterval) clearInterval(aiInterval);
      progressBar?.remove();
      submit.disabled = false;
      btnLabel.style.display = '';
      btnSpinner.style.display = 'none';
    }
  });
}

async function renderStudyPack(packId) {
  if (!state.user) return navigate('/login');
  let pack = StudyStore.get(packId);
  if (!pack) {
    // Fallback: try fetching from server (e.g. after localStorage cleared or new device)
    const token = await Auth.getToken().catch(() => null);
    if (token) {
      const r = await fetch(`/api/study/packs/${packId}`, {
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => null);
      if (r?.ok) {
        const data = await r.json().catch(() => null);
        if (data?.id) {
          pack = { ...data, courseId: data.course_id ?? data.courseId };
          StudyStore.save(pack);
        }
      }
    }
  }
  if (!pack) {
    toast('חבילת הלימוד לא נמצאה', 'error');
    const cid = state.course?.id;
    return navigate(cid ? `/course/${cid}/study` : '/dashboard');
  }
  const tpl = tmpl('tmpl-study-pack');
  $app.innerHTML = '';
  $app.appendChild(tpl);
  wireTopbar();

  // Rewrite back button to course-scoped URL so state.course is always set on return
  const cid = pack.courseId || pack.course_id;
  if (cid) {
    document.querySelectorAll('[data-route="/study"]').forEach(el => {
      const r = `/course/${cid}/study`;
      el.setAttribute('data-route', r);
      if (el.tagName === 'A') el.setAttribute('href', `#${r}`);
    });
  }

  document.querySelectorAll('[data-route]').forEach(link => {
    link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.getAttribute('data-route')); });
  });

  document.getElementById('pack-title').textContent = pack.title;
  document.getElementById('pack-summary').textContent = pack.materials?.summary || '';

  const m = pack.materials || {};
  document.getElementById('pack-panel-questions').innerHTML = renderStudyQuestions(m.questions || []);
  document.getElementById('pack-panel-flashcards').innerHTML = renderStudyFlashcards(m.flashcards || []);
  document.getElementById('pack-panel-outline').innerHTML = renderStudyOutline(m.outline || []);
  document.getElementById('pack-panel-glossary').innerHTML = renderStudyGlossary(m.glossary || []);
  document.getElementById('pack-panel-open').innerHTML = renderStudyOpenQuestions(m.openQuestions || []);
  document.getElementById('pack-panel-selftest').innerHTML = renderStudySelfTest(m.selfTest || []);

  // Tab switching
  document.querySelectorAll('.pack-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.pack-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.pack-panel').forEach(p => {
        p.style.display = p.dataset.panel === target ? '' : 'none';
      });
    });
  });

  // Wire up flashcard flip behavior
  document.querySelectorAll('.flashcard').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('flipped'));
  });

  // Wire up MCQ "show answer" buttons
  document.querySelectorAll('[data-show-answer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.study-question');
      wrap.classList.add('revealed');
    });
  });

  // Wire up study question removal
  document.querySelectorAll('[data-remove-sq]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.removeSq, 10);
      const questions = pack.materials?.questions;
      if (questions && idx >= 0 && idx < questions.length) {
        questions.splice(idx, 1);
        StudyStore.save(pack); // persist to localStorage
        const panel = document.getElementById('pack-panel-questions');
        panel.innerHTML = renderStudyQuestions(questions);
        // Re-wire show-answer + remove buttons
        panel.querySelectorAll('[data-show-answer]').forEach(b => {
          b.addEventListener('click', () => b.closest('.study-question').classList.add('revealed'));
        });
        panel.querySelectorAll('[data-remove-sq]').forEach(b => {
          b.addEventListener('click', () => {
            const i2 = parseInt(b.dataset.removeSq, 10);
            if (questions[i2] !== undefined) {
              questions.splice(i2, 1);
              StudyStore.save(pack);
              panel.innerHTML = renderStudyQuestions(questions);
              // Recursive re-wire is fine since it rebuilds the DOM
              panel.querySelectorAll('[data-show-answer]').forEach(bb => {
                bb.addEventListener('click', () => bb.closest('.study-question').classList.add('revealed'));
              });
            }
          });
        });
        toast('השאלה הוסרה', 'info');
      }
    });
  });

  // Wire up open-question "show model answer"
  document.querySelectorAll('[data-show-model]').forEach(btn => {
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.study-open-q');
      wrap.classList.add('revealed');
    });
  });

  // Self-test scoring (basic)
  initSelfTest();
}

function renderStudyQuestions(questions) {
  if (!questions.length) return '<div class="empty-state">אין שאלות בחבילה זו.</div>';
  return questions.map((q, i) => `
    <div class="study-question" data-sq-idx="${i}">
      <div class="study-question-head">
        <div class="study-question-num">שאלה ${i + 1}</div>
        <button type="button" class="study-q-remove" data-remove-sq="${i}" title="הסר שאלה">✕</button>
      </div>
      <div class="study-question-stem">${escapeHtml(q.stem)}</div>
      <ol class="study-question-options">
        ${q.options.map((opt, idx) => `
          <li class="${idx + 1 === q.correctIdx ? 'is-correct' : ''}">${escapeHtml(opt)}</li>
        `).join('')}
      </ol>
      <button type="button" class="btn btn-soft btn-sm" data-show-answer>הצג תשובה והסבר</button>
      <div class="study-question-explain">
        <strong>התשובה הנכונה: ${q.correctIdx}</strong>
        <p>${escapeHtml(q.explanation || '')}</p>
      </div>
    </div>
  `).join('');
}

function renderStudyFlashcards(cards) {
  if (!cards.length) return '<div class="empty-state">אין כרטיסיות בחבילה זו.</div>';
  return `
    <div class="flashcards-hint">לחץ על כרטיסייה כדי להפוך אותה</div>
    <div class="flashcards-grid">
      ${cards.map((c, i) => `
        <div class="flashcard" tabindex="0">
          <div class="flashcard-inner">
            <div class="flashcard-face flashcard-front">
              <span class="flashcard-num">${i + 1}</span>
              <div class="flashcard-text">${escapeHtml(c.front)}</div>
              <small class="flashcard-hint">לחץ להפוך</small>
            </div>
            <div class="flashcard-face flashcard-back">
              <div class="flashcard-text">${escapeHtml(c.back)}</div>
              <small class="flashcard-hint">לחץ לחזור</small>
            </div>
          </div>
        </div>
      `).join('')}
    </div>`;
}

function renderStudyOutline(sections) {
  if (!sections.length) return '<div class="empty-state">אין מתאר בחבילה זו.</div>';
  function renderItems(items, depth = 0) {
    if (!items || !items.length) return '';
    return `<ul class="study-outline-list depth-${depth}">${items.map(it => {
      if (typeof it === 'string') return `<li><span class="outline-leaf">${escapeHtml(it)}</span></li>`;
      const sub = it.items && it.items.length ? renderItems(it.items, depth + 1) : '';
      return `<li><strong>${escapeHtml(it.title || '')}</strong>${sub}</li>`;
    }).join('')}</ul>`;
  }
  return `<div class="study-outline">
    ${sections.map((s, i) => `
      <section class="study-outline-section">
        <h3><span class="study-outline-num">${i + 1}</span> ${escapeHtml(s.title || '')}</h3>
        ${renderItems(s.items, 0)}
      </section>
    `).join('')}
  </div>`;
}

function renderStudyGlossary(items) {
  if (!items.length) return '<div class="empty-state">אין מושגים בחבילה זו.</div>';
  return `<dl class="study-glossary">
    ${items.map(g => `
      <div class="glossary-item">
        <dt>${escapeHtml(g.term)}</dt>
        <dd>${escapeHtml(g.definition)}</dd>
      </div>
    `).join('')}
  </dl>`;
}

function renderStudyOpenQuestions(items) {
  if (!items.length) return '<div class="empty-state">אין שאלות פתוחות בחבילה זו.</div>';
  return items.map((q, i) => `
    <div class="study-open-q">
      <div class="study-open-q-num">שאלה ${i + 1}</div>
      <div class="study-open-q-text">${escapeHtml(q.question)}</div>
      <button type="button" class="btn btn-soft btn-sm" data-show-model>הצג תשובה מומלצת</button>
      <div class="study-open-q-answer">
        <strong>תשובה מומלצת:</strong>
        <p>${escapeHtml(q.modelAnswer || '')}</p>
      </div>
    </div>
  `).join('');
}

function renderStudySelfTest(items) {
  if (!items.length) return '<div class="empty-state">אין מבחן עצמי בחבילה זו.</div>';
  return `
    <div class="self-test-intro">
      <p>מבחן קצר שמערבב שאלות אמריקאיות וכרטיסיות. ענה על כל הפריטים ובסוף תקבל ציון.</p>
    </div>
    <div class="self-test-items">
      ${items.map((it, i) => {
        if (it.type === 'mcq') {
          return `
            <div class="st-item st-item-mcq" data-idx="${i}" data-correct="${it.correctIdx}">
              <div class="st-item-num">${i + 1}. שאלה אמריקאית</div>
              <div class="st-item-stem">${escapeHtml(it.stem)}</div>
              <div class="st-options">
                ${it.options.map((o, oi) => `
                  <button type="button" class="st-option" data-pick="${oi + 1}">${escapeHtml(o)}</button>
                `).join('')}
              </div>
            </div>`;
        }
        return `
          <div class="st-item st-item-flash" data-idx="${i}">
            <div class="st-item-num">${i + 1}. כרטיסייה</div>
            <div class="st-item-stem">${escapeHtml(it.front)}</div>
            <button type="button" class="btn btn-soft btn-sm st-flash-show">הצג תשובה</button>
            <div class="st-flash-back">${escapeHtml(it.back)}</div>
            <div class="st-flash-rate">
              <button type="button" class="btn btn-ghost btn-sm" data-rate="known">ידעתי</button>
              <button type="button" class="btn btn-ghost btn-sm" data-rate="unknown">לא ידעתי</button>
            </div>
          </div>`;
      }).join('')}
    </div>
    <div class="self-test-result" id="self-test-result"></div>
  `;
}

function initSelfTest() {
  const items = document.querySelectorAll('.st-item');
  if (!items.length) return;
  const answers = new Array(items.length).fill(null);

  document.querySelectorAll('.st-item-mcq .st-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.st-item');
      const idx = parseInt(item.dataset.idx, 10);
      const correctIdx = parseInt(item.dataset.correct, 10);
      const picked = parseInt(btn.dataset.pick, 10);
      item.querySelectorAll('.st-option').forEach(b => {
        b.disabled = true;
        const p = parseInt(b.dataset.pick, 10);
        if (p === correctIdx) b.classList.add('is-correct');
        if (p === picked && p !== correctIdx) b.classList.add('is-wrong');
      });
      answers[idx] = picked === correctIdx;
      updateSelfTestResult(answers);
    });
  });

  document.querySelectorAll('.st-flash-show').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.st-item');
      item.classList.add('revealed');
    });
  });
  document.querySelectorAll('.st-item-flash [data-rate]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.st-item');
      const idx = parseInt(item.dataset.idx, 10);
      answers[idx] = btn.dataset.rate === 'known';
      item.classList.add('rated');
      item.querySelectorAll('[data-rate]').forEach(b => b.disabled = true);
      updateSelfTestResult(answers);
    });
  });
}

function updateSelfTestResult(answers) {
  const total = answers.length;
  const answered = answers.filter(a => a !== null).length;
  const correct = answers.filter(a => a === true).length;
  const result = document.getElementById('self-test-result');
  if (!result) return;
  if (answered < total) {
    result.innerHTML = `<div class="st-progress">ענית על ${answered} מתוך ${total}</div>`;
  } else {
    const pct = Math.round((correct / total) * 100);
    let emoji = '🎉', verdict = 'מצוין!';
    if (pct < 50) { emoji = '💪'; verdict = 'יש על מה לחזור — נסה שוב.'; }
    else if (pct < 75) { emoji = '👍'; verdict = 'לא רע! עוד קצת חזרה ותהיה מוכן.'; }
    else if (pct < 90) { emoji = '🌟'; verdict = 'מצוין — אתה בכיוון הנכון.'; }
    result.innerHTML = `
      <div class="st-result-card">
        <div class="st-result-emoji">${emoji}</div>
        <div class="st-result-score">${correct} / ${total}</div>
        <div class="st-result-pct">${pct}%</div>
        <div class="st-result-verdict">${verdict}</div>
      </div>`;
  }
}

// Helper: detect whether a Supabase session exists in localStorage even if
// the ep_user cache was cleared. This lets the boot step render protected
// routes optimistically when the user is still signed in at the token level.
function _hasStoredSupabaseSession() {
  try {
    const cfg = window.APP_CONFIG || {};
    const ref = cfg.SUPABASE_URL?.match(/https:\/\/([^.]+)\./)?.[1];
    if (!ref) return false;
    const raw = localStorage.getItem(`sb-${ref}-auth-token`);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return !!(parsed?.access_token || parsed?.refresh_token);
  } catch { return false; }
}

// Instant boot skeleton — prevents the blank-page flash while we validate
// the session on refresh. Shown for at most a few hundred ms in the happy path.
function showBootSkeleton() {
  if (!$app) return;
  $app.innerHTML = `
    <div class="boot-skeleton" role="status" aria-live="polite">
      <div class="boot-skeleton-spinner"></div>
      <p class="boot-skeleton-label">טוען את החשבון שלך...</p>
    </div>
  `;
}

// ===== Boot =====
(async function boot() {
  Theme.init();
  state.user = Auth.current();
  if (!location.hash) location.hash = '#/';

  const route = getRoute();
  const needsAuth = route.startsWith('/course/') || route === '/dashboard' ||
                    route === '/settings' || route.startsWith('/study');
  const hasStoredSession = _hasStoredSupabaseSession();

  if (needsAuth && (state.user || hasStoredSession)) {
    // Auth-required page, and we have SOMETHING to try with — paint a skeleton
    // immediately so the user never sees a blank screen, then restore in the
    // background and render when ready.
    showBootSkeleton();
    try {
      const u = await Auth.restoreSession();
      if (u) state.user = u;
    } catch {}
    if (state.user) {
      renderRoute();
    } else if (hasStoredSession) {
      // We had a session but restoreSession couldn't rebuild a user — keep the
      // skeleton a moment longer and try once more. This avoids the false
      // "kicked back to login" when the profile fetch times out on refresh.
      await new Promise(r => setTimeout(r, 250));
      try {
        const u2 = await Auth.restoreSession();
        if (u2) state.user = u2;
      } catch {}
      if (state.user) renderRoute();
      else { navigate('/login'); renderRoute(); }
    } else {
      navigate('/login');
      renderRoute();
    }
  } else {
    // Public page or no credentials at all — render immediately, restore in bg.
    renderRoute();
    Auth.restoreSession().then(u => {
      if (u && (!state.user || state.user.email !== u.email || state.user.plan !== u.plan)) {
        state.user = u;
      }
    }).catch(() => {});
  }

  // Defer supabase-js auth state subscription until AFTER first paint. The
  // library is dynamically imported (~80KB), so we don't want to block page
  // interactivity waiting for it. If it never loads, the app still works —
  // _consumeOAuthHash() in restoreSession() already handles the OAuth redirect
  // back, and login/signup/getToken go through raw fetch.
  const _attachAuthSubscription = async () => {
    try {
      const sb = await getSbClient();
      if (!sb) return;
      sb.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          const profile = await Auth._fetchProfile(session.user.id).catch(() => null);
          let _dl = null;
          if (profile?.plan === 'trial' && profile?.plan_expires_at) {
            _dl = Math.max(0, Math.ceil((new Date(profile.plan_expires_at) - Date.now()) / 86400000));
          }
          const u = {
            id: session.user.id,
            email: session.user.email,
            name: profile?.display_name || session.user.user_metadata?.username || session.user.email.split('@')[0],
            plan: profile?.plan || 'free',
            isAdmin: profile?.is_admin || false,
            daysLeft: _dl,
            planExpiresAt: profile?.plan_expires_at || null,
            trialUsed: profile?.trial_used || false,
            studyPacksUsedToday: profile?.study_packs_used_today || 0,
            studyPacksUsedThisMonth: profile?.study_packs_used_this_month || 0,
          };
          Auth.save(u);
          state.user = u;
          // Create profile if missing (first Google login → start trial).
          if (!profile) {
            const now = new Date();
            const expires = new Date(now); expires.setDate(expires.getDate() + 14);
            try {
              await fetch(`${_sbConfig.SUPABASE_URL}/rest/v1/profiles`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'apikey': _sbConfig.SUPABASE_ANON_KEY,
                  'Authorization': `Bearer ${session.access_token}`,
                  'Prefer': 'resolution=merge-duplicates,return=minimal',
                },
                body: JSON.stringify({
                  id: session.user.id,
                  email: session.user.email,
                  display_name: u.name,
                  plan: 'trial',
                  plan_expires_at: expires.toISOString(),
                  trial_started_at: now.toISOString(),
                  trial_used: false,
                  is_admin: false,
                }),
                cache: 'no-store',
              });
            } catch {}
            u.plan = 'trial';
          }
          if (getRoute() === '/' || getRoute().startsWith('/login')) {
            navigate('/dashboard');
          }
        } else if (event === 'SIGNED_OUT') {
          // Guard against spurious SIGNED_OUT events that supabase-js fires on
          // page load if it reads localStorage before _consumeOAuthHash() runs,
          // or during a token-refresh race. Only honor the event if we have NO
          // valid session token left.
          if (_hasStoredSupabaseSession()) {
            console.warn('[auth] ignoring SIGNED_OUT — stored session still present');
            return;
          }
          Auth.clearLocal();
          state.user = null;
          navigate('/');
        }
      });
    } catch (e) {
      console.warn('[auth] subscription attach failed:', e?.message || e);
    }
  };
  // Schedule after first paint: requestIdleCallback if available, else setTimeout.
  if ('requestIdleCallback' in window) {
    requestIdleCallback(_attachAuthSubscription, { timeout: 3000 });
  } else {
    setTimeout(_attachAuthSubscription, 1500);
  }
})();
