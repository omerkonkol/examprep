-- ====== Trial-farming protection ======
-- Prevents a single person from creating many accounts (e.g. via Gmail
-- +aliases) to get unlimited free trials. On first /api/me call after
-- signup, the server hashes the client IP and records it. If the same
-- IP has already claimed >= 2 trials in the last 30 days, the new
-- account is immediately flipped to 'free' with trial_used = true.
--
-- Design: the check is done via an RPC called from /api/me, so it runs
-- on every profile fetch but does no-op once signup_ip_hash is set.

-- 1) Add the hash column (nullable — old profiles stay NULL).
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS signup_ip_hash TEXT;

CREATE INDEX IF NOT EXISTS profiles_signup_ip_hash_created
  ON profiles (signup_ip_hash, created_at DESC)
  WHERE signup_ip_hash IS NOT NULL;

-- 2) RPC called once per account (no-op if signup_ip_hash already set).
-- Returns JSONB:
--   { "claimed": true|false, "downgraded": true|false,
--     "reason": "already_set"|"no_ip"|"too_many_trials_from_ip"|"ok" }
CREATE OR REPLACE FUNCTION ep_claim_trial_with_ip_check(
  p_user_id UUID,
  p_ip_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_existing_hash TEXT;
  v_trials_from_ip INTEGER;
  v_current_plan TEXT;
  v_is_admin BOOLEAN;
BEGIN
  SELECT signup_ip_hash, plan, COALESCE(is_admin, false)
    INTO v_existing_hash, v_current_plan, v_is_admin
  FROM profiles WHERE id = p_user_id;

  -- Already set — nothing to do.
  IF v_existing_hash IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_set');
  END IF;

  -- Admins bypass entirely.
  IF v_is_admin THEN
    UPDATE profiles SET signup_ip_hash = p_ip_hash WHERE id = p_user_id;
    RETURN jsonb_build_object('claimed', true, 'reason', 'admin');
  END IF;

  -- No IP provided — record but don't downgrade (can't verify).
  IF p_ip_hash IS NULL OR p_ip_hash = '' THEN
    UPDATE profiles SET signup_ip_hash = 'unknown' WHERE id = p_user_id;
    RETURN jsonb_build_object('claimed', true, 'reason', 'no_ip');
  END IF;

  -- Count trials already opened from this IP in the last 30 days,
  -- excluding the current user.
  SELECT COUNT(*) INTO v_trials_from_ip
  FROM profiles
  WHERE signup_ip_hash = p_ip_hash
    AND id <> p_user_id
    AND created_at >= NOW() - INTERVAL '30 days';

  IF v_trials_from_ip >= 2 THEN
    -- Too many trials from this IP — flip to free, mark trial_used.
    UPDATE profiles
      SET signup_ip_hash = p_ip_hash,
          plan = 'free',
          trial_used = true,
          plan_expires_at = NULL
      WHERE id = p_user_id;
    RETURN jsonb_build_object(
      'claimed', true,
      'downgraded', true,
      'reason', 'too_many_trials_from_ip',
      'trials_from_ip', v_trials_from_ip
    );
  END IF;

  -- Clean IP — record hash but leave plan as-is (trial).
  UPDATE profiles SET signup_ip_hash = p_ip_hash WHERE id = p_user_id;
  RETURN jsonb_build_object(
    'claimed', true,
    'downgraded', false,
    'reason', 'ok',
    'trials_from_ip', v_trials_from_ip
  );
END;
$$;

REVOKE ALL ON FUNCTION ep_claim_trial_with_ip_check(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ep_claim_trial_with_ip_check(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION ep_claim_trial_with_ip_check IS
  'One-shot per-account trial claim with IP-based anti-farming. Called from /api/me.';
