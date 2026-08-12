-- 069: DATA CLEANUP (regression leftovers) — remove two test rows by PRIMARY KEY, idempotent.
-- Fully guarded: each DELETE also matches the row's own identity (number / name), so it is a
-- no-op if the row is already gone OR if a real refund/role ever takes that id. Runs on boot.

-- (1) Approved test refund REF-2026-27/0001 (id 3), ₹2,000, skewing the org revenue view by
--     -2000. The API refuses to delete an approved refund by design, so we remove it here.
--     No table carries a refund_id FK (approve only writes a lead_activity note, which has no
--     refund reference and does not affect revenue), so there are NO dependent child rows to
--     delete — a single guarded DELETE suffices. The revenue view reads
--     `refund WHERE status='approved' AND deleted_at IS NULL`, so this hard delete corrects it.
DELETE FROM refund
 WHERE id = 3 AND refund_no = 'REF-2026-27/0001' AND status = 'approved';

-- (2) Leftover custom role ZZTEST Role (id 19). role_permission FK is ON DELETE CASCADE, but
--     user_assignment.role_id is NOT — delete any assignments first (guarded on the role's
--     identity), then the grants (explicit), then the role. All no-ops if id 19 is not that role.
DELETE FROM user_assignment
 WHERE role_id = 19
   AND EXISTS (SELECT 1 FROM role WHERE id = 19 AND name = 'ZZTEST Role');
DELETE FROM role_permission
 WHERE role_id = 19
   AND EXISTS (SELECT 1 FROM role WHERE id = 19 AND name = 'ZZTEST Role');
DELETE FROM role
 WHERE id = 19 AND name = 'ZZTEST Role';
