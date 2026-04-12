// =====================================================
// Shared IP-based throttle helper for expensive AI endpoints.
// Calls the `ep_check_ip_throttle` SECURITY DEFINER RPC defined in schema.sql.
// Fails OPEN on misconfiguration (no salt, no admin, RPC error) — never block
// legit traffic because of a throttle bug.
// =====================================================

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

let _admin = null;
function getAdmin() {
  if (!_admin && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    _admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _admin;
}

export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

// Returns { allowed, reason?, blocked_until?, count_today?, count_week? }
export async function checkIpThrottle(req, bucket, { maxDay = 30, maxWeek = 100, blockHours = 24 } = {}) {
  const salt = (process.env.IP_HASH_SALT || '').replace(/\\n/g, '').trim();
  if (!salt) return { allowed: true, reason: 'no_salt' };

  const ip = getClientIp(req);
  if (!ip) return { allowed: true, reason: 'no_ip' };

  const admin = getAdmin();
  if (!admin) return { allowed: true, reason: 'no_admin' };

  const ipHash = createHash('sha256').update(salt + ip).digest('hex');

  const { data, error } = await admin.rpc('ep_check_ip_throttle', {
    p_ip_hash: ipHash,
    p_bucket: bucket,
    p_max_day: maxDay,
    p_max_week: maxWeek,
    p_block_hours: blockHours,
  });

  if (error) {
    console.error('[ipThrottle]', bucket, error.message);
    return { allowed: true, reason: 'rpc_error' };
  }
  return data || { allowed: true, reason: 'no_data' };
}
