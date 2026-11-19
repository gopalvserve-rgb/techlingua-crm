import { ScopeColumnMap } from '../rbac/rbac.types';

/**
 * =============================================================================
 * THE REPORT ENTITY REGISTRY — the security surface of Sprint 6, in one file.
 * =============================================================================
 *
 * A user-defined report is, unavoidably, "the user describes a query and we run it".
 * That sentence is one bad decision away from SQL injection and two away from a
 * counsellor reading the whole org's revenue. So the design is deliberately narrow:
 *
 *   1. THE CLIENT NEVER SENDS SQL. Not a column, not an operator, not a direction.
 *      A saved report names KEYS. Every key is looked up in this file. A key that is
 *      not here is a 400 with the key quoted — never a query.
 *
 *   2. EVERY FRAGMENT OF SQL IN THE RESULTING QUERY IS A STRING LITERAL WRITTEN HERE
 *      BY HAND. `sql` below is not built from input; it is a constant. The only thing
 *      that comes from the request is a VALUE, and a value is always a `$n` parameter.
 *
 *   3. EVERY ENTITY CARRIES ITS OWN PERMISSION AND ITS OWN SCOPE COLUMNS, and the
 *      report runner resolves that permission FOR THE PERSON RUNNING IT, on every run.
 *      Not for the person who saved it. Not for the person who shared it. The runner.
 *      `buildScopeWhere` then puts the fragment INSIDE the WHERE clause — the same
 *      function, the same shape, as the lead list and the dashboard. There is no code
 *      path in which out-of-scope rows are read and then filtered out, because those
 *      rows are never selected.
 *
 *   4. `scopeCols` MUST be complete for the entity. `buildScopeWhere` skips a filter
 *      whose column it has no mapping for, and if NOTHING maps it returns `1=0` —
 *      i.e. a missing mapping DENIES, it never widens. A `1=0` report is a bug report
 *      from the client; a report that leaks is a breach. The failure direction is
 *      chosen on purpose, and `entities.spec.ts` pins it.
 *
 * Adding an entity = adding an object here. It cannot be done from the UI, it cannot
 * be done from the database, and it cannot be done by a client payload.
 */

export type ColType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'bool';

export interface ReportColumn {
  key: string;
  label: string;
  /** A HAND-WRITTEN SQL EXPRESSION. Never interpolated from input. */
  sql: string;
  type: ColType;
  /** `table.column` pairs this expression reads — checked against the real migrations
   *  by sprint6-sql-schema.spec.ts, which is how DEF-S4-01 (`c.fee`, a column that does
   *  not exist, 793 green tests) does not happen a second time. */
  deps: string[];
  /** false = never offered as a filter (e.g. a computed label). Default true. */
  filterable?: boolean;
  /** false = never offered as a group-by. Default true for text/bool, false for money. */
  groupable?: boolean;
  /** money/number columns that are SUMMED when the report is grouped. */
  aggregate?: 'sum' | 'avg' | 'count';
}

export interface ReportEntity {
  key: string;
  label: string;
  blurb: string;
  /** The permission whose RECORD SCOPE limits this entity's rows, resolved per run. */
  permission: string;
  /** FROM + JOINs. A hand-written constant. */
  from: string;
  /** Predicates that are ALWAYS on (soft delete, mostly). Hand-written constants. */
  where: string[];
  scopeCols: ScopeColumnMap;
  columns: ReportColumn[];
  /** column keys that may be used as the report's date window. */
  dateFields: string[];
  defaultDateField: string;
  defaultColumns: string[];
}

/* --------------------------------------------------------------------------- */

const LEADS: ReportEntity = {
  key: 'leads',
  label: 'Leads',
  blurb: 'Every lead with its full path, owner, stage, score and follow-up.',
  permission: 'lead.read',
  from: `lead l
     LEFT JOIN branch br      ON br.id = l.branch_id
     LEFT JOIN vertical vt    ON vt.id = l.vertical_id
     LEFT JOIN pipeline pl    ON pl.id = l.pipeline_id
     LEFT JOIN campaign cm    ON cm.id = l.campaign_id
     LEFT JOIN source sr      ON sr.id = l.source_id
     LEFT JOIN pipeline_stage ps ON ps.id = l.stage_id
     LEFT JOIN m_course cr    ON cr.id = l.course_id
     LEFT JOIN "user" ow      ON ow.id = l.owner_id
     LEFT JOIN team tm        ON tm.id = l.team_id`,
  where: ['l.deleted_at IS NULL'],
  scopeCols: {
    owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
    vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
  },
  dateFields: ['created_at', 'last_activity_at', 'next_follow_up_at'],
  defaultDateField: 'created_at',
  defaultColumns: ['full_name', 'phone', 'stage', 'owner', 'campaign', 'source', 'temperature', 'created_at'],
  columns: [
    { key: 'id', label: 'Lead ID', sql: 'l.id', type: 'number', deps: ['lead.id'], groupable: false },
    { key: 'full_name', label: 'Name', sql: 'l.full_name', type: 'text', deps: ['lead.full_name'], groupable: false },
    { key: 'phone', label: 'Mobile', sql: 'l.phone', type: 'text', deps: ['lead.phone'], groupable: false },
    { key: 'email', label: 'Email', sql: 'l.email', type: 'text', deps: ['lead.email'], groupable: false },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'pipeline', label: 'Pipeline', sql: 'pl.name', type: 'text', deps: ['pipeline.name'] },
    { key: 'campaign', label: 'Campaign', sql: 'cm.name', type: 'text', deps: ['campaign.name'] },
    { key: 'source', label: 'Source', sql: 'sr.name', type: 'text', deps: ['source.name'] },
    { key: 'stage', label: 'Stage', sql: 'ps.name', type: 'text', deps: ['pipeline_stage.name'] },
    { key: 'stage_type', label: 'Stage type', sql: 'ps.stage_type', type: 'text', deps: ['pipeline_stage.stage_type'] },
    { key: 'course', label: 'Course', sql: 'cr.name', type: 'text', deps: ['m_course.name'] },
    { key: 'owner', label: 'Counsellor', sql: 'ow.name', type: 'text', deps: ['user.name'] },
    { key: 'team', label: 'Team', sql: 'tm.name', type: 'text', deps: ['team.name'] },
    { key: 'priority', label: 'Priority', sql: 'l.priority', type: 'text', deps: ['lead.priority'] },
    { key: 'temperature', label: 'Score band', sql: 'l.temperature', type: 'text', deps: ['lead.temperature'] },
    { key: 'score', label: 'Score', sql: 'l.score', type: 'number', deps: ['lead.score'], groupable: false, aggregate: 'avg' },
    { key: 'is_duplicate', label: 'Duplicate', sql: 'l.is_duplicate', type: 'bool', deps: ['lead.is_duplicate'] },
    { key: 'created_at', label: 'Created on', sql: 'l.created_at', type: 'datetime', deps: ['lead.created_at'], groupable: false },
    { key: 'created_month', label: 'Created month', sql: `to_char(l.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`, type: 'text', deps: ['lead.created_at'] },
    { key: 'created_day', label: 'Created day', sql: `to_char(l.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`, type: 'text', deps: ['lead.created_at'] },
    { key: 'last_activity_at', label: 'Last activity', sql: 'l.last_activity_at', type: 'datetime', deps: ['lead.last_activity_at'], groupable: false },
    { key: 'next_follow_up_at', label: 'Next follow-up', sql: 'l.next_follow_up_at', type: 'datetime', deps: ['lead.next_follow_up_at'], groupable: false },
  ],
};

const FOLLOW_UPS: ReportEntity = {
  key: 'follow_ups',
  label: 'Follow-ups & Tasks',
  blurb: 'Scheduled work: due, done, overdue, by owner — the adherence picture.',
  permission: 'followup.read',
  from: `follow_up f
     JOIN lead l              ON l.id = f.lead_id
     LEFT JOIN "user" ow      ON ow.id = f.owner_id
     LEFT JOIN "user" rp      ON rp.id = f.report_to_id
     LEFT JOIN m_followup_type ft ON ft.id = f.type_id
     LEFT JOIN m_call_disposition dp   ON dp.id = f.disposition_id
     LEFT JOIN branch br      ON br.id = l.branch_id
     LEFT JOIN vertical vt    ON vt.id = l.vertical_id`,
  where: ['f.deleted_at IS NULL', 'l.deleted_at IS NULL'],
  // A follow-up's unit path lives on its LEAD (follow_up has no branch column) —
  // the same map the follow-up list already uses (rbac/scope-cols.ts).
  scopeCols: {
    owner: 'f.owner_id', team: 'l.team_id', branch: 'l.branch_id',
    vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
  },
  dateFields: ['scheduled_at', 'completed_at', 'created_at'],
  defaultDateField: 'scheduled_at',
  defaultColumns: ['lead_name', 'type', 'owner', 'scheduled_at', 'status', 'priority'],
  columns: [
    { key: 'id', label: 'Task ID', sql: 'f.id', type: 'number', deps: ['follow_up.id'], groupable: false },
    { key: 'lead_name', label: 'Lead', sql: 'l.full_name', type: 'text', deps: ['lead.full_name'], groupable: false },
    { key: 'lead_phone', label: 'Lead mobile', sql: 'l.phone', type: 'text', deps: ['lead.phone'], groupable: false },
    { key: 'type', label: 'Type', sql: 'ft.name', type: 'text', deps: ['m_followup_type.name'] },
    { key: 'disposition', label: 'Disposition', sql: 'dp.name', type: 'text', deps: ['m_call_disposition.name'] },
    { key: 'owner', label: 'Owner', sql: 'ow.name', type: 'text', deps: ['user.name'] },
    { key: 'report_to', label: 'Report to', sql: 'rp.name', type: 'text', deps: ['user.name'] },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'status', label: 'Status', sql: 'f.status', type: 'text', deps: ['follow_up.status'] },
    { key: 'priority', label: 'Priority', sql: 'f.priority', type: 'text', deps: ['follow_up.priority'] },
    // "on time" is the SAME arithmetic PerformanceService.adherence uses
    // (completed_at <= scheduled_at). One definition, two readers.
    { key: 'on_time', label: 'Completed on time', sql: '(f.completed_at IS NOT NULL AND f.completed_at <= f.scheduled_at)', type: 'bool', deps: ['follow_up.completed_at', 'follow_up.scheduled_at'] },
    { key: 'notes', label: 'Notes', sql: 'f.notes', type: 'text', deps: ['follow_up.notes'], groupable: false },
    { key: 'scheduled_at', label: 'Due at', sql: 'f.scheduled_at', type: 'datetime', deps: ['follow_up.scheduled_at'], groupable: false },
    { key: 'completed_at', label: 'Completed at', sql: 'f.completed_at', type: 'datetime', deps: ['follow_up.completed_at'], groupable: false },
    { key: 'created_at', label: 'Created on', sql: 'f.created_at', type: 'datetime', deps: ['follow_up.created_at'], groupable: false },
  ],
};

const ENROLMENTS: ReportEntity = {
  key: 'enrolments',
  label: 'Enrolments',
  blurb: 'Closed sales: course, fee, discount, counsellor, status.',
  permission: 'enrolment.read',
  from: `enrolment e
     LEFT JOIN lead l         ON l.id = e.lead_id
     LEFT JOIN branch br      ON br.id = e.branch_id
     LEFT JOIN vertical vt    ON vt.id = e.vertical_id
     LEFT JOIN campaign cm    ON cm.id = e.campaign_id
     LEFT JOIN m_course cr    ON cr.id = e.course_id
     LEFT JOIN "user" cn      ON cn.id = e.counsellor_id`,
  where: ['e.deleted_at IS NULL'],
  scopeCols: {
    owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
    vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
  },
  dateFields: ['created_at', 'start_date'],
  defaultDateField: 'created_at',
  defaultColumns: ['enrolment_no', 'lead_name', 'course', 'counsellor', 'net_fee', 'status', 'created_at'],
  columns: [
    { key: 'id', label: 'ID', sql: 'e.id', type: 'number', deps: ['enrolment.id'], groupable: false },
    { key: 'enrolment_no', label: 'Enrolment no.', sql: 'e.enrolment_no', type: 'text', deps: ['enrolment.enrolment_no'], groupable: false },
    { key: 'lead_name', label: 'Student / lead', sql: 'l.full_name', type: 'text', deps: ['lead.full_name'], groupable: false },
    { key: 'lead_phone', label: 'Mobile', sql: 'l.phone', type: 'text', deps: ['lead.phone'], groupable: false },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'campaign', label: 'Campaign', sql: 'cm.name', type: 'text', deps: ['campaign.name'] },
    { key: 'course', label: 'Course', sql: 'cr.name', type: 'text', deps: ['m_course.name'] },
    { key: 'counsellor', label: 'Counsellor', sql: 'cn.name', type: 'text', deps: ['user.name'] },
    { key: 'status', label: 'Status', sql: 'e.status', type: 'text', deps: ['enrolment.status'] },
    { key: 'payment_plan', label: 'Payment plan', sql: 'e.payment_plan', type: 'text', deps: ['enrolment.payment_plan'] },
    { key: 'fee', label: 'Fee', sql: 'e.fee_minor', type: 'money', deps: ['enrolment.fee_minor'], groupable: false, aggregate: 'sum' },
    { key: 'discount', label: 'Discount', sql: 'e.discount_minor', type: 'money', deps: ['enrolment.discount_minor'], groupable: false, aggregate: 'sum' },
    { key: 'net_fee', label: 'Net fee (booked)', sql: 'e.net_fee_minor', type: 'money', deps: ['enrolment.net_fee_minor'], groupable: false, aggregate: 'sum' },
    // COLLECTED is a correlated sum against the receipts, NOT a join — a join would
    // multiply `net_fee` by the number of receipts, which is how a report ends up
    // claiming three times the revenue and the client stops believing any of it.
    { key: 'collected', label: 'Collected', type: 'money', aggregate: 'sum', groupable: false,
      sql: '(SELECT COALESCE(sum(fr.amount_minor), 0) FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL)',
      deps: ['fee_receipt.amount_minor', 'fee_receipt.enrolment_id', 'fee_receipt.deleted_at'] },
    { key: 'balance', label: 'Balance', type: 'money', aggregate: 'sum', groupable: false,
      sql: '(e.net_fee_minor - (SELECT COALESCE(sum(fr2.amount_minor), 0) FROM fee_receipt fr2 WHERE fr2.enrolment_id = e.id AND fr2.deleted_at IS NULL))',
      deps: ['enrolment.net_fee_minor', 'fee_receipt.amount_minor', 'fee_receipt.enrolment_id', 'fee_receipt.deleted_at'] },
    { key: 'start_date', label: 'Start date', sql: 'e.start_date', type: 'date', deps: ['enrolment.start_date'], groupable: false },
    { key: 'created_at', label: 'Closed on', sql: 'e.created_at', type: 'datetime', deps: ['enrolment.created_at'], groupable: false },
    { key: 'closed_month', label: 'Closed month', sql: `to_char(e.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`, type: 'text', deps: ['enrolment.created_at'] },
  ],
};

const RECEIPTS: ReportEntity = {
  key: 'receipts',
  label: 'Fee receipts',
  blurb: 'Cash actually taken: amount, mode, reference, who took it.',
  permission: 'fee.read',
  from: `fee_receipt fr
     JOIN enrolment e         ON e.id = fr.enrolment_id
     LEFT JOIN lead l         ON l.id = fr.lead_id
     LEFT JOIN branch br      ON br.id = fr.branch_id
     LEFT JOIN vertical vt    ON vt.id = fr.vertical_id
     LEFT JOIN "user" rb      ON rb.id = fr.received_by
     LEFT JOIN "user" cn      ON cn.id = e.counsellor_id`,
  where: ['fr.deleted_at IS NULL', 'e.deleted_at IS NULL'],
  // DECISION #45, ENFORCED IN THE REPORTS TOO: cash belongs to the ENROLMENT'S
  // COUNSELLOR, so a receipt is scoped on `e.counsellor_id`, never on `received_by`.
  // Scope this on received_by and an Accountant's receipt disappears from the
  // counsellor's own report while showing on the dashboard — the exact DEF-S5-03
  // disagreement, rebuilt in a new module.
  scopeCols: {
    owner: 'e.counsellor_id', team: 'e.team_id', branch: 'fr.branch_id',
    vertical: 'fr.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
  },
  dateFields: ['received_at'],
  defaultDateField: 'received_at',
  defaultColumns: ['receipt_no', 'lead_name', 'amount', 'mode', 'received_by', 'received_at'],
  columns: [
    { key: 'id', label: 'ID', sql: 'fr.id', type: 'number', deps: ['fee_receipt.id'], groupable: false },
    { key: 'receipt_no', label: 'Receipt no.', sql: 'fr.receipt_no', type: 'text', deps: ['fee_receipt.receipt_no'], groupable: false },
    { key: 'enrolment_no', label: 'Enrolment no.', sql: 'e.enrolment_no', type: 'text', deps: ['enrolment.enrolment_no'], groupable: false },
    { key: 'lead_name', label: 'Student / lead', sql: 'l.full_name', type: 'text', deps: ['lead.full_name'], groupable: false },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'amount', label: 'Amount', sql: 'fr.amount_minor', type: 'money', deps: ['fee_receipt.amount_minor'], groupable: false, aggregate: 'sum' },
    { key: 'mode', label: 'Mode', sql: 'fr.mode', type: 'text', deps: ['fee_receipt.mode'] },
    { key: 'reference', label: 'Reference', sql: 'fr.reference', type: 'text', deps: ['fee_receipt.reference'], groupable: false },
    { key: 'received_by', label: 'Received by (till)', sql: 'rb.name', type: 'text', deps: ['user.name'] },
    { key: 'counsellor', label: 'Counsellor (credited)', sql: 'cn.name', type: 'text', deps: ['user.name'] },
    { key: 'note', label: 'Note', sql: 'fr.note', type: 'text', deps: ['fee_receipt.note'], groupable: false },
    { key: 'received_at', label: 'Received on', sql: 'fr.received_at', type: 'datetime', deps: ['fee_receipt.received_at'], groupable: false },
    { key: 'received_month', label: 'Received month', sql: `to_char(fr.received_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`, type: 'text', deps: ['fee_receipt.received_at'] },
  ],
};

const CAMPAIGNS: ReportEntity = {
  key: 'campaigns',
  label: 'Campaigns',
  blurb: 'Spend, leads, enrolments, cost per lead and revenue — the ROI picture.',
  permission: 'campaign.read',
  from: `campaign cm
     LEFT JOIN branch br   ON br.id = cm.branch_id
     LEFT JOIN vertical vt ON vt.id = cm.vertical_id
     LEFT JOIN pipeline pl ON pl.id = cm.pipeline_id`,
  where: ['cm.deleted_at IS NULL'],
  scopeCols: {
    branch: 'cm.branch_id', vertical: 'cm.vertical_id', pipeline: 'cm.pipeline_id', campaign: 'cm.id',
  },
  dateFields: ['created_at'],
  defaultDateField: 'created_at',
  defaultColumns: ['name', 'branch', 'cost', 'leads', 'enrolments', 'cpl', 'revenue'],
  columns: [
    { key: 'id', label: 'ID', sql: 'cm.id', type: 'number', deps: ['campaign.id'], groupable: false },
    { key: 'name', label: 'Campaign', sql: 'cm.name', type: 'text', deps: ['campaign.name'] },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'pipeline', label: 'Pipeline', sql: 'pl.name', type: 'text', deps: ['pipeline.name'] },
    { key: 'priority', label: 'Priority', sql: 'cm.priority', type: 'text', deps: ['campaign.priority'] },
    // campaign.cost is NUMERIC(14,2) RUPEES (Sprint 1), not paise. Everything else in
    // this app is minor units, so it is converted HERE, once, rather than in four
    // readers that will eventually disagree. round() before ::bigint, or 4999.999
    // silently becomes 4999.
    { key: 'cost', label: 'Spend', sql: 'round(cm.cost * 100)::bigint', type: 'money', deps: ['campaign.cost'], groupable: false, aggregate: 'sum' },
    { key: 'leads', label: 'Leads', type: 'number', groupable: false, aggregate: 'sum',
      sql: '(SELECT count(*) FROM lead cl WHERE cl.campaign_id = cm.id AND cl.deleted_at IS NULL)',
      deps: ['lead.campaign_id', 'lead.deleted_at'] },
    { key: 'enrolments', label: 'Enrolments', type: 'number', groupable: false, aggregate: 'sum',
      sql: `(SELECT count(*) FROM enrolment ce WHERE ce.campaign_id = cm.id AND ce.deleted_at IS NULL AND ce.status = 'active')`,
      deps: ['enrolment.campaign_id', 'enrolment.deleted_at', 'enrolment.status'] },
    // REVENUE = net_fee_minor of ACTIVE enrolments. Identical to
    // PerformanceService.leaderboard's `revenue_minor`, deliberately: reports-vs-dashboard
    // reconciliation is pinned by reconcile.spec.ts, and it can only hold if the
    // definition is the same one.
    { key: 'revenue', label: 'Revenue (booked)', type: 'money', groupable: false, aggregate: 'sum',
      sql: `(SELECT COALESCE(sum(ce2.net_fee_minor), 0) FROM enrolment ce2 WHERE ce2.campaign_id = cm.id AND ce2.deleted_at IS NULL AND ce2.status = 'active')`,
      deps: ['enrolment.campaign_id', 'enrolment.net_fee_minor', 'enrolment.deleted_at', 'enrolment.status'] },
    // COST PER LEAD. NULLIF, because a campaign with no leads yet must show "—",
    // not a division-by-zero 500 on the client's first look at his own ROI screen.
    { key: 'cpl', label: 'Cost per lead', type: 'money', groupable: false, filterable: false,
      sql: `round((cm.cost * 100) / NULLIF((SELECT count(*) FROM lead cl2 WHERE cl2.campaign_id = cm.id AND cl2.deleted_at IS NULL), 0))::bigint`,
      deps: ['campaign.cost', 'lead.campaign_id', 'lead.deleted_at'] },
    { key: 'is_active', label: 'Active', sql: 'cm.is_active', type: 'bool', deps: ['campaign.is_active'] },
    { key: 'created_at', label: 'Created on', sql: 'cm.created_at', type: 'datetime', deps: ['campaign.created_at'], groupable: false },
  ],
};

const USERS: ReportEntity = {
  key: 'users',
  label: 'Users',
  blurb: 'The team: role, unit, status, last login.',
  permission: 'user.read',
  // A user's UNIT comes from user_assignment, so the scope columns point there. A
  // user with several assignments would appear once per assignment, so DISTINCT ON
  // is not enough — the assignment is folded into a LATERAL that returns at most one
  // row. Reporting "Asha Rao" three times because she covers three branches is not a
  // report, it is a bug with a spreadsheet icon.
  from: `"user" u
     LEFT JOIN LATERAL (
       SELECT ua.branch_id, ua.vertical_id, ua.pipeline_id, ua.campaign_id, ua.team_id, ua.role_id
         FROM user_assignment ua
        WHERE ua.user_id = u.id AND ua.is_active
        ORDER BY ua.id
        LIMIT 1
     ) ua ON TRUE
     LEFT JOIN role ro     ON ro.id = ua.role_id
     LEFT JOIN branch br   ON br.id = ua.branch_id
     LEFT JOIN vertical vt ON vt.id = ua.vertical_id
     LEFT JOIN team tm     ON tm.id = ua.team_id`,
  where: ['u.deleted_at IS NULL'],
  scopeCols: {
    owner: 'u.id', team: 'ua.team_id', branch: 'ua.branch_id',
    vertical: 'ua.vertical_id', pipeline: 'ua.pipeline_id', campaign: 'ua.campaign_id',
  },
  // NOTE: there is no `last_login_at` column on "user" — the first draft of this file
  // named one, and the schema guard caught it before Postgres could. The login record
  // lives in `audit_log` (action = 'login'), so that is where the column reads from.
  dateFields: ['created_at'],
  defaultDateField: 'created_at',
  defaultColumns: ['name', 'mobile', 'email', 'role', 'branch', 'status'],
  columns: [
    { key: 'id', label: 'ID', sql: 'u.id', type: 'number', deps: ['user.id'], groupable: false },
    { key: 'name', label: 'Name', sql: 'u.name', type: 'text', deps: ['user.name'], groupable: false },
    { key: 'mobile', label: 'Mobile', sql: 'u.phone', type: 'text', deps: ['user.phone'], groupable: false },
    { key: 'email', label: 'Email', sql: 'u.email', type: 'text', deps: ['user.email'], groupable: false },
    { key: 'role', label: 'Role', sql: 'ro.name', type: 'text', deps: ['role.name'] },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'team', label: 'Team', sql: 'tm.name', type: 'text', deps: ['team.name'] },
    { key: 'status', label: 'Status', sql: 'u.status', type: 'text', deps: ['user.status'] },
    { key: 'created_at', label: 'Created on', sql: 'u.created_at', type: 'datetime', deps: ['user.created_at'], groupable: false },
    { key: 'last_login_at', label: 'Last login', type: 'datetime', groupable: false, filterable: false,
      sql: `(SELECT max(al.occurred_at) FROM audit_log al WHERE al.actor_id = u.id AND al.action = 'login')`,
      deps: ['audit_log.occurred_at', 'audit_log.actor_id', 'audit_log.action'] },
  ],
};

/* ---------------------------------------------------------------------------
 * Client 12 Nov 2026 — "complete Analytics & Reports on priority": the Report Builder
 * now also reports Calls, Students, Fee dues, Invoices, Refunds, Attendance, Batches and
 * Walk-ins. Each entity's scope map is THE SAME map its own screen uses (calls.service,
 * student/transfer.service, dues.service, invoice.service, finance-dashboard, attendance,
 * capture), so a report never shows a row the screen would hide.
 * ------------------------------------------------------------------------- */

const IST_TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

const CALLS: ReportEntity = {
  key: 'calls',
  label: 'Calls',
  blurb: 'Every call logged by the counsellor phone app: who, which lead, direction, connected or missed, talk time.',
  permission: 'calls.read',
  from: `call_event ce
     LEFT JOIN lead l          ON l.id = ce.lead_id
     LEFT JOIN "user" cu       ON cu.id = ce.user_id
     LEFT JOIN branch br       ON br.id = l.branch_id
     LEFT JOIN vertical vt     ON vt.id = l.vertical_id
     LEFT JOIN campaign cm     ON cm.id = l.campaign_id
     LEFT JOIN m_call_disposition dp ON dp.id = ce.disposition_id`,
  // a "dial requested" row is the app asking the phone to dial — not a call; a live-dup row is
  // a live event the phone's call log superseded (calls.service hides it the same way)
  where: [`ce.event <> 'dial_requested'`, `ce.src IS DISTINCT FROM 'live-dup'`],
  scopeCols: {
    owner: 'ce.user_id', team: 'l.team_id', branch: 'l.branch_id',
    vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
  },
  dateFields: ['call_start_at', 'created_at'],
  defaultDateField: 'call_start_at',
  defaultColumns: ['counsellor', 'lead_name', 'phone', 'direction', 'outcome', 'talk_minutes', 'call_start_at'],
  columns: [
    { key: 'id', label: 'Call ID', sql: 'ce.id', type: 'number', deps: ['call_event.id'], groupable: false },
    { key: 'counsellor', label: 'Counsellor', sql: 'cu.name', type: 'text', deps: ['user.name'] },
    { key: 'lead_name', label: 'Lead', sql: 'l.full_name', type: 'text', deps: ['lead.full_name'], groupable: false },
    { key: 'phone', label: 'Number', sql: 'ce.phone_number', type: 'text', deps: ['call_event.phone_number'], groupable: false },
    { key: 'direction', label: 'Direction', type: 'text', deps: ['call_event.direction'],
      sql: `CASE ce.direction WHEN 'in' THEN 'Incoming' WHEN 'out' THEN 'Outgoing' WHEN 'missed' THEN 'Missed' ELSE 'Other' END` },
    { key: 'outcome', label: 'Outcome', type: 'text', deps: ['call_event.duration_s', 'call_event.direction'],
      sql: `CASE WHEN COALESCE(ce.duration_s, 0) > 0 THEN 'Connected' WHEN ce.direction = 'missed' THEN 'Missed' ELSE 'Not connected' END` },
    { key: 'connected', label: 'Connected', sql: '(COALESCE(ce.duration_s, 0) > 0)', type: 'bool', deps: ['call_event.duration_s'] },
    { key: 'talk_seconds', label: 'Talk time (sec)', sql: 'COALESCE(ce.duration_s, 0)', type: 'number', deps: ['call_event.duration_s'], groupable: false, aggregate: 'sum' },
    { key: 'talk_minutes', label: 'Talk time (min)', sql: 'round(COALESCE(ce.duration_s, 0) / 60.0, 1)', type: 'number', deps: ['call_event.duration_s'], groupable: false, aggregate: 'sum' },
    { key: 'disposition', label: 'Disposition', sql: 'dp.name', type: 'text', deps: ['m_call_disposition.name'] },
    { key: 'sim', label: 'SIM', sql: 'ce.sim_label', type: 'text', deps: ['call_event.sim_label'] },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'campaign', label: 'Campaign', sql: 'cm.name', type: 'text', deps: ['campaign.name'] },
    { key: 'has_recording', label: 'Recorded', sql: '(ce.recording_id IS NOT NULL)', type: 'bool', deps: ['call_event.recording_id'] },
    { key: 'note', label: 'Note', sql: 'ce.note', type: 'text', deps: ['call_event.note'], groupable: false },
    { key: 'call_start_at', label: 'Call time', sql: 'ce.call_start_at', type: 'datetime', deps: ['call_event.call_start_at'], groupable: false },
    { key: 'call_day', label: 'Call day', sql: `to_char(ce.call_start_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`, type: 'text', deps: ['call_event.call_start_at'] },
    { key: 'call_month', label: 'Call month', sql: `to_char(ce.call_start_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`, type: 'text', deps: ['call_event.call_start_at'] },
    { key: 'call_hour', label: 'Hour of day', sql: `to_char(ce.call_start_at AT TIME ZONE 'Asia/Kolkata', 'HH24')`, type: 'text', deps: ['call_event.call_start_at'] },
    { key: 'created_at', label: 'Synced at', sql: 'ce.created_at', type: 'datetime', deps: ['call_event.created_at'], groupable: false },
  ],
};

const STUDENTS: ReportEntity = {
  key: 'students',
  label: 'Students',
  blurb: 'The student register: course, batch, status, counsellor, training mode, contact.',
  permission: 'student.read',
  from: `student s
     LEFT JOIN branch br      ON br.id = s.branch_id
     LEFT JOIN vertical vt    ON vt.id = s.vertical_id
     LEFT JOIN m_course cr    ON cr.id = s.course_id
     LEFT JOIN batch bt       ON bt.id = s.batch_id
     LEFT JOIN "user" ow      ON ow.id = s.owner_id`,
  where: ['s.deleted_at IS NULL'],
  scopeCols: {
    owner: 's.owner_id', team: 's.team_id', branch: 's.branch_id', vertical: 's.vertical_id',
    pipeline: 's.pipeline_id', campaign: 's.campaign_id',
  },
  dateFields: ['created_at', 'admission_date'],
  defaultDateField: 'created_at',
  defaultColumns: ['student_no', 'full_name', 'phone', 'course', 'batch', 'status', 'counsellor', 'created_at'],
  columns: [
    { key: 'id', label: 'ID', sql: 's.id', type: 'number', deps: ['student.id'], groupable: false },
    { key: 'student_no', label: 'Student no.', sql: 's.student_no', type: 'text', deps: ['student.student_no'], groupable: false },
    { key: 'enrollment_no', label: 'Enrolment no.', sql: 's.enrollment_no', type: 'text', deps: ['student.enrollment_no'], groupable: false },
    { key: 'full_name', label: 'Name', sql: 's.full_name', type: 'text', deps: ['student.full_name'], groupable: false },
    { key: 'phone', label: 'Mobile', sql: 's.phone', type: 'text', deps: ['student.phone'], groupable: false },
    { key: 'email', label: 'Email', sql: 's.email', type: 'text', deps: ['student.email'], groupable: false },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'course', label: 'Course', sql: 'cr.name', type: 'text', deps: ['m_course.name'] },
    { key: 'batch', label: 'Batch', sql: 'bt.name', type: 'text', deps: ['batch.name'] },
    { key: 'counsellor', label: 'Counsellor', sql: 'ow.name', type: 'text', deps: ['user.name'] },
    { key: 'status', label: 'Status', sql: 's.status', type: 'text', deps: ['student.status'] },
    { key: 'training_mode', label: 'Training mode', sql: 's.training_mode', type: 'text', deps: ['student.training_mode'] },
    { key: 'gender', label: 'Gender', sql: 's.gender', type: 'text', deps: ['student.gender'] },
    { key: 'qualification', label: 'Qualification', sql: 's.qualification', type: 'text', deps: ['student.qualification'] },
    { key: 'admission_date', label: 'Admission date', sql: 's.admission_date', type: 'date', deps: ['student.admission_date'], groupable: false },
    { key: 'created_at', label: 'Created on', sql: 's.created_at', type: 'datetime', deps: ['student.created_at'], groupable: false },
    { key: 'created_month', label: 'Created month', sql: `to_char(s.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`, type: 'text', deps: ['student.created_at'] },
  ],
};

const FEE_DUES: ReportEntity = {
  key: 'fee_dues',
  label: 'Fee dues (instalments)',
  blurb: 'Every instalment of an active payment plan: due date, amount, paid, outstanding and how overdue it is.',
  permission: 'fee_dues.read',
  from: `installment i
     JOIN payment_plan pp     ON pp.id = i.plan_id
     JOIN enrolment e         ON e.id = i.enrolment_id
     LEFT JOIN lead l         ON l.id = e.lead_id
     LEFT JOIN student sp     ON sp.id = e.student_profile_id
     LEFT JOIN branch br      ON br.id = e.branch_id
     LEFT JOIN vertical vt    ON vt.id = e.vertical_id
     LEFT JOIN m_course cr    ON cr.id = e.course_id
     LEFT JOIN "user" cn      ON cn.id = e.counsellor_id`,
  // the same population as Finance › Fee Dues (dues.service.ts): active plans of active enrolments
  where: [`pp.status = 'active'`, 'pp.deleted_at IS NULL', 'e.deleted_at IS NULL', `e.status = 'active'`, `i.status <> 'waived'`],
  scopeCols: {
    owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
    vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
  },
  dateFields: ['due_date'],
  defaultDateField: 'due_date',
  defaultColumns: ['student', 'enrolment_no', 'course', 'label', 'due_date', 'amount', 'paid', 'outstanding', 'ageing'],
  columns: [
    { key: 'id', label: 'ID', sql: 'i.id', type: 'number', deps: ['installment.id'], groupable: false },
    { key: 'student', label: 'Student', sql: 'COALESCE(l.full_name, sp.full_name)', type: 'text', deps: ['lead.full_name', 'student.full_name'], groupable: false },
    { key: 'phone', label: 'Mobile', sql: 'COALESCE(l.phone, sp.phone)', type: 'text', deps: ['lead.phone', 'student.phone'], groupable: false },
    { key: 'enrolment_no', label: 'Enrolment no.', sql: 'e.enrolment_no', type: 'text', deps: ['enrolment.enrolment_no'], groupable: false },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'course', label: 'Course', sql: 'cr.name', type: 'text', deps: ['m_course.name'] },
    { key: 'counsellor', label: 'Counsellor', sql: 'cn.name', type: 'text', deps: ['user.name'] },
    { key: 'label', label: 'Instalment', sql: `COALESCE(i.label, 'Instalment ' || i.seq_no)`, type: 'text', deps: ['installment.label', 'installment.seq_no'], groupable: false },
    { key: 'status', label: 'Status', sql: 'i.status', type: 'text', deps: ['installment.status'] },
    { key: 'due_date', label: 'Due date', sql: 'i.due_date', type: 'date', deps: ['installment.due_date'], groupable: false },
    { key: 'due_month', label: 'Due month', sql: `to_char(i.due_date, 'YYYY-MM')`, type: 'text', deps: ['installment.due_date'] },
    { key: 'amount', label: 'Amount', sql: 'i.amount_minor', type: 'money', deps: ['installment.amount_minor'], groupable: false, aggregate: 'sum' },
    { key: 'paid', label: 'Paid', sql: 'COALESCE(i.paid_minor, 0)', type: 'money', deps: ['installment.paid_minor'], groupable: false, aggregate: 'sum' },
    { key: 'outstanding', label: 'Outstanding', sql: 'GREATEST(i.amount_minor - COALESCE(i.paid_minor, 0), 0)', type: 'money', deps: ['installment.amount_minor', 'installment.paid_minor'], groupable: false, aggregate: 'sum' },
    { key: 'days_overdue', label: 'Days overdue', type: 'number', groupable: false, aggregate: 'avg', deps: ['installment.due_date', 'installment.amount_minor', 'installment.paid_minor'],
      sql: `CASE WHEN i.amount_minor - COALESCE(i.paid_minor, 0) > 0 AND i.due_date < ${IST_TODAY} THEN ${IST_TODAY} - i.due_date ELSE 0 END` },
    // DUES AGEING — the bucket a collections manager works from
    { key: 'ageing', label: 'Ageing', type: 'text', deps: ['installment.due_date', 'installment.amount_minor', 'installment.paid_minor'],
      sql: `CASE WHEN i.amount_minor - COALESCE(i.paid_minor, 0) <= 0 THEN 'Paid'
                 WHEN i.due_date >= ${IST_TODAY} THEN '0 · Not due yet'
                 WHEN ${IST_TODAY} - i.due_date <= 30 THEN '1 · 1–30 days overdue'
                 WHEN ${IST_TODAY} - i.due_date <= 60 THEN '2 · 31–60 days overdue'
                 WHEN ${IST_TODAY} - i.due_date <= 90 THEN '3 · 61–90 days overdue'
                 ELSE '4 · 90+ days overdue' END` },
    { key: 'is_overdue', label: 'Overdue', type: 'bool', deps: ['installment.due_date', 'installment.amount_minor', 'installment.paid_minor'],
      sql: `(i.amount_minor - COALESCE(i.paid_minor, 0) > 0 AND i.due_date < ${IST_TODAY})` },
  ],
};

const INVOICES: ReportEntity = {
  key: 'invoices',
  label: 'GST invoices',
  blurb: 'Tax invoices: number, buyer, taxable value, CGST / SGST / IGST, total and status.',
  permission: 'invoice.read',
  from: `gst_invoice gi
     LEFT JOIN branch br      ON br.id = gi.branch_id
     LEFT JOIN vertical vt    ON vt.id = gi.vertical_id
     LEFT JOIN "user" cn      ON cn.id = gi.counsellor_id`,
  where: ['gi.deleted_at IS NULL'],
  scopeCols: {
    owner: 'gi.counsellor_id', team: 'gi.team_id', branch: 'gi.branch_id',
    vertical: 'gi.vertical_id', pipeline: 'gi.pipeline_id', campaign: 'gi.campaign_id',
  },
  dateFields: ['invoice_date', 'issued_at', 'created_at'],
  defaultDateField: 'invoice_date',
  defaultColumns: ['invoice_no', 'invoice_date', 'buyer_name', 'taxable', 'gst', 'total', 'status'],
  columns: [
    { key: 'id', label: 'ID', sql: 'gi.id', type: 'number', deps: ['gst_invoice.id'], groupable: false },
    { key: 'invoice_no', label: 'Invoice no.', sql: 'gi.invoice_no', type: 'text', deps: ['gst_invoice.invoice_no'], groupable: false },
    { key: 'invoice_date', label: 'Invoice date', sql: 'gi.invoice_date', type: 'date', deps: ['gst_invoice.invoice_date'], groupable: false },
    { key: 'invoice_month', label: 'Invoice month', sql: `to_char(gi.invoice_date, 'YYYY-MM')`, type: 'text', deps: ['gst_invoice.invoice_date'] },
    { key: 'status', label: 'Status', sql: 'gi.status', type: 'text', deps: ['gst_invoice.status'] },
    { key: 'buyer_name', label: 'Buyer', sql: 'gi.buyer_name', type: 'text', deps: ['gst_invoice.buyer_name'], groupable: false },
    { key: 'buyer_phone', label: 'Buyer mobile', sql: 'gi.buyer_phone', type: 'text', deps: ['gst_invoice.buyer_phone'], groupable: false },
    { key: 'buyer_gstin', label: 'Buyer GSTIN', sql: 'gi.buyer_gstin', type: 'text', deps: ['gst_invoice.buyer_gstin'], groupable: false },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'counsellor', label: 'Counsellor', sql: 'cn.name', type: 'text', deps: ['user.name'] },
    { key: 'supply_type', label: 'Supply type', sql: 'gi.supply_type', type: 'text', deps: ['gst_invoice.supply_type'] },
    { key: 'taxable', label: 'Taxable value', sql: 'gi.taxable_minor', type: 'money', deps: ['gst_invoice.taxable_minor'], groupable: false, aggregate: 'sum' },
    { key: 'discount', label: 'Discount', sql: 'gi.discount_minor', type: 'money', deps: ['gst_invoice.discount_minor'], groupable: false, aggregate: 'sum' },
    { key: 'cgst', label: 'CGST', sql: 'gi.cgst_minor', type: 'money', deps: ['gst_invoice.cgst_minor'], groupable: false, aggregate: 'sum' },
    { key: 'sgst', label: 'SGST', sql: 'gi.sgst_minor', type: 'money', deps: ['gst_invoice.sgst_minor'], groupable: false, aggregate: 'sum' },
    { key: 'igst', label: 'IGST', sql: 'gi.igst_minor', type: 'money', deps: ['gst_invoice.igst_minor'], groupable: false, aggregate: 'sum' },
    { key: 'gst', label: 'Total GST', sql: '(COALESCE(gi.cgst_minor,0) + COALESCE(gi.sgst_minor,0) + COALESCE(gi.igst_minor,0))', type: 'money',
      deps: ['gst_invoice.cgst_minor', 'gst_invoice.sgst_minor', 'gst_invoice.igst_minor'], groupable: false, aggregate: 'sum' },
    { key: 'total', label: 'Invoice total', sql: 'gi.total_minor', type: 'money', deps: ['gst_invoice.total_minor'], groupable: false, aggregate: 'sum' },
    { key: 'issued_at', label: 'Issued at', sql: 'gi.issued_at', type: 'datetime', deps: ['gst_invoice.issued_at'], groupable: false },
    { key: 'paid_at', label: 'Paid at', sql: 'gi.paid_at', type: 'datetime', deps: ['gst_invoice.paid_at'], groupable: false },
    { key: 'created_at', label: 'Created on', sql: 'gi.created_at', type: 'datetime', deps: ['gst_invoice.created_at'], groupable: false },
  ],
};

const REFUNDS: ReportEntity = {
  key: 'refunds',
  label: 'Refunds',
  blurb: 'Refund requests: amount, reason, who asked, who approved, status and when it was paid out.',
  permission: 'refund.read',
  from: `refund rf
     LEFT JOIN enrolment e    ON e.id = rf.enrolment_id
     LEFT JOIN lead l         ON l.id = rf.lead_id
     LEFT JOIN branch br      ON br.id = rf.branch_id
     LEFT JOIN vertical vt    ON vt.id = rf.vertical_id
     LEFT JOIN "user" rq      ON rq.id = rf.requested_by
     LEFT JOIN "user" ap      ON ap.id = rf.approver_id`,
  where: ['rf.deleted_at IS NULL'],
  scopeCols: {
    owner: 'e.counsellor_id', team: 'e.team_id', branch: 'rf.branch_id',
    vertical: 'rf.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
  },
  dateFields: ['requested_at', 'refunded_at'],
  defaultDateField: 'requested_at',
  defaultColumns: ['refund_no', 'student', 'amount', 'reason', 'status', 'requested_by', 'requested_at'],
  columns: [
    { key: 'id', label: 'ID', sql: 'rf.id', type: 'number', deps: ['refund.id'], groupable: false },
    { key: 'refund_no', label: 'Refund no.', sql: 'rf.refund_no', type: 'text', deps: ['refund.refund_no'], groupable: false },
    { key: 'student', label: 'Student / lead', sql: 'l.full_name', type: 'text', deps: ['lead.full_name'], groupable: false },
    { key: 'enrolment_no', label: 'Enrolment no.', sql: 'e.enrolment_no', type: 'text', deps: ['enrolment.enrolment_no'], groupable: false },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'amount', label: 'Amount', sql: 'rf.amount_minor', type: 'money', deps: ['refund.amount_minor'], groupable: false, aggregate: 'sum' },
    { key: 'reason', label: 'Reason', sql: 'rf.reason', type: 'text', deps: ['refund.reason'], groupable: false },
    { key: 'mode', label: 'Mode', sql: 'rf.mode', type: 'text', deps: ['refund.mode'] },
    { key: 'status', label: 'Status', sql: 'rf.status', type: 'text', deps: ['refund.status'] },
    { key: 'requested_by', label: 'Requested by', sql: 'rq.name', type: 'text', deps: ['user.name'] },
    { key: 'approver', label: 'Approver', sql: 'ap.name', type: 'text', deps: ['user.name'] },
    { key: 'requested_at', label: 'Requested on', sql: 'rf.requested_at', type: 'datetime', deps: ['refund.requested_at'], groupable: false },
    { key: 'decided_at', label: 'Decided on', sql: 'rf.decided_at', type: 'datetime', deps: ['refund.decided_at'], groupable: false },
    { key: 'refunded_at', label: 'Paid out on', sql: 'rf.refunded_at', type: 'datetime', deps: ['refund.refunded_at'], groupable: false },
  ],
};

const ATTENDANCE: ReportEntity = {
  key: 'attendance',
  label: 'Attendance',
  blurb: 'Class attendance by student, batch and day: present, absent, late, leave.',
  permission: 'attendance.read',
  from: `attendance a
     LEFT JOIN student s      ON s.id = a.student_id
     LEFT JOIN batch bt       ON bt.id = a.batch_id
     LEFT JOIN m_course cr    ON cr.id = bt.course_id
     LEFT JOIN "user" tr      ON tr.id = bt.trainer_id
     LEFT JOIN "user" mk      ON mk.id = a.marked_by
     LEFT JOIN branch br      ON br.id = a.branch_id
     LEFT JOIN vertical vt    ON vt.id = a.vertical_id`,
  where: ['a.deleted_at IS NULL'],
  // the Attendance screen's own map (attendance.service ATT_SCOPE_COLS)
  scopeCols: { branch: 'a.branch_id', vertical: 'a.vertical_id', owner: 'a.marked_by' },
  dateFields: ['session_date'],
  defaultDateField: 'session_date',
  defaultColumns: ['session_date', 'student', 'batch', 'status', 'mode', 'marked_by'],
  columns: [
    { key: 'id', label: 'ID', sql: 'a.id', type: 'number', deps: ['attendance.id'], groupable: false },
    { key: 'session_date', label: 'Session date', sql: 'a.session_date', type: 'date', deps: ['attendance.session_date'], groupable: false },
    { key: 'session_month', label: 'Session month', sql: `to_char(a.session_date, 'YYYY-MM')`, type: 'text', deps: ['attendance.session_date'] },
    { key: 'student', label: 'Student', sql: 's.full_name', type: 'text', deps: ['student.full_name'] },
    { key: 'student_no', label: 'Student no.', sql: 's.student_no', type: 'text', deps: ['student.student_no'], groupable: false },
    { key: 'batch', label: 'Batch', sql: 'bt.name', type: 'text', deps: ['batch.name'] },
    { key: 'course', label: 'Course', sql: 'cr.name', type: 'text', deps: ['m_course.name'] },
    { key: 'trainer', label: 'Trainer', sql: 'tr.name', type: 'text', deps: ['user.name'] },
    { key: 'status', label: 'Status', sql: 'a.status', type: 'text', deps: ['attendance.status'] },
    { key: 'present', label: 'Present', sql: `(a.status IN ('present', 'late'))`, type: 'bool', deps: ['attendance.status'] },
    { key: 'mode', label: 'Mode', sql: 'a.mode', type: 'text', deps: ['attendance.mode'] },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'marked_by', label: 'Marked by', sql: 'mk.name', type: 'text', deps: ['user.name'] },
    { key: 'remarks', label: 'Remarks', sql: 'a.remarks', type: 'text', deps: ['attendance.remarks'], groupable: false },
  ],
};

const BATCHES: ReportEntity = {
  key: 'batches',
  label: 'Batches',
  blurb: 'Batches with trainer, schedule, capacity, enrolled students and fill rate.',
  permission: 'batch.read',
  from: `batch bt
     LEFT JOIN branch br      ON br.id = bt.branch_id
     LEFT JOIN vertical vt    ON vt.id = bt.vertical_id
     LEFT JOIN m_course cr    ON cr.id = bt.course_id
     LEFT JOIN "user" tr      ON tr.id = bt.trainer_id`,
  where: ['bt.deleted_at IS NULL'],
  scopeCols: { branch: 'bt.branch_id', vertical: 'bt.vertical_id' },
  dateFields: ['start_date', 'end_date', 'created_at'],
  defaultDateField: 'start_date',
  defaultColumns: ['batch_code', 'name', 'course', 'trainer', 'start_date', 'capacity', 'students', 'fill_pct', 'status'],
  columns: [
    { key: 'id', label: 'ID', sql: 'bt.id', type: 'number', deps: ['batch.id'], groupable: false },
    { key: 'batch_code', label: 'Batch code', sql: 'bt.batch_code', type: 'text', deps: ['batch.batch_code'], groupable: false },
    { key: 'name', label: 'Batch', sql: 'bt.name', type: 'text', deps: ['batch.name'] },
    { key: 'course', label: 'Course', sql: 'cr.name', type: 'text', deps: ['m_course.name'] },
    { key: 'trainer', label: 'Trainer', sql: 'tr.name', type: 'text', deps: ['user.name'] },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'status', label: 'Status', sql: 'bt.status', type: 'text', deps: ['batch.status'] },
    { key: 'delivery_mode', label: 'Delivery mode', sql: 'bt.delivery_mode', type: 'text', deps: ['batch.delivery_mode'] },
    { key: 'schedule', label: 'Schedule', sql: 'bt.schedule', type: 'text', deps: ['batch.schedule'], groupable: false },
    { key: 'capacity', label: 'Capacity', sql: 'COALESCE(bt.capacity, 0)', type: 'number', deps: ['batch.capacity'], groupable: false, aggregate: 'sum' },
    { key: 'students', label: 'Students', type: 'number', groupable: false, aggregate: 'sum',
      sql: '(SELECT count(*) FROM student bs WHERE bs.batch_id = bt.id AND bs.deleted_at IS NULL)',
      deps: ['student.batch_id', 'student.deleted_at'] },
    { key: 'fill_pct', label: 'Fill %', type: 'number', groupable: false, filterable: false, aggregate: 'avg',
      sql: 'round(100.0 * (SELECT count(*) FROM student bs2 WHERE bs2.batch_id = bt.id AND bs2.deleted_at IS NULL) / NULLIF(bt.capacity, 0), 1)',
      deps: ['student.batch_id', 'student.deleted_at', 'batch.capacity'] },
    { key: 'start_date', label: 'Start date', sql: 'bt.start_date', type: 'date', deps: ['batch.start_date'], groupable: false },
    { key: 'end_date', label: 'End date', sql: 'bt.end_date', type: 'date', deps: ['batch.end_date'], groupable: false },
    { key: 'created_at', label: 'Created on', sql: 'bt.created_at', type: 'datetime', deps: ['batch.created_at'], groupable: false },
  ],
};

const WALK_INS: ReportEntity = {
  key: 'walk_ins',
  label: 'Walk-ins',
  blurb: 'Visitors at the centre: purpose, counsellor, course, wait time and whether they became a lead.',
  permission: 'walkin.read',
  from: `walk_in w
     LEFT JOIN lead wl        ON wl.id = w.lead_id
     LEFT JOIN campaign cmp   ON cmp.id = w.campaign_id
     LEFT JOIN branch br      ON br.id = w.branch_id
     LEFT JOIN vertical vt    ON vt.id = w.vertical_id
     LEFT JOIN m_course cr    ON cr.id = w.course_id
     LEFT JOIN "user" cn      ON cn.id = w.counsellor_id
     LEFT JOIN m_source ms    ON ms.id = w.heard_about_source_id`,
  where: ['w.deleted_at IS NULL'],
  // the Walk-ins screen's own map (capture.service WALKIN_SCOPE_COLS)
  scopeCols: {
    owner: 'COALESCE(wl.owner_id, w.counsellor_id)', team: 'wl.team_id',
    branch: 'w.branch_id', vertical: 'w.vertical_id',
    pipeline: 'COALESCE(cmp.pipeline_id, wl.pipeline_id)', campaign: 'COALESCE(w.campaign_id, wl.campaign_id)',
  },
  dateFields: ['visited_at'],
  defaultDateField: 'visited_at',
  defaultColumns: ['visitor_name', 'phone', 'purpose', 'course', 'counsellor', 'status', 'visited_at'],
  columns: [
    { key: 'id', label: 'ID', sql: 'w.id', type: 'number', deps: ['walk_in.id'], groupable: false },
    { key: 'visitor_name', label: 'Visitor', sql: 'w.visitor_name', type: 'text', deps: ['walk_in.visitor_name'], groupable: false },
    { key: 'phone', label: 'Mobile', sql: 'w.phone', type: 'text', deps: ['walk_in.phone'], groupable: false },
    { key: 'purpose', label: 'Purpose', sql: 'w.purpose', type: 'text', deps: ['walk_in.purpose'] },
    { key: 'course', label: 'Course', sql: 'cr.name', type: 'text', deps: ['m_course.name'] },
    { key: 'counsellor', label: 'Counsellor', sql: 'cn.name', type: 'text', deps: ['user.name'] },
    { key: 'heard_about', label: 'How they heard', sql: 'ms.name', type: 'text', deps: ['m_source.name'] },
    { key: 'status', label: 'Status', sql: 'w.status', type: 'text', deps: ['walk_in.status'] },
    { key: 'became_lead', label: 'Became a lead', sql: '(w.lead_id IS NOT NULL)', type: 'bool', deps: ['walk_in.lead_id'] },
    { key: 'branch', label: 'Branch', sql: 'br.name', type: 'text', deps: ['branch.name'] },
    { key: 'vertical', label: 'Vertical', sql: 'vt.name', type: 'text', deps: ['vertical.name'] },
    { key: 'wait_minutes', label: 'Wait (min)', sql: 'COALESCE(w.wait_minutes, 0)', type: 'number', deps: ['walk_in.wait_minutes'], groupable: false, aggregate: 'avg' },
    { key: 'visited_at', label: 'Visited at', sql: 'w.visited_at', type: 'datetime', deps: ['walk_in.visited_at'], groupable: false },
    { key: 'visit_month', label: 'Visit month', sql: `to_char(w.visited_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`, type: 'text', deps: ['walk_in.visited_at'] },
  ],
};

export const REPORT_ENTITIES: ReportEntity[] = [LEADS, FOLLOW_UPS, ENROLMENTS, RECEIPTS, CAMPAIGNS, USERS,
  CALLS, STUDENTS, FEE_DUES, INVOICES, REFUNDS, ATTENDANCE, BATCHES, WALK_INS];

export const entityByKey = (key: string): ReportEntity | undefined =>
  REPORT_ENTITIES.find((e) => e.key === key);

export const columnByKey = (entity: ReportEntity, key: string): ReportColumn | undefined =>
  entity.columns.find((c) => c.key === key);

/** Default for `groupable` when the column does not say: money/number are measures. */
export const isGroupable = (c: ReportColumn): boolean =>
  c.groupable ?? (c.type !== 'money' && c.type !== 'number' && c.type !== 'datetime' && c.type !== 'date');

export const isFilterable = (c: ReportColumn): boolean => c.filterable ?? true;

/** What the UI needs to draw the builder. Contains no SQL — the client never sees any. */
export const catalog = () => REPORT_ENTITIES.map((e) => ({
  key: e.key,
  label: e.label,
  blurb: e.blurb,
  permission: e.permission,
  date_fields: e.dateFields.map((k) => ({ key: k, label: columnByKey(e, k)?.label ?? k })),
  default_date_field: e.defaultDateField,
  default_columns: e.defaultColumns,
  columns: e.columns.map((c) => ({
    key: c.key, label: c.label, type: c.type,
    filterable: isFilterable(c), groupable: isGroupable(c), aggregate: c.aggregate ?? null,
  })),
}));
