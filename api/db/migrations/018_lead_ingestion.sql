-- 018 — Sprint 2: SHARED LEAD INGESTION PIPELINE + bulk CSV import.
--
-- One path for every capture channel (CSV today; webhook / website form /
-- Google-Sheet pull reuse it verbatim next):
--   normalise -> resolve hierarchy -> E.164 phone -> duplicate check (NeoDove
--   §4, per-campaign duplicacy_config) -> distribution (campaign engine)
--   -> persist + audit.
--
-- Queue topology (decision, 14 Jul 2026): the durable queue is POSTGRES, not
-- Redis/BullMQ. Railway runs ONE api service, so a separate BullMQ worker
-- process is not deployable today; a Postgres queue claimed with
-- `FOR UPDATE SKIP LOCKED` is durable across restarts, needs no extra infra and
-- is multi-instance safe. The worker runs in-process inside the API.
-- See the decision log in docs/PROJECT_DOCUMENTATION.md.

-- 1) import_batch — one per uploaded file / channel batch (the Import History row)
CREATE TABLE IF NOT EXISTS import_batch (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  channel         VARCHAR(16) NOT NULL DEFAULT 'csv'
                  CHECK (channel IN ('csv','webhook','form','sheet','api')),
  file_name       VARCHAR(255),
  file_hash       VARCHAR(64),
  branch_id       BIGINT NOT NULL REFERENCES branch(id),
  vertical_id     BIGINT NOT NULL REFERENCES vertical(id),
  pipeline_id     BIGINT NOT NULL REFERENCES pipeline(id),
  campaign_id     BIGINT NOT NULL REFERENCES campaign(id),
  source_id       BIGINT NOT NULL REFERENCES source(id),
  mapping         JSONB NOT NULL DEFAULT '{}',
  status          VARCHAR(10) NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','done','failed')),
  total_rows      INT NOT NULL DEFAULT 0,
  created_count   INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  skipped_count   INT NOT NULL DEFAULT 0,
  failed_count    INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_by      BIGINT REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_import_batch_path ON import_batch(branch_id, vertical_id, pipeline_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_import_batch_time ON import_batch(created_at DESC);

-- 2) import_job — the durable queue: ONE row per source record.
CREATE TABLE IF NOT EXISTS import_job (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    BIGINT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  row_num     INT NOT NULL,
  payload     JSONB NOT NULL,
  raw         JSONB NOT NULL DEFAULT '{}',
  dedupe_key  VARCHAR(120) NOT NULL,
  status      VARCHAR(10) NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','created','duplicate','skipped','failed')),
  attempts    INT NOT NULL DEFAULT 0,
  run_after   TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at   TIMESTAMPTZ,
  lead_id     BIGINT REFERENCES lead(id),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_job_claim ON import_job(status, run_after, id);
CREATE INDEX IF NOT EXISTS idx_import_job_batch ON import_job(batch_id, row_num);

-- 3) lead_ingest_record — THE IDEMPOTENCY LEDGER (all channels).
CREATE TABLE IF NOT EXISTS lead_ingest_record (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  source_id   BIGINT NOT NULL REFERENCES source(id),
  dedupe_key  VARCHAR(120) NOT NULL,
  channel     VARCHAR(16) NOT NULL DEFAULT 'csv',
  outcome     VARCHAR(10) NOT NULL CHECK (outcome IN ('created','duplicate')),
  lead_id     BIGINT REFERENCES lead(id),
  batch_id    BIGINT REFERENCES import_batch(id) ON DELETE SET NULL,
  pending_action  VARCHAR(20),
  duplicate_of_id BIGINT REFERENCES lead(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_ingest_key ON lead_ingest_record(source_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_lead_ingest_lead ON lead_ingest_record(lead_id);

-- 4) import_error — durable dead-letter; backs the downloadable error CSV.
CREATE TABLE IF NOT EXISTS import_error (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id   BIGINT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  job_id     BIGINT REFERENCES import_job(id) ON DELETE SET NULL,
  row_num    INT NOT NULL,
  raw        JSONB NOT NULL,
  reason     TEXT NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_error_batch ON import_error(batch_id, row_num);

-- 5) lead traceability: which batch produced this lead (also powers cleanup)
ALTER TABLE lead ADD COLUMN IF NOT EXISTS ingest_batch_id BIGINT NULL REFERENCES import_batch(id) ON DELETE SET NULL;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS external_id     VARCHAR(120) NULL;
CREATE INDEX IF NOT EXISTS idx_lead_ingest_batch ON lead(ingest_batch_id);

-- 6) permission: lead.import already exists (007) and is granted to Super Admin +
--    Organization Admin at record_scope 'all'. Re-asserted idempotently here.
INSERT INTO permission (key, module, action) VALUES ('lead.import','lead','import')
ON CONFLICT (key) DO NOTHING;
