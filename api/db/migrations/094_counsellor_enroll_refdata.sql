-- =============================================================================
-- 094 — COUNSELLOR (and Team Leader) CAN ENROLL / CREATE STUDENTS  [OBS-2, dev/105]
--
-- BUG (final testing, OBS-2): a Counsellor could not enroll a student or create one — the
-- Branch and Vertical dropdowns in the "Enroll in another course" modal and the New Student
-- form were EMPTY. Root cause is a permission/RefData wiring gap, NOT the enrolment logic:
--   * the dropdowns are populated from GET /branches (branch.read) and GET /verticals
--     (vertical.read);
--   * the web RefData layer only CALLS those endpoints when can('branch.read') /
--     can('vertical.read') is true (web/src/refdata.tsx) — otherwise it returns [];
--   * the system Counsellor role holds student.create + enrolment.create (migrations 044 / 029)
--     but was NEVER granted branch.read / vertical.read, so both the client-side gate AND the
--     server endpoint (403) denied it — the dropdowns stayed empty and no enrolment could be
--     completed.
--
-- FIX: grant READ-ONLY branch.read + vertical.read to every NON-ADMIN role that can create a
-- student / enrolment but lacked them — the Counsellor and the Team Leader (Team Leader holds
-- student.create + enrolment.create 'team' too and had the identical latent gap). Scope mirrors
-- the managers: branch.read at 'branch', vertical.read at 'vertical', so the ScopeResolver shows
-- a user only the branch(es)/vertical(s) they belong to — consistent with how leads already show
-- them a branch/vertical. NO create/update/deactivate/delete is granted (read only).
--
-- Telecaller is intentionally NOT included: it holds neither student.create nor enrolment.create,
-- so it never reaches the enroll / new-student forms.
--
-- Idempotent (ON CONFLICT DO NOTHING). Permissions branch.read / vertical.read already exist
-- (seeded in 001 / the permission catalog); this only adds the missing role_permission rows.
-- =============================================================================

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('branch.read',   'Counsellor',  'branch'),
      ('vertical.read', 'Counsellor',  'vertical'),
      ('branch.read',   'Team Leader', 'branch'),
      ('vertical.read', 'Team Leader', 'vertical')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND ro.is_system = TRUE AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
