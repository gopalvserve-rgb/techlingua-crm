-- Client 12 Nov 2026 — online admission form:
--   "At the time of creation online admission form need to add Logo, address, contact details.
--    It should be created by following Branch and Verticals, and in admission form need to add
--    Course name field."
-- The link carries its own header (name, address, phone, email, logo). Blank parts fall back to
-- the vertical's identity (display name / billing address / phone / email / logo), then the
-- branch's (address / contact number / email), so an existing link shows a header at once.
ALTER TABLE admission_form ADD COLUMN IF NOT EXISTS header JSONB NOT NULL DEFAULT '{}'::jsonb;
