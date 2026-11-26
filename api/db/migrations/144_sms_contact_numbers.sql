-- 144 — FB-2026-004 (client, 23 Nov 2026): the numbers SMS templates put in front of a lead.
--
-- "Counsellor's phone — where does it come from? That is the LOGIN number." → a user can now have a
-- separate CONTACT number (Users › Edit user › Contact number for leads); the SMS marker uses it and
-- falls back to the login mobile when it is empty.
-- "Call-back number (vertical) is our SUPPORT number — give another number" → a vertical can now have
-- its own CALL-BACK number for leads who have not joined yet (Verticals › Edit › Call-back number);
-- the vertical's Phone stays the support number on invoices and fee receipts.
-- Both are optional and empty for everyone at first, so every SMS reads exactly as before until set.

ALTER TABLE "user"   ADD COLUMN IF NOT EXISTS contact_phone  VARCHAR(24) NULL;
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS callback_phone VARCHAR(24) NULL;
