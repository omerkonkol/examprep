-- =====================================================
-- Modelim: auto-propagate admin changes to all clones.
-- =====================================================
-- The source of truth is whichever user is recorded in
-- ep_app_config.template_user_id. When that user UPDATEs or DELETEs a
-- question, the trigger below mirrors the change to every other user on
-- plan='modelim'. Similarly for ep_exams status/name updates.
--
-- Matching is by (exam_name, question_number) — stable across clones
-- because ep_clone_modelim_data preserves both fields.
--
-- Idempotent (safe to re-run).

-- Point the template at the modelim admin account.
UPDATE ep_app_config
SET template_user_id = (SELECT id FROM profiles WHERE email = 'admin-modelim@examprep.com' LIMIT 1),
    updated_at = NOW()
WHERE id = 1;

-- =====================================================
-- Question propagation
-- =====================================================
CREATE OR REPLACE FUNCTION propagate_modelim_question_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src UUID;
  v_exam_name TEXT;
BEGIN
  SELECT template_user_id INTO v_src FROM ep_app_config WHERE id = 1;
  IF v_src IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.user_id <> v_src THEN RETURN OLD; END IF;
    SELECT name INTO v_exam_name FROM ep_exams WHERE id = OLD.exam_id;
    IF v_exam_name IS NOT NULL THEN
      DELETE FROM ep_questions
      WHERE id IN (
        SELECT q.id FROM ep_questions q
        JOIN ep_exams e ON e.id = q.exam_id
        JOIN profiles p ON p.id = q.user_id
        WHERE p.plan = 'modelim' AND p.id <> v_src
          AND q.question_number = OLD.question_number
          AND e.name = v_exam_name
      );
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT / UPDATE
  IF NEW.user_id <> v_src THEN RETURN NEW; END IF;
  SELECT name INTO v_exam_name FROM ep_exams WHERE id = NEW.exam_id;
  IF v_exam_name IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' THEN
    UPDATE ep_questions q
    SET correct_idx = NEW.correct_idx,
        image_path = NEW.image_path,
        num_options = NEW.num_options,
        option_labels = NEW.option_labels,
        topic = NEW.topic,
        answer_confidence = NEW.answer_confidence,
        question_text = NEW.question_text,
        options_text = NEW.options_text,
        general_explanation = NEW.general_explanation,
        option_explanations = NEW.option_explanations,
        instructor_solution_text = NEW.instructor_solution_text,
        has_rich_solution = NEW.has_rich_solution,
        context_text = NEW.context_text,
        context_image_path = NEW.context_image_path,
        context_cross_page = NEW.context_cross_page,
        group_id = NEW.group_id,
        solution_text_raw = NEW.solution_text_raw
    FROM ep_exams e, profiles p
    WHERE e.id = q.exam_id AND p.id = q.user_id
      AND p.plan = 'modelim' AND p.id <> v_src
      AND q.question_number = NEW.question_number
      AND e.name = v_exam_name;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION propagate_modelim_question_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS ep_questions_propagate_modelim ON ep_questions;
CREATE TRIGGER ep_questions_propagate_modelim
  AFTER UPDATE OR DELETE ON ep_questions
  FOR EACH ROW EXECUTE FUNCTION propagate_modelim_question_change();

-- =====================================================
-- Exam propagation (status + question_count + name)
-- =====================================================
CREATE OR REPLACE FUNCTION propagate_modelim_exam_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src UUID;
BEGIN
  SELECT template_user_id INTO v_src FROM ep_app_config WHERE id = 1;
  IF v_src IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.user_id <> v_src THEN RETURN OLD; END IF;
    DELETE FROM ep_exams e
    USING profiles p
    WHERE p.id = e.user_id AND p.plan = 'modelim' AND p.id <> v_src
      AND e.name = OLD.name;
    RETURN OLD;
  END IF;

  IF NEW.user_id <> v_src THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' THEN
    UPDATE ep_exams e
    SET status = NEW.status,
        question_count = NEW.question_count,
        total_pages = NEW.total_pages
    FROM profiles p
    WHERE p.id = e.user_id AND p.plan = 'modelim' AND p.id <> v_src
      AND e.name = COALESCE(OLD.name, NEW.name);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION propagate_modelim_exam_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS ep_exams_propagate_modelim ON ep_exams;
CREATE TRIGGER ep_exams_propagate_modelim
  AFTER UPDATE OR DELETE ON ep_exams
  FOR EACH ROW EXECUTE FUNCTION propagate_modelim_exam_change();

-- =====================================================
-- Manual reconcile RPC — for cases the triggers can't handle
-- (e.g. admin uploads a new exam: the questions land on admin's account
-- but nothing runs on the other clones. This RPC rebuilds any modelim
-- clone that's out of sync with the template.)
-- =====================================================
CREATE OR REPLACE FUNCTION ep_reconcile_modelim_clones()
RETURNS TABLE(email TEXT, action TEXT, exams_after INT, questions_after INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src UUID;
  v_src_exams INT;
  v_src_qs INT;
  r RECORD;
  v_clone_exams INT;
  v_clone_qs INT;
  v_action TEXT;
BEGIN
  SELECT template_user_id INTO v_src FROM ep_app_config WHERE id = 1;
  IF v_src IS NULL THEN RETURN; END IF;
  SELECT COUNT(*) INTO v_src_exams FROM ep_exams WHERE user_id = v_src;
  SELECT COUNT(*) INTO v_src_qs   FROM ep_questions WHERE user_id = v_src;

  FOR r IN SELECT id, email FROM profiles WHERE plan = 'modelim' AND id <> v_src LOOP
    SELECT COUNT(*) INTO v_clone_exams FROM ep_exams WHERE user_id = r.id;
    SELECT COUNT(*) INTO v_clone_qs    FROM ep_questions WHERE user_id = r.id;
    IF v_clone_exams = v_src_exams AND v_clone_qs = v_src_qs THEN
      v_action := 'in_sync';
    ELSE
      -- Nuke and re-clone.
      DELETE FROM ep_attempts WHERE user_id = r.id;
      DELETE FROM ep_questions WHERE user_id = r.id;
      DELETE FROM ep_exams WHERE user_id = r.id;
      DELETE FROM ep_courses WHERE user_id = r.id;
      PERFORM ep_clone_modelim_data(r.id);
      v_action := 'resynced';
    END IF;
    SELECT COUNT(*) INTO v_clone_exams FROM ep_exams WHERE user_id = r.id;
    SELECT COUNT(*) INTO v_clone_qs    FROM ep_questions WHERE user_id = r.id;
    email := r.email;
    action := v_action;
    exams_after := v_clone_exams;
    questions_after := v_clone_qs;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION ep_reconcile_modelim_clones() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ep_reconcile_modelim_clones() TO service_role;
