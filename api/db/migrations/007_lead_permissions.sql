-- 007: Sprint 2 — make sure lead.* / followup.* permissions exist and are granted
-- to the system roles that work leads. Fully idempotent (ON CONFLICT DO NOTHING /
-- WHERE NOT EXISTS) so it is safe on databases seeded before or after this sprint.
-- QA sign-off note (docs/qa/02-sprint1-test-report.md): lead & follow_up must be
-- registered in the @ScopedEntity registry (done in code) and permitted via seed.

-- 1) permission catalog rows (mirror of src/rbac/permission-catalog.ts)
INSERT INTO permission (key, module, action) VALUES
  ('lead.read','lead','read'), ('lead.create','lead','create'), ('lead.update','lead','update'),
  ('lead.delete','lead','delete'), ('lead.assign','lead','assign'), ('lead.transfer','lead','transfer'),
  ('lead.export','lead','export'), ('lead.import','lead','import'),
  ('followup.read','followup','read'), ('followup.create','followup','create'),
  ('followup.update','followup','update'), ('followup.delete','followup','delete')
ON CONFLICT (key) DO NOTHING;

-- 2) grants per system role (record_scope per PROJECT_DOCUMENTATION §3.2)
--    Super Admin / Organization Admin: everything at 'all'
--    Branch Manager: branch · Vertical Manager: vertical · Team Leader: team
--    Counsellor / Telecaller: own · Marketing Manager: lead.read at vertical
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('Super Admin',        'all',      ARRAY['lead.read','lead.create','lead.update','lead.delete','lead.assign','lead.transfer','lead.export','lead.import','followup.read','followup.create','followup.update','followup.delete']),
      ('Organization Admin', 'all',      ARRAY['lead.read','lead.create','lead.update','lead.delete','lead.assign','lead.transfer','lead.export','lead.import','followup.read','followup.create','followup.update','followup.delete']),
      ('Branch Manager',     'branch',   ARRAY['lead.read','lead.create','lead.update','lead.assign','lead.transfer','lead.export','followup.read','followup.create','followup.update']),
      ('Vertical Manager',   'vertical', ARRAY['lead.read','lead.create','lead.update','lead.assign','lead.export','followup.read','followup.create','followup.update']),
      ('Team Leader',        'team',     ARRAY['lead.read','lead.update','lead.assign','followup.read','followup.create','followup.update']),
      ('Counsellor',         'own',      ARRAY['lead.read','lead.create','lead.update','followup.read','followup.create','followup.update']),
      ('Telecaller',         'own',      ARRAY['lead.read','lead.create','lead.update','followup.read','followup.create','followup.update']),
      ('Marketing Manager',  'vertical', ARRAY['lead.read'])
    ) AS t(role_name, scope, keys)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro
      JOIN permission p ON p.key = ANY (r.keys)
     WHERE ro.name = r.role_name AND ro.is_system
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
