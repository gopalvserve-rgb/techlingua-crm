-- =============================================================================
-- 031 — SPRINT 6: REPORTS, WORKSPACE, HARDENING  (closes Phase 1)
--
--   1) report_definition  a SAVED REPORT: entity + columns + filters + grouping +
--                         sort + date window. `config` is JSONB, but NOTHING in it
--                         is ever SQL — see reports/entities.ts. The client names
--                         COLUMN KEYS from a fixed registry; anything not in the
--                         registry is rejected before a query is built.
--   2) report_share       who a saved report is shared WITH (a user or a role).
--                         A share grants VISIBILITY OF THE DEFINITION ONLY. The
--                         rows are re-scoped to whoever RUNS it, every run. See
--                         the note under §2 below — it is the security crux of
--                         this sprint.
--   3) report_export      the async export queue (xlsx / pdf). Same topology as
--                         message_log and import_job: a Postgres queue + an
--                         in-process worker. A 20,000-row export must not hold an
--                         API request open.
--   4) report_schedule    daily / weekly / monthly email delivery of a saved report.
--   5) report_delivery    one row per (schedule, period). UNIQUE(schedule_id,
--                         run_key) is what makes a schedule IDEMPOTENT: two API
--                         replicas ticking in the same second cannot both send.
--                         It is also the delivery HISTORY the client reads.
--
--   6) workspace_channel / workspace_message   internal team messages
--   7) workspace_note                          shared + personal notes
--   8) kb_article                              internal knowledge base
--   9) announcement / announcement_read        announcements + read tracking
--
--  WORKSPACE TASKS ARE NOT IN THIS MIGRATION, ON PURPOSE.
--  "tasks (same fields/statuses as follow-up tasks)" — PROJECT_DOCUMENTATION §5.
--  A second task table with the same fields IS the fork the brief forbids, so
--  Workspace › Tasks IS the follow-up module: same table, same statuses, same
--  priorities, same Report To, same API. See docs/dev/08 §5 for what that does and
--  does not give the client (a task with no lead is a real gap, and it is flagged,
--  not hidden).
--
--  10) HARDENING — indexes for the lists and reports the client is about to load
--      with real volume. Every one of them is CONCURRENTLY-free on purpose: they
--      run inside the boot migration, and the tables are small TODAY. Doing it now
--      is the cheap moment.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) report_definition
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_definition (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  name        VARCHAR(160) NOT NULL,
  description TEXT NULL,
  entity      VARCHAR(32) NOT NULL,
  -- { columns[], filters[], group_by[], sort[], date_field, date_preset, date_from, date_to }
  -- Column/filter/sort entries are KEYS into reports/entities.ts. Never SQL.
  config      JSONB NOT NULL DEFAULT '{}',
  owner_id    BIGINT NULL REFERENCES "user"(id),
  is_standard BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT NULL REFERENCES "user"(id),
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS ix_report_definition_owner ON report_definition (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_report_definition_entity ON report_definition (entity) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2) report_share — VISIBILITY OF THE DEFINITION, NOT OF THE DATA.
--
--    THE RULE, WRITTEN WHERE IT IS ENFORCED:
--    A share says "you may see and run this report". It says NOTHING about which
--    rows come back. Every run re-resolves the RUNNER's own record scope through the
--    ScopeResolver and puts that fragment INSIDE the SQL. A Branch Manager shares
--    "Leads won this month" with a counsellor; the counsellor runs it and gets HIS
--    won leads. That is not a filter applied afterwards in JavaScript — his scope IS
--    the WHERE clause, so there is no code path in which the wider rows are ever read.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_share (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id  BIGINT NOT NULL REFERENCES report_definition(id) ON DELETE CASCADE,
  user_id    BIGINT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role_id    BIGINT NULL REFERENCES role(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NULL REFERENCES "user"(id),
  CHECK ((user_id IS NULL) <> (role_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_share
  ON report_share (report_id, COALESCE(user_id, 0), COALESCE(role_id, 0));

-- ---------------------------------------------------------------------------
-- 3) report_export — the async export queue.
--    `bytes` is BYTEA: a Railway container has no durable disk, and an export is
--    a few hundred KB that the user downloads within the minute. It is deleted by
--    the worker's own sweep after `expires_at`, so the table cannot grow forever.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_export (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  report_id    BIGINT NULL REFERENCES report_definition(id) ON DELETE SET NULL,
  entity       VARCHAR(32) NOT NULL,
  config       JSONB NOT NULL DEFAULT '{}',
  format       VARCHAR(8) NOT NULL DEFAULT 'xlsx' CHECK (format IN ('xlsx', 'pdf', 'csv')),
  -- WHOSE SCOPE THE ROWS ARE RENDERED IN. An export runs in the background, so the
  -- request's ResolvedScope is long gone by the time the worker picks it up; it is
  -- re-resolved from this user id. An export therefore contains exactly what the
  -- person who asked for it could see on screen — never more.
  requested_by BIGINT NOT NULL REFERENCES "user"(id),
  status       VARCHAR(12) NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  attempts     INT NOT NULL DEFAULT 0,
  locked_at    TIMESTAMPTZ NULL,
  file_name    VARCHAR(200) NULL,
  row_count    INT NULL,
  bytes        BYTEA NULL,
  error        TEXT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ NULL,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);
CREATE INDEX IF NOT EXISTS ix_report_export_due ON report_export (status, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS ix_report_export_user ON report_export (requested_by, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4) report_schedule
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_schedule (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  report_id     BIGINT NOT NULL REFERENCES report_definition(id) ON DELETE CASCADE,
  frequency     VARCHAR(8) NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  hour_local    INT NOT NULL DEFAULT 8 CHECK (hour_local BETWEEN 0 AND 23),
  minute_local  INT NOT NULL DEFAULT 0 CHECK (minute_local BETWEEN 0 AND 59),
  day_of_week   INT NULL CHECK (day_of_week BETWEEN 0 AND 6),      -- weekly; 0 = Sunday
  day_of_month  INT NULL CHECK (day_of_month BETWEEN 1 AND 28),    -- monthly; 28 = every month has one
  format        VARCHAR(8) NOT NULL DEFAULT 'xlsx' CHECK (format IN ('xlsx', 'pdf', 'csv')),
  recipient_user_ids JSONB NOT NULL DEFAULT '[]',
  recipient_role_ids JSONB NOT NULL DEFAULT '[]',
  -- Same rule as report_export: the delivered file is rendered in the SCHEDULE
  -- OWNER'S scope, and the UI says so in words on the schedule form. Emailing a
  -- Branch Manager's report to a counsellor does not widen the counsellor's access
  -- to the app, but it DOES put branch rows in his inbox — so the client must see
  -- that sentence before he presses Save, not discover it afterwards.
  run_as_user_id BIGINT NOT NULL REFERENCES "user"(id),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at   TIMESTAMPTZ NULL,
  last_run_at   TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT NULL REFERENCES "user"(id),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS ix_report_schedule_due
  ON report_schedule (next_run_at) WHERE is_active AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5) report_delivery — the idempotency key AND the history.
--    run_key is the PERIOD the run is for ('2026-07-17', '2026-W29', '2026-07'),
--    so a schedule can only ever have one delivery per period. Insert first with
--    ON CONFLICT DO NOTHING RETURNING id: no id back means somebody else already
--    owns this period, and we stop. (The Sprint-4 journey rule, unchanged: a
--    UNIQUE index, never a check-then-insert that races.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_delivery (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule_id BIGINT NOT NULL REFERENCES report_schedule(id) ON DELETE CASCADE,
  run_key     VARCHAR(24) NOT NULL,
  status      VARCHAR(12) NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'sent', 'failed', 'skipped')),
  recipients  JSONB NOT NULL DEFAULT '[]',
  message_ids JSONB NOT NULL DEFAULT '[]',
  file_name   VARCHAR(200) NULL,
  row_count   INT NULL,
  error       TEXT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_delivery_period ON report_delivery (schedule_id, run_key);
CREATE INDEX IF NOT EXISTS ix_report_delivery_recent ON report_delivery (schedule_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- 5b) message_attachment — EMAIL ATTACHMENTS, added to the Sprint-4 pipeline.
--
--     Scheduled delivery is the first thing in this product that has to attach a FILE
--     to an email. The alternative was a second send path for "emails with files",
--     which would have its own retries, its own rate limit and its own log — i.e. the
--     one thing Sprint 4 explicitly bought by putting every message through one table
--     ("a reminder email and a marketing email are the same row, the same worker, the
--     same log"). So the attachment hangs off message_log instead, and the existing
--     worker, retry policy, rate limit and send log all keep working unchanged.
--
--     BYTEA, like report_export: a Railway container has no durable disk, an attachment
--     is a few hundred KB, and it is deleted with its message.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_attachment (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id   BIGINT NOT NULL REFERENCES message_log(id) ON DELETE CASCADE,
  filename     VARCHAR(200) NOT NULL,
  content_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
  bytes        BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_message_attachment_msg ON message_attachment (message_id);

-- ---------------------------------------------------------------------------
-- 6) workspace_channel / workspace_message — internal team messages.
--    branch_id / vertical_id are the SCOPE COLUMNS the ScopeResolver narrows on,
--    exactly like every other entity. A NULL means org-wide.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_channel (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  name        VARCHAR(120) NOT NULL,
  topic       TEXT NULL,
  branch_id   BIGINT NULL REFERENCES branch(id),
  vertical_id BIGINT NULL REFERENCES vertical(id),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT NULL REFERENCES "user"(id),
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_channel_name
  ON workspace_channel (org_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_message (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES workspace_channel(id) ON DELETE CASCADE,
  author_id  BIGINT NULL REFERENCES "user"(id),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ NULL,
  deleted_by BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS ix_workspace_message_channel
  ON workspace_message (channel_id, id DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 7) workspace_note
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_note (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  title       VARCHAR(200) NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  branch_id   BIGINT NULL REFERENCES branch(id),
  vertical_id BIGINT NULL REFERENCES vertical(id),
  owner_id    BIGINT NULL REFERENCES "user"(id),
  -- FALSE = only the owner sees it. TRUE = anyone whose scope covers the note's
  -- branch/vertical sees it. There is no third state, because "shared with a list
  -- of people" is what a report share is for, and one sharing model is enough.
  is_shared   BOOLEAN NOT NULL DEFAULT FALSE,
  is_pinned   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT NULL REFERENCES "user"(id),
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS ix_workspace_note_owner ON workspace_note (owner_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 8) kb_article
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_article (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  category     VARCHAR(120) NOT NULL DEFAULT 'General',
  title        VARCHAR(200) NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  branch_id    BIGINT NULL REFERENCES branch(id),
  vertical_id  BIGINT NULL REFERENCES vertical(id),
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  author_id    BIGINT NULL REFERENCES "user"(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT NULL REFERENCES "user"(id),
  deleted_at   TIMESTAMPTZ NULL,
  deleted_by   BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS ix_kb_article_cat ON kb_article (org_id, category) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 9) announcement + read tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS announcement (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  title        VARCHAR(200) NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  branch_id    BIGINT NULL REFERENCES branch(id),
  vertical_id  BIGINT NULL REFERENCES vertical(id),
  role_ids     JSONB NOT NULL DEFAULT '[]',
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ NULL,
  notify       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT NULL REFERENCES "user"(id),
  deleted_at   TIMESTAMPTZ NULL,
  deleted_by   BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS ix_announcement_pub ON announcement (org_id, published_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS announcement_read (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  announcement_id BIGINT NOT NULL REFERENCES announcement(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_announcement_read ON announcement_read (announcement_id, user_id);

-- ---------------------------------------------------------------------------
-- 10) HARDENING — the indexes the big lists and the new reports need.
--
--     These were chosen by reading the ACTUAL WHERE/ORDER BY of the queries the
--     client will run hardest once he imports real volume, not by guessing:
--       · every scoped list orders by `id DESC` inside `deleted_at IS NULL`;
--       · every report windows on a date column and narrows on owner/branch;
--       · the funnel and TAT reports read lead_stage_tat by (lead, stage);
--       · campaign ROI counts leads per campaign and enrolments per campaign.
--     Partial indexes (WHERE deleted_at IS NULL) because ~100% of reads exclude
--     deleted rows, and a partial index is smaller and stays in cache.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_lead_owner_created   ON lead (owner_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_lead_branch_created  ON lead (branch_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_lead_campaign_created ON lead (campaign_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_lead_stage_live      ON lead (stage_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_lead_created_live    ON lead (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_follow_up_owner_sched ON follow_up (owner_id, scheduled_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_follow_up_lead       ON follow_up (lead_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_lead_stage_tat_lead  ON lead_stage_tat (lead_id, stage_id);
CREATE INDEX IF NOT EXISTS ix_lead_stage_tat_stage ON lead_stage_tat (stage_id, entered_at);
CREATE INDEX IF NOT EXISTS ix_lead_sla_metric      ON lead_sla (metric, started_at);
CREATE INDEX IF NOT EXISTS ix_enrolment_counsellor ON enrolment (counsellor_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_enrolment_campaign   ON enrolment (campaign_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_fee_receipt_enrolment ON fee_receipt (enrolment_id, received_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_fee_receipt_received  ON fee_receipt (received_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_lead_activity_actor   ON lead_activity (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_log_actor       ON audit_log (actor_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 11) Permissions + grants.
--     `report.read` / `report.export` were catalogued in Sprint 1 and NEVER
--     GRANTED to anybody — Sprint 6 is the first sprint with a report to read, so
--     this is where they get their rows.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('report.read',      'report',    'read'),
  ('report.create',    'report',    'create'),
  ('report.update',    'report',    'update'),
  ('report.delete',    'report',    'delete'),
  ('report.share',     'report',    'share'),
  ('report.schedule',  'report',    'schedule'),
  ('report.export',    'report',    'export'),
  ('workspace.read',   'workspace', 'read'),
  ('workspace.post',   'workspace', 'post'),
  ('workspace.manage', 'workspace', 'manage'),
  ('announcement.read',   'announcement', 'read'),
  ('announcement.manage', 'announcement', 'manage'),
  ('kb.read',   'kb', 'read'),
  ('kb.manage', 'kb', 'manage')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- reports: everybody who works leads may READ and BUILD reports. Their scope
      -- does the limiting, not a second permission — a counsellor building "my leads
      -- this week" is the whole point of a self-service builder.
      ('report.read',     'Super Admin',        'all'),
      ('report.read',     'Organization Admin', 'all'),
      ('report.read',     'Marketing Manager',  'all'),
      ('report.read',     'Branch Manager',     'branch'),
      ('report.read',     'Vertical Manager',   'vertical'),
      ('report.read',     'Team Leader',        'team'),
      ('report.read',     'Counsellor',         'own'),
      ('report.read',     'Telecaller',         'own'),
      ('report.create',   'Super Admin',        'all'),
      ('report.create',   'Organization Admin', 'all'),
      ('report.create',   'Marketing Manager',  'all'),
      ('report.create',   'Branch Manager',     'branch'),
      ('report.create',   'Vertical Manager',   'vertical'),
      ('report.create',   'Team Leader',        'team'),
      ('report.create',   'Counsellor',         'own'),
      ('report.update',   'Super Admin',        'all'),
      ('report.update',   'Organization Admin', 'all'),
      ('report.update',   'Marketing Manager',  'all'),
      ('report.update',   'Branch Manager',     'branch'),
      ('report.update',   'Vertical Manager',   'vertical'),
      ('report.update',   'Team Leader',        'team'),
      ('report.update',   'Counsellor',         'own'),
      ('report.delete',   'Super Admin',        'all'),
      ('report.delete',   'Organization Admin', 'all'),
      ('report.delete',   'Branch Manager',     'branch'),
      ('report.delete',   'Vertical Manager',   'vertical'),
      ('report.delete',   'Counsellor',         'own'),
      -- SHARE and SCHEDULE are deliberately NOT a counsellor's. Sharing puts a
      -- definition in somebody else's list; scheduling puts a FILE IN AN INBOX on a
      -- timer. Both are things a manager decides.
      ('report.share',    'Super Admin',        'all'),
      ('report.share',    'Organization Admin', 'all'),
      ('report.share',    'Marketing Manager',  'all'),
      ('report.share',    'Branch Manager',     'branch'),
      ('report.share',    'Vertical Manager',   'vertical'),
      ('report.share',    'Team Leader',        'team'),
      ('report.schedule', 'Super Admin',        'all'),
      ('report.schedule', 'Organization Admin', 'all'),
      ('report.schedule', 'Marketing Manager',  'all'),
      ('report.schedule', 'Branch Manager',     'branch'),
      ('report.schedule', 'Vertical Manager',   'vertical'),
      ('report.export',   'Super Admin',        'all'),
      ('report.export',   'Organization Admin', 'all'),
      ('report.export',   'Marketing Manager',  'all'),
      ('report.export',   'Branch Manager',     'branch'),
      ('report.export',   'Vertical Manager',   'vertical'),
      ('report.export',   'Team Leader',        'team'),
      ('report.export',   'Counsellor',         'own'),

      ('workspace.read',   'Super Admin',        'all'),
      ('workspace.read',   'Organization Admin', 'all'),
      ('workspace.read',   'Marketing Manager',  'all'),
      ('workspace.read',   'Branch Manager',     'branch'),
      ('workspace.read',   'Vertical Manager',   'vertical'),
      ('workspace.read',   'Team Leader',        'branch'),
      ('workspace.read',   'Counsellor',         'branch'),
      ('workspace.read',   'Telecaller',         'branch'),
      ('workspace.read',   'Accountant',         'branch'),
      ('workspace.post',   'Super Admin',        'all'),
      ('workspace.post',   'Organization Admin', 'all'),
      ('workspace.post',   'Marketing Manager',  'all'),
      ('workspace.post',   'Branch Manager',     'branch'),
      ('workspace.post',   'Vertical Manager',   'vertical'),
      ('workspace.post',   'Team Leader',        'branch'),
      ('workspace.post',   'Counsellor',         'branch'),
      ('workspace.post',   'Telecaller',         'branch'),
      ('workspace.post',   'Accountant',         'branch'),
      ('workspace.manage', 'Super Admin',        'all'),
      ('workspace.manage', 'Organization Admin', 'all'),
      ('workspace.manage', 'Branch Manager',     'branch'),
      ('workspace.manage', 'Vertical Manager',   'vertical'),

      ('kb.read',   'Super Admin',        'all'),
      ('kb.read',   'Organization Admin', 'all'),
      ('kb.read',   'Marketing Manager',  'all'),
      ('kb.read',   'Branch Manager',     'branch'),
      ('kb.read',   'Vertical Manager',   'vertical'),
      ('kb.read',   'Team Leader',        'branch'),
      ('kb.read',   'Counsellor',         'branch'),
      ('kb.read',   'Telecaller',         'branch'),
      ('kb.read',   'Accountant',         'branch'),
      ('kb.manage', 'Super Admin',        'all'),
      ('kb.manage', 'Organization Admin', 'all'),
      ('kb.manage', 'Branch Manager',     'branch'),
      ('kb.manage', 'Vertical Manager',   'vertical'),

      ('announcement.read',   'Super Admin',        'all'),
      ('announcement.read',   'Organization Admin', 'all'),
      ('announcement.read',   'Marketing Manager',  'all'),
      ('announcement.read',   'Branch Manager',     'branch'),
      ('announcement.read',   'Vertical Manager',   'vertical'),
      ('announcement.read',   'Team Leader',        'branch'),
      ('announcement.read',   'Counsellor',         'branch'),
      ('announcement.read',   'Telecaller',         'branch'),
      ('announcement.read',   'Accountant',         'branch'),
      ('announcement.manage', 'Super Admin',        'all'),
      ('announcement.manage', 'Organization Admin', 'all'),
      ('announcement.manage', 'Branch Manager',     'branch'),
      ('announcement.manage', 'Vertical Manager',   'vertical')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 12) A general channel, so Workspace is not an empty room on day one.
-- ---------------------------------------------------------------------------
INSERT INTO workspace_channel (org_id, name, topic)
SELECT o.id, 'General', 'Everyone. Announcements, questions, hand-overs.'
  FROM organisation o
 WHERE NOT EXISTS (SELECT 1 FROM workspace_channel c WHERE c.org_id = o.id AND lower(c.name) = 'general')
ON CONFLICT DO NOTHING;
