-- =============================================================================
-- 138 — AI INSIGHTS + COMMUNICATION INTELLIGENCE (client 12 Nov 2026, "complete this module")
--
--   call_transcript  one per call recording (or a transcript pasted against a call / lead):
--                    pending → processing → done | failed | skipped, which provider, language,
--                    the text. Recordings come from the counsellor phone app (lead_recording).
--   call_insight     the AI read of one transcript: summary, key points, next steps, sentiment,
--                    a 0–100 quality score on the five-criteria rubric, objections, intent,
--                    interest, a follow-up suggestion, and FLAGS (low quality / negative / an
--                    unanswered objection) with a manager review trail.
--   Speech-to-text keys live in channel_config (channel 'stt': OpenAI Whisper, Deepgram or
--   Sarvam), settings in app_setting 'transcription_settings'. Nothing runs until a provider
--   is chosen and its key saved.
--   tracked_keyword.alert  — a keyword heard on a call alerts the call's counsellor + managers.
--   Two staff notification events: call_flagged, call_keyword (Notification Settings).
-- =============================================================================

CREATE TABLE IF NOT EXISTS call_transcript (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  recording_id   BIGINT NULL UNIQUE REFERENCES lead_recording(id) ON DELETE SET NULL,
  call_event_id  BIGINT NULL REFERENCES call_event(id) ON DELETE SET NULL,
  lead_id        BIGINT NULL REFERENCES lead(id),
  user_id        BIGINT NULL REFERENCES "user"(id),
  branch_id      BIGINT NULL, vertical_id BIGINT NULL, team_id BIGINT NULL, pipeline_id BIGINT NULL, campaign_id BIGINT NULL,
  call_at        TIMESTAMPTZ NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed', 'skipped')),
  source         VARCHAR(12) NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual', 'paste')),
  provider       VARCHAR(24) NULL,
  model          VARCHAR(60) NULL,
  language       VARCHAR(16) NULL,
  duration_s     INT NULL,
  transcript     TEXT NULL,
  error          VARCHAR(400) NULL,
  attempts       INT NOT NULL DEFAULT 0,
  next_try_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ NULL,
  deleted_at     TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS ix_ct_status ON call_transcript (status, next_try_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_ct_lead ON call_transcript (lead_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_ct_text ON call_transcript USING gin (to_tsvector('simple', COALESCE(transcript, '')));

CREATE TABLE IF NOT EXISTS call_insight (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL REFERENCES organisation(id),
  transcript_id    BIGINT NOT NULL UNIQUE REFERENCES call_transcript(id) ON DELETE CASCADE,
  lead_id          BIGINT NULL REFERENCES lead(id),
  user_id          BIGINT NULL REFERENCES "user"(id),
  branch_id        BIGINT NULL, vertical_id BIGINT NULL, team_id BIGINT NULL, pipeline_id BIGINT NULL, campaign_id BIGINT NULL,
  call_at          TIMESTAMPTZ NULL,
  summary          TEXT NULL,
  key_points       JSONB NOT NULL DEFAULT '[]',
  next_steps       JSONB NOT NULL DEFAULT '[]',
  sentiment        VARCHAR(12) NULL CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative')),
  sentiment_score  NUMERIC(4, 2) NULL,
  quality_score    INT NULL,
  criteria         JSONB NOT NULL DEFAULT '{}',
  coaching         TEXT NULL,
  objections       JSONB NOT NULL DEFAULT '[]',
  intent           VARCHAR(60) NULL,
  interest_level   VARCHAR(12) NULL,
  follow_up        TEXT NULL,
  flagged          BOOLEAN NOT NULL DEFAULT FALSE,
  flag_reasons     JSONB NOT NULL DEFAULT '[]',
  reviewed_by      BIGINT NULL REFERENCES "user"(id),
  reviewed_at      TIMESTAMPTZ NULL,
  review_note      VARCHAR(500) NULL,
  provider         VARCHAR(24) NULL,
  model            VARCHAR(80) NULL,
  tokens           INT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ci_user ON call_insight (user_id, call_at DESC);
CREATE INDEX IF NOT EXISTS ix_ci_flag ON call_insight (flagged, reviewed_at) WHERE flagged;
CREATE INDEX IF NOT EXISTS ix_ci_text ON call_insight USING gin (to_tsvector('simple', COALESCE(summary, '')));

ALTER TABLE tracked_keyword ADD COLUMN IF NOT EXISTS alert BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO app_setting (key, value)
VALUES ('transcription_settings', '{"auto_transcribe": true, "auto_analyse": true, "language": "auto", "min_duration_s": 15, "monthly_minutes_limit": 0, "flag_quality_below": 50}'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO staff_notif_rule (event_key, module, name, message, timing_kind, sort_order, priority, delay_minutes, sound, desktop, escalate, escalate_after_minutes)
VALUES
  ('call_flagged', 'Communication', 'Call flagged for review', 'A call needs a manager review', 'instant', 400, 'high', 0, TRUE, TRUE, FALSE, 60),
  ('call_keyword', 'Communication', 'Tracked keyword on a call', 'A tracked keyword was heard on a call', 'instant', 410, 'medium', 0, FALSE, FALSE, FALSE, 60)
ON CONFLICT (event_key) DO NOTHING;
UPDATE staff_notif_rule r
   SET role_ids = ARRAY(SELECT id FROM role WHERE name IN ('Branch Manager', 'Organization Admin') AND deleted_at IS NULL ORDER BY id)
 WHERE r.event_key IN ('call_flagged', 'call_keyword') AND r.updated_by IS NULL AND r.role_ids = '{}';
