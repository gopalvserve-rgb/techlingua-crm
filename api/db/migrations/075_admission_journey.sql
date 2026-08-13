-- =============================================================================
-- 075 — ADMISSION JOURNEY (the intake funnel + approval/confirmation gates)
--
-- Client spec: the student profile is missing an Admission Journey. The admission funnel is
--   Lead -> Course -> Payment -> Invoice/Receipt -> admission & payment APPROVED BY AN
--   AUTHORIZED PERSON -> CONFIRMATION FROM STUDENT -> CONVERT TO ADMISSION.
--
-- MODEL: an `admission_stage` dimension ON THE ENROLMENT (an enrolment = a student's course
-- admission), orthogonal to the academic-lifecycle `course_status` (074) and the sale `status`.
--   stages: lead -> course_selected -> payment_received -> invoiced -> approved ->
--            student_confirmed -> admitted, plus `rejected` (with remarks).
--
-- EARLY stages (lead / course_selected / payment_received / invoiced) are DERIVED at read time
-- from existing linked data (the originating lead, the enrolment's course, fee_receipt rows, a
-- gst_invoice) — they are NOT persisted or auto-advanced, so no risky wiring into the payment /
-- invoice create paths. Only the WORKFLOW stages from `approved` onward are PERSISTED on the
-- enrolment by the transition endpoints. `admission_stage` therefore holds `course_selected`
-- for a new enrolment until an authorized approval bumps it to `approved`.
--
-- EXISTING enrolments are GRANDFATHERED to `admitted` (backfill) so nothing regresses.
--
-- Idempotent throughout (IF NOT EXISTS / guarded / ON CONFLICT). Re-runnable.
-- =============================================================================

-- 1 ------------------------------------------------ admission_stage + workflow metadata
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS admission_stage             VARCHAR(24) NOT NULL DEFAULT 'course_selected';
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS admission_approved_by       BIGINT NULL REFERENCES "user"(id);
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS admission_approved_at       TIMESTAMPTZ NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS admission_approval_remarks  TEXT NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS student_confirmed_at        TIMESTAMPTZ NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS student_confirmed_via       VARCHAR(24) NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS student_confirmation_note   TEXT NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS confirmation_captured_by    BIGINT NULL REFERENCES "user"(id);
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS admitted_at                 TIMESTAMPTZ NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS admitted_by                 BIGINT NULL REFERENCES "user"(id);
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS admission_rejected_reason   TEXT NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS admission_rejected_by       BIGINT NULL REFERENCES "user"(id);
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS admission_rejected_at       TIMESTAMPTZ NULL;

-- Grandfather EVERY existing enrolment to `admitted` (they were already live admissions). Only
-- rows still at the fresh default are touched, so re-running never demotes a mid-journey row.
UPDATE enrolment
   SET admission_stage = 'admitted',
       admitted_at = COALESCE(admitted_at, updated_at, created_at)
 WHERE admission_stage = 'course_selected';

-- CHECK constraint over the stage vocabulary (added after rows conform).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrolment_admission_stage_chk') THEN
    ALTER TABLE enrolment
      ADD CONSTRAINT enrolment_admission_stage_chk CHECK (admission_stage IN
        ('lead','course_selected','payment_received','invoiced','approved','student_confirmed','admitted','rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_enrolment_admission_stage ON enrolment (admission_stage) WHERE deleted_at IS NULL;

-- 2 ------------------------------------------------ the admission-journey audit / history
CREATE TABLE IF NOT EXISTS admission_event (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  branch_id     BIGINT NULL REFERENCES branch(id),
  vertical_id   BIGINT NULL REFERENCES vertical(id),
  enrolment_id  BIGINT NOT NULL REFERENCES enrolment(id),
  student_id    BIGINT NULL REFERENCES student(id),
  stage         VARCHAR(24) NOT NULL,
  note          TEXT NULL,
  changed_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admission_event_enrol ON admission_event (enrolment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admission_event_student ON admission_event (student_id, created_at DESC);

-- 3 ------------------------------------------------ permission admission.approve + grants
INSERT INTO permission (key, module, action) VALUES
  ('admission.approve', 'admission', 'approve')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('admission.approve', 'Academic Admin',     'branch'),
      ('admission.approve', 'Branch Manager',     'branch'),
      ('admission.approve', 'Organization Admin', 'all'),
      ('admission.approve', 'Super Admin',        'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 4 --------------------------------- [DEMO] seed: a mid-journey admission awaiting approval
DO $$
DECLARE
  v_admin  BIGINT;
  v_org    BIGINT;
  v_enr    BIGINT;
  v_stu    BIGINT;
  v_lead   BIGINT;
  v_branch BIGINT;
  v_vert   BIGINT;
  v_net    BIGINT;
  v_name   TEXT;
BEGIN
  SELECT id FROM organisation ORDER BY id LIMIT 1 INTO v_org;
  SELECT id FROM "user" WHERE deleted_at IS NULL ORDER BY id LIMIT 1 INTO v_admin;

  SELECT e.id, e.student_profile_id, e.lead_id, e.branch_id, e.vertical_id, e.net_fee_minor
    FROM enrolment e
   WHERE e.enrolment_no LIKE 'ENR-DEMO-%' AND e.deleted_at IS NULL
   ORDER BY e.id DESC LIMIT 1
   INTO v_enr, v_stu, v_lead, v_branch, v_vert, v_net;

  IF v_enr IS NOT NULL THEN
    UPDATE enrolment SET admission_stage = 'invoiced', admitted_at = NULL, updated_at = now()
      WHERE id = v_enr AND admission_stage IN ('admitted','course_selected');

    IF NOT EXISTS (SELECT 1 FROM fee_receipt WHERE receipt_no = 'RCPT-ADMJ-DEMO') THEN
      INSERT INTO fee_receipt (org_id, receipt_no, enrolment_id, lead_id, branch_id, vertical_id,
                               amount_minor, mode, reference, received_at, received_by, note)
      VALUES (v_org, 'RCPT-ADMJ-DEMO', v_enr, v_lead, v_branch, v_vert,
              GREATEST(COALESCE(v_net,3000000)/2, 100), 'upi', 'DEMO-UPI-REF', now(), v_admin, '[DEMO] admission-journey part payment');
    END IF;

    SELECT COALESCE(s.full_name, l.full_name, '[DEMO] Admission Journey')
      FROM enrolment e
      LEFT JOIN student s ON s.id = e.student_profile_id
      LEFT JOIN lead l ON l.id = e.lead_id
     WHERE e.id = v_enr INTO v_name;
    IF NOT EXISTS (SELECT 1 FROM gst_invoice WHERE invoice_no = 'INV-ADMJ-DEMO') THEN
      INSERT INTO gst_invoice (org_id, invoice_no, invoice_date, status, enrolment_id, student_id,
                               branch_id, vertical_id, buyer_name, taxable_minor, total_minor,
                               issued_at, issued_by, created_by)
      VALUES (v_org, 'INV-ADMJ-DEMO', CURRENT_DATE, 'issued', v_enr, v_stu,
              v_branch, v_vert, COALESCE(v_name,'[DEMO]'), COALESCE(v_net,3000000), COALESCE(v_net,3000000),
              now(), v_admin, v_admin);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM admission_event WHERE enrolment_id = v_enr AND stage = 'invoiced') THEN
      INSERT INTO admission_event (org_id, branch_id, vertical_id, enrolment_id, student_id, stage, note, changed_by)
      VALUES (v_org, v_branch, v_vert, v_enr, v_stu, 'invoiced', '[DEMO] Payment received + invoice generated — awaiting authorized approval', v_admin);
    END IF;
  END IF;
END $$;
