-- ============================================================================
-- Migration 030: Email sending log (Gmail daily limit tracking)
-- Date: 2026-11-16
--
-- One row per email the backend sends (every kind: tickets, broadcasts,
-- reminders, alerts, invitations). Used to show how close the sending
-- account is to Gmail's limits, which apply over a rolling 24 hours:
--   2,000 messages, 10,000 total recipients, 3,000 external recipients,
--   3,000 unique recipients (2,000 unique external).
--
-- Privacy: recipient addresses are NOT stored. recipient_hashes holds a
-- one-way SHA-256 fingerprint of each address, only so unique recipients
-- can be counted. Fingerprints are cleared after 3 days; counts are kept.
--
-- Backend only (service role); RLS on with no policies.
-- Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_send_log (
  id BIGSERIAL PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind TEXT CHECK (kind IS NULL OR char_length(kind) <= 60),
  recipients INTEGER NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  external_recipients INTEGER NOT NULL DEFAULT 0 CHECK (external_recipients >= 0),
  recipient_hashes TEXT[],
  ok BOOLEAN NOT NULL DEFAULT TRUE,
  error TEXT CHECK (error IS NULL OR char_length(error) <= 300)
);

CREATE INDEX IF NOT EXISTS idx_email_send_log_sent_at ON email_send_log (sent_at DESC);

ALTER TABLE email_send_log ENABLE ROW LEVEL SECURITY;

-- Record migration
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('030', '030_email_send_log.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- Verification:
--   SELECT date_trunc('day', sent_at) AS day, count(*) AS messages, sum(recipients) AS recipients
--   FROM email_send_log GROUP BY 1 ORDER BY 1 DESC;
