-- =============================================================================
-- 038 — CROSS-SELL (CRM-level, working on the leads/enrolments that exist today)
--
-- Replaces the design-only "Cross-Sell engine (Phase 2)" shell with a real,
-- working, RBAC-scoped, audited module. It suggests ADDITIONAL courses to
-- existing converted contacts (a won lead or an enrolled lead) based on their
-- current course + the Course master, and lets a user act on the suggestion.
--
-- No student-academics dependency (that is Phase 2). Candidates are computed
-- from leads + enrolments that exist now; suggestions come from the Course
-- master, optionally narrowed by an admin-managed rule map.
--
--   1) cross_sell_rule     admin-managed mapping "current course X -> suggest
--                          course Y". If ANY rule matches a contact's current
--                          course, the rule targets are used; otherwise the
--                          fallback is other active courses in the same vertical.
--                          Soft-deletable, audited. Managed under CRM > Cross-Sell
--                          (crosssell.manage).
--   2) cross_sell_attempt  the log of an acted-on suggestion. One row per
--                          (lead, suggested course). Records which action was
--                          taken (create a follow-up, create a new lead, or
--                          dismiss), links the created follow_up/lead, and — via a
--                          UNIQUE index on (lead_id, suggested_course_id) among
--                          live rows — guarantees the same pair is NEVER suggested
--                          again (the candidate drops off the list).
--
-- lead_activity.type gains 'cross_sell' so every attempt shows on the lead's
-- timeline.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING). Safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) cross_sell_rule — "current course -> suggested course" (admin-managed)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cross_sell_rule (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            BIGINT NOT NULL REFERENCES organisation(id),
  source_course_id  BIGINT NOT NULL REFERENCES m_course(id),
  target_course_id  BIGINT NOT NULL REFERENCES m_course(id),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  note              TEXT NULL,
  created_by        BIGINT NULL REFERENCES "user"(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ NULL,
  deleted_by        BIGINT NULL REFERENCES "user"(id),
  -- a rule that suggests the course you already have is nonsense
  CONSTRAINT cross_sell_rule_distinct CHECK (source_course_id <> target_course_id)
);
-- one live rule per (org, source, target) — re-adding the same mapping is a no-op
CREATE UNIQUE INDEX IF NOT EXISTS uq_cross_sell_rule_active
  ON cross_sell_rule (org_id, source_course_id, target_course_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_cross_sell_rule_source
  ON cross_sell_rule (source_course_id) WHERE deleted_at IS NULL AND is_active;

-- ---------------------------------------------------------------------------
-- 2) cross_sell_attempt — the acted-on suggestion log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cross_sell_attempt (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id               BIGINT NOT NULL REFERENCES organisation(id),
  lead_id              BIGINT NOT NULL REFERENCES lead(id),
  from_course_id       BIGINT NULL REFERENCES m_course(id),
  suggested_course_id  BIGINT NOT NULL REFERENCES m_course(id),
  branch_id            BIGINT NULL REFERENCES branch(id),
  vertical_id          BIGINT NULL REFERENCES vertical(id),
  owner_id             BIGINT NULL REFERENCES "user"(id),
  action               VARCHAR(16) NOT NULL
                         CHECK (action IN ('followup', 'lead', 'dismissed')),
  status               VARCHAR(16) NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'dismissed', 'converted')),
  follow_up_id         BIGINT NULL REFERENCES follow_up(id),
  new_lead_id          BIGINT NULL REFERENCES lead(id),
  note                 TEXT NULL,
  created_by           BIGINT NULL REFERENCES "user"(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ NULL,
  deleted_by           BIGINT NULL REFERENCES "user"(id)
);
-- THE de-dupe guarantee: one live attempt per (lead, suggested course) — a contact
-- that has been acted on for a course is never suggested that course again.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cross_sell_attempt_pair
  ON cross_sell_attempt (lead_id, suggested_course_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_cross_sell_attempt_lead    ON cross_sell_attempt (lead_id)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_cross_sell_attempt_created ON cross_sell_attempt (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_cross_sell_attempt_scope   ON cross_sell_attempt (branch_id, vertical_id, owner_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3) lead_activity.type must accept 'cross_sell' (timeline event).
--     Same story as 023 (disposition): the CHECK is enumerated, so a new verb
--     needs its migration or the INSERT is refused.
-- ---------------------------------------------------------------------------
ALTER TABLE lead_activity DROP CONSTRAINT IF EXISTS lead_activity_type_check;
ALTER TABLE lead_activity ADD  CONSTRAINT lead_activity_type_check
  CHECK (type IN ('create','stage_change','status_change','assign','follow_up','note',
                  'message','call_log','field_change','merge','transfer','disposition','cross_sell'));

-- ---------------------------------------------------------------------------
-- 4) Permissions — the crosssell.* module + role grants.
--     read = view candidates / attempts (per scope); act = create a follow-up /
--     a new lead / dismiss a suggestion (a counsellor acts on his own contacts);
--     manage = maintain the rule map (admin).
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('crosssell.read',   'crosssell', 'read'),
  ('crosssell.act',    'crosssell', 'act'),
  ('crosssell.manage', 'crosssell', 'manage')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('crosssell.read',   'Super Admin',        'all'),
      ('crosssell.read',   'Organization Admin', 'all'),
      ('crosssell.read',   'Marketing Manager',  'all'),
      ('crosssell.read',   'Branch Manager',     'branch'),
      ('crosssell.read',   'Vertical Manager',   'vertical'),
      ('crosssell.read',   'Team Leader',        'team'),
      ('crosssell.read',   'Counsellor',         'own'),
      ('crosssell.read',   'Telecaller',         'own'),
      ('crosssell.act',    'Super Admin',        'all'),
      ('crosssell.act',    'Organization Admin', 'all'),
      ('crosssell.act',    'Marketing Manager',  'all'),
      ('crosssell.act',    'Branch Manager',     'branch'),
      ('crosssell.act',    'Vertical Manager',   'vertical'),
      ('crosssell.act',    'Team Leader',        'team'),
      ('crosssell.act',    'Counsellor',         'own'),
      ('crosssell.act',    'Telecaller',         'own'),
      ('crosssell.manage', 'Super Admin',        'all'),
      ('crosssell.manage', 'Organization Admin', 'all'),
      ('crosssell.manage', 'Marketing Manager',  'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
