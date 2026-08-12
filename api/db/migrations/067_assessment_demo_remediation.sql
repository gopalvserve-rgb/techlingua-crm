-- 067  ASSESSMENT DEMO REMEDIATION (docs/dev/64)
-- ---------------------------------------------------------------------------------------------
-- Four gaps the independent tester found in the live Assessment demo, fixed idempotently. This
-- migration touches ONLY clearly-marked [DEMO] data and is safe to run repeatedly and on a fresh
-- DB (every block is guarded; nothing here is client data).
--
--   GAP 1  demo image_mcq / audio_mcq had NULL media -> point them at fixed R2 keys (the bytes are
--          uploaded by the one-shot POST /questions/seed-demo-media, which writes the SAME keys).
--   GAP 2  restore the demo student to a batch (roster non-empty), reset the tester-evaluated
--          writing attempt back to pending, add a few more demo students, and add a demo PRACTICE
--          test (published, max_attempts 5, no subjective) the take-test player can actually run.
--   GAP 4  leaves the evaluated A+ attempt / certificate / verify code untouched (self-consistent).
-- ---------------------------------------------------------------------------------------------

-- 1 ------------------------------------------------------ GAP 1: demo media keys (fixed R2 keys)
DO $$
DECLARE
  q_img BIGINT; q_aud BIGINT;
BEGIN
  SELECT id INTO q_img FROM question
    WHERE q_type = 'image_mcq' AND deleted_at IS NULL AND tags @> ARRAY['demo','image']::text[]
    ORDER BY id LIMIT 1;
  IF q_img IS NOT NULL THEN
    UPDATE question SET image_r2_key = 'questions/media/demo/binary-tree-diagram.png', updated_at = now()
      WHERE id = q_img AND image_r2_key IS NULL;
  END IF;

  SELECT id INTO q_aud FROM question
    WHERE q_type = 'audio_mcq' AND deleted_at IS NULL AND tags @> ARRAY['demo','listening']::text[]
    ORDER BY id LIMIT 1;
  IF q_aud IS NOT NULL THEN
    UPDATE question SET audio_r2_key = 'questions/media/demo/listening-clip-their.wav', updated_at = now()
      WHERE id = q_aud AND audio_r2_key IS NULL;
  END IF;
END $$;

-- 2 ------------------------------- GAP 2: batch roster, attempt reset, students, practice test
DO $$
DECLARE
  v_org BIGINT; v_student BIGINT; v_branch BIGINT; v_vertical BIGINT; v_course BIGINT;
  v_pipeline BIGINT; v_campaign BIGINT; v_source BIGINT;
  v_batch BIGINT;
  a_assign BIGINT; att_pending BIGINT;
  v_cat_it BIGINT; v_cat_lang BIGINT;
  a_practice BIGINT; v_total NUMERIC; ord INT; q RECORD;
  s RECORD; v_lead BIGINT; v_new BIGINT;
  demo_students TEXT[][] := ARRAY[
    ARRAY['DEMO-STU-101','[DEMO] Meera Nair','+919000000101','demo.meera@techlingua.in'],
    ARRAY['DEMO-STU-102','[DEMO] Arjun Rao','+919000000102','demo.arjun@techlingua.in'],
    ARRAY['DEMO-STU-103','[DEMO] Priya Menon','+919000000103','demo.priya@techlingua.in']
  ];
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;

  -- The demo cohort = the student who owns the seeded evaluated IT-mock attempt ("Subash" on live,
  -- the first student on a fresh DB). Stable handle that survives the tester's transfer.
  SELECT at.student_id, at.branch_id, at.vertical_id
    INTO v_student, v_branch, v_vertical
    FROM assessment_attempt at
    JOIN assessment a ON a.id = at.assessment_id
   WHERE at.org_id = v_org AND a.title = '[DEMO] IT Fundamentals Mock Test'
     AND at.deleted_at IS NULL
   ORDER BY at.id LIMIT 1;
  IF v_student IS NULL THEN RETURN; END IF;
  -- fall back to the student's own branch/vertical if the attempt did not carry them
  IF v_branch IS NULL OR v_vertical IS NULL THEN
    SELECT branch_id, vertical_id INTO v_branch, v_vertical FROM student WHERE id = v_student;
  END IF;

  -- resolve a course for a batch (m_course is org-scoped): the student's course, else any batch's, else any active course
  SELECT COALESCE(
    (SELECT course_id FROM student WHERE id = v_student AND course_id IS NOT NULL),
    (SELECT course_id FROM batch WHERE org_id = v_org AND branch_id = v_branch AND deleted_at IS NULL ORDER BY id LIMIT 1),
    (SELECT id FROM m_course WHERE org_id = v_org AND is_active ORDER BY sort_order, id LIMIT 1)
  ) INTO v_course;

  -- (a) resolve / ensure the demo batch. Prefer the tester's "Test batch"; else the demo batch; else create it.
  SELECT id INTO v_batch FROM batch
    WHERE org_id = v_org AND deleted_at IS NULL AND lower(name) = lower('Test batch') ORDER BY id LIMIT 1;
  IF v_batch IS NULL THEN
    SELECT id INTO v_batch FROM batch
      WHERE org_id = v_org AND deleted_at IS NULL AND name = '[DEMO] Assessment Batch' ORDER BY id LIMIT 1;
  END IF;
  IF v_batch IS NULL AND v_course IS NOT NULL THEN
    INSERT INTO batch (org_id, batch_code, name, branch_id, vertical_id, course_id, capacity, status)
      VALUES (v_org, 'DEMO-BATCH-1', '[DEMO] Assessment Batch', v_branch, v_vertical, v_course, 30, 'active')
      RETURNING id INTO v_batch;
  END IF;

  -- (b) restore the demo student to the batch (roster non-empty -> P/A/H/L/E buttons render)
  IF v_batch IS NOT NULL THEN
    UPDATE student SET batch_id = v_batch, updated_at = now()
      WHERE id = v_student AND batch_id IS DISTINCT FROM v_batch AND deleted_at IS NULL;
  END IF;

  -- (c) add a few more [DEMO] students in the same branch/vertical/batch (guarded by student_no)
  SELECT id INTO v_pipeline FROM pipeline WHERE deleted_at IS NULL ORDER BY id LIMIT 1;
  SELECT id INTO v_campaign FROM campaign WHERE deleted_at IS NULL ORDER BY id LIMIT 1;
  SELECT id INTO v_source   FROM source   WHERE deleted_at IS NULL ORDER BY id LIMIT 1;
  IF v_pipeline IS NOT NULL AND v_campaign IS NOT NULL AND v_source IS NOT NULL THEN
    FOR i IN 1 .. array_length(demo_students, 1) LOOP
      IF NOT EXISTS (SELECT 1 FROM student WHERE org_id = v_org AND student_no = demo_students[i][1]) THEN
        INSERT INTO lead (org_id, branch_id, vertical_id, pipeline_id, campaign_id, source_id, full_name, phone, email)
          VALUES (v_org, v_branch, v_vertical, v_pipeline, v_campaign, v_source,
                  demo_students[i][2], demo_students[i][3], demo_students[i][4])
          RETURNING id INTO v_lead;
        INSERT INTO student (org_id, student_no, lead_id, full_name, phone, email, branch_id, vertical_id,
                             course_id, batch_id, status, remarks)
          VALUES (v_org, demo_students[i][1], v_lead, demo_students[i][2], demo_students[i][3], demo_students[i][4],
                  v_branch, v_vertical, v_course, v_batch, 'active',
                  '[DEMO] added for Assessment remediation (docs/dev/64)');
      END IF;
    END LOOP;
  END IF;

  -- (d) reset the tester-evaluated demo WRITING attempt back to submitted / pending-evaluation
  SELECT id INTO a_assign FROM assessment
    WHERE org_id = v_org AND title = '[DEMO] Formal Email — Writing Assignment' AND deleted_at IS NULL
    ORDER BY id LIMIT 1;
  IF a_assign IS NOT NULL THEN
    SELECT id INTO att_pending FROM assessment_attempt
      WHERE org_id = v_org AND assessment_id = a_assign AND student_id = v_student AND deleted_at IS NULL
      ORDER BY id LIMIT 1;
    IF att_pending IS NOT NULL THEN
      -- only act when it is NOT already in the pending state (idempotent)
      UPDATE assessment_attempt
         SET status = 'submitted', manual_score = NULL, total_score = NULL, is_passed = NULL,
             evaluated_by = NULL, evaluated_at = NULL, grade_label = NULL, percentage = NULL,
             auto_score = 0, updated_at = now()
       WHERE id = att_pending
         AND (status <> 'submitted' OR total_score IS NOT NULL OR manual_score IS NOT NULL OR evaluated_at IS NOT NULL);
      UPDATE attempt_answer
         SET evaluator_marks = NULL, evaluator_feedback = NULL
       WHERE attempt_id = att_pending
         AND (evaluator_marks IS NOT NULL OR evaluator_feedback IS NOT NULL);
    END IF;
  END IF;

  -- (e) a demo PRACTICE test (published, max_attempts 5, instant, NO subjective) the player can run
  SELECT id INTO v_cat_it   FROM question_category WHERE org_id = v_org AND name = 'Programming Fundamentals' AND deleted_at IS NULL ORDER BY id LIMIT 1;
  SELECT id INTO v_cat_lang FROM question_category WHERE org_id = v_org AND name = 'English Grammar' AND deleted_at IS NULL ORDER BY id LIMIT 1;
  IF v_cat_it IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM assessment WHERE org_id = v_org AND title = '[DEMO] IT Practice Test (Auto-scored)' AND deleted_at IS NULL) THEN
    INSERT INTO assessment (org_id, branch_id, vertical_id, title, description, test_type, language,
        duration_min, negative_marking, randomize_questions, randomize_options, max_attempts,
        passing_pct, show_result_mode, status, start_at, end_at, instructions, published_at)
      VALUES (v_org, v_branch, v_vertical, '[DEMO] IT Practice Test (Auto-scored)',
        'Practice test built from objective demo questions — instant auto-scored, retake up to 5 times.',
        'practice', NULL, 20, false, true, true, 5, 40, 'instant', 'published',
        now() - interval '1 hour', now() + interval '10 years',
        'Objective questions only. Instant result. You may retake this practice test.', now())
      RETURNING id INTO a_practice;
    ord := 0; v_total := 0;
    FOR q IN
      SELECT id, marks FROM question
       WHERE org_id = v_org AND deleted_at IS NULL
         AND ( (category_id = v_cat_it   AND q_type IN ('mcq_single','mcq_multi','true_false'))
            OR (v_cat_lang IS NOT NULL AND category_id = v_cat_lang AND q_type = 'fill_blank') )
       ORDER BY category_id, id
    LOOP
      ord := ord + 1;
      INSERT INTO assessment_question (assessment_id, question_id, ordering) VALUES (a_practice, q.id, ord);
      v_total := v_total + COALESCE(q.marks, 0);
    END LOOP;
    UPDATE assessment SET total_marks = v_total, passing_marks = ROUND(v_total * 0.40, 2) WHERE id = a_practice;
  END IF;
END $$;
