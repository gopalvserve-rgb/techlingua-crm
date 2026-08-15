-- =============================================================================
-- 085 — VERTICAL BILLING / IDENTITY FIELDS (client feedback, dev/88)
--
--   The client raises GST tax invoices / receipts PER VERTICAL, so the seller
--   identity a tax invoice prints (legal/display name, GSTIN, billing address)
--   belongs at the VERTICAL level, not only the branch (055 put legal_name/gstin
--   on branch; that stays the fallback). This adds the vertical-level identity +
--   contact + logo + bank-detail columns the Add/Edit Vertical form now captures.
--
--     · gstin               — 15-char India GSTIN of this vertical (seller)
--     · billing_address     — the address printed on the vertical's documents
--     · phone / email       — the vertical's contact
--     · display_name        — the brand / legal display name on documents
--     · logo_r2_key         — Cloudflare R2 object key for the vertical logo
--                             (R2-only; presigned on read — never a DB blob)
--     · bank_*              — discrete bank-detail columns (cleaner than JSONB)
--
--   Idempotent (IF NOT EXISTS). Nullable — existing verticals keep NULLs and the
--   invoice seller identity falls back to branch/org exactly as before.
-- =============================================================================

ALTER TABLE vertical ADD COLUMN IF NOT EXISTS gstin               VARCHAR(15);
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS billing_address     TEXT;
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS phone               VARCHAR(24);
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS email               VARCHAR(255);
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS display_name        VARCHAR(200);
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS logo_r2_key         TEXT;
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS bank_name           VARCHAR(160);
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS bank_account_no     VARCHAR(40);
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS bank_ifsc           VARCHAR(15);
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS bank_branch         VARCHAR(160);
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS bank_account_holder VARCHAR(200);
