-- 003: RBAC — user, role, permission, role_permission, user_assignment, team, team_member
-- A user has MANY user_assignment rows -> multi-unit, multi-role. The policy layer
-- unions a user's assignments and injects scope filters into every query (§4 of core data model).

CREATE TABLE "user" (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  name          VARCHAR(160) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  phone         VARCHAR(20),
  password_hash VARCHAR(100),
  sso_subject   VARCHAR(255),                 -- SSO stub (Google/Microsoft later)
  mfa_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  status        VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE role (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  name        VARCHAR(120) NOT NULL,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,   -- seeded roles; not deletable
  is_custom   BOOLEAN NOT NULL DEFAULT FALSE,   -- admin-composed custom roles
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (org_id, name)
);

-- permission catalog, e.g. key='lead.update', module='lead', action='update'
CREATE TABLE permission (
  id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key    VARCHAR(80) NOT NULL UNIQUE,
  module VARCHAR(40) NOT NULL,
  action VARCHAR(40) NOT NULL
);

CREATE TABLE role_permission (
  role_id       BIGINT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  -- field-level scoping: { "allow": ["field_key", ...] } or { "deny": [...] }; NULL = all fields
  field_scope   JSONB NULL,
  -- record-level scoping
  record_scope  VARCHAR(10) NOT NULL DEFAULT 'own'
                CHECK (record_scope IN ('own','team','branch','vertical','pipeline','campaign','all')),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE team (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  branch_id   BIGINT REFERENCES branch(id),
  vertical_id BIGINT REFERENCES vertical(id),
  name        VARCHAR(160) NOT NULL,
  leader_id   BIGINT REFERENCES "user"(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE team_member (
  team_id BIGINT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

-- the unit this grant applies to; NULL columns mean "not narrowed at that level"
-- (an assignment with all unit columns NULL = org-wide grant of that role)
CREATE TABLE user_assignment (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role_id     BIGINT NOT NULL REFERENCES role(id),
  branch_id   BIGINT NULL REFERENCES branch(id),
  vertical_id BIGINT NULL REFERENCES vertical(id),
  pipeline_id BIGINT NULL REFERENCES pipeline(id),
  campaign_id BIGINT NULL REFERENCES campaign(id),
  team_id     BIGINT NULL REFERENCES team(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_assignment_user ON user_assignment(user_id) WHERE is_active;
CREATE INDEX idx_assignment_role ON user_assignment(role_id);
