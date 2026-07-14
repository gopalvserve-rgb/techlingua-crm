-- =============================================================================
-- 026 — SPRINT 4: ENGAGEMENT & AUTOMATION
--
--   1) channel_config    the SETTINGS FRAMEWORK's storage — one row per
--                        (channel, vertical). SMTP is PER VERTICAL (project rule),
--                        Razorpay is PER VERTICAL, SMS/WhatsApp/AI are org-wide.
--                        Secrets AES-256-GCM at rest (common/crypto.util.ts).
--   2) message_template  dynamic templates per channel, with merge variables.
--   3) message_log       THE DURABLE SEND LOG **and** the send QUEUE. One table:
--                        a queued row IS the job (status/run_after/attempts), and
--                        the same row is what the UI shows afterwards. There is no
--                        second queue and no second history.
--   4) opt_out           consent — a phone/email that must never be messaged again.
--   5) journey           trigger -> conditions -> actions, activate/pause.
--   6) journey_run       one row per (journey, lead, trigger_key) — the UNIQUE index
--                        IS the idempotency guarantee: a lead cannot receive the same
--                        journey step twice, however many replicas sweep.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0) lead.dob — the `birthday` journey trigger needs a date to fire on.
-- ---------------------------------------------------------------------------
ALTER TABLE lead ADD COLUMN IF NOT EXISTS dob DATE;
CREATE INDEX IF NOT EXISTS idx_lead_dob ON lead ((EXTRACT(MONTH FROM dob)), (EXTRACT(DAY FROM dob)))
  WHERE dob IS NOT NULL AND is_active;

-- ---------------------------------------------------------------------------
-- 1) channel_config — the Settings framework's credential store.
--
-- `vertical_id IS NULL` = the ORG-WIDE row. A per-vertical row overrides it.
-- Resolution is always "most specific wins" (vertical -> org), the same rule the
-- SLA policies use, so there is one mental model in the product, not two.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_config (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  -- unconstrained VARCHAR on purpose (the capture-channel-registry lesson):
  -- a new channel is one entry in messaging/providers.ts, NOT a migration.
  channel     VARCHAR(24) NOT NULL,          -- email | sms | whatsapp | payment | ai
  provider    VARCHAR(32) NOT NULL,          -- smtp | msg91 | sms_http | meta_cloud | razorpay | deepseek | gemini
  vertical_id BIGINT NULL REFERENCES vertical(id),
  config      JSONB NOT NULL DEFAULT '{}',
  secrets     JSONB NOT NULL DEFAULT '{}',   -- ciphertexts only: enc:v1:<iv>:<tag>:<ct>
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  last_test_at     TIMESTAMPTZ,
  last_test_ok     BOOLEAN,
  last_test_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES "user"(id),
  updated_by  BIGINT REFERENCES "user"(id),
  deleted_at  TIMESTAMPTZ,
  deleted_by  BIGINT REFERENCES "user"(id)
);
-- ONE row per (channel, vertical). COALESCE(-1) makes the org-wide NULL row
-- participate in the unique index (NULLs are distinct in Postgres otherwise).
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_config ON channel_config
  (org_id, channel, COALESCE(vertical_id, -1)) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2) message_template
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_template (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  channel     VARCHAR(16) NOT NULL,          -- whatsapp | sms | email
  name        VARCHAR(120) NOT NULL,
  code        VARCHAR(60),                   -- stable key journeys refer to
  -- NULL = available to every vertical. Set = scoped to that vertical (the client
  -- runs different course lines with different tone and different SMTP domains).
  vertical_id BIGINT NULL REFERENCES vertical(id),
  subject     VARCHAR(300),                  -- email only
  body        TEXT NOT NULL DEFAULT '',      -- email HTML / sms text / whatsapp body preview
  -- WhatsApp (Meta Cloud API): the template is APPROVED IN META, we only reference it.
  wa_template_name VARCHAR(120),
  wa_language      VARCHAR(12) NOT NULL DEFAULT 'en',
  wa_params        JSONB NOT NULL DEFAULT '[]',  -- ["{{lead.name}}","{{course}}"] -> body {{1}},{{2}}
  -- SMS in India: DLT is a legal requirement, so it is a first-class field, not a note.
  sms_sender_id       VARCHAR(16),
  sms_dlt_template_id VARCHAR(40),
  variables   JSONB NOT NULL DEFAULT '[]',   -- detected at save; drives the preview panel
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES "user"(id),
  updated_by  BIGINT REFERENCES "user"(id),
  deleted_at  TIMESTAMPTZ,
  deleted_by  BIGINT REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_msg_template_channel ON message_template(channel, is_active) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_template_code ON message_template(org_id, code)
  WHERE code IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3) message_log — the send log AND the queue.
--
--   queued  -> claimed by MessageWorker (FOR UPDATE SKIP LOCKED)
--   sent    -> the provider accepted it (provider_message_id recorded)
--   delivered/read -> a provider webhook told us so (WhatsApp)
--   failed  -> permanent (incl. "not configured") or retries exhausted
--   skipped -> opt-out / daily cap — DELIBERATELY not sent, and we say why
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  channel       VARCHAR(16) NOT NULL,        -- whatsapp | sms | email
  provider      VARCHAR(32),                 -- filled when the provider is resolved
  direction     VARCHAR(8) NOT NULL DEFAULT 'out',
  -- who/what
  lead_id       BIGINT REFERENCES lead(id) ON DELETE SET NULL,
  user_id       BIGINT REFERENCES "user"(id),   -- staff recipient (notifier fan-out)
  template_id   BIGINT REFERENCES message_template(id) ON DELETE SET NULL,
  journey_id    BIGINT,
  journey_run_id BIGINT,
  vertical_id   BIGINT REFERENCES vertical(id), -- which SMTP config was used
  branch_id     BIGINT REFERENCES branch(id),
  campaign_id   BIGINT REFERENCES campaign(id),
  to_addr       VARCHAR(255) NOT NULL,       -- E.164 phone or email address
  subject       VARCHAR(300),
  body          TEXT,
  -- queue mechanics (same shape as import_job — one worker idiom in the codebase)
  status        VARCHAR(12) NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sending','sent','delivered','read','failed','skipped')),
  attempts      INT NOT NULL DEFAULT 0,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at     TIMESTAMPTZ,
  provider_message_id VARCHAR(160),
  provider_response   JSONB NOT NULL DEFAULT '{}',
  error         TEXT,
  -- "not configured" is an EXPECTED state, not an incident: flagged so the UI can
  -- show it in amber and the Error Log never gains a red row for it.
  not_configured BOOLEAN NOT NULL DEFAULT FALSE,
  dedupe_key    VARCHAR(160),
  created_by    BIGINT REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_msg_log_claim   ON message_log(status, run_after, id);
CREATE INDEX IF NOT EXISTS idx_msg_log_lead    ON message_log(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_log_channel ON message_log(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_log_provmsg ON message_log(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
-- the daily-cap guardrail reads this
CREATE INDEX IF NOT EXISTS idx_msg_log_lead_day ON message_log(lead_id, created_at)
  WHERE lead_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4) opt_out — consent. Identifier = E.164 phone (sms/whatsapp) or email.
-- Keyed on the IDENTIFIER, not the lead: a person who says STOP stays opted out
-- even if their lead is merged, deleted or re-created from another campaign.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opt_out (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  channel     VARCHAR(16) NOT NULL,          -- whatsapp | sms | email | all
  identifier  VARCHAR(255) NOT NULL,         -- E.164 phone or lower-cased email
  lead_id     BIGINT REFERENCES lead(id) ON DELETE SET NULL,
  reason      VARCHAR(200),
  source      VARCHAR(24) NOT NULL DEFAULT 'manual',  -- manual | inbound | webhook | unsubscribe
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_opt_out ON opt_out(org_id, channel, identifier);
CREATE INDEX IF NOT EXISTS idx_opt_out_ident ON opt_out(identifier);

-- ---------------------------------------------------------------------------
-- 5) journey — trigger -> conditions -> actions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journey (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  name         VARCHAR(160) NOT NULL,
  description  VARCHAR(400),
  -- unconstrained VARCHAR: a new trigger type is one entry in journeys/journey.engine.ts.
  trigger_type VARCHAR(32) NOT NULL,   -- lead_created | stage_changed | no_response | fee_due | birthday
  trigger_config JSONB NOT NULL DEFAULT '{}',  -- e.g. {days:3} | {stage_ids:[..]} | {days_before:3}
  conditions   JSONB NOT NULL DEFAULT '{}',    -- {campaign_ids:[],source_ids:[],bands:[],branch_ids:[],...}
  actions      JSONB NOT NULL DEFAULT '[]',    -- ordered steps (send_message|create_task|change_stage|notify_user|wait)
  guardrails   JSONB NOT NULL DEFAULT '{}',    -- per-journey override of the org guardrails
  status       VARCHAR(10) NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','active','paused')),
  -- optional scoping: a journey can be limited to one branch/vertical
  branch_id    BIGINT NULL REFERENCES branch(id),
  vertical_id  BIGINT NULL REFERENCES vertical(id),
  run_count    INT NOT NULL DEFAULT 0,
  last_run_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT REFERENCES "user"(id),
  updated_by   BIGINT REFERENCES "user"(id),
  deleted_at   TIMESTAMPTZ,
  deleted_by   BIGINT REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_journey_trigger ON journey(trigger_type, status) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6) journey_run — THE IDEMPOTENCY LEDGER.
--
-- trigger_key makes "the same event" concrete and therefore de-duplicable:
--   lead_created  -> 'created'                     (once per lead, ever)
--   stage_changed -> 'stage:<stage_id>'            (once per lead per stage)
--   no_response   -> 'nr:<days>:<YYYY-MM-DD>'      (once per lead per day)
--   fee_due       -> 'fee:<due_date>'              (once per lead per due date)
--   birthday      -> 'bday:<YYYY>'                 (once per lead per year)
--
-- The UNIQUE index does the work. `INSERT ... ON CONFLICT DO NOTHING RETURNING id`
-- returns a row ONLY to the caller that actually claimed the run — so N replicas
-- sweeping the same lead produce exactly one run, and re-running a journey by hand
-- produces zero extra sends. This is the "no double-send" guarantee, in one line of SQL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journey_run (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  journey_id   BIGINT NOT NULL REFERENCES journey(id) ON DELETE CASCADE,
  lead_id      BIGINT NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  trigger_key  VARCHAR(80) NOT NULL,
  status       VARCHAR(12) NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','done','failed','skipped')),
  step_index   INT NOT NULL DEFAULT 0,      -- resume point for `wait` steps
  next_run_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  steps        JSONB NOT NULL DEFAULT '[]', -- per-step result, rendered on the lead timeline
  reason       TEXT,
  attempts     INT NOT NULL DEFAULT 0,
  locked_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_journey_run ON journey_run(journey_id, lead_id, trigger_key);
CREATE INDEX IF NOT EXISTS idx_journey_run_claim ON journey_run(status, next_run_at, id);
CREATE INDEX IF NOT EXISTS idx_journey_run_lead  ON journey_run(lead_id, created_at DESC);

-- message_log -> journey_run (declared after the table exists)
DO $$ BEGIN
  ALTER TABLE message_log
    ADD CONSTRAINT fk_msg_log_journey_run FOREIGN KEY (journey_run_id)
    REFERENCES journey_run(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE message_log
    ADD CONSTRAINT fk_msg_log_journey FOREIGN KEY (journey_id)
    REFERENCES journey(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 7) SETTINGS DEFAULTS (app_setting). Every one of these is a row the client
-- edits in Administration › Settings — no deploy, ever.
-- ---------------------------------------------------------------------------
INSERT INTO app_setting (key, value) VALUES
  ('org_profile', '{"name":"Tech Lingua LLP","currency":"INR","timezone":"Asia/Kolkata","date_format":"DD/MM/YYYY"}'),
  -- business hours drive the journey guardrail
  ('business_hours', '{"enabled":true,"timezone":"Asia/Kolkata","days":{"mon":["09:00","19:00"],"tue":["09:00","19:00"],"wed":["09:00","19:00"],"thu":["09:00","19:00"],"fri":["09:00","19:00"],"sat":["09:00","19:00"],"sun":[]}}'),
  ('holidays', '{"dates":[]}'),
  ('numbering_series', '{"lead":{"prefix":"LD-","next":1,"width":5},"quotation":{"prefix":"QT-","next":1,"width":5},"invoice":{"prefix":"INV-","next":1,"width":5},"receipt":{"prefix":"RC-","next":1,"width":5}}'),
  -- the guardrails the client asked for, as ONE editable row
  ('journey_guardrails', '{"respect_business_hours":true,"max_sends_per_lead_per_day":3,"honour_opt_out":true}'),
  -- WHICH EVENT NOTIFIES WHICH ROLE ON WHICH CHANNEL (the notification matrix)
  ('notification_matrix', '{"reminder":{"in_app":true,"email":false,"sms":false,"whatsapp":false},"escalation":{"in_app":true,"email":true,"sms":false,"whatsapp":false},"sla_breach":{"in_app":true,"email":true,"sms":false,"whatsapp":false},"assignment":{"in_app":true,"email":false,"sms":false,"whatsapp":false},"handout":{"in_app":true,"email":false,"sms":false,"whatsapp":false},"system":{"in_app":true,"email":false,"sms":false,"whatsapp":false}}'),
  -- per-channel throttle (messages/minute) — protects the provider account and our IP reputation
  ('message_rate_limits', '{"email":60,"sms":60,"whatsapp":40}')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8) STARTER TEMPLATES — one per channel, so the client can build a journey the
-- minute he logs in instead of staring at an empty screen. All editable.
-- ---------------------------------------------------------------------------
INSERT INTO message_template (org_id, channel, name, code, subject, body, wa_template_name, wa_params, sms_sender_id, variables)
SELECT o.id, t.channel, t.name, t.code, t.subject, t.body, t.wa_name, t.wa_params::jsonb, t.sender, t.vars::jsonb
FROM organisation o
CROSS JOIN (VALUES
  ('whatsapp', 'Welcome — new lead', 'welcome_wa', NULL,
   'Hi {{lead.name}}, thanks for your interest in {{course}} at {{branch}}. Your counsellor {{counsellor}} will call you shortly.',
   'lead_welcome', '["{{lead.name}}","{{course}}"]', NULL,
   '["lead.name","course","branch","counsellor"]'),
  ('sms', 'Follow-up reminder', 'followup_sms', NULL,
   'Hi {{lead.name}}, this is {{counsellor}} from {{org}} regarding {{course}}. Please call us back.',
   NULL, '[]', 'TCHLNG',
   '["lead.name","counsellor","org","course"]'),
  ('email', 'Course brochure', 'brochure_email', 'Your {{course}} details from {{org}}',
   '<p>Hi {{lead.name}},</p><p>Thank you for enquiring about <b>{{course}}</b> at our {{branch}} centre.</p><p>Your counsellor <b>{{counsellor}}</b> will be in touch shortly.</p><p>— {{org}}</p>',
   NULL, '[]', NULL,
   '["lead.name","course","branch","counsellor","org"]')
) AS t(channel, name, code, subject, body, wa_name, wa_params, sender, vars)
WHERE NOT EXISTS (SELECT 1 FROM message_template mt WHERE mt.org_id = o.id AND mt.code = t.code);

-- ---------------------------------------------------------------------------
-- 9) PERMISSIONS — catalog sync + grants.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('template.read',   'template', 'read'),
  ('template.create', 'template', 'create'),
  ('template.update', 'template', 'update'),
  ('template.delete', 'template', 'delete'),
  ('journey.read',    'journey',  'read'),
  ('journey.create',  'journey',  'create'),
  ('journey.update',  'journey',  'update'),
  ('journey.delete',  'journey',  'delete'),
  ('message.read',    'message',  'read'),
  ('message.send',    'message',  'send'),
  ('message.manage',  'message',  'manage')
ON CONFLICT (key) DO NOTHING;

-- `settings.read` / `settings.update` already existed in the catalog (Sprint 1) but were
-- never granted to anyone, because there was no Settings module to guard. Grant them now.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- SETTINGS: ADMIN ONLY. Credentials live here; a Branch Manager must not read them.
      ('settings.read',   'Super Admin',        'all'),
      ('settings.read',   'Organization Admin', 'all'),
      ('settings.update', 'Super Admin',        'all'),
      ('settings.update', 'Organization Admin', 'all'),

      -- TEMPLATES: marketing writes them; anyone who works a lead can read them
      -- (you cannot send a message from the lead sheet if you cannot see the template).
      ('template.read',   'Super Admin',        'all'),
      ('template.read',   'Organization Admin', 'all'),
      ('template.read',   'Marketing Manager',  'all'),
      ('template.read',   'Branch Manager',     'branch'),
      ('template.read',   'Vertical Manager',   'vertical'),
      ('template.read',   'Team Leader',        'team'),
      ('template.read',   'Counsellor',         'own'),
      ('template.read',   'Telecaller',         'own'),
      ('template.create', 'Super Admin',        'all'),
      ('template.create', 'Organization Admin', 'all'),
      ('template.create', 'Marketing Manager',  'all'),
      ('template.update', 'Super Admin',        'all'),
      ('template.update', 'Organization Admin', 'all'),
      ('template.update', 'Marketing Manager',  'all'),
      ('template.delete', 'Super Admin',        'all'),
      ('template.delete', 'Organization Admin', 'all'),

      -- JOURNEYS: automation changes what the system does to leads at scale.
      -- Read is wide (a counsellor should be able to see why a message went out);
      -- write is admin + marketing only.
      ('journey.read',    'Super Admin',        'all'),
      ('journey.read',    'Organization Admin', 'all'),
      ('journey.read',    'Marketing Manager',  'all'),
      ('journey.read',    'Branch Manager',     'branch'),
      ('journey.read',    'Vertical Manager',   'vertical'),
      ('journey.read',    'Team Leader',        'team'),
      ('journey.read',    'Counsellor',         'own'),
      ('journey.read',    'Telecaller',         'own'),
      ('journey.create',  'Super Admin',        'all'),
      ('journey.create',  'Organization Admin', 'all'),
      ('journey.create',  'Marketing Manager',  'all'),
      ('journey.update',  'Super Admin',        'all'),
      ('journey.update',  'Organization Admin', 'all'),
      ('journey.update',  'Marketing Manager',  'all'),
      ('journey.delete',  'Super Admin',        'all'),
      ('journey.delete',  'Organization Admin', 'all'),

      -- MESSAGES: the send log is lead data, so it is scoped exactly like leads.
      ('message.read',    'Super Admin',        'all'),
      ('message.read',    'Organization Admin', 'all'),
      ('message.read',    'Marketing Manager',  'all'),
      ('message.read',    'Branch Manager',     'branch'),
      ('message.read',    'Vertical Manager',   'vertical'),
      ('message.read',    'Team Leader',        'team'),
      ('message.read',    'Counsellor',         'own'),
      ('message.read',    'Telecaller',         'own'),
      ('message.send',    'Super Admin',        'all'),
      ('message.send',    'Organization Admin', 'all'),
      ('message.send',    'Marketing Manager',  'all'),
      ('message.send',    'Branch Manager',     'branch'),
      ('message.send',    'Vertical Manager',   'vertical'),
      ('message.send',    'Team Leader',        'team'),
      ('message.send',    'Counsellor',         'own'),
      ('message.send',    'Telecaller',         'own'),
      ('message.manage',  'Super Admin',        'all'),
      ('message.manage',  'Organization Admin', 'all'),
      ('message.manage',  'Marketing Manager',  'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
