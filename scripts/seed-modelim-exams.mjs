// =====================================================
// One-shot seeding for the Modelim exam library.
// =====================================================
// What this script does:
//   1. Creates (or reuses) the template user template-modelim@examprep.com
//   2. Promotes them to is_admin so the upload pipeline's daily cap doesn't
//      choke mid-run (we're uploading 13 exams in a row).
//   3. Creates degree "מדעי המחשב" + course "מודלים חישוביים" if absent.
//   4. For each (exam PDF, solution PDF) pair, POSTs multipart to
//      /api/upload on production. The same pipeline the app uses for
//      interactive uploads — we just invoke it from a script.
//   5. Writes the template user's UUID into ep_app_config so the
//      handle_new_user trigger knows who to clone from.
//
// Run:
//   TEMPLATE_PASSWORD='...' BASE_URL='https://try.examprep.com' \
//     node scripts/seed-modelim-exams.mjs
//
// Secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) come from .env.local,
// passed via dotenv at startup.
// =====================================================

import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

// Tiny .env.local loader — avoids the dotenv dependency.
(function loadDotenv() {
  const p = path.resolve(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    // Values in this project's .env.local contain literal "\n" suffixes.
    v = v.replace(/\\n/g, '').trim();
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
})();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TEMPLATE_EMAIL = 'template-modelim@examprep.com';
const TEMPLATE_PASSWORD = process.env.TEMPLATE_PASSWORD;
const BASE_URL = (process.env.BASE_URL || 'https://try.examprep.com').replace(/\/$/, '');
const EXAMS_DIR = 'E:/uni/modelim';
const DEGREE_NAME = 'מדעי המחשב';
const COURSE_NAME = 'מודלים חישוביים';

if (!SUPABASE_URL || !SERVICE_ROLE || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}
if (!TEMPLATE_PASSWORD) {
  console.error('Missing TEMPLATE_PASSWORD env var');
  process.exit(1);
}

// File pairs — skipping 2026AA per user's instruction (yellow-highlight cleanup later).
const PAIRS = [
  ['2022 מועד ב׳ (2)',        '22BB.pdf',   '22BB_Sol.pdf'],
  ['2023 מועד א׳ (1)',        '23AA.pdf',   '23AA_sol.pdf'],
  ['2023 מועד א׳ (2)',        '23AB.pdf',   '23AB_sol.pdf'],
  ['2023 מועד ב׳ (1)',        '23BA.pdf',   '23BA_ClosedQs_Official_Sol.pdf'],
  ['2023 מועד ב׳ (2)',        '23BB.pdf',   '23BB_sol.pdf'],
  ['2024 מועד א׳ (1)',        '24AA.pdf',   '24AA_Sol.pdf'],
  ['2024 מועד א׳ (2)',        '24AB.pdf',   '24AB_Sol.pdf'],
  ['2024 מועד ב׳ (1)',        '24BA.pdf',   '24BA multiple choice sol.pdf'],
  ['2024 מועד ב׳ (2)',        '24BB.pdf',   '2024BB_sol.pdf'],
  ['2025 מועד א׳ (1)',        '25AA.pdf',   '25AA_closed_sol.pdf'],
  ['2025 מועד א׳ (2)',        '25AB.pdf',   '25AB_closed_Sol.pdf'],
  ['2025 מועד ב׳ (1)',        '25BA.pdf',   '25BA_Sol.pdf'],
  ['2025 מועד ב׳ (2)',        '25BB.pdf',   '25BB_sol.pdf'],
];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

async function ensureTemplateUser() {
  console.log(`\n▸ Ensuring template user ${TEMPLATE_EMAIL}`);
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const existing = list?.users?.find(u => u.email === TEMPLATE_EMAIL);
  let userId;
  if (existing) {
    userId = existing.id;
    console.log(`  found existing user ${userId}`);
    // Reset password so we can sign in reliably.
    await admin.auth.admin.updateUserById(userId, { password: TEMPLATE_PASSWORD, email_confirm: true });
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEMPLATE_EMAIL,
      password: TEMPLATE_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'Modelim Template' },
    });
    if (error) throw new Error(`createUser failed: ${error.message}`);
    userId = data.user.id;
    console.log(`  created user ${userId}`);
  }
  // Promote to admin so upload quota is generous.
  await admin.from('profiles').update({
    is_admin: true,
    plan: 'pro',
    plan_expires_at: null,
    trial_used: false,
  }).eq('id', userId);
  return userId;
}

async function signInAsTemplate() {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({
    email: TEMPLATE_EMAIL,
    password: TEMPLATE_PASSWORD,
  });
  if (error) throw new Error(`signIn failed: ${error.message}`);
  return data.session.access_token;
}

async function ensureDegreeAndCourse(userId, jwt) {
  console.log('\n▸ Ensuring degree + course rows');
  const { data: existingDegree } = await admin.from('ep_courses')
    .select('id, name').eq('user_id', userId).eq('is_degree', true).eq('name', DEGREE_NAME).maybeSingle();
  let degreeId = existingDegree?.id;
  if (!degreeId) {
    const r = await fetch(`${BASE_URL}/api/courses`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DEGREE_NAME, is_degree: true, color: '#1E40AF' }),
    });
    if (!r.ok) throw new Error(`create degree HTTP ${r.status}: ${await r.text()}`);
    const row = await r.json();
    degreeId = row.id;
    console.log(`  created degree id=${degreeId}`);
  } else {
    console.log(`  degree already present id=${degreeId}`);
  }

  const { data: existingCourse } = await admin.from('ep_courses')
    .select('id').eq('user_id', userId).eq('parent_id', degreeId).eq('name', COURSE_NAME).maybeSingle();
  let courseId = existingCourse?.id;
  if (!courseId) {
    const r = await fetch(`${BASE_URL}/api/courses`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: COURSE_NAME, parent_id: degreeId, color: '#7C3AED' }),
    });
    if (!r.ok) throw new Error(`create course HTTP ${r.status}: ${await r.text()}`);
    const row = await r.json();
    courseId = row.id;
    console.log(`  created course id=${courseId}`);
  } else {
    console.log(`  course already present id=${courseId}`);
  }
  return { degreeId, courseId };
}

function buildMultipart(fields, files) {
  const boundary = '----seedModelim' + Math.random().toString(36).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${k}"\r\n\r\n` +
      String(v) + '\r\n'
    ));
  }
  for (const f of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    ));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Upload one PDF directly to Cloudinary using the signed params from /api/upload-sign.
// Uses multipart form encoding — Cloudinary rejects application/pdf POSTs.
async function putToCloudinary(fileBuf, filename, params) {
  const boundary = '----cld' + Math.random().toString(36).slice(2);
  const parts = [];
  const add = (k, v) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  add('public_id', params.publicId);
  add('api_key', params.apiKey);
  add('timestamp', params.timestamp);
  add('signature', params.signature);
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/pdf\r\n\r\n`
  ));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const r = await fetch(params.uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Cloudinary ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  if (!j.public_id) throw new Error('Cloudinary returned no public_id');
  return j.public_id;
}

async function uploadOne(jwt, courseId, name, examPath, solPath) {
  const examData = await readFile(examPath);
  const solData  = await readFile(solPath);
  const totalMb = (examData.length + solData.length) / 1024 / 1024;
  console.log(`  [${name}] exam=${(examData.length/1024/1024).toFixed(1)}MB sol=${(solData.length/1024/1024).toFixed(1)}MB total=${totalMb.toFixed(1)}MB`);

  // Vercel functions cap request bodies at ~4.5MB. For anything approaching
  // that, use direct-to-Cloudinary + JSON POST (same path the web UI uses for
  // large files). Below the cap, plain multipart is simpler.
  const useDirect = totalMb > 3.5;

  if (useDirect) {
    console.log(`    via direct Cloudinary (large bundle)`);
    const signResp = await fetch(`${BASE_URL}/api/upload-sign`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId }),
    });
    if (!signResp.ok) throw new Error(`upload-sign HTTP ${signResp.status}: ${await signResp.text()}`);
    const signData = await signResp.json();

    const [examPublicId, solPublicId] = await Promise.all([
      putToCloudinary(examData, path.basename(examPath), signData.exam),
      putToCloudinary(solData,  path.basename(solPath),  signData.solution),
    ]);

    const r = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, courseId,
        examPublicId, solPublicId,
        examFilename: path.basename(examPath),
        solFilename:  path.basename(solPath),
      }),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 400)}`);
    const json = JSON.parse(txt);
    console.log(`    → exam_id=${json.exam_id} q=${json.question_count} status=${json.status} review=${json.review_count || 0}`);
    return json;
  }

  const { body, contentType } = buildMultipart(
    { courseId: String(courseId), name },
    [
      { field: 'examPdf',     filename: path.basename(examPath), data: examData },
      { field: 'solutionPdf', filename: path.basename(solPath),  data: solData },
    ]
  );

  const r = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': contentType,
      'Content-Length': String(body.length),
    },
    body,
  });
  const txt = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${txt.slice(0, 400)}`);
  }
  const json = JSON.parse(txt);
  console.log(`    → exam_id=${json.exam_id} q=${json.question_count} status=${json.status} review=${json.review_count || 0}`);
  return json;
}

async function setConfigTemplateUser(userId) {
  console.log(`\n▸ Writing template_user_id=${userId} into ep_app_config`);
  const { error } = await admin.from('ep_app_config')
    .update({ template_user_id: userId, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) throw new Error(`ep_app_config update: ${error.message}`);
  console.log('  ✓ done');
}

async function verify(userId) {
  console.log('\n▸ Verifying seeded data');
  const { data: exams } = await admin.from('ep_exams').select('id, name, status, question_count').eq('user_id', userId);
  console.log(`  exams rows: ${exams?.length || 0}`);
  (exams || []).forEach(e => console.log(`    #${e.id} ${e.name}: status=${e.status} q=${e.question_count}`));

  const { count: qTotal } = await admin.from('ep_questions').select('*', { count: 'exact', head: true }).eq('user_id', userId);
  const { count: qNoAns } = await admin.from('ep_questions').select('*', { count: 'exact', head: true }).eq('user_id', userId).is('correct_idx', null);
  console.log(`  questions total: ${qTotal}, missing correct_idx: ${qNoAns || 0}`);
}

async function main() {
  // Pre-flight: verify all source PDFs exist.
  const missing = [];
  for (const [, ex, sol] of PAIRS) {
    if (!existsSync(path.join(EXAMS_DIR, ex))) missing.push(ex);
    if (!existsSync(path.join(EXAMS_DIR, sol))) missing.push(sol);
  }
  if (missing.length) {
    console.error('Missing source PDFs:', missing);
    process.exit(2);
  }

  const userId = await ensureTemplateUser();
  const jwt = await signInAsTemplate();
  const { courseId } = await ensureDegreeAndCourse(userId, jwt);

  console.log(`\n▸ Uploading ${PAIRS.length} exam/solution pairs (skipping already-seeded)`);
  const { data: existing } = await admin.from('ep_exams')
    .select('id, name, question_count, status').eq('user_id', userId).eq('course_id', courseId);
  const seeded = new Map((existing || []).map(e => [e.name, e]));
  const results = [];
  for (const [name, exFile, solFile] of PAIRS) {
    console.log(`\n  [${name}]`);
    const prev = seeded.get(name);
    if (prev && prev.status !== 'failed' && (prev.question_count || 0) > 0) {
      console.log(`    skipping — already seeded (exam_id=${prev.id}, status=${prev.status}, q=${prev.question_count})`);
      results.push({ name, ok: true, exam_id: prev.id, question_count: prev.question_count, status: prev.status, skipped: true });
      continue;
    }
    if (prev && (prev.status === 'failed' || (prev.question_count || 0) === 0)) {
      console.log(`    cleaning stale row exam_id=${prev.id} before retry`);
      await admin.from('ep_exams').delete().eq('id', prev.id);
    }
    try {
      const r = await uploadOne(jwt, courseId,
        name,
        path.join(EXAMS_DIR, exFile),
        path.join(EXAMS_DIR, solFile));
      results.push({ name, ok: true, ...r });
    } catch (e) {
      console.error(`  ✗ ${name} failed: ${e.message}`);
      results.push({ name, ok: false, error: e.message });
    }
    // Pace to stay under admin burst cap (10/min) with room for Gemini slowness.
    await new Promise(r => setTimeout(r, 12_000));
  }

  await setConfigTemplateUser(userId);
  await verify(userId);

  const failed = results.filter(r => !r.ok);
  console.log(`\n=== Summary ===`);
  console.log(`  succeeded: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log(`  failures:`);
    failed.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
    process.exit(3);
  }
  console.log(`\n✓ Seeding complete. Template user: ${TEMPLATE_EMAIL} (id=${userId})`);
  console.log(`  Flip ep_app_config.seed_mode_enabled=true when you're ready for new signups to clone this library.`);
}

main().catch(e => {
  console.error('\n✗ FATAL:', e?.stack || e?.message || e);
  process.exit(1);
});
