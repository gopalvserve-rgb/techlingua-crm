/**
 * Screen specs — ported 1:1 from the prototype's APP array (post reconcileNav()).
 * Every module / submenu / block / table column matches the prototype exactly.
 * Fake demo people & numbers are NOT ported: dynamic screens fetch real data
 * (spec.dyn -> component in dyn.tsx); everything else renders clean zero/empty
 * states plus the prototype's own capability/config descriptions.
 */

export interface KpiItem { lab: string; val: string; delta?: string; tone?: 'up' | 'down' | 'flat'; ic?: string;
  /** #13(c) — make a summary tile navigable. When present the tile gets a button role,
   * keyboard activation (Enter/Space), a pointer cursor and `navLabel` as its accessible name. */
  onClick?: () => void; navLabel?: string }
export interface CapItem { t: string; d?: string; p2?: boolean }
export interface CfgRow { ic?: string; k: string; s?: string; v?: string; toggle?: boolean }
export interface ListRow { ic?: string; tone?: string; t1: string; t2?: string; rt?: string }
export interface HBar { label: string; val: string; pct: number; color: string }

export interface Block {
  type: string;
  title?: string;
  more?: string;
  cols?: number | string | string[];
  items?: any[];
  rows?: any[];
  steps?: Array<{ k: string; t: string; d: string }>;
  fields?: Array<{ label: string; val?: string; ph?: string; req?: number; span?: number }>;
  nodes?: any[];
  slices?: Array<{ label: string; pct: number; color: string }>;
  center?: string;
  text?: string;
  l?: string; v?: string; s?: string; tone?: string;
  empty?: string;
}

export interface ScreenSpec {
  sub?: string;
  tag?: 'p2';
  actions?: Array<[string, string, string?]>;
  blocks?: Block[];
  dyn?: string;            // dynamic component key (see dyn.tsx registry)
  sprintNote?: string;     // amber note for modules whose backend lands later
}

export interface SubItem { id: string; label: string; spec: ScreenSpec }
export interface ModuleItem { id: string; label: string; icon: string; phase?: string; subs: SubItem[] }

export const kpi = (lab: string, val: string, ic?: string, delta?: string, tone?: 'up' | 'down' | 'flat'): KpiItem =>
  ({ lab, val, ic, delta, tone });
export const cap = (t: string, d?: string, p2?: boolean): CapItem => ({ t, d, p2 });

const NOTE_S2 = 'Backend for this module lands in Phase 2 — the screen design is final; data will appear here automatically.';
const NOTE_P2 = undefined; // P2 screens use the prototype p2notice block instead

const emptyTable = (title: string, cols: string[], empty?: string): Block =>
  ({ type: 'table', title, cols, rows: [], empty });
const emptyList = (title: string, empty?: string): Block => ({ type: 'list', title, rows: [], empty });

const gen = (mod: string, label: string): ScreenSpec => ({
  sub: `${label} · ${mod}.`,
  blocks: [{
    type: 'caps', title: label, items: [
      cap(`${label} view`, 'Structured per client requirements'),
      cap('Filters & search', 'Standard controls'),
      cap('Export / actions', 'Excel · PDF · role-based'),
    ],
  }],
});
const genP2 = (mod: string, label: string): ScreenSpec => {
  const sp = gen(mod, label);
  sp.tag = 'p2';
  sp.blocks!.unshift({ type: 'p2notice' });
  return sp;
};
const p2 = (title: string, sub: string, caps: CapItem[]): ScreenSpec => ({
  sub, tag: 'p2',
  blocks: [{ type: 'p2notice' }, { type: 'caps', title: `${title} — capabilities`, items: caps }],
});

/* ============================ THE NAV TREE ============================ */

export const APP: ModuleItem[] = [

  /* ---------------- Dashboard ---------------- */
  { id: 'dash', label: 'Dashboard', icon: 'dash', subs: [
    { id: 'overview', label: 'Overview', spec: { dyn: 'dashOverview',
      sub: 'Role-based view across your Branch › Vertical › Pipeline scope.',
      actions: [['plus', 'Quick add lead', 'primary']] } },
    { id: 'quickcontact', label: 'Quick Contact', spec: { dyn: 'quickContact',
      sub: 'Search an existing lead by Branch / Vertical / Pipeline / Campaign, or add a new one in seconds — then call / WhatsApp / email straight from here.' } },
    { id: 'mytasks', label: 'My Tasks', spec: { dyn: 'myTasks',
      sub: 'Your open tasks — auto-created from follow-ups & stage changes, plus manually added.',
      actions: [['plus', 'Add task', 'primary']] } },
    { id: 'todayfollowups', label: "Today's Follow-ups", spec: { dyn: 'todayFollowups',
      sub: 'Every lead with a follow-up due today (and overdue), sorted hot-first. Overdue highlighted in red.' } },
    { id: 'quickstats', label: 'Quick Stats', spec: { dyn: 'quickStats',
      sub: 'Key numbers at a glance for any range — today, week, month, or a custom date range.' } },
    { id: 'calendar', label: 'Calendar', spec: { dyn: 'calendar',
      sub: 'Follow-ups, demos and meetings on one calendar. Google/Outlook sync is built and waiting on credentials.' } },
    { id: 'walkins', label: 'Walk-ins', spec: { dyn: 'walkIns',
      sub: 'Capture branch visitors and convert directly into assigned leads — the counsellor owns the lead on add.',
      actions: [['plus', 'Add walk-in', 'primary']] } },
    { id: 'referrals', label: 'Referrals', spec: { dyn: 'referrals',
      sub: 'Students, staff & partners refer new leads — track rewards and link referrer to lead.',
      actions: [['plus', 'Add referral', 'primary']] } },
    { id: 'aiinsights', label: 'AI Insights', spec: {
      sub: 'Lead scoring, churn / at-risk, next-best-action & summaries — running on Gemini.',
      sprintNote: 'Rule-based lead scoring is LIVE (Marketing › Lead Scoring). AI insights switch on once the Gemini key is configured in Settings (Phase 2).',
      blocks: [
        emptyList('Active insights', 'No insights yet — the AI engine connects in Phase 2'),
        { type: 'caps', title: 'Insight types', items: [
          cap('Lead scoring', 'Hot / Warm / Cold bands'), cap('Churn & at-risk', 'Recency + engagement'),
          cap('Next-best-action', 'Per-lead suggestion'), cap('Conversation summaries', 'Phase 2 with call AI', true)] },
      ] } },
  ] },

  /* ---------------- Marketing & Lead Management ---------------- */
  { id: 'leads', label: 'Marketing & Lead Management', icon: 'leads', subs: [
    { id: 'branch', label: 'Branch', spec: { dyn: 'branches',
      sub: 'Create & configure branches. Super Admin / permitted managers.' } },
    { id: 'vertical', label: 'Vertical', spec: { dyn: 'verticals',
      sub: 'Business lines (brands) under each Branch — different per Branch. SMTP configured per vertical.' } },
    { id: 'pipelinemaster', label: 'Pipeline', spec: { dyn: 'pipelines',
      sub: 'Sales pipelines (stage-flows) — multiple per Vertical, each with its own stages.' } },
    { id: 'campaigns', label: 'Campaign', spec: { dyn: 'campaigns',
      sub: 'Campaigns sit under each Pipeline and pull leads from sources. UTM & ROI tracked per campaign.',
      actions: [['plus', 'New campaign', 'primary']] } },
    { id: 'all', label: 'Leads', spec: { dyn: 'leadsAll',
      sub: 'Full lead table — every lead tagged Branch › Vertical › Pipeline › Campaign › Source.',
      actions: [['filter', 'Filters', 'ghost'], ['plus', 'Add lead', 'primary']] } },
    { id: 'calling', label: 'Start Calling', spec: { dyn: 'startCalling',
      sub: 'On Demand campaigns park their leads in a pool. Click Start Calling and the next 10 (the campaign\u2019s hand-out size) are assigned to you \u2014 then work them one at a time: disposition, next follow-up, next lead. No dialler: you call from your own phone.' } },
    { id: 'import', label: 'Import Leads', spec: { dyn: 'leadImport',
      sub: 'Bulk-import leads from a CSV — map your columns, preview every row, then import. Duplicates and assignment follow the campaign\u2019s own rules.' } },
    { id: 'capture', label: 'Integrations', spec: { dyn: 'captureChannels',
      sub: 'Available Tools \u2014 Facebook Leads, Meta WhatsApp, Google Sheets / Form / Ads, IndiaMART, JustDial, TradeIndia, Housing.com, 99acres, Custom & Webhook. Pick a tool, choose Branch \u203a Vertical \u203a Campaign, map its fields, and every lead flows through the same pipeline as the CSV import \u2014 same duplicate rules, same auto-assignment, and a repeated delivery never creates a second lead.' } },
    { id: 'followups', label: 'Follow-ups', spec: { dyn: 'followups',
      sub: 'All scheduled follow-ups across leads — call, WhatsApp, email, visit. Overdue highlighted.',
      actions: [['plus', 'Add follow-up', 'primary'], ['filter', 'Filters', 'ghost']] } },
    { id: 'pipeline', label: 'Kanban', spec: { dyn: 'kanban',
      sub: 'Drag to move stage (permitted users) · every lead tagged Branch › Vertical › Pipeline › Campaign › Source.',
      actions: [['filter', 'Filters', 'ghost'], ['plus', 'Add lead', 'primary']] } },
    { id: 'scoring', label: 'Lead Scoring', spec: { dyn: 'scoring',
      sub: 'Rule-based scoring you configure yourself — source, budget, course, engagement, recency. Bands for Hot / Warm / Cold.' } },
    { id: 'sources', label: 'Lead Sources', spec: { dyn: 'sources',
      sub: 'Auto-capture via API/webhook from every source. Cost per source tracked for ROI.' } },
    { id: 'assign', label: 'Auto-Assignment', spec: {
      sub: 'Defined while creating a campaign — round-robin by branch / vertical / pipeline / campaign. Reassign on no-response.',
      blocks: [
        { type: 'cfg', title: 'Assignment rules', rows: [
          { ic: 'refresh', k: 'Round-robin', s: 'Even distribution within scope', v: 'Default', toggle: true },
          { ic: 'branch', k: 'By branch / vertical', s: 'Lead routed to scope owners', v: 'On', toggle: true },
          { ic: 'bolt', k: 'By campaign ownership', s: 'Campaign creator owns leads', v: 'On', toggle: true },
          { ic: 'clock', k: 'Working-hours aware', s: 'Skip offline counsellors', v: 'On', toggle: true },
          { ic: 'refresh', k: 'Reassign on no-response', s: 'After SLA breach, move to next', v: '48h', toggle: true }] },
        { type: 'caps', title: 'Per-scope rules', items: [
          cap('Branch level', 'Round-robin within branch'), cap('Vertical level', 'Per vertical / brand'),
          cap('Pipeline level', 'Different stages, different owners'), cap('Campaign level', 'Set at campaign creation')] },
      ] } },
    { id: 'dup', label: 'Duplicate Rules', spec: {
      sub: 'Detect by phone — scoped by branch, vertical, campaign per settings. Re-enquiry handled intelligently.',
      blocks: [
        { type: 'cfg', title: 'Duplicate handling', rows: [
          { ic: 'phone', k: 'Detect by phone', s: 'Primary match key', v: 'On', toggle: true },
          { ic: 'branch', k: 'Scope of check', s: 'Branch + vertical + campaign', v: 'Configurable', toggle: true },
          { ic: 'leads', k: 'If lead is open', s: 'Re-assign to same owner', v: 'Auto', toggle: true },
          { ic: 'refresh', k: 'If lost / closed', s: 'Flag & re-open the lead', v: 'Auto', toggle: true },
          { ic: 'bolt', k: 'Highlight duplicates', s: 'Badge on list & card', v: 'On', toggle: true }] },
      ] } },
    { id: 'sla', label: 'SLA & TAT', spec: { dyn: 'sla',
      sub: 'First-response time per lead with escalation if missed.' } },
    { id: 'fields', label: 'Custom Fields', spec: {
      sub: 'Standard lead fields plus custom fields & predefined dropdown masters.',
      blocks: [
        { type: 'table', title: 'Lead fields (masters linked)', cols: ['Field', 'Type', 'Mandatory', 'Master'], rows: [
          ['Name', 'Text', { b: ['Yes', 'b-rose'] }, '—'], ['Mobile Number', 'Phone', { b: ['Yes', 'b-rose'] }, '—'],
          ['Email', 'Email', 'No', '—'], ['State / City', 'Dropdown', 'No', { b: ['Master', 'b-indigo'] }],
          ['Branch', 'Dropdown', { b: ['Yes', 'b-rose'] }, { b: ['Master', 'b-indigo'] }],
          ['Vertical', 'Dropdown', { b: ['Yes', 'b-rose'] }, { b: ['Master', 'b-indigo'] }],
          ['Course', 'Dropdown', 'No', { b: ['Master', 'b-indigo'] }],
          ['Source', 'Dropdown', { b: ['Yes', 'b-rose'] }, { b: ['Master', 'b-indigo'] }],
          ['Stage / Status', 'Dropdown', { b: ['Yes', 'b-rose'] }, { b: ['Master', 'b-indigo'] }],
          ['Lead Score', 'Auto', '—', '—'], ['Tag', 'Multi', 'No', { b: ['Master', 'b-indigo'] }],
          ['Follow-up Date', 'Date', 'No', '—'], ['+ Custom field', 'Any', 'Configurable', 'Link to master'],
        ] },
      ] } },
  ] },

  /* ---------------- Performance & Conversion ---------------- */
  { id: 'perf', label: 'Performance & Conversion', icon: 'perf', subs: [
    // Sprint 5 — all four are LIVE and read real data. The prototype's blocks are kept
    // 1:1 by the dyn components (KPI strip, tables, hbars); only the fake numbers are gone.
    { id: 'closure', label: 'Sale Closure', spec: { dyn: 'saleClosure',
      sub: 'Lead marked Won on enrolment. Optional approval per step. Captures course, fee, discount, payment plan & start date.' } },
    { id: 'quotes', label: 'Quotations', spec: { dyn: 'quotations',
      sub: 'Fee proposals with line items, discounts, validity & revisions. PDF + email/WhatsApp. Convert to enrolment (GST invoicing is Phase 3).' } },
    { id: 'targets', label: 'Monthly Targets', spec: { dyn: 'monthlyTargets',
      sub: 'Targets per counsellor / branch / vertical — admissions count & revenue, set monthly.' } },
    { id: 'counsellor', label: 'Counsellor Performance', spec: { dyn: 'counsellorPerformance',
      sub: 'Leads handled, activity, conversion %, revenue, TAT, follow-up adherence & enrolments — with a leaderboard.' } },
  ] },

  /* ---------------- Engagement & Workflow ---------------- */
  { id: 'engage', label: 'Engagement & Workflow', icon: 'engage', subs: [
    { id: 'wabot', label: 'WhatsBot', spec: {
      sub: 'Meta Cloud API BSP. Auto-reply, lead qualification & fee reminders. Permitted users manage templates.',
      sprintNote: NOTE_S2,
      blocks: [
        { type: 'kpis', items: [kpi('Conversations (24h)', '0', 'wa'), kpi('Auto-qualified', '0', 'check'), kpi('Templates approved', '0', 'doc'), kpi('Read rate', '—', 'perf')] },
        { type: 'builder', title: 'Qualification bot flow', steps: [
          { k: 'trig', t: 'New lead message', d: 'Inbound WhatsApp from any source' },
          { k: 'act', t: 'Send greeting + menu', d: '"Which course interests you?"' },
          { k: 'cond', t: 'Branch on course', d: 'Route by course interest' },
          { k: 'act', t: 'Capture budget & timing', d: 'Auto-fill lead fields' },
          { k: 'end', t: 'Hand over to counsellor', d: 'Assign + notify owner' }] },
      ] } },
    { id: 'aibot', label: 'AI Bot', spec: {
      sub: 'AI chatbot on website & WhatsApp answering from a knowledge source, with human hand-over.',
      sprintNote: NOTE_S2,
      blocks: [
        { type: 'cfg', title: 'AI bot setup', rows: [
          { ic: 'intel', k: 'Channels', s: 'Website widget + WhatsApp', v: 'Both', toggle: true },
          { ic: 'book', k: 'Knowledge source', s: 'Course KB + FAQs', v: 'Linked', toggle: true },
          { ic: 'users', k: 'Human hand-over', s: 'On intent: pricing/complaint', v: 'Auto', toggle: true },
          { ic: 'cfg', k: 'AI provider', s: 'Gemini key in Settings', v: 'Gemini', toggle: true }] },
      ] } },
    { id: 'sms', label: 'Bulk SMS', spec: { dyn: 'bulkSms',
      sub: 'DLT-approved templates & sender ID, audience filters & opt-out handling. Any Indian gateway — the adapter is configured in Settings.' } },
    { id: 'wabulk', label: 'Bulk WhatsApp', spec: { dyn: 'bulkWhatsApp',
      sub: 'Meta Cloud API template messages, audience filters, delivery/read receipts & opt-out (a customer who replies STOP is never messaged again).' } },
    { id: 'email', label: 'Email Campaigns', spec: { dyn: 'emailCampaigns',
      sub: 'SMTP PER VERTICAL — each course line sends from its own domain. Templates, audience filters, bounce/failure capture & unsubscribe.' } },
    { id: 'journeys', label: 'Automation Journeys (Workflow)', spec: { dyn: 'journeys',
      sub: 'Triggers (new lead, stage change, no response, fee due, birthday) → conditions → actions. Idempotent: a lead never receives the same step twice.' } },
    { id: 'inbox', label: 'WhatsApp Live Chat', spec: { dyn: 'waChat',
      sub: 'Live WhatsApp inbox — bot auto-replies, lead qualification, quick replies & human hand-over.' } },
    { id: 'templates', label: 'Message Templates', spec: { dyn: 'templates',
      sub: 'Dynamic templates per channel — WhatsApp (Meta template name + params), SMS (sender ID + DLT), Email (subject + HTML) — with merge variables and a live preview.' } },
  ] },

  /* ---------------- Students & Academics ---------------- */
  { id: 'students', label: 'Students & Academics', icon: 'students', subs: [
    { id: 'all', label: 'Student Management', spec: {
      sub: 'Active students with fee & course details mapped per student.',
      actions: [['plus', 'Add student', 'primary']], sprintNote: NOTE_S2,
      blocks: [
        { type: 'kpis', items: [kpi('Active', '0', 'students'), kpi('New (MTD)', '0', 'plus'), kpi('Avg attendance', '—', 'check'), kpi('Fee defaulters', '0', 'rose')] },
        emptyTable('Student directory', ['Student', 'ID', 'Course · Batch', 'Attendance', 'Fee status'], 'Students appear here after the first enrolment'),
      ] } },
    { id: 'courses', label: 'Courses', spec: { dyn: 'courses',
      sub: 'Course master linked to branches & verticals — code, duration, fee, level, mode, syllabus. Bundles supported.',
      actions: [['plus', 'New course', 'primary']] } },
    { id: 'batches', label: 'Batches', spec: {
      sub: 'Code, course, trainer, branch, room, schedule, capacity, enrolled count. Transfer & waitlist supported.',
      actions: [['plus', 'New batch', 'primary']], sprintNote: NOTE_S2,
      blocks: [emptyTable('Batches', ['Batch', 'Course', 'Trainer', 'Schedule', 'Room', 'Enrolled', 'Status'], 'No batches yet')] } },
    { id: 'attendance', label: 'Attendance', spec: {
      sub: 'Trainer / biometric / self marking per session. Present / absent / late / leave with parent absence alerts.',
      sprintNote: NOTE_S2,
      blocks: [
        { type: 'kpis', items: [kpi('Today present', '0', 'check'), kpi('Absent', '0', 'rose'), kpi('Avg attendance', '—', 'perf'), kpi('Parent alerts sent', '0', 'wa')] },
        emptyTable('Today', ['Student', 'Status', 'Marked by', 'Time'], 'Attendance marking starts with the first batch'),
      ] } },
    { id: 'tests', label: 'Tests & Scores', spec: {
      sub: 'Quiz, mock & exam types with max marks, grading scheme, score entry, result sheets & sharing.',
      sprintNote: NOTE_S2,
      blocks: [emptyTable('Tests', ['Test', 'Type', 'Batch', 'Max', 'Avg', 'Top', 'Shared'], 'No tests yet')] } },
    { id: 'assignments', label: 'Assignments', spec: {
      sub: 'Create assignments with due dates, student upload/submission, grading & feedback.',
      sprintNote: NOTE_S2,
      blocks: [emptyTable('Assignments', ['Assignment', 'Batch', 'Due', 'Submitted', 'Graded'], 'No assignments yet')] } },
    { id: 'material', label: 'Study Material', spec: {
      sub: 'Upload material (PDF / video / links) per course or batch, with access control & download tracking. Embedded videos.',
      sprintNote: NOTE_S2,
      blocks: [emptyTable('Material library', ['Title', 'Type', 'Course', 'Access', 'Downloads'], 'No material uploaded yet')] } },
    { id: 'certs', label: 'Certificates', spec: {
      sub: 'Templates with completion criteria, auto serial numbers, verification & delivery.',
      sprintNote: NOTE_S2,
      blocks: [
        { type: 'kpis', items: [kpi('Issued (MTD)', '0', 'award'), kpi('Templates', '0', 'doc'), kpi('Verifications', '0', 'shield')] },
        { type: 'caps', title: 'Certificate engine', items: [
          cap('Templates', 'Per course / vertical'), cap('Completion criteria', 'Attendance + score'),
          cap('Auto serial number', 'Unique + QR verify'), cap('Auto-delivery', 'Email + WhatsApp')] },
      ] } },
    { id: 'progress', label: 'Academic Progress', spec: {
      sub: 'Progress = attendance + scores + assignments. Report cards visible to parents.',
      sprintNote: NOTE_S2,
      blocks: [{ type: 'hbars', title: 'Student progress', rows: [], empty: 'Progress charts appear once attendance & scores exist' }] } },
    { id: 'crosssell', label: 'Cross-Sell', spec: p2('Cross-sell engine (Phase 2)',
      'Recommend additional / next courses to current students. Triggers & offer tracking.',
      [cap('Next-course recommend', 'e.g. IELTS → PTE / Visa prep', true), cap('Trigger on completion', 'Auto offer at 80% progress', true), cap('Offer tracking', 'Sent → viewed → enrolled', true)]) },
    { id: 'admissions', label: 'Admissions', spec: {
      sub: 'On enrolment a lead converts to a student record. Branch-set Student ID format. Online Admission Form supported.',
      sprintNote: NOTE_S2,
      blocks: [
        { type: 'form', title: 'New admission', fields: [
          { label: 'Student name', ph: 'Enter name', req: 1 }, { label: 'Mobile', ph: '+91', req: 1 },
          { label: 'Course', ph: 'Course master', req: 1 }, { label: 'Batch', ph: 'Batch' },
          { label: 'Branch', ph: 'Branch master', req: 1 }, { label: 'Student ID', ph: 'Auto-generated' },
          { label: 'Parent / Guardian', ph: '' }, { label: 'Admission date', ph: 'Today' },
          { label: 'Fee plan', ph: 'Plan master', span: 2 }] },
        { type: 'caps', title: 'Admission options', items: [
          cap('Lead → student auto', 'On closure'), cap('Online Admission Form', 'Public link'),
          cap('Branch-set ID format', 'First-time setup'), cap('Sibling / family link', 'Connect records')] },
      ] } },
  ] },

  /* ---------------- Finance & Collections ---------------- */
  { id: 'finance', label: 'Finance & Collections', icon: 'finance', subs: [
    { id: 'dashboard', label: 'Finance Dashboard', spec: {
      sub: 'GST invoicing · Razorpay · branch & vertical-wise revenue · INR',
      sprintNote: 'Lite fee collection is live in Phase 1; full accounts (GST invoicing, Razorpay capture, Tally export) land in Phase 3.',
      blocks: [
        { type: 'kpis', cols: 5, items: [
          kpi('Total Collected (MTD)', '—', 'rupee'), kpi('Today', '—', 'rupee'),
          kpi('Pending Dues', '—', 'clock'), kpi('Refunds', '—', 'refresh'), kpi('Back-office', '—', 'users')] },
        { type: 'row2', cols: '1.4fr 1fr', items: [
          { type: 'hbars', title: 'Revenue by vertical', rows: [], empty: 'Revenue appears with the first collections' },
          { type: 'donut', title: 'Payment modes', center: '—', slices: [], empty: 'No collections yet' }] },
        emptyTable('Recent collections', ['Invoice', 'Student', 'Course', 'Amount', 'Mode', 'Branch', 'Status'], 'No collections yet'),
      ] } },
    { id: 'invoices', label: 'Invoices', spec: {
      sub: 'Auto GST invoices, separate numbering per branch & vertical, tax & proforma, PDF + email/WhatsApp.',
      actions: [['plus', 'New invoice', 'primary']], sprintNote: NOTE_S2,
      blocks: [emptyTable('Invoices', ['Invoice #', 'Student', 'Course', 'Amount', 'GST', 'Type', 'Status'], 'No invoices yet')] } },
    // Sprint 5 — LITE fee collection is live: a receipt + a collection entry, partial
    // payments, receipt PDF. Razorpay capture, GST invoices, dues/ageing and refunds are
    // Phase 3 and the screen says so on its face rather than implying otherwise.
    { id: 'collection', label: 'Fee Collection', spec: { dyn: 'feeCollection',
      sub: 'Cash, UPI, Card, Cheque, Online (recorded by hand). Partial payments. Auto receipts + PDF. Razorpay capture is Phase 3.' } },
    { id: 'dues', label: 'Fee Dues', spec: {
      sub: 'Dues per student / installment, ageing buckets, automatic reminders (SMS/WhatsApp/email) & escalation.',
      sprintNote: NOTE_S2,
      blocks: [
        { type: 'kpis', items: [kpi('Total dues', '—', 'rupee'), kpi('Defaulters', '0', 'rose'), kpi('Reminders sent', '0', 'wa'), kpi('Overdue >30d', '—', 'clock')] },
        { type: 'hbars', title: 'Dues ageing', rows: [], empty: 'Ageing buckets appear with the first dues' },
      ] } },
    { id: 'plans', label: 'Payment Plans', spec: {
      sub: 'Installment plans — down payment, EMI schedule, late-fee rules. Branch / vertical / course-wise.',
      blocks: [
        { type: 'table', title: 'Plan templates', cols: ['Plan', 'Down payment', 'Installments', 'Schedule', 'Late fee'], rows: [
          ['Full Payment', '100%', '—', '—', '—'],
          ['3 EMI', '40%', '3', 'Monthly', 'Configurable'],
          ['6 EMI', '25%', '6', 'Monthly', 'Configurable'],
          ['Custom', 'Configurable', 'Custom', 'Custom dates', 'Configurable']] },
      ] } },
    { id: 'scholar', label: 'Scholarships', spec: {
      sub: 'Percentage or fixed. Approval workflow at manager level. Scholarship reason mandatory.',
      sprintNote: NOTE_S2,
      blocks: [emptyTable('Scholarship requests', ['Student', 'Type', 'Value', 'Reason', 'Approver', 'Status'], 'No scholarship requests yet')] } },
    { id: 'discounts', label: 'Discounts', spec: {
      sub: 'Referral, Early Bird, Employee, Sibling, Promotional — role-based approval limits at closure / invoice.',
      blocks: [
        { type: 'table', title: 'Discount types', cols: ['Type', 'Applies at', 'Default', 'Approval needed above'], rows: [
          ['Early Bird', 'Closure', 'Configurable', 'Manager'], ['Referral', 'Closure', 'Configurable', '—'],
          ['Sibling', 'Invoice', 'Configurable', 'Manager'], ['Employee', 'Closure', 'Configurable', 'Manager'],
          ['Promotional', 'Invoice', 'Variable', 'Manager']] },
      ] } },
    { id: 'revenue', label: 'Revenue', spec: {
      sub: 'Collection-based & accrual-based reports by branch / vertical / course / counsellor / period.',
      sprintNote: NOTE_S2,
      blocks: [{ type: 'hbars', title: 'Revenue by vertical', rows: [], empty: 'Revenue reports fill after first collections' }] } },
    { id: 'refunds', label: 'Refunds', spec: {
      sub: 'Refund request → approval workflow, partial refunds, refund mode & accounting impact.',
      sprintNote: NOTE_S2,
      blocks: [emptyTable('Refund requests', ['Student', 'Amount', 'Type', 'Mode', 'Approver', 'Status'], 'No refund requests yet')] } },
    { id: 'reports', label: 'Collection Reports', spec: {
      sub: 'Daily, monthly, branch / vertical / course / counsellor / mode-wise. Tally export.',
      blocks: [
        { type: 'table', title: 'Report shortcuts', cols: ['Report', 'Range', 'Format'], rows: [
          ['Daily collection', 'Today', { b: ['Excel / PDF', 'b-green'] }],
          ['Monthly revenue', 'Month', { b: ['Excel / PDF', 'b-green'] }],
          ['Due report', 'All', { b: ['Excel', 'b-green'] }],
          ['Back-office report', 'MTD', { b: ['Excel', 'b-green'] }],
          ['Refund report', 'MTD', { b: ['Excel', 'b-green'] }],
          ['Mode-wise / Counsellor-wise', 'Custom', { b: ['Excel', 'b-green'] }]] },
      ] } },
  ] },

  /* ---------------- Calls ---------------- */
  { id: 'calls', label: 'Calls', icon: 'calls', subs: [
    { id: 'overview', label: 'Calls', spec: gen('Calls', 'Calls') },
    { id: 'dialer', label: 'Dialer', spec: {
      sub: 'NeoDove integration. Manual, preview & predictive dialer. Call from any lead/student record.',
      sprintNote: 'Telephony / calls are out of scope — this screen is a design reference only; no dialler ships.',
      blocks: [
        { type: 'kpis', items: [kpi('Calls today', '0', 'calls'), kpi('Connected', '—', 'check'), kpi('Avg duration', '—', 'clock'), kpi('In queue', '0', 'list')] },
        { type: 'caps', title: 'Dialer modes', items: [
          cap('Manual / Preview', 'Counsellor-paced'), cap('Predictive', 'Auto-dial queue'),
          cap('Click-to-call', 'From lead record'), cap('Number masking', 'Privacy on outbound')] },
      ] } },
    { id: 'click', label: 'Click-to-Call', spec: {
      sub: 'Trigger a call from the lead list with number masking for privacy.',
      blocks: [{ type: 'caps', title: 'Click-to-call', items: [
        cap('From lead / student / contact', 'One tap'), cap('Number masking', 'Caller ID hidden'),
        cap('Auto-log + disposition', 'After each call'), cap('Mobile dialer', 'Call via phone')] }] } },
    { id: 'incoming', label: 'Incoming Calls', spec: {
      sub: 'IVR routing with screen-pop of the matching CRM record on incoming call.',
      blocks: [{ type: 'builder', title: 'IVR routing', steps: [
        { k: 'trig', t: 'Incoming call', d: 'Caller dials business number' },
        { k: 'cond', t: 'IVR menu', d: 'Route by course / department' },
        { k: 'act', t: 'Match CRM record', d: 'Screen-pop to owner' },
        { k: 'end', t: 'Route by skill / vertical', d: 'Connect to counsellor' }] }] } },
    { id: 'outgoing', label: 'Outgoing Calls', spec: gen('Calls', 'Outgoing Calls') },
    { id: 'missed', label: 'Missed Calls', spec: {
      sub: 'Auto-create a lead from a missed call to power missed-call campaigns.',
      sprintNote: 'Telephony is out of scope, so missed-call auto-leads are not built — this screen is a design reference only.',
      blocks: [emptyTable('Missed-call leads', ['Number', 'Time', 'Auto-lead', 'Campaign', 'Assigned'], 'No missed-call leads yet')] } },
    { id: 'transfer', label: 'Call Transfer', spec: gen('Calls', 'Call Transfer') },
    { id: 'conference', label: 'Conference Calling', spec: gen('Calls', 'Conference Calling') },
    { id: 'routing', label: 'Call Routing', spec: gen('Calls', 'Call Routing') },
    { id: 'logs', label: 'Call Logs', spec: {
      sub: 'Every call auto-logged against the lead with a disposition prompt after each call.',
      sprintNote: 'Telephony is out of scope, so automatic call logging is not built — this screen is a design reference only.',
      blocks: [emptyTable('Call logs', ['Lead', 'Direction', 'Duration', 'Disposition', 'Owner', 'Recording'], 'No calls logged yet')] } },
    { id: 'recordings', label: 'Recordings', spec: {
      sub: 'Recordings via third-party software. Access control & retention. Caller consent captured.',
      blocks: [{ type: 'cfg', title: 'Recording settings', rows: [
        { ic: 'calls', k: 'Recording source', s: 'Third-party software', v: 'External', toggle: true },
        { ic: 'shield', k: 'Caller consent', s: 'Played before recording', v: 'On', toggle: true },
        { ic: 'clock', k: 'Retention', s: 'Auto-purge after period', v: '90 days', toggle: true },
        { ic: 'admin', k: 'Access control', s: 'Manager + owner only', v: 'Restricted', toggle: true }] }] } },
    { id: 'telSettings', label: 'Telephony Settings', spec: {
      sub: 'Provider, numbers & routing. Transfer / conference not required per requirements.',
      blocks: [{ type: 'cfg', title: 'Provider', rows: [
        { ic: 'calls', k: 'Provider', s: 'NeoDove (Exotel/Knowlarity/MyOperator/Tata ready)', v: 'NeoDove', toggle: true },
        { ic: 'phone', k: 'Dialer', s: 'Mobile + predictive', v: 'On', toggle: true },
        { ic: 'cfg', k: 'Transfer / Conference', s: 'Not required', v: 'Off', toggle: false }] }] } },
  ] },

  /* ---------------- Communication Intelligence (P2) ---------------- */
  { id: 'intel', label: 'Communication Intelligence', icon: 'intel', phase: 'P2', subs: [
    { id: 'activity', label: 'Call Activity', spec: gen('Communication Intelligence', 'Call Activity') },
    { id: 'insights', label: 'Call Insights', spec: p2('Call Insights & Summaries',
      'Post-call transcription, summaries, intent & keyword tracking across English, Hindi & mixed-language calls.',
      [cap('Transcription', 'Multi-language', true), cap('AI summaries', 'Per call', true), cap('Intent detection', 'Pricing / objection / interest', true), cap('Keyword tracking', 'Course & competitor mentions', true)]) },
    { id: 'ratings', label: 'Call Ratings', spec: gen('Communication Intelligence', 'Call Ratings') },
    { id: 'aiusage', label: 'AI Usage', spec: gen('Communication Intelligence', 'AI Usage') },
    { id: 'convanalytics', label: 'Conversation Analytics', spec: gen('Communication Intelligence', 'Conversation Analytics') },
    { id: 'sentiment', label: 'Sentiment Analysis', spec: p2('Sentiment & Conversation Analytics',
      'Sentiment scoring, conversation analytics & follow-up suggestions.',
      [cap('Sentiment score', 'Positive / neutral / negative', true), cap('Objection detection', 'Auto-flagged moments', true), cap('Follow-up suggestions', 'AI next step', true), cap('Conversation analytics', 'Talk ratio, pace', true)]) },
    { id: 'quality', label: 'Quality Monitoring', spec: p2('Quality Monitoring',
      'AI-scored quality scorecards reviewing recorded calls.',
      [cap('AI scorecards', 'Define criteria', true), cap('Quality rating', 'Per call / counsellor', true), cap('Coaching flags', 'Low-score alerts', true)]) },
    { id: 'reclib', label: 'Recording Library', spec: gen('Communication Intelligence', 'Recording Library') },
    { id: 'transcription', label: 'Call Transcription', spec: genP2('Communication Intelligence', 'Call Transcription') },
    { id: 'summaries', label: 'Call Summaries', spec: genP2('Communication Intelligence', 'Call Summaries') },
    { id: 'intent', label: 'Intent Detection', spec: genP2('Communication Intelligence', 'Intent Detection') },
    { id: 'keyword', label: 'Keyword Tracking', spec: genP2('Communication Intelligence', 'Keyword Tracking') },
    { id: 'objection', label: 'Objection Detection', spec: genP2('Communication Intelligence', 'Objection Detection') },
    { id: 'followsug', label: 'Follow-up Suggestions', spec: genP2('Communication Intelligence', 'Follow-up Suggestions') },
    { id: 'aiset', label: 'AI Settings', spec: p2('AI Provider & Cost',
      'Deepseek / Gemini with keys in Settings. Budget ceiling per minute.',
      [cap('Provider', 'Deepseek / Gemini', true), cap('Keys in Settings', 'Bring your own', true), cap('Budget ceiling', 'Per call / minute', true), cap('Post-call only', 'No real-time needed', true)]) },
  ] },

  /* ---------------- Analytics & Reports ---------------- */
  { id: 'analytics', label: 'Analytics & Reports', icon: 'analytics', subs: [
    // Sprint 6 — all live. The catalog table is gone: the client's saved reports ARE the
    // catalog, and a hardcoded list of reports that do not exist is the fake data this
    // project's design rule forbids.
    { id: 'standard', label: 'Reports', spec: { dyn: 'savedReports',
      sub: 'Your saved reports — run, share, schedule or export any of them.' } },
    { id: 'builder', label: 'Report Builder', spec: { dyn: 'reportBuilder',
      sub: 'Self-service builder — pick a data source, columns, filters, grouping and a date range. Save it, share it, schedule it, export it.' } },
    { id: 'campreports', label: 'Campaign Reports', spec: { dyn: 'campaignRoi',
      sub: 'Spend, leads, enrolments, cost per lead and revenue, by campaign.' } },
    { id: 'activity', label: 'Activity Reports', spec: { dyn: 'activityReports',
      sub: 'Track user activity — logins, follow-ups, notes and edits — by user / branch / period.' } },
    { id: 'tat', label: 'TAT Reports', spec: { dyn: 'tatReport',
      sub: 'First response, time-in-stage and lead-to-enrolment turnaround.' } },
    { id: 'funnel', label: 'Funnel Analytics', spec: { dyn: 'funnelAnalytics',
      sub: 'Stage-to-stage conversion and drop-off.' } },
    { id: 'roi', label: 'Campaign ROI', spec: { dyn: 'campaignRoi',
      sub: 'Ad spend from the campaign record. Cost per lead, cost per enrolment and return on spend.' } },
    { id: 'counseloranalytics', label: 'Counselor Analytics', spec: gen('Analytics & Reports', 'Counselor Analytics') },
    { id: 'counselorperf', label: 'Counselor Performance', spec: gen('Analytics & Reports', 'Counselor Performance') },
    { id: 'revanalytics', label: 'Revenue Analytics', spec: gen('Analytics & Reports', 'Revenue Analytics') },
    { id: 'studentanalytics', label: 'Student Analytics', spec: gen('Analytics & Reports', 'Student Analytics') },
    { id: 'forecasting', label: 'Forecasting', spec: gen('Analytics & Reports', 'Forecasting') },
    { id: 'delivery', label: 'Scheduled Delivery', spec: { dyn: 'scheduledDelivery',
      sub: 'Any saved report, emailed daily / weekly / monthly with the file attached. Pause it, run it now, and read the delivery history.' } },
  ] },

  /* ---------------- Workspace & Productivity ---------------- */
  { id: 'work', label: 'Workspace & Productivity', icon: 'work', subs: [
    { id: 'socialinbox', label: 'Social Inbox', spec: gen('Workspace & Productivity', 'Social Inbox') },
    { id: 'socialcomments', label: 'Social Comments', spec: gen('Workspace & Productivity', 'Social Comments') },
    { id: 'socialpublisher', label: 'Social Publisher', spec: gen('Workspace & Productivity', 'Social Publisher') },
    { id: 'chat', label: 'Team Chat', spec: { dyn: 'teamChat',
      sub: 'Built-in internal messaging — channels scoped to a branch, a vertical, or everyone. No external Slack/Teams needed.' } },
    // TASKS ARE THE FOLLOW-UP MODULE. The doc says "same fields & statuses as lead
    // follow-ups", and a second task screen with the same fields is the fork that
    // sentence forbids: two "My Tasks" counts, two overdue sweeps, two answers.
    { id: 'tasks', label: 'Tasks', spec: { dyn: 'workTasks',
      sub: 'Shared task management — the same tasks, fields and statuses as lead follow-ups.' } },
    { id: 'notes', label: 'Notes', spec: { dyn: 'workNotes',
      sub: 'Private and shared notes, pinned and searchable.' } },
    { id: 'kb', label: 'Knowledge Base', spec: { dyn: 'knowledgeBase',
      sub: 'Internal staff KB — categories, search and access control.' } },
    { id: 'announce', label: 'Announcements', spec: { dyn: 'announcements',
      sub: 'Org / branch announcements with audience targeting and read tracking.' } },
    { id: 'docs', label: 'Shared Documents', spec: {
      sub: 'Documents shared inside internal team message.',
      sprintNote: NOTE_S2,
      blocks: [emptyList('Recent shared files', 'No shared files yet')] } },
  ] },

  /* ---------------- HR & Workforce ---------------- */
  { id: 'hr', label: 'HR & Workforce', icon: 'hr', subs: [
    { id: 'directory', label: 'Employee Directory', spec: {
      sub: 'Emp ID, designation, department, branch, joining date, reporting manager, status & documents.',
      actions: [['plus', 'Add employee', 'primary']], sprintNote: 'Basic HR lands in Phase 2.',
      blocks: [emptyTable('Employees', ['Employee', 'Emp ID', 'Designation', 'Branch', 'Manager', 'Status'], 'Employee records land with the HR module')] } },
    { id: 'attendance', label: 'Attendance', spec: {
      sub: 'Web check-in, biometric or geo-attendance with shifts.',
      sprintNote: 'Basic HR lands in Phase 2.',
      blocks: [
        { type: 'kpis', items: [kpi('Present today', '0', 'check'), kpi('On leave', '0', 'cal'), kpi('Late', '0', 'clock'), kpi('Avg in-time', '—', 'clock')] },
        { type: 'caps', title: 'Attendance modes', items: [
          cap('Web check-in', 'Browser'), cap('Biometric', 'Device integration'),
          cap('Geo-attendance', 'Location-stamped'), cap('Shifts', 'Configurable')] },
      ] } },
    { id: 'leaves', label: 'Leaves', spec: {
      sub: 'Leave types, balances, apply-approve workflow & holiday calendar.',
      sprintNote: 'Basic HR lands in Phase 2.',
      blocks: [emptyTable('Leave requests', ['Employee', 'Type', 'Days', 'From', 'Approver', 'Status'], 'No leave requests yet')] } },
    { id: 'payroll', label: 'Salary', spec: {
      sub: 'Components, payslips, statutory PF / ESI / TDS.',
      sprintNote: 'Basic HR lands in Phase 2.',
      blocks: [
        { type: 'kpis', items: [kpi('Monthly payroll', '—', 'rupee'), kpi('Payslips', '0', 'doc'), kpi('PF/ESI/TDS', '—', 'shield')] },
        { type: 'caps', title: 'Payroll', items: [
          cap('Salary components', 'Earnings + deductions'), cap('Payslips', 'Auto-generated'),
          cap('Statutory', 'PF / ESI / TDS'), cap('Bank details', 'Sensitive · restricted')] },
      ] } },
    { id: 'incentives', label: 'Incentives', spec: {
      sub: 'Incentive rules on admissions / revenue / targets, calculation, approval & payout tracking.',
      sprintNote: 'Basic HR lands in Phase 2.',
      blocks: [emptyTable('Incentive payouts', ['Counsellor', 'Basis', 'Achieved', 'Incentive', 'Status'], 'No incentive payouts yet')] } },
    { id: 'bank', label: 'Bank', spec: gen('HR & Workforce', 'Bank') },
    { id: 'performance', label: 'Performance', spec: {
      sub: 'Appraisal cycles, KRAs / goals & ratings.',
      blocks: [{ type: 'caps', title: 'Appraisals', items: [
        cap('Appraisal cycles', 'Quarterly / annual'), cap('KRAs & goals', 'Per role'),
        cap('Ratings', 'Manager + self'), cap('Linked to incentives', 'Score → payout')] }] } },
    { id: 'hiring', label: 'Hiring', spec: {
      sub: 'Job posts, candidate pipeline, interviews & offers.',
      sprintNote: 'Basic HR lands in Phase 2.',
      blocks: [emptyTable('Hiring pipeline', ['Role', 'Applicants', 'Interview', 'Offer', 'Status'], 'No open positions yet')] } },
  ] },

  /* ---------------- Operations (P2) ---------------- */
  { id: 'ops', label: 'Operations', icon: 'ops', phase: 'P2', subs: [
    { id: 'catalog', label: 'Catalog', spec: p2('Catalog', 'Physical items — books, kits & merchandise sold to students.',
      [cap('Books & kits', 'Per item', true), cap('Pricing', 'Per item / bundle', true), cap('Student-facing', 'Add to admission', true)]) },
    { id: 'inventory', label: 'Inventory', spec: p2('Inventory', 'Stock in/out with reorder levels & per-branch stock.',
      [cap('Stock in/out', 'Movements', true), cap('Reorder levels', 'Low-stock alerts', true), cap('Per-branch stock', 'Branch visibility', true)]) },
    { id: 'assets', label: 'Assets', spec: p2('Assets', 'Register for computers, furniture & equipment with assignment, maintenance & depreciation.',
      [cap('Asset register', 'Tagged', true), cap('Assignment', 'To staff / room', true), cap('Maintenance', 'Schedule', true), cap('Depreciation', 'Auto', true)]) },
    { id: 'vendors', label: 'Vendor Management', spec: p2('Vendor Management', 'Vendor master with contacts, categories & contracts.',
      [cap('Vendor master', 'Profiles', true), cap('Categories', 'Grouping', true), cap('Contracts', 'Stored', true)]) },
    { id: 'procure', label: 'Procurement', spec: p2('Procurement', 'Purchase request → PO → GRN → invoice with approvals.',
      [cap('Purchase request', 'Raise PR', true), cap('PO → GRN', 'Goods receipt', true), cap('Invoice match', '3-way', true), cap('Approvals', 'Workflow', true)]) },
  ] },

  /* ---------------- Administration ---------------- */
  { id: 'admin', label: 'Administration', icon: 'admin', subs: [
    { id: 'branches', label: 'Branch Management', spec: { dyn: 'branches',
      sub: 'Create & configure branches and verticals. Super Admin / permitted managers.' } },
    { id: 'verticalmgmt', label: 'Vertical Management', spec: { dyn: 'verticals',
      sub: 'Business lines (brands) under each Branch — different per Branch. SMTP configured per vertical.' } },
    { id: 'pipelines', label: 'Pipeline Management', spec: { dyn: 'pipelines',
      sub: 'Multiple pipelines per vertical, each with its own stages & movement rules.' } },
    { id: 'users', label: 'Users', spec: { dyn: 'users',
      sub: 'Create / edit / deactivate, bulk import & SSO (Google / Microsoft). Assign to multiple branches / pipelines.',
      actions: [['plus', 'Add user', 'primary']] } },
    { id: 'roles', label: 'Roles & Permissions', spec: { dyn: 'roles',
      sub: 'Custom roles — module, field & record-level. Partial roles instead of full modules.',
      actions: [['plus', 'New role', 'primary']] } },
    { id: 'courseconfig', label: 'Course Configuration', spec: { dyn: 'courses',
      sub: 'Configure courses & fees. Approval step for fee changes.',
      actions: [['plus', 'New course', 'primary']] } },
    // Sanctioned addition (UAT: "edit option for Course master and all masters") — see design spec §Sanctioned additions.
    { id: 'masters', label: 'Masters', spec: { dyn: 'mastersAdmin',
      sub: 'Every dropdown master in one place — add, edit, view and activate/deactivate values (states, cities, sources, courses, statuses, tags & more).' } },
    { id: 'workflow', label: 'Workflow Automation', spec: {
      sub: 'Admin-built rules (same engine as Automation Journeys). Who can build them.',
      blocks: [{ type: 'caps', title: 'Workflow automation', items: [
        cap('Trigger → action', 'Same as journeys'), cap('Admin-built rules', 'Org-wide'),
        cap('Builder access', 'Super Admin / Org Admin'), cap('Conditions & delays', 'Full control')] }] } },
    { id: 'integrations', label: 'Integrations', spec: {
      sub: 'Lead-source & messaging integrations. Connect and manage lead tools in Marketing › Integrations (Available Tools, field mapping, connected list, logs); credentials live in Settings › Channels.',
      blocks: [{ type: 'table', title: 'Integrations', cols: ['System', 'Type', 'Status'], rows: [
        ['Facebook Leads (Facebook & Instagram Lead Ads)', 'Ad platform', { b: ['Live · Marketing › Integrations', 'b-green'] }],
        ['Meta WhatsApp (WhatsApp API)', 'Messaging', { b: ['Built · connect in Settings › Channels', 'b-green'] }],
        ['Google Ads lead forms', 'Ad platform', { b: ['Live · Marketing › Integrations', 'b-green'] }],
        ['Google Sheets pull', 'Lead source', { b: ['Live · needs Google credentials', 'b-amber'] }],
        ['Google Form', 'Lead source', { b: ['Live · Marketing › Integrations', 'b-green'] }],
        ['IndiaMART', 'Marketplace', { b: ['Live · paste webhook URL in panel', 'b-green'] }],
        ['JustDial', 'Marketplace', { b: ['Live · paste webhook URL in panel', 'b-green'] }],
        ['TradeIndia', 'Marketplace', { b: ['Live · paste webhook URL in panel', 'b-green'] }],
        ['Housing.com', 'Marketplace', { b: ['Live · paste webhook URL in panel', 'b-green'] }],
        ['99acres', 'Marketplace', { b: ['Live · paste webhook URL in panel', 'b-green'] }],
        ['Custom Integration / Webhook', 'Lead source', { b: ['Live · Marketing › Integrations', 'b-green'] }],
        ['Website form endpoint', 'Website', { b: ['Live · Marketing › Integrations', 'b-green'] }],
        ['Razorpay', 'Payment', { b: ['Config ready · live payments Phase 3', 'b-amber'] }],
        ['NeoDove', 'Telephony', { b: ['Out of scope', 'b-gray'] }],
        ['SMS (DLT)', 'Messaging', { b: ['Built · needs gateway credentials', 'b-amber'] }],
        ['Tally / Zoho Books', 'Accounting', { b: ['Phase 3', 'b-gray'] }],
        ['Biometric device', 'Attendance', { b: ['Phase 2', 'b-gray'] }],
        ['Gemini / Deepseek', 'AI', { b: ['Phase 2 (AI)', 'b-amber'] }]] }] } },
    { id: 'api', label: 'API Access', spec: { dyn: 'apiModule',
      sub: 'Developer API — generate keys (shown once, stored hashed), enable/disable & revoke, read the endpoint docs, and see every inbound API request in the log. Keys authenticate the public create-lead / list-leads endpoints.' } },
    { id: 'compliance', label: 'Compliance', spec: {
      sub: 'DPDP / consent capture, DLT records, audit requirements & data-retention policy.',
      blocks: [{ type: 'cfg', title: 'Compliance', rows: [
        { ic: 'shield', k: 'DPDP consent', s: 'Capture at lead create', v: 'On', toggle: true },
        { ic: 'doc', k: 'DLT records', s: 'SMS template registry', v: 'Linked', toggle: true },
        { ic: 'calls', k: 'Recording consent', s: 'IVR pre-roll', v: 'On', toggle: true },
        { ic: 'clock', k: 'Data retention', s: 'Auto-purge policy', v: 'Configurable', toggle: true }] }] } },
    { id: 'audit', label: 'Audit Logs', spec: { dyn: 'audit',
      sub: 'Every user action across CRM & ERP — work done, edits, updates, messages, emails & calls. Filter by type, user, module & date.' } },
    // Sanctioned addition (client-approved, not in the prototype nav) — see design spec §Sanctioned additions.
    { id: 'errorlogs', label: 'Error Logs', spec: { dyn: 'errorLogs',
      sub: 'Every captured error & issue across API and web — grouped by root cause, bugs highlighted by severity, with stack traces and a resolve workflow.' } },
    // Sanctioned addition (soft-delete client request) — see design spec §Sanctioned additions.
    { id: 'deleted', label: 'Deleted Items', spec: { dyn: 'deletedItems',
      sub: 'Soft-deleted records across every module — deleted rows are hidden from lists, dropdowns & KPIs while their children stay intact. Review impact and restore (Super Admin / Org Admin).' } },
    { id: 'settings', label: 'Settings', spec: { dyn: 'settings',
      sub: 'Channels & credentials (SMTP per vertical · WhatsApp · SMS · Razorpay per vertical · AI keys — encrypted at rest), business hours, holidays, numbering series, automation guardrails and the notification matrix.' } },
  ] },

  /* ---------------- Help & Support ---------------- */
  { id: 'help', label: 'Help & Support', icon: 'help', subs: [
    { id: 'tickets', label: 'Support Tickets', spec: p2('Support Tickets',
      'Tickets raised by internal staff or students/customers — categories, priority, SLA, assignment & statuses.',
      [cap('Categories & priority', 'Triage', true), cap('SLA & assignment', 'Routing', true), cap('Statuses', 'Open → resolved', true)]) },
    { id: 'helpcenter', label: 'Help Center', spec: {
      sub: 'In-app help articles maintained by Admin. Available at launch.',
      sprintNote: 'Help articles are being authored — they publish before go-live.',
      blocks: [emptyTable('Help articles', ['Article', 'Category', 'Views'], 'Help articles publish before go-live')] } },
    { id: 'guides', label: 'Product Guides', spec: {
      sub: 'Step-by-step guides for using the system. Available at launch.',
      sprintNote: 'Guides publish before go-live.',
      blocks: [emptyList('Guides', 'Product guides publish before go-live')] } },
    { id: 'training', label: 'Training Videos', spec: p2('Training Videos', 'Host training videos in-app.',
      [cap('In-app hosting', 'Embedded', true), cap('Per module', 'Organised', true)]) },
    { id: 'releases', label: 'Release Notes', spec: p2('Release Notes', 'Publish release notes / changelog to users inside the app.',
      [cap('Changelog', 'In-app', true), cap('Version history', 'Tracked', true)]) },
  ] },

  /* ---------------- Franchise (P2) ---------------- */
  { id: 'fran', label: 'Franchise', icon: 'fran', phase: 'P2', subs: [
    { id: 'dashboard', label: 'Franchise Dashboard', spec: p2('Franchise Dashboard',
      'A franchise is a single branch. KPIs: active franchises, royalty due/collected, top/bottom performers, compliance, renewals.',
      [cap('HO overview', 'All franchises', true), cap('Per-franchise view', 'Partner portal', true), cap('Royalty due / collected', 'At a glance', true), cap('Compliance status', 'Score & renewals', true)]) },
    { id: 'partners', label: 'Partners', spec: p2('Franchise Partners',
      'Franchise ID, legal & brand name, owner, location, mapped territory/branch, status, KYC documents.',
      [cap('Partner profiles', 'Full KYC', true), cap('Branch-mapped', '1 franchise = 1 branch', true), cap('Partner portal login', 'Own data only', true)]) },
    { id: 'agreements', label: 'Agreements & Renewals', spec: p2('Agreements & Renewals',
      'Agreement number, fee, royalty model, territory & signed PDF. Renewal reminders & history.',
      [cap('Signed PDF / e-sign', 'Stored', true), cap('Renewal reminders', 'Before expiry', true), cap('Term changes', 'On renewal', true)]) },
    { id: 'territory', label: 'Territory', spec: p2('Territory Management',
      'Territories by city / pincode / region / radius. Exclusive with overlap prevention.',
      [cap('Define territory', 'City / pincode / radius', true), cap('Exclusive', 'No overlap', true), cap('Conflict check', 'On assign', true)]) },
    { id: 'onboarding', label: 'Onboarding', spec: p2('Onboarding',
      'Stages: application → agreement → fee → setup → training → go-live with required documents.',
      [cap('Checklist', 'Stage-wise', true), cap('Documents', 'Required uploads', true), cap('Progress tracking', 'Per partner', true)]) },
    { id: 'royaltyRules', label: 'Royalty Rules', spec: p2('Royalty Rules',
      'Four models — Fixed, Percentage, Hybrid & Minimum. Different franchises, different models.',
      [cap('Fixed', 'Flat amount', true), cap('Percentage', '% of revenue', true), cap('Hybrid', 'Fixed + %', true), cap('Minimum', 'Guaranteed floor', true)]) },
    { id: 'royaltyInv', label: 'Royalty Invoices', spec: p2('Royalty Invoices & Collection',
      'Royalty invoice numbering, GST, schedule, collection & reconciliation. Separate from student invoices.',
      [cap('Schedule', 'Monthly / quarterly', true), cap('Auto-generate', 'On due date', true), cap('Collection & gateway', 'Reconcile', true), cap('Separate series', 'Not student invoices', true)]) },
    { id: 'outstanding', label: 'Outstanding Royalties', spec: p2('Outstanding Royalties',
      'Ageing of unpaid royalties, reminders & escalation, late-fee / penalty rules.',
      [cap('Ageing buckets', '0–30 / 30–60 / 60+', true), cap('Reminders', 'Auto', true), cap('Late-fee rules', 'Configurable', true)]) },
    { id: 'revshare', label: 'Revenue Sharing', spec: p2('Revenue Sharing',
      'Splits between HO & franchise beyond royalty — defined, applied & reported.',
      [cap('Split definition', '% or tiered', true), cap('Auto-applied', 'On revenue', true), cap('Reported', 'HO & partner', true)]) },
    { id: 'perf', label: 'Targets & Performance', spec: p2('Franchise Targets & Performance',
      'Targets (admissions, revenue, collections), metrics & comparison vs target.',
      [cap('Targets', 'Per franchise', true), cap('Metrics', 'Revenue, conv, collection%', true), cap('Vs target', 'Tracked', true)]) },
    { id: 'leaderboard', label: 'Leaderboard & Benchmarking', spec: p2('Leaderboard & Benchmarking',
      'Ranking & benchmarking vs peer average / top performer / target.',
      [cap('Ranking', 'Configurable basis', true), cap('Visibility', 'Own rank or all', true), cap('Benchmark', 'Peer / top / target', true)]) },
    { id: 'compliance', label: 'Compliance & Audits', spec: p2('Franchise Compliance & Audits',
      'Compliance score, audit schedules, checklists, findings & corrective actions with sign-off.',
      [cap('Compliance score', 'Brand, fee, docs', true), cap('Audit schedules', 'Financial / operational / brand', true), cap('Audit reports', 'Findings + corrective', true)]) },
    { id: 'brand', label: 'Brand & Training', spec: p2('Brand Guidelines & Training',
      'Brand assets with acknowledgement; training programs, attendance, completion & certification.',
      [cap('Brand guidelines', 'Assets + adherence', true), cap('Training programs', 'Schedule & attendance', true), cap('Certifications', 'On completion', true)]) },
    { id: 'franReports', label: 'Franchise Reports', spec: p2('Franchise Reports',
      'Revenue, royalty (due vs collected vs outstanding), performance & franchise analytics.',
      [cap('Revenue reports', 'By franchise / territory', true), cap('Royalty reports', 'Due / collected / outstanding', true), cap('Analytics', 'Growth, churn risk, forecasting', true)]) },
  ] },

  /* ---------------- Site Map ---------------- */
  { id: 'map', label: 'All Features · Site Map', icon: 'grid', subs: [
    { id: 'all', label: 'Site Map', spec: { dyn: 'sitemap' } },
  ] },
];

export const findScreen = (m: string, s: string): { mod: ModuleItem; sub: SubItem } | null => {
  const mod = APP.find((x) => x.id === m);
  const sub = mod?.subs.find((x) => x.id === s);
  return mod && sub ? { mod, sub } : null;
};
