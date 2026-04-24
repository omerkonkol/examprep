// Repair script: find the broken question, re-run Gemini to get correct
// bounding box + answer, update DB.
// Usage: node --env-file=.env.local scripts/repair-broken-question.mjs
//
// Identifies the broken question by comparing crop heights across the same
// question_number in the same course — a suspiciously small h indicates a
// bad reanalyze crop.

import { createClient } from '@supabase/supabase-js';
import { reanalyzeSingleQuestion } from '../api/_lib/gemini-solution.mjs';
import { createHash } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLOUD_NAME   = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUD_KEY    = (process.env.CLOUDINARY_API_KEY || '').trim();
const CLOUD_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim();

if (!SUPABASE_URL || !SERVICE_ROLE) { console.error('Missing Supabase env vars'); process.exit(1); }
if (!CLOUD_NAME) { console.error('Missing CLOUDINARY_CLOUD_NAME'); process.exit(1); }

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── helpers ──────────────────────────────────────────────────────────────────
const RENDER_W = 1600;

async function fetchPdfBase64(publicId) {
  const errors = [];
  async function tryUrl(url, label) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.ok) return { ok: true, base64: Buffer.from(await r.arrayBuffer()).toString('base64') };
      errors.push(`${label}: HTTP ${r.status}`);
    } catch (e) { errors.push(`${label}: ${e.message}`); }
    return null;
  }

  let ok = await tryUrl(`https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${publicId}.pdf`, 'unsigned');
  if (ok) return ok;

  if (CLOUD_SECRET) {
    const b64 = buf => buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const toSign = publicId + CLOUD_SECRET;
    const sig1 = b64(createHash('sha1').update(toSign).digest()).slice(0, 8);
    ok = await tryUrl(`https://res.cloudinary.com/${CLOUD_NAME}/image/upload/s--${sig1}--/${publicId}.pdf`, 'sha1');
    if (ok) return ok;
    const sig2 = b64(createHash('sha256').update(toSign).digest()).slice(0, 32);
    ok = await tryUrl(`https://res.cloudinary.com/${CLOUD_NAME}/image/upload/s--${sig2}--/${publicId}.pdf`, 'sha256');
    if (ok) return ok;
  }
  if (CLOUD_KEY && CLOUD_SECRET) {
    const ts = Math.floor(Date.now() / 1000);
    const params = { format: 'pdf', public_id: publicId, timestamp: String(ts), type: 'upload' };
    const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&') + CLOUD_SECRET;
    const sig = createHash('sha1').update(toSign).digest('hex');
    const qs = new URLSearchParams({ ...params, api_key: CLOUD_KEY, signature: sig }).toString();
    ok = await tryUrl(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/download?${qs}`, 'admin-dl');
    if (ok) return ok;
  }
  return { ok: false, error: errors.join(' | ') };
}

function buildCropUrl(publicId, page, yTopPct, yBotPct, pageH = 842, pageW = 595) {
  const scale = RENDER_W / pageW;
  const renderH = Math.round(RENDER_W * (pageH / pageW));
  const yTopPt = Math.max(0, (yTopPct / 100) * pageH - 8);
  const yBotPt = Math.min(pageH - 5, (yBotPct / 100) * pageH + 8);
  const yPx = Math.max(0, Math.round((yTopPt) * scale));
  const rawH = Math.round((yBotPt - yTopPt) * scale);
  const hPx = Math.max(200, Math.min(renderH - yPx, rawH));
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/pg_${page},w_${RENDER_W}/c_crop,w_${RENDER_W},h_${hPx},y_${yPx},g_north/q_auto/${publicId}.png`;
}

// ── parse crop params from an existing image_path URL ────────────────────────
function parseCropH(url) {
  const m = url?.match(/,h_(\d+),/);
  return m ? parseInt(m[1], 10) : null;
}

// ── main ─────────────────────────────────────────────────────────────────────

// Find user
const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
const user = users.users.find(u => u.email === 'omerkol123@gmail.com');
if (!user) { console.error('User not found'); process.exit(1); }

// Get all question_number=2 from מודלים חישוביים exams with full image_path
const { data: courses } = await admin.from('ep_courses').select('id').eq('user_id', user.id).ilike('name', '%מודלים%');
const courseIds = courses.map(c => c.id);
const { data: exams } = await admin.from('ep_exams').select('id, name, exam_pdf_path, solution_pdf_path').in('course_id', courseIds);
const examIds = exams.map(e => e.id);
const { data: questions } = await admin.from('ep_questions').select('id, question_number, image_path, num_options, correct_idx, exam_id').in('exam_id', examIds).eq('question_number', 2);

console.log('\nAll question_number=2 for מודלים חישוביים:');
for (const q of questions) {
  const h = parseCropH(q.image_path);
  const exam = exams.find(e => e.id === q.exam_id);
  console.log(`  id=${q.id} exam=${exam?.name} h=${h} correct_idx=${q.correct_idx}`);
}

// The broken one has the smallest h (reanalyze set it to a tiny crop)
const sorted = [...questions].sort((a, b) => (parseCropH(a.image_path) || 9999) - (parseCropH(b.image_path) || 9999));
const broken = sorted[0];
const brokenH = parseCropH(broken.image_path);
const medianH = sorted[Math.floor(sorted.length / 2)];
const medianHeight = parseCropH(medianH.image_path);

console.log(`\nIdentified likely broken question: id=${broken.id}, h=${brokenH} (median h=${medianHeight})`);
if (brokenH >= medianHeight * 0.7) {
  console.log('All crop heights are similar — no obviously broken question found.');
  console.log('Proceeding with the smallest-h question anyway...');
}

const exam = exams.find(e => e.id === broken.exam_id);
console.log(`Exam: ${exam?.name} (id=${exam?.id})`);
console.log(`Current image_path: ${broken.image_path?.slice(0, 150)}`);

// Download PDFs
console.log('\nDownloading PDFs...');
const [examRes, solRes] = await Promise.all([
  exam.exam_pdf_path ? fetchPdfBase64(exam.exam_pdf_path) : Promise.resolve({ ok: false }),
  exam.solution_pdf_path ? fetchPdfBase64(exam.solution_pdf_path) : Promise.resolve({ ok: false }),
]);
if (!examRes.ok) { console.error('Failed to download exam PDF:', examRes.error); process.exit(1); }
console.log(`Exam PDF: ${(examRes.base64.length * 0.75 / 1024).toFixed(0)} KB`);
console.log(`Solution PDF: ${solRes.ok ? ((solRes.base64.length * 0.75 / 1024).toFixed(0) + ' KB') : 'not available'}`);

// Run Gemini reanalysis
console.log('\nRunning Gemini reanalysis for question #2...');
const result = await reanalyzeSingleQuestion(
  examRes.base64,
  solRes.ok ? solRes.base64 : null,
  2,
  null,
);
if (!result) { console.error('Gemini returned null — cannot repair'); process.exit(1); }
console.log(`Gemini result: page=${result.page} y_top=${result.y_top} y_bottom=${result.y_bottom} num_options=${result.num_options} correct_idx=${result.correct_idx} confidence=${result.confidence}`);

// Gemini sometimes returns absolute PDF points instead of percentages.
// Detect: if y_top or y_bottom > 100, treat as points and convert.
const pageH = result.page_h || 842;
let yTopPct = result.y_top;
let yBotPct = result.y_bottom;
if (yTopPct > 100 || yBotPct > 100) {
  console.log(`Detected absolute pt coords — converting to % (pageH=${pageH})`);
  yTopPct = (yTopPct / pageH) * 100;
  yBotPct = (yBotPct / pageH) * 100;
}

// Validate coordinates
const ySpan = yBotPct - yTopPct;
if (!Number.isFinite(yTopPct) || !Number.isFinite(yBotPct) || ySpan < 3 || ySpan > 75) {
  console.error(`Gemini returned suspicious coordinates (span=${ySpan.toFixed(1)}%) — aborting`);
  process.exit(1);
}

// Build repair URL
const newUrl = buildCropUrl(exam.exam_pdf_path, result.page, yTopPct, yBotPct, pageH, result.page_w || 595);
console.log(`\nNew image_path: ${newUrl.slice(0, 150)}`);

// Update DB
const updatePayload = { image_path: newUrl };
if (Number.isFinite(parseInt(result.correct_idx, 10))) {
  const ans = parseInt(result.correct_idx, 10);
  if (ans >= 1 && ans <= (result.num_options || 10)) {
    updatePayload.correct_idx = ans;
    updatePayload.answer_confidence = (result.confidence || 0) >= 0.7 ? 'confirmed' : 'uncertain';
  }
}
if (typeof result.question_text === 'string' && result.question_text.trim().length >= 5) {
  updatePayload.question_text = result.question_text.trim();
}
if (result.options && typeof result.options === 'object') {
  const opts = {};
  for (const [k, v] of Object.entries(result.options)) {
    const idx = parseInt(k, 10);
    if (idx >= 1 && idx <= 10 && typeof v === 'string') opts[idx] = v.trim();
  }
  if (Object.keys(opts).length >= 2) updatePayload.options_text = opts;
}

console.log(`Updating fields: ${Object.keys(updatePayload).join(', ')}`);
const { error } = await admin.from('ep_questions').update(updatePayload).eq('id', broken.id);
if (error) { console.error('Update failed:', error.message); process.exit(1); }
console.log(`\nRepaired question id=${broken.id}`);
if (updatePayload.correct_idx) console.log(`  correct_idx: ${broken.correct_idx} -> ${updatePayload.correct_idx}`);
console.log('Done.');
