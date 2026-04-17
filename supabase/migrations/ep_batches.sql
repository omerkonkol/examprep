-- =====================================================
-- ep_batches — per-course practice history synced to the cloud
-- Replaces the previous localStorage-only storage so every user
-- sees their batches on any device after login.
-- =====================================================

CREATE TABLE IF NOT EXISTS ep_batches (
  id TEXT PRIMARY KEY,                       -- client-generated batchId (e.g. "b_<ts>")
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id BIGINT NOT NULL REFERENCES ep_courses(id) ON DELETE CASCADE,
  exam_id BIGINT REFERENCES ep_exams(id) ON DELETE SET NULL,
  size INT NOT NULL,
  correct INT NOT NULL DEFAULT 0,
  wrong INT NOT NULL DEFAULT 0,
  exam_mode BOOLEAN NOT NULL DEFAULT false,
  qids JSONB NOT NULL,                       -- array of question ids in order presented
  selections JSONB,                          -- { [qid]: selectedIdx }
  correct_map JSONB,                         -- { [qid]: bool }
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ep_batches_user_course_idx
  ON ep_batches(user_id, course_id, ended_at DESC NULLS LAST);

ALTER TABLE ep_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_batches_select_own" ON ep_batches;
CREATE POLICY "ep_batches_select_own" ON ep_batches
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_batches_insert_own" ON ep_batches;
CREATE POLICY "ep_batches_insert_own" ON ep_batches
  FOR INSERT WITH CHECK (
    auth.uid() = user_id AND
    course_id IN (SELECT id FROM ep_courses WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "ep_batches_update_own" ON ep_batches;
CREATE POLICY "ep_batches_update_own" ON ep_batches
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_batches_delete_own" ON ep_batches;
CREATE POLICY "ep_batches_delete_own" ON ep_batches
  FOR DELETE USING (auth.uid() = user_id);
