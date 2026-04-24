-- =====================================================
-- Modelim plan + copy-on-signup seed flow
-- =====================================================
-- Introduces a restricted "modelim" plan for friends of the Computational
-- Models course. When ep_app_config.seed_mode_enabled is TRUE, every new
-- signup lands on plan='modelim' and receives a clone of the template
-- account's degree/course/exams/questions. When FALSE, signup flow is
-- unchanged (trial/free path).
--
-- Run in Supabase SQL Editor. Idempotent.

-- ====== EP_APP_CONFIG (singleton) ======
-- Global toggles the service role manages. Authenticated clients may read
-- (so we could surface status), but only service_role writes.
CREATE TABLE IF NOT EXISTS ep_app_config (
  id                  INT PRIMARY KEY CHECK (id = 1),
  seed_mode_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  template_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ep_app_config (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

ALTER TABLE ep_app_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_app_config_select_all" ON ep_app_config;
CREATE POLICY "ep_app_config_select_all" ON ep_app_config
  FOR SELECT USING (true);
-- No INSERT/UPDATE/DELETE policies → only service_role can write.

-- ====== CLONE RPC ======
-- Copies the template user's single degree + single course + all exams and
-- questions into the target user's account. Idempotent: if the target user
-- already has a course named the same under the same degree, we skip.
CREATE OR REPLACE FUNCTION public.ep_clone_modelim_data(p_new_user UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_template UUID;
  v_src_degree_id BIGINT;
  v_src_course_id BIGINT;
  v_new_degree_id BIGINT;
  v_new_course_id BIGINT;
  v_existing_course_id BIGINT;
  v_src_exam RECORD;
  v_new_exam_id BIGINT;
BEGIN
  -- Fetch the template user id from the app config.
  SELECT template_user_id INTO v_template
  FROM ep_app_config WHERE id = 1;

  IF v_template IS NULL OR v_template = p_new_user THEN
    RAISE NOTICE 'ep_clone_modelim_data: no template_user_id set or same as target; skipping.';
    RETURN;
  END IF;

  -- Locate the source degree + course. We expect exactly one of each for the
  -- template account, matched by name (the seeding script creates them by
  -- these literal names).
  SELECT id INTO v_src_degree_id
  FROM ep_courses
  WHERE user_id = v_template
    AND COALESCE(is_degree, false) = true
    AND name = 'מדעי המחשב'
  LIMIT 1;

  IF v_src_degree_id IS NULL THEN
    RAISE NOTICE 'ep_clone_modelim_data: template degree "מדעי המחשב" not found; skipping.';
    RETURN;
  END IF;

  SELECT id INTO v_src_course_id
  FROM ep_courses
  WHERE user_id = v_template
    AND parent_id = v_src_degree_id
    AND name = 'מודלים חישוביים'
  LIMIT 1;

  IF v_src_course_id IS NULL THEN
    RAISE NOTICE 'ep_clone_modelim_data: template course "מודלים חישוביים" not found; skipping.';
    RETURN;
  END IF;

  -- Idempotency guard: if the target user already has this course under a
  -- degree of the same name, do nothing.
  SELECT c.id INTO v_existing_course_id
  FROM ep_courses c
  JOIN ep_courses d ON d.id = c.parent_id
  WHERE c.user_id = p_new_user
    AND c.name = 'מודלים חישוביים'
    AND d.user_id = p_new_user
    AND d.name = 'מדעי המחשב'
  LIMIT 1;

  IF v_existing_course_id IS NOT NULL THEN
    RAISE NOTICE 'ep_clone_modelim_data: target user already seeded; skipping.';
    RETURN;
  END IF;

  -- Clone the degree row.
  INSERT INTO ep_courses (user_id, name, description, color, image_url, is_degree, parent_id)
  SELECT p_new_user, name, description, color, image_url, true, NULL
  FROM ep_courses WHERE id = v_src_degree_id
  RETURNING id INTO v_new_degree_id;

  -- Clone the course row (under the new degree).
  INSERT INTO ep_courses (user_id, name, description, color, image_url, is_degree,
                          parent_id, total_questions, total_pdfs)
  SELECT p_new_user, name, description, color, image_url, false,
         v_new_degree_id, total_questions, total_pdfs
  FROM ep_courses WHERE id = v_src_course_id
  RETURNING id INTO v_new_course_id;

  -- Clone every exam + its questions.
  FOR v_src_exam IN
    SELECT * FROM ep_exams
    WHERE user_id = v_template AND course_id = v_src_course_id
    ORDER BY id
  LOOP
    INSERT INTO ep_exams (
      course_id, user_id, name,
      exam_pdf_path, solution_pdf_path, exam_pdf_hash,
      total_pages, question_count, status, error_message, processed_at
    )
    VALUES (
      v_new_course_id, p_new_user, v_src_exam.name,
      v_src_exam.exam_pdf_path, v_src_exam.solution_pdf_path, v_src_exam.exam_pdf_hash,
      v_src_exam.total_pages, v_src_exam.question_count, v_src_exam.status,
      v_src_exam.error_message, v_src_exam.processed_at
    )
    RETURNING id INTO v_new_exam_id;

    INSERT INTO ep_questions (
      exam_id, course_id, user_id,
      question_number, section_label, image_path,
      num_options, option_labels, correct_idx, topic,
      is_ai_generated,
      general_explanation, option_explanations,
      question_text, options_text,
      group_id, context_text, context_image_path, context_cross_page,
      answer_confidence, instructor_solution_text, has_rich_solution,
      solution_text_raw, deleted_at
    )
    SELECT
      v_new_exam_id, v_new_course_id, p_new_user,
      question_number, section_label, image_path,
      num_options, option_labels, correct_idx, topic,
      COALESCE(is_ai_generated, false),
      general_explanation, option_explanations,
      question_text, options_text,
      group_id, context_text, context_image_path, COALESCE(context_cross_page, false),
      COALESCE(answer_confidence, 'confirmed'), instructor_solution_text, COALESCE(has_rich_solution, false),
      solution_text_raw, deleted_at
    FROM ep_questions
    WHERE exam_id = v_src_exam.id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.ep_clone_modelim_data(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ep_clone_modelim_data(UUID) TO service_role;

-- ====== REPLACE handle_new_user TO BRANCH ON SEED MODE ======
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seed_mode BOOLEAN;
  v_plan TEXT;
  v_trial_started TIMESTAMPTZ;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT seed_mode_enabled INTO v_seed_mode FROM ep_app_config WHERE id = 1;
  v_seed_mode := COALESCE(v_seed_mode, false);

  IF v_seed_mode THEN
    v_plan := 'modelim';
    v_trial_started := NULL;
    v_expires := NULL;
  ELSE
    v_plan := 'trial';
    v_trial_started := NOW();
    v_expires := NOW() + INTERVAL '14 days';
  END IF;

  INSERT INTO public.profiles (id, email, display_name, plan, trial_started_at, plan_expires_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'username',
      split_part(NEW.email, '@', 1)
    ),
    v_plan,
    v_trial_started,
    v_expires
  )
  ON CONFLICT (id) DO NOTHING;

  IF v_seed_mode THEN
    BEGIN
      PERFORM public.ep_clone_modelim_data(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      -- Never block signup on clone failure; log and continue.
      RAISE WARNING 'ep_clone_modelim_data failed for user %: %', NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger already exists (on_auth_user_created); redefining the function is enough.

-- ====== KEEP MODELIM USERS FROM BEING DOWNGRADED ======
-- The IP-trial-farming check downgrades users to 'free' when ≥3 accounts
-- share one IP. Modelim users must be exempt (multiple friends from the
-- same course may sign up from the same campus network).
CREATE OR REPLACE FUNCTION ep_claim_trial_with_ip_check(
  p_user_id UUID,
  p_ip_hash TEXT
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

  IF v_existing_hash IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_set');
  END IF;

  IF v_is_admin THEN
    UPDATE profiles SET signup_ip_hash = p_ip_hash WHERE id = p_user_id;
    RETURN jsonb_build_object('claimed', true, 'reason', 'admin');
  END IF;

  -- Modelim users are exempt from the IP-trial downgrade logic.
  IF v_current_plan = 'modelim' THEN
    UPDATE profiles
      SET signup_ip_hash = COALESCE(p_ip_hash, 'unknown')
    WHERE id = p_user_id;
    RETURN jsonb_build_object('claimed', true, 'reason', 'modelim');
  END IF;

  IF p_ip_hash IS NULL OR p_ip_hash = '' THEN
    UPDATE profiles SET signup_ip_hash = 'unknown' WHERE id = p_user_id;
    RETURN jsonb_build_object('claimed', true, 'reason', 'no_ip');
  END IF;

  SELECT COUNT(*) INTO v_trials_from_ip
  FROM profiles
  WHERE signup_ip_hash = p_ip_hash
    AND id <> p_user_id
    AND created_at >= NOW() - INTERVAL '30 days';

  IF v_trials_from_ip >= 3 THEN
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
