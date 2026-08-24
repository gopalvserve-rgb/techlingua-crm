-- dev/132 ITEM B (task #216) — a vertical gains MULTIPLE bank accounts (one marked
-- active/required via checkbox), a UPI id, and a QR image (R2 key). Banks are stored as a
-- jsonb array; the legacy single-bank columns (085) are kept in sync with the ACTIVE bank
-- so any consumer still reading them keeps working. Idempotent (safe to re-run on boot).
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS banks     jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS upi_id    VARCHAR(120);
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS qr_r2_key TEXT;

-- Backfill: seed banks[] from the existing single-bank columns so no vertical loses its bank.
UPDATE vertical
   SET banks = jsonb_build_array(jsonb_build_object(
         'name',           COALESCE(bank_name, ''),
         'account_no',     COALESCE(bank_account_no, ''),
         'ifsc',           COALESCE(bank_ifsc, ''),
         'branch',         COALESCE(bank_branch, ''),
         'account_holder', COALESCE(bank_account_holder, ''),
         'active',         true))
 WHERE (banks IS NULL OR banks = '[]'::jsonb)
   AND (COALESCE(bank_name, '') <> '' OR COALESCE(bank_account_no, '') <> '');
