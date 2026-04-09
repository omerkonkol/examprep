// =====================================================
// ExamPrep - One-shot migration of tohna1 questions
// =====================================================
// Imports the full tohna1 question bank (11 exams, ~83 MCQs + Hebrew explanations)
// from e:/tohna1-questions/tohna1-app/data/* into ExamPrep's ep_* tables under a
// freshly-created admin user.
//
// Usage (from any directory):
//   SUPABASE_URL=https://bhdkdttsxdrfpbheyouy.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//   node e:/examprep/scripts/migrate-tohna1.mjs
//
// SECRET HANDLING: SUPABASE_SERVICE_ROLE_KEY is read from env only.
// It is NEVER persisted to disk by this script. After running, the user is
// reminded to rotate the key since it was shared in chat.

import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';

// ----- Resolve paths -----
const TOHNA1_DIR = 'e:/tohna1-questions/tohna1-app';
const TOHNA1_DATA = path.join(TOHNA1_DIR, 'data');
const SUPABASE_JS_PATH = path.join(TOHNA1_DIR, 'node_modules', '@supabase', 'supabase-js', 'dist', 'index.mjs');

// ----- Load supabase-js dynamically from tohna1-app's node_modules -----
const fileUrl = 'file:///' + SUPABASE_JS_PATH.replace(/\\/g, '/');
const { createClient } = await import(fileUrl);

// ----- Env -----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing required env vars: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
  console.error('Run with: SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/migrate-tohna1.mjs');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ----- Helpers -----
function genRandomEmail() {
  const tag = crypto.randomBytes(3).toString('hex'); // e.g. "a3f91c"
  return `admin+${tag}@examprep.app`;
}

function genRandomPassword() {
  // 16 chars, mixed case + digits + symbols, URL-safe-ish
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
  let out = '';
  const buf = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) out += charset[buf[i] % charset.length];
  return out;
}

function imageUrl(relativePath) {
  // metadata stores e.g. "moed_a_sem_a_2024/q-01_א.png"
  // tohna1 frontend deployment serves these at /images/<exam>/<file>
  // encodeURI handles the Hebrew chars but leaves the slash alone
  return `https://tohna1-quiz.vercel.app/images/${encodeURI(relativePath)}`;
}

function loadJson(filename) {
  const filePath = path.join(TOHNA1_DATA, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// ----- Step 1: Verify schema exists -----
async function verifySchema() {
  console.log('▸ Verifying ep_* schema exists...');
  const { error } = await sb.from('ep_courses').select('id', { head: true, count: 'exact' }).limit(1);
  if (error) {
    if (error.code === '42P01' || /does not exist/i.test(error.message || '')) {
      console.error('\n❌ The ep_* schema does not exist in this Supabase project yet.');
      console.error('   You need to run the schema setup ONCE before this script can work:');
      console.error('   1. Open Supabase SQL Editor:');
      console.error('      https://supabase.com/dashboard/project/bhdkdttsxdrfpbheyouy/sql/new');
      console.error('   2. Paste the contents of: e:/examprep/supabase/schema.sql');
      console.error('   3. Click "Run"');
      console.error('   4. Re-run this migration script.\n');
      process.exit(2);
    }
    console.error('❌ Unexpected schema check error:', error);
    process.exit(3);
  }
  console.log('  ✓ ep_courses table is reachable');
}

// ----- Step 2: Create admin auth user -----
async function createAdminUser() {
  const email = genRandomEmail();
  const password = genRandomPassword();
  console.log(`\n▸ Creating admin auth user: ${email}`);
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // skip the email verification step
    user_metadata: {
      display_name: 'ExamPrep Admin',
      seeded: true,
    },
  });
  if (error) {
    console.error('❌ Failed to create admin user:', error);
    process.exit(4);
  }
  const userId = data.user.id;
  console.log(`  ✓ Created auth user, id=${userId}`);

  // Upsert profile (the profiles table may or may not have a trigger that auto-creates rows)
  const { error: profErr } = await sb.from('profiles').upsert({
    id: userId,
    username: email.split('@')[0],
    display_name: 'ExamPrep Admin',
    email,
    plan: 'pro',
    is_admin: true,
  }, { onConflict: 'id' });
  if (profErr) {
    console.error('  ⚠ Could not upsert profile (continuing anyway):', profErr.message);
  } else {
    console.log('  ✓ Profile upserted (admin=true, plan=pro)');
  }

  return { userId, email, password };
}

// ----- Step 3: Insert course -----
async function createCourse(userId) {
  console.log('\n▸ Creating course "תוכנה 1"...');
  const { data, error } = await sb.from('ep_courses').insert({
    user_id: userId,
    name: 'תוכנה 1',
    description: 'בנק שאלות אמריקאיות מבחינות עבר של תוכנה 1 - אונ\' תל אביב. כולל הסברים מפורטים לכל שאלה ותשובה.',
    color: '#2563eb',
    total_questions: 0, // updated later
    total_pdfs: 0, // updated later
  }).select().single();
  if (error) {
    console.error('❌ Failed to create course:', error);
    process.exit(5);
  }
  console.log(`  ✓ Course id=${data.id}`);
  return data.id;
}

// ----- Step 4: Insert exams + questions -----
async function migrateExamsAndQuestions(userId, courseId) {
  const metadata = loadJson('metadata.json');
  const answersDoc = loadJson('answers.json');
  const explanations = loadJson('explanations.json');
  const answers = answersDoc.answers || {};

  let totalQuestions = 0;
  const examIds = [];

  for (const exam of metadata.exams) {
    console.log(`\n▸ Exam "${exam.label}" (${exam.id}) - ${exam.questions.length} questions`);

    // Insert exam row
    const { data: examRow, error: examErr } = await sb.from('ep_exams').insert({
      course_id: courseId,
      user_id: userId,
      name: exam.label,
      status: 'ready',
      question_count: exam.questions.length,
      processed_at: new Date().toISOString(),
    }).select().single();
    if (examErr) {
      console.error(`  ❌ Failed to insert exam:`, examErr);
      process.exit(6);
    }
    const examId = examRow.id;
    examIds.push(examId);
    console.log(`  ✓ Inserted ep_exams row id=${examId}`);

    // Build question rows
    const questionsToInsert = [];
    for (const q of exam.questions) {
      const a = answers[q.id];
      if (!a) {
        console.warn(`  ⚠ No answer found for ${q.id}, skipping`);
        continue;
      }
      const exp = explanations[q.id] || null;
      questionsToInsert.push({
        exam_id: examId,
        course_id: courseId,
        user_id: userId,
        question_number: q.orderIdx,
        section_label: q.section,
        image_path: imageUrl(q.image),
        num_options: a.numOptions,
        option_labels: a.optionLabels || null,
        correct_idx: a.correctIdx,
        topic: a.topic || null,
        general_explanation: exp ? exp.general : null,
        option_explanations: exp ? exp.options : null,
      });
    }

    const { error: qErr } = await sb.from('ep_questions').insert(questionsToInsert);
    if (qErr) {
      console.error(`  ❌ Failed to insert questions for exam ${exam.id}:`, qErr);
      process.exit(7);
    }
    console.log(`  ✓ Inserted ${questionsToInsert.length} questions`);
    totalQuestions += questionsToInsert.length;
  }

  return { totalQuestions, examCount: examIds.length };
}

// ----- Step 5: Update course counters -----
async function updateCourseCounters(courseId, totalQuestions, totalExams) {
  console.log('\n▸ Updating course counters...');
  const { error } = await sb.from('ep_courses').update({
    total_questions: totalQuestions,
    total_pdfs: totalExams,
  }).eq('id', courseId);
  if (error) {
    console.error('  ⚠ Failed to update counters:', error.message);
    return;
  }
  console.log(`  ✓ total_questions=${totalQuestions}, total_pdfs=${totalExams}`);
}

// ----- Step 6: Verify counts -----
async function verify(courseId) {
  console.log('\n▸ Verifying counts in DB...');
  const [examsRes, questionsRes] = await Promise.all([
    sb.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', courseId),
    sb.from('ep_questions').select('id', { count: 'exact', head: true }).eq('course_id', courseId),
  ]);
  console.log(`  ✓ ep_exams in course: ${examsRes.count}`);
  console.log(`  ✓ ep_questions in course: ${questionsRes.count}`);
  return { exams: examsRes.count, questions: questionsRes.count };
}

// ===== MAIN =====
async function main() {
  console.log('========================================');
  console.log('ExamPrep ← tohna1 migration');
  console.log('========================================');
  console.log('Source data: ' + TOHNA1_DATA);
  console.log('Target: ' + SUPABASE_URL);
  console.log('');

  await verifySchema();
  const admin = await createAdminUser();
  const courseId = await createCourse(admin.userId);
  const { totalQuestions, examCount } = await migrateExamsAndQuestions(admin.userId, courseId);
  await updateCourseCounters(courseId, totalQuestions, examCount);
  const counts = await verify(courseId);

  console.log('\n========================================');
  console.log('✅ MIGRATION COMPLETE');
  console.log('========================================');
  console.log('');
  console.log('Admin user credentials:');
  console.log('  Email:    ' + admin.email);
  console.log('  Password: ' + admin.password);
  console.log('  user_id:  ' + admin.userId);
  console.log('');
  console.log('Course:');
  console.log('  id:                ' + courseId);
  console.log('  name:              תוכנה 1');
  console.log('  exams inserted:    ' + counts.exams);
  console.log('  questions inserted: ' + counts.questions);
  console.log('');
  console.log('SAVE THE CREDENTIALS NOW — they are not stored anywhere on disk.');
}

main().catch((err) => {
  console.error('\n❌ FATAL:', err);
  process.exit(99);
});
