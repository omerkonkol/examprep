// Verify profile RLS fix: create a throwaway confirmed user via service_role,
// get a JWT, simulate the attack, verify it's blocked, then delete the user.

// Pass secrets inline — do NOT persist to disk.
// Pull fresh from Vercel each run: `vercel env pull --environment=production <tmpfile>`
// then read those vars into your shell, then invoke this script.
const URL = process.env.SUPABASE_URL?.trim();
const ANON = process.env.SUPABASE_ANON_KEY?.trim();
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!URL || !ANON || !SERVICE) {
  console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}

const email = `rls-test-${Date.now()}@example.com`;
const password = 'Test_' + Math.random().toString(36).slice(2, 14) + '!A1';
console.log('Test user:', email);

// 1. Create confirmed user via service_role (bypasses email confirmation)
const createRes = await fetch(`${URL}/auth/v1/admin/users`, {
  method: 'POST',
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password, email_confirm: true }),
});
const created = await createRes.json();
const userId = created?.id;
if (!userId) { console.error('[create] FAILED:', createRes.status, created); process.exit(1); }
console.log('[create] ok, user id:', userId);

try {
  // 2. Sign in as that user to get a real JWT
  const loginRes = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const lb = await loginRes.json();
  const token = lb?.access_token;
  if (!token) { console.error('[login] FAILED:', loginRes.status, lb); process.exit(1); }
  console.log('[login] ok');

  // 3. Ensure profile row exists with counter=5 so reset-to-0 attack is meaningful
  await fetch(`${URL}/rest/v1/profiles`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: userId, email, plan: 'free', is_admin: false, pdfs_uploaded_today: 5 }),
  });
  // If row already existed from trigger, force counter to 5 via service_role
  await fetch(`${URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdfs_uploaded_today: 5 }),
  });

  const patch = (body) => fetch(`${URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.text() }));

  const read = () => fetch(`${URL}/rest/v1/profiles?id=eq.${userId}&select=plan,is_admin,pdfs_uploaded_today,display_name`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  }).then(r => r.json());

  console.log('\nBEFORE:', JSON.stringify(await read()));

  const a1 = await patch({ plan: 'pro', plan_expires_at: '2099-12-31T23:59:59Z' });
  console.log('\n[ATTACK 1] UPDATE plan=pro');
  console.log('  status:', a1.status, ' body:', a1.body.slice(0, 180));

  const a2 = await patch({ pdfs_uploaded_today: 0 });
  console.log('\n[ATTACK 2] UPDATE pdfs_uploaded_today=0');
  console.log('  status:', a2.status, ' body:', a2.body.slice(0, 180));

  const a3 = await patch({ is_admin: true });
  console.log('\n[ATTACK 3] UPDATE is_admin=true');
  console.log('  status:', a3.status, ' body:', a3.body.slice(0, 180));

  const legit = await patch({ display_name: 'Verified RLS Test' });
  console.log('\n[LEGITIMATE] UPDATE display_name');
  console.log('  status:', legit.status, ' body:', legit.body.slice(0, 180));

  console.log('\nAFTER:', JSON.stringify(await read()));

  // 4. Evaluate: check FINAL stored state (only that matters — 200 responses could be no-ops)
  const fin = await read();
  const got = fin?.[0];
  const stayedFree = got?.plan === 'free';
  const notAdmin = got?.is_admin === false;
  const counterUntouched = got?.pdfs_uploaded_today === 5;
  const displayNameUpdated = got?.display_name === 'Verified RLS Test';

  console.log('\n=== RESULT ===');
  console.log('ATTACK 1 plan change:       ', stayedFree ? 'BLOCKED OK' : 'ALLOWED — VULNERABLE');
  console.log('ATTACK 2 counter reset (5→0):', counterUntouched ? 'BLOCKED OK' : 'ALLOWED — VULNERABLE');
  console.log('ATTACK 3 admin escalation:  ', notAdmin ? 'BLOCKED OK' : 'ALLOWED — VULNERABLE');
  console.log('LEGITIMATE display_name:    ', displayNameUpdated ? 'OK' : 'BROKEN');
} finally {
  // 5. Clean up: delete the test user
  const delRes = await fetch(`${URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  console.log('\n[cleanup] deleted test user:', delRes.status);
}
