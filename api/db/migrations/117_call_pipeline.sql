-- ============================================================================
-- 117 — CALL PIPELINE (Call-Tracking Blueprint, client Sep 2026)
--
-- Reverses part of the "telephony out of scope" decision: adds tap-to-dial,
-- native call-log import, and OEM call-recording sync — NO dialer/IVR/routing.
--
-- Two carrier tables + one per-user settings table + the calls.* permission.
-- Everything idempotent (IF NOT EXISTS / guarded seeds).
--
--   lead_recording — one row per synced audio file (bytes in R2; bytea fallback).
--   call_event     — one row per call from any source. The `src` column is the
--                    whole design: NULL = live phone-state event (fast, untrusted);
--                    calllog = phone's own log (authoritative); calllog-fix = a live
--                    row repaired by the import; live-dup = a live row superseded and
--                    hidden from reports. Nothing is ever deleted, so it stays auditable.
--   call_setting   — per-user: tracking on/off, SIM slots, recording folder, intervals.
-- ============================================================================

-- ---- lead_recording -------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_recording (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  lead_id BIGINT NULL REFERENCES lead(id),
  user_id BIGINT NULL REFERENCES "user"(id),
  phone_number VARCHAR(32) NOT NULL DEFAULT '',
  file_name VARCHAR(200),
  mime VARCHAR(80),
  size_bytes BIGINT NOT NULL DEFAULT 0,
  duration_s INT NULL,
  file_mtime TIMESTAMPTZ NULL,
  r2_key VARCHAR(300) NULL,
  content BYTEA NULL,
  source_hash VARCHAR(120) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_lead_recording_lead ON lead_recording(lead_id);
CREATE INDEX IF NOT EXISTS ix_lead_recording_phone ON lead_recording(phone_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_recording_source
  ON lead_recording(org_id, user_id, source_hash) WHERE source_hash IS NOT NULL;

-- ---- call_event -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_event (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  lead_id BIGINT NULL REFERENCES lead(id),
  user_id BIGINT NULL REFERENCES "user"(id),
  phone_number VARCHAR(32) NOT NULL DEFAULT '',
  phone_raw VARCHAR(48) NULL,
  direction VARCHAR(12) NOT NULL DEFAULT 'unknown',
  event VARCHAR(24) NOT NULL DEFAULT 'ended',
  duration_s INT NOT NULL DEFAULT 0,
  call_start_at TIMESTAMPTZ NULL,
  recording_id BIGINT NULL REFERENCES lead_recording(id) ON DELETE SET NULL,
  sim_slot INT NULL,
  sim_label VARCHAR(60) NULL,
  external_log_id VARCHAR(80) NULL,
  src VARCHAR(16) NULL,
  disposition_id BIGINT NULL REFERENCES m_call_disposition(id),
  note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_call_event_user ON call_event(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_call_event_lead ON call_event(lead_id);
CREATE INDEX IF NOT EXISTS ix_call_event_phone ON call_event(phone_number);
CREATE INDEX IF NOT EXISTS ix_call_event_src ON call_event(src);
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_event_external
  ON call_event(org_id, user_id, external_log_id) WHERE external_log_id IS NOT NULL;

-- ---- call_setting (per user) ---------------------------------------------
CREATE TABLE IF NOT EXISTS call_setting (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  user_id BIGINT NOT NULL REFERENCES "user"(id),
  tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sim_slots JSONB NOT NULL DEFAULT '[]',
  recording_folder VARCHAR(300) NULL,
  log_sync_minutes INT NOT NULL DEFAULT 60,
  rec_sync_minutes INT NOT NULL DEFAULT 15,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_setting_user ON call_setting(org_id, user_id);

-- ---- permissions ----------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('calls.read',   'calls', 'read'),
  ('calls.act',    'calls', 'act'),
  ('calls.manage', 'calls', 'manage')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('calls.read',   'Super Admin',        'all'),
      ('calls.read',   'Organization Admin', 'all'),
      ('calls.read',   'Marketing Manager',  'all'),
      ('calls.read',   'Branch Manager',     'branch'),
      ('calls.read',   'Vertical Manager',   'vertical'),
      ('calls.read',   'Team Leader',        'team'),
      ('calls.read',   'Counsellor',         'own'),
      ('calls.read',   'Telecaller',         'own'),
      ('calls.act',    'Super Admin',        'all'),
      ('calls.act',    'Organization Admin', 'all'),
      ('calls.act',    'Marketing Manager',  'all'),
      ('calls.act',    'Branch Manager',     'branch'),
      ('calls.act',    'Vertical Manager',   'vertical'),
      ('calls.act',    'Team Leader',        'team'),
      ('calls.act',    'Counsellor',         'own'),
      ('calls.act',    'Telecaller',         'own'),
      ('calls.manage', 'Super Admin',        'all'),
      ('calls.manage', 'Organization Admin', 'all'),
      ('calls.manage', 'Marketing Manager',  'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
