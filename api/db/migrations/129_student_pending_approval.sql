-- ============================================================================
-- 129 - STUDENT "PENDING APPROVAL" (client feedback 31 Oct, point 15)
--
-- Convert to Student skipped the enrolment approval policy: a 30% discount went straight into
-- Student Management. An enrolment that needs approval is now held, and a student whose every
-- enrolment is held waits at this status until an approver decides.
-- ============================================================================

INSERT INTO student_status_def (code, label, meaning, lms_access, requires_reason, requires_approval, is_terminal, ordering)
VALUES ('pending_approval', 'Pending approval', 'Enrolment waiting for approval (discount or closure)', 'none', FALSE, FALSE, FALSE, 5)
ON CONFLICT (code) DO NOTHING;
