-- Raise IP farming threshold from 2 → 3.
-- The old threshold of 2 meant a developer's 3rd test account was immediately
-- downgraded to 'free'. Raising to 3 allows up to 3 accounts per IP per 30 days.

CREATE OR REPLACE FUNCTION ep_claim_trial_with_ip_check(
  p_user_id UUID,
  p_ip_hash  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_existing_hash  TEXT;
  v_trials_from_ip INTEGER;
  v_current_plan   TEXT;
  v_is_admin       BOOLEAN;
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

  IF v_trials_from_ip >= 3 THEN  -- was 2
    UPDATE profiles
      SET signup_ip_hash  = p_ip_hash,
          plan            = 'free',
          trial_used      = true,
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
