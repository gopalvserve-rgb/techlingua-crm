-- =============================================================================
-- 136 — CROSS-SELL as per the client's 12 Nov 2026 mockup
--
-- "Keep the Cross-Sell module connected to Student & Academic Administration, but maintain
--  opportunities, attempts and recommendations as separate records. This will let you track
--  additional sales without disturbing existing admissions, student profiles or fee records."
--
--   cross_sell_opportunity          an additional sale being worked: contact (lead / student),
--                                   current → recommended course, type, value, owner, stage
--                                   (8 stages), next follow-up. "Converted" is set ONLY when a
--                                   real enrolment for that course exists (normal Sale Closure),
--                                   so additional revenue = the enrolment's net fee.
--   cross_sell_opportunity_history  every stage move (who / when / note) — the pipeline report
--   cross_sell_campaign             an offer to a group of students: course, audience, WhatsApp
--                                   template, how many were notified / became opportunities
--   cross_sell_rule (+type, +weight) the admin rule map now says what KIND of sale it is and
--                                   how strong the match is (feeds the match %).
--   cross_sell_attempt              unchanged (the suggestion action log).
--
-- Existing masters only (m_course, lead, student, user, branch, vertical, follow_up,
-- message templates) and the existing crosssell.read / act / manage permissions.
-- Idempotent.
-- =============================================================================

ALTER TABLE cross_sell_rule ADD COLUMN IF NOT EXISTS sale_type VARCHAR(16) NOT NULL DEFAULT 'cross_sell';
ALTER TABLE cross_sell_rule ADD COLUMN IF NOT EXISTS weight    INT         NOT NULL DEFAULT 85;
DO $$ BEGIN
  ALTER TABLE cross_sell_rule ADD CONSTRAINT cross_sell_rule_type_chk
    CHECK (sale_type IN ('cross_sell', 'upsell', 'downsell', 'cross_vertical'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE cross_sell_rule ADD CONSTRAINT cross_sell_rule_weight_chk CHECK (weight BETWEEN 1 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS cross_sell_campaign (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL REFERENCES organisation(id),
  name                VARCHAR(160) NOT NULL,
  course_id           BIGINT NOT NULL REFERENCES m_course(id),
  from_course_id      BIGINT NULL REFERENCES m_course(id),
  sale_type           VARCHAR(16) NOT NULL DEFAULT 'cross_sell'
                        CHECK (sale_type IN ('cross_sell', 'upsell', 'downsell', 'cross_vertical')),
  branch_id           BIGINT NULL REFERENCES branch(id),
  vertical_id         BIGINT NULL REFERENCES vertical(id),
  template_id         BIGINT NULL,                -- WhatsApp / SMS / email template (message templates)
  audience            JSONB NOT NULL DEFAULT '{}',-- { lead_ids: [...] } as picked when it was sent
  status              VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  audience_count      INT NOT NULL DEFAULT 0,
  notified_count      INT NOT NULL DEFAULT 0,
  opportunities_count INT NOT NULL DEFAULT 0,
  note                TEXT NULL,
  sent_at             TIMESTAMPTZ NULL,
  created_by          BIGINT NULL REFERENCES "user"(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ NULL,
  deleted_by          BIGINT NULL REFERENCES "user"(id)
);

CREATE TABLE IF NOT EXISTS cross_sell_opportunity (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                BIGINT NOT NULL REFERENCES organisation(id),
  lead_id               BIGINT NOT NULL REFERENCES lead(id),
  student_id            BIGINT NULL REFERENCES student(id),
  from_course_id        BIGINT NULL REFERENCES m_course(id),
  course_id             BIGINT NOT NULL REFERENCES m_course(id),
  sale_type             VARCHAR(16) NOT NULL DEFAULT 'cross_sell'
                          CHECK (sale_type IN ('cross_sell', 'upsell', 'downsell', 'cross_vertical')),
  stage                 VARCHAR(16) NOT NULL DEFAULT 'new'
                          CHECK (stage IN ('new', 'assigned', 'contacted', 'interested', 'quotation_sent',
                                           'negotiation', 'converted', 'lost')),
  value_minor           BIGINT NOT NULL DEFAULT 0,      -- expected value (paise)
  converted_value_minor BIGINT NULL,                    -- the enrolment's net fee once converted
  match_pct             INT NULL,
  source                VARCHAR(16) NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('manual', 'recommendation', 'campaign')),
  campaign_id           BIGINT NULL REFERENCES cross_sell_campaign(id),
  owner_id              BIGINT NULL REFERENCES "user"(id),
  branch_id             BIGINT NULL REFERENCES branch(id),
  vertical_id           BIGINT NULL REFERENCES vertical(id),
  team_id               BIGINT NULL,
  pipeline_id           BIGINT NULL,
  lead_campaign_id      BIGINT NULL,                    -- the contact's own campaign (RBAC path)
  next_follow_up_at     TIMESTAMPTZ NULL,
  follow_up_id          BIGINT NULL REFERENCES follow_up(id),
  quotation_id          BIGINT NULL,
  enrolment_id          BIGINT NULL REFERENCES enrolment(id),
  lost_reason           TEXT NULL,
  note                  TEXT NULL,
  stage_changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted_at          TIMESTAMPTZ NULL,
  created_by            BIGINT NULL REFERENCES "user"(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ NULL,
  deleted_by            BIGINT NULL REFERENCES "user"(id)
);
-- one OPEN opportunity per (contact, course); a lost one may be re-opened as a new record
CREATE UNIQUE INDEX IF NOT EXISTS uq_cs_opp_open
  ON cross_sell_opportunity (lead_id, course_id)
  WHERE deleted_at IS NULL AND stage NOT IN ('converted', 'lost');
CREATE INDEX IF NOT EXISTS ix_cs_opp_stage   ON cross_sell_opportunity (stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_cs_opp_created ON cross_sell_opportunity (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_cs_opp_scope   ON cross_sell_opportunity (branch_id, vertical_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_cs_opp_lead    ON cross_sell_opportunity (lead_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS cross_sell_opportunity_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id  BIGINT NOT NULL REFERENCES cross_sell_opportunity(id) ON DELETE CASCADE,
  from_stage      VARCHAR(16) NULL,
  to_stage        VARCHAR(16) NOT NULL,
  actor_id        BIGINT NULL REFERENCES "user"(id),
  note            TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_cs_opp_hist ON cross_sell_opportunity_history (opportunity_id, created_at);
