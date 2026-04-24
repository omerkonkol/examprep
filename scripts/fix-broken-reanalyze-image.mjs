// One-time fix: restore image_path for questions broken by the old reanalyze endpoint.
// The old endpoint used Gemini bounding-box coordinates to update image_path, but
// Cloudinary returns HTTP 200 for any crop URL so the validation was ineffective.
//
// Usage: node --env-file=.env.local scripts/fix-broken-reanalyze-image.mjs

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Find the user
const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
const user = users.users.find(u => u.email === 'omerkol123@gmail.com');
if (!user) { console.error('User not found'); process.exit(1); }
console.log(`User: ${user.email} (${user.id})`);

// Find their מודלים חישוביים course
const { data: courses } = await admin.from('ep_courses')
  .select('id, name')
  .eq('user_id', user.id)
  .ilike('name', '%מודלים%');
console.log('Courses matching מודלים:', courses?.map(c => `[${c.id}] ${c.name}`));

if (!courses?.length) { console.error('No matching course found'); process.exit(1); }
const courseIds = courses.map(c => c.id);

// Find exams for those courses
const { data: exams } = await admin.from('ep_exams')
  .select('id, name, course_id')
  .in('course_id', courseIds);
console.log('Exams:', exams?.map(e => `[${e.id}] ${e.name} (course=${e.course_id})`));
if (!exams?.length) { console.error('No exams found'); process.exit(1); }
const examIds = exams.map(e => e.id);

// Find question_number=2 in those exams
const { data: questions } = await admin.from('ep_questions')
  .select('id, question_number, image_path, exam_id')
  .in('exam_id', examIds)
  .eq('question_number', 2);

console.log(`\nFound ${questions?.length || 0} question(s) with number=2:`);
for (const q of questions || []) {
  console.log(`  id=${q.id} exam_id=${q.exam_id}`);
  console.log(`  image_path=${q.image_path?.slice(0, 120) || '(null)'}`);

  // Null out the broken image_path so the UI falls back to question_text
  const { error } = await admin.from('ep_questions')
    .update({ image_path: null })
    .eq('id', q.id);
  if (error) {
    console.error(`  ✗ failed to clear image_path: ${error.message}`);
  } else {
    console.log(`  ✓ image_path cleared — question will now display using OCR text`);
  }
}

console.log('\nDone. User should now click "נתח מחדש" again to re-extract the correct answer.');
