-- 141 — THE CLIENT'S DLT-APPROVED SMS TEMPLATES (23 Nov 2026, "templateDumpReport (2).xlsx").
--
-- 23 templates registered on the DLT portal (operator + GSTS approved): header (sender), name,
-- the exact registered text, the DLT template id, Branch + Vertical, the event that sends it and
-- the order of the fields that fill its markers ({#var#}, {#cbn#}, {#num#} are all positional).
-- They are editable afterwards in Engagement › SMS Templates (dynamic: text, ids, event, field
-- mapping, on/off), so nothing here is fixed in code.
--
-- Imported INACTIVE: turning one on sends real SMS for its event; the client switches them on.
-- Idempotent: a template is added once, matched by its DLT template id.

ALTER TABLE sms_template ALTER COLUMN trigger_event TYPE VARCHAR(40);
ALTER TABLE sms_template ALTER COLUMN trigger_event SET DEFAULT 'new_lead_created';

WITH src (header, name, body, dlt_template_id, branch_name, vertical_name, trigger_event, var_mapping) AS (VALUES
  ($tl$BCLDEL$tl$, $tl$BCL New Lead$tl$, $tl$Dear {#var#}, Thank you for your interest in British College of Language. "Approved Training Partner of Medhavi Skills University". We have received your enquiry for {#var#} Course. Our expert will contact you shortly. For any assistance, call +91 9911537041 or visit www.britishcollegeoflanguage.com.$tl$, $tl$1777179076330762457$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$new_lead_created$tl$, $tl$["name", "course"]$tl$),
  ($tl$lNSTAI$tl$, $tl$Insta New Lead$tl$, $tl$Dear {#var#}, Thank you for your interest in Insta Infotech. "Approved Training Partner of Medhavi Skills University". We have received your enquiry for {#var#} Course. Our admission counsellor will contact you Shortly. For any assistance, call +91 8920150908 or visit www.instainfotech.in.$tl$, $tl$1777179080360766663$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$new_lead_created$tl$, $tl$["name", "course"]$tl$),
  ($tl$lNSTAI$tl$, $tl$Insta Lead Assigned$tl$, $tl$Dear {#var#}, Thank you for your interest in Insta Infotech. Your enquiry for {#var#} Course has been assigned to our Admission Counsellor {#var#}. Our counsellor will contact you shortly. For assistance, call {#cbn#} or visit www.instainfotech.in.$tl$, $tl$1777179080395849705$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$lead_assigned$tl$, $tl$["name", "course", "counsellor", "callback"]$tl$),
  ($tl$BCLDEL$tl$, $tl$BCL Lead Assigned$tl$, $tl$Dear {#var#}, Thank you for your interest in BCL. Your enquiry for {#var#} Course has been assigned to our Admission Counsellor {#var#}. Our counsellor will contact you shortly. For any assistance, call {#cbn#} or visit www.britishcollegeoflanguage.com.$tl$, $tl$1777179080420391440$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$lead_assigned$tl$, $tl$["name", "course", "counsellor", "callback"]$tl$),
  ($tl$lNSTAI$tl$, $tl$Insta Counselling Scheduled$tl$, $tl$Dear {#var#}, your counselling for {#var#} Course at Insta Infotech is scheduled on {#var#} at {#var#}. Our Admission Counsellor {#var#} will assist with course, certification and admission details. For any assistance, call {#cbn#} or visit www.instainfotech.in.$tl$, $tl$1777179080465729523$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$counselling_scheduled$tl$, $tl$["name", "course", "date", "time", "counsellor", "callback"]$tl$),
  ($tl$BCLDEL$tl$, $tl$BCL Counselling Scheduled$tl$, $tl$Dear {#var#}, your counselling for {#var#} Course at BCL is scheduled on {#var#} at {#var#}. Our Admission Counsellor {#var#} will assist with course, certification and admission details. For any assistance, call {#cbn#} or visit www.britishcollegeoflanguage.com.$tl$, $tl$1777179080498657129$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$counselling_scheduled$tl$, $tl$["name", "course", "date", "time", "counsellor", "callback"]$tl$),
  ($tl$lNSTAI$tl$, $tl$Insta Counselling Reminder$tl$, $tl$Dear {#var#}, this is a reminder for your counselling session for {#var#} Course at Insta Infotech on {#var#} at {#var#}. Please be available at the scheduled time. Our Counsellor {#var#} will guide you further. For any assistance, call {#cbn#} or visit www.instainfotech.in.$tl$, $tl$1777179085397750267$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$counselling_reminder$tl$, $tl$["name", "course", "date", "time", "counsellor", "callback"]$tl$),
  ($tl$BCLDEL$tl$, $tl$BCL Counselling Reminder$tl$, $tl$Dear {#var#}, this is a reminder for your counselling session for {#var#} Course at BCL on {#var#} at {#var#}. Please be available at the scheduled time. Our Counsellor {#var#} will guide you further. For any assistance, call {#cbn#} or visit www.britishcollegeoflanguage.com.$tl$, $tl$1777179085426501099$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$counselling_reminder$tl$, $tl$["name", "course", "date", "time", "counsellor", "callback"]$tl$),
  ($tl$lNSTAI$tl$, $tl$Insta Demo Class Scheduled$tl$, $tl$Dear {#var#}, your Demo Class for {#var#} Course at Insta Infotech is scheduled on {#var#} at {#var#}. Our Trainer will guide you during the session. Please be available at the scheduled time. For any assistance, call {#cbn#} or visit www.instainfotech.in.$tl$, $tl$1777179085519810484$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$demo_scheduled$tl$, $tl$["name", "course", "date", "time", "callback"]$tl$),
  ($tl$BCLDEL$tl$, $tl$BCL Demo Class Scheduled$tl$, $tl$Dear {#var#}, your Demo Class for {#var#} Course at BCL is scheduled on {#var#} at {#var#}. Our Trainer will guide you during the session. Please be available at the scheduled time. For any assistance, call {#num#} or visit www.britishcollegeoflanguage.com.$tl$, $tl$1777179085557010743$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$demo_scheduled$tl$, $tl$["name", "course", "date", "time", "callback"]$tl$),
  ($tl$lNSTAI$tl$, $tl$Insta Demo Reminder$tl$, $tl$Dear {#var#}, this is a reminder for your Demo Class for {#var#} Course at Insta Infotech on {#var#} at {#var#}. Please be available at the scheduled time. Our Trainer will guide you during the session. For any assistance, call {#num#} or visit www.instainfotech.in.$tl$, $tl$1777179085584885474$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$demo_reminder$tl$, $tl$["name", "course", "date", "time", "callback"]$tl$),
  ($tl$BCLDEL$tl$, $tl$BCL Demo Reminder$tl$, $tl$Dear {#var#}, this is a reminder for your Demo Class for {#var#} Course at BCL on {#var#} at {#var#}. Please be available at the scheduled time. Our Trainer will guide you during the session. For any assistance, call {#num#} or visit www.britishcollegeoflanguage.com.$tl$, $tl$1777179085608420000$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$demo_reminder$tl$, $tl$["name", "course", "date", "time", "callback"]$tl$),
  ($tl$BCLDEL$tl$, $tl$BCL_DIWALI_OFFER_2026$tl$, $tl$Dear {#var#}, Light Up Your Future This Diwali! British College of Language brings an exclusive festive discount of {#var#} on {#var#} Course. Limited Period Offer! Enroll by {#var#} to claim your benefits. For assistance, call {#var#}. Team BCL$tl$, $tl$1777179288502853186$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$manual$tl$, $tl$["name", "discount", "course", "last_date", "callback"]$tl$),
  ($tl$lNSTIN$tl$, $tl$INSTA_DIWALI_OFFER_2026$tl$, $tl$Dear {#var#}, Light Up Your Career This Diwali! Insta Infotech brings an exclusive festive discount of {#var#} on {#var#} Course. Limited Period Offer! Enroll by {#var#} to claim your benefits. For any assistance, call {#cbn#}. Team Insta Infotech. "Approved Training Partner of Medhavi Skills University"$tl$, $tl$1777179288574840544$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$manual$tl$, $tl$["name", "discount", "course", "last_date", "callback"]$tl$),
  ($tl$lNSTAI$tl$, $tl$INSTA Call Connected$tl$, $tl$Dear {#var#},
It was a pleasure speaking with you! Thank you for your time and interest in Insta Infotech®.
We hope our conversation helped you understand more about {#var#}. For any further assistance, contact us at {#cbn#}. Team Insta Infotech®.$tl$, $tl$1777179512514015493$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$call_connected$tl$, $tl$["name", "course", "callback"]$tl$),
  ($tl$lNSTAI$tl$, $tl$insta Student Welcome$tl$, $tl$Dear {#var#},
Congratulations and welcome aboard at Insta Infotech®.
We are delighted to have you join us on your learning journey. Your admission to {#var#} has been successfully completed.
We wish you great success as you take this exciting step towards achieving your academic and career goals.
For any assistance or guidance, please contact us at {#cbn#}. Team Insta Infotech®.$tl$, $tl$1777179512743940740$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$student_welcome$tl$, $tl$["name", "course", "callback"]$tl$),
  ($tl$lNSTAI$tl$, $tl$Insta Enrollment Created$tl$, $tl$Dear {#var#},
Congratulations! Your enrollment has been successfully created.
You are now enrolled in {#var#}. We are excited to have you begin this learning journey and wish you great success ahead.
For any assistance regarding your classes, course or enrollment, contact us at {#cbn#}. Insta Infotech®.$tl$, $tl$1777179512921889835$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$enrollment_created$tl$, $tl$["name", "course", "callback"]$tl$),
  ($tl$BCLDEL$tl$, $tl$BCL Call Connected$tl$, $tl$Dear {#var#},
It was a pleasure speaking with you! Thank you for your time and interest in BCL®.
We hope our conversation helped you understand more about {#var#}. For any further assistance, contact us at {#cbn#}. Team BCL®.$tl$, $tl$1777179515444129929$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$call_connected$tl$, $tl$["name", "course", "callback"]$tl$),
  ($tl$BCLDEL$tl$, $tl$BCL Enrollment Created$tl$, $tl$Dear {#var#},
Congratulations Your enrollment has been successfully created.
You are now enrolled in {#var#}. We are excited to have you begin this learning journey and wish you great success ahead.
For any assistance regarding your classes, course or enrollment, contact us at {#cbn#}. Team BCL®.$tl$, $tl$1777179515597615981$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$enrollment_created$tl$, $tl$["name", "course", "callback"]$tl$),
  ($tl$BCLDEL$tl$, $tl$BCL Student Welcome$tl$, $tl$Dear {#var#},
Congratulations and welcome aboard at BCL®.
We are delighted to have you join us on your learning journey. Your admission to {#var#} has been successfully completed.
We wish you great success as you take this exciting step towards achieving your academic and career goals.
For any assistance or guidance, please contact us at {#cbn#}. Team BCL®.$tl$, $tl$1777179516651579729$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$student_welcome$tl$, $tl$["name", "course", "callback"]$tl$),
  ($tl$BCLDEL$tl$, $tl$BCL Call not Connected$tl$, $tl$Dear {#var#},
We tried reaching you regarding your {#var#} but couldn't connect with you. 
We understand you may be busy. We would be happy to discuss your interests, and guide you towards the right learning opportunities.
Feel free to call us at {#cbn#} whenever convenient. We look forward to speaking with you. Team BCL®.$tl$, $tl$1777179516810837679$tl$, $tl$Vikaspuri$tl$, $tl$BCL VKP$tl$, $tl$call_not_connected$tl$, $tl$["name", "course", "callback"]$tl$),
  ($tl$lNSTAI$tl$, $tl$Insta Call not Connected$tl$, $tl$Dear {#var#},
We tried reaching you regarding your {#var#} but couldn't connect with you. 
We understand you may be busy. We would be happy to discuss your interests, and guide you towards the right learning opportunities.
Feel free to call us at {#cbn#} whenever convenient. Team Insta Infotech®.$tl$, $tl$1777179516820357570$tl$, $tl$Vikaspuri$tl$, $tl$INSTA VKP$tl$, $tl$call_not_connected$tl$, $tl$["name", "course", "callback"]$tl$),
  ($tl$TECHLN$tl$, $tl$Login OTP$tl$, $tl$Dear {#var#}, 
Your One-Time Password (OTP) for account login is {#num#} .
This OTP is valid for {#num#} minutes. Tech Lingua$tl$, $tl$1777179517625448668$tl$, NULL, NULL, $tl$login_otp$tl$, $tl$["name", "otp", "otp_minutes"]$tl$)
)
INSERT INTO sms_template (org_id, header, name, body, branch_id, vertical_id, dlt_template_id, var_mapping, trigger_event, is_active)
SELECT o.id, s.header, s.name, s.body, b.id, v.id, s.dlt_template_id, s.var_mapping::jsonb, s.trigger_event, FALSE
  FROM src s
  CROSS JOIN (SELECT id FROM organisation ORDER BY id LIMIT 1) o
  LEFT JOIN branch b ON s.branch_name IS NOT NULL AND b.deleted_at IS NULL AND lower(b.name) = lower(s.branch_name)
  LEFT JOIN vertical v ON s.vertical_name IS NOT NULL AND v.deleted_at IS NULL AND lower(v.name) = lower(s.vertical_name)
       AND (b.id IS NULL OR v.branch_id = b.id)
 WHERE NOT EXISTS (SELECT 1 FROM sms_template t WHERE t.dlt_template_id = s.dlt_template_id AND t.deleted_at IS NULL)
   -- a template for a Branch / Vertical this CRM doesn't have is skipped, never filed org-wide
   AND (s.branch_name IS NULL OR b.id IS NOT NULL)
   AND (s.vertical_name IS NULL OR v.id IS NOT NULL);
