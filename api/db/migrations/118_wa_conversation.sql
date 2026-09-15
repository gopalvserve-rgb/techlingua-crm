-- WhatsApp Live Chat (Stage 2): per-contact conversation STATE that the message stores
-- (message_log / lead_activity) do not carry — resolved flag, bot on/off, and an explicit
-- chat assignee (falls back to the lead owner in the read model). Keyed by the contact's
-- last-10 phone digits, one row per org+phone. Additive: no existing data touched.
CREATE TABLE IF NOT EXISTS wa_conversation (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL REFERENCES organisation(id),
  phone10          VARCHAR(10) NOT NULL,
  resolved         BOOLEAN NOT NULL DEFAULT FALSE,
  bot_on           BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_user_id BIGINT REFERENCES "user"(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       BIGINT REFERENCES "user"(id),
  UNIQUE (org_id, phone10)
);
