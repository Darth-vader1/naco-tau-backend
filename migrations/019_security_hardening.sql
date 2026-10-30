-- ============================================================================
-- Migration 019: Security Hardening & RLS Remediation
-- Date: 2026-10-31
-- Description: 
--   1. Fix Critical #3: Block student self-escalation (status, verified_at, verified_by).
--   2. Fix Critical #4: Scope hackathon submissions to team leader only.
--   3. Fix Medium #1: Enforce election voting window at data layer.
--   4. Fix Medium #5: Add WITH CHECK on hackathon registrations to prevent leader hijack.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. PREVENT STUDENT SELF-ESCALATION ON ACCOUNT STATUS (Critical #3)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_student_privileges()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if called via authenticated role (Supabase client/REST API with anon key)
  IF (auth.role() = 'authenticated') THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Security violation: Students cannot alter account verification status directly.';
    END IF;
    IF NEW.is_graduated IS DISTINCT FROM OLD.is_graduated THEN
      RAISE EXCEPTION 'Security violation: Students cannot alter graduation status directly.';
    END IF;
    IF NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'Security violation: Email changes require administrative re-verification.';
    END IF;
    IF NEW.matric_no IS DISTINCT FROM OLD.matric_no THEN
      RAISE EXCEPTION 'Security violation: Matriculation number cannot be altered.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_enforce_student_privileges ON students;
CREATE TRIGGER trg_enforce_student_privileges
BEFORE UPDATE ON students
FOR EACH ROW
EXECUTE FUNCTION enforce_student_privileges();

-- ----------------------------------------------------------------------------
-- 2. HARDEN PAYMENTS INSERT & PREVENT CLIENT UPDATE ESCALATION (Critical #3)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "payments_insert_own" ON payments;
CREATE POLICY "payments_insert_own" ON payments 
FOR INSERT TO authenticated 
WITH CHECK (
  auth.uid() = user_id 
  AND (status IS NULL OR status = 'pending')
  AND verified_at IS NULL 
  AND verified_by IS NULL
);

-- Ensure authenticated students cannot update payment records (only backend service role can verify)
DROP POLICY IF EXISTS "payments_update_own" ON payments;

-- ----------------------------------------------------------------------------
-- 3. SCOPE HACKATHON SUBMISSIONS TO TEAM LEADERS ONLY (Critical #4)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "hackathon_submissions_insert" ON hackathon_submissions;
CREATE POLICY "hackathon_submissions_insert" ON hackathon_submissions 
FOR INSERT TO authenticated 
WITH CHECK (
  registration_id IN (
    SELECT id FROM hackathon_registrations WHERE leader_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "hackathon_submissions_update" ON hackathon_submissions;
CREATE POLICY "hackathon_submissions_update" ON hackathon_submissions 
FOR UPDATE TO authenticated 
USING (
  registration_id IN (
    SELECT id FROM hackathon_registrations WHERE leader_id = auth.uid()
  )
)
WITH CHECK (
  registration_id IN (
    SELECT id FROM hackathon_registrations WHERE leader_id = auth.uid()
  )
);

-- ----------------------------------------------------------------------------
-- 4. PREVENT HACKATHON TEAM LEADER HIJACKING (Medium #5)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "hackathon_registrations_update_own" ON hackathon_registrations;
CREATE POLICY "hackathon_registrations_update_own" ON hackathon_registrations 
FOR UPDATE TO authenticated 
USING (auth.uid() = leader_id)
WITH CHECK (auth.uid() = leader_id);

-- ----------------------------------------------------------------------------
-- 5. ENFORCE VOTING WINDOW AT THE DATA LAYER (Medium #1)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "votes_insert_own" ON votes;
CREATE POLICY "votes_insert_own" ON votes 
FOR INSERT TO authenticated 
WITH CHECK (
  auth.uid() = voter_id AND
  EXISTS (
    SELECT 1 FROM voting_positions vp
    WHERE vp.id = votes.position_id
      AND vp.is_active = true
      AND (vp.voting_start IS NULL OR NOW() >= vp.voting_start)
      AND (vp.voting_end IS NULL OR NOW() <= vp.voting_end)
  )
);

-- ----------------------------------------------------------------------------
-- 6. RECORD MIGRATION
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('019', '019_security_hardening.sql', NOW())
ON CONFLICT (version) DO NOTHING;
