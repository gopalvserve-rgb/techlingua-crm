-- ===========================================================================
-- 133 — Client 11 Nov 2026 ("Development Requirements — 11 Nov")
--
--   A) TRAINING MODE on the enrolment and the student (Convert to Student, Sale Closure,
--      Admissions & Enrolment and Edit Student all offer the Training Mode master).
--   B) lead.search — a SEPARATE permission: a user who works only his own leads may still
--      SEARCH every lead (to see if a caller is already a lead, and whose it is).
--   C) STAFF NOTIFICATION SETTINGS (Administration › Notification Settings): one rule per
--      business event — on/off, bell, toast pop-up, sound, desktop, email, WhatsApp, which
--      roles receive it, priority, WHEN it goes (delay / minutes before / after) and
--      HIERARCHY escalation (to the person's Reports-To manager, then theirs …) when it is
--      not actioned in time. Plus a queue for delayed sends / escalations.
-- Idempotent: safe on every deploy; an admin's saved choices are never overwritten.
-- ===========================================================================

-- A) training mode ------------------------------------------------------------
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS training_mode VARCHAR(80);
ALTER TABLE student   ADD COLUMN IF NOT EXISTS training_mode VARCHAR(80);

-- B) lead.search ------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES ('lead.search', 'lead', 'search')
ON CONFLICT (key) DO NOTHING;
-- Admins search everything; every other role that can read leads may search its BRANCH
-- (widen to "All" per role in Roles & Permissions).
INSERT INTO role_permission (role_id, permission_id, record_scope)
SELECT DISTINCT rp.role_id, ps.id,
       CASE WHEN r.name IN ('Super Admin', 'Organization Admin') OR rp.record_scope = 'all' THEN 'all' ELSE 'branch' END
  FROM role_permission rp
  JOIN permission pr ON pr.id = rp.permission_id AND pr.key = 'lead.read'
  JOIN role r ON r.id = rp.role_id
  CROSS JOIN (SELECT id FROM permission WHERE key = 'lead.search') ps
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- C) staff notification rules -----------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_notif_rule (
  event_key     VARCHAR(48) PRIMARY KEY,
  module        VARCHAR(24) NOT NULL,
  name          VARCHAR(80) NOT NULL,          -- the create event ("New Lead")
  message       VARCHAR(120) NOT NULL,         -- the notification ("Lead created")
  timing_kind   VARCHAR(8)  NOT NULL DEFAULT 'instant' CHECK (timing_kind IN ('instant', 'before', 'at', 'after')),
  sort_order    INT NOT NULL DEFAULT 0,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  in_app        BOOLEAN NOT NULL DEFAULT TRUE,
  toast         BOOLEAN NOT NULL DEFAULT TRUE,
  sound         BOOLEAN NOT NULL DEFAULT FALSE,
  desktop       BOOLEAN NOT NULL DEFAULT FALSE,
  email         BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp      BOOLEAN NOT NULL DEFAULT FALSE,
  priority      VARCHAR(8)  NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  delay_minutes INT NOT NULL DEFAULT 0 CHECK (delay_minutes BETWEEN 0 AND 10080),
  notify_owner  BOOLEAN NOT NULL DEFAULT TRUE,  -- the assigned user (counsellor / trainer / owner)
  role_ids      BIGINT[] NOT NULL DEFAULT '{}', -- plus everyone holding these roles (in the record's branch)
  escalate      BOOLEAN NOT NULL DEFAULT FALSE,
  escalate_after_minutes INT NOT NULL DEFAULT 30 CHECK (escalate_after_minutes BETWEEN 1 AND 10080),
  escalate_levels INT NOT NULL DEFAULT 1 CHECK (escalate_levels BETWEEN 1 AND 5),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT
);

-- catalog: module, event, notification, timing kind, default priority / delay / escalation.
-- ON CONFLICT only refreshes the LABELS — toggles an admin saved are left alone.
INSERT INTO staff_notif_rule (event_key, module, name, message, timing_kind, sort_order, priority, delay_minutes, sound, desktop, escalate, escalate_after_minutes)
VALUES
  ('lead_created',        'CRM',        'New Lead',             'Lead created',          'instant',  10, 'medium',   0, FALSE, FALSE, FALSE, 30),
  ('lead_assigned',       'CRM',        'Lead Assigned',        'New lead assigned',     'instant',  20, 'high',     0, TRUE,  TRUE,  FALSE, 30),
  ('followup_scheduled',  'CRM',        'Follow-up',            'Follow-up scheduled',   'instant',  30, 'medium',   0, FALSE, FALSE, FALSE, 30),
  ('new_enquiry',         'CRM',        'New Enquiry',          'Enquiry received',      'instant',  40, 'medium',   0, FALSE, FALSE, FALSE, 30),
  ('followup_upcoming',   'CRM',        'Upcoming follow-up',   'Follow-up due soon',    'before',   50, 'medium',  15, TRUE,  TRUE,  FALSE, 30),
  ('followup_due',        'CRM',        'Follow-up due now',    'Follow-up due now',     'at',       60, 'high',     0, TRUE,  TRUE,  FALSE, 30),
  ('followup_overdue',    'CRM',        'Follow-up missed',     'Follow-up overdue',     'after',    70, 'critical', 30, TRUE,  TRUE,  TRUE,  60),
  ('application_created', 'Admissions', 'New Application',      'Application created',   'instant',  80, 'medium',   0, FALSE, FALSE, FALSE, 30),
  ('student_registered',  'Students',   'New Student',          'Student registered',    'instant',  90, 'medium',   0, FALSE, FALSE, FALSE, 30),
  ('enrolment_completed', 'Students',   'Course Enrolment',     'Enrolment completed',   'instant', 100, 'medium',   0, FALSE, FALSE, FALSE, 30),
  ('invoice_generated',   'Finance',    'Fee Invoice',          'Invoice generated',     'instant', 110, 'low',      0, FALSE, FALSE, FALSE, 30),
  ('payment_received',    'Finance',    'Fee Receipt',          'Payment received',      'instant', 120, 'medium',   0, TRUE,  FALSE, FALSE, 30),
  ('refund_initiated',    'Finance',    'Refund',               'Refund initiated',      'instant', 130, 'high',     0, FALSE, FALSE, FALSE, 30),
  ('fee_due',             'Finance',    'Fee due',              'Fee due today',         'instant', 140, 'medium',   0, FALSE, FALSE, FALSE, 30),
  ('fee_overdue',         'Finance',    'Fee over due',         'Fee overdue',           'after',   150, 'high',  1440, FALSE, FALSE, TRUE, 1440),
  ('batch_created',       'Academics',  'New Batch',            'Batch created',         'instant', 160, 'low',      0, FALSE, FALSE, FALSE, 30),
  ('timetable_published', 'Academics',  'New Timetable',        'Timetable published',   'instant', 170, 'medium',   0, FALSE, FALSE, FALSE, 30),
  ('attendance_recorded', 'Attendance', 'Attendance Submitted', 'Attendance recorded',   'instant', 180, 'low',      0, FALSE, FALSE, FALSE, 30)
ON CONFLICT (event_key) DO UPDATE SET
  module = EXCLUDED.module, name = EXCLUDED.name, message = EXCLUDED.message,
  timing_kind = EXCLUDED.timing_kind, sort_order = EXCLUDED.sort_order;

-- master switches (per module + per channel) — the screen's top card.
INSERT INTO app_setting (key, value) VALUES
  ('staff_notif_global', '{"modules": {"CRM": true, "Admissions": true, "Students": true, "Finance": true, "Academics": true, "Attendance": true},
                           "toast": true, "sound": true, "desktop": true, "email": true, "whatsapp": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- delayed sends + hierarchy escalations. A row is CLAIMED (sent_at) by the worker exactly once.
CREATE TABLE IF NOT EXISTS staff_notif_queue (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key     VARCHAR(48) NOT NULL,
  user_id       BIGINT NOT NULL,          -- level 0: the recipient · level ≥1: the person escalated FROM
  level         INT NOT NULL DEFAULT 0,
  due_at        TIMESTAMPTZ NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  parent_notification_id BIGINT,          -- escalation fires only while this stays unread …
  cond          VARCHAR(48),              -- … or while e.g. 'followup:<id>' is still pending
  sent_at       TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_staff_notif_queue_due ON staff_notif_queue (due_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- once-only guard for repeatable instants (an instalment's due day, an overdue day …)
CREATE TABLE IF NOT EXISTS staff_notif_sent (
  dedupe_key VARCHAR(160) PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- follow-up "due now" claim (the upcoming reminder already has reminded_at)
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS due_notified_at TIMESTAMPTZ;

-- the bell's popups need the priority without parsing meta
ALTER TABLE notification ADD COLUMN IF NOT EXISTS priority VARCHAR(8);

-- events that often have NO owner (a public application, a refund request …) also go to the
-- branch's managers by default — only while the admin has never edited the rule.
UPDATE staff_notif_rule r
   SET role_ids = ARRAY(SELECT id FROM role WHERE name IN ('Branch Manager', 'Organization Admin') AND deleted_at IS NULL ORDER BY id)
 WHERE r.event_key IN ('application_created', 'refund_initiated', 'fee_overdue')
   AND r.updated_by IS NULL AND r.role_ids = '{}';
