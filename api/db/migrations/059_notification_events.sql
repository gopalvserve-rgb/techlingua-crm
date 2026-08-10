-- ===========================================================================
-- 059 — NOTIFICATION EVENTS
--
-- A user-friendly, curated layer OVER the Sprint-4 notifier/messaging stack. The
-- client works in terms of business EVENTS ("a payment succeeded", "a certificate
-- was issued"), not journeys. This migration gives them:
--
--   1) notification_event         a fixed CATALOG of the 37 standard events, each with
--                                 a category, a trigger description, the recipient it
--                                 targets, whether its trigger is wired to a live event
--                                 yet, and the client's DEFAULT per-channel flags.
--   2) notification_event_config  the admin's CHOICE per event (org-wide, or overridden
--                                 per vertical): which of SMS / Email / WhatsApp is ON,
--                                 and which message_template to send on each channel.
--   3) permissions                notification_event.read / update / manage + grants.
--
-- Idempotent: safe to run on every deploy. The catalog is upserted from constants; the
-- org-wide config rows are seeded to the catalog defaults only when absent, so re-running
-- never clobbers an admin's saved toggles or template mappings.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS notification_event (
  id              BIGSERIAL PRIMARY KEY,
  event_key       VARCHAR(64)  NOT NULL UNIQUE,
  name            VARCHAR(120) NOT NULL,
  trigger_desc    VARCHAR(200) NOT NULL,
  category        VARCHAR(24)  NOT NULL,
  recipient       VARCHAR(16)  NOT NULL DEFAULT 'lead',
  trigger_status  VARCHAR(16)  NOT NULL DEFAULT 'pending',
  default_sms      BOOLEAN NOT NULL DEFAULT FALSE,
  default_email    BOOLEAN NOT NULL DEFAULT FALSE,
  default_whatsapp BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_event_config (
  id                   BIGSERIAL PRIMARY KEY,
  org_id               BIGINT NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  event_key            VARCHAR(64) NOT NULL REFERENCES notification_event(event_key) ON DELETE CASCADE,
  vertical_id          BIGINT REFERENCES vertical(id) ON DELETE CASCADE,
  sms_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  email_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  sms_template_id      BIGINT REFERENCES message_template(id) ON DELETE SET NULL,
  email_template_id    BIGINT REFERENCES message_template(id) ON DELETE SET NULL,
  whatsapp_template_id BIGINT REFERENCES message_template(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_event_config
  ON notification_event_config (org_id, event_key, COALESCE(vertical_id, -1));
CREATE INDEX IF NOT EXISTS idx_notif_event_config_event
  ON notification_event_config (event_key);

INSERT INTO notification_event
  (event_key, name, trigger_desc, category, recipient, trigger_status,
   default_sms, default_email, default_whatsapp, sort_order)
VALUES
  ('new_lead_created',      'New Lead Created',      'Lead created',                 'Leads', 'lead',       'wired',   TRUE,  TRUE,  TRUE,   10),
  ('lead_assigned',         'Lead Assigned',         'Counselor assigned',           'Leads', 'lead',       'wired',   FALSE, FALSE, TRUE,   20),
  ('counselling_scheduled', 'Counselling Scheduled', 'Appointment created',          'Leads', 'lead',       'pending', TRUE,  TRUE,  TRUE,   30),
  ('counselling_reminder',  'Counselling Reminder',  'Before appointment',           'Leads', 'lead',       'pending', TRUE,  TRUE,  TRUE,   40),
  ('demo_scheduled',        'Demo/Class Scheduled',  'Demo created',                 'Leads', 'lead',       'pending', TRUE,  TRUE,  TRUE,   50),
  ('demo_reminder',         'Demo Reminder',         'Before demo',                  'Leads', 'lead',       'pending', TRUE,  TRUE,  TRUE,   60),
  ('lead_converted',        'Lead Converted',        'Admission created',            'Leads', 'lead',       'wired',   TRUE,  TRUE,  TRUE,   70),
  ('enrollment_created',    'Enrollment Created',    'Student enrolled',             'Academics', 'student', 'wired',   TRUE,  TRUE,  TRUE,   80),
  ('batch_assigned',        'Batch Assigned',        'Batch assigned',               'Academics', 'student', 'pending',   TRUE,  TRUE,  TRUE,   90),
  ('batch_changed',         'Batch Changed',         'Batch updated',                'Academics', 'student', 'pending',   TRUE,  TRUE,  TRUE,  100),
  ('course_start_reminder', 'Course Start Reminder', 'X days before start',          'Academics', 'student', 'pending', TRUE,  TRUE,  TRUE,  110),
  ('student_welcome',       'Student Welcome',       'Admission completed',          'Academics', 'student', 'pending', TRUE,  TRUE,  TRUE,  120),
  ('birthday',              'Birthday',              'Student DOB',                  'Academics', 'student', 'pending', FALSE, TRUE,  TRUE,  130),
  ('batch_starts',          'Batch Starts',          'X days before',                'Academics', 'student', 'pending', TRUE,  TRUE,  TRUE,  140),
  ('class_cancelled',       'Class Cancelled',       'Class cancelled',              'Academics', 'student', 'pending', TRUE,  TRUE,  TRUE,  150),
  ('class_rescheduled',     'Class Rescheduled',     'Schedule changed',             'Academics', 'student', 'pending', TRUE,  TRUE,  TRUE,  160),
  ('course_completed',      'Course Completed',      'Completion=100%',              'Academics', 'student', 'pending', TRUE,  TRUE,  TRUE,  170),
  ('course_expiring',       'Course Expiring',       'X days remaining',             'Academics', 'student', 'pending', FALSE, TRUE,  TRUE,  180),
  ('fee_invoice_generated', 'Fee Invoice Generated', 'Invoice generated',            'Fees', 'student',     'pending',   TRUE,  TRUE,  TRUE,  190),
  ('payment_successful',    'Payment Successful',    'Payment completed',            'Fees', 'student',     'pending',   TRUE,  TRUE,  TRUE,  200),
  ('payment_failed',        'Payment Failed',        'Payment failed',               'Fees', 'student',     'pending',   TRUE,  TRUE,  TRUE,  210),
  ('receipt_generated',     'Receipt Generated',     'Receipt generated',            'Fees', 'student',     'pending',   FALSE, TRUE,  TRUE,  220),
  ('installment_due_soon',  'Installment Due Soon',  'X days before due',            'Fees', 'student',     'pending',   TRUE,  TRUE,  TRUE,  230),
  ('installment_due_today', 'Installment Due Today', 'Due date=today',               'Fees', 'student',     'pending',   TRUE,  TRUE,  TRUE,  240),
  ('payment_overdue',       'Payment Overdue',       'Due date passed',              'Fees', 'student',     'pending',   TRUE,  TRUE,  TRUE,  250),
  ('refund_initiated',      'Refund Initiated',      'Refund created',               'Fees', 'student',     'pending',   FALSE, TRUE,  TRUE,  260),
  ('refund_completed',      'Refund Completed',      'Refund completed',             'Fees', 'student',     'pending',   FALSE, TRUE,  TRUE,  270),
  ('fee_fully_paid',        'Fee Fully Paid',        'Balance=0',                    'Fees', 'student',     'pending',   TRUE,  TRUE,  TRUE,  280),
  ('student_absent',        'Student Absent',        'Attendance=Absent',            'Academics', 'student', 'pending',   TRUE,  FALSE, TRUE,  290),
  ('exam_scheduled',        'Exam Scheduled',        'Exam created',                 'Academics', 'student', 'pending', TRUE,  TRUE,  TRUE,  300),
  ('exam_reminder',         'Exam Reminder',         'X days before',                'Academics', 'student', 'pending', TRUE,  TRUE,  TRUE,  310),
  ('exam_rescheduled',      'Exam Rescheduled',      'Date changed',                 'Academics', 'student', 'pending', TRUE,  TRUE,  TRUE,  320),
  ('certificate_generated', 'Certificate Generated', 'Certificate created',          'Certificates', 'student', 'pending',   FALSE, TRUE,  TRUE,  330),
  ('certificate_issued',    'Certificate Issued',    'Status=Issued',                'Certificates', 'student', 'pending',   TRUE,  TRUE,  TRUE,  340),
  ('certificate_ready',     'Certificate Ready',     'File generated',               'Certificates', 'student', 'pending',   FALSE, TRUE,  TRUE,  350),
  ('call_connected',        'Call Connected',        'Mark contact status=Connected','Calls', 'lead',       'pending', TRUE,  TRUE,  TRUE,  360),
  ('call_not_connected',    'Call Not Connected',    'Create retry task',            'Calls', 'lead',       'pending', TRUE,  TRUE,  TRUE,  370)
ON CONFLICT (event_key) DO UPDATE SET
  name = EXCLUDED.name, trigger_desc = EXCLUDED.trigger_desc, category = EXCLUDED.category,
  recipient = EXCLUDED.recipient, trigger_status = EXCLUDED.trigger_status,
  default_sms = EXCLUDED.default_sms, default_email = EXCLUDED.default_email,
  default_whatsapp = EXCLUDED.default_whatsapp, sort_order = EXCLUDED.sort_order;

INSERT INTO notification_event_config
  (org_id, event_key, vertical_id, sms_enabled, email_enabled, whatsapp_enabled)
SELECT o.id, e.event_key, NULL, e.default_sms, e.default_email, e.default_whatsapp
  FROM organisation o
  CROSS JOIN notification_event e
 WHERE NOT EXISTS (
   SELECT 1 FROM notification_event_config c
    WHERE c.org_id = o.id AND c.event_key = e.event_key AND c.vertical_id IS NULL
 );

INSERT INTO permission (key, module, action) VALUES
  ('notification_event.read',   'notification_event', 'read'),
  ('notification_event.update', 'notification_event', 'update'),
  ('notification_event.manage', 'notification_event', 'manage')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('notification_event.read',   'Super Admin',        'all'),
      ('notification_event.read',   'Organization Admin', 'all'),
      ('notification_event.read',   'Marketing Manager',  'all'),
      ('notification_event.read',   'Branch Manager',     'branch'),
      ('notification_event.read',   'Vertical Manager',   'vertical'),
      ('notification_event.update', 'Super Admin',        'all'),
      ('notification_event.update', 'Organization Admin', 'all'),
      ('notification_event.update', 'Marketing Manager',  'all'),
      ('notification_event.manage', 'Super Admin',        'all'),
      ('notification_event.manage', 'Organization Admin', 'all'),
      ('notification_event.manage', 'Marketing Manager',  'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
