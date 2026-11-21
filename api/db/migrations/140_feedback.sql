-- 140 — FEEDBACK (22 Nov 2026): a note pinned to the page it was written on.
--
-- A "✎ Feedback" button on every signed-in page files a note with the page it came from
-- (path, title, window size, browser), up to six screenshots and up to two screen recordings
-- with the person's voice. Every note lands in Help & Support › Feedback with status PENDING
-- (OPEN), and becomes a conversation: the status always says whose turn it is —
--   the team replies          -> ANSWERED (waiting on the reporter)
--   the reporter replies      -> OPEN again, even from RESOLVED
--   the reporter accepts      -> RESOLVED
--   the team closes           -> RESOLVED or WONT_FIX (a reply never undoes WONT_FIX)
--
-- Who sees what (enforced in ONE query scope in FeedbackService): everyone may file; a reporter
-- sees only their own notes; holders of feedback.manage (the team) see and answer all of them.

CREATE SEQUENCE IF NOT EXISTS feedback_reference_seq START 1;   -- FB-2026-001

CREATE TABLE IF NOT EXISTS feedback (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  reference    VARCHAR(20) NOT NULL UNIQUE,
  -- the route, never the full URL: a query string can carry ids we'd rather not copy here
  page_path    VARCHAR(512) NOT NULL CHECK (left(page_path, 1) = '/'),
  page_title   VARCHAR(200) NULL,
  message      TEXT NOT NULL CHECK (char_length(message) BETWEEN 3 AND 4000),
  kind         VARCHAR(12) NOT NULL DEFAULT 'ISSUE' CHECK (kind IN ('ISSUE', 'SUGGESTION', 'QUESTION', 'PRAISE')),
  status       VARCHAR(14) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'ANSWERED', 'RESOLVED', 'WONT_FIX')),
  created_by   BIGINT NOT NULL REFERENCES "user"(id),      -- from the session, never the request
  branch_id    BIGINT NULL REFERENCES branch(id),          -- the reporter's branch when filed
  viewport     VARCHAR(32) NULL,                           -- 1440x765: half of "it looks broken"
  user_agent   VARCHAR(400) NULL,
  resolved_by  BIGINT NULL REFERENCES "user"(id),
  resolved_at  TIMESTAMPTZ NULL,
  resolution   TEXT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_status_created ON feedback (status, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_page ON feedback (page_path);
CREATE INDEX IF NOT EXISTS idx_feedback_author ON feedback (created_by);

-- The thread. Never edited, never deleted: a thread somebody can rewrite is not a record of
-- what was agreed. is_answer = said by the team (or posted as the team's answer).
CREATE TABLE IF NOT EXISTS feedback_message (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feedback_id  BIGINT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  author_id    BIGINT NOT NULL REFERENCES "user"(id),
  body         TEXT NOT NULL CHECK (char_length(body) BETWEEN 2 AND 4000),
  is_answer    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_message_thread ON feedback_message (feedback_id, created_at);

CREATE OR REPLACE FUNCTION feedback_message_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Feedback messages are never edited or deleted';
END
$$;
DROP TRIGGER IF EXISTS trg_feedback_message_immutable ON feedback_message;
CREATE TRIGGER trg_feedback_message_immutable BEFORE UPDATE OR DELETE ON feedback_message
  FOR EACH ROW EXECUTE FUNCTION feedback_message_immutable();

-- Screenshots (PNG / JPEG / WebP / HEIC, 8 MB, 6 per note) and screen recordings (WebM / MP4,
-- 50 MB, 2 per note), type checked by their bytes. Cloudflare R2 (private, served by short-lived
-- signed links) when configured, else the bytes in `content`.
CREATE TABLE IF NOT EXISTS feedback_attachment (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feedback_id  BIGINT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  kind         VARCHAR(10) NOT NULL CHECK (kind IN ('image', 'video')),
  file_name    VARCHAR(255) NOT NULL,
  mime         VARCHAR(80) NOT NULL,
  size_bytes   BIGINT NOT NULL,
  r2_key       VARCHAR(400) NULL,
  content      BYTEA NULL,
  uploaded_by  BIGINT NOT NULL REFERENCES "user"(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_attachment_note ON feedback_attachment (feedback_id, created_at);

-- The team: sees every note, answers, closes. Filing, reading your own notes, replying on them
-- and accepting an answer need no permission at all — everyone who can sign in may do those.
INSERT INTO permission (key, module, action) VALUES ('feedback.manage', 'feedback', 'manage')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permission (role_id, permission_id, record_scope)
SELECT r.id, p.id, 'all'
  FROM role r CROSS JOIN permission p
 WHERE r.name IN ('Super Admin', 'Organization Admin') AND p.key = 'feedback.manage'
ON CONFLICT (role_id, permission_id) DO NOTHING;
