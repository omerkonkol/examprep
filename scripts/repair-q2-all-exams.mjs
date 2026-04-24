// Fix question #2 correct_idx + image for all מודלים חישוביים exams.
// For exams without exam_pdf_path, extracts the PDF public_id from the
// question's image_path URL (both point to the same Cloudinary asset).
// Usage: node --env-file=.env.local scripts/repair-q2-all-exams.mjs

import { createClient } from '@supabase/supabase-js';
import { reanalyzeSingleQuestion } from '../api/_lib/gemini-solution.mjs';
import { createHash } from 'node:crypto';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_ROLE  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLOUD_NAME    = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUD_KEY     = (process.env.CLOUDINARY_API_KEY || '').trim();
const CLOUD_SECRET  = (process.env.CLOUDINARY_API_SECRET || '').trim();

if (!SUPABASE_URL || !SERVICE_ROLE) { console.error('Missing Supabase env vars'); process.exit(1); }

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// ── helpers ──────────────────────────────────────────────────────────────────
async function fetchPdfBase64(publicId) {
  const errors = [];
  async function tryUrl(url, label) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer()).toString('base64');
      errors.push(`${label}: HTTP ${r.status}`);
    } catch (e) { errors.push(`${label}: ${e.message}`); }
    return null;
  }

  let b64 = await tryUrl(`https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${publicId}.pdf`, 'unsigned');
  if (b64) return b64;

  if (CLOUD_SECRET) {
    const enc = buf => buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const toSign = publicId + CLOUD_SECRET;
    const sig1 = enc(createHash('sha1').update(toSign).digest()).slice(0,8);
    b64 = await tryUrl(`https://res.cloudinary.com/${CLOUD_NAME}/image/upload/s--${sig1}--/${publicId}.pdf`, 'sha1');
    if (b64) return b64;
    const sig2 = enc(createHash('sha256').update(toSign).digest()).slice(0,32);
    b64 = await tryUrl(`https://res.cloudinary.com/${CLOUD_NAME}/image/upload/s--${sig2}--/${publicId}.pdf`, 'sha256');
    if (b64) return b64;
  }
  if (CLOUD_KEY && CLOUD_SECRET) {
    const ts = Math.floor(Date.now()/1000);
    const params = { format:'pdf', public_id: publicId, timestamp: String(ts), type:'upload' };
    const toSign = Object.keys(params).sort().map(k=>`${k}=${params[k]}`).join('&') + CLOUD_SECRET;
    const sig = createHash('sha1').update(toSign).digest('hex');
    const qs = new URLSearchParams({...params, api_key: CLOUD_KEY, signature: sig}).toString();
    b64 = await tryUrl(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/download?${qs}`, 'admin-dl');
    if (b64) return b64;
  }
  console.warn(`  PDF download failed: ${errors.join(' | ')}`);
  return null;
}

// Extract exam PDF public_id from a question's image_path Cloudinary URL.
// Format: https://res.cloudinary.com/{cloud}/image/upload/{transforms}/q_auto/{publicId}.png
function extractPublicId(imageUrl) {
  if (!imageUrl) return null;
  const m = imageUrl.match(/\/q_auto\/(.+?)\.png(?:\?|$)/);
  if (m) return m[1];
  // Fallback: everything after last q_auto/
  const idx = imageUrl.indexOf('/q_auto/');
  if (idx !== -1) return imageUrl.slice(idx + 8).replace(/\.png.*$/, '');
  return null;
}

function buildCropUrl(publicId, page, yTopPct, yBotPct, pageH=842, pageW=595) {
  const scale = 1600 / pageW;
  const renderH = Math.round(1600 * (pageH / pageW));
  const yTopPt = Math.max(0, (yTopPct/100)*pageH - 8);
  const yBotPt = Math.min(pageH - 5, (yBotPct/100)*pageH + 8);
  const yPx = Math.max(0, Math.round(yTopPt * scale));
  const hPx = Math.max(200, Math.min(renderH - yPx, Math.round((yBotPt - yTopPt) * scale)));
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/pg_${page},w_1600/c_crop,w_1600,h_${hPx},y_${yPx},g_north/q_auto/${publicId}.png`;
}

// ── main ─────────────────────────────────────────────────────────────────────
const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
const user = users.users.find(u => u.email === 'omerkol123@gmail.com');
if (!user) { console.error('User not found'); process.exit(1); }

const { data: courses } = await admin.from('ep_courses').select('id').eq('user_id', user.id).ilike('name', '%מודלים%');
const courseIds = courses.map(c => c.id);
const { data: exams } = await admin.from('ep_exams').select('id,name,exam_pdf_path,solution_pdf_path').in('course_id', courseIds);
const examIds = exams.map(e => e.id);

const { data: questions } = await admin.from('ep_questions')
  .select('id,question_number,correct_idx,num_options,image_path,exam_id')
  .in('exam_id', examIds)
  .eq('question_number', 2);

console.log(`Found ${questions.length} question(s) with number=2 across ${exams.length} exams\n`);

for (const q of questions) {
  const exam = exams.find(e => e.id === q.exam_id);
  console.log(`\n═══ ${exam.name} (exam_id=${exam.id}, question_id=${q.id}) correct_idx=${q.correct_idx} ═══`);

  // Determine exam PDF public_id
  let examPublicId = exam.exam_pdf_path;
  if (!examPublicId) {
    examPublicId = extractPublicId(q.image_path);
    if (examPublicId) {
      console.log(`  No exam_pdf_path stored — extracted publicId from image_path: ${examPublicId.slice(0, 60)}`);
    } else {
      console.log(`  Cannot determine exam PDF public_id — skipping`);
      continue;
    }
  }

  // Download PDFs
  console.log(`  Downloading exam PDF...`);
  const examBase64 = await fetchPdfBase64(examPublicId);
  if (!examBase64) { console.log(`  ✗ exam PDF download failed — skipping`); continue; }
  console.log(`  Exam PDF: ${(examBase64.length * 0.75 / 1024).toFixed(0)} KB`);

  let solBase64 = null;
  if (exam.solution_pdf_path) {
    solBase64 = await fetchPdfBase64(exam.solution_pdf_path);
    if (solBase64) console.log(`  Solution PDF: ${(solBase64.length * 0.75 / 1024).toFixed(0)} KB`);
    else console.log(`  Solution PDF download failed — will rely on exam marks only`);
  } else {
    console.log(`  No solution PDF stored — will rely on exam visual marks only`);
  }

  // Run Gemini
  console.log(`  Running Gemini for question #2...`);
  const result = await reanalyzeSingleQuestion(examBase64, solBase64, 2, null);
  if (!result) { console.log(`  ✗ Gemini returned null — skipping`); continue; }

  const pageH = result.page_h || 842;
  let yTopPct = result.y_top;
  let yBotPct = result.y_bottom;
  // Handle Gemini returning absolute points instead of percentages
  if (yTopPct > 100 || yBotPct > 100) {
    yTopPct = (yTopPct / pageH) * 100;
    yBotPct = (yBotPct / pageH) * 100;
  }
  const ySpan = yBotPct - yTopPct;

  console.log(`  Gemini: page=${result.page} y_top=${yTopPct?.toFixed(1)}% y_bottom=${yBotPct?.toFixed(1)}% span=${ySpan?.toFixed(1)}% correct_idx=${result.correct_idx} conf=${result.confidence}`);

  const update = {};

  // Image crop: only update if span is reasonable
  if (Number.isFinite(yTopPct) && Number.isFinite(yBotPct) && ySpan >= 5 && ySpan <= 75) {
    update.image_path = buildCropUrl(examPublicId, result.page, yTopPct, yBotPct, pageH, result.page_w || 595);
    console.log(`  New image_path: ...h_${update.image_path.match(/,h_(\d+),/)?.[1]},y_${update.image_path.match(/,y_(\d+),/)?.[1]}`);
  } else {
    console.log(`  Coords invalid (span=${ySpan?.toFixed(1)}%) — keeping existing image`);
  }

  // Answer
  if (Number.isFinite(parseInt(result.correct_idx, 10))) {
    const ans = parseInt(result.correct_idx, 10);
    if (ans >= 1 && ans <= (result.num_options || 10)) {
      update.correct_idx = ans;
      update.answer_confidence = (result.confidence || 0) >= 0.7 ? 'confirmed' : 'uncertain';
    }
  }

  // OCR
  if (typeof result.question_text === 'string' && result.question_text.trim().length >= 5) {
    update.question_text = result.question_text.trim();
  }
  if (result.options && typeof result.options === 'object') {
    const opts = {};
    for (const [k, v] of Object.entries(result.options)) {
      const idx = parseInt(k, 10);
      if (idx >= 1 && idx <= 10 && typeof v === 'string') opts[idx] = v.trim();
    }
    if (Object.keys(opts).length >= 2) update.options_text = opts;
  }

  if (Object.keys(update).length === 0) {
    console.log(`  No changes to apply`);
    continue;
  }

  const { error } = await admin.from('ep_questions').update(update).eq('id', q.id);
  if (error) {
    console.error(`  ✗ DB update failed: ${error.message}`);
  } else {
    const summary = Object.entries(update)
      .filter(([k]) => k !== 'image_path' && k !== 'question_text' && k !== 'options_text')
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    console.log(`  ✓ Updated: ${Object.keys(update).join(', ')} ${summary}`);
  }
}

console.log('\n✓ Done');
