-- 020 — Sprint 2 / WS3: LEAD CAPTURE CHANNELS
--
-- Meta (Facebook/Instagram) Lead Ads · Google Ads lead form extensions ·
-- website form endpoint · Google Sheet pull.
--
-- Every channel is a thin adapter in front of the ONE shared pipeline built in
-- 018/019 (`LeadIngestionService`): normalise -> E.164 -> NeoDove §4 duplicate
-- rules -> campaign distribution -> persist + audit, with the `lead_ingest_record`
-- ledger giving replay-idempotency for free. A channel NEVER creates a lead itself.
--
-- The provider is a plain VARCHAR with NO check constraint: JustDial / IndiaMART
-- (explicitly out of scope today) or any future source are added by registering a
-- provider spec in `ingestion/channels/providers.ts` — no migration, no refactor.
--
-- SECRETS: `capture_channel.secrets` holds ONLY AES-256-GCM ciphertexts
-- ('enc:v1:...', see common/crypto.util.ts). Nothing readable is ever written to
-- the repo, audit_log or an API response (values always come back masked).

-- 1) capture_channel — one configured inbound channel, bound to ONE campaign+source
CREATE TABLE IF NOT EXISTS capture_channel (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  provider      VARCHAR(24) NOT NULL,          -- meta | google_ads | website | google_sheet | (future: justdial, indiamart)
  name          VARCHAR(120) NOT NULL,

  -- the lead's full path is derived from the campaign, exactly like every other channel
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  vertical_id   BIGINT NOT NULL REFERENCES vertical(id),
  pipeline_id   BIGINT NOT NULL REFERENCES pipeline(id),
  campaign_id   BIGINT NOT NULL REFERENCES campaign(id),
  source_id     BIGINT NOT NULL REFERENCES source(id),

  -- the unguessable URL segment for this channel's public endpoint (and the
  -- website form's public key). Rotatable without touching the campaign.
  public_key    VARCHAR(48) NOT NULL UNIQUE,

  config        JSONB NOT NULL DEFAULT '{}',   -- NON-secret settings (origins, sheet id, field map, ...)
  secrets       JSONB NOT NULL DEFAULT '{}',   -- key -> 'enc:v1:...' ciphertext. NEVER plaintext.

  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  cursor        JSONB NOT NULL DEFAULT '{}',   -- google_sheet: { last_row: N } — rows are never re-ingested
  next_poll_at  TIMESTAMPTZ,                   -- google_sheet scheduler

  last_event_at TIMESTAMPTZ,
  last_lead_at  TIMESTAMPTZ,
  last_lead_id  BIGINT REFERENCES lead(id) ON DELETE SET NULL,
  last_error    TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES "user"(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES "user"(id),
  deleted_at    TIMESTAMPTZ,
  deleted_by    BIGINT REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_capture_channel_path ON capture_channel(branch_id, vertical_id, pipeline_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_capture_channel_poll ON capture_channel(next_poll_at) WHERE deleted_at IS NULL AND is_active;
CREATE INDEX IF NOT EXISTS idx_capture_channel_provider ON capture_channel(provider) WHERE deleted_at IS NULL;

-- 2) webhook_event — the DURABLE inbound log. EVERY request that reaches a public
--    capture endpoint lands here VERBATIM, accepted or rejected, so a "lost lead"
--    can always be traced (and replayed) after the fact.
CREATE TABLE IF NOT EXISTS webhook_event (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT REFERENCES organisation(id),
  channel_id   BIGINT REFERENCES capture_channel(id) ON DELETE SET NULL,
  provider     VARCHAR(24) NOT NULL,
  public_key   VARCHAR(48),                    -- kept even when no channel matched
  method       VARCHAR(8)  NOT NULL DEFAULT 'POST',
  ip           VARCHAR(64),
  origin       VARCHAR(255),
  raw          JSONB NOT NULL DEFAULT '{}',    -- the payload, verbatim (it IS the lead — never redacted)
  signature_ok BOOLEAN,
  status       VARCHAR(16) NOT NULL
               CHECK (status IN ('verified','rejected','ingested','duplicate','skipped','failed')),
  reason       TEXT,
  external_key VARCHAR(160),                   -- leadgen_id / lead_id / sheet row / form id
  lead_id      BIGINT REFERENCES lead(id) ON DELETE SET NULL,
  duration_ms  INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_event_channel ON webhook_event(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_event_time    ON webhook_event(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_event_status  ON webhook_event(status, created_at DESC);

-- 3) the ingestion ledger already carries 'webhook' | 'form' | 'sheet' channels
--    (018). Nothing to change: idempotency, duplicates, distribution and audit are
--    inherited by all four channels for free.

-- 4) permissions -------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('channel.read','channel','read'),
  ('channel.manage','channel','manage')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  -- manage (create / edit secrets) = admins only. Secrets are readable by NOBODY:
  -- the API returns them masked, always.
  FOR r IN
    SELECT * FROM (VALUES
      ('Super Admin',        'all',      TRUE),
      ('Organization Admin', 'all',      TRUE),
      ('Branch Manager',     'branch',   FALSE),
      ('Vertical Manager',   'vertical', FALSE)
    ) AS t(role_name, scope, can_manage)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
      SELECT ro.id, p.id, r.scope
        FROM role ro JOIN permission p ON p.key = 'channel.read'
       WHERE ro.name = r.role_name AND ro.is_system
      ON CONFLICT (role_id, permission_id) DO NOTHING;

    IF r.can_manage THEN
      INSERT INTO role_permission (role_id, permission_id, record_scope)
        SELECT ro.id, p.id, r.scope
          FROM role ro JOIN permission p ON p.key = 'channel.manage'
         WHERE ro.name = r.role_name AND ro.is_system
        ON CONFLICT (role_id, permission_id) DO NOTHING;
    END IF;
  END LOOP;
END $$;
