-- 004: custom field definitions (values live in owning row's custom_fields JSONB)

CREATE TABLE custom_field_def (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            BIGINT NOT NULL REFERENCES organisation(id),
  scope_branch_id   BIGINT NULL REFERENCES branch(id),    -- per branch and/or vertical
  scope_vertical_id BIGINT NULL REFERENCES vertical(id),
  entity            VARCHAR(30) NOT NULL DEFAULT 'lead',  -- lead | student | ...
  field_key         VARCHAR(60) NOT NULL,
  label             VARCHAR(160) NOT NULL,
  data_type         VARCHAR(15) NOT NULL
                    CHECK (data_type IN ('text','number','date','bool','select','multiselect')),
  options           JSONB NULL,          -- for select types (static list)
  master_ref        VARCHAR(40) NULL,    -- or bind dropdown to a master table (e.g. 'm_course')
  required          BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order        INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        BIGINT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (org_id, entity, scope_vertical_id, field_key)
);
