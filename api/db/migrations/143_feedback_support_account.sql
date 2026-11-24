-- 143 — FEEDBACK: THE SUPPORT ACCOUNT ANSWERS ARE POSTED FROM (24 Nov 2026).
--
-- Feedback is worked through every day (export, fix, answer, close a day later) and the answers are
-- posted with api/scripts/feedback-ops.js. Until now the only account on the feedback team was the
-- client's own Super Admin login — the same one that files the notes — so an answer would have read
-- as that person answering himself. Answers come from this account instead: the reporter sees
-- "Tech Lingua CRM Support".
--
-- It is an author, not a login: no password and status 'disabled', so nobody can sign in with it
-- (auth refuses both); is_active false and lead assignment off keep it out of staff pickers, lead
-- routing and head counts. Its one role grants feedback.manage and nothing else.
-- Re-runnable: every insert checks first.

INSERT INTO role (org_id, name, is_system, is_custom, description)
SELECT o.id, 'Feedback Support', false, true,
       'Answers in-app feedback (Help & Support › Feedback) and nothing else. Held by the Tech Lingua CRM Support account.'
  FROM (SELECT id FROM organisation ORDER BY id LIMIT 1) o
 WHERE NOT EXISTS (SELECT 1 FROM role r WHERE r.org_id = o.id AND r.name = 'Feedback Support');

INSERT INTO role_permission (role_id, permission_id, record_scope)
SELECT r.id, p.id, 'all'
  FROM role r CROSS JOIN permission p
 WHERE r.name = 'Feedback Support' AND p.key = 'feedback.manage'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- phone is mandatory and unique (the login identifier): a placeholder no mobile can have (Indian
-- mobiles start 6-9), the same idea as migration 012's placeholders.
INSERT INTO "user" (org_id, name, email, phone, password_hash, status, is_active, lead_assignment_enabled)
SELECT o.id, 'Tech Lingua CRM Support', 'crm-support@techlingua.invalid', '+910000000143', NULL, 'disabled', false, false
  FROM (SELECT id FROM organisation ORDER BY id LIMIT 1) o
 WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE lower(u.email) = 'crm-support@techlingua.invalid')
   AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.phone = '+910000000143');

INSERT INTO user_assignment (user_id, role_id)
SELECT u.id, r.id
  FROM "user" u JOIN role r ON r.org_id = u.org_id AND r.name = 'Feedback Support'
 WHERE lower(u.email) = 'crm-support@techlingua.invalid'
   AND NOT EXISTS (SELECT 1 FROM user_assignment ua WHERE ua.user_id = u.id AND ua.role_id = r.id);
