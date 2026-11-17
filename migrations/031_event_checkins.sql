-- ============================================================================
-- Migration 031: Door check-in for ticketed events
-- Date: 2026-11-16
--
-- Lets door staff (appointed like game marshals, by school email for one
-- event and a time window) scan a ticket's QR code and admit its holders.
-- A 6-ticket order can be admitted all at once or one person at a time,
-- and can never let in more people than it paid for.
--
--   event_checkins  every admission (ticket, how many, who admitted, when)
--   admit_tickets() locks the ticket so two staff scanning at once can't
--                   admit more people than were bought
--
-- Backend only (service role). Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_checkins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  registration_id UUID NOT NULL REFERENCES event_registrations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  admitted INTEGER NOT NULL CHECK (admitted > 0),
  marshal_id UUID REFERENCES game_marshals(id) ON DELETE SET NULL,
  marshal_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_checkins_registration ON event_checkins (registration_id);
CREATE INDEX IF NOT EXISTS idx_event_checkins_event ON event_checkins (event_id, created_at DESC);

ALTER TABLE event_checkins ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION admit_tickets(
  p_registration_id UUID,
  p_count INTEGER,
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
  IF p_count IS NULL OR p_count < 1 THEN
    RAISE EXCEPTION 'INVALID_COUNT';
  END IF;

  SELECT event_id INTO v_event_id
  FROM event_registrations
  WHERE id = p_registration_id
  FOR UPDATE;

  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'TICKET_NOT_FOUND';
  END IF;

  SELECT COALESCE(SUM(admitted), 0) INTO v_used
  FROM event_checkins
  WHERE registration_id = p_registration_id;

  IF v_used + p_count > p_bought THEN
    RAISE EXCEPTION 'ALREADY_ADMITTED';
  END IF;

  INSERT INTO event_checkins (registration_id, event_id, admitted, marshal_id, marshal_user_id)
  VALUES (p_registration_id, v_event_id, p_count, p_marshal_id, p_marshal_user_id);

  RETURN p_bought - v_used - p_count;
END;
$$;

REVOKE ALL ON FUNCTION admit_tickets(UUID, INTEGER, INTEGER, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION admit_tickets(UUID, INTEGER, INTEGER, UUID, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION admit_tickets(UUID, INTEGER, INTEGER, UUID, UUID) TO service_role;

-- Record migration
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('031', '031_event_checkins.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- Verification:
--   SELECT * FROM event_checkins ORDER BY created_at DESC LIMIT 20;
