-- Migration 017: Add index on payments.transaction_id
-- ============================================================
-- WHY: transaction_id is queried on every payment verification
-- (verify-paystack route) and on every receipt lookup
-- (GET /payments/receipt/:reference). Without an index, both
-- queries do a full table scan. As payment volume grows this
-- becomes a measurable bottleneck.
--
-- SAFE TO RUN: CREATE INDEX IF NOT EXISTS is idempotent.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_payments_transaction_id
  ON payments (transaction_id);
