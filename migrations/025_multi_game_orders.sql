-- ============================================================================
-- Migration 025: Several games in one order
-- Date: 2026-11-15
--
-- A buyer can now pick more than one game in a single checkout, e.g.
--   FIFA x 2 plays (N500 each) + Ludo x 1 play (N300) = N1,300 (+ service fee)
-- One-game orders keep using payments/event_registrations.event_item_id.
-- Orders with several games store their lines here instead:
--   [{ "item_id": "<event_items.id>", "name": "FIFA", "plays": 2, "unit_price": 500 }]
-- ticket_quantity stays the total number of plays.
--
-- Run AFTER 024 and BEFORE deploying the multi-game code. Safe to re-run.
-- ============================================================================

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS order_items JSONB;
ALTER TABLE event_registrations
  ADD COLUMN IF NOT EXISTS order_items JSONB;

-- Only arrays (or NULL) are allowed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_order_items_is_array') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_order_items_is_array
      CHECK (order_items IS NULL OR jsonb_typeof(order_items) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_registrations_order_items_is_array') THEN
    ALTER TABLE event_registrations ADD CONSTRAINT event_registrations_order_items_is_array
      CHECK (order_items IS NULL OR jsonb_typeof(order_items) = 'array');
  END IF;
END $$;

-- Record migration
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('025', '025_multi_game_orders.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- Verification:
--   SELECT column_name, table_name FROM information_schema.columns
--   WHERE column_name = 'order_items' AND table_name IN ('payments', 'event_registrations');
