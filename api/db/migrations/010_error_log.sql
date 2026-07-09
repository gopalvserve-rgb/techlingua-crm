-- 010: Error Log module — every API/web error & issue captured for the admin
-- Administration › Error Logs screen ("show all errors, issues and highlight bugs").
-- fingerprint groups repeat occurrences of the same root cause (hash of
-- source + normalised path + normalised message). Fully idempotent (like 007)
-- so it is safe on databases seeded before or after this feature.

CREATE TABLE IF NOT EXISTS error_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT REFERENCES organisation(id),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       VARCHAR(10)  NOT NULL CHECK (source IN ('api','web')),
  level        VARCHAR(10)  NOT NULL CHECK (level IN ('error','warning')),
  status_code  INT,
  method       VARCHAR(10),
  path         VARCHAR(300),
  message      TEXT NOT NULL,
  stack        TEXT,                             -- truncated to ~4000 chars by the writer
  fingerprint  VARCHAR(64) NOT NULL,             -- sha256(source|path-normalised|message-normalised), for grouping
  user_id      BIGINT REFERENCES "user"(id),
  ip           VARCHAR(45),
  user_agent   TEXT,
  meta         JSONB,                            -- redacted request context (never secrets)
  status       VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by  BIGINT REFERENCES "user"(id),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_error_log_org_time ON error_log(org_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_fp       ON error_log(fingerprint);
CREATE INDEX IF NOT EXISTS idx_error_log_status   ON error_log(status);

-- 1) permission catalog rows (mirror of src/rbac/permission-catalog.ts)
INSERT INTO permission (key, module, action) VALUES
  ('errorlog.read', 'errorlog', 'read'),
  ('errorlog.manage', 'errorlog', 'manage')
ON CONFLICT (key) DO NOTHING;

-- 2) grants: Super Admin + Organization Admin only, record_scope 'all'.
--    Error logs are org-level (like masters): only an 'all'-scoped grant gives access.
INSERT INTO role_permission (role_id, permission_id, record_scope)
SELECT ro.id, p.id, 'all'
  FROM role ro
  JOIN permission p ON p.key IN ('errorlog.read', 'errorlog.manage')
 WHERE ro.name IN ('Super Admin', 'Organization Admin') AND ro.is_system
ON CONFLICT (role_id, permission_id) DO NOTHING;
