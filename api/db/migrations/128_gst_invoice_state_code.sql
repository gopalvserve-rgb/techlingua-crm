-- ============================================================================
-- 128 — GST INVOICE STATE CODES (error log, Nov 2026)
--
-- Generate Invoice failed with "value too long for type character varying(4)": the state
-- master holds codes longer than 4 characters and the invoice copies them as they are.
-- ============================================================================

ALTER TABLE gst_invoice ALTER COLUMN seller_state_code TYPE VARCHAR(16);
ALTER TABLE gst_invoice ALTER COLUMN pos_state_code TYPE VARCHAR(16);
