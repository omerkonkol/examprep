import { readFileSync } from 'node:fs';

const env = readFileSync('.env.local', 'utf8');
const url = env.match(/SUPABASE_URL="([^"\n\\]+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY="([^"\n\\]+)/)[1].trim();

console.log('URL:', url);

// 1. Test ep_reserve_lab_slot exists
const testUserId = '00000000-0000-0000-0000-000000000000';
const r = await fetch(url + '/rest/v1/rpc/ep_reserve_lab_slot', {
  method: 'POST',
  headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_user_id: testUserId, p_max_day: 10, p_max_month: 60, p_count: 1 }),
});
console.log('\n[1] ep_reserve_lab_slot RPC:');
console.log('    status:', r.status);
console.log('    body:', (await r.text()).slice(0, 200));

// 2. Test reset_user_quotas_if_needed still works
const r2 = await fetch(url + '/rest/v1/rpc/reset_user_quotas_if_needed', {
  method: 'POST',
  headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_user_id: testUserId }),
});
console.log('\n[2] reset_user_quotas_if_needed RPC:');
console.log('    status:', r2.status);
console.log('    body:', (await r2.text()).slice(0, 200));

// 3. Verify lab columns exist by querying a real profile (LIMIT 1)
const r3 = await fetch(url + '/rest/v1/profiles?select=id,plan,lab_questions_today,lab_questions_this_month&limit=1', {
  headers: { apikey: key, Authorization: 'Bearer ' + key },
});
console.log('\n[3] lab columns in profiles:');
console.log('    status:', r3.status);
console.log('    body:', (await r3.text()).slice(0, 300));
