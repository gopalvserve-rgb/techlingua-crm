-- =============================================================================
-- 076 — ENROLMENT DISCOUNT MODEL (client feedback item 4)
--
--   The enrolment already stored fee_minor (GROSS), discount_minor (the discount
--   AMOUNT) and net_fee_minor (= fee - discount). Item 4 asks the client to be able to
--   enter a discount EITHER as an amount (₹) OR as a percentage (%), and to SEE the
--   derived discount amount + the discounted (net) fee. To round-trip the choice back to
--   the form (so a 10% discount reopens as "10 %", not "₹2,000") we record:
--
--     discount_type          none | amount | percent   (how it was entered)
--     discount_value         the raw value the user typed — PAISE for an amount,
--                            a NUMERIC percent (e.g. 10.000) for a percentage
--     gross_fee_minor        the gross fee the discount was computed on (mirrors fee_minor)
--     discount_amount_minor  the DERIVED ₹ discount (mirrors discount_minor; for percent
--                            it is gross × pct, half-up to the paisa)
--
--   net_fee_minor stays = gross − discount_amount (the payable; unchanged). The payment
--   plan / installments are always built on the NET. gross_fee_minor + discount_amount_minor
--   are kept in lock-step with the long-standing fee_minor / discount_minor so every
--   existing reader (reports, revenue, dues, plans) is unregressed.
--
--   MONEY RULE: every money column is BIGINT paise. Idempotent (IF NOT EXISTS + guarded
--   backfill that only touches rows not yet populated).
-- =============================================================================

ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_type          VARCHAR(8)     NOT NULL DEFAULT 'none';
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_value         NUMERIC(14,3)  NOT NULL DEFAULT 0;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS gross_fee_minor        BIGINT         NOT NULL DEFAULT 0;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_amount_minor  BIGINT         NOT NULL DEFAULT 0;

-- constrain the type to the three allowed values (idempotent — drop+add)
ALTER TABLE enrolment DROP CONSTRAINT IF EXISTS chk_enrolment_discount_type;
ALTER TABLE enrolment ADD  CONSTRAINT chk_enrolment_discount_type
  CHECK (discount_type IN ('none', 'amount', 'percent'));

-- BACKFILL existing enrolments from the columns that always held the truth:
--   gross  = fee_minor, discount_amount = discount_minor, and the entry mode was an amount
--   whenever a discount was actually applied (we cannot know it was a percentage after the
--   fact, and storing it as the exact ₹ it became is lossless for display).
UPDATE enrolment
   SET gross_fee_minor       = fee_minor,
       discount_amount_minor = discount_minor,
       discount_type         = CASE WHEN discount_minor > 0 THEN 'amount' ELSE 'none' END,
       discount_value        = CASE WHEN discount_minor > 0 THEN discount_minor ELSE 0 END
 WHERE gross_fee_minor = 0 AND discount_amount_minor = 0
   AND (fee_minor > 0 OR discount_minor > 0);
