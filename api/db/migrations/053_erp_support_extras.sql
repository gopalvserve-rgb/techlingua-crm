-- =============================================================================
-- 053 — ERP SUPPORT EXTRAS (Phase 2, Batch 7 — the last Phase-2 support items)
--
-- Two ORG-WIDE staff-facing content libraries that sit under Help & Support:
--   1) TRAINING VIDEO — a library of training / how-to videos for staff (title,
--      description, category, video URL/embed, thumbnail, tags, sort order, active).
--      A grid/list staff browse + play. Reuses the study-material "video" idea, but is
--      an org-wide staff resource (NOT per-student / per-batch), so no branch scope.
--   2) RELEASE NOTE — an in-app changelog: version / date, title, notes (what changed),
--      category (feature / fix / improvement). Admin creates entries; ALL users read a
--      "What's New / Release Notes" screen backed by this data (the static What's-New
--      panel from Batch 27 is merged onto it).
--
-- Both are org-wide masters: guarded by @RequirePermission only (no record scope). RBAC
-- keys training.* (view / manage) and release_note.* (view / manage). Idempotent
-- (IF NOT EXISTS / ON CONFLICT). Re-runnable.
-- =============================================================================

-- 1) training_video -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS training_video (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  title          VARCHAR(200) NOT NULL,
  description    TEXT NULL,
  category       VARCHAR(80) NULL,
  video_url      VARCHAR(1000) NOT NULL,
  thumbnail_url  VARCHAR(1000) NULL,
  tags           VARCHAR(300) NULL,
  sort_order     INT NOT NULL DEFAULT 0,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_training_video_active ON training_video (active, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_training_video_cat    ON training_video (category) WHERE deleted_at IS NULL;

-- 2) release_note -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS release_note (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  version        VARCHAR(40) NULL,
  release_date   DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  title          VARCHAR(200) NOT NULL,
  notes          TEXT NULL,
  category       VARCHAR(16) NOT NULL DEFAULT 'feature'
                   CHECK (category IN ('feature', 'fix', 'improvement')),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_release_note_feed ON release_note (active, release_date DESC) WHERE deleted_at IS NULL;

-- 3) Permissions --------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('training.view',        'training',     'view'),
  ('training.manage',      'training',     'manage'),
  ('release_note.view',    'release_note', 'view'),
  ('release_note.manage',  'release_note', 'manage')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('training.view',       'Super Admin',        'all'),
      ('training.view',       'Organization Admin', 'all'),
      ('training.view',       'Branch Manager',     'all'),
      ('training.view',       'Vertical Manager',   'all'),
      ('training.view',       'Team Leader',        'all'),
      ('training.view',       'Counsellor',         'all'),
      ('release_note.view',   'Super Admin',        'all'),
      ('release_note.view',   'Organization Admin', 'all'),
      ('release_note.view',   'Branch Manager',     'all'),
      ('release_note.view',   'Vertical Manager',   'all'),
      ('release_note.view',   'Team Leader',        'all'),
      ('release_note.view',   'Counsellor',         'all'),
      ('training.manage',     'Super Admin',        'all'),
      ('training.manage',     'Organization Admin', 'all'),
      ('release_note.manage', 'Super Admin',        'all'),
      ('release_note.manage', 'Organization Admin', 'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
