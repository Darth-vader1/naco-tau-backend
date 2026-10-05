-- Migration 001 — Link payments to events + audit registrations back to their payment.
-- Run once against Supabase SQL Editor (non-destructive, safe for existing data).
--
-- (1) payments.event_id — allows linking an event_registration payment to a specific event.
--     Without this, the paid-event gate in events.register cannot find the verified payment.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'payments'
       AND column_name  = 'event_id'
  ) THEN
    ALTER TABLE public.payments
      ADD COLUMN event_id UUID NULL REFERENCES public.events(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_event_id
  ON public.payments (event_id);

CREATE INDEX IF NOT EXISTS idx_payments_user_event_status
  ON public.payments (user_id, event_id, payment_type, status);

-- (2) event_registrations.linked_payment_id — audit trail back to the verified payment
--     that unlocked the registration. Also used by verify-reject to undo auto-created rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'event_registrations'
       AND column_name  = 'linked_payment_id'
  ) THEN
    ALTER TABLE public.event_registrations
      ADD COLUMN linked_payment_id UUID NULL REFERENCES public.payments(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_registrations_payment
  ON public.event_registrations (linked_payment_id)
  WHERE linked_payment_id IS NOT NULL;

-- (3) payments back-fill hint — existing event_registration rows (created manually or
--     prior to this migration) have no linked_payment_id; that's acceptable. If you want
--     to link historical paid registrations, match by (event_id, user_id, created_at).
