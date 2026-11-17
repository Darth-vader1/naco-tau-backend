-- 032: tournament games (1 entry per person + player username) and buyer phone numbers
-- Safe to run more than once. Run the whole file in the Supabase SQL Editor.

-- A game marked as a tournament (e.g. eFootball Mobile): each buyer may hold
-- only one entry, and must give their player username when paying.
ALTER TABLE event_items
  ADD COLUMN IF NOT EXISTS tournament BOOLEAN NOT NULL DEFAULT false;

-- Phone number the buyer gave at checkout (students and guests).
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS buyer_phone TEXT;

-- Player usernames for tournament entries: [{ "item_id": "...", "name": "eFootball", "username": "..." }]
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS entry_details JSONB;
ALTER TABLE event_registrations
  ADD COLUMN IF NOT EXISTS entry_details JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_buyer_phone_len') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_buyer_phone_len
      CHECK (buyer_phone IS NULL OR char_length(buyer_phone) <= 25);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_entry_details_array') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_entry_details_array
      CHECK (entry_details IS NULL OR jsonb_typeof(entry_details) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_registrations_entry_details_array') THEN
    ALTER TABLE event_registrations ADD CONSTRAINT event_registrations_entry_details_array
      CHECK (entry_details IS NULL OR jsonb_typeof(entry_details) = 'array');
  END IF;
END $$;

-- Let PostgREST see the new columns straight away.
NOTIFY pgrst, 'reload schema';
