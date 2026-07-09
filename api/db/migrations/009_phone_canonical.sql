-- 009 — DEF-QA4-02: canonical phone storage for NeoDove duplicacy (match_key: phone).
--
-- The API now normalises phones on write (see src/common/phone.util.ts); this
-- migration backfills already-stored values (e.g. raw dashed phones persisted
-- before the fix) so stored data and the dedupe comparison use ONE canonical
-- form: +91XXXXXXXXXX for Indian numbers. The function mirrors normalizePhone()
-- exactly and stays in the DB as the single SQL-side definition of the rules.

CREATE OR REPLACE FUNCTION phone_canonical(raw TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d TEXT;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN RETURN raw; END IF;
  d := regexp_replace(raw, '\D', '', 'g');                             -- strip spaces/dashes/parens/+
  IF length(d) > 12 AND left(d, 2) = '00' THEN d := substr(d, 3); END IF;  -- 0091... international prefix
  IF length(d) = 11 AND left(d, 1) = '0'  THEN d := substr(d, 2); END IF;  -- leading trunk 0
  IF length(d) = 10 THEN RETURN '+91' || d; END IF;
  IF length(d) = 12 AND left(d, 2) = '91' THEN RETURN '+' || d; END IF;
  RETURN CASE WHEN left(btrim(raw), 1) = '+' THEN '+' || d ELSE d END; -- short/foreign: digits only
END $$;

UPDATE lead
   SET phone      = phone_canonical(phone),
       alt_phone  = phone_canonical(alt_phone),
       updated_at = now()
 WHERE phone     IS DISTINCT FROM phone_canonical(phone)
    OR alt_phone IS DISTINCT FROM phone_canonical(alt_phone);
