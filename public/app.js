// =====================================================
// ExamPrep - Frontend SPA
// =====================================================
// Vanilla JS, no framework. All-local mode for the admin
// testing phase: question data from /public/data/*.json,
// progress in localStorage. Cloud path comes later for
// real users.
// =====================================================

// ===== Globals =====
const $app = document.getElementById('app');

const Data = {
  metadata: null,
  answers: null,
  explanations: null,
  loaded: false,
  async ensureLoaded() {
    if (this.loaded) return;
    const [meta, ans, exp] = await Promise.all([
      fetch('/public/data/metadata.json').then(r => r.json()),
      fetch('/public/data/answers.json').then(r => r.json()),
      fetch('/public/data/explanations.json').then(r => r.json()).catch(() => ({})),
    ]);
    this.metadata = meta;
    this.answers = ans.answers || {};
    this.explanations = exp || {};
    this.loaded = true;
  },
  publicMeta(qid) {
    const a = this.answers[qid] || {};
    return {
      numOptions: a.numOptions,
      optionLabels: a.optionLabels || null,
      topic: a.topic || null,
      groupId: a.groupId || null,
    };
  },
  reveal(qid) {
    const a = this.answers[qid] || {};
    return {
      correctIdx: a.correctIdx,
      explanation: this.explanations[qid] || null,
      topic: a.topic || null,
    };
  },
  imageUrl(relImage) {
    return `https://tohna1-quiz.vercel.app/images/${encodeURI(relImage)}`;
  },
  allQuestions() {
    if (!this.metadata) return [];
    return this.metadata.exams.flatMap(e => e.questions);
  },
};

// ===== State =====
const state = {
  user: null, // { email, name, plan, isAdmin }
  course: null, // currently selected course (for admin: hardcoded "תוכנה 1")
  quiz: null, // current quiz session
  lastBatch: null, // for the mistake review screen
};

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

// ===== Local "auth" (admin testing phase only) =====
// SECURITY NOTE: This is a localStorage-only mock for the local-files
// testing phase. There is NO real authentication here. The `plan` and
// `isAdmin` fields are not trusted by anything — they're just UI hints.
// Any user can edit localStorage and set plan='pro'; that's by design
// for this phase. Phase 2 will replace Auth with supabase.auth.
const Auth = {
  KEY: 'ep_user',
  current() {
    try { return JSON.parse(localStorage.getItem(this.KEY)); } catch { return null; }
  },
  save(user) { localStorage.setItem(this.KEY, JSON.stringify(user)); },
  clear() { localStorage.removeItem(this.KEY); },
  loginLocal(email, password, name) {
    // Local-only mock — every account is plan='free'. Any premium
    // gating must be enforced server-side once phase 2 ships.
    const u = {
      email,
      name: name || email.split('@')[0],
      plan: 'free',
      isAdmin: false,
    };
    this.save(u);
    return u;
  },
  loginAdmin() {
    // Synthetic admin session for the local testing phase. No real credentials
    // are checked or stored — this is a developer shortcut so the user can
    // immediately see the dashboard with the תוכנה 1 question bank loaded.
    // Phase 2 will replace this with a real Supabase Auth call to the actual
    // admin user that was seeded in the migration step.
    const u = {
      email: 'admin@examprep.local',
      name: 'אדמין',
      plan: 'pro',
      isAdmin: true,
    };
    this.save(u);
    return u;
  },
  // Patch the current user record (local-mode only). Used by the settings
  // page to update name/plan. Phase 2 will route to a Supabase RPC.
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

    // Persist
    Progress.save(uid, {
      attempts,
      batches,
      reviewQueue,
    });
    DemoSeed.markSeeded(uid);
  },
};

// ===== Local progress storage =====
const Progress = {
  KEY(uid) { return `ep_progress_${uid}`; },
  load(uid) {
    try { return JSON.parse(localStorage.getItem(this.KEY(uid))) || {}; }
    catch { return { attempts: [], reviewQueue: [], batches: [] }; }
  },
  save(uid, data) { localStorage.setItem(this.KEY(uid), JSON.stringify(data)); },
  recordAttempt(uid, attempt) {
    const p = this.load(uid);
    p.attempts = p.attempts || [];
    p.attempts.push({ ...attempt, ts: Date.now() });
    if (!attempt.isCorrect || attempt.revealed) {
      p.reviewQueue = p.reviewQueue || [];
      if (!p.reviewQueue.includes(attempt.questionId)) p.reviewQueue.push(attempt.questionId);
    } else {
      p.reviewQueue = (p.reviewQueue || []).filter(id => id !== attempt.questionId);
    }
    this.save(uid, p);
  },
  saveBatch(uid, batch) {
    const p = this.load(uid);
    p.batches = p.batches || [];
    p.batches.push(batch);
    this.save(uid, p);
  },
  stats(uid) {
    const p = this.load(uid);
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
  history(uid) { return (this.load(uid).attempts || []); },
};

// ===== Plans / quotas (mirrors server.mjs intent) =====
const PLANS = {
  free: { name: 'חינמי', canPractice: true, canAI: false, maxCourses: 1 },
  basic: { name: 'Basic', canPractice: true, canAI: true, maxCourses: 5 },
  pro: { name: 'Pro', canPractice: true, canAI: true, maxCourses: -1 },
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
function pickRandom(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
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

// ===== Router =====
function getRoute() {
  const hash = location.hash || '#/';
  return hash.replace(/^#/, '');
}
function navigate(path) {
  location.hash = '#' + path;
}
window.addEventListener('hashchange', renderRoute);

function renderRoute() {
  const route = getRoute();
  const path = route.split('?')[0];
  const params = new URLSearchParams(route.split('?')[1] || '');

  if (path === '/' || path === '') return renderLanding();
  if (path === '/login') return renderAuth(params.get('signup') === '1');
  if (path === '/dashboard') return renderDashboard();
  if (path === '/quiz') return state.quiz ? renderQuiz() : navigate('/dashboard');
  if (path === '/summary') return renderSummary();
  if (path === '/review') return renderMistakeReview();
  if (path === '/insights') return renderInsights(params.get('course'));
  if (path === '/lab') return renderLab(params.get('course'));
  if (path === '/progress') return renderProgress(params.get('course'));
  if (path === '/study') return renderStudyList();
  if (path === '/study/new') return renderStudyCreate();
  if (path.startsWith('/study/')) return renderStudyPack(path.split('/')[2]);
  if (path === '/settings') return renderSettings(params.get('tab') || 'profile');
  return renderLanding();
}

// ===== Course-scoped data helpers =====
// Every analysis function below works on a *course-scoped* slice of questions
// so the same code runs for each course the user adds in the future.
function questionsForCourse(courseId) {
  // Local-files phase: the only course is "tohna1" and all 85 questions belong
  // to it. When we move to the cloud, exam.courseId will be a real FK and we'll
  // filter on it here. The function signature is already course-aware so the
  // analysis pipeline doesn't change.
  if (!Data.metadata) return [];
  return Data.metadata.exams.flatMap(e => e.questions);
}
function examsForCourse(courseId) {
  if (!Data.metadata) return [];
  return Data.metadata.exams;
}
function attemptsForCourse(uid, courseId) {
  const all = Progress.history(uid);
  // Local mode: every attempt belongs to the single course, so no filtering
  // is required. Cloud mode will tag attempts with course_id and we'll filter
  // here. Same for the helpers below.
  return all;
}
function batchesForCourse(uid, courseId) {
  const p = Progress.load(uid);
  return p.batches || [];
}
function reviewQueueForCourse(uid, courseId) {
  const p = Progress.load(uid);
  return p.reviewQueue || [];
}

// ===== Topic taxonomy — normalize raw topic strings into canonical buckets =====
// Topics in answers.json are very granular ("Method Overriding (private)",
// "Wildcards (extends/super)", etc.). We bucket them into ~14 canonical themes
// so the analytics show meaningful aggregates instead of 60 unique labels.
const TOPIC_BUCKETS = [
  { id: 'generics',     name: 'Generics & Wildcards', icon: '🧬', color: '#7c3aed', match: /generic|wildcard|<\?|extends |super /i },
  { id: 'streams',      name: 'Streams API',          icon: '🌊', color: '#0ea5e9', match: /stream/i },
  { id: 'overriding',   name: 'Method Overriding',    icon: '🔁', color: '#f59e0b', match: /overrid/i },
  { id: 'overloading',  name: 'Method Overloading',   icon: '↔️', color: '#ec4899', match: /overload/i },
  { id: 'resolution',   name: 'Method Resolution',    icon: '🎯', color: '#ef4444', match: /method resolution|resolution/i },
  { id: 'inner',        name: 'Inner Classes',        icon: '📦', color: '#8b5cf6', match: /inner class|nested/i },
  { id: 'exceptions',   name: 'Exceptions',           icon: '⚠️', color: '#f97316', match: /exception|try.?catch|throw/i },
  { id: 'equals',       name: 'equals & hashCode',    icon: '🔑', color: '#10b981', match: /equals|hashcode|hashing/i },
  { id: 'iterators',    name: 'Iterators & Iterable', icon: '🔄', color: '#06b6d4', match: /iterator|iterable/i },
  { id: 'lambdas',      name: 'Lambdas & Functional', icon: 'λ',  color: '#3b82f6', match: /lambda|functional|predicate|bifunction|comparator/i },
  { id: 'patterns',     name: 'Design Patterns',      icon: '🏛️', color: '#0d9488', match: /design pattern|observer|factory|bridge|singleton/i },
  { id: 'constructors', name: 'Constructors',         icon: '🏗️', color: '#65a30d', match: /constructor/i },
  { id: 'static',       name: 'Static / Instance',    icon: '⚡', color: '#eab308', match: /static|instance field|instance method/i },
  { id: 'visibility',   name: 'Visibility / Access',  icon: '🔒', color: '#64748b', match: /visibility|private|public|access/i },
  { id: 'casting',      name: 'Casting & Types',      icon: '🎭', color: '#dc2626', match: /cast|classcast|inherit/i },
];
function bucketsForTopic(topicStr) {
  if (!topicStr) return [];
  const found = TOPIC_BUCKETS.filter(b => b.match.test(topicStr));
  return found.length ? found : [{ id: 'other', name: 'אחר', icon: '📌', color: '#94a3b8' }];
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
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-landing'));

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
  document.querySelectorAll('[data-pwa-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.pwa-tab').forEach(t => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      const panel = tab.getAttribute('data-pwa-tab');
      const iosPanel = document.getElementById('pwa-panel-ios');
      const androidPanel = document.getElementById('pwa-panel-android');
      if (iosPanel) iosPanel.hidden = panel !== 'ios';
      if (androidPanel) androidPanel.hidden = panel !== 'android';
    });
  });

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
        const success = document.getElementById('contact-success');
        if (success) {
          success.hidden = false;
          setTimeout(() => { success.hidden = true; }, 5000);
        }
      } catch {
        alert('שגיאה בשליחה. אפשר לשלוח ישירות ל-hi@examprep.app');
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

  // Password show/hide (works for both password fields)
  function bindEyeToggle(btn, input) {
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
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

  // Forgot password (placeholder)
  if (forgotLink) forgotLink.addEventListener('click', (e) => {
    e.preventDefault();
    toast('שחזור סיסמה — בקרוב! בינתיים תוכל ליצור חשבון חדש או להיכנס כאדמין.', '');
  });

  // Google OAuth (placeholder for now)
  const oauthBtn = document.getElementById('oauth-google');
  if (oauthBtn) oauthBtn.addEventListener('click', () => {
    toast('כניסה עם Google — בקרוב! בינתיים השתמש באימייל וסיסמה.', '');
  });

  // Form submit
  document.getElementById('auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = passInput.value;
    const name = document.getElementById('auth-name').value.trim();
    const errEl = document.getElementById('auth-error');
    errEl.textContent = '';
    errEl.classList.remove('success');
    if (!email || !password) { errEl.textContent = 'חובה למלא אימייל וסיסמה'; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'כתובת האימייל לא תקינה'; return; }
    if (mode === 'signup') {
      if (password.length < 8) { errEl.textContent = 'סיסמה חייבת להיות לפחות 8 תווים'; return; }
      if (!/[A-Za-z]/.test(password)) { errEl.textContent = 'סיסמה חייבת להכיל לפחות אות אחת'; return; }
      if (!/\d/.test(password)) { errEl.textContent = 'סיסמה חייבת להכיל לפחות ספרה אחת'; return; }
      const passwordConfirm = passConfirmInput ? passConfirmInput.value : '';
      if (!passwordConfirm) { errEl.textContent = 'נא לאמת את הסיסמה'; return; }
      if (password !== passwordConfirm) { errEl.textContent = 'הסיסמאות לא תואמות'; return; }
      if (!name) { errEl.textContent = 'נא להזין שם מלא'; return; }
    } else {
      if (password.length < 6) { errEl.textContent = 'סיסמה לא תקינה'; return; }
    }
    try {
      const user = Auth.loginLocal(email, password, name);
      state.user = user;
      errEl.classList.add('success');
      errEl.textContent = mode === 'signup' ? 'נרשמת בהצלחה — מעבירים אותך...' : 'התחברת בהצלחה — מעבירים אותך...';
      setTimeout(() => navigate('/dashboard'), 600);
    } catch (err) {
      errEl.textContent = err.message || 'שגיאה לא ידועה';
    }
  });

  // Admin quick-login button
  const adminBtn = document.getElementById('admin-quick-login');
  if (adminBtn) adminBtn.addEventListener('click', async () => {
    const user = Auth.loginAdmin();
    state.user = user;
    // Seed demo learning history so the new screens have content immediately.
    await Data.ensureLoaded();
    if (DemoSeed.shouldSeed(user.email)) {
      DemoSeed.build(user.email);
    }
    toast('ברוך הבא, אדמין. נטענו נתוני דמו מ-10 ימי תרגול.', 'success');
    setTimeout(() => navigate('/dashboard'), 400);
  });
}

// ===== Render: Dashboard =====
async function renderDashboard() {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');

  await Data.ensureLoaded();

  // For the admin user, ensure demo data is seeded so the new screens have
  // realistic content even on the very first dashboard visit.
  if (state.user.isAdmin && DemoSeed.shouldSeed(state.user.email)) {
    DemoSeed.build(state.user.email);
  }

  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-dash'));

  wireTopbar();
  document.getElementById('dash-greet-title').textContent = `שלום ${state.user.name}`;

  // Stats — clean monochrome metric cards with subtle SVG label icons
  const stats = Progress.stats(state.user.email);
  const accuracy = stats.unique > 0 ? Math.round((stats.correct / stats.unique) * 100) : 0;
  const sg = document.getElementById('dash-stats');
  sg.className = 'metric-grid';
  sg.innerHTML = `
    <div class="metric-card">
      <div class="metric-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        סך ניסיונות
      </div>
      <div class="metric-value">${stats.total}</div>
      <div class="metric-sub">${stats.unique} שאלות ייחודיות</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        תשובות נכונות
      </div>
      <div class="metric-value">${stats.correct}</div>
      <div class="metric-sub">דיוק כללי <strong>${accuracy}%</strong></div>
    </div>
    <div class="metric-card">
      <div class="metric-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        טעיתי / הוצגו
      </div>
      <div class="metric-value">${stats.wrong}</div>
      <div class="metric-sub">שאלות שצריך לחזור עליהן</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
        בתור החזרה
      </div>
      <div class="metric-value">${stats.reviewCount}</div>
      <div class="metric-sub">בהמתנה לתרגול חוזר</div>
    </div>
  `;

  // Courses (currently only "תוכנה 1" for admin)
  const cg = document.getElementById('dash-courses');
  const totalQuestions = Data.allQuestions().length;
  const totalExams = Data.metadata.exams.length;
  cg.innerHTML = `
    <div class="course-card" style="--course-color:#3b82f6" data-course="tohna1">
      <h3>תוכנה 1</h3>
      <div class="desc">בנק שאלות אמריקאיות מבחינות עבר של תוכנה 1 — אונ' תל אביב. כולל הסברים מפורטים בעברית לכל שאלה.</div>
      <div class="meta">
        <span>${totalQuestions} שאלות</span>
        <span>${totalExams} מבחנים</span>
        <span class="ready-pill">מוכן לתרגול</span>
      </div>
    </div>
    <div class="course-card add" id="btn-add-course-card">
      <div class="add-card-content">
        <div class="add-icon">+</div>
        <strong>הוסף קורס חדש</strong>
        <small>העלה PDF של מבחן</small>
      </div>
    </div>
  `;

  document.querySelector('[data-course="tohna1"]').addEventListener('click', () => {
    state.course = { id: 'tohna1', name: 'תוכנה 1' };
    showCourseActionsModal(state.course);
  });
  const addBtn = document.getElementById('btn-add-course-card');
  if (addBtn) addBtn.addEventListener('click', () => {
    toast('העלאת PDF — בקרוב! פיצ\'ר זה יופעל בשלב הבא.', '');
  });
  const topAddBtn = document.getElementById('btn-add-course');
  if (topAddBtn) topAddBtn.addEventListener('click', () => {
    toast('העלאת PDF — בקרוב! פיצ\'ר זה יופעל בשלב הבא.', '');
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
      close();
      if (action === 'practice') showBatchModal();
      else if (action === 'lab') navigate('/lab');
      else if (action === 'insights') navigate('/insights');
      else if (action === 'progress') navigate('/progress');
      else if (action === 'study') navigate('/study');
    });
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

  document.getElementById('batch-type').addEventListener('change', (e) => {
    document.getElementById('exam-row').style.display = e.target.value === 'exam' ? '' : 'none';
  });

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
      questions = pickRandom(Data.allQuestions(), size);
    } else if (type === 'exam') {
      const ex = Data.metadata.exams.find(e => e.id === examSelect.value);
      if (!ex) return;
      questions = pickRandom(ex.questions, size);
    } else if (type === 'review') {
      const rq = Progress.load(state.user.email).reviewQueue || [];
      const all = Data.allQuestions().filter(q => rq.includes(q.id));
      if (!all.length) {
        toast('אין שאלות בתור החזרה. תרגל קצת ואז חזור!', '');
        return;
      }
      questions = pickRandom(all, size);
    } else if (type === 'unanswered') {
      const seen = new Set(Progress.history(state.user.email).map(a => a.questionId));
      const all = Data.allQuestions().filter(q => !seen.has(q.id));
      if (!all.length) {
        toast('עברת על כל השאלות! נסה מקבץ אקראי.', 'success');
        return;
      }
      questions = pickRandom(all, size);
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
  navigate('/quiz');
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
    // Replace image with a text/code panel
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

  // Reveal button (hidden in exam mode)
  const revealBtn = document.getElementById('btn-reveal');
  revealBtn.classList.toggle('hidden', state.quiz.examMode);
  revealBtn.addEventListener('click', revealSolution);

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

  // Show solution if already revealed (and not in exam mode)
  if (state.quiz.revealed[q.id] && !state.quiz.examMode) showSolutionPanel(q);

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
}

function revealSolution() {
  if (state.quiz.examMode) return; // disabled in exam mode
  const q = state.quiz.questions[state.quiz.idx];
  if (state.quiz.revealed[q.id]) return;
  const data = Data.reveal(q.id);
  state.quiz.revealed[q.id] = true;
  state.quiz.correctIdxByQ[q.id] = data.correctIdx;
  const sel = state.quiz.selections[q.id];
  state.quiz.correct[q.id] = sel === data.correctIdx;
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
  });
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
  if (exp?.general) {
    html += `<div class="solution-general"><strong>הסבר כללי:</strong>${renderExplanation(exp.general)}</div>`;
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
        <div>${renderExplanation(expTxt)}</div>
      </div>
    `;
  }
  if (!exp) {
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
  state.quiz.correct[q.id] = sel === data.correctIdx;
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
  });
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
  Progress.saveBatch(state.user.email, batchSummary);
  state.lastBatch = batchSummary;
  navigate('/summary');
}

// ===== Render: Summary =====
function renderSummary() {
  if (!state.lastBatch) return navigate('/dashboard');
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-summary'));

  const b = state.lastBatch;
  const score = Math.round((b.correct / b.size) * 100);
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
  state.quiz.questions.forEach((qq, i) => {
    const p = document.createElement('div');
    p.className = 'q-pill';
    if (b.selections[qq.id] == null) p.classList.add('skipped');
    else if (b.correctMap[qq.id]) p.classList.add('correct');
    else p.classList.add('wrong');
    p.textContent = i + 1;
    pillsEl.appendChild(p);
  });

  document.getElementById('btn-mistake-review').addEventListener('click', () => navigate('/review'));
  document.getElementById('btn-summary-home').addEventListener('click', () => navigate('/dashboard'));

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
  // Get all questions that were wrong or skipped
  const wrongQs = state.quiz.questions.filter(q => {
    const sel = b.selections[q.id];
    return sel == null || !b.correctMap[q.id];
  });

  if (!wrongQs.length) {
    $app.innerHTML = '<div class="loader-screen"><div><h2>אין טעויות לסקור! 🎉</h2><p style="margin-top:14px"><a href="#/dashboard" class="btn btn-primary" data-route="/dashboard">חזרה למסך הבית</a></p></div></div>';
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
    const correctIdx = data.correctIdx;
    const exam = Data.metadata.exams.find(e => e.id === q.examId);
    const exp = data.explanation;

    document.getElementById('review-pos').textContent = `שאלה ${idx + 1} מתוך ${wrongQs.length}`;
    document.getElementById('review-sub').textContent = sel == null ? 'שאלה שדילגת עליה' : 'שאלה שטעית בה';

    const yourLabel = sel == null ? 'דילגת' : (labels[sel - 1] || `אפשרות ${sel}`);
    const correctLabel = labels[correctIdx - 1] || `אפשרות ${correctIdx}`;

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
          ${exp?.general ? `<div class="general">${renderExplanation(exp.general)}</div>` : ''}
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
          <div>${renderExplanation(expTxt)}</div>
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
  document.getElementById('review-back').addEventListener('click', () => navigate('/dashboard'));

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
    return pickRandom(hard.map(h => h.q), size);
  }

  if (style === 'weak') {
    const weakBuckets = analysis.filter(b => b.accuracy != null && b.accuracy < 0.6);
    if (!weakBuckets.length) {
      // Fallback to hard if user has no weak buckets yet
      return buildMockExam(courseId, { size, style: 'hard' });
    }
    const pool = weakBuckets.flatMap(b => b.qids);
    const poolQs = questions.filter(q => pool.includes(q.id));
    return pickRandom(poolQs, size);
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
    return pickRandom(stale.length ? stale : questions, size);
  }

  // BALANCED: distribute slots across topic buckets proportionally to frequency
  const totalCount = analysis.reduce((s, b) => s + b.count, 0);
  if (totalCount === 0) return pickRandom(questions, size);
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
  // Shuffle final order so the user doesn't see all "Generics" in a row
  return pickRandom(picked, picked.length);
}

// ===== Render: Insights =====
async function renderInsights() {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');
  if (!state.course) state.course = { id: 'tohna1', name: 'תוכנה 1' };

  await Data.ensureLoaded();
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-insights'));
  wireTopbar();

  const uid = state.user.email;
  const courseId = state.course.id;
  const questions = questionsForCourse(courseId);
  const exams = examsForCourse(courseId);
  const attempts = attemptsForCourse(uid, courseId);
  const analysis = analyzeQuestionBank(questions, attempts);
  const hard = identifyHardQuestions(questions, attempts, 12);

  // Banner
  const minRecommended = 3;
  const banner = document.getElementById('insights-banner');
  const examCount = exams.length;
  if (examCount < minRecommended) {
    banner.className = 'insights-banner warn';
    banner.innerHTML = `<strong>הניתוח יעבוד טוב יותר עם יותר מבחנים.</strong> כרגע יש בקורס "${escapeHtml(state.course.name)}" רק <strong>${examCount}</strong> מבחנים. המלצה: לפחות <strong>${minRecommended}</strong> מבחנים שונים כדי שנוכל לזהות דפוסים אמיתיים של מה שחוזר.`;
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

// ===== Render: Lab =====
async function renderLab() {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');
  if (!state.course) state.course = { id: 'tohna1', name: 'תוכנה 1' };

  await Data.ensureLoaded();
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-lab'));
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
  document.querySelectorAll('.mode-pill').forEach(p => {
    p.addEventListener('click', () => {
      mockMode = p.dataset.mode;
      const parent = p.closest('.lab-mode-pills');
      parent.querySelectorAll('.mode-pill').forEach(x => x.classList.toggle('active', x === p));
    });
  });
  document.querySelectorAll('.source-pill').forEach(p => {
    p.addEventListener('click', () => {
      mockSource = p.dataset.source;
      document.querySelectorAll('.source-pill').forEach(x => x.classList.toggle('active', x === p));
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
      const res = await fetch('/api/lab/generate-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        if (data?.reason === 'no_api_key') {
          result.innerHTML = `
            <div class="ai-error">
              <strong>🔧 מפתח ה-API של הבינה המלאכותית עוד לא מוגדר בשרת.</strong>
              <p>כדי להפעיל את הפיצ'ר הזה, הוסף <code>GEMINI_API_KEY</code> לקובץ ה-.env של השרת ואז הפעל מחדש. אפשר לקבל מפתח חינמי ב-aistudio.google.com/apikey.</p>
            </div>
          `;
        } else {
          result.innerHTML = `<div class="ai-error">❌ ${escapeHtml(data?.error || 'שגיאה לא ידועה')}</div>`;
        }
        return;
      }
      // Render generated questions with delete buttons
      let aiPool = [...data.questions];
      function renderAiPool() {
        if (!aiPool.length) {
          result.innerHTML = '<div class="ai-error">הסרת את כל השאלות. צור שאלות חדשות.</div>';
          return;
        }
        result.innerHTML = `
          <div class="ai-success">✨ ${aiPool.length} שאלות מוכנות לתרגול</div>
          <div class="ai-questions">
            ${aiPool.map((q, i) => renderAiQuestion(q, i)).join('')}
          </div>
          <div class="ai-actions">
            <button class="btn btn-primary btn-lg" id="btn-practice-ai">🎯 תרגל ${aiPool.length} שאלות</button>
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
      }
      renderAiPool();
    } catch (err) {
      result.innerHTML = `<div class="ai-error">❌ שגיאת רשת: ${escapeHtml(err.message || String(err))}</div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '✨ צור שאלות חכמות';
    }
  });
}

function renderAiQuestion(q, i) {
  return `
    <div class="ai-q-card">
      <div class="ai-q-head">
        <span class="ai-q-num">שאלה ${i + 1}</span>
        <span class="ai-q-topic">${escapeHtml(q.topic)}</span>
        <span class="ai-q-diff ai-q-diff-${q.difficulty}">${q.difficulty === 'hard' ? 'קשה' : q.difficulty === 'medium' ? 'בינוני' : 'קל'}</span>
        <button class="ai-q-remove" data-remove-ai-q="${i}" title="הסר שאלה">✕</button>
      </div>
      ${q.code ? `<pre class="ai-q-code"><code>${escapeHtml(q.code)}</code></pre>` : ''}
      <div class="ai-q-stem">${escapeHtml(q.stem)}</div>
      <ol class="ai-q-options">
        ${q.options.map((opt, j) => `
          <li class="${j + 1 === q.correctIdx ? 'correct' : ''}">
            <span class="opt-num">${j + 1}</span>
            <span>${escapeHtml(opt)}</span>
            ${j + 1 === q.correctIdx ? '<span class="opt-mark">✓</span>' : ''}
          </li>
        `).join('')}
      </ol>
      <details class="ai-q-explain">
        <summary>הצג פתרון מלא</summary>
        <div class="ai-q-explain-body">
          ${q.explanationGeneral ? `<p><strong>הסבר כללי:</strong> ${escapeHtml(q.explanationGeneral)}</p>` : ''}
          ${q.optionExplanations?.length ? `
            <div class="ai-q-opt-exps">
              ${q.optionExplanations.map((e, j) => `
                <div class="${j + 1 === q.correctIdx ? 'correct' : 'wrong'}">
                  <strong>${j + 1}.</strong> ${escapeHtml(e || '')}
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      </details>
    </div>
  `;
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
  if (!state.course) state.course = { id: 'tohna1', name: 'תוכנה 1' };

  await Data.ensureLoaded();
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-progress'));
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
  const stats = Progress.stats(uid);
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
        <strong>${stats.unique} / ${questions.length}</strong>
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
        navigate('/summary');
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
        if (r === 'practice') showBatchModal();
        else if (r === 'insights') navigate('/insights');
        else if (r === 'progress') navigate('/progress');
      });
    });
  }
}

// ===== Shared topbar wiring =====
function wireTopbar() {
  document.querySelectorAll('[data-route]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const r = link.getAttribute('data-route');
      if (r) navigate(r);
    });
  });
  // User info
  const planEl = document.getElementById('user-plan');
  const nameEl = document.getElementById('user-name');
  const avatarEl = document.getElementById('user-avatar');
  if (nameEl) nameEl.textContent = state.user.name;
  if (avatarEl) avatarEl.textContent = (state.user.name || 'U').slice(0, 1).toUpperCase();
  if (planEl) {
    planEl.textContent = state.user.plan;
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

  const planLabel = (state.user.plan || 'free').toUpperCase();
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
  free:      { label: 'FREE',      desc: '2 חבילות לימוד · 5 קבצי PDF · ללא AI' },
  basic:     { label: 'BASIC',     desc: '30 חבילות · 30 PDFs · 100 שאלות AI · 5 קורסים' },
  pro:       { label: 'PRO',       desc: '150 PDFs · 500 שאלות AI · קורסים ללא הגבלה' },
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
  document.getElementById('settings-email-input').value = u.email || '';
  document.getElementById('settings-save-profile').addEventListener('click', () => {
    const newName = document.getElementById('settings-name-input').value.trim();
    if (!newName) return;
    state.user = Auth.update({ name: newName });
    document.getElementById('settings-name').textContent = newName;
    document.getElementById('settings-avatar').textContent = newName.slice(0, 1).toUpperCase();
    const status = document.getElementById('settings-save-status');
    status.textContent = 'נשמר ✓';
    status.classList.add('is-ok');
    setTimeout(() => { status.textContent = ''; status.classList.remove('is-ok'); }, 2200);
  });

  // Plan section
  const planInfo = PLAN_INFO[u.plan] || PLAN_INFO.free;
  document.getElementById('settings-plan-name').textContent = planInfo.label;
  document.getElementById('settings-plan-meta').textContent = planInfo.desc;
  document.querySelectorAll('.settings-plan-tile').forEach(tile => {
    if (tile.dataset.plan === u.plan) tile.classList.add('is-current');
    tile.addEventListener('click', () => {
      const newPlan = tile.dataset.plan;
      if (newPlan === u.plan) return;
      if (!confirm(`האם להחליף תוכנית ל-${(PLAN_INFO[newPlan] || {label: newPlan}).label}?\n\n(זהו שינוי מקומי בלבד — חיוב אמיתי יחובר ב-Phase 2)`)) return;
      state.user = Auth.update({ plan: newPlan });
      renderSettings('plan');
    });
  });
  document.getElementById('settings-upgrade-btn').addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = '#pricing';
    navigate('/');
  });
  document.getElementById('settings-manage-billing').addEventListener('click', () => {
    alert('ניהול חיוב יתחבר ל-Stripe ב-Phase 2.\nכרגע אין נתוני חיוב אמיתיים.');
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
      progress: (typeof Progress !== 'undefined' && Progress.load) ? Progress.load(state.user.email) : null,
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
  document.getElementById('settings-delete-account').addEventListener('click', () => {
    if (!confirm('למחוק לצמיתות את החשבון שלך וכל הנתונים?\nפעולה זו לא ניתנת לביטול.')) return;
    if (!confirm('זוהי הזדמנות אחרונה. למחוק לצמיתות?')) return;
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
    const idx = all.findIndex(p => p.id === pack.id);
    if (idx >= 0) all[idx] = pack; else all.unshift(pack);
    localStorage.setItem(this.KEY, JSON.stringify(all));
  },
  remove(id) {
    const all = this.list().filter(p => String(p.id) !== String(id));
    localStorage.setItem(this.KEY, JSON.stringify(all));
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
  // Free plan quota: 2 lifetime packs. Admins/paid users get unlimited in
  // local mode (we use the mock plan field).
  quotaForUser(user) {
    const plan = (user && user.plan) || 'free';
    if (plan === 'free') return { lifetime: 2, used: this.usedTotal(), unlimited: false };
    return { lifetime: -1, used: this.usedTotal(), unlimited: true };
  },
};

function showPaywallModal() {
  const wrap = document.createElement('div');
  wrap.appendChild(tmpl('tmpl-paywall-modal'));
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('paywall-modal');
  const close = () => modal.remove();
  document.getElementById('paywall-close').addEventListener('click', close);
  document.getElementById('paywall-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('paywall-upgrade').addEventListener('click', (e) => {
    close();
    setTimeout(() => { location.hash = '#pricing'; navigate('/'); }, 0);
  });
}

async function renderStudyList() {
  if (!state.user) return navigate('/login');
  const tpl = tmpl('tmpl-study-list');
  $app.innerHTML = '';
  $app.appendChild(tpl);

  document.getElementById('user-name').textContent = state.user.name || '';
  document.getElementById('user-plan').textContent = state.user.plan || 'free';
  document.getElementById('user-avatar').textContent = (state.user.name || 'U').charAt(0).toUpperCase();
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    Auth.clear(); state.user = null; navigate('/');
  });
  document.querySelectorAll('[data-route]').forEach(link => {
    link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.getAttribute('data-route')); });
  });

  const packs = StudyStore.list();
  const quota = StudyStore.quotaForUser(state.user);
  const banner = document.getElementById('study-quota-banner');
  if (!quota.unlimited) {
    const left = Math.max(0, quota.lifetime - quota.used);
    banner.innerHTML = `
      <div class="quota-pill ${left === 0 ? 'quota-pill-empty' : ''}">
        <span class="quota-pill-icon">${left === 0 ? '🔒' : '✨'}</span>
        <div>
          <strong>נשארו לך ${left} מתוך ${quota.lifetime} חבילות לימוד חינמיות</strong>
          <small>${left === 0 ? 'שדרג ל-Basic כדי ליצור חבילות נוספות' : 'תשתמש בהן ליצור חומרי לימוד מסיכומים שונים'}</small>
        </div>
      </div>`;
  } else {
    banner.innerHTML = `<div class="quota-pill quota-pill-unlimited"><span class="quota-pill-icon">⭐</span><div><strong>חבילות לימוד ללא הגבלה</strong><small>מסלול ${state.user.plan}</small></div></div>`;
  }

  const grid = document.getElementById('study-list-grid');
  const empty = document.getElementById('study-empty');
  if (!packs.length) {
    grid.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
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
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm('למחוק את החבילה?')) return;
      StudyStore.remove(btn.dataset.delete);
      renderStudyList();
    });
  });
}

async function renderStudyCreate() {
  if (!state.user) return navigate('/login');
  const tpl = tmpl('tmpl-study-create');
  $app.innerHTML = '';
  $app.appendChild(tpl);

  document.getElementById('user-name').textContent = state.user.name || '';
  document.getElementById('user-plan').textContent = state.user.plan || 'free';
  document.getElementById('user-avatar').textContent = (state.user.name || 'U').charAt(0).toUpperCase();
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    Auth.clear(); state.user = null; navigate('/');
  });
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
      showPaywallModal();
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
      body = JSON.stringify({ kind: 'paste', text, title });
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
      body = fd;
    }

    submit.disabled = true;
    btnLabel.style.display = 'none';
    btnSpinner.style.display = '';

    // Animated progress indicator so user knows it's working
    const steps = [
      { text: '📤 מעלה את הקובץ...', pct: 10 },
      { text: '📖 קורא את התוכן...', pct: 25 },
      { text: '🧠 הבינה המלאכותית מנתחת את החומר...', pct: 40 },
      { text: '✍️ יוצר שאלות אמריקאיות...', pct: 55 },
      { text: '🃏 בונה כרטיסיות ומתאר...', pct: 70 },
      { text: '📝 מכין מבחן עצמי ומילון מושגים...', pct: 85 },
      { text: '✨ כמעט מוכן...', pct: 95 },
    ];
    let stepIdx = 0;
    const progressBar = document.createElement('div');
    progressBar.className = 'study-progress-wrap';
    progressBar.innerHTML = `
      <div class="study-progress-bar"><div class="study-progress-fill" style="width:5%"></div></div>
      <div class="study-progress-step">${steps[0].text}</div>
    `;
    submit.parentElement.insertBefore(progressBar, submit.nextSibling);
    const fill = progressBar.querySelector('.study-progress-fill');
    const stepLabel = progressBar.querySelector('.study-progress-step');

    const progressTimer = setInterval(() => {
      if (stepIdx < steps.length) {
        fill.style.width = steps[stepIdx].pct + '%';
        stepLabel.textContent = steps[stepIdx].text;
        stepIdx++;
      }
    }, stepIdx === 0 ? 1500 : 4000);
    // First step fires quickly, then every 4s
    setTimeout(() => {
      if (stepIdx < steps.length) {
        fill.style.width = steps[stepIdx].pct + '%';
        stepLabel.textContent = steps[stepIdx].text;
        stepIdx++;
      }
    }, 1500);

    btnSpinner.textContent = '⏳ יוצר חבילת לימוד...';

    try {
      const res = await fetch('/api/study/generate', { method: 'POST', headers, body });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 402 && data.needs_upgrade) {
          showPaywallModal();
          return;
        }
        errBox.textContent = data.error || 'שגיאה ביצירת חבילת הלימוד.';
        return;
      }

      // Persist locally and bump quota
      const packTitle = data.title || (activeTab === 'paste'
        ? (document.getElementById('study-title-paste').value.trim() || 'סיכום ללא שם')
        : (fileInput.files[0].name.replace(/\.pdf$/i, '') || 'סיכום ללא שם'));
      const pack = {
        id: 'local_' + Date.now(),
        title: packTitle,
        courseName: state.course?.name || packTitle,
        source_kind: data.source_kind || activeTab,
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
      clearInterval(progressTimer);
      progressBar?.remove();
      submit.disabled = false;
      btnLabel.style.display = '';
      btnSpinner.style.display = 'none';
    }
  });
}

async function renderStudyPack(packId) {
  if (!state.user) return navigate('/login');
  const pack = StudyStore.get(packId);
  if (!pack) {
    toast('חבילת הלימוד לא נמצאה', 'error');
    return navigate('/study');
  }
  const tpl = tmpl('tmpl-study-pack');
  $app.innerHTML = '';
  $app.appendChild(tpl);

  document.getElementById('user-name').textContent = state.user.name || '';
  document.getElementById('user-plan').textContent = state.user.plan || 'free';
  document.getElementById('user-avatar').textContent = (state.user.name || 'U').charAt(0).toUpperCase();
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    Auth.clear(); state.user = null; navigate('/');
  });
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

// ===== Boot =====
(function boot() {
  Theme.init();
  state.user = Auth.current();
  if (!location.hash) location.hash = '#/';
  renderRoute();
})();
