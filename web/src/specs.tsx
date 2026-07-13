/**
 * Screen specs — ported 1:1 from the prototype's APP array (post reconcileNav()).
 * Every module / submenu / block / table column matches the prototype exactly.
 * Fake demo people & numbers are NOT ported: dynamic screens fetch real data
 * (spec.dyn -> component in dyn.tsx); everything else renders clean zero/empty
 * states plus the prototype's own capability/config descriptions.
 */

export interface KpiItem { lab: string; val: string; delta?: string; tone?: 'up' | 'down' | 'flat'; ic?: string }
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

const NOTE_S2 = 'Backend for this module arrives in Sprint 3 — the screen design is final; data will appear here automatically.';
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
      actions: [['cal', 'This month', 'ghost'], ['plus', 'Quick add lead', 'primary']] } },
    { id: 'quickcontact', label: 'Quick Contact', spec: { dyn: 'quickContact',
      sub: 'Search an existing lead by Branch / Vertical / Pipeline / Campaign, or add a new one in seconds — then call / WhatsApp / email straight from here.' } },
    { id: 'mytasks', label: 'My Tasks', spec: { dyn: 'myTasks',
      sub: 'Your open tasks — auto-created from follow-ups & stage changes, plus manually added.',
      actions: [['plus', 'Add task', 'primary']] } },
    { id: 'todayfollowups', label: "Today's Follow-ups", spec: { dyn: 'todayFollowups',
      sub: 'Every lead with a follow-up due today (and overdue), sorted hot-first. Overdue highlighted in red.',
      actions: [['filter', 'Filters', 'ghost']] } },
    { id: 'quickstats', label: 'Quick Stats', spec: { dyn: 'quickStats',
      sub: 'Key numbers at a glance for any range — today, week, month, or a custom date range.',
      actions: [['cal', 'This month', 'ghost']] } },
    { id: 'calendar', label: 'Calendar', spec: { dyn: 'calendar',
      sub: 'Follow-ups, demos, batch sessions, holidays & leaves — two-way Google/Outlook sync.' } },
    { id: 'walkins', label: 'Walk-ins', spec: {
      sub: 'Capture branch visitors and convert directly into assigned leads.',
      actions: [['plus', 'Add walk-in', 'primary']], sprintNote: NOTE_S2,
      blocks: [
        { type: 'kpis', items: [kpi('Walk-ins today', '0', 'users'), kpi('Converted', '0', 'check'), kpi('Demo booked', '0', 'cal'), kpi('Avg wait', '—', 'clock')] },
        emptyTable("Today's walk-ins", ['Visitor', 'Interest', 'Assigned to', 'Branch', 'Status'], 'No walk-ins recorded yet'),
      ] } },
    { id: 'referrals', label: 'Referrals', spec: {
      sub: 'Students, staff & partners refer new leads — track rewards and link referrer to lead.',
      sprintNote: NOTE_S2,
      blocks: [
        { type: 'kpis', items: [kpi('Referrals (MTD)', '0', 'users'), kpi('Converted', '0', 'check'), kpi('Rewards due', '—', 'rupee')] },
        emptyTable('Referral tracker', ['Referrer', 'Type', 'New lead', 'Status', 'Reward'], 'No referrals recorded yet'),
      ] } },
    { id: 'aiinsights', label: 'AI Insights', spec: {
      sub: 'Lead scoring, churn / at-risk, next-best-action & summaries — running on Gemini.',
      sprintNote: 'AI insights switch on once the Gemini key is configured in Settings (Sprint 3).',
      blocks: [
        emptyList('Active insights', 'No insights yet — AI engine connects in Sprint 3'),
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
    { id: 'import', label: 'Import Leads', spec: { dyn: 'leadImport',
      sub: 'Bulk-import leads from a CSV — map your columns, preview every row, then import. Duplicates and assignment follow the campaign\u2019s own rules.' } },
    { id: 'followups', label: 'Follow-ups', spec: { dyn: 'followups',
      sub: 'All scheduled follow-ups across leads — call, WhatsApp, email, visit. Overdue highlighted.',
      actions: [['plus', 'Add follow-up', 'primary'], ['filter', 'Filters', 'ghost']] } },
    { id: 'pipeline', label: 'Kanban', spec: { dyn: 'kanban',
      sub: 'Drag to move stage (permitted users) · every lead tagged Branch › Vertical › Pipeline › Campaign › Source.',
      actions: [['filter', 'Filters', 'ghost'], ['plus', 'Add lead', 'primary']] } },
    { id: 'scoring', label: 'Lead Scoring', spec: { dyn: 'scoring',
      sub: 'Automatic scoring on source, budget, course, engagement & recency. Bands for Hot / Warm / Cold.' } },
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
    { id: 'closure', label: 'Sale Closure', spec: {
      sub: 'Lead marked Won on enrolment. Optional approval. Captures course, batch, fee, discount & payment.',
      sprintNote: NOTE_S2,
      blocks: [
        { type: 'kpis', items: [kpi('Enrolments (MTD)', '0', 'check'), kpi('Revenue closed', '—', 'rupee'), kpi('Avg discount', '—', 'perf'), kpi('Pending approval', '0', 'clock')] },
        { type: 'form', title: 'Closure capture', fields: [
          { label: 'Course', ph: 'Course master', req: 1 }, { label: 'Batch', ph: 'Batch', req: 1 },
          { label: 'Total fee', ph: '₹', req: 1 }, { label: 'Discount', ph: 'Role-based approval' },
          { label: 'Payment plan', ph: 'Plan master' }, { label: 'First payment', ph: '₹', req: 1 },
          { label: 'Approval', ph: 'Branch Manager', span: 2 }] },
      ] } },
    { id: 'quotes', label: 'Quotations', spec: {
      sub: 'Fee proposals with line items, discounts, validity & approval. PDF + email/WhatsApp. Convert to invoice.',
      actions: [['plus', 'New quotation', 'primary']], sprintNote: NOTE_S2,
      blocks: [
        emptyTable('Quotations', ['Quote #', 'Lead', 'Course', 'Amount', 'Validity', 'Status'], 'No quotations yet'),
        { type: 'caps', title: 'Quotation features', items: [
          cap('Line items & discounts', 'Per-item pricing'), cap('Validity & approval', 'Role-based discount limits'),
          cap('PDF + WhatsApp/email', 'One-click send'), cap('Convert to invoice', 'On acceptance')] },
      ] } },
    { id: 'targets', label: 'Monthly Targets', spec: {
      sub: 'Targets per counsellor / branch / vertical — admissions count & revenue, set monthly.',
      sprintNote: NOTE_S2,
      blocks: [
        { type: 'hbars', title: 'Branch targets', rows: [], empty: 'Branch targets appear once monthly targets are set' },
        emptyTable('Counsellor targets', ['Counsellor', 'Admissions target', 'Achieved', 'Revenue target', 'Achieved', '%'], 'No targets set yet'),
      ] } },
    { id: 'counsellor', label: 'Counsellor Performance', spec: {
      sub: 'Leads handled, calls, conversion %, revenue, TAT, follow-up adherence & enrolments — with leaderboard.',
      sprintNote: NOTE_S2,
      blocks: [
        emptyTable('Leaderboard', ['#', 'Counsellor', 'Leads', 'Calls', 'Conv%', 'Enrol', 'Revenue', 'TAT', 'Adherence'], 'Leaderboard fills as leads & closures accumulate'),
      ] } },
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
    { id: 'sms', label: 'Bulk SMS', spec: {
      sub: 'DLT-approved templates & sender ID, audience filters, scheduling & opt-out handling.',
      actions: [['plus', 'New SMS blast', 'primary']], sprintNote: NOTE_S2,
      blocks: [emptyTable('SMS campaigns', ['Campaign', 'Template (DLT)', 'Audience', 'Scheduled', 'Sent', 'Status'], 'No SMS campaigns yet')] } },
    { id: 'wabulk', label: 'Bulk WhatsApp', spec: {
      sub: 'Approved template messages, media, audience filters, scheduling & delivery/read reports.',
      actions: [['plus', 'New broadcast', 'primary']], sprintNote: NOTE_S2,
      blocks: [emptyTable('WhatsApp broadcasts', ['Broadcast', 'Template', 'Media', 'Audience', 'Delivered', 'Read'], 'No broadcasts yet')] } },
    { id: 'email', label: 'Email Campaigns', spec: {
      sub: 'SMTP / SendGrid, templates, lists & segments, scheduling, open/click tracking, unsubscribe.',
      actions: [['plus', 'New email', 'primary']], sprintNote: NOTE_S2,
      blocks: [
        { type: 'kpis', items: [kpi('Sent (MTD)', '0', 'mail'), kpi('Open rate', '—', 'perf'), kpi('Click rate', '—', 'bolt'), kpi('Unsub', '—', 'refresh')] },
        emptyTable('Campaigns', ['Campaign', 'Segment', 'Sent', 'Open', 'Click', 'Status'], 'No email campaigns yet'),
      ] } },
    { id: 'journeys', label: 'Automation Journeys (Workflow)', spec: {
      sub: 'Triggers (new lead, stage change, no response, fee due, birthday) → actions with conditions & delays.',
      actions: [['plus', 'New journey', 'primary']], sprintNote: NOTE_S2,
      blocks: [
        { type: 'builder', title: 'Journey · "No response 48h re-engage"', steps: [
          { k: 'trig', t: 'Trigger: No response 48h', d: 'Lead in Contacted, no reply' },
          { k: 'wait', t: 'Wait 0m', d: 'Run immediately' },
          { k: 'act', t: 'Send WhatsApp template', d: 'Re-engage message' },
          { k: 'cond', t: 'If replied → stop', d: 'Else continue' },
          { k: 'wait', t: 'Wait 1 day', d: 'Delay' },
          { k: 'act', t: 'Create call task + notify owner', d: 'Assign follow-up' },
          { k: 'end', t: 'If still cold → mark Lost', d: 'Flag for re-open later' }] },
        { type: 'caps', title: 'Journey library', items: [
          cap('Welcome on new lead', 'Greeting + brochure'), cap('Stage change → notify', 'Counsellor + manager'),
          cap('Fee due reminder', '3-day, 1-day, overdue'), cap('Birthday wish', 'Auto on DOB')] },
      ] } },
    { id: 'inbox', label: 'WhatsApp Live Chat', spec: { dyn: 'waChat',
      sub: 'Live WhatsApp inbox — bot auto-replies, lead qualification, quick replies & human hand-over.' } },
    { id: 'templates', label: 'Message Templates', spec: {
      sub: 'Dynamic templates per channel — WhatsApp, SMS, Email — with variables.',
      sprintNote: NOTE_S2,
      blocks: [emptyTable('Templates', ['Name', 'Channel', 'Variables', 'Approval', 'Used'], 'No templates yet')] } },
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
      actions: [['export', 'Tally export', 'ghost'], ['plus', 'New invoice', 'primary']],
      sprintNote: 'Finance lands in Phase 1 as lite fee collection (Sprint 4); full accounts in Phase 3.',
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
    { id: 'collection', label: 'Fee Collection', spec: {
      sub: 'Cash, UPI, Card, Net Banking, Cheque, Razorpay, PhonePe, PayU. Partial payments. Auto receipts.',
      actions: [['plus', 'Record payment', 'primary']], sprintNote: NOTE_S2,
      blocks: [
        { type: 'donut', title: 'Collection by mode', center: '\u2014', slices: [], empty: 'No payments recorded yet' },
        emptyTable('Recent collections', ['Receipt', 'Student', 'Amount', 'Mode', 'Branch', 'Status'], 'No payments recorded yet')] } },
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
      actions: [['export', 'Tally export', 'ghost']],
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
      sprintNote: 'Telephony rides on NeoDove — integration switches on in Sprint 3.',
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
      sprintNote: 'Missed-call auto-leads switch on with the NeoDove integration (Sprint 3).',
      blocks: [emptyTable('Missed-call leads', ['Number', 'Time', 'Auto-lead', 'Campaign', 'Assigned'], 'No missed-call leads yet')] } },
    { id: 'transfer', label: 'Call Transfer', spec: gen('Calls', 'Call Transfer') },
    { id: 'conference', label: 'Conference Calling', spec: gen('Calls', 'Conference Calling') },
    { id: 'routing', label: 'Call Routing', spec: gen('Calls', 'Call Routing') },
    { id: 'logs', label: 'Call Logs', spec: {
      sub: 'Every call auto-logged against the lead with a disposition prompt after each call.',
      sprintNote: 'Call logging rides on the telephony integration (Sprint 3).',
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
    { id: 'standard', label: 'Reports', spec: {
      sub: 'Replaces the Excel reports you maintain today — fixed & ready at launch.',
      blocks: [{ type: 'table', title: 'Report catalog', cols: ['Report', 'Scope', 'Format', 'Schedule'], rows: [
        ['Lead status report', 'By branch/vertical', 'Excel/PDF', 'Daily'],
        ['Conversion report', 'By counsellor', 'Excel', 'Weekly'],
        ['Collection report', 'By mode', 'Excel', 'Daily'],
        ['Attendance report', 'By batch', 'Excel', 'Daily'],
        ['Campaign performance', 'By source', 'Excel/PDF', 'Weekly']] }] } },
    { id: 'builder', label: 'Report Builder', spec: {
      sub: 'Self-service builder — pick fields, filters, save, schedule, export.',
      blocks: [{ type: 'builder', title: 'Build a report', steps: [
        { k: 'trig', t: 'Pick a data source', d: 'Leads / Students / Finance / Calls' },
        { k: 'act', t: 'Choose fields', d: 'Drag columns' },
        { k: 'cond', t: 'Apply filters', d: 'Branch, vertical, date range' },
        { k: 'act', t: 'Save & schedule', d: 'Email delivery' },
        { k: 'end', t: 'Export', d: 'Excel / PDF' }] }] } },
    { id: 'campreports', label: 'Campaign Reports', spec: gen('Analytics & Reports', 'Campaign Reports') },
    { id: 'activity', label: 'Activity Reports', spec: { dyn: 'activityReports',
      sub: 'Track user activity — logins, calls, follow-ups, edits — by user / branch / period.' } },
    { id: 'tat', label: 'TAT Reports', spec: {
      sub: 'First response, time-in-stage & resolution turnaround.',
      sprintNote: 'TAT numbers compute automatically as lead activity accumulates.',
      blocks: [{ type: 'row2', cols: '1fr 1fr 1fr', items: [
        { type: 'bignum', l: 'Avg first response', v: '—', s: 'Target: 5m SLA', tone: 'b-green' },
        { type: 'bignum', l: 'Avg time in stage', v: '—', s: 'Contacted → Qualified', tone: 'b-indigo' },
        { type: 'bignum', l: 'Avg resolution', v: '—', s: 'Lead → enrolment', tone: 'b-cyan' }] }] } },
    { id: 'funnel', label: 'Funnel Analytics', spec: { dyn: 'funnelAnalytics',
      sub: 'Conversion ratios between every stage.' } },
    { id: 'roi', label: 'Campaign ROI', spec: {
      sub: 'Ad spend pulled from source. ROI per campaign / source.',
      sprintNote: 'ROI computes once campaigns carry spend and leads convert.',
      blocks: [emptyTable('Campaign ROI', ['Campaign', 'Source', 'Spend', 'Leads', 'CPL', 'Conv%', 'Revenue'], 'ROI appears when campaigns have spend & leads')] } },
    { id: 'counseloranalytics', label: 'Counselor Analytics', spec: gen('Analytics & Reports', 'Counselor Analytics') },
    { id: 'counselorperf', label: 'Counselor Performance', spec: gen('Analytics & Reports', 'Counselor Performance') },
    { id: 'revanalytics', label: 'Revenue Analytics', spec: gen('Analytics & Reports', 'Revenue Analytics') },
    { id: 'studentanalytics', label: 'Student Analytics', spec: gen('Analytics & Reports', 'Student Analytics') },
    { id: 'forecasting', label: 'Forecasting', spec: gen('Analytics & Reports', 'Forecasting') },
    { id: 'delivery', label: 'Scheduled Delivery', spec: {
      sub: 'Export Excel / PDF, scheduled email delivery & embedded dashboards.',
      sprintNote: NOTE_S2,
      blocks: [emptyTable('Scheduled reports', ['Report', 'Recipients', 'Frequency', 'Format', 'Next run'], 'No scheduled reports yet')] } },
  ] },

  /* ---------------- Workspace & Productivity ---------------- */
  { id: 'work', label: 'Workspace & Productivity', icon: 'work', subs: [
    { id: 'socialinbox', label: 'Social Inbox', spec: gen('Workspace & Productivity', 'Social Inbox') },
    { id: 'socialcomments', label: 'Social Comments', spec: gen('Workspace & Productivity', 'Social Comments') },
    { id: 'socialpublisher', label: 'Social Publisher', spec: gen('Workspace & Productivity', 'Social Publisher') },
    { id: 'chat', label: 'Team Chat', spec: {
      sub: 'Built-in internal messaging — channels, DMs & file sharing. No external Slack/Teams needed.',
      sprintNote: NOTE_S2,
      blocks: [emptyList('Channels', 'Team chat opens in Sprint 3')] } },
    { id: 'tasks', label: 'Tasks', spec: { dyn: 'workTasks',
      sub: 'Shared task management — same fields & statuses as lead follow-ups.' } },
    { id: 'notes', label: 'Notes', spec: {
      sub: 'Notes attached to records, plus shared / team notes.',
      blocks: [{ type: 'caps', title: 'Notes', items: [
        cap('Record notes', 'On lead / student'), cap('Team notes', 'Shared visibility'), cap('Pin & search', 'Quick recall')] }] } },
    { id: 'kb', label: 'Knowledge Base', spec: {
      sub: 'Internal staff KB — categories, search & access control.',
      sprintNote: NOTE_S2,
      blocks: [emptyTable('KB categories', ['Category', 'Articles', 'Access'], 'No KB articles yet')] } },
    { id: 'announce', label: 'Announcements', spec: {
      sub: 'Org / branch announcements with audience targeting & read tracking.',
      sprintNote: NOTE_S2,
      blocks: [emptyTable('Announcements', ['Title', 'Audience', 'Sent', 'Read'], 'No announcements yet')] } },
    { id: 'docs', label: 'Shared Documents', spec: {
      sub: 'Documents shared inside internal team message.',
      sprintNote: NOTE_S2,
      blocks: [emptyList('Recent shared files', 'No shared files yet')] } },
  ] },

  /* ---------------- HR & Workforce ---------------- */
  { id: 'hr', label: 'HR & Workforce', icon: 'hr', subs: [
    { id: 'directory', label: 'Employee Directory', spec: {
      sub: 'Emp ID, designation, department, branch, joining date, reporting manager, status & documents.',
      actions: [['plus', 'Add employee', 'primary']], sprintNote: 'Basic HR lands in Phase 2 (Sprint 5).',
      blocks: [emptyTable('Employees', ['Employee', 'Emp ID', 'Designation', 'Branch', 'Manager', 'Status'], 'Employee records land with the HR module')] } },
    { id: 'attendance', label: 'Attendance', spec: {
      sub: 'Web check-in, biometric or geo-attendance with shifts.',
      sprintNote: 'Basic HR lands in Phase 2 (Sprint 5).',
      blocks: [
        { type: 'kpis', items: [kpi('Present today', '0', 'check'), kpi('On leave', '0', 'cal'), kpi('Late', '0', 'clock'), kpi('Avg in-time', '—', 'clock')] },
        { type: 'caps', title: 'Attendance modes', items: [
          cap('Web check-in', 'Browser'), cap('Biometric', 'Device integration'),
          cap('Geo-attendance', 'Location-stamped'), cap('Shifts', 'Configurable')] },
      ] } },
    { id: 'leaves', label: 'Leaves', spec: {
      sub: 'Leave types, balances, apply-approve workflow & holiday calendar.',
      sprintNote: 'Basic HR lands in Phase 2 (Sprint 5).',
      blocks: [emptyTable('Leave requests', ['Employee', 'Type', 'Days', 'From', 'Approver', 'Status'], 'No leave requests yet')] } },
    { id: 'payroll', label: 'Salary', spec: {
      sub: 'Components, payslips, statutory PF / ESI / TDS.',
      sprintNote: 'Basic HR lands in Phase 2 (Sprint 5).',
      blocks: [
        { type: 'kpis', items: [kpi('Monthly payroll', '—', 'rupee'), kpi('Payslips', '0', 'doc'), kpi('PF/ESI/TDS', '—', 'shield')] },
        { type: 'caps', title: 'Payroll', items: [
          cap('Salary components', 'Earnings + deductions'), cap('Payslips', 'Auto-generated'),
          cap('Statutory', 'PF / ESI / TDS'), cap('Bank details', 'Sensitive · restricted')] },
      ] } },
    { id: 'incentives', label: 'Incentives', spec: {
      sub: 'Incentive rules on admissions / revenue / targets, calculation, approval & payout tracking.',
      sprintNote: 'Basic HR lands in Phase 2 (Sprint 5).',
      blocks: [emptyTable('Incentive payouts', ['Counsellor', 'Basis', 'Achieved', 'Incentive', 'Status'], 'No incentive payouts yet')] } },
    { id: 'bank', label: 'Bank', spec: gen('HR & Workforce', 'Bank') },
    { id: 'performance', label: 'Performance', spec: {
      sub: 'Appraisal cycles, KRAs / goals & ratings.',
      blocks: [{ type: 'caps', title: 'Appraisals', items: [
        cap('Appraisal cycles', 'Quarterly / annual'), cap('KRAs & goals', 'Per role'),
        cap('Ratings', 'Manager + self'), cap('Linked to incentives', 'Score → payout')] }] } },
    { id: 'hiring', label: 'Hiring', spec: {
      sub: 'Job posts, candidate pipeline, interviews & offers.',
      sprintNote: 'Basic HR lands in Phase 2 (Sprint 5).',
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
      sub: 'Telephony, WhatsApp/SMS, email, payment gateway, accounting, website, ad platforms, biometric.',
      blocks: [{ type: 'table', title: 'Integrations', cols: ['System', 'Type', 'Status'], rows: [
        ['Meta WhatsApp Cloud API', 'Messaging', { b: ['Planned · Sprint 3', 'b-amber'] }],
        ['Razorpay', 'Payment', { b: ['Planned · Sprint 4', 'b-amber'] }],
        ['NeoDove', 'Telephony', { b: ['Planned · Sprint 3', 'b-amber'] }],
        ['Meta / Google Lead Ads', 'Ad platform', { b: ['Planned · Sprint 3', 'b-amber'] }],
        ['IndiaMART / JustDial', 'Lead source', { b: ['Planned · Sprint 3', 'b-amber'] }],
        ['SMS (DLT)', 'Messaging', { b: ['Setup', 'b-amber'] }],
        ['Tally / Zoho Books', 'Accounting', { b: ['Setup', 'b-amber'] }],
        ['Biometric device', 'Attendance', { b: ['Setup', 'b-amber'] }],
        ['Gemini / Deepseek', 'AI', { b: ['Planned · Sprint 3', 'b-amber'] }]] }] } },
    { id: 'api', label: 'API Access', spec: {
      sub: 'Open API / webhooks for other internal systems to read or push data.',
      blocks: [{ type: 'cfg', title: 'API access', rows: [
        { ic: 'link', k: 'REST API', s: 'Read & push leads/students/finance', v: 'Enabled', toggle: true },
        { ic: 'bolt', k: 'Webhooks', s: 'Outbound on events', v: 'Sprint 3', toggle: true },
        { ic: 'shield', k: 'API keys', s: 'Per-integration keys', v: '—', toggle: true }] }] } },
    { id: 'compliance', label: 'Compliance', spec: {
      sub: 'DPDP / consent capture, DLT records, audit requirements & data-retention policy.',
      blocks: [{ type: 'cfg', title: 'Compliance', rows: [
        { ic: 'shield', k: 'DPDP consent', s: 'Capture at lead create', v: 'On', toggle: true },
        { ic: 'doc', k: 'DLT records', s: 'SMS template registry', v: 'Linked', toggle: true },
        { ic: 'calls', k: 'Recording consent', s: 'IVR pre-roll', v: 'On', toggle: true },
        { ic: 'clock', k: 'Data retention', s: 'Auto-purge policy', v: 'Configurable', toggle: true }] }] } },
    { id: 'audit', label: 'Audit Logs', spec: { dyn: 'audit',
      sub: 'Every user action across CRM & ERP — work done, edits, updates, messages, emails & calls. Filter by type, user, module & date.',
      actions: [['export', 'Export', 'ghost']] } },
    // Sanctioned addition (client-approved, not in the prototype nav) — see design spec §Sanctioned additions.
    { id: 'errorlogs', label: 'Error Logs', spec: { dyn: 'errorLogs',
      sub: 'Every captured error & issue across API and web — grouped by root cause, bugs highlighted by severity, with stack traces and a resolve workflow.' } },
    // Sanctioned addition (soft-delete client request) — see design spec §Sanctioned additions.
    { id: 'deleted', label: 'Deleted Items', spec: { dyn: 'deletedItems',
      sub: 'Soft-deleted records across every module — deleted rows are hidden from lists, dropdowns & KPIs while their children stay intact. Review impact and restore (Super Admin / Org Admin).' } },
    { id: 'settings', label: 'Settings', spec: {
      sub: 'Org settings, numbering series, templates, business hours, holidays, SMTP & notifications.',
      blocks: [{ type: 'cfg', title: 'Organisation settings', rows: [
        { ic: 'finance', k: 'Currency / Timezone', s: 'INR · Asia/Kolkata', v: 'INR ₹', toggle: true },
        { ic: 'doc', k: 'Numbering series', s: 'Per branch & vertical', v: 'Configured', toggle: true },
        { ic: 'mail', k: 'SMTP per vertical', s: 'One sending domain per vertical', v: 'Per vertical', toggle: true },
        { ic: 'clock', k: 'Business hours', s: 'Mon–Sat 9–7', v: 'Set', toggle: true },
        { ic: 'cal', k: 'Holidays', s: 'Branch calendar', v: 'Set', toggle: true },
        { ic: 'bolt', k: 'Notification channels', s: 'In-app, email, WhatsApp, SMS', v: 'All', toggle: true }] }] } },
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
