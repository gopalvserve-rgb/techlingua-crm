-- 014 — Client update #2: country-aware E.164 phones + lead search indexes.
--
-- phone_canonical() is upgraded to mirror the reworked normalizePhone()
-- (src/common/phone.util.ts): canonical = +<dialcode><national>. The +91 default
-- applies ONLY when the input carries no country info AND looks like a 10-digit
-- Indian national number — existing +91 rows are already canonical, so NO data
-- backfill is needed (verified: rules are identical for every +91-storable form).
-- The one behavioural change: 00-prefixed international numbers now keep their
-- real dial code as +<cc>... instead of falling back to bare digits.

CREATE OR REPLACE FUNCTION phone_canonical(raw TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d TEXT;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN RETURN raw; END IF;
  d := regexp_replace(raw, '\D', '', 'g');                                 -- strip punctuation
  IF left(btrim(raw), 1) = '+' AND length(d) > 6 THEN RETURN '+' || d; END IF;  -- explicit country code wins
  IF left(d, 2) = '00' AND length(d) > 11 THEN RETURN '+' || substr(d, 3); END IF; -- 00 international prefix
  IF length(d) = 11 AND left(d, 1) = '0' THEN d := substr(d, 2); END IF;   -- trunk 0
  IF length(d) = 10 THEN RETURN '+91' || d; END IF;                        -- bare Indian national
  IF length(d) = 12 AND left(d, 2) = '91' THEN RETURN '+' || d; END IF;    -- 91XXXXXXXXXX
  RETURN CASE WHEN left(btrim(raw), 1) = '+' THEN '+' || d ELSE d END;     -- short/unknown: keep digits
END $$;

-- Lead search: q matches name (ILIKE), email (ILIKE) and phone (digit-contains,
-- country-code agnostic). Trigram GIN indexes make the ILIKE '%…%' scans indexed;
-- if pg_trgm cannot be installed (no privilege) we fall back to plain btree
-- expression indexes (still help exact/prefix) and the API stays correct.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_lead_name_trgm  ON lead USING GIN (full_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_lead_email_trgm ON lead USING GIN (lower(email) gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_lead_phone_digits_trgm
    ON lead USING GIN (regexp_replace(phone, '\D', '', 'g') gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
  RAISE NOTICE 'pg_trgm unavailable — falling back to btree expression indexes';
  CREATE INDEX IF NOT EXISTS idx_lead_email_lower   ON lead (lower(email));
  CREATE INDEX IF NOT EXISTS idx_lead_phone_digits  ON lead (regexp_replace(phone, '\D', '', 'g'));
END $$;
