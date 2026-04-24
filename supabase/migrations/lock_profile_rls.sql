-- =====================================================
-- Lock client-side updates to profiles.
-- Prior migration (security_hardening.sql) accidentally weakened the policy
-- to only block is_admin. Users could self-promote to paid plans via the
-- browser console. This restores + extends the original comprehensive check.
-- Server (service_role) bypasses RLS and mutates these via authenticated RPCs.
-- =====================================================

DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
DROP POLICY IF EXISTS "profiles_update_own_no_admin" ON profiles;
DROP POLICY IF EXISTS "profiles_self_update" ON profiles;
DROP POLICY IF EXISTS "profiles_update_own_locked" ON profiles;

CREATE POLICY "profiles_update_own_locked" ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    -- identity / role
    AND is_admin              IS NOT DISTINCT FROM (SELECT is_admin              FROM profiles WHERE id = auth.uid())
    AND email                 IS NOT DISTINCT FROM (SELECT email                 FROM profiles WHERE id = auth.uid())
    -- plan + trial state
    AND plan                  IS NOT DISTINCT FROM (SELECT plan                  FROM profiles WHERE id = auth.uid())
    AND plan_expires_at       IS NOT DISTINCT FROM (SELECT plan_expires_at       FROM profiles WHERE id = auth.uid())
    AND trial_started_at      IS NOT DISTINCT FROM (SELECT trial_started_at      FROM profiles WHERE id = auth.uid())
    AND trial_used            IS NOT DISTINCT FROM (SELECT trial_used            FROM profiles WHERE id = auth.uid())
    -- billing
    AND stripe_customer_id      IS NOT DISTINCT FROM (SELECT stripe_customer_id      FROM profiles WHERE id = auth.uid())
    AND stripe_subscription_id  IS NOT DISTINCT FROM (SELECT stripe_subscription_id  FROM profiles WHERE id = auth.uid())
    -- quota counters (all four features, daily + monthly + totals)
    AND pdfs_uploaded_today        IS NOT DISTINCT FROM (SELECT pdfs_uploaded_today        FROM profiles WHERE id = auth.uid())
    AND pdfs_uploaded_this_month   IS NOT DISTINCT FROM (SELECT pdfs_uploaded_this_month   FROM profiles WHERE id = auth.uid())
    AND ai_questions_used_today       IS NOT DISTINCT FROM (SELECT ai_questions_used_today       FROM profiles WHERE id = auth.uid())
    AND ai_questions_used_this_month  IS NOT DISTINCT FROM (SELECT ai_questions_used_this_month  FROM profiles WHERE id = auth.uid())
    AND study_packs_used_today      IS NOT DISTINCT FROM (SELECT study_packs_used_today      FROM profiles WHERE id = auth.uid())
    AND study_packs_used_this_month IS NOT DISTINCT FROM (SELECT study_packs_used_this_month FROM profiles WHERE id = auth.uid())
    AND study_packs_used_total      IS NOT DISTINCT FROM (SELECT study_packs_used_total      FROM profiles WHERE id = auth.uid())
    AND lab_questions_today       IS NOT DISTINCT FROM (SELECT lab_questions_today       FROM profiles WHERE id = auth.uid())
    AND lab_questions_this_month  IS NOT DISTINCT FROM (SELECT lab_questions_this_month  FROM profiles WHERE id = auth.uid())
    -- reset timestamps (otherwise clients can force an immediate reset by setting these to a past time)
    AND daily_reset_at    IS NOT DISTINCT FROM (SELECT daily_reset_at    FROM profiles WHERE id = auth.uid())
    AND monthly_reset_at  IS NOT DISTINCT FROM (SELECT monthly_reset_at  FROM profiles WHERE id = auth.uid())
  );
