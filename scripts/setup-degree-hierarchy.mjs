// =====================================================
// One-time migration: reorganize existing courses into degree hierarchy.
// Usage: node --env-file=.env.local scripts/setup-degree-hierarchy.mjs
// SECURITY: reads env vars only, writes nothing to disk.
// =====================================================

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

// ── helpers ──────────────────────────────────────────────────────────────────

async function getUserId(email) {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error('listUsers: ' + error.message);
  const user = data.users.find(u => u.email === email);
  return user?.id ?? null;
}

async function getCourses(userId) {
  const { data, error } = await admin
    .from('ep_courses')
    .select('id, name, is_degree, parent_id, color, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error('getCourses: ' + error.message);
  return data || [];
}

async function createDegree(userId, name, color) {
  const { data, error } = await admin
    .from('ep_courses')
    .insert({ user_id: userId, name, description: '', is_degree: true, color, parent_id: null })
    .select('id')
    .single();
  if (error) throw new Error('createDegree: ' + error.message);
  return data.id;
}

async function setCourseParent(courseId, parentId) {
  const { error } = await admin
    .from('ep_courses')
    .update({ parent_id: parentId })
    .eq('id', courseId);
  if (error) throw new Error('setCourseParent: ' + error.message);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function organizeUser({ email, degreeName, courseSearch, createCourseIfMissing = false }) {
  console.log(`\n▸ ${email}`);

  const userId = await getUserId(email);
  if (!userId) { console.log('  ✗ user not found'); return; }
  console.log(`  user_id: ${userId}`);

  let courses = await getCourses(userId);
  console.log('  existing courses:', courses.map(c =>
    `[${c.id}] "${c.name}"${c.is_degree ? ' (degree)' : ''}${c.parent_id ? ` → parent ${c.parent_id}` : ''}`
  ).join('\n    ') || '(none)');

  // Find the target course (top-level, not already nested)
  let target = courses.find(c =>
    !c.is_degree &&
    c.parent_id == null &&
    c.name.includes(courseSearch)
  );

  if (!target && createCourseIfMissing) {
    // Create the course so it can be nested inside the degree
    const { data, error } = await admin
      .from('ep_courses')
      .insert({ user_id: userId, name: courseSearch, description: '', is_degree: false, color: '#3b82f6', parent_id: null })
      .select('id, name, color, parent_id')
      .single();
    if (error) { console.log('  ✗ failed to create course:', error.message); return; }
    target = data;
    console.log(`  ✓ created course "${courseSearch}" id=${target.id}`);
    courses = await getCourses(userId);
  }

  if (!target) {
    console.log(`  ✗ no top-level course matching "${courseSearch}" found`);
    return;
  }
  console.log(`  target course: [${target.id}] "${target.name}"`);

  // Find or create the degree
  let degree = courses.find(c => c.is_degree && c.name === degreeName);
  if (!degree) {
    const degreeId = await createDegree(userId, degreeName, target.color || '#3b82f6');
    console.log(`  ✓ created degree "${degreeName}" id=${degreeId}`);
    degree = { id: degreeId };
  } else {
    console.log(`  ✓ degree "${degreeName}" already exists id=${degree.id}`);
  }

  // If course is already inside the degree, nothing to do
  if (String(target.parent_id) === String(degree.id)) {
    console.log(`  ✓ already nested — nothing to do`);
    return;
  }

  // Move the course into the degree
  await setCourseParent(target.id, degree.id);
  console.log(`  ✓ moved [${target.id}] "${target.name}" → degree [${degree.id}]`);
}

// ── run ───────────────────────────────────────────────────────────────────────

await organizeUser({
  email: 'omerkol123@gmail.com',
  degreeName: 'תואר מדעי המחשב',
  courseSearch: 'מודלים חישוביים',
});

await organizeUser({
  email: 'admin@examprep.app',
  degreeName: 'תואר למדעי המחשב',
  courseSearch: 'תוכנה 1',
  createCourseIfMissing: true,
});

console.log('\n✓ done');
