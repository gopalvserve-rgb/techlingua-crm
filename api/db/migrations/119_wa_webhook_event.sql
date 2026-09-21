-- WhatsApp Account › WEBHOOK HEALTH. Nothing durable recorded that Meta had called
-- /api/webhooks/whatsapp at all: a receipt only UPDATEs message_log, and an inbound
-- message that is not "STOP" leaves no trace. So "is my webhook working?" had no answer.
--
-- One tiny row per VERIFIED inbound POST (never the payload — no message bodies, no
-- customer numbers): when it arrived, what kind it was, and which of our numbers it was
-- for. The screen reads max(received_at) and a 24-hour count from it.
-- Additive: no existing data touched.
CREATE TABLE IF NOT EXISTS wa_webhook_event (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            VARCHAR(40) NOT NULL DEFAULT 'other',   -- message | status | <webhook field> | other
  phone_number_id VARCHAR(40)                              -- OUR number (value.metadata.phone_number_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_webhook_event_received ON wa_webhook_event (received_at DESC);
