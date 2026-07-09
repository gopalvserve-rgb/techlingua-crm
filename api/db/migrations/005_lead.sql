-- 005: lead + lead_tag + lead_activity + follow_up (schema only in Sprint 1; APIs land in Sprint 2)
-- NOTE: partitioning (lead by branch hash, activity by month) is deferred to Sprint 2
-- when the ingestion worker lands — documented in docs/dev/02-sprint1-implementation.md.

CREATE TABLE lead (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            BIGINT NOT NULL REFERENCES organisation(id),
  -- full path, all NOT NULL (every level is mandatory on every lead)
  branch_id         BIGINT NOT NULL REFERENCES branch(id),
  vertical_id       BIGINT NOT NULL REFERENCES vertical(id),
  pipeline_id       BIGINT NOT NULL REFERENCES pipeline(id),
  campaign_id       BIGINT NOT NULL REFERENCES campaign(id),
  source_id         BIGINT NOT NULL REFERENCES source(id),
  full_name         VARCHAR(200) NOT NULL,
  phone             VARCHAR(20)  NOT NULL,
  email             VARCHAR(255),
  alt_phone         VARCHAR(20),
  status_id         BIGINT REFERENCES m_status(id),
  stage_id          BIGINT REFERENCES pipeline_stage(id),
  priority          VARCHAR(6) NOT NULL DEFAULT 'med' CHECK (priority IN ('low','med','high')),
  temperature       VARCHAR(6) CHECK (temperature IN ('hot','warm','cold')),
  score             INT NOT NULL DEFAULT 0,
  owner_id          BIGINT REFERENCES "user"(id),
  team_id           BIGINT REFERENCES team(id),
  next_follow_up_at TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ,
  is_duplicate      BOOLEAN NOT NULL DEFAULT FALSE,
  merged_into_id    BIGINT REFERENCES lead(id),
  -- denormalised master FK dropdowns
  state_id          BIGINT REFERENCES state(id),
  city_id           BIGINT REFERENCES city(id),
  course_id         BIGINT REFERENCES m_course(id),
  qualification_id  BIGINT REFERENCES m_qualification(id),
  budget_id         BIGINT REFERENCES m_budget(id),
  consent           JSONB NOT NULL DEFAULT '{}',   -- DPDP consent capture
  custom_fields     JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        BIGINT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE
);

-- indexing per core-data-model §8
CREATE INDEX idx_lead_path       ON lead(branch_id, vertical_id, pipeline_id);
CREATE INDEX idx_lead_owner_fu   ON lead(owner_id, next_follow_up_at);
CREATE INDEX idx_lead_stage      ON lead(stage_id);
CREATE INDEX idx_lead_phone      ON lead(phone);           -- dedup key
CREATE INDEX idx_lead_campaign   ON lead(campaign_id);
CREATE INDEX idx_lead_custom_gin ON lead USING GIN (custom_fields);

CREATE TABLE lead_tag (
  lead_id BIGINT NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  tag_id  BIGINT NOT NULL REFERENCES m_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);

-- immutable lead-facing history/timeline (transfers, merges, stage moves, SLA/TAT source)
CREATE TABLE lead_activity (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id     BIGINT NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  branch_id   BIGINT NOT NULL REFERENCES branch(id),   -- carried for partition/scope
  actor_id    BIGINT REFERENCES "user"(id),
  type        VARCHAR(16) NOT NULL
              CHECK (type IN ('create','stage_change','status_change','assign','follow_up',
                              'note','message','call_log','field_change','merge','transfer')),
  from_value  JSONB,
  to_value    JSONB,
  note        TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_lead ON lead_activity(lead_id, occurred_at);

CREATE TABLE follow_up (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id        BIGINT NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  owner_id       BIGINT NOT NULL REFERENCES "user"(id),
  type_id        BIGINT REFERENCES m_followup_type(id),
  disposition_id BIGINT REFERENCES m_disposition(id),
  scheduled_at   TIMESTAMPTZ NOT NULL,
  completed_at   TIMESTAMPTZ,
  status         VARCHAR(8) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','overdue')),
  remind_at      TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_followup_owner ON follow_up(owner_id, status, scheduled_at);  -- today/overdue queries
