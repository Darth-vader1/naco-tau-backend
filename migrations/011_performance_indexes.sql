-- ============================================
-- NACOS TAU CHAPTER: PRODUCTION PERFORMANCE INDEXES
-- Run directly in Supabase Dashboard -> SQL Editor
-- ============================================

-- 1. Students & Auth mapping
CREATE INDEX IF NOT EXISTS idx_students_user_id ON students(user_id);
CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);
CREATE INDEX IF NOT EXISTS idx_students_matric_no ON students(matric_no);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);
CREATE INDEX IF NOT EXISTS idx_admin_users_user_id ON admin_users(user_id);

-- 2. Events & Registrations
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_is_active ON events(is_active);
CREATE INDEX IF NOT EXISTS idx_event_reg_event_user ON event_registrations(event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_event_reg_user_id ON event_registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_event_reg_payment_id ON event_registrations(linked_payment_id);

-- 3. Payments
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_event_id ON payments(event_id);
CREATE INDEX IF NOT EXISTS idx_payments_submitted_at ON payments(submitted_at);

-- 4. Voting & Elections (Crucial for high concurrent voting spikes)
CREATE INDEX IF NOT EXISTS idx_voting_pos_active ON voting_positions(is_active);
CREATE INDEX IF NOT EXISTS idx_voting_cand_position ON voting_candidates(position_id);
CREATE INDEX IF NOT EXISTS idx_votes_voter_id ON votes(voter_id);
CREATE INDEX IF NOT EXISTS idx_votes_position_id ON votes(position_id);

-- 5. Audit & Activity
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_resources_type ON academic_resources(resource_type);
CREATE INDEX IF NOT EXISTS idx_timetables_department ON timetables(department);
CREATE INDEX IF NOT EXISTS idx_resource_views_resource_id ON resource_views(resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_downloads_resource_id ON resource_downloads(resource_id);
