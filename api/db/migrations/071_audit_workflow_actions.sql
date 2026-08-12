-- =============================================================================
-- 071 — allow the content-approval workflow actions in audit_log
--
-- Migration 070's ContentApprovalWorkflowService writes a transition row to audit_log for the
-- required approval history. audit_log.action carries a CHECK whitelist; extend it with the
-- workflow verbs so submit/approve/reject/unpublish and results release are recorded (they were
-- otherwise rejected by audit_log_action_check). Idempotent (drop-if-exists + recreate).
-- =============================================================================
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (
  action IN (
    'create','update','delete','login','export','transfer','permission_change',
    'merge','restore','handout','escalate','sla_breach',
    -- Academics governance (070/071)
    'workflow_draft','workflow_submit','workflow_approve','workflow_reject','workflow_unpublish',
    'results_release'
  )
);
