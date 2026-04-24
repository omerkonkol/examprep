-- =============================================================
-- ep_upload_jobs — async job queue for heavy AI workloads
-- =============================================================
-- Intended workloads:
--   kind='upload'        — future async upload pipeline
--   kind='reanalyze'     — bulk re-extract on existing exam
--   kind='explain_batch' — ensemble-generate explanations for N questions
--
-- Worker architecture (provisioned separately):
--   pg_cron every 10s → calls a Supabase Edge Function worker →
--   worker selects queued row, marks running, executes, updates status.
--
-- This migration only creates the storage + RLS. Worker setup is a
-- separate deploy step documented in CLAUDE/README.
-- =============================================================

CREATE TABLE IF NOT EXISTS ep_upload_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exam_id     bigint REFERENCES ep_exams(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('upload','reanalyze','explain_batch')),
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','failed','cancelled')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  result      jsonb,
  attempts    int  NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  last_error  text,
  priority    int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);

-- Worker polls by (status='queued' ordered by priority desc, created_at asc).
CREATE INDEX IF NOT EXISTS ep_upload_jobs_queue_idx
  ON ep_upload_jobs (status, priority DESC, created_at ASC)
  WHERE status IN ('queued','running');

-- User-scoped lookup for polling their own jobs from the frontend.
CREATE INDEX IF NOT EXISTS ep_upload_jobs_user_idx
  ON ep_upload_jobs (user_id, created_at DESC);

ALTER TABLE ep_upload_jobs ENABLE ROW LEVEL SECURITY;

-- SELECT: users read only their own jobs (for UI polling).
DROP POLICY IF EXISTS ep_upload_jobs_own_select ON ep_upload_jobs;
CREATE POLICY ep_upload_jobs_own_select ON ep_upload_jobs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- INSERT: users queue their own jobs.
DROP POLICY IF EXISTS ep_upload_jobs_own_insert ON ep_upload_jobs;
CREATE POLICY ep_upload_jobs_own_insert ON ep_upload_jobs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- UPDATE/DELETE restricted to service role (workers use service key).
-- No policy added → authenticated users cannot modify job state.

COMMENT ON TABLE ep_upload_jobs IS 'Async job queue (Layer 6). Workers poll queued rows, update to running/done/failed. Cron-driven external worker; no inline execution.';
