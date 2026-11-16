-- ============================================================================
-- Migration 027: Live "new content" pop-ups
-- Date: 2026-11-16
--
-- The site shows a pop-up ("New event published!", "New resource uploaded",
-- "New timetable") when a row is added to events, past_questions or
-- timetables. That needs Supabase Realtime (Postgres Changes) switched on for
-- those tables, which it never was: subscribing returned
-- "Unable to subscribe to changes ... Please check Realtime is enabled".
--
-- Realtime applies each table's existing Row Level Security to every
-- subscriber, so nobody receives a row they couldn't already read.
-- Only these three tables are added (never payments, students, etc.).
--
-- Safe to re-run.
-- ============================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOREACH t IN ARRAY ARRAY['events', 'past_questions', 'timetables'] LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t)
       AND NOT EXISTS (
         SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
       ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- Record migration
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('027', '027_realtime_site_updates.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- Verification (should list the three tables):
--   SELECT schemaname, tablename FROM pg_publication_tables
--   WHERE pubname = 'supabase_realtime' ORDER BY tablename;
