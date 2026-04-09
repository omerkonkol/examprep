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
  return renderLanding();
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
    passInput.placeholder = mode === 'signup' ? 'בחר סיסמה חזקה' : 'הזן סיסמה';
    passInput.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  }
  applyMode();

  tabs.forEach(t => t.addEventListener('click', () => {
    mode = t.dataset.tab;
    applyMode();
  }));

  // Password show/hide
  if (togglePass) togglePass.addEventListener('click', () => {
    if (passInput.type === 'password') {
      passInput.type = 'text';
      togglePass.textContent = '🙈';
    } else {
      passInput.type = 'password';
      togglePass.textContent = '👁';
    }
  });

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
  });

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
  if (adminBtn) adminBtn.addEventListener('click', () => {
    const user = Auth.loginAdmin();
    state.user = user;
    toast('ברוך הבא, אדמין!', 'success');
    setTimeout(() => navigate('/dashboard'), 400);
  });
}

// ===== Render: Dashboard =====
async function renderDashboard() {
  if (!state.user) state.user = Auth.current();
  if (!state.user) return navigate('/login');

  await Data.ensureLoaded();
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-dash'));

  document.querySelectorAll('[data-route]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.getAttribute('data-route'));
    });
  });

  // User info
  document.getElementById('user-name').textContent = state.user.name;
  document.getElementById('user-avatar').textContent = (state.user.name || 'U').slice(0, 1).toUpperCase();
  const planEl = document.getElementById('user-plan');
  planEl.textContent = state.user.plan;
  if (state.user.plan === 'pro' || state.user.plan === 'education') planEl.classList.add('pro');
  document.getElementById('dash-greet-title').textContent = `שלום ${state.user.name}! 👋`;

  document.getElementById('btn-logout').addEventListener('click', () => {
    Auth.clear();
    state.user = null;
    navigate('/');
  });

  // Stats
  const stats = Progress.stats(state.user.email);
  const sg = document.getElementById('dash-stats');
  sg.innerHTML = `
    <div class="stat-card brand"><div class="label">סה"כ ניסיונות</div><div class="value">${stats.total}</div></div>
    <div class="stat-card success"><div class="label">תשובות נכונות (ייחודיות)</div><div class="value">${stats.correct}</div></div>
    <div class="stat-card danger"><div class="label">טעיתי / הוצגו</div><div class="value">${stats.wrong}</div></div>
    <div class="stat-card warn"><div class="label">בתור החזרה</div><div class="value">${stats.reviewCount}</div></div>
  `;

  // Courses (currently only "תוכנה 1" for admin)
  const cg = document.getElementById('dash-courses');
  const totalQuestions = Data.allQuestions().length;
  const totalExams = Data.metadata.exams.length;
  cg.innerHTML = `
    <div class="course-card" style="--course-color:#3933e0" data-course="tohna1">
      <h3>תוכנה 1</h3>
      <div class="desc">בנק שאלות אמריקאיות מבחינות עבר של תוכנה 1 — אונ' תל אביב. כולל הסברים מפורטים בעברית לכל שאלה.</div>
      <div class="meta">
        <span><strong>${totalQuestions}</strong> שאלות</span>
        <span><strong>${totalExams}</strong> מבחנים</span>
        <span class="ready-pill">● מוכן לתרגול</span>
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
    showBatchModal();
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

  // Image
  document.getElementById('quiz-image').src = Data.imageUrl(q.image);

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

  // Emoji + title based on score
  let emoji = '🎉', title = 'מצוין!';
  if (score >= 90) { emoji = '🏆'; title = 'מושלם!'; }
  else if (score >= 75) { emoji = '🎯'; title = 'מצוין!'; }
  else if (score >= 60) { emoji = '👍'; title = 'יפה מאוד!'; }
  else if (score >= 40) { emoji = '💪'; title = 'יש מה לתרגל'; }
  else { emoji = '📚'; title = 'בוא נלמד מהטעויות'; }
  document.getElementById('summary-emoji').textContent = emoji;
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
    $app.innerHTML = '<div class="loader-screen"><div><h2>אין טעויות לסקור! 🎉</h2><p style="margin-top:14px"><a href="#/dashboard" class="btn btn-primary" data-route="/dashboard">חזרה לדשבורד</a></p></div></div>';
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

// ===== Boot =====
(function boot() {
  state.user = Auth.current();
  if (!location.hash) location.hash = '#/';
  renderRoute();
})();
