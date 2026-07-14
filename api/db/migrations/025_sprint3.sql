-- ============================================================================
-- 025 — SPRINT 3: "Working the lead"
--   1. lead scoring        — rule-based, ADMIN-CONFIGURABLE (client decision 14 Jul)
--   2. notifications       — in-app centre + the channel-agnostic notifier seam
--   3. follow-up reminders — remind_at + overdue ESCALATION (fires exactly once)
--   4. SLA / TAT           — configurable policy per stage/pipeline, breach flagged
--   5. calendar            — in-app events; Google/Outlook sync config-driven
--   6. walk-ins & referrals — real capture screens feeding the dashboard widgets
--
-- Idempotent (IF NOT EXISTS / DO-block guards) — the runner is filename-keyed and
-- never re-runs a file, but a half-applied file must be safe to re-apply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) LEAD SCORING — rules are DATA, not code. The admin edits them in Settings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_score_rule (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  name        VARCHAR(160) NOT NULL,
  -- the rule TYPE selects the evaluator; `config` carries its parameters.
  -- Deliberately an unconstrained VARCHAR (the providers-registry lesson):
  -- a new rule type is one entry in scoring/score.engine.ts, no migration.
  rule_type   VARCHAR(40) NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}',
  points      INT NOT NULL DEFAULT 0,          -- may be NEGATIVE (penalties)
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT,
  deleted_at  TIMESTAMPTZ,
  deleted_by  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_score_rule_active ON lead_score_rule(is_active, sort_order)
  WHERE deleted_at IS NULL;

-- the score BREAKDOWN is stored on the lead: "why is this lead Hot?" is answerable
-- without re-running the engine (and it is what the lead sheet renders).
ALTER TABLE lead ADD COLUMN IF NOT EXISTS score_breakdown JSONB NOT NULL DEFAULT '[]';
ALTER TABLE lead ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_lead_score ON lead(score DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_temperature ON lead(temperature) WHERE deleted_at IS NULL;
-- the ageing sweep's index: open leads whose score is stale
CREATE INDEX IF NOT EXISTS idx_lead_scored_at ON lead(scored_at NULLS FIRST)
  WHERE deleted_at IS NULL AND is_active;

-- band thresholds + clamp — ONE app_setting row, editable in Settings, no deploy.
INSERT INTO app_setting (key, value) VALUES
  ('lead_score_config', '{"bands": {"hot": 70, "warm": 40}, "min": 0, "max": 100, "age_sweep_hours": 6}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------- the DEFAULT rule set (client can edit every row) ----------
-- Ships sensible defaults so scoring works on day one; each row is editable and
-- deactivatable in Marketing & Lead Management > Lead Scoring.
INSERT INTO lead_score_rule (org_id, name, rule_type, config, points, sort_order)
SELECT o.id, r.name, r.rule_type, r.config::jsonb, r.points, r.sort_order
  FROM organisation o,
       (VALUES
         ('Walk-in visitor',            'walk_in',          '{}',                                    25, 10),
         ('Referral lead',              'referral',         '{}',                                    20, 20),
         ('Paid social source (Meta)',  'source_channel',   '{"channels": ["meta"]}',                10, 30),
         ('Paid search source (Google)','source_channel',   '{"channels": ["google"]}',              10, 40),
         ('Website / landing form',     'source_channel',   '{"channels": ["form", "webhook"]}',      5, 50),
         ('High priority lead',         'priority',         '{"values": ["high"]}',                  15, 60),
         ('Budget declared',            'has_field',        '{"field": "budget_id"}',                10, 70),
         ('Course of interest known',   'has_field',        '{"field": "course_id"}',                 8, 80),
         ('Email captured',             'has_field',        '{"field": "email"}',                     5, 90),
         ('WhatsApp number captured',   'has_field',        '{"field": "whatsapp_phone"}',            5, 100),
         ('Engagement: follow-ups done','followup_done',    '{"points_each": 5, "max": 20}',          5, 110),
         ('No response for 7 days',     'no_response_days', '{"days": 7}',                          -15, 120),
         ('Stale lead (30 days open)',  'age_days',         '{"days": 30}',                         -10, 130),
         ('Flagged as duplicate',       'duplicate',        '{}',                                   -10, 140)
       ) AS r(name, rule_type, config, points, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM lead_score_rule);

-- ---------------------------------------------------------------------------
-- 2) NOTIFICATIONS — the in-app centre. This is the SEAM Sprint 4 plugs
--    WhatsApp / SMS / Email into: every reminder, escalation, assignment and
--    SLA breach is written here by the channel-agnostic Notifier.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  user_id     BIGINT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  -- reminder | escalation | assignment | sla_breach | handout | system
  type        VARCHAR(24) NOT NULL,
  severity    VARCHAR(8) NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','error')),
  title       VARCHAR(200) NOT NULL,
  body        TEXT,
  -- deep link back into the app (lead sheet / follow-up)
  link_type   VARCHAR(24),
  link_id     BIGINT,
  meta        JSONB NOT NULL DEFAULT '{}',
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- the bell's query: my unread, newest first
CREATE INDEX IF NOT EXISTS idx_notification_user ON notification(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification(user_id) WHERE read_at IS NULL;

-- which channels the notifier fans out to. in_app is ON; the rest are the
-- Sprint-4 seam and stay OFF until the client's credentials arrive (SMS gateway,
-- Meta WhatsApp, per-vertical SMTP) — exactly the Sheet-channel precedent.
INSERT INTO app_setting (key, value) VALUES
  ('notification_channels', '{"in_app": true, "email": false, "sms": false, "whatsapp": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3) FOLLOW-UP REMINDERS + OVERDUE ESCALATION
--    reminded_at / escalated_at are the EXACTLY-ONCE guards: the worker claims a
--    row with `UPDATE ... WHERE reminded_at IS NULL RETURNING id` inside the same
--    transaction that writes the notification, so two replicas cannot double-fire.
-- ---------------------------------------------------------------------------
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS reminded_at      TIMESTAMPTZ;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS escalated_at     TIMESTAMPTZ;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS escalation_level INT NOT NULL DEFAULT 0;

-- the reminder sweep's index (pending, due, not yet reminded)
CREATE INDEX IF NOT EXISTS idx_followup_remind ON follow_up(remind_at)
  WHERE status = 'pending' AND reminded_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_followup_escalate ON follow_up(scheduled_at)
  WHERE status = 'pending' AND escalated_at IS NULL AND deleted_at IS NULL;

-- THE ESCALATION POLICY — one editable app_setting row, no deploy.
--   overdue_after_minutes : how long past `scheduled_at` before we escalate
--   reminder_lead_minutes : when remind_at is not set explicitly, remind this long before due
--   actions               : any of notify_owner | notify_manager | flag_lead | reassign_to_manager
INSERT INTO app_setting (key, value) VALUES
  ('escalation_policy', '{"enabled": true, "reminder_lead_minutes": 30, "overdue_after_minutes": 120,
                          "actions": ["notify_owner", "notify_manager", "flag_lead"],
                          "repeat_every_minutes": 0, "max_levels": 1}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- an escalated/at-risk lead is flagged so it is visible in the list, not only in a report
ALTER TABLE lead ADD COLUMN IF NOT EXISTS is_flagged  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS flag_reason VARCHAR(200);

-- ---------------------------------------------------------------------------
-- 4) SLA / TAT — configurable per stage and per pipeline.
--    Most specific policy wins: stage > pipeline > global (pipeline_id IS NULL).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sla_policy (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                 BIGINT NOT NULL REFERENCES organisation(id),
  name                   VARCHAR(160) NOT NULL,
  -- first_response = clock from lead creation to the first human touch
  -- stage_duration = clock while the lead sits in `stage_id`
  metric                 VARCHAR(20) NOT NULL CHECK (metric IN ('first_response','stage_duration')),
  pipeline_id            BIGINT REFERENCES pipeline(id),
  stage_id               BIGINT REFERENCES pipeline_stage(id),
  threshold_minutes      INT NOT NULL CHECK (threshold_minutes > 0),
  -- escalate this long AFTER the breach (0 = notify at the breach itself)
  escalate_after_minutes INT NOT NULL DEFAULT 0,
  notify_manager         BOOLEAN NOT NULL DEFAULT TRUE,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             BIGINT,
  deleted_at             TIMESTAMPTZ,
  deleted_by             BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sla_policy_lookup ON sla_policy(metric, pipeline_id, stage_id)
  WHERE is_active AND deleted_at IS NULL;

-- one CLOCK per (lead, policy, stage). The unique index is what makes starting a
-- clock idempotent — a replayed event can never open a second clock.
CREATE TABLE IF NOT EXISTS lead_sla (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id      BIGINT NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  policy_id    BIGINT NOT NULL REFERENCES sla_policy(id) ON DELETE CASCADE,
  metric       VARCHAR(20) NOT NULL,
  stage_id     BIGINT REFERENCES pipeline_stage(id),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at       TIMESTAMPTZ NOT NULL,
  satisfied_at TIMESTAMPTZ,
  breached_at  TIMESTAMPTZ,
  notified_at  TIMESTAMPTZ,
  elapsed_seconds INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_sla_clock
  ON lead_sla(lead_id, policy_id, COALESCE(stage_id, 0));
CREATE INDEX IF NOT EXISTS idx_lead_sla_due ON lead_sla(due_at)
  WHERE satisfied_at IS NULL AND breached_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_sla_lead ON lead_sla(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_sla_breached ON lead_sla(breached_at) WHERE breached_at IS NOT NULL;

-- TAT per lead PER STAGE — the raw material for the Sprint-6 TAT reports.
CREATE TABLE IF NOT EXISTS lead_stage_tat (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id     BIGINT NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  pipeline_id BIGINT NOT NULL REFERENCES pipeline(id),
  stage_id    BIGINT NOT NULL REFERENCES pipeline_stage(id),
  entered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at   TIMESTAMPTZ,
  seconds     INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tat_lead ON lead_stage_tat(lead_id, entered_at);
CREATE INDEX IF NOT EXISTS idx_tat_stage ON lead_stage_tat(stage_id) WHERE exited_at IS NOT NULL;
-- a lead is in exactly ONE stage at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_tat_open ON lead_stage_tat(lead_id) WHERE exited_at IS NULL;

-- default SLA: first response within 60 minutes, org-wide. Editable / deletable.
INSERT INTO sla_policy (org_id, name, metric, threshold_minutes, escalate_after_minutes)
SELECT o.id, 'First response within 60 minutes', 'first_response', 60, 0
  FROM organisation o
 WHERE NOT EXISTS (SELECT 1 FROM sla_policy);

-- ---------------------------------------------------------------------------
-- 5) CALENDAR — in-app events (meetings / demos). Google & Outlook sync is
--    CONFIG-DRIVEN and degrades cleanly (NotConfiguredException) until the
--    client supplies credentials — same pattern as the Google Sheet channel.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_event (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  branch_id   BIGINT REFERENCES branch(id),
  vertical_id BIGINT REFERENCES vertical(id),
  title       VARCHAR(200) NOT NULL,
  type        VARCHAR(16) NOT NULL DEFAULT 'meeting'
              CHECK (type IN ('meeting','demo','visit','other')),
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ,
  all_day     BOOLEAN NOT NULL DEFAULT FALSE,
  lead_id     BIGINT REFERENCES lead(id) ON DELETE SET NULL,
  owner_id    BIGINT REFERENCES "user"(id),
  -- denormalised so a TEAM-scoped grant has a column to filter on. Without it
  -- ScopeResolver.buildScopeWhere finds no `team` column and (correctly, but
  -- uselessly) denies — a Team Leader would see an empty calendar. Set from the
  -- linked lead's team, else the owner's first team. See CalendarService.
  team_id     BIGINT REFERENCES team(id),
  location    VARCHAR(200),
  notes       TEXT,
  ext_provider VARCHAR(16),
  ext_event_id VARCHAR(200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at  TIMESTAMPTZ,
  deleted_by  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_calendar_range ON calendar_event(starts_at)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_owner ON calendar_event(owner_id, starts_at)
  WHERE deleted_at IS NULL;

-- NOT CONFIGURED until the client pastes credentials in Settings. No deploy needed.
INSERT INTO app_setting (key, value) VALUES
  ('calendar_sync', '{"provider": null, "enabled": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6) WALK-INS & REFERRALS — real capture, feeding the dashboard widgets.
--    Both ALWAYS create a lead through the one LeadIngestionService (so the
--    hierarchy path, dedupe, audit and distribution rules are inherited).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS walk_in (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  vertical_id   BIGINT NOT NULL REFERENCES vertical(id),
  lead_id       BIGINT REFERENCES lead(id) ON DELETE SET NULL,
  visitor_name  VARCHAR(200) NOT NULL,
  phone         VARCHAR(20) NOT NULL,
  email         VARCHAR(255),
  visited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  purpose       VARCHAR(60),
  course_id     BIGINT REFERENCES m_course(id),
  -- ASSIGN ON ADD (Phase-1 scope: "Walk-ins (assign on add)"): the counsellor is
  -- mandatory and becomes the lead's owner immediately — no round-robin wait.
  counsellor_id BIGINT NOT NULL REFERENCES "user"(id),
  status        VARCHAR(12) NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting','in_progress','converted','closed')),
  wait_minutes  INT,
  remarks       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at    TIMESTAMPTZ,
  deleted_by    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_walkin_today ON walk_in(visited_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_walkin_lead ON walk_in(lead_id);
CREATE INDEX IF NOT EXISTS idx_walkin_branch ON walk_in(branch_id, visited_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS referral (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  branch_id       BIGINT NOT NULL REFERENCES branch(id),
  vertical_id     BIGINT NOT NULL REFERENCES vertical(id),
  lead_id         BIGINT REFERENCES lead(id) ON DELETE SET NULL,
  referrer_type   VARCHAR(24) NOT NULL,
  referrer_name   VARCHAR(200) NOT NULL,
  referrer_phone  VARCHAR(20),
  referrer_user_id BIGINT REFERENCES "user"(id),
  referred_name   VARCHAR(200) NOT NULL,
  referred_phone  VARCHAR(20) NOT NULL,
  relationship    VARCHAR(120),
  course_id       BIGINT REFERENCES m_course(id),
  incentive       VARCHAR(120),
  status          VARCHAR(12) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','converted','rewarded','rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at      TIMESTAMPTZ,
  deleted_by      BIGINT
);
CREATE INDEX IF NOT EXISTS idx_referral_lead ON referral(lead_id);
CREATE INDEX IF NOT EXISTS idx_referral_status ON referral(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_referral_branch ON referral(branch_id, created_at DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 7) PERMISSIONS — every new endpoint is behind one of these (catalog-sync).
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('score.read',        'score',        'read'),
  ('score.manage',      'score',        'manage'),
  ('sla.read',          'sla',          'read'),
  ('sla.manage',        'sla',          'manage'),
  ('calendar.read',     'calendar',     'read'),
  ('calendar.create',   'calendar',     'create'),
  ('calendar.update',   'calendar',     'update'),
  ('calendar.delete',   'calendar',     'delete'),
  ('notification.read', 'notification', 'read'),
  ('walkin.read',       'walkin',       'read'),
  ('walkin.create',     'walkin',       'create'),
  ('walkin.update',     'walkin',       'update'),
  ('walkin.delete',     'walkin',       'delete'),
  ('referral.read',     'referral',     'read'),
  ('referral.create',   'referral',     'create'),
  ('referral.update',   'referral',     'update'),
  ('referral.delete',   'referral',     'delete')
ON CONFLICT (key) DO NOTHING;

-- Grants. Record scope is never wider than the role's own LEAD scope, so a
-- Counsellor's dashboard/calendar/walk-in lists resolve to their own records —
-- the SQL cannot return branch numbers to them.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('notification.read', 'Super Admin',        'own'),
      ('notification.read', 'Organization Admin', 'own'),
      ('notification.read', 'Branch Manager',     'own'),
      ('notification.read', 'Vertical Manager',   'own'),
      ('notification.read', 'Team Leader',        'own'),
      ('notification.read', 'Counsellor',         'own'),
      ('notification.read', 'Telecaller',         'own'),
      ('notification.read', 'Marketing Manager',  'own'),

      ('score.read',   'Super Admin',        'all'),
      ('score.read',   'Organization Admin', 'all'),
      ('score.read',   'Branch Manager',     'branch'),
      ('score.read',   'Vertical Manager',   'vertical'),
      ('score.read',   'Team Leader',        'team'),
      ('score.read',   'Counsellor',         'own'),
      ('score.read',   'Telecaller',         'own'),
      ('score.read',   'Marketing Manager',  'all'),
      ('score.manage', 'Super Admin',        'all'),
      ('score.manage', 'Organization Admin', 'all'),

      ('sla.read',   'Super Admin',        'all'),
      ('sla.read',   'Organization Admin', 'all'),
      ('sla.read',   'Branch Manager',     'branch'),
      ('sla.read',   'Vertical Manager',   'vertical'),
      ('sla.read',   'Team Leader',        'team'),
      ('sla.read',   'Counsellor',         'own'),
      ('sla.read',   'Telecaller',         'own'),
      ('sla.manage', 'Super Admin',        'all'),
      ('sla.manage', 'Organization Admin', 'all'),

      ('calendar.read',   'Super Admin',        'all'),
      ('calendar.read',   'Organization Admin', 'all'),
      ('calendar.read',   'Branch Manager',     'branch'),
      ('calendar.read',   'Vertical Manager',   'vertical'),
      ('calendar.read',   'Team Leader',        'team'),
      ('calendar.read',   'Counsellor',         'own'),
      ('calendar.read',   'Telecaller',         'own'),
      ('calendar.create', 'Super Admin',        'all'),
      ('calendar.create', 'Organization Admin', 'all'),
      ('calendar.create', 'Branch Manager',     'branch'),
      ('calendar.create', 'Vertical Manager',   'vertical'),
      ('calendar.create', 'Team Leader',        'team'),
      ('calendar.create', 'Counsellor',         'own'),
      ('calendar.create', 'Telecaller',         'own'),
      ('calendar.update', 'Super Admin',        'all'),
      ('calendar.update', 'Organization Admin', 'all'),
      ('calendar.update', 'Branch Manager',     'branch'),
      ('calendar.update', 'Vertical Manager',   'vertical'),
      ('calendar.update', 'Team Leader',        'team'),
      ('calendar.update', 'Counsellor',         'own'),
      ('calendar.update', 'Telecaller',         'own'),
      ('calendar.delete', 'Super Admin',        'all'),
      ('calendar.delete', 'Organization Admin', 'all'),
      ('calendar.delete', 'Branch Manager',     'branch'),

      ('walkin.read',   'Super Admin',        'all'),
      ('walkin.read',   'Organization Admin', 'all'),
      ('walkin.read',   'Branch Manager',     'branch'),
      ('walkin.read',   'Vertical Manager',   'vertical'),
      ('walkin.read',   'Team Leader',        'team'),
      ('walkin.read',   'Counsellor',         'own'),
      ('walkin.read',   'Telecaller',         'own'),
      ('walkin.create', 'Super Admin',        'all'),
      ('walkin.create', 'Organization Admin', 'all'),
      ('walkin.create', 'Branch Manager',     'branch'),
      ('walkin.create', 'Vertical Manager',   'vertical'),
      ('walkin.create', 'Team Leader',        'team'),
      ('walkin.create', 'Counsellor',         'own'),
      ('walkin.create', 'Telecaller',         'own'),
      ('walkin.update', 'Super Admin',        'all'),
      ('walkin.update', 'Organization Admin', 'all'),
      ('walkin.update', 'Branch Manager',     'branch'),
      ('walkin.update', 'Vertical Manager',   'vertical'),
      ('walkin.update', 'Team Leader',        'team'),
      ('walkin.update', 'Counsellor',         'own'),
      ('walkin.delete', 'Super Admin',        'all'),
      ('walkin.delete', 'Organization Admin', 'all'),
      ('walkin.delete', 'Branch Manager',     'branch'),

      ('referral.read',   'Super Admin',        'all'),
      ('referral.read',   'Organization Admin', 'all'),
      ('referral.read',   'Branch Manager',     'branch'),
      ('referral.read',   'Vertical Manager',   'vertical'),
      ('referral.read',   'Team Leader',        'team'),
      ('referral.read',   'Counsellor',         'own'),
      ('referral.read',   'Telecaller',         'own'),
      ('referral.read',   'Marketing Manager',  'all'),
      ('referral.create', 'Super Admin',        'all'),
      ('referral.create', 'Organization Admin', 'all'),
      ('referral.create', 'Branch Manager',     'branch'),
      ('referral.create', 'Vertical Manager',   'vertical'),
      ('referral.create', 'Team Leader',        'team'),
      ('referral.create', 'Counsellor',         'own'),
      ('referral.create', 'Telecaller',         'own'),
      ('referral.update', 'Super Admin',        'all'),
      ('referral.update', 'Organization Admin', 'all'),
      ('referral.update', 'Branch Manager',     'branch'),
      ('referral.update', 'Vertical Manager',   'vertical'),
      ('referral.update', 'Team Leader',        'team'),
      ('referral.update', 'Counsellor',         'own'),
      ('referral.delete', 'Super Admin',        'all'),
      ('referral.delete', 'Organization Admin', 'all'),
      ('referral.delete', 'Branch Manager',     'branch')
    ) AS t(perm_key, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
      SELECT ro.id, p.id, r.scope
        FROM role ro JOIN permission p ON p.key = r.perm_key
       WHERE ro.name = r.role_name AND ro.is_system
      ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 8) audit_log.action must accept the new mutating actions
-- ---------------------------------------------------------------------------
-- Same constraint NAME and the same full list as 022 (006 -> 015 -> 019 -> 022),
-- plus 'escalate' (overdue escalation) and 'sla_breach'. Dropping it by name and
-- re-adding it is the established pattern; omitting an existing value here would
-- silently break merges/hand-outs, so the list is a strict SUPERSET of 022's.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_action_check
  CHECK (action IN ('create','update','delete','login','export','transfer',
                    'permission_change','merge','restore','handout',
                    'escalate','sla_breach'));

-- ---------------------------------------------------------------------------
-- 9) BACKFILL — open the TAT clock for leads that already sit in a stage, so the
--    Sprint-6 TAT report is not blind to the leads that existed before today.
--    (No SLA clocks are back-dated: a policy cannot be breached retroactively by
--    a lead nobody was told to respond to. New leads start clean.)
-- ---------------------------------------------------------------------------
INSERT INTO lead_stage_tat (lead_id, pipeline_id, stage_id, entered_at)
SELECT l.id, l.pipeline_id, l.stage_id, COALESCE(l.last_activity_at, l.created_at)
  FROM lead l
 WHERE l.stage_id IS NOT NULL AND l.deleted_at IS NULL AND l.is_active
   AND NOT EXISTS (SELECT 1 FROM lead_stage_tat t WHERE t.lead_id = l.id AND t.exited_at IS NULL)
ON CONFLICT DO NOTHING;
