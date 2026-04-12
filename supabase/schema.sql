-- =====================================================
-- ExamPrep - Supabase Schema (with ep_ prefix to coexist with other apps)
-- =====================================================
-- Run this in your Supabase SQL Editor

-- ====== EXTEND PROFILES (or create if doesn't exist) ======
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add ExamPrep-specific columns (safe to run multiple times)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pdfs_uploaded_this_month INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ai_questions_used_this_month INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS storage_bytes_used BIGINT NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pdfs_uploaded_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ai_questions_used_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS daily_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS monthly_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- Smart Study (summary → AI study materials) usage counters
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS study_packs_used_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS study_packs_used_this_month INTEGER NOT NULL DEFAULT 0;
-- Trial tracking
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trial_used BOOLEAN NOT NULL DEFAULT FALSE;

-- Make sure RLS is on
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON profiles;
CREATE POLICY "profiles_insert_own" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
-- Allow users to update their own profile, but BLOCK changes to privileged
-- columns (plan, is_admin, stripe, trial). Only supabaseAdmin (service_role)
-- can change those — the client SDK uses anon/authenticated role.
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND plan = (SELECT plan FROM profiles WHERE id = auth.uid())
    AND is_admin = (SELECT is_admin FROM profiles WHERE id = auth.uid())
    AND plan_expires_at IS NOT DISTINCT FROM (SELECT plan_expires_at FROM profiles WHERE id = auth.uid())
    AND trial_started_at IS NOT DISTINCT FROM (SELECT trial_started_at FROM profiles WHERE id = auth.uid())
    AND trial_used = (SELECT trial_used FROM profiles WHERE id = auth.uid())
    AND stripe_customer_id IS NOT DISTINCT FROM (SELECT stripe_customer_id FROM profiles WHERE id = auth.uid())
    AND stripe_subscription_id IS NOT DISTINCT FROM (SELECT stripe_subscription_id FROM profiles WHERE id = auth.uid())
  );

-- ====== EP_COURSES ======
CREATE TABLE IF NOT EXISTS ep_courses (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT DEFAULT '#3b82f6',
  total_questions INTEGER NOT NULL DEFAULT 0,
  total_pdfs INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ep_courses_user_idx ON ep_courses(user_id);

ALTER TABLE ep_courses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_courses_select_own" ON ep_courses;
CREATE POLICY "ep_courses_select_own" ON ep_courses FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_courses_insert_own" ON ep_courses;
CREATE POLICY "ep_courses_insert_own" ON ep_courses FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_courses_update_own" ON ep_courses;
CREATE POLICY "ep_courses_update_own" ON ep_courses FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_courses_delete_own" ON ep_courses;
CREATE POLICY "ep_courses_delete_own" ON ep_courses FOR DELETE USING (auth.uid() = user_id);

-- ====== EP_EXAMS ======
CREATE TABLE IF NOT EXISTS ep_exams (
  id BIGSERIAL PRIMARY KEY,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  exam_pdf_path TEXT,
  solution_pdf_path TEXT,
  exam_pdf_hash TEXT,
  total_pages INTEGER,
  question_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ep_exams_course_idx ON ep_exams(course_id);
CREATE INDEX IF NOT EXISTS ep_exams_user_idx ON ep_exams(user_id);
CREATE INDEX IF NOT EXISTS ep_exams_hash_idx ON ep_exams(user_id, exam_pdf_hash);

ALTER TABLE ep_exams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_exams_select_own" ON ep_exams;
CREATE POLICY "ep_exams_select_own" ON ep_exams FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_exams_insert_own" ON ep_exams;
CREATE POLICY "ep_exams_insert_own" ON ep_exams FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_exams_update_own" ON ep_exams;
CREATE POLICY "ep_exams_update_own" ON ep_exams FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_exams_delete_own" ON ep_exams;
CREATE POLICY "ep_exams_delete_own" ON ep_exams FOR DELETE USING (auth.uid() = user_id);

-- ====== EP_QUESTIONS ======
CREATE TABLE IF NOT EXISTS ep_questions (
  id BIGSERIAL PRIMARY KEY,
  exam_id BIGINT REFERENCES ep_exams(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_number INTEGER NOT NULL,
  section_label TEXT,
  image_path TEXT NOT NULL,
  num_options INTEGER NOT NULL DEFAULT 4,
  option_labels JSONB,
  correct_idx INTEGER NOT NULL,
  topic TEXT,
  is_ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
  source_question_id BIGINT REFERENCES ep_questions(id) ON DELETE SET NULL,
  general_explanation TEXT,
  option_explanations JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ep_questions_exam_idx ON ep_questions(exam_id);
CREATE INDEX IF NOT EXISTS ep_questions_course_idx ON ep_questions(course_id);

-- Idempotent column additions for tables that may pre-exist from an older
-- schema run (e.g. setup-with-sample-data.sql which lacks these columns).
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS is_ai_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS source_question_id BIGINT REFERENCES ep_questions(id) ON DELETE SET NULL;
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS general_explanation TEXT;
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS option_explanations JSONB;
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS question_text TEXT;
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS options_text JSONB;

ALTER TABLE ep_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_questions_select_own" ON ep_questions;
CREATE POLICY "ep_questions_select_own" ON ep_questions FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_questions_insert_own" ON ep_questions;
CREATE POLICY "ep_questions_insert_own" ON ep_questions FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_questions_update_own" ON ep_questions;
CREATE POLICY "ep_questions_update_own" ON ep_questions FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_questions_delete_own" ON ep_questions;
CREATE POLICY "ep_questions_delete_own" ON ep_questions FOR DELETE USING (auth.uid() = user_id);

-- ====== EP_ATTEMPTS ======
CREATE TABLE IF NOT EXISTS ep_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_id BIGINT REFERENCES ep_questions(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  selected_idx INTEGER,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  revealed BOOLEAN NOT NULL DEFAULT FALSE,
  time_seconds INTEGER,
  batch_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ep_attempts_user_idx ON ep_attempts(user_id);
CREATE INDEX IF NOT EXISTS ep_attempts_question_idx ON ep_attempts(question_id);

ALTER TABLE ep_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_attempts_select_own" ON ep_attempts;
CREATE POLICY "ep_attempts_select_own" ON ep_attempts FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_attempts_insert_own" ON ep_attempts;
CREATE POLICY "ep_attempts_insert_own" ON ep_attempts FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ====== EP_REVIEW_QUEUE ======
CREATE TABLE IF NOT EXISTS ep_review_queue (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_id BIGINT REFERENCES ep_questions(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, question_id)
);

ALTER TABLE ep_review_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_review_queue_select_own" ON ep_review_queue;
CREATE POLICY "ep_review_queue_select_own" ON ep_review_queue FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_review_queue_insert_own" ON ep_review_queue;
CREATE POLICY "ep_review_queue_insert_own" ON ep_review_queue FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_review_queue_delete_own" ON ep_review_queue;
CREATE POLICY "ep_review_queue_delete_own" ON ep_review_queue FOR DELETE USING (auth.uid() = user_id);

-- ====== ATOMIC QUOTA RPCs ======
-- Race-safe quota enforcement. The server cannot just SELECT-then-UPDATE
-- because concurrent uploads from the same user would both pass the check.
-- These functions perform the check and the increment in a single statement.

-- Reset daily/monthly counters if their window has rolled over.
CREATE OR REPLACE FUNCTION reset_user_quotas_if_needed(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
  SET pdfs_uploaded_today = 0,
      ai_questions_used_today = 0,
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

-- Atomically reserve one PDF upload slot. Returns true if granted.
-- Pass -1 for any "unlimited" cap to skip that check.
CREATE OR REPLACE FUNCTION ep_reserve_pdf_slot(
  p_user_id UUID,
  p_max_today INTEGER,
  p_max_month INTEGER,
  p_max_total INTEGER,
  p_max_storage_bytes BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_total_count INTEGER;
  v_updated INTEGER;
BEGIN
  -- Lifetime cap (free plan only). Counts existing exam rows.
  IF p_max_total <> -1 THEN
    SELECT COUNT(*) INTO v_total_count
    FROM ep_exams WHERE user_id = p_user_id;
    IF v_total_count >= p_max_total THEN RETURN FALSE; END IF;
  END IF;

  UPDATE profiles
  SET pdfs_uploaded_today = pdfs_uploaded_today + 1,
      pdfs_uploaded_this_month = pdfs_uploaded_this_month + 1
  WHERE id = p_user_id
    AND pdfs_uploaded_today < p_max_today
    AND pdfs_uploaded_this_month < p_max_month
    AND storage_bytes_used < p_max_storage_bytes;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

-- Atomically reserve N AI generation slots.
CREATE OR REPLACE FUNCTION ep_reserve_ai_slots(
  p_user_id UUID,
  p_count INTEGER,
  p_max_day INTEGER,
  p_max_month INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  IF p_count < 1 OR p_count > 50 THEN RETURN FALSE; END IF;

  UPDATE profiles
  SET ai_questions_used_today = ai_questions_used_today + p_count,
      ai_questions_used_this_month = ai_questions_used_this_month + p_count
  WHERE id = p_user_id
    AND ai_questions_used_today + p_count <= p_max_day
    AND ai_questions_used_this_month + p_count <= p_max_month;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

-- ====== EP_STUDY_PACKS (Smart Study from Summary feature) ======
-- A "study pack" is the AI-generated bundle (questions, flashcards, outline,
-- glossary, open questions, self-test) produced from one summary the user
-- uploaded — either as PDF (text-extracted, no image processing) or pasted text.
CREATE TABLE IF NOT EXISTS ep_study_packs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('pdf', 'paste')),
  source_text_excerpt TEXT,
  source_char_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error_message TEXT,
  materials JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ep_study_packs_user_idx ON ep_study_packs(user_id);
CREATE INDEX IF NOT EXISTS ep_study_packs_user_created_idx ON ep_study_packs(user_id, created_at DESC);

ALTER TABLE ep_study_packs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_study_packs_select_own" ON ep_study_packs;
CREATE POLICY "ep_study_packs_select_own" ON ep_study_packs FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_study_packs_insert_own" ON ep_study_packs;
CREATE POLICY "ep_study_packs_insert_own" ON ep_study_packs FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_study_packs_update_own" ON ep_study_packs;
CREATE POLICY "ep_study_packs_update_own" ON ep_study_packs FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_study_packs_delete_own" ON ep_study_packs;
CREATE POLICY "ep_study_packs_delete_own" ON ep_study_packs FOR DELETE USING (auth.uid() = user_id);

-- Atomically reserve one Study Pack slot. Mirrors ep_reserve_pdf_slot.
-- Pass -1 for any "unlimited" cap to skip that check.
CREATE OR REPLACE FUNCTION ep_reserve_study_pack_slot(
  p_user_id UUID,
  p_max_total INTEGER,
  p_max_month INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_total_count INTEGER;
  v_updated INTEGER;
BEGIN
  -- Lifetime cap (free plan = 2 packs ever).
  IF p_max_total <> -1 THEN
    SELECT study_packs_used_total INTO v_total_count
    FROM profiles WHERE id = p_user_id;
    IF v_total_count IS NULL THEN v_total_count := 0; END IF;
    IF v_total_count >= p_max_total THEN RETURN FALSE; END IF;
  END IF;

  IF p_max_month <> -1 THEN
    UPDATE profiles
    SET study_packs_used_total = study_packs_used_total + 1,
        study_packs_used_this_month = study_packs_used_this_month + 1
    WHERE id = p_user_id
      AND study_packs_used_this_month < p_max_month;
  ELSE
    UPDATE profiles
    SET study_packs_used_total = study_packs_used_total + 1,
        study_packs_used_this_month = study_packs_used_this_month + 1
    WHERE id = p_user_id;
  END IF;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

-- ====== EP_IP_THROTTLE (anti-abuse: token-burning defense) ======
-- Tracks per-IP usage of expensive AI endpoints across rolling daily and
-- weekly windows. The per-account quota alone (2 free study packs lifetime)
-- is not enough — an attacker can sock-puppet new accounts and burn the
-- quota again on each one. This table puts a hard ceiling on how often any
-- single source IP can trigger Gemini regardless of which (or no) account
-- is logged in.
--
-- Privacy: stores SHA-256(server_salt + ip), not raw IPs, so we don't keep
-- PII. The salt lives in IP_HASH_SALT env on the app server.
CREATE TABLE IF NOT EXISTS ep_ip_throttle (
  ip_hash TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count_today INTEGER NOT NULL DEFAULT 0,
  count_week INTEGER NOT NULL DEFAULT 0,
  daily_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  weekly_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ip_hash, bucket)
);

CREATE INDEX IF NOT EXISTS ep_ip_throttle_blocked_idx
  ON ep_ip_throttle(blocked_until)
  WHERE blocked_until IS NOT NULL;

-- RLS on with no policies = nothing reachable from anon/user contexts.
-- Only the service-role server may read/write this table.
ALTER TABLE ep_ip_throttle ENABLE ROW LEVEL SECURITY;

-- Atomically check + increment IP usage for one bucket.
-- Returns a JSONB object:
--   { allowed: bool, blocked_until?: timestamptz,
--     count_today: int, count_week: int, reason?: text }
-- Pass p_block_hours to set how long an offending IP stays blocked once
-- it trips a daily or weekly cap.
CREATE OR REPLACE FUNCTION ep_check_ip_throttle(
  p_ip_hash TEXT,
  p_bucket TEXT,
  p_max_day INTEGER,
  p_max_week INTEGER,
  p_block_hours INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_row ep_ip_throttle%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
  v_blocked_until TIMESTAMPTZ;
BEGIN
  IF p_ip_hash IS NULL OR length(p_ip_hash) < 16 THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'no_ip');
  END IF;

  -- Insert-or-fetch the row.
  INSERT INTO ep_ip_throttle (ip_hash, bucket)
  VALUES (p_ip_hash, p_bucket)
  ON CONFLICT (ip_hash, bucket) DO NOTHING;

  -- Lock the row so concurrent requests serialize on it.
  SELECT * INTO v_row
  FROM ep_ip_throttle
  WHERE ip_hash = p_ip_hash AND bucket = p_bucket
  FOR UPDATE;

  -- Currently in a temporary block?
  IF v_row.blocked_until IS NOT NULL AND v_row.blocked_until > v_now THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'blocked_until', v_row.blocked_until,
      'count_today', v_row.count_today,
      'count_week', v_row.count_week,
      'reason', 'blocked'
    );
  END IF;

  -- Roll over windows if expired.
  IF v_row.daily_reset_at < v_now - INTERVAL '24 hours' THEN
    v_row.count_today := 0;
    v_row.daily_reset_at := v_now;
  END IF;
  IF v_row.weekly_reset_at < v_now - INTERVAL '7 days' THEN
    v_row.count_week := 0;
    v_row.weekly_reset_at := v_now;
  END IF;

  -- Over the cap? Set a temporary block and refuse.
  IF v_row.count_today >= p_max_day OR v_row.count_week >= p_max_week THEN
    v_blocked_until := v_now + (p_block_hours * INTERVAL '1 hour');
    UPDATE ep_ip_throttle
    SET blocked_until = v_blocked_until,
        last_seen_at = v_now,
        daily_reset_at = v_row.daily_reset_at,
        weekly_reset_at = v_row.weekly_reset_at,
        count_today = v_row.count_today,
        count_week = v_row.count_week
    WHERE ip_hash = p_ip_hash AND bucket = p_bucket;
    RETURN jsonb_build_object(
      'allowed', false,
      'blocked_until', v_blocked_until,
      'count_today', v_row.count_today,
      'count_week', v_row.count_week,
      'reason', 'limit_exceeded'
    );
  END IF;

  -- Allowed: increment counters, clear any stale block.
  v_row.count_today := v_row.count_today + 1;
  v_row.count_week := v_row.count_week + 1;
  UPDATE ep_ip_throttle
  SET count_today = v_row.count_today,
      count_week = v_row.count_week,
      daily_reset_at = v_row.daily_reset_at,
      weekly_reset_at = v_row.weekly_reset_at,
      blocked_until = NULL,
      last_seen_at = v_now
  WHERE ip_hash = p_ip_hash AND bucket = p_bucket;

  RETURN jsonb_build_object(
    'allowed', true,
    'count_today', v_row.count_today,
    'count_week', v_row.count_week
  );
END;
$$;

-- ====== EP_CONTACT_MESSAGES ======
-- Stores contact form submissions. No user_id FK because anonymous visitors
-- can submit. Only service-role may insert/read (no public RLS policies).
CREATE TABLE IF NOT EXISTS ep_contact_messages (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT 'general',
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ep_contact_messages_created_idx
  ON ep_contact_messages(created_at DESC);

-- RLS on with no policies = only service_role can read/write.
ALTER TABLE ep_contact_messages ENABLE ROW LEVEL SECURITY;

-- ====== AUTO-PROFILE TRIGGER ======
-- Automatically create a profiles row when any new user signs up,
-- including Google OAuth users. Runs as SECURITY DEFINER to bypass RLS.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, plan, trial_started_at, plan_expires_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'username',
      split_part(NEW.email, '@', 1)
    ),
    'trial',
    NOW(),
    NOW() + INTERVAL '14 days'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Lock these RPCs so only the service role + the owner can call them.
REVOKE ALL ON FUNCTION reset_user_quotas_if_needed(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ep_reserve_pdf_slot(UUID, INTEGER, INTEGER, INTEGER, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ep_reserve_ai_slots(UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION ep_reserve_study_pack_slot(UUID, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION ep_check_ip_throttle(TEXT, TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_user_quotas_if_needed(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION ep_reserve_pdf_slot(UUID, INTEGER, INTEGER, INTEGER, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION ep_reserve_ai_slots(UUID, INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION ep_reserve_study_pack_slot(UUID, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION ep_check_ip_throttle(TEXT, TEXT, INTEGER, INTEGER, INTEGER) TO service_role;
