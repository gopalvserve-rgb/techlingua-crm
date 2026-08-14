-- 077 — Manual fee-reminder idempotency (client feedback item 5).
-- The Fee Management (dues) list gains a "Reminder" action icon that fires the same
-- channel-agnostic reminder the automatic sweep uses (WhatsApp / SMS / Email, guarded,
-- degrades cleanly). This tiny ledger makes a MANUAL nudge idempotent: at most ONE per
-- enrolment per IST day, so repeated clicks never spam the student. The automatic
-- installment_reminder sweep (056) is untouched.
CREATE TABLE IF NOT EXISTS fee_manual_reminder (
  id              BIGSERIAL PRIMARY KEY,
  enrolment_id    BIGINT NOT NULL REFERENCES enrolment(id) ON DELETE CASCADE,
  ymd             DATE   NOT NULL,
  channels        TEXT[] NOT NULL DEFAULT '{}',
  message_log_id  BIGINT,
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_manual_reminder_enr_day
  ON fee_manual_reminder (enrolment_id, ymd);
