-- Restore trial-expiry logic to reset_user_quotas_if_needed.
-- pack_day_quota.sql replaced this function but accidentally dropped the
-- trial→free expiry UPDATE (step 1 from harden_trial_expiry.sql).
-- Vercel API functions that call this RPC directly would miss expiry without it.

CREATE OR REPLACE FUNCTION reset_user_quotas_if_needed(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- (1) Expire trial → free when plan_expires_at has passed.
  UPDATE profiles
  SET plan = 'free',
      trial_used = true,
      plan_expires_at = NULL
  WHERE id = p_user_id
    AND plan = 'trial'
    AND plan_expires_at IS NOT NULL
    AND plan_expires_at < NOW();

  -- (2) Reset daily counters if rolled over.
  UPDATE profiles
  SET pdfs_uploaded_today      = 0,
      ai_questions_used_today  = 0,
      study_packs_used_today   = 0,
      daily_reset_at           = NOW()
  WHERE id = p_user_id
    AND daily_reset_at < (NOW() - INTERVAL '24 hours');

  -- (3) Reset monthly counters if rolled over.
  UPDATE profiles
  SET pdfs_uploaded_this_month     = 0,
      ai_questions_used_this_month = 0,
      study_packs_used_this_month  = 0,
      monthly_reset_at             = NOW()
  WHERE id = p_user_id
    AND monthly_reset_at < (NOW() - INTERVAL '30 days');
END;
$$;

REVOKE ALL ON FUNCTION reset_user_quotas_if_needed(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_user_quotas_if_needed(UUID) TO service_role;
