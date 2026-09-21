-- ============================================================================
-- 120 — FACEBOOK FORM MAPPING (Page Monitor + Form Mapping, client Sep 2026)
--
-- One row per Lead Ad FORM on a Meta capture channel: which CRM field each of the
-- form's questions feeds, and whether the form is enabled at all.
--
--   · field_map  — { "<question key>": "<crm target>" }. Overlaid ON TOP of the
--                  channel-level config.field_map at ingestion (form-level wins).
--                  Targets are the ones providers.ts accepts (CHANNEL_TARGETS,
--                  _first/_last, cf:<custom field key>).
--   · is_enabled — FALSE: deliveries for this form are logged as `skipped`
--                  ("form disabled in mapping") and create no lead.
--   · questions  — the form's question list as last read from the Graph API
--                  (cache only — lets the mapping editor open without a Graph call).
--
-- Page tokens are NOT stored here: they stay AES-GCM encrypted in
-- capture_channel.secrets (page_token_<page_id>). Leads still land in the channel's
-- own campaign + source — a capture channel is bound to exactly one target path.
--
-- Additive and idempotent (IF NOT EXISTS). No existing data touched.
-- ============================================================================
CREATE TABLE IF NOT EXISTS fb_form_mapping (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  channel_id  BIGINT NOT NULL REFERENCES capture_channel(id) ON DELETE CASCADE,
  page_id     VARCHAR(64) NOT NULL DEFAULT '',
  form_id     VARCHAR(64) NOT NULL,
  form_name   VARCHAR(255),
  is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  field_map   JSONB NOT NULL DEFAULT '{}',
  questions   JSONB,
  updated_by  BIGINT REFERENCES "user"(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, form_id)
);
CREATE INDEX IF NOT EXISTS idx_fb_form_mapping_page ON fb_form_mapping(channel_id, page_id);
