-- ============================================
-- NACOS TAU CHAPTER: PERFORMANCE & CORE INDEXES
-- Migration: 013_performance_indexes.sql
-- ============================================

-- 1. Students Table Indexes
CREATE INDEX IF NOT EXISTS idx_students_user_id ON students(user_id);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);
CREATE INDEX IF NOT EXISTS idx_students_matric_no ON students(matric_no);
CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);
CREATE INDEX IF NOT EXISTS idx_students_dept_lvl ON students(department, current_level);

-- 2. Events & Event Registrations Indexes
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'event_registrations') THEN
        CREATE INDEX IF NOT EXISTS idx_event_reg_event_id ON event_registrations(event_id);
        CREATE INDEX IF NOT EXISTS idx_event_reg_user_id ON event_registrations(user_id);
        CREATE INDEX IF NOT EXISTS idx_event_reg_status ON event_registrations(status);
        CREATE INDEX IF NOT EXISTS idx_event_reg_composite ON event_registrations(event_id, user_id);
    END IF;
END $$;

-- 3. Payments Table Indexes
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payments') THEN
        CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
        CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
        CREATE INDEX IF NOT EXISTS idx_payments_transaction_id ON payments(transaction_id);
    END IF;
END $$;

-- 4. Voting & Elections Indexes
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'votes') THEN
        CREATE INDEX IF NOT EXISTS idx_votes_user_id ON votes(user_id);
        CREATE INDEX IF NOT EXISTS idx_votes_election_id ON votes(election_id);
        CREATE INDEX IF NOT EXISTS idx_votes_position_id ON votes(position_id);
    END IF;
END $$;

-- 5. Hackathons & Pitchathons Indexes
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'hackathons') THEN
        CREATE INDEX IF NOT EXISTS idx_hackathons_status ON hackathons(status);
        CREATE INDEX IF NOT EXISTS idx_hackathons_dates ON hackathons(start_date, end_date);
        CREATE INDEX IF NOT EXISTS idx_hackathons_published ON hackathons(is_published);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'hackathon_registrations') THEN
        CREATE INDEX IF NOT EXISTS idx_hackathon_reg_hackathon ON hackathon_registrations(hackathon_id);
        CREATE INDEX IF NOT EXISTS idx_hackathon_reg_leader ON hackathon_registrations(leader_id);
        CREATE INDEX IF NOT EXISTS idx_hackathon_reg_status ON hackathon_registrations(status);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'hackathon_submissions') THEN
        CREATE INDEX IF NOT EXISTS idx_hackathon_sub_hackathon ON hackathon_submissions(hackathon_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_hackathon_sub_reg ON hackathon_submissions(registration_id);
        CREATE INDEX IF NOT EXISTS idx_hackathon_sub_winner ON hackathon_submissions(is_winner);
    END IF;
END $$;

-- 6. Audit Logs Indexes
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs') THEN
        CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
    END IF;
END $$;
