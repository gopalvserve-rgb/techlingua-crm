-- ============================================================================
-- 108 — CALL DISPOSITION MASTER + LEAD "LAST CALL DISPOSITION" + USER last_seen
-- (dev/139 — Calling CRM batch, client 26/27 Aug 2026)
--
-- (a) A NEW self-manageable generic master `m_call_disposition` (the outcome of a
--     call), exactly like every other master (m_disposition / m_campaign_type / m_level):
--     CRUD via /api/masters/call_disposition, managed in Administration > Masters, and
--     surfaced on the Start Calling disposition form + the lead "Log disposition" control.
--     This is DISTINCT from the older generic `m_disposition` (kept, unchanged) so the
--     client can curate a dedicated Call Disposition list without disturbing existing rows.
--
-- (b) `lead.last_call_disposition_id` (+ `last_call_disposition_at`) — the most recent call
--     outcome per lead. Set when a disposition is logged (Start Calling save & next, or the
--     lightweight lead "Log disposition" control). Surfaced as a Leads-list column + filter,
--     the Start Calling queue filter, and on the lead detail. Nullable, no backfill needed.
--
-- (c) `user.last_seen_at` — a lightweight "last activity" touch written by the JWT guard on
--     each authenticated request (throttled), powering the Dashboard live team-status widget
--     (Online / Away / Offline). Nullable; NULL simply reads as Offline until first seen.
--
-- Idempotent: IF NOT EXISTS on all DDL; every seed guarded by NOT EXISTS-per-row.
-- ============================================================================

-- (a) Generic master table — identical shape to m_campaign_type (100) / m_level (097).
CREATE TABLE IF NOT EXISTS m_call_disposition (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  name VARCHAR(120) NOT NULL, code VARCHAR(40),
  sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}', parent_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT, deleted_at TIMESTAMPTZ NULL, deleted_by BIGINT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_m_call_disposition_active_name ON m_call_disposition (org_id, lower(name)) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_m_call_disposition_active_code ON m_call_disposition (org_id, lower(code)) WHERE is_active AND code IS NOT NULL;

-- Seed the common call outcomes (only when the org already exists — a fresh DB seeds via seed.ts).
DO $$
DECLARE v_org BIGINT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;
  INSERT INTO m_call_disposition (org_id, name, code, sort_order)
  SELECT v_org, v.name, v.code, v.ord
    FROM (VALUES
            ('Connected',            'CONNECTED',   10),
            ('Not Connected / RNR',  'RNR',         20),
            ('Busy',                 'BUSY',        30),
            ('Switched Off',         'SWITCHOFF',   40),
            ('Wrong Number',         'WRONGNO',     50),
            ('Call Back',            'CALLBACK',    60),
            ('Interested',           'INTERESTED',  70),
            ('Not Interested',       'NOTINT',      80),
            ('Follow-up Scheduled',  'FUPSCHED',    90)
         ) AS v(name, code, ord)
   WHERE NOT EXISTS (SELECT 1 FROM m_call_disposition m WHERE m.org_id = v_org AND lower(m.name) = lower(v.name));
END $$;

-- (b) Lead: the last call disposition + when it was logged.
ALTER TABLE lead ADD COLUMN IF NOT EXISTS last_call_disposition_id BIGINT NULL;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS last_call_disposition_at TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS ix_lead_last_call_disposition ON lead (last_call_disposition_id) WHERE last_call_disposition_id IS NOT NULL;

-- (c) User: last activity heartbeat for the live team-status widget.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;
