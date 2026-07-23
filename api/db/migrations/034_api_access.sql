-- =============================================================================
-- 034 — DEVELOPER / API ACCESS  (Administration › API)
--
-- The client asked for a real, key-authenticated public surface with four things:
--   (a) API KEYS      — generate (shown ONCE), enable/disable, revoke; only a hash
--                       is ever stored, never the plaintext.
--   (b) API DOCS      — an in-app page listing the endpoints a key can call.
--   (c) API REQUEST   — every inbound key-authed request logged: when, which key
--       LOG             (masked), endpoint, status code, success/failure + reason.
--   (d) ENABLE/DISABLE— per key; a disabled or revoked key is rejected (401).
--
--   1) api_key          the credential. We store only a SHA-256 HASH of the full
--                       key (key_hash, UNIQUE) plus a display prefix and last-4 for
--                       the masked list — the plaintext is shown once at creation
--                       and is never retrievable again. A key is scoped to a fixed
--                       capability set (scopes) and, for create-lead, an optional
--                       default campaign+source it drops leads into.
--   2) api_request_log  one row per inbound key-authed request (accepted AND
--                       rejected), mirroring webhook_event for the capture
--                       channels. It is the "why was this call refused?" screen.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING), auto-run on boot.
-- =============================================================================

CREATE TABLE IF NOT EXISTS api_key (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL REFERENCES organisation(id),
  name                VARCHAR(120) NOT NULL,
  key_prefix          VARCHAR(40) NOT NULL,
  key_last4           VARCHAR(8)  NOT NULL DEFAULT '',
  key_hash            VARCHAR(64) NOT NULL,
  scopes              TEXT[] NOT NULL DEFAULT ARRAY['lead:create','lead:read'],
  record_scope        VARCHAR(12) NOT NULL DEFAULT 'all',
  default_campaign_id BIGINT REFERENCES campaign(id),
  default_source_id   BIGINT REFERENCES source(id),
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by          BIGINT,
  created_by          BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_key_hash ON api_key (key_hash);
CREATE INDEX IF NOT EXISTS ix_api_key_org ON api_key (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_request_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT,
  api_key_id    BIGINT REFERENCES api_key(id),
  key_prefix    VARCHAR(40),
  method        VARCHAR(8)   NOT NULL DEFAULT 'POST',
  endpoint      VARCHAR(200) NOT NULL,
  status_code   INT          NOT NULL,
  outcome       VARCHAR(12)  NOT NULL,
  reason        VARCHAR(2000),
  ip            VARCHAR(64),
  lead_id       BIGINT,
  duration_ms   INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_api_req_log_created ON api_request_log (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_api_req_log_key     ON api_request_log (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_api_req_log_status  ON api_request_log (status_code);

-- ---------------------------------------------------------------------------
-- Permissions. The API module is admin-only, exactly like Settings: it mints
-- credentials that authenticate as a caller against the whole org, so a Branch
-- Manager must not be able to read or manage them.
--   api.read   — view keys (masked), the docs and the request log
--   api.manage — generate / enable / disable / revoke a key
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('api.read',   'api', 'read'),
  ('api.manage', 'api', 'manage')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('api.read',   'Super Admin',        'all'),
      ('api.read',   'Organization Admin', 'all'),
      ('api.manage', 'Super Admin',        'all'),
      ('api.manage', 'Organization Admin', 'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
