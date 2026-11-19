-- ============================================================================
-- Migration 033: Event & Game Night Winners
-- Date: 2026-11-19
--
-- Stores winners/champions for Game Night, tournaments, and events:
--   - Links optionally to a specific game/tournament (event_items)
--   - Links optionally to a paid registration (event_registrations)
--   - Supports public display once announced_at IS NOT NULL
--
-- Safe to re-run (idempotent).
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_winners (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    item_id UUID REFERENCES event_items(id) ON DELETE SET NULL,
    registration_id UUID REFERENCES event_registrations(id) ON DELETE SET NULL,
    winner_name TEXT NOT NULL,
    in_game_username TEXT,
    winner_email TEXT,
    placement TEXT NOT NULL DEFAULT '1st Place',
    prize TEXT,
    note TEXT,
    announced_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_winners_event
    ON event_winners (event_id, announced_at DESC, created_at ASC);

ALTER TABLE event_winners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view announced event winners" ON event_winners;
CREATE POLICY "Public can view announced event winners"
    ON event_winners FOR SELECT
    TO public
    USING (announced_at IS NOT NULL);

DROP POLICY IF EXISTS "Admins can manage event winners" ON event_winners;
CREATE POLICY "Admins can manage event winners"
    ON event_winners FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('033', '033_event_winners.sql', NOW())
ON CONFLICT (version) DO NOTHING;
