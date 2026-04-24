-- ====== Global daily budget kill-switch ======
-- Reads ep_ai_cost_log to compute total USD spent in the last 24 hours.
-- If the sum exceeds the caller-supplied budget, returns allowed=false
-- so the server can return 503 to users (admins still pass).
--
-- The server calls this before each expensive AI endpoint. Admins bypass
-- via a separate profile.is_admin check in the caller.

CREATE OR REPLACE FUNCTION ep_check_global_budget(
  p_budget_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_cost_today NUMERIC;
BEGIN
  SELECT COALESCE(SUM(cost_usd), 0)::numeric INTO v_cost_today
  FROM ep_ai_cost_log
  WHERE created_at >= NOW() - INTERVAL '24 hours';

  IF v_cost_today >= p_budget_usd THEN
    RETURN jsonb_build_object(
      'ok', false,
      'cost_today_usd', v_cost_today,
      'budget_usd', p_budget_usd
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'cost_today_usd', v_cost_today,
    'budget_usd', p_budget_usd
  );
END;
$$;

REVOKE ALL ON FUNCTION ep_check_global_budget(NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ep_check_global_budget(NUMERIC) TO service_role;

COMMENT ON FUNCTION ep_check_global_budget IS
  'Global daily kill-switch. Returns ok=false when 24-hour AI spend >= budget.';
