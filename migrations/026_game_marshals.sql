-- ============================================================================
-- Migration 026: Game marshals and the play log
-- Date: 2026-11-15
--
-- Game marshals are students an admin appoints (by school email) for ONE
-- event, between a start and an end time. While active they can look up a
-- game ticket (scan or type the ticket number) and mark plays as used.
--
--   game_marshals : who is a marshal, for which event, and until when
--   game_plays    : every play marked as used (game, ticket, marshal, time)
--
-- Plays left for a ticket = plays bought - plays marked used.
-- Only the backend (service role) reads or writes these tables.
--
-- Run AFTER 025 and BEFORE deploying the marshal code. Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS game_marshals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  appointed_by UUID,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_marshals_time_order CHECK (ends_at > starts_at)
);

-- One live appointment per student per event.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_game_marshals_live
  ON game_marshals (event_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_game_marshals_user ON game_marshals (user_id, ends_at);

CREATE TABLE IF NOT EXISTS game_plays (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  registration_id UUID NOT NULL REFERENCES event_registrations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES event_items(id) ON DELETE CASCADE,
  plays INTEGER NOT NULL CHECK (plays > 0),
  marshal_id UUID REFERENCES game_marshals(id) ON DELETE SET NULL,
  marshal_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_plays_registration ON game_plays (registration_id, item_id);
CREATE INDEX IF NOT EXISTS idx_game_plays_event ON game_plays (event_id, item_id);

-- Backend only: RLS on with no policies means the public/anon key gets nothing.
ALTER TABLE game_marshals ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_plays ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Mark plays as used, safely. Locks the ticket's registration row so two
-- marshals scanning the same ticket at once can never use more plays than
-- were bought. Returns the plays left for that game afterwards.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redeem_game_play(
  p_registration_id UUID,
  p_item_id UUID,
  p_plays INTEGER,
  p_bought INTEGER,
  p_marshal_id UUID,
  p_marshal_user_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id UUID;
  v_used INTEGER;
BEGIN
  IF p_plays IS NULL OR p_plays < 1 THEN
    RAISE EXCEPTION 'INVALID_PLAYS';
  END IF;

  SELECT event_id INTO v_event_id
  FROM event_registrations
  WHERE id = p_registration_id
  FOR UPDATE;

  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'TICKET_NOT_FOUND';
  END IF;

  SELECT COALESCE(SUM(plays), 0) INTO v_used
  FROM game_plays
  WHERE registration_id = p_registration_id AND item_id = p_item_id;

  IF v_used + p_plays > p_bought THEN
    RAISE EXCEPTION 'NO_PLAYS_LEFT';
  END IF;

  INSERT INTO game_plays (registration_id, event_id, item_id, plays, marshal_id, marshal_user_id)
  VALUES (p_registration_id, v_event_id, p_item_id, p_plays, p_marshal_id, p_marshal_user_id);

  RETURN p_bought - v_used - p_plays;
END;
$$;

-- Only the backend may call it.
REVOKE ALL ON FUNCTION redeem_game_play(UUID, UUID, INTEGER, INTEGER, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION redeem_game_play(UUID, UUID, INTEGER, INTEGER, UUID, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION redeem_game_play(UUID, UUID, INTEGER, INTEGER, UUID, UUID) TO service_role;

-- ----------------------------------------------------------------------------
-- Record migration
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('026', '026_game_marshals.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- Verification:
--   SELECT * FROM game_marshals ORDER BY created_at DESC;
--   SELECT * FROM game_plays ORDER BY created_at DESC;
