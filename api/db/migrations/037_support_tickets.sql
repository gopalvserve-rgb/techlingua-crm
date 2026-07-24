-- =============================================================================
-- 037 — SUPPORT & TICKETS (internal staff tickets, full lifecycle)
--
-- Replaces the design-only "Help & Support › Support Tickets" shell with a real,
-- working, RBAC-scoped, soft-deletable, audited module.
--
--   1) m_ticket_category   Ticket Category is a MASTER (admin manages the list from
--                          Administration › Masters). Registered in
--                          masters.service.ts MASTER_TYPES as `ticket_category`, so it
--                          inherits the generic masters CRUD, the ＋Master quick-add and
--                          the soft-delete registry entry `master:ticket_category` for
--                          free. Four rows are seeded (Technical/Billing/Academic/General),
--                          all editable and deletable by the admin.
--   2) support_ticket      the ticket. Carries branch_id/vertical_id for RBAC scope
--                          (same Org>Branch>Vertical isolation every other entity uses),
--                          created_by (the reporter) and assignee_id (a user). Numbered
--                          SUP-#### from the numbering series (`support` kind).
--                          Lifecycle: open -> in_progress -> resolved -> closed, with a
--                          reopen path back to in_progress. Soft delete (deleted_at).
--   3) support_ticket_comment   the thread — one row per comment/reply, author + time,
--                          with an optional internal-note flag (a note staff see but that
--                          is not a customer-facing reply).
--
-- SLA: a simple, configurable per-priority first-response + resolution target (minutes),
-- stored in app_setting `support_sla` (defaults below). Breach is DERIVED at read time
-- from created_at/first_response_at + the target, so changing the target re-evaluates
-- every open ticket at once with no backfill — the same "compute, don't denormalise"
-- choice the dashboards use.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING). Safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Ticket Category master. Same shape as every m_* master (masters.service.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS m_ticket_category (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  name        VARCHAR(120) NOT NULL,
  code        VARCHAR(40) NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  meta        JSONB NOT NULL DEFAULT '{}',
  parent_id   BIGINT NULL,
  created_by  BIGINT NULL REFERENCES "user"(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  BIGINT NULL REFERENCES "user"(id)
);

-- Uniqueness on (org, lower(name)) among ACTIVE rows — the same guard the UAT-R2 masters
-- use, so a duplicate category cannot be created and the seed below is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_m_ticket_category_active_name
  ON m_ticket_category (org_id, lower(name)) WHERE is_active;

-- Seed guarded row-by-row with NOT EXISTS, so re-running the migration adds nothing.
DO $$
DECLARE v_org BIGINT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;
  INSERT INTO m_ticket_category (org_id, name, code, sort_order)
  SELECT v_org, v.name, v.code, v.so
    FROM (VALUES ('Technical', 'TECH', 0),
                 ('Billing',   'BILL', 1),
                 ('Academic',  'ACAD', 2),
                 ('General',   'GEN',  3)) AS v(name, code, so)
   WHERE NOT EXISTS (SELECT 1 FROM m_ticket_category m WHERE m.org_id = v_org AND lower(m.name) = lower(v.name));
END $$;

-- ---------------------------------------------------------------------------
-- 2) support_ticket
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_ticket (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL REFERENCES organisation(id),
  ticket_no          VARCHAR(32) NOT NULL,
  subject            VARCHAR(200) NOT NULL,
  description        TEXT NULL,
  -- category is the MASTER'S NAME (text), the same way walk-in Training Mode / Purpose
  -- store the master name: it keeps the column readable and edit-prefill trivial, and the
  -- list is still admin-managed in Masters. (A renamed/deleted category does not rewrite
  -- history — deliberate, like every other mopts master.)
  category           VARCHAR(120) NULL,
  priority           VARCHAR(12) NOT NULL DEFAULT 'medium'
                       CHECK (priority IN ('low','medium','high','urgent')),
  status             VARCHAR(16) NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','in_progress','resolved','closed')),
  branch_id          BIGINT NULL REFERENCES branch(id),
  vertical_id        BIGINT NULL REFERENCES vertical(id),
  assignee_id        BIGINT NULL REFERENCES "user"(id),
  created_by         BIGINT NULL REFERENCES "user"(id),
  first_response_at  TIMESTAMPTZ NULL,
  resolved_at        TIMESTAMPTZ NULL,
  closed_at          TIMESTAMPTZ NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ NULL,
  deleted_by         BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS ix_support_ticket_status   ON support_ticket (status)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_support_ticket_assignee ON support_ticket (assignee_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_support_ticket_branch   ON support_ticket (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_support_ticket_created  ON support_ticket (created_at DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3) support_ticket_comment — the thread
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_ticket_comment (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  ticket_id    BIGINT NOT NULL REFERENCES support_ticket(id) ON DELETE CASCADE,
  author_id    BIGINT NULL REFERENCES "user"(id),
  body         TEXT NOT NULL,
  is_internal  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_support_comment_ticket ON support_ticket_comment (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- 4) Numbering series for tickets (SUP-####). Most-specific-wins like every kind.
-- ---------------------------------------------------------------------------
INSERT INTO number_series (org_id, kind, prefix, next_number, padding, reset_period)
SELECT id, 'support', 'SUP-', 1, 4, 'none' FROM organisation ORDER BY id LIMIT 1
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5) Default per-priority SLA targets (minutes). Editable; a missing row means defaults.
-- ---------------------------------------------------------------------------
INSERT INTO app_setting (key, value)
VALUES ('support_sla', '{
  "urgent": {"first_response": 30,  "resolution": 240},
  "high":   {"first_response": 60,  "resolution": 480},
  "medium": {"first_response": 120, "resolution": 1440},
  "low":    {"first_response": 240, "resolution": 2880}
}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6) Permissions — the ticket.* module + role grants.
--     read/create wide (any staff member raises and sees per scope); update = work the
--     ticket (status/reassign/edit); comment = reply on the thread; delete = admin.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('ticket.read',    'ticket', 'read'),
  ('ticket.create',  'ticket', 'create'),
  ('ticket.update',  'ticket', 'update'),
  ('ticket.comment', 'ticket', 'comment'),
  ('ticket.delete',  'ticket', 'delete')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ticket.read',    'Super Admin',        'all'),
      ('ticket.read',    'Organization Admin', 'all'),
      ('ticket.read',    'Marketing Manager',  'all'),
      ('ticket.read',    'Branch Manager',     'branch'),
      ('ticket.read',    'Vertical Manager',   'vertical'),
      ('ticket.read',    'Team Leader',        'team'),
      ('ticket.read',    'Counsellor',         'own'),
      ('ticket.read',    'Telecaller',         'own'),
      ('ticket.create',  'Super Admin',        'all'),
      ('ticket.create',  'Organization Admin', 'all'),
      ('ticket.create',  'Marketing Manager',  'all'),
      ('ticket.create',  'Branch Manager',     'branch'),
      ('ticket.create',  'Vertical Manager',   'vertical'),
      ('ticket.create',  'Team Leader',        'team'),
      ('ticket.create',  'Counsellor',         'own'),
      ('ticket.create',  'Telecaller',         'own'),
      ('ticket.update',  'Super Admin',        'all'),
      ('ticket.update',  'Organization Admin', 'all'),
      ('ticket.update',  'Marketing Manager',  'all'),
      ('ticket.update',  'Branch Manager',     'branch'),
      ('ticket.update',  'Vertical Manager',   'vertical'),
      ('ticket.update',  'Team Leader',        'team'),
      ('ticket.comment', 'Super Admin',        'all'),
      ('ticket.comment', 'Organization Admin', 'all'),
      ('ticket.comment', 'Marketing Manager',  'all'),
      ('ticket.comment', 'Branch Manager',     'branch'),
      ('ticket.comment', 'Vertical Manager',   'vertical'),
      ('ticket.comment', 'Team Leader',        'team'),
      ('ticket.comment', 'Counsellor',         'own'),
      ('ticket.comment', 'Telecaller',         'own'),
      ('ticket.delete',  'Super Admin',        'all'),
      ('ticket.delete',  'Organization Admin', 'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
