-- ============================================================================
-- Migration 022: Repeat purchases + guest (non-member) checkout
-- Date: 2026-11-11
--
-- 1. events.allow_repeat_orders: admin switch that lets someone who already
--    bought tickets buy again (e.g. game night). Off by default.
-- 2. events.open_to_public + events.public_price: admin switch that lets
--    non-members buy tickets without an account, at a per-event guest price.
-- 3. event_registrations becomes ONE ROW PER ORDER instead of one row per
--    student per event:
--      - drop UNIQUE(event_id, user_id)
--      - UNIQUE(linked_payment_id): one registration per paid order
--      - free registrations (no payment) stay one per student per event
-- 4. Guest buyer details on payments and event_registrations.
--
-- Run AFTER 021 and BEFORE deploying the matching backend/frontend.
-- Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1 & 2. Event switches
-- ----------------------------------------------------------------------------
ALTER TABLE events ADD COLUMN IF NOT EXISTS allow_repeat_orders BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS open_to_public BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS public_price DECIMAL(10,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_public_price_positive') THEN
    ALTER TABLE events
      ADD CONSTRAINT events_public_price_positive CHECK (public_price IS NULL OR public_price > 0);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. One registration per order
-- ----------------------------------------------------------------------------
-- Drop whatever unique constraint/index enforces exactly (event_id, user_id).
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'event_registrations'::regclass
      AND c.contype = 'u'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM unnest(c.conkey) k
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) = ARRAY['event_id', 'user_id']
  LOOP
    EXECUTE format('ALTER TABLE event_registrations DROP CONSTRAINT %I', rec.conname);
    RAISE NOTICE 'Dropped constraint %', rec.conname;
  END LOOP;

  FOR rec IN
    SELECT i.relname AS indexname
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid = 'event_registrations'::regclass
      AND x.indisunique
      AND NOT x.indisprimary
      AND x.indpred IS NULL
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM unnest(x.indkey) k
           JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k) = ARRAY['event_id', 'user_id']
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', rec.indexname);
    RAISE NOTICE 'Dropped index %', rec.indexname;
  END LOOP;
END $$;

-- One registration per paid order (also makes concurrent ticket issuing safe).
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_registrations_payment
  ON event_registrations (linked_payment_id)
  WHERE linked_payment_id IS NOT NULL;

-- Free registrations (no payment) remain one per student per event.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_registrations_free_user
  ON event_registrations (event_id, user_id)
  WHERE linked_payment_id IS NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_registrations_event_user
  ON event_registrations (event_id, user_id);

-- ----------------------------------------------------------------------------
-- 4. Guest buyers
-- ----------------------------------------------------------------------------
ALTER TABLE payments ADD COLUMN IF NOT EXISTS guest_name TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS guest_email TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS guest_phone TEXT;

ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS guest_name TEXT;
ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS guest_email TEXT;
ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS guest_phone TEXT;

-- Guest rows have no student account.
ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE event_registrations ALTER COLUMN user_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_registrations_owner_present') THEN
    ALTER TABLE event_registrations
      ADD CONSTRAINT event_registrations_owner_present
      CHECK (user_id IS NOT NULL OR guest_email IS NOT NULL) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_guest_email ON payments (lower(guest_email)) WHERE guest_email IS NOT NULL;

-- Guest PII is only ever read by the backend (service role). Students reading
-- their own rows via RLS never match guest rows (user_id IS NULL), and no
-- anon policy exposes payments or event_registrations.

-- ----------------------------------------------------------------------------
-- 5. Record migration
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('022', '022_repeat_orders_and_guest_checkout.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- Verification:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'event_registrations'::regclass;
--   SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'event_registrations';
