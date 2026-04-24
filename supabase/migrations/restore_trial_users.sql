-- Restore trial status for users who were incorrectly downgraded by the IP check.
-- Targets: accounts created in the last 14 days that ended up on plan='free'
-- with trial_used=true — they should still be in their trial window.
-- Excludes: admin (xtractions1mv@gmail.com) and omerkol123@gmail.com who
-- are intentionally on their current paid plans.
--
-- Restored users get plan='trial' with plan_expires_at = created_at + 14 days
-- (so they get the remaining portion of their 14-day window).

DO $$
DECLARE
  v_admin_id   UUID;
  v_omer_id    UUID;
  v_restored   INT;
BEGIN
  SELECT id INTO v_admin_id FROM auth.users WHERE email = 'xtractions1mv@gmail.com';
  SELECT id INTO v_omer_id  FROM auth.users WHERE email = 'omerkol123@gmail.com';

  UPDATE profiles
  SET plan            = 'trial',
      trial_used      = false,
      plan_expires_at = created_at + INTERVAL '14 days',
      signup_ip_hash  = NULL   -- clear so the IP check re-runs on next /api/me
  WHERE plan       = 'free'
    AND trial_used = true
    AND created_at >= NOW() - INTERVAL '14 days'
    AND (v_admin_id IS NULL OR id <> v_admin_id)
    AND (v_omer_id  IS NULL OR id <> v_omer_id);

  GET DIAGNOSTICS v_restored = ROW_COUNT;
  RAISE NOTICE 'Restored % users to trial plan', v_restored;
END;
$$;

-- Verify: show all active trial/free users created in the last 14 days
SELECT
  u.email,
  p.plan,
  p.trial_used,
  p.plan_expires_at,
  p.created_at
FROM profiles p
JOIN auth.users u ON u.id = p.id
WHERE p.created_at >= NOW() - INTERVAL '14 days'
ORDER BY p.created_at DESC;
