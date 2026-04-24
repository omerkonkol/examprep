-- Add lab question usage counters to profiles.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS lab_questions_today       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lab_questions_this_month  INTEGER NOT NULL DEFAULT 0;

-- Replace reset function to also zero out lab counters on daily/monthly rollover.
CREATE OR REPLACE FUNCTION reset_user_quotas_if_needed(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
  SET pdfs_uploaded_today        = 0,
      ai_questions_used_today    = 0,
      study_packs_used_today     = 0,
      lab_questions_today        = 0,
      daily_reset_at             = NOW()
  WHERE id = p_user_id
    AND daily_reset_at < (NOW() - INTERVAL '24 hours');

  UPDATE profiles
  SET pdfs_uploaded_this_month       = 0,
      ai_questions_used_this_month   = 0,
      study_packs_used_this_month    = 0,
      lab_questions_this_month       = 0,
      monthly_reset_at               = NOW()
  WHERE id = p_user_id
    AND monthly_reset_at < (NOW() - INTERVAL '30 days');
END;
$$;

-- Atomic RPC: check + reserve N lab question slots in one UPDATE.
-- Returns TRUE if reservation succeeded, FALSE if quota exhausted.
CREATE OR REPLACE FUNCTION ep_reserve_lab_slot(
  p_user_id   UUID,
  p_max_day   INTEGER DEFAULT -1,
  p_max_month INTEGER DEFAULT -1,
  p_count     INTEGER DEFAULT 1
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  IF p_max_day = -1 AND p_max_month = -1 THEN
    UPDATE profiles
    SET lab_questions_today      = lab_questions_today      + p_count,
        lab_questions_this_month = lab_questions_this_month + p_count
    WHERE id = p_user_id;
    RETURN TRUE;
  END IF;

  IF p_max_day <> -1 AND p_max_month <> -1 THEN
    UPDATE profiles
    SET lab_questions_today      = lab_questions_today      + p_count,
        lab_questions_this_month = lab_questions_this_month + p_count
    WHERE id = p_user_id
      AND lab_questions_today      + p_count <= p_max_day
      AND lab_questions_this_month + p_count <= p_max_month;
  ELSIF p_max_day <> -1 THEN
    UPDATE profiles
    SET lab_questions_today      = lab_questions_today      + p_count,
        lab_questions_this_month = lab_questions_this_month + p_count
    WHERE id = p_user_id
      AND lab_questions_today + p_count <= p_max_day;
  ELSE
    UPDATE profiles
    SET lab_questions_today      = lab_questions_today      + p_count,
        lab_questions_this_month = lab_questions_this_month + p_count
    WHERE id = p_user_id
      AND lab_questions_this_month + p_count <= p_max_month;
  END IF;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION ep_reserve_lab_slot(UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ep_reserve_lab_slot(UUID, INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION reset_user_quotas_if_needed(UUID) TO service_role;
