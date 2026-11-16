-- ============================================================================
-- Migration 024: Games inside an event (pay per play)
-- Date: 2026-11-15
--
-- A game night is a normal event with a list of games (event_items), each
-- with its own price PER PLAY, e.g.:
--   Mortal Kombat  ₦500 per play
--   FIFA           ₦500 per play
--   Ludo           ₦300 per play
-- The buyer picks one game and a number of plays. Plays reuse the existing
-- ticket quantity, so 2 plays of a ₦500 game = ₦1,000 (+ service fee), and
-- every existing rule (fees, Bachs checkout, webhook, receipts, capacity
-- counted in tickets) keeps working unchanged.
--
-- Events WITHOUT games are untouched.
--
-- Run AFTER 023 and BEFORE deploying the matching backend/frontend.
-- Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Games offered at an event
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 300),
  price NUMERIC(10,2) NOT NULL CHECK (price > 0),                 -- member price per play
  public_price NUMERIC(10,2) CHECK (public_price IS NULL OR public_price > 0), -- guest price per play (NULL = members only)
  max_plays INTEGER CHECK (max_plays IS NULL OR max_plays > 0),   -- optional cap for this game (NULL = no cap)
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_items_event ON event_items (event_id, sort_order);

-- Anyone may read active games (the public events page lists them, like events).
-- Only the backend (service role, bypasses RLS) can write.
ALTER TABLE event_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "event_items_public_read" ON event_items;
CREATE POLICY "event_items_public_read" ON event_items
  FOR SELECT USING (is_active = true);

-- ----------------------------------------------------------------------------
-- 2. Which game an order / ticket is for
-- ----------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS event_item_id UUID REFERENCES event_items(id) ON DELETE SET NULL;
ALTER TABLE event_registrations
  ADD COLUMN IF NOT EXISTS event_item_id UUID REFERENCES event_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_event_registrations_item ON event_registrations (event_item_id) WHERE event_item_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. Record migration
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('024', '024_event_games.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- Verification:
--   SELECT * FROM event_items ORDER BY event_id, sort_order;
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'event_item_id';
