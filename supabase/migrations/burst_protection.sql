-- ====== Per-user burst protection ======
-- Prevents authenticated users from spamming expensive endpoints (e.g.
-- fire 100 parallel AI requests in a few seconds). Complements the daily
-- quota (ep_reserve_ai_slots) which is atomic but per-day, not per-minute.
--
-- Storage: one row per request (purged by a periodic job — TTL 15 min).

CREATE TABLE IF NOT EXISTS ep_user_request_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL,                -- 'ai' | 'upload' | 'pack' | ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ep_user_request_log_lookup
  ON ep_user_request_log (user_id, bucket, created_at DESC);

ALTER TABLE ep_user_request_log ENABLE ROW LEVEL SECURITY;

-- Only the service role writes/reads this table. Regular users have no
-- direct access — the server enforces via the RPC below.
DROP POLICY IF EXISTS "ep_user_request_log_no_client" ON ep_user_request_log;
CREATE POLICY "ep_user_request_log_no_client" ON ep_user_request_log
  FOR ALL USING (false) WITH CHECK (false);

-- Atomically check-and-record a user's request rate.
-- Admins bypass. Returns JSON:
--   { "allowed": true|false, "count_last_minute": N, "max_per_minute": M,
--     "retry_after_seconds": S }
CREATE OR REPLACE FUNCTION ep_check_burst(
  p_user_id UUID,
  p_bucket  TEXT,
  p_max_per_minute INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_count  INTEGER;
  v_oldest TIMESTAMPTZ;
  v_is_admin BOOLEAN;
BEGIN
  -- Admins never get throttled.
  SELECT COALESCE(is_admin, false) INTO v_is_admin
  FROM profiles WHERE id = p_user_id;
  IF v_is_admin THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'admin');
  END IF;

  -- Count recent requests in this bucket.
  SELECT COUNT(*), MIN(created_at)
    INTO v_count, v_oldest
  FROM ep_user_request_log
  WHERE user_id = p_user_id
    AND bucket = p_bucket
    AND created_at >= NOW() - INTERVAL '60 seconds';

  IF v_count >= p_max_per_minute THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'count_last_minute', v_count,
      'max_per_minute', p_max_per_minute,
      'retry_after_seconds', GREATEST(1, 60 - EXTRACT(EPOCH FROM (NOW() - v_oldest))::int)
    );
  END IF;

  -- Record this request and allow it.
  INSERT INTO ep_user_request_log (user_id, bucket) VALUES (p_user_id, p_bucket);

  -- Opportunistic cleanup: delete rows older than 15 min (1 in ~50 calls).
  -- Keeps the table small without needing a cron job.
  IF random() < 0.02 THEN
    DELETE FROM ep_user_request_log
    WHERE created_at < NOW() - INTERVAL '15 minutes';
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'count_last_minute', v_count + 1,
    'max_per_minute', p_max_per_minute
  );
END;
$$;

REVOKE ALL ON FUNCTION ep_check_burst(UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ep_check_burst(UUID, TEXT, INTEGER) TO service_role;

COMMENT ON TABLE ep_user_request_log IS 'Per-user request log for per-minute burst throttling. Rows expire after 15 minutes.';
COMMENT ON FUNCTION ep_check_burst IS 'Atomic burst check + record. Call before every expensive authenticated endpoint.';
