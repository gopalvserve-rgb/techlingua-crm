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

const APP_FULL: ModuleItem[] = [

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
    { id: 'aiinsights', label: 'AI Insights', spec: { dyn: 'aiIntelligence',
      sub: 'Summary · sentiment · quality on transcripts & lead notes — DeepSeek / Gemini. Degrades cleanly until a key is set.' } },
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
    { id: 'sources', label: 'Lead Source Master', spec: { dyn: 'sources',
      sub: 'The manageable master list of Lead Sources (per Campaign). Auto-capture via API/webhook; cost per source tracked for ROI. The lead form\u2019s \u201cLead Source\u201d field picks from this master.' } },
    // Client (Aug 2026): the Lead Status master was hard to find under Administration › Masters,
    // so it's surfaced here in the Leads area too. Opens the SAME masters screen on Lead Status.
    { id: 'leadstatus', label: 'Lead Status', spec: { dyn: 'leadStatusMaster',
      sub: 'Add, edit, activate/deactivate the Lead Status values used in the lead form and the Status filter. Same master as Administration › Masters › Lead Status.' } },
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
    { id: 'fields', label: 'Custom Fields', spec: { dyn: 'customFields',
      sub: 'Define extra lead fields (text, number, date, yes/no, dropdown). They render on the Add / Edit Lead form and save into each lead.',
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
    { id: 'targets', label: 'Target & Incentive', spec: { dyn: 'targetIncentive',
      sub: 'Named targets (Individual / Team / Branch / Vertical / Course) across Leads · Walk-ins · Admissions · Revenue · Collection · Meetings, over Monthly / Quarterly / Half-Yearly / Yearly / Custom periods, with an Incentive Plan whose achievement slabs compute the earned incentive.' } },
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
    { id: 'wabulk', label: 'Bulk WhatsApp', spec: { dyn: 'bulkWhatsApp',
      sub: 'Meta Cloud API template messages, audience filters, delivery/read receipts & opt-out (a customer who replies STOP is never messaged again).' } },
    { id: 'journeys', label: 'Automation Journeys (Workflow)', spec: { dyn: 'journeys',
      sub: 'Triggers (new lead, stage change, no response, fee due, birthday) → conditions → actions. Idempotent: a lead never receives the same step twice.' } },
    { id: 'inbox', label: 'WhatsApp Live Chat', spec: { dyn: 'waChat',
      sub: 'Live WhatsApp inbox — bot auto-replies, lead qualification, quick replies & human hand-over.' } },
    { id: 'templates', label: 'Message Templates', spec: { dyn: 'templates',
      sub: 'Dynamic templates per channel — WhatsApp (Meta template name + params), SMS (sender ID + DLT), Email (subject + HTML) — with merge variables and a live preview.' } },
    { id: 'smstpl', label: 'SMS Templates', spec: { dyn: 'smsTemplates',
      sub: 'DLT-compliant SMS templates scoped by Branch + Vertical — Header (DLT sender), body with {#var#} markers, and the DLT Template ID. Sent through the Nimbus gateway; a matching template auto-sends once on every new lead.' } },
    { id: 'notifevents', label: 'Notification Events', spec: { dyn: 'notificationEvents',
      sub: 'A catalog of 37 standard events (Leads, Academics, Fees, Certificates, Calls). For each, enable SMS / Email / WhatsApp and map the template it sends. Fires over the existing channels — opt-out & business hours respected; an unconfigured channel degrades to a logged not-sent attempt.' } },
  ] },

  /* ---------------- Students & Academics ---------------- */
  { id: 'students', label: 'Students & Academics', icon: 'students', subs: [
    { id: 'dashboard', label: 'Student Dashboard', spec: { dyn: 'studentDashboard',
      sub: 'Live student metrics computed from the students, enrolments and fee receipts that exist — total, active, new in the range, by branch / vertical / course, batch allocation and fees collected. Scope- and date-aware; every KPI opens its filtered list.' } },
    { id: 'all', label: 'Student Management', spec: { dyn: 'studentsList',
      sub: 'The student directory. A student is created by converting a won lead (Leads list › ⋮ › Convert to Student, or the lead sheet). Filter by Branch / Vertical / Course / Owner / status; export, refresh, choose columns.' } },
    { id: 'courses', label: 'Courses', spec: { dyn: 'courses',
      sub: 'Course master linked to branches & verticals — code, duration, fee, level, mode, syllabus. Bundles supported.',
      actions: [['plus', 'New course', 'primary']] } },
    { id: 'batches', label: 'Batches', spec: { dyn: 'batchesList',
      sub: 'A batch is bound to Branch → Vertical → Course (strict cascade). Set code, name, trainer, room, schedule, capacity and dates; a student can be assigned to a batch from the student detail.' } },
    { id: 'attendance', label: 'Attendance', spec: { dyn: 'attendanceScreen',
      sub: 'Per-session (batch + date) marking — Present / Absent / Late / Excused, by staff or self (mode flag; a biometric device feed can post to the same endpoint). An Absent mark fires a parent-absence alert via the notifier (degrades cleanly if channels are unconfigured). Present-% summary + records list, scope- and date-aware.' } },
    { id: 'tests', label: 'Tests & Scores', spec: { dyn: 'testsScreen',
      sub: 'A test per batch (quiz / mock / exam / other) with max & pass marks; per-student score entry with a computed percentage and letter grade. Result sheet per test; feeds report cards.' } },
    { id: 'assignments', label: 'Assignments', spec: { dyn: 'assignmentsScreen',
      sub: 'An assignment per batch (title, description, due date, attachment link, max marks) with a per-student submission tracker — assigned → submitted → graded (marks + feedback).' } },
    { id: 'material', label: 'Study Material', spec: { dyn: 'studyMaterial',
      sub: 'A study-material library — video / link / document / note items scoped to a batch, a course or a whole vertical. A published item is visible to the students it targets; an "allow parents" flag surfaces it in the parent report-card view. Filter by branch / vertical / course / type / visibility, export, choose columns, refresh, bulk-delete. RBAC material.*.' } },
    { id: 'coursecontent', label: 'Course Content', spec: { dyn: 'courseContent', tag: 'p2',
      sub: 'Structured course content / lessons under a course (module/unit ordering, rich body, optional file to Cloudflare R2 or an external/YouTube link). GOVERNED by the approval workflow: a Trainer drafts + submits; an Academic Admin approves & publishes (or rejects with remarks / unpublishes). Non-approvers see only PUBLISHED items for their scope. Full list treatment: multi-filter (branch / vertical / course / status), export, column chooser, refresh, bulk-delete. RBAC course_content.*.' } },
    { id: 'syllabus', label: 'Syllabus', spec: { dyn: 'syllabus', tag: 'p2',
      sub: 'A versioned syllabus outline per course (version, structured outline / rich body, optional file to Cloudflare R2 or a link). GOVERNED by the same approval workflow (draft → submit → publish / reject / unpublish); non-approvers see only PUBLISHED items. Full list treatment: multi-filter (branch / vertical / course / status), export, column chooser, refresh, bulk-delete. RBAC syllabus.*.' } },
    { id: 'certs', label: 'Certificates', spec: { dyn: 'certificates',
      sub: 'Completion / participation / merit certificates issued to a student — an auto serial number from the numbering series (CERT-), a branded PDF (the quotation/receipt PDF pipeline), and issue / reissue / revoke. Filter, export, choose columns, refresh, bulk-delete. RBAC certificate.*.' } },
    { id: 'progress', label: 'Academic Progress', spec: { dyn: 'reportCards',
      sub: 'Per-student, per-term report cards computed from attendance %, test scores and assignment grades (Indian grading bands; tests 50% / assignments 30% / attendance 20% over the components present). Report-card PDF; publish for a login-free PARENT VIEW (a shareable link to the card, attendance and parent-visible study material). Filter, export, choose columns, refresh, bulk-delete. RBAC reportcard.*.' } },
    { id: 'placements', label: 'Placement Support', spec: { dyn: 'placements',
      sub: 'Post JOB OPENINGS (title, employer, JD, location, type, openings, salary/stipend, skills) scoped Branch > Vertical, with ELIGIBILITY by course / vertical and an optional minimum enrolment status (e.g. Completed), an application deadline and an optional JD file to Cloudflare R2. Eligible students see the openings they qualify for on their profile\u2019s Placements tab and APPLY; staff track applicants and advance them (applied \u2192 shortlisted \u2192 selected / rejected). Full list treatment: multi-filter (branch / vertical / status / job type), export names-not-ids, column chooser, refresh, bulk-delete. RBAC placement.*.' } },
    { id: 'crosssell', label: 'Cross-Sell', spec: { dyn: 'crossSell',
      sub: 'CRM-level cross-sell on the contacts you have today. Converted contacts (won or enrolled) are paired with a suggested additional course from the Course master — via an admin rule map (current course → suggested course) or, failing a rule, other active courses in their vertical. Act on a suggestion: create a cross-sell follow-up, or create a new lead through the ingestion pipeline (dedup / distribution / audit), or dismiss it. Every act is logged so it is never suggested again. RBAC-scoped. (Deeper student-based cross-sell on academic progress remains Phase 2.)' } },
    { id: 'admissions', label: 'Admissions', spec: { dyn: 'admissionsList',
      sub: 'The online-admission REVIEW QUEUE. A prospective student fills a public, key-authenticated form (generate & share the link via “Form links”); each submit lands here as a PENDING admission. Open a submission, edit it, APPROVE → creates the student, or reject with a reason. Filter by branch / vertical / course / status / date; export, choose columns, refresh, bulk-delete. RBAC admission.*.' } },
    { id: 'questionbank', label: 'Question Bank', spec: { dyn: 'questionBank', tag: 'p2',
      sub: 'The reusable question bank behind the Assessment / Test module (Insta Infotech IT + British College of Language). Every question type — MCQ single/multi, True/False, fill-in, match-the-following, image / audio / YouTube-video MCQ, short/long answer, essay, case study, coding, practical, and language items (reading, listening, speaking, translation, vocabulary, grammar, writing) — with difficulty, marks + negative marks, an options editor for objective types, image/audio upload to Cloudflare R2, a YouTube embed with start/end seconds and a live preview, tags and an explanation. CSV import with a row-by-row error report. Full list treatment: multi-filter (category / type / difficulty / language), export (names not ids), column chooser, refresh, bulk-delete. RBAC question.*.' } },
    { id: 'questioncats', label: 'Question Categories', spec: { dyn: 'questionCategories', tag: 'p2',
      sub: 'The subject / topic taxonomy for the question bank — a subject (e.g. Programming Fundamentals, English Grammar) or a topic nested under a subject, with an optional code, branch/vertical scope and active flag. Full list treatment. RBAC question_category.*.' } },
    { id: 'exams', label: 'Tests / Exams', spec: { dyn: 'tests', tag: 'p2',
      sub: 'Create and manage tests/exams assembled from the Question Bank — hand-picked questions and/or pooled sections (pick N at random from a category). Test types: practice, chapter, weekly, mock, assignment, practical, final exam. Settings: duration, total/passing marks (derived or overridden), negative marking, randomise questions/options, shuffle per attempt, questions-to-show, max attempts, availability window, instructions and how results are shown (instant / manual / after window). Live computed total marks, a builder with a question picker, draft → published → closed with validation, a student-facing PREVIEW that strips answers, create-from-template, and CSV import. Full list treatment: multi-filter (type / status / course / batch / language), export (names not ids), column chooser, refresh, bulk-delete. RBAC assessment.*.' } },
    { id: 'testtemplates', label: 'Test Templates', spec: { dyn: 'testTemplates', tag: 'p2',
      sub: 'Reusable test-settings presets — duration, negative marking, randomisation, attempt limit, passing %, show-result mode and default instructions, per test type. Creating a test from a template copies its settings. Full list treatment. RBAC assessment_template.*.' } },
    { id: 'evaluation', label: 'Evaluation Queue', spec: { dyn: 'assessmentEvaluation', tag: 'p2',
      sub: 'The faculty EVALUATION QUEUE for the Assessment module. Two tabs: student TEST ATTEMPTS (objective portion auto-scored on submit; grade the subjective answers with per-question marks + feedback, a running total, then release) and ASSIGNMENT SUBMISSIONS (open/download the file the student uploaded to Cloudflare R2, award marks + feedback). Launch a test for a student from Tests / Exams — a timed player (live countdown, autosave, auto-submit at 0) for MCQ/subjective tests, or a file upload for assignment/practical tests. Filter by branch / vertical / status; export; refresh; run the overdue-attempt expiry sweep. RBAC assessment_attempt.* / assignment_submission.* / assessment.evaluate.' } },
    { id: 'assessmentresults', label: 'Results & Analytics', spec: { dyn: 'assessmentResults', tag: 'p2',
      sub: 'Per-test RESULTS: a scope-enforced LEADERBOARD (dense rank by score, percentile, grade, pass/fail) with pass-rate and average KPIs, and a drill-in RESULT CARD per student — score breakdown, grade badge, time taken, and analytics by topic/section, difficulty and question type. Export, refresh, column chooser. Results honour the test\'s show-result mode (instant / manual / after window). RBAC assessment.read / assessment_attempt.read.' } },
    { id: 'gradeschemes', label: 'Grade Schemes', spec: { dyn: 'gradeSchemes', tag: 'p2',
      sub: 'Configurable grading bands (India default seeded: A+ 90–100, A 80–89, B+ 70–79, B 60–69, C 50–59, Fail <50). Add/edit a scheme with a band editor validated to be contiguous over 0–100 with at least one pass band; set the default. A test can pin a scheme, else the org default applies. Full list treatment. RBAC grade_scheme.*.' } },
    { id: 'assessmentcerts', label: 'Certificates', spec: { dyn: 'assessmentCertificates', tag: 'p2',
      sub: 'Assessment certificates for a PASSED, evaluated attempt — a per-branch/vertical FY certificate number (ACRT-), grade + percentage, a generated PDF stored in Cloudflare R2, and a PUBLIC verification code (share the /verify link). Issue / revoke / download / delete. Full list treatment. RBAC assessment_certificate.* (issue / revoke). A login-free public page verifies a certificate by its code.' } },
  ] },

  /* ---------------- Finance & Collections ---------------- */
  { id: 'finance', label: 'Finance & Collections', icon: 'finance', subs: [
    { id: 'dashboard', label: 'Finance Dashboard', spec: { dyn: 'financeDashboard',
      sub: 'REAL ₹ KPIs from fees, invoices & enrolments — total invoiced, collected, outstanding dues, GST (CGST/SGST/IGST), collection by branch / vertical / course / mode, recent receipts & top dues. Scope + DateRange honoured. India-formatted (₹).' } },
    { id: 'invoices', label: 'Invoices', spec: { dyn: 'invoicesList',
      sub: 'GST tax invoices raised from an enrolment (or ad-hoc): seller GSTIN + state, buyer GSTIN + place of supply, HSN/SAC, CGST+SGST (intra-state) or IGST (inter-state), round-off, amount in words, branded PDF. Per-branch & per-vertical FY numbering. Issue / cancel. Full list treatment.' } },
    // Sprint 5 — LITE fee collection is live: a receipt + a collection entry, partial
    // payments, receipt PDF. Razorpay capture, GST invoices, dues/ageing and refunds are
    // Phase 3 and the screen says so on its face rather than implying otherwise.
    { id: 'collection', label: 'Fee Collection', spec: { dyn: 'feeCollection',
      sub: 'Cash, UPI, Card, Cheque, Online (recorded by hand). Partial payments. Auto receipts + PDF. Online Razorpay capture is on the Online Payments screen.' } },
    { id: 'onlinepay', label: 'Online Payments', spec: { dyn: 'onlinePayments',
      sub: 'Razorpay online collection PER VERTICAL. Mint a payment link for a fee due / installment (amount in paise, partial allowed) using that enrolment\'s vertical\'s Razorpay key. On payment the webhook (HMAC-verified, idempotent) captures it, records the fee collection (oldest-due first) and auto-generates the receipt + PDF. A vertical with no key degrades to a clean message until the client enters it in Settings. Full list treatment; RBAC payment.*.' } },
    { id: 'plans', label: 'Payment Plans', spec: { dyn: 'paymentPlans',
      sub: 'Installment plans on an enrolment — Full / Installment / EMI / Custom. Generates a due-dated schedule that sums EXACTLY to the net fee (₹ paise). Collections apply oldest-due first, updating each installment\'s paid / outstanding / status. Full list treatment.' } },
    { id: 'dues', label: 'Fee Management', spec: { dyn: 'feeDues',
      sub: 'Outstanding per student / enrolment / installment with ageing buckets (Not due / 0–30 / 31–60 / 61–90 / 90+ days) computed in IST. Filter by ageing / branch / vertical / course / owner, export, refresh. Automatic due reminders (WhatsApp / SMS / Email) with configurable offsets — idempotent, degrade cleanly.' } },
    { id: 'scholar', label: 'Scholarships', spec: {
      sub: 'Percentage or fixed. Approval workflow at manager level. Scholarship reason mandatory.',
      sprintNote: NOTE_S2,
      blocks: [emptyTable('Scholarship requests', ['Student', 'Type', 'Value', 'Reason', 'Approver', 'Status'], 'No scholarship requests yet')] } },
    // dev/103 — the manageable Discount Master: cap a discount by % AND ₹, optionally scoped by
    // branch/vertical/course (most-specific-wins). An over-cap discount is held for approval by an
    // authorized user (discount.approve = Academic Admin / Org / Super Admin) on the same screen.
    { id: 'discounts', label: 'Discount Master', spec: { dyn: 'discountMaster',
      sub: 'Cap discounts by percentage AND by amount (₹), optionally scoped by branch / vertical / course (most-specific-wins). When a counsellor enters a discount above the cap, only the cap is applied and the excess is held for approval — an authorized user (Academic Admin / Org / Super Admin) approves (the full discount applies, Net/Due recompute) or rejects (the discount stays at the cap). Full list treatment.' } },
    { id: 'revenue', label: 'Revenue', spec: { dyn: 'revenueView',
      sub: 'The two views of revenue: COLLECTION (money received, net of approved refunds) and ACCRUAL (fee billed / earned = enrolment net fee recognised). Group by branch / vertical / course / counsellor / payment mode / day / month, with DateRange + scope. India ₹.' } },
    { id: 'refunds', label: 'Refunds', spec: { dyn: 'refundsList',
      sub: 'Full or PARTIAL refund of a student\'s collected fee, behind an approval hierarchy: a refund is REQUESTED, then APPROVED / REJECTED by a permitted role (a high-value refund needs a senior approver; nobody approves their own). On approval a REF- voucher (PDF) is minted and net collected reduces. Refund mode + reason. Full list treatment; RBAC refund.*.' } },
    { id: 'reports', label: 'Collection Reports', spec: { dyn: 'collectionReports',
      sub: 'Collections in a period grouped by daily / monthly / branch / vertical / course / counsellor / payment mode, with totals (net of refunds). Filter + DateRange + full treatment, exportable to Excel / CSV / PDF (values, not ids). TALLY EXPORT: the period\'s collections (Receipt vouchers) and refunds (Payment vouchers) as a Tally-importable XML file.' } },
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
    { id: 'aiintel', label: 'AI Insights', spec: { dyn: 'aiIntelligence',
      sub: 'Credential-gated AI over the text that exists — paste/upload a transcript or pick a lead, then run summary · sentiment · quality. Saved + listed with the full treatment.' } },
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
    { id: 'directory', label: 'Employee Directory', spec: { dyn: 'hrDirectory', tag: 'p2',
      sub: 'The staff register — employee code (auto EMP-), name, optional login account, designation, department, branch/vertical, date of joining, employment type, contact (Indian mobile/E.164), personal, status and reporting manager. Full list treatment: filters (branch/vertical/department/designation/status), export, column chooser, refresh, bulk-delete.' } },
    { id: 'attendance', label: 'Attendance', spec: { dyn: 'hrAttendance', tag: 'p2',
      sub: 'Daily STAFF attendance (present / absent / half-day / leave / holiday) marked by HR/manager or self check-in, a monthly attendance sheet per branch and a per-employee summary (present days, absent, leaves). Date range via the picker. Full list treatment on the records.' } },
    { id: 'leaves', label: 'Leaves', spec: { dyn: 'hrLeaves', tag: 'p2',
      sub: 'Configurable leave types (Casual / Sick / Earned / Unpaid), a leave balance per employee/type/year, and the apply → approve/reject workflow: on approval the balance is deducted and the days are marked as Leave in attendance; the manager is notified on apply and the employee on the decision. Nobody can approve their own leave. Full list treatment.' } },
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
  /* ---------------- Operations (ERP Batch 5 — now live) ---------------- */
  { id: 'ops', label: 'Operations', icon: 'ops', phase: 'P2', subs: [
    { id: 'catalog', label: 'Catalog', spec: { dyn: 'catalogList', tag: 'p2',
      sub: 'The org-wide master of items / products / services the institute deals in — books, kits, merchandise, service items. Item code (auto ITM-), category, unit, price (₹), GST % and HSN/SAC (India), active. Used by inventory and procurement. Full list treatment: multi-filter, export, columns, refresh, bulk-delete.' } },
    { id: 'inventory', label: 'Inventory', spec: { dyn: 'inventoryList', tag: 'p2',
      sub: 'Per-branch/location stock of catalog items — quantity on hand, a receipt / issue / adjustment "Stock movement" that writes a movement log, and a low-stock threshold + flag. Receiving a purchase order increments stock automatically. Branch-scoped; full list treatment + a movement log.' } },
    { id: 'assets', label: 'Assets', spec: { dyn: 'assetsList', tag: 'p2',
      sub: 'The equipment / furniture / IT register — asset code (auto AST-), category, branch/location, purchase date + cost (₹), status (in-use / in-repair / retired), assigned-to (user), vendor, warranty + AMC dates. Lifecycle. Full list treatment.' } },
    { id: 'vendors', label: 'Vendor Management', spec: { dyn: 'vendorsList', tag: 'p2',
      sub: 'The vendor master — name, GSTIN (India), category, contact, address, optional bank details, active. Used by procurement and assets. Full list treatment: multi-filter, export, columns, refresh, bulk-delete.' } },
    { id: 'procure', label: 'Procurement', spec: { dyn: 'procurementList', tag: 'p2',
      sub: 'Purchase orders to a vendor for catalog items — line items (qty × ₹ price, per-line discount + GST), PO number (auto PO-), draft → sent → received → closed. Receiving a PO increments inventory. Branded PO PDF (the quotation/receipt PDF pipeline). India GST throughout. Full list treatment.' } },
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
      sub: 'Every dropdown master in one place — add, edit, view and activate/deactivate values (states, cities, sources, courses, Lead Status, tags & more).' } },
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
        ['SMS (DLT)', 'Messaging', { b: ['Built · needs gateway credentials', 'b-amber'] }],
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
    // Client request — Finance Settings: discount / scholarship / capping limit, BOTH by
    // percentage and by amount, org-wide or per vertical. Enforced everywhere a discount
    // is applied (quotation line, enrolment). Only a permitted user changes the caps.
    { id: 'finance', label: 'Finance Settings', spec: { dyn: 'financeSettings',
      sub: 'Discount, scholarship and the hard capping limit — each configurable by percentage AND by amount (₹). Set organisation-wide or per vertical. A discount must be within both the percent cap and the amount cap; the cap is enforced on quotation lines and enrolment. Only a permitted user (finance.manage) can change these; a user with finance.override may exceed them at closure.' } },
  ] },

  /* ---------------- Help & Support ---------------- */
  { id: 'help', label: 'Help & Support', icon: 'help', subs: [
    { id: 'features', label: "What's New / Features", spec: { dyn: 'featuresPanel',
      sub: 'Recent updates and the full list of feature modules in the CRM. Click a module to open it. This is the destination of the top-bar Features shortcut.' } },
    { id: 'tickets', label: 'Support Tickets', spec: { dyn: 'supportTickets',
      sub: 'Internal staff tickets — full lifecycle. Category (admin-managed master), priority, SLA target with overdue flagging, assignment (active users only), and the Open → In Progress → Resolved → Closed status flow with a reopen path. Comment thread per ticket. RBAC-scoped: you see your own / assigned / branch tickets per your access.' } },
    { id: 'helpcenter', label: 'Help Center', spec: {
      sub: 'In-app help articles maintained by Admin. Available at launch.',
      sprintNote: 'Help articles are being authored — they publish before go-live.',
      blocks: [emptyTable('Help articles', ['Article', 'Category', 'Views'], 'Help articles publish before go-live')] } },
    { id: 'guides', label: 'Product Guides', spec: {
      sub: 'Step-by-step guides for using the system. Available at launch.',
      sprintNote: 'Guides publish before go-live.',
      blocks: [emptyList('Guides', 'Product guides publish before go-live')] } },
    { id: 'training', label: 'Training Videos', spec: { dyn: 'trainingVideos',
      sub: 'A library of training / how-to videos for staff — title, description, category, video URL (YouTube / Vimeo / MP4 / embed), thumbnail, tags, order and active flag. Staff browse and play in-app; admins manage the library. Filter by category / status / search / date, export, choose columns, refresh, bulk-delete. RBAC training.* (view vs manage).' } },
    { id: 'releases', label: 'Release Notes', spec: { dyn: 'releaseNotes',
      sub: 'An in-app changelog — version, release date, title, what-changed notes and category (feature / fix / improvement). Admins publish entries; every user reads them on the What\'s New panel. Filter by category / status / search / date, export, choose columns, refresh, bulk-delete. RBAC release_note.* (view vs manage).' } },
  ] },

  /* ---------------- Franchise & Royalty (Phase 4 Batch 1) ---------------- */
  { id: 'fran', label: 'Franchise', icon: 'fran', subs: [
    { id: 'portal', label: 'Partner Portal', spec: { dyn: 'franchisePartnerPortal',
      sub: 'The franchise-owner self-service view, FIXED to the logged-in owner\'s franchise (no selector). Their dashboard (branches, students / enrolments, revenue collected, net, outstanding dues, royalty payable), their royalty invoices, compliance status and target achievement — all scoped to their own franchise. Head office keeps the full Franchise module across all franchises.' } },
    { id: 'franchises', label: 'Franchises', spec: { dyn: 'franchises',
      sub: 'Franchise records — name, code, owner (name/contact/email/phone), address/city, GST no, status (Prospect / Onboarding / Active / Suspended / Terminated), agreement dates, and the BRANCHES the franchise operates. A franchise\'s data = everything under its mapped branches. Add / Edit / View + branch mapping.' } },
    { id: 'dashboard', label: 'Franchise Dashboard', spec: { dyn: 'franchiseDashboard',
      sub: 'Per-franchise KPI rollup computed LIVE from the franchise\'s branches — active branches, students / enrolments, revenue collected, net revenue, outstanding dues and royalty payable. Franchise selector + DateRange. Reuses the same finance sources as the Finance Dashboard, so figures reconcile.' } },
    { id: 'royaltyPlans', label: 'Royalty Plans', spec: { dyn: 'royaltyPlans',
      sub: 'Royalty / revenue-share configuration per franchise (or a reusable template): % of collected revenue, % of net revenue, a fixed monthly fee, or a TIERED plan whose royalty % varies by revenue band. Optional monthly minimum guarantee + an effective date range. Live compute preview.' } },
    { id: 'royaltyStatement', label: 'Royalty Statement', spec: { dyn: 'royaltyStatement',
      sub: 'The royalty payable for a franchise + period: gross collected, refunds, net collected, the royalty rate applied, royalty amount, adjustments and the final payable — pulled from the franchise\'s branches\' collections so it reconciles with Finance.' } },
    { id: 'agreements', label: 'Agreements & Renewals', spec: { dyn: 'franchiseAgreements',
      sub: 'Franchise agreement records — agreement no, sign / start / end / renewal dates, status (Active / Expiring / Expired / Renewed) and the signed document (stored in R2). Add / Edit + document upload, plus a renewal reminder listing agreements expiring within 60 days.' } },
    { id: 'territory', label: 'Territory', spec: { dyn: 'franchiseTerritory',
      sub: 'The allowed operating area(s) per franchise — city / region / pincode / area — so two franchises do not overlap. Simple list + add / remove on the franchise; a value shared with another franchise is surfaced as an overlap warning.' } },
    { id: 'onboarding', label: 'Onboarding', spec: { dyn: 'franchiseOnboarding',
      sub: 'A per-franchise onboarding checklist materialised from a default template (application -> agreement -> fee -> branches -> royalty plan -> KYC -> territory -> training -> go-live). Each step done / pending with completed-by/at and a live progress %. Add / remove custom steps.' } },
    { id: 'royaltyInv', label: 'Royalty Invoices', spec: { dyn: 'royaltyInvoices',
      sub: 'Generate a royalty invoice for a franchise + period from its royalty statement (ROY-<FY>/#### series, separate from student invoices). Draft / Issued / Paid / Cancelled, preview + print, record payments against it. List + generate-from-statement + view.' } },
    { id: 'outstanding', label: 'Outstanding Royalties', spec: { dyn: 'outstandingRoyalties',
      sub: 'An ageing view of unpaid / partly-paid royalty invoices per franchise — current / 31-60 / 61-90 / 90+ buckets computed in IST — with a record-payment action that updates the invoice status and outstanding.' } },
    { id: 'perf', label: 'Targets & Performance', spec: { dyn: 'franchiseTargets',
      sub: 'Per-franchise target setting (admissions, enrolments, revenue, collection) for a period, with a live target-vs-actual view (progress bars, per-metric achievement %) computed from the franchise\'s branches, plus a head-office leaderboard ranking franchises by achievement across their active targets.' } },
    { id: 'compliance', label: 'Compliance & Audits', spec: { dyn: 'franchiseCompliance',
      sub: 'A per-franchise compliance checklist materialised from a default template (agreement valid, KYC, GST filed, statutory docs, royalty up to date, brand & fee standards, …). Each item carries a status, due date and evidence document (R2), with a live compliance % and overdue count, plus an audit trail of franchise-critical changes.' } },
    { id: 'franReports', label: 'Franchise Reports', spec: { dyn: 'franchiseReports',
      sub: 'A per-franchise rollup — branches, students / enrolments, revenue collected, net revenue, outstanding dues, and royalty billed vs paid vs outstanding — as an on-screen table + CSV export, with a DateRange. Reuses the Batch-1 dashboard rollup + the new royalty numbers.' } },
  ] },

  /* ---------------- Site Map ---------------- */
  { id: 'map', label: 'All Features · Site Map', icon: 'grid', subs: [
    { id: 'all', label: 'Site Map', spec: { dyn: 'sitemap' } },
  ] },
];

/* ============================ NAV VISIBILITY ============================
 * dev/111 (client, 2026-08-21) — REVERSIBLE nav hide. The modules / sub-items
 * listed below are removed from the navigation (sidebar tree AND the site map).
 * Nothing is deleted: every screen spec, dyn component and backend endpoint is
 * left intact above, so re-enabling an item is just deleting its id from the
 * sets below. This is purely a front-end nav filter.
 *
 *   • Operations — the whole module (Catalog, Inventory, Assets, Vendors, Procurement)
 *   • HR & Workforce — Hiring, Bank, Performance, Incentives
 *   • Workspace & Productivity — Social Publisher, Social Comments, Social Inbox
 *   • Analytics & Reports — Scheduled Delivery, Counselor Analytics
 *   • Communication Intelligence — Intent Detection, Conversation Analytics,
 *       Sentiment Analysis, Objection Detection, Follow-up Suggestions
 *   • Calls (Telephony) — Telephony Settings, Call Routing, Conference Calling, Call Transfer
 */
const HIDDEN_MODULES = new Set<string>([
  'ops', // Operations — entire module hidden
]);
const HIDDEN_SUBS: Record<string, Set<string>> = {
  hr:        new Set(['hiring', 'bank', 'performance', 'incentives']),
  work:      new Set(['socialpublisher', 'socialcomments', 'socialinbox']),
  analytics: new Set(['delivery', 'counseloranalytics']),
  intel:     new Set(['intent', 'convanalytics', 'sentiment', 'objection', 'followsug']),
  calls:     new Set(['telSettings', 'routing', 'conference', 'transfer']),
};

/** The nav tree the app actually renders — {@link APP_FULL} minus the hidden entries above. */
export const APP: ModuleItem[] = APP_FULL
  .filter((m) => !HIDDEN_MODULES.has(m.id))
  .map((m) => {
    const hide = HIDDEN_SUBS[m.id];
    return hide ? { ...m, subs: m.subs.filter((s) => !hide.has(s.id)) } : m;
  });

export const findScreen = (m: string, s: string): { mod: ModuleItem; sub: SubItem } | null => {
  const mod = APP.find((x) => x.id === m);
  const sub = mod?.subs.find((x) => x.id === s);
  return mod && sub ? { mod, sub } : null;
};

/* ==================== Mobile-app scope (dev/121) ====================
 * The Android app (Capacitor WebView over the live origin) must render ONLY the
 * OPERATIONAL Leads CRM — operate leads and convert them into students — and hide
 * ALL configuration/admin: Settings, Administration, Masters, Integrations, API
 * management and every non-lead module (Students & Academics, Finance, HR,
 * Assessment, Reports config, Workspace, Communication Intelligence, Calls, …),
 * PLUS the config-only lead screens (Lead Scoring rules, Lead Capture / Integrations
 * setup, Duplicate Rules, SLA & TAT, Custom Fields, Lead Source / Status masters,
 * Branch / Vertical / Pipeline masters).
 *
 * Detection: the Capacitor build loads `…/?app=mobile`; on boot we read the flag
 * from the URL query and persist it to sessionStorage so it survives client-side
 * navigation. `window.Capacitor.isNativePlatform()` is a secondary signal, so the
 * scope also applies inside the native wrapper even without the query string.
 * On desktop/web (no flag) NOTHING changes — the full nav renders as before.
 */
export const MOBILE_ALLOW: Record<string, Set<string>> = {
  // Lead-focused dashboard + operational lead touchpoints.
  dash: new Set(['overview', 'quickcontact', 'mytasks', 'todayfollowups', 'quickstats', 'calendar', 'walkins', 'referrals']),
  // Operate leads: list/add/edit/view/actions (+ Convert → Student from the sheet),
  // Start Calling, Campaigns (operate/view), Follow-ups, Kanban, Import.
  // Masters + config-only lead screens are deliberately excluded.
  leads: new Set(['all', 'calling', 'campaigns', 'followups', 'pipeline', 'import']),
};

/** True when running inside the Android/Capacitor mobile wrapper (or `?app=mobile`). */
export function isMobileApp(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get('app') === 'mobile') sessionStorage.setItem('tl_mobile_app', '1');
    if (sessionStorage.getItem('tl_mobile_app') === '1') return true;
  } catch { /* sessionStorage unavailable — fall through to the Capacitor check */ }
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

/** The nav tree the app actually renders: desktop/web = full {@link APP}; mobile =
 *  APP restricted to the operational Leads CRM allowlist ({@link MOBILE_ALLOW}). */
export function scopedApp(): ModuleItem[] {
  if (!isMobileApp()) return APP;
  return APP
    .filter((m) => MOBILE_ALLOW[m.id])
    .map((m) => ({ ...m, subs: m.subs.filter((s) => MOBILE_ALLOW[m.id].has(s.id)) }))
    .filter((m) => m.subs.length > 0);
}

/** Route guard — is (mod,sub) reachable in the current mode? On web everything is
 *  allowed; in the mobile app only the {@link MOBILE_ALLOW} allowlist is. */
export function isRouteAllowed(m: string, s: string): boolean {
  if (!isMobileApp()) return true;
  const allow = MOBILE_ALLOW[m];
  return !!allow && allow.has(s);
}
