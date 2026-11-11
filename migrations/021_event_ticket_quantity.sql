-- ============================================================================
-- Migration 021: Multiple tickets per event purchase
-- Date: 2026-11-11
--
-- A student can buy several tickets for a paid event in one order
-- (e.g. 2 x ₦100 = ₦200). The quantity is stored on the payment and on the
-- resulting event registration; event capacity and current_attendees are
-- counted in TICKETS (sum of ticket_quantity), not registration rows.
--
-- Existing rows default to 1 ticket, so all historical data stays correct.
-- RUN THIS BEFORE DEPLOYING the backend that writes ticket_quantity.
-- Safe to re-run.
-- ============================================================================

-- events.current_attendees was referenced by the app but never created by any
-- earlier migration (the old count-sync updates failed silently). It now holds
-- the number of TICKETS issued and drives "spots left" on the public events page.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS current_attendees INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS ticket_quantity INTEGER NOT NULL DEFAULT 1;

ALTER TABLE event_registrations
  ADD COLUMN IF NOT EXISTS ticket_quantity INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_ticket_quantity_range') THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_ticket_quantity_range CHECK (ticket_quantity BETWEEN 1 AND 50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_registrations_ticket_quantity_range') THEN
    ALTER TABLE event_registrations
      ADD CONSTRAINT event_registrations_ticket_quantity_range CHECK (ticket_quantity BETWEEN 1 AND 50);
  END IF;
END $$;

-- Re-sync attendee counts so they are measured in tickets.
UPDATE events e
SET current_attendees = COALESCE((
  SELECT SUM(r.ticket_quantity)
  FROM event_registrations r
  WHERE r.event_id = e.id
    AND COALESCE(r.status, 'registered') <> 'cancelled'
), 0);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('021', '021_event_ticket_quantity.sql', NOW())
ON CONFLICT (version) DO NOTHING;
