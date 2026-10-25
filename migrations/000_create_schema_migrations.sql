-- ============================================
-- Migration 000: Schema Migrations Tracking Table
-- Run this FIRST in your Supabase SQL Editor before any other migration.
--
-- This creates a registry that records which SQL migrations have been
-- applied to the live database, solving the "unclear what's applied"
-- problem. After running this, manually INSERT a row for every migration
-- you have already run (see MIGRATIONS_LOG.md for the full list).
-- ============================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  id          SERIAL PRIMARY KEY,
  filename    TEXT NOT NULL UNIQUE,        -- e.g. '007_add_student_networking_fields'
  description TEXT,                        -- human-readable summary
  applied_at  TIMESTAMPTZ DEFAULT NOW(),   -- when it was applied
  applied_by  TEXT DEFAULT 'manual'        -- 'manual', 'script', or operator name
);

-- No RLS — this table is only ever touched by the service-role key or a superuser.
-- Anon/authenticated roles cannot read or write it.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "schema_migrations_deny_all" ON schema_migrations
  FOR ALL USING (false);

-- ============================================
-- BACKFILL: mark every migration that was already applied
-- before this tracking table existed.
-- Edit this list if your live database differs.
-- ============================================

INSERT INTO schema_migrations (filename, description) VALUES
  ('001_payments_event_link',                     'Link payments to events via event_id FK'),
  ('002_add_past_questions_payment_verification', 'Add past_questions and payment_verification tables'),
  ('003_fix_schema_mismatches',                   'Fix schema mismatches from initial deploy'),
  ('004_align_payment_verification_schema',       'Align payment_verification columns with routes'),
  ('005_fix_academic_resources_schema',           'Fix academic_resources column constraints'),
  ('006_add_url_to_academic_resources',           'Add url column to academic_resources'),
  ('007_add_student_networking_fields',           'Add social/networking fields, visibility, privacy_settings'),
  ('008_add_snapchat_field',                      'Add snapchat column to students'),
  ('009_add_events_composite_index',              'Composite index on events for query performance'),
  ('010_fix_audit_logs_rls',                      'Fix Row Level Security on audit_logs table'),
  ('011_add_level_to_students',                   'Add static level column (100-400) to students'),
  ('011b_performance_indexes',                    'Production performance indexes for all major tables'),
  ('012a_hackathons',                             'Create hackathons, registrations, submissions tables'),
  ('012b_replace_level_with_year_of_study',       'Replace static level with year_of_study + graduation_year + view'),
  ('013a_fix_year_of_study_data',                 'Re-extract and correct year_of_study from matric numbers'),
  ('013b_past_executives',                        'Create past_executives Roll of Honour table'),
  ('013c_performance_indexes',                    'Additional performance indexes incl. hackathons'),
  ('014_fix_level_display_issue',                 'Fix current_level display calculation in view'),
  ('015_fix_all_student_data_issues',             'Bulk fix student data quality issues'),
  ('016_fix_double_encoded_skills_interests',     'Fix double-encoded JSON in skills/interests arrays'),
  ('017_add_payments_transaction_id_index',       'Index on payments.transaction_id for receipt lookups')
ON CONFLICT (filename) DO NOTHING;
