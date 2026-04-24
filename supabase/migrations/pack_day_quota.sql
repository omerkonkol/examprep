-- Add daily study-pack counter so we can enforce per-day limits.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS study_packs_used_today INTEGER NOT NULL DEFAULT 0;

-- Reset study_packs_used_today alongside the other daily counters.
CREATE OR REPLACE FUNCTION reset_user_quotas_if_needed(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
  SET pdfs_uploaded_today = 0,
      ai_questions_used_today = 0,
      study_packs_used_today = 0,
      daily_reset_at = NOW()
  WHERE id = p_user_id
    AND daily_reset_at < (NOW() - INTERVAL '24 hours');

  UPDATE profiles
  SET pdfs_uploaded_this_month = 0,
      ai_questions_used_this_month = 0,
      study_packs_used_this_month = 0,
      monthly_reset_at = NOW()
  WHERE id = p_user_id
    AND monthly_reset_at < (NOW() - INTERVAL '30 days');
END;
$$;

-- Drop old 3-arg version; new version adds p_max_day with DEFAULT -1.
DROP FUNCTION IF EXISTS ep_reserve_study_pack_slot(UUID, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION ep_reserve_study_pack_slot(
  p_user_id   UUID,
  p_max_total INTEGER,
  p_max_month INTEGER,
  p_max_day   INTEGER DEFAULT -1
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_total_count INTEGER;
  v_updated     INTEGER;
BEGIN
  -- Lifetime cap.
  IF p_max_total <> -1 THEN
    SELECT study_packs_used_total INTO v_total_count
    FROM profiles WHERE id = p_user_id;
    IF v_total_count IS NULL THEN v_total_count := 0; END IF;
    IF v_total_count >= p_max_total THEN RETURN FALSE; END IF;
  END IF;

  -- Build the UPDATE dynamically based on which caps are active.
  IF p_max_month <> -1 AND p_max_day <> -1 THEN
    UPDATE profiles
    SET study_packs_used_total        = study_packs_used_total + 1,
        study_packs_used_this_month   = study_packs_used_this_month + 1,
        study_packs_used_today        = study_packs_used_today + 1
    WHERE id = p_user_id
      AND study_packs_used_this_month < p_max_month
      AND study_packs_used_today      < p_max_day;

  ELSIF p_max_month <> -1 THEN
    UPDATE profiles
    SET study_packs_used_total        = study_packs_used_total + 1,
        study_packs_used_this_month   = study_packs_used_this_month + 1,
        study_packs_used_today        = study_packs_used_today + 1
    WHERE id = p_user_id
      AND study_packs_used_this_month < p_max_month;

  ELSIF p_max_day <> -1 THEN
    UPDATE profiles
    SET study_packs_used_total        = study_packs_used_total + 1,
        study_packs_used_this_month   = study_packs_used_this_month + 1,
        study_packs_used_today        = study_packs_used_today + 1
    WHERE id = p_user_id
      AND study_packs_used_today < p_max_day;

  ELSE
    UPDATE profiles
    SET study_packs_used_total        = study_packs_used_total + 1,
        study_packs_used_this_month   = study_packs_used_this_month + 1,
        study_packs_used_today        = study_packs_used_today + 1
    WHERE id = p_user_id;
  END IF;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION ep_reserve_study_pack_slot(UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ep_reserve_study_pack_slot(UUID, INTEGER, INTEGER, INTEGER) TO service_role;
