-- 036 — INTEGRATIONS MODULE (NeoDove-modelled)
--
-- The Integrations module reuses the Sprint-2 capture infrastructure verbatim: a
-- "connected integration" IS a `capture_channel` row bound to a campaign, and its
-- field mapping + "capture other fields" toggle live in the existing `config`
-- JSONB (keys `field_map` / `capture_extra`). No parallel system, no new lead
-- path — every push still flows through LeadIngestionService.
--
-- The new push providers (indiamart · justdial · tradeindia · housing · 99acres ·
-- google_form · custom · webhook) are registered in ingestion/channels/providers.ts
-- and served by ONE public route family (/api/webhooks/push/<public_key>), so they
-- needed NO schema change. This migration is therefore small and additive:
--   1) widen the free-VARCHAR provider columns (future-proofing only), and
--   2) index webhook_event by provider for the Logs page's per-source filter.
-- It is idempotent and safe to re-run.

ALTER TABLE capture_channel ALTER COLUMN provider TYPE VARCHAR(32);
ALTER TABLE webhook_event  ALTER COLUMN provider TYPE VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_webhook_event_provider
  ON webhook_event(provider, created_at DESC);
