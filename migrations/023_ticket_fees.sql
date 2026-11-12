-- ============================================================================
-- Migration 023: Ticket fees (service fee + payment processing fee)
-- Date: 2026-11-12
--
-- Every online ticket order is stored as a breakdown:
--   subtotal_amount  ticket price x quantity            (goes to NACOS)
--   service_fee      service fee x quantity              (the portal's service fee)
--   amount           subtotal + service fee              (what the portal charges)
--   gateway_fee      Bachs processing fee, when Bachs reports it. With
--                    "customer bears fee" on, Bachs adds it on top for the buyer.
--
-- Fee settings live in a single-row table that only the backend (service
-- role) can read or write; admins change it through the API.
--
-- Run BEFORE deploying the matching backend. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Global fee settings (single row, id = 1)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  member_service_fee NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (member_service_fee >= 0),
  guest_service_fee  NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (guest_service_fee >= 0),
  customer_bears_gateway_fee BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);

INSERT INTO fee_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Backend-only: RLS on with no policies, so the anon/authenticated roles
-- cannot read or change it directly. The service role bypasses RLS.
ALTER TABLE fee_settings ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 2. Per-event override of the service fee (per ticket)
--    NULL = use the global setting; 0 = no service fee for this event.
-- ----------------------------------------------------------------------------
ALTER TABLE events ADD COLUMN IF NOT EXISTS service_fee_override NUMERIC(10,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_service_fee_override_nonneg') THEN
    ALTER TABLE events
      ADD CONSTRAINT events_service_fee_override_nonneg CHECK (service_fee_override IS NULL OR service_fee_override >= 0);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Payment breakdown
-- ----------------------------------------------------------------------------
ALTER TABLE payments ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(10,2);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_fee NUMERIC(10,2);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_fee_paid_by TEXT;

-- Existing rows: everything paid was ticket money (no service fee existed).
UPDATE payments SET subtotal_amount = amount WHERE subtotal_amount IS NULL;

CREATE INDEX IF NOT EXISTS idx_payments_status_submitted ON payments (status, submitted_at DESC);

-- ----------------------------------------------------------------------------
-- 4. Record migration
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('023', '023_ticket_fees.sql', NOW())
ON CONFLICT (version) DO NOTHING;
