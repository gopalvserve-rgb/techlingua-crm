-- =============================================================================
-- 050 — ERP AI COMMUNICATION INTELLIGENCE (Phase 2, Batch 4)
--
-- Credential-gated AI intelligence. The DeepSeek / Gemini API keys already live in
-- Settings > Channels (channel='ai', one row per provider — DEF-S5-04); this batch
-- makes them DO something. Telephony / call recording is OUT of scope in this system,
-- so the AI works on the TEXT that exists: lead / follow-up notes, the activity
-- timeline, and — the primary path — an uploaded or PASTED transcript.
--
-- Four capabilities, each an LLM call whose structured JSON output is stored here:
--   · transcription — accept a pasted/typed transcript (audio transcription is
--                     key-dependent and noted as such); the transcript is the input text.
--   · summary       — a concise summary of a conversation / transcript / lead notes.
--   · sentiment     — positive / neutral / negative + a short rationale.
--   · quality       — a rubric score (greeting, needs, solution, next-step, politeness)
--                     -> a 0-100 quality score + notes, for counsellor call-quality review.
--
-- Everything DEGRADES cleanly via NotConfiguredException (503, never a 500) when no key
-- is set, and lights up the moment a key is entered.
--
-- ai_analysis denormalises the lead scope columns so the ScopeResolver filters it exactly
-- like every other lead-shaped entity. owner_id is the subject's owner when there is a
-- subject, else the runner, so a counsellor always sees his own ad-hoc analyses under 'own'.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT). Re-runnable.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_analysis (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),

  subject_type  VARCHAR(16) NOT NULL DEFAULT 'transcript'
                  CHECK (subject_type IN ('lead', 'student', 'transcript')),
  subject_id    BIGINT NULL,
  subject_label VARCHAR(200) NULL,

  analysis_type VARCHAR(20) NOT NULL
                  CHECK (analysis_type IN ('transcription', 'summary', 'sentiment', 'quality')),
  input_source  VARCHAR(20) NOT NULL DEFAULT 'transcript'
                  CHECK (input_source IN ('transcript', 'notes', 'activity', 'audio')),
  input_ref     VARCHAR(200) NULL,
  input_text    TEXT NULL,

  provider      VARCHAR(24) NULL,
  model         VARCHAR(80) NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'complete'
                  CHECK (status IN ('complete', 'failed')),
  output        JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_text  TEXT NULL,
  sentiment     VARCHAR(12) NULL CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative')),
  quality_score INT NULL,
  tokens        INT NULL,
  error         VARCHAR(300) NULL,

  branch_id     BIGINT NULL REFERENCES branch(id),
  vertical_id   BIGINT NULL REFERENCES vertical(id),
  pipeline_id   BIGINT NULL REFERENCES pipeline(id),
  campaign_id   BIGINT NULL REFERENCES campaign(id),
  team_id       BIGINT NULL REFERENCES team(id),
  owner_id      BIGINT NULL REFERENCES "user"(id),

  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_subject ON ai_analysis (subject_type, subject_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_analysis_scope   ON ai_analysis (branch_id, vertical_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_analysis_type    ON ai_analysis (analysis_type, created_at DESC) WHERE deleted_at IS NULL;

-- Permissions — the ai.* module.
INSERT INTO permission (key, module, action) VALUES
  ('ai.read',   'ai', 'read'),
  ('ai.run',    'ai', 'run'),
  ('ai.delete', 'ai', 'delete'),
  ('ai.manage', 'ai', 'manage')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ai.read',   'Super Admin',        'all'),
      ('ai.read',   'Organization Admin', 'all'),
      ('ai.read',   'Marketing Manager',  'all'),
      ('ai.read',   'Branch Manager',     'branch'),
      ('ai.read',   'Vertical Manager',   'vertical'),
      ('ai.read',   'Team Leader',        'team'),
      ('ai.read',   'Counsellor',         'own'),
      ('ai.read',   'Telecaller',         'own'),
      ('ai.run',    'Super Admin',        'all'),
      ('ai.run',    'Organization Admin', 'all'),
      ('ai.run',    'Marketing Manager',  'all'),
      ('ai.run',    'Branch Manager',     'branch'),
      ('ai.run',    'Vertical Manager',   'vertical'),
      ('ai.run',    'Team Leader',        'team'),
      ('ai.run',    'Counsellor',         'own'),
      ('ai.run',    'Telecaller',         'own'),
      ('ai.delete', 'Super Admin',        'all'),
      ('ai.delete', 'Organization Admin', 'all'),
      ('ai.delete', 'Marketing Manager',  'all'),
      ('ai.delete', 'Branch Manager',     'branch'),
      ('ai.delete', 'Vertical Manager',   'vertical'),
      ('ai.delete', 'Team Leader',        'team'),
      ('ai.delete', 'Counsellor',         'own'),
      ('ai.delete', 'Telecaller',         'own'),
      ('ai.manage', 'Super Admin',        'all'),
      ('ai.manage', 'Organization Admin', 'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
