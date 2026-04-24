// =====================================================
// Per-minute burst protection for authenticated endpoints.
// =====================================================
// Calls the `ep_check_burst` RPC which counts rows in ep_user_request_log
// for the last 60 seconds and rejects if the user has exceeded the cap.
// checkBurst fails OPEN on RPC error — never block legit traffic due to a
// throttle bug. checkGlobalBudget fails CLOSED on RPC error — billing risk
// outweighs availability risk for expensive AI operations.

import { createClient } from '@supabase/supabase-js';

let _admin = null;
function getAdmin() {
  if (!_admin && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    _admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _admin;
}

// Returns { allowed: true|false, reason?: string, retry_after_seconds?: number }
export async function checkBurst(userId, bucket, maxPerMinute = 6) {
  if (!userId || !bucket) return { allowed: true, reason: 'no_input' };
  const admin = getAdmin();
  if (!admin) return { allowed: true, reason: 'no_admin' };

  try {
    const { data, error } = await admin.rpc('ep_check_burst', {
      p_user_id: userId,
      p_bucket: bucket,
      p_max_per_minute: maxPerMinute,
    });
    if (error) {
      console.warn('[burst]', bucket, error.message);
      return { allowed: true, reason: 'rpc_error' };
    }
    return data || { allowed: true, reason: 'no_data' };
  } catch (e) {
    console.warn('[burst] exception:', e?.message);
    return { allowed: true, reason: 'exception' };
  }
}

// Returns { ok: true } or { ok: false, cost_today_usd, budget_usd }
export async function checkGlobalBudget() {
  const admin = getAdmin();
  if (!admin) return { ok: true, reason: 'no_admin' };
  const budget = parseFloat(process.env.GLOBAL_DAILY_BUDGET_USD || '15');
  if (!Number.isFinite(budget) || budget <= 0) return { ok: true, reason: 'no_budget' };

  try {
    const { data, error } = await admin.rpc('ep_check_global_budget', {
      p_budget_usd: budget,
    });
    if (error) {
      console.warn('[budget] RPC error — denying request conservatively:', error.message);
      return { ok: false, reason: 'rpc_error' };
    }
    return data || { ok: true };
  } catch (e) {
    console.warn('[budget] exception — denying request conservatively:', e?.message);
    return { ok: false, reason: 'exception' };
  }
}
