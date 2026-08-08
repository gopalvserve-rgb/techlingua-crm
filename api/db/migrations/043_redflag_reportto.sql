-- 043 — Client requests (Aug 2026):
--   A) Lead RED FLAG — a per-lead flag state + a conversation of remark entries. Distinct
--      from the existing duplicate/SLA `is_flagged` amber badge: RED flag is a deliberate,
--      human "watch this lead" mark that carries a running remark thread.
--   B) USER "Reports To" — a user's reporting MANAGER, stored on the user record. This is a
--      DIFFERENT thing from the task-level report_to (migration 016, on follow_up): that is
--      "who the assignee reports this task's progress to"; THIS is the user's org manager.
-- Fully idempotent (ADD COLUMN / CREATE TABLE / permission grants all IF NOT EXISTS-style).

-- A) lead red-flag state ------------------------------------------------------
ALTER TABLE lead ADD COLUMN IF NOT EXISTS is_red_flagged BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS red_flagged_at TIMESTAMPTZ;
-- partial index: the Leads list can offer a "Red flagged" filter, and the badge query reads
-- only the rare flagged rows.
CREATE INDEX IF NOT EXISTS ix_lead_red_flagged ON lead (is_red_flagged) WHERE is_red_flagged;

-- A) lead red-flag entries (the conversation) --------------------------------
-- Each row is one remark by one user at one time. Soft-deletable (deleted_at/deleted_by)
-- exactly like the other soft-deletable records, so the thread respects the delete policy.
CREATE TABLE IF NOT EXISTS lead_red_flag (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id     BIGINT NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  branch_id   BIGINT NOT NULL REFERENCES branch(id),   -- carried for partition/scope, like lead_activity
  remark      TEXT NOT NULL,
  created_by  BIGINT REFERENCES "user"(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  deleted_by  BIGINT REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS ix_red_flag_lead ON lead_red_flag (lead_id, created_at);

-- lead_activity gains the 'red_flag' verb so a red flag shows on the MAIN timeline too.
-- (VARCHAR(16); 'red_flag' = 8 chars.) Same enumerated-CHECK pattern as 041/038/023.
ALTER TABLE lead_activity DROP CONSTRAINT IF EXISTS lead_activity_type_check;
ALTER TABLE lead_activity ADD  CONSTRAINT lead_activity_type_check
  CHECK (type IN ('create','stage_change','status_change','assign','follow_up','note',
                  'message','call_log','field_change','merge','transfer','disposition',
                  'cross_sell','pause','resume','red_flag'));

-- A) RBAC — a dedicated `lead.flag` permission (mirror of src/rbac/permission-catalog.ts).
-- Granted to every role that already holds `lead.update`, at that role's SAME record scope,
-- so exactly the people who can edit a lead can also flag it (no new admin step needed).
INSERT INTO permission (key, module, action) VALUES ('lead.flag','lead','flag')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id, record_scope)
SELECT rp.role_id, pf.id, rp.record_scope
  FROM role_permission rp
  JOIN permission pu ON pu.id = rp.permission_id AND pu.key = 'lead.update'
  CROSS JOIN (SELECT id FROM permission WHERE key = 'lead.flag') pf
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- B) user "Reports To" (reporting manager) -----------------------------------
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS report_to_id BIGINT;
DO $$ BEGIN
  ALTER TABLE "user" ADD CONSTRAINT fk_user_report_to
    FOREIGN KEY (report_to_id) REFERENCES "user"(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_user_report_to ON "user"(report_to_id);
