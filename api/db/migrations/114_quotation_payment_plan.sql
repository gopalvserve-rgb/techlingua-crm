-- =============================================================================
-- 114 — QUOTATION PAYMENT PLAN (27aug Batch C, item 8)
-- The Quotation module now captures a Payment plan (matching the Sales Closer / enrolment flow:
-- Branch>Vertical>Course>Level>Payment plan). Nullable; existing quotations keep NULL.
-- =============================================================================
ALTER TABLE quotation ADD COLUMN IF NOT EXISTS payment_plan VARCHAR(24) NULL;
