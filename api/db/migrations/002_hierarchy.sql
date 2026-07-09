-- 002: hierarchy — Org > Branch > Vertical > Pipeline (+stages) > Campaign > Source
-- Each child holds the FULL ancestor chain as FKs (denormalised) so any level
-- filters/reports without recursive joins (docs/dev/01-core-data-model.md §1).

CREATE TABLE branch (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  name        VARCHAR(160) NOT NULL,
  code        VARCHAR(40)  NOT NULL,
  state_id    BIGINT REFERENCES state(id),
  city_id     BIGINT REFERENCES city(id),
  address     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (org_id, code)
);

-- vertical = brand per branch; carries per-vertical SMTP + payment gateway config
-- (secret VALUES live in the secrets manager; these JSONB columns store refs/non-secret config)
CREATE TABLE vertical (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  branch_id      BIGINT NOT NULL REFERENCES branch(id),
  name           VARCHAR(160) NOT NULL,
  code           VARCHAR(40)  NOT NULL,
  smtp_config    JSONB NOT NULL DEFAULT '{}',
  gateway_config JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (branch_id, code)
);

-- multiple pipelines per vertical, each with its own stage set
CREATE TABLE pipeline (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  branch_id   BIGINT NOT NULL REFERENCES branch(id),
  vertical_id BIGINT NOT NULL REFERENCES vertical(id),
  name        VARCHAR(160) NOT NULL,
  code        VARCHAR(40)  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (vertical_id, code)
);

CREATE TABLE pipeline_stage (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pipeline_id BIGINT NOT NULL REFERENCES pipeline(id) ON DELETE CASCADE,
  name        VARCHAR(120) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  stage_type  VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (stage_type IN ('open','won','lost')),
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_stage_pipeline ON pipeline_stage(pipeline_id, sort_order);

-- campaign name may repeat across pipelines; distribution + duplicacy per NeoDove (PROJECT_DOC §4)
CREATE TABLE campaign (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL REFERENCES organisation(id),
  branch_id           BIGINT NOT NULL REFERENCES branch(id),
  vertical_id         BIGINT NOT NULL REFERENCES vertical(id),
  pipeline_id         BIGINT NOT NULL REFERENCES pipeline(id),
  name                VARCHAR(160) NOT NULL,
  utm                 JSONB NOT NULL DEFAULT '{}',
  cost                NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- { mode: on_demand|equal|conditional, batch_size, agent_user_ids[], round_robin_scope, conditions[] }
  distribution_config JSONB NOT NULL DEFAULT '{"mode":"on_demand","batch_size":10}',
  -- { check_scope: this_campaign|this_pipeline|global, match_key: phone,
  --   on_duplicate: ignore|merge|create|merge_and_reopen, open_reassign_same_user: true }
  duplicacy_config    JSONB NOT NULL DEFAULT '{"check_scope":"this_campaign","match_key":"phone","on_duplicate":"ignore","open_reassign_same_user":true}',
  priority            VARCHAR(6) NOT NULL DEFAULT 'med' CHECK (priority IN ('low','med','high')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          BIGINT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_campaign_path ON campaign(branch_id, vertical_id, pipeline_id);

CREATE TABLE source (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL REFERENCES organisation(id),
  branch_id        BIGINT NOT NULL REFERENCES branch(id),
  vertical_id      BIGINT NOT NULL REFERENCES vertical(id),
  pipeline_id      BIGINT NOT NULL REFERENCES pipeline(id),
  campaign_id      BIGINT NOT NULL REFERENCES campaign(id),
  master_source_id BIGINT REFERENCES m_source(id),
  name             VARCHAR(160) NOT NULL,
  channel          VARCHAR(16) NOT NULL DEFAULT 'manual'
                   CHECK (channel IN ('meta','google','justdial','indiamart','form','sheet','webhook','walkin','referral','manual')),
  webhook_token    VARCHAR(80) UNIQUE,        -- secret used by inbound webhooks (Sprint 2)
  config           JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_source_path ON source(branch_id, vertical_id, pipeline_id, campaign_id);

-- round-robin cursor state for Equal distribution (avoids race conditions; worker-owned)
CREATE TABLE campaign_distribution_state (
  campaign_id    BIGINT PRIMARY KEY REFERENCES campaign(id) ON DELETE CASCADE,
  last_agent_idx INT NOT NULL DEFAULT -1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
