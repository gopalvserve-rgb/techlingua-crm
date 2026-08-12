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
  { module: 'lead', label: 'Leads', actions: ['read', 'create', 'update', 'delete', 'assign', 'transfer', 'export', 'import', 'merge', 'pull', 'flag'] },
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
  // Sprint 6 (migration 031). 'read' and 'export' were catalogued in Sprint 1 and GRANTED
  // TO NOBODY for five sprints — there was no report to read. 031 grants them, and adds
  // the four the builder needs. 'share' and 'schedule' are deliberately separate from
  // 'create': building a report for yourself is a counsellor's business; putting one in
  // somebody else's list, or a FILE IN THEIR INBOX on a timer, is a manager's decision.
  { module: 'report', label: 'Reports', actions: ['read', 'create', 'update', 'delete', 'share', 'schedule', 'export'] },
  { module: 'settings', label: 'Settings', actions: ['read', 'update'] },
  // Developer / API access (migration 034). Admin-only, exactly like Settings —
  // an API key authenticates as an org-level caller, so minting and reading them
  // is Super/Org Admin only. 'read' = keys (masked) + docs + request log; 'manage'
  // = generate / enable / disable / revoke.
  { module: 'api', label: 'API Access', actions: ['read', 'manage'] },
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
  // Sprint 6 — Workspace. 'post' covers writing a message, a note, and deleting YOUR OWN
  // message; 'manage' is creating channels and deleting other people's posts. Guarding
  // delete with 'manage' would stop a counsellor removing his own typo.
  { module: 'workspace', label: 'Workspace (messages & notes)', actions: ['read', 'post', 'manage'] },
  { module: 'kb', label: 'Knowledge Base', actions: ['read', 'manage'] },
  { module: 'announcement', label: 'Announcements', actions: ['read', 'manage'] },
  // Support & Tickets (migration 037) — internal staff tickets, full lifecycle.
  // 'comment' = reply on the thread (a reporter may comment on his own ticket, per scope).
  { module: 'ticket', label: 'Support Tickets', actions: ['read', 'create', 'update', 'comment', 'delete'] },
  // Cross-Sell (migration 038) — CRM-level suggestions on converted contacts.
  // 'act' = create a follow-up / a new lead / dismiss a suggestion (a counsellor acts on
  // his own contacts). 'manage' = maintain the admin rule map (current -> suggested course).
  { module: 'crosssell', label: 'Cross-Sell', actions: ['read', 'act', 'manage'] },
  // Phase 2 (migration 044) — Students & Academics at the CRM level.
  // 'create' on student is what the "Convert to Student" button checks; it is granted to
  // exactly the roles that hold enrolment.create. 'delete' is admin-only (a student is a
  // record). Batches are branch/vertical/course-scoped and managed by managers/admins.
  { module: 'student', label: 'Students', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'batch', label: 'Batches', actions: ['read', 'create', 'update', 'delete'] },
  // Client request (migration 045) — Finance Settings: discount / scholarship / capping
  // limit, BOTH percentage and amount. 'read' shows the screen; 'manage' CHANGES the caps
  // (the permitted user); 'override' applies a discount/scholarship BEYOND the cap. A
  // Counsellor holds neither manage nor override, so a Counsellor is capped.
  { module: 'finance', label: 'Finance Settings (discount/scholarship/cap)', actions: ['read', 'manage', 'override'] },
  // Phase 2 ERP Batch 1 (migration 047) — Academics core.
  // Attendance: 'mark' = record a session's marks (staff / self / biometric feed); 'manage'
  // = admin corrections. Tests: 'grade' = enter/update per-student scores, distinct from
  // 'update' (editing the test itself). Coursework (academic assignments — the module is
  // named `coursework` because `assignment` is the RBAC user-grants module): 'grade' = mark
  // a submission. Batch TRANSFER + WAITLIST reuse student.update (they move the student's
  // batch assignment), so there is deliberately no new batch action.
  { module: 'attendance', label: 'Attendance', actions: ['read', 'mark', 'manage'] },
  { module: 'test', label: 'Tests & Scores', actions: ['read', 'create', 'update', 'delete', 'grade'] },
  { module: 'coursework', label: 'Assignments (coursework)', actions: ['read', 'create', 'update', 'delete', 'grade'] },
  // Phase 2 ERP Batch 2 (migration 048) — Learning.
  // Study material: 'create'/'update' let staff manage the library; a student's read is via
  // scope, not a grant. Certificates: 'issue' mints a serial + PDF, 'revoke' invalidates one
  // (both distinct from 'delete', which removes the record). Report cards: 'create' = generate
  // (compute + snapshot), 'read' shows/downloads; the parent view is a public tokened read,
  // outside RBAC by design.
  { module: 'material', label: 'Study Material', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'certificate', label: 'Certificates', actions: ['read', 'issue', 'revoke', 'delete'] },
  { module: 'reportcard', label: 'Report Cards', actions: ['read', 'create', 'delete'] },
  // ERP Batch 3 — online admission form + review queue. 'read' = see the queue; 'manage' =
  // create/edit/delete the public form links; 'review' = approve (→ student) / reject; 'delete'
  // = bulk-delete submissions. Sibling/family linking reuses student.update + student.read.
  { module: 'admission', label: 'Admissions (Online form & review)', actions: ['read', 'manage', 'review', 'delete'] },
  // Phase 2 ERP Batch 5 (migration 051) — Operations. Catalog + vendor are ORG-WIDE masters
  // (read granted broadly @ 'all', writes admin/manager). Inventory / asset / procurement are
  // BRANCH-SCOPED. inventory.manage = stock movements (receipt/issue/adjustment) + thresholds;
  // procurement.receive = receiving a PO into inventory, distinct from update (editing the PO).
  { module: 'catalog', label: 'Catalog (items/products/services)', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'inventory', label: 'Inventory (stock & movements)', actions: ['read', 'manage', 'delete'] },
  { module: 'asset', label: 'Assets (equipment/furniture/IT)', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'vendor', label: 'Vendors', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'procurement', label: 'Procurement (Purchase Orders)', actions: ['read', 'create', 'update', 'receive', 'delete'] },
  // Phase 2 ERP Batch 6 (migration 052) — Basic HR (no statutory payroll). Employee directory +
  // staff attendance + leaves are BRANCH-SCOPED. hr_attendance.mark = daily marking (staff/self);
  // leave.approve = a manager deciding a report's leave (distinct from leave.create = apply);
  // leave.manage = configuring leave types & balances. leave.read/create are granted to Counsellor
  // at 'own' so an employee can apply for and see their own leave.
  { module: 'employee', label: 'Employee Directory', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'hr_attendance', label: 'Staff Attendance', actions: ['read', 'mark', 'delete'] },
  { module: 'leave', label: 'Leaves (apply / approve / balances)', actions: ['read', 'create', 'approve', 'manage', 'delete'] },
  // Phase 2 ERP Batch 7 (migration 053) — Support extras. Training Videos + Release Notes are
  // ORG-WIDE staff content (no record scope). 'view' = every staff role reads the library / the
  // What's-New feed; 'manage' = admins create/edit/delete the entries.
  { module: 'training', label: 'Training Videos', actions: ['view', 'manage'] },
  { module: 'release_note', label: 'Release Notes', actions: ['view', 'manage'] },
  // Assessment / Test Module — Batch A (migration 063). The Question Bank foundation: a
  // subject/topic taxonomy + a reusable question bank with a wide type list (IT + Language),
  // difficulty, marks, media (image/audio -> R2, YouTube video id), CSV import. Branch/vertical
  // scoped. Batches B/C/D add tests, attempts and results.
  { module: 'question_category', label: 'Question Categories', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'question', label: 'Question Bank', actions: ['read', 'create', 'update', 'delete', 'import'] },
  // Assessment / Test Module — Batch B (migration 064). Tests / exams assembled from the bank
  // (hand-picked links + pooled sections), settings, publish/close, and reusable settings
  // templates. Branch/vertical scoped. Batches C/D add attempts and results.
  { module: 'assessment', label: 'Tests / Exams', actions: ['read', 'create', 'update', 'delete', 'publish', 'evaluate'] },
  { module: 'assessment_attempt', label: 'Test Attempts', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'assignment_submission', label: 'Assignment Submissions', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'assessment_template', label: 'Test Templates', actions: ['read', 'create', 'update', 'delete'] },
];
