/**
 * Permission catalog — the module × action grid that role_permission rows reference.
 * key = `${module}.${action}`. Seeded into the `permission` table by db:seed.
 * Add new modules here as sprints land; the seed only runs once, so late additions
 * need a small catalog-sync migration (Sprint 2 note).
 */
export interface PermissionModule {
  module: string;
  label: string;
  actions: string[];
}

export const PERMISSION_CATALOG: PermissionModule[] = [
  { module: 'dashboard', label: 'Dashboard', actions: ['read'] },
  // 'pull' = the on-demand "Start Calling" hand-out (§4.1): an agent claims the next
  // batch of UNASSIGNED leads for themselves. Distinct from 'assign' (a manager giving
  // someone else's lead to a user) — see migration 021 / leads/handout.service.ts.
  { module: 'lead', label: 'Leads', actions: ['read', 'create', 'update', 'delete', 'assign', 'transfer', 'export', 'import', 'merge', 'pull'] },
  { module: 'followup', label: 'Follow-ups', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'user', label: 'Users', actions: ['read', 'create', 'update', 'deactivate', 'delete', 'import'] },
  { module: 'team', label: 'Teams', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'role', label: 'Roles & Permissions', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'assignment', label: 'User Assignments', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'branch', label: 'Branches', actions: ['read', 'create', 'update', 'deactivate', 'delete'] },
  { module: 'vertical', label: 'Verticals', actions: ['read', 'create', 'update', 'deactivate', 'delete'] },
  { module: 'pipeline', label: 'Pipelines & Stages', actions: ['read', 'create', 'update', 'deactivate', 'delete'] },
  { module: 'campaign', label: 'Campaigns', actions: ['read', 'create', 'update', 'deactivate', 'delete'] },
  { module: 'source', label: 'Sources', actions: ['read', 'create', 'update', 'deactivate', 'delete'] },
  { module: 'master', label: 'Masters', actions: ['read', 'create', 'update', 'deactivate', 'delete'] },
  { module: 'custom_field', label: 'Custom Fields', actions: ['read', 'create', 'update', 'deactivate', 'delete'] },
  { module: 'audit', label: 'Audit Logs', actions: ['read', 'export'] },
  { module: 'errorlog', label: 'Error Logs', actions: ['read', 'manage'] },
  // Soft delete (migration 015): restore + Deleted Items screen — Super/Org Admin
  { module: 'deleted', label: 'Deleted Items', actions: ['manage'] },
  { module: 'report', label: 'Reports', actions: ['read', 'export'] },
  { module: 'settings', label: 'Settings', actions: ['read', 'update'] },
  // Sprint 3 (migration 025) — working the lead
  { module: 'score', label: 'Lead Scoring', actions: ['read', 'manage'] },
  { module: 'sla', label: 'SLA & TAT', actions: ['read', 'manage'] },
  { module: 'calendar', label: 'Calendar', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'notification', label: 'Notifications', actions: ['read'] },
  { module: 'walkin', label: 'Walk-ins', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'referral', label: 'Referrals', actions: ['read', 'create', 'update', 'delete'] },
  // Sprint 4 (migration 026) — engagement & automation.
  // `settings` already existed above (Sprint 1) but had no grants until 026: the Settings
  // module holds the client's credentials, so it is Super/Org Admin only.
  { module: 'template', label: 'Message Templates', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'journey', label: 'Automation Journeys', actions: ['read', 'create', 'update', 'delete'] },
  // 'send' = despatch a message (a counsellor may message THEIR lead).
  // 'manage' = the opt-out list + retrying a failed send (admin / marketing).
  { module: 'message', label: 'Messages & Send Log', actions: ['read', 'send', 'manage'] },
  // Sprint 5 (migration 029) — conversion & money-lite.
  // 'send' on a quotation is distinct from 'message.send': despatching a PRICED OFFER is
  // a commercial act, and a client may well want a telecaller who can message a lead but
  // not quote one. Two permissions, because they are two decisions.
  { module: 'quotation', label: 'Quotations', actions: ['read', 'create', 'update', 'delete', 'send'] },
  // 'approve' is deliberately NOT granted to Counsellor/Team Leader in migration 029 —
  // an approval a counsellor can grant himself is not an approval.
  { module: 'enrolment', label: 'Enrolments (Sale Closure)', actions: ['read', 'create', 'update', 'delete', 'approve'] },
  // 'collect' = take money at the desk. 'delete' = void a receipt, which is an admin act
  // (it is a money record, not a typo in a note). Refunds are Phase 3 and are neither.
  { module: 'fee', label: 'Fee Collection (lite)', actions: ['read', 'collect', 'delete'] },
  { module: 'target', label: 'Monthly Targets', actions: ['read', 'manage'] },
  { module: 'performance', label: 'Counsellor Performance', actions: ['read'] },
];
