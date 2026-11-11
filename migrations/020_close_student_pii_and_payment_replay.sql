-- ============================================================================
-- Migration 020: Close student PII exposure & payment-reference replay
-- Date: 2026-11-11
--
-- 1. CRITICAL (NDPR): The "students_directory_read" RLS policy (migration 007)
--    let ANY authenticated user SELECT every column (email, phone, matric_no,
--    privacy_settings ...) of every active, non-private student directly via
--    the Supabase REST API with the public anon key. Per-field privacy toggles
--    were only enforced in the Express API, so they were trivially bypassed.
--
--    The student directory and profile pages are served by the backend
--    (service_role + applyPrivacySettings), so students only ever need to read
--    their OWN row directly. This migration restores own-row-only access.
--
-- 2. The students_with_current_level view must respect RLS of the querying
--    user (security_invoker) and must not be readable by anonymous visitors.
--
-- 3. payments.transaction_id becomes unique so one gateway reference can never
--    be recorded twice (prevents concurrent double-claim of one payment).
--
-- Run in the Supabase SQL Editor. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Students: own-row-only SELECT for end users
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "students_directory_read" ON students;

DROP POLICY IF EXISTS "students_select_own" ON students;
CREATE POLICY "students_select_own" ON students
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 2. View: evaluate with the caller's privileges (requires Postgres 15+,
--    which all current Supabase projects run) and remove anonymous access.
-- ----------------------------------------------------------------------------
ALTER VIEW students_with_current_level SET (security_invoker = true);
REVOKE SELECT ON students_with_current_level FROM anon;
GRANT SELECT ON students_with_current_level TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. One payment row per gateway reference
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT transaction_id
    FROM payments
    WHERE transaction_id IS NOT NULL
    GROUP BY transaction_id
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE WARNING 'payments has % duplicated transaction_id value(s); unique index NOT created. '
      'Review with: SELECT transaction_id, COUNT(*) FROM payments GROUP BY 1 HAVING COUNT(*) > 1; '
      'then resolve and re-run this migration.', dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_transaction_id
      ON payments (transaction_id)
      WHERE transaction_id IS NOT NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. Record migration
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('020', '020_close_student_pii_and_payment_replay.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Verification (run manually after applying):
--   SELECT policyname, cmd, roles, qual FROM pg_policies WHERE tablename = 'students';
--     -> must NOT list students_directory_read
--   SELECT reloptions FROM pg_class WHERE relname = 'students_with_current_level';
--     -> {security_invoker=true}
-- ----------------------------------------------------------------------------
