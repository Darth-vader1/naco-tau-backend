-- ============================================================================
-- Migration 029: Archive (soft delete) payments
-- Date: 2026-11-16
--
-- Lets admins archive orders that shouldn't count, such as test payments.
-- Archived orders are kept (nothing is deleted) but are left out of the
-- revenue report, payment stats and the default Payments list. They can be
-- restored at any time.
--
--   archived_at     when it was archived (NULL = not archived)
--   archived_by     the admin who archived it
--   archive_reason  short note, e.g. "Test payment"
--
-- Safe to re-run.
-- ============================================================================

ALTER TABLE payments ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS archived_by UUID;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS archive_reason TEXT
  CHECK (archive_reason IS NULL OR char_length(archive_reason) <= 200);

-- Reports only read live (not archived) orders.
CREATE INDEX IF NOT EXISTS idx_payments_live_verified
  ON payments (status, verified_at DESC)
  WHERE archived_at IS NULL;

-- Record migration
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('029', '029_payment_archive.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- Verification:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'payments' AND column_name LIKE 'archive%';
