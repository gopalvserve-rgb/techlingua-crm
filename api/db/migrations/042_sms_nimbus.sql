-- 042 — SMS via the Nimbus IT gateway (client request, Aug 2026)
--
-- Two things live here:
--   A) sms_template — an admin-managed, Branch+Vertical-scoped SMS Template list,
--      exactly the model in the client's screenshot: Header (the DLT sender/header,
--      e.g. BRTISC / INSTAI), Template name, the DLT-approved body carrying ordered
--      {#var#} markers, Branch, Vertical, the per-template DLT Template ID and an
--      active toggle. This is DISTINCT from message_template (the {{merge-var}} dynamic
--      templates): a DLT SMS body must be sent VERBATIM with only its {#var#} markers
--      filled, or the gateway rejects it — so it gets its own, deliberately rigid model.
--
--   B) an idempotency backstop for the auto-send-on-new-lead: a lead may only ever get
--      ONE creation SMS. The creation send carries dedupe_key = 'sms_creation:<lead_id>';
--      a partial UNIQUE index makes a second one impossible even under a double-fire.
--
-- The Nimbus provider config (user, authkey [encrypted], entityid, base url, sender/header
-- default) is stored in the existing channel_config table — no DDL needed, exactly as the
-- Settings framework was built to allow (channel_config.channel is an unconstrained
-- VARCHAR and channel_config.provider is likewise). So there is NO new credential column.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS; the seed guards on NOT EXISTS.

-- A) the SMS Template master -------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_template (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  -- the DLT sender/header (e.g. BRTISC, INSTAI). THIS is the `sender` for the send.
  header          VARCHAR(24)  NOT NULL,
  -- the human template name (e.g. "BCL Lead Creation II")
  name            VARCHAR(160) NOT NULL,
  -- the DLT-approved body, with ordered {#var#} markers. Sent VERBATIM with vars filled.
  body            TEXT         NOT NULL,
  -- which lead this template applies to (Branch + Vertical)
  branch_id       BIGINT REFERENCES branch(id),
  vertical_id     BIGINT REFERENCES vertical(id),
  -- the DLT Template ID (`templateid`). BLANK until the client pastes his approved id.
  dlt_template_id VARCHAR(40),
  -- optional per-template DLT Entity ID override; blank => use the Nimbus config entityid.
  entity_id       VARCHAR(40),
  -- ordered {#var#} -> lead field mapping. Default: 1st {#var#}=name, 2nd={#var#}=course.
  var_mapping     JSONB NOT NULL DEFAULT '["name","course"]'::jsonb,
  -- NULL = auto-detect unicode from the body; TRUE/FALSE = explicit override (&type=1).
  unicode         BOOLEAN,
  -- which event auto-sends this template. Today only 'lead_created'; room for more.
  trigger_event   VARCHAR(24) NOT NULL DEFAULT 'lead_created',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT REFERENCES "user"(id),
  updated_by      BIGINT REFERENCES "user"(id),
  deleted_at      TIMESTAMPTZ,
  deleted_by      BIGINT REFERENCES "user"(id)
);

-- the auto-send match reads WHERE branch_id/vertical_id/trigger_event on active rows
CREATE INDEX IF NOT EXISTS ix_sms_template_match
  ON sms_template (branch_id, vertical_id, trigger_event)
  WHERE deleted_at IS NULL AND is_active;

-- B) idempotency backstop for the creation SMS ------------------------------
-- Only the creation send uses this key shape; the partial index leaves every other
-- dedupe_key (e.g. the Sprint-6 scheduled-report keys) completely untouched.
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_log_sms_creation
  ON message_log (dedupe_key)
  WHERE dedupe_key LIKE 'sms_creation:%';

-- C) SEED the two example rows from the client's screenshot ------------------
-- Defensive: inserts ONLY where the named Branch+Vertical exist, and never twice.
-- The DLT Template ID is deliberately left BLANK — the client pastes his approved id.
-- The bodies are EDITABLE placeholders in the DLT shape; the client must overwrite each
-- with the EXACT text he registered on the DLT portal (the gateway rejects any deviation).
INSERT INTO sms_template (org_id, header, name, body, branch_id, vertical_id, var_mapping, trigger_event, is_active)
SELECT o.id, 'BRTISC', 'BCL Lead Creation II',
       'Dear {#var#}, thank you for your interest in {#var#}. Our counsellor will connect with you shortly. - BCL',
       b.id, v.id, '["name","course"]'::jsonb, 'lead_created', TRUE
  FROM organisation o
  JOIN branch b   ON b.org_id = o.id AND lower(b.name) = 'vikaspuri'
  JOIN vertical v ON v.branch_id = b.id AND lower(v.name) = 'bcl'
 WHERE NOT EXISTS (SELECT 1 FROM sms_template t WHERE t.org_id = o.id AND t.name = 'BCL Lead Creation II' AND t.deleted_at IS NULL)
 LIMIT 1;

INSERT INTO sms_template (org_id, header, name, body, branch_id, vertical_id, var_mapping, trigger_event, is_active)
SELECT o.id, 'INSTAI', 'insta Lead Creation IV',
       'Dear {#var#}, thank you for your interest in {#var#}. Our team will reach out to you soon. - INSTA',
       b.id, v.id, '["name","course"]'::jsonb, 'lead_created', TRUE
  FROM organisation o
  JOIN branch b   ON b.org_id = o.id AND lower(b.name) = 'vikaspuri'
  JOIN vertical v ON v.branch_id = b.id AND lower(v.name) = 'insta'
 WHERE NOT EXISTS (SELECT 1 FROM sms_template t WHERE t.org_id = o.id AND t.name = 'insta Lead Creation IV' AND t.deleted_at IS NULL)
 LIMIT 1;
