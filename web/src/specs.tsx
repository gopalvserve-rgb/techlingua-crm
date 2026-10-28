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
      sub: 'Follow-ups, demos and meetings on one calendar. Optional two-way sync with Google / Outlook.' } },
    { id: 'walkins', label: 'Walk-ins', spec: { dyn: 'walkIns',
      sub: 'Capture branch visitors and convert directly into assigned leads — the counsellor owns the lead on add.',
      actions: [['plus', 'Add walk-in', 'primary']] } },
    { id: 'referrals', label: 'Referrals', spec: { dyn: 'referrals',
      sub: 'Students, staff & partners refer new leads — track rewards and link referrer to lead.',
      actions: [['plus', 'Add referral', 'primary']] } },
    { id: 'aiinsights', label: 'AI Insights', spec: { dyn: 'aiIntelligence',
      sub: 'AI summary, sentiment and quality scores for call transcripts and lead notes.' } },
  ] },

  /* ---------------- Marketing & Lead Management ---------------- */
  { id: 'leads', label: 'Marketing & Lead Management', icon: 'leads', subs: [
    { id: 'branch', label: 'Branch', spec: { dyn: 'branches',
      sub: 'Your branches and the verticals under each one.' } },
    { id: 'vertical', label: 'Vertical', spec: { dyn: 'verticals',
      sub: 'Business lines (brands) under each Branch — different per Branch. SMTP configured per vertical.' } },
    { id: 'pipelinemaster', label: 'Pipeline', spec: { dyn: 'pipelines',
      sub: 'Sales pipelines and their stages — a vertical can have several pipelines.' } },
    { id: 'campaigns', label: 'Campaign', spec: { dyn: 'campaigns',
      sub: 'Campaigns sit under each Pipeline and pull leads from sources. UTM & ROI tracked per campaign.',
      actions: [['plus', 'New campaign', 'primary']] } },
    { id: 'all', label: 'Leads', spec: { dyn: 'leadsAll',
      sub: 'Full lead table — every lead tagged Branch › Vertical › Pipeline › Campaign › Source.',
      actions: [['filter', 'Filters', 'ghost'], ['plus', 'Add lead', 'primary']] } },
    { id: 'calling', label: 'Start Calling', spec: { dyn: 'startCalling',
      sub: 'On Demand campaigns park their leads in a pool. Click Start Calling and the next 10 (the campaign’s hand-out size) are assigned to you — then work them one at a time: disposition, next follow-up, next lead. No dialler: you call from your own phone.' } },
    { id: 'import', label: 'Import Leads', spec: { dyn: 'leadImport',
      sub: 'Bulk-import leads from a CSV — map your columns, preview every row, then import. Duplicates and assignment follow the campaign’s own rules.' } },
    { id: 'capture', label: 'Integrations', spec: { dyn: 'captureChannels',
      sub: 'Connect lead sources — Facebook / Instagram lead ads, Google forms & sheets, IndiaMART, JustDial, website forms and more. Every lead lands in the right campaign with the same duplicate and assignment rules.' } },
    { id: 'followups', label: 'Follow-ups', spec: { dyn: 'followups',
      sub: 'All scheduled follow-ups across leads — call, WhatsApp, email, visit. Overdue highlighted.',
      actions: [['plus', 'Add follow-up', 'primary'], ['filter', 'Filters', 'ghost']] } },
    { id: 'pipeline', label: 'Kanban', spec: { dyn: 'kanban',
      sub: 'Drag to move stage (permitted users) · every lead tagged Branch › Vertical › Pipeline › Campaign › Source.',
      actions: [['filter', 'Filters', 'ghost'], ['plus', 'Add lead', 'primary']] } },
    { id: 'scoring', label: 'Lead Scoring', spec: { dyn: 'scoring',
      sub: 'Rule-based scoring you configure yourself — source, budget, course, engagement, recency. Bands for Hot / Warm / Cold.' } },
    { id: 'sources', label: 'Lead Source Master', spec: { dyn: 'sources',
      sub: 'The one list of Lead Sources — each source is available under every campaign. Every Lead Source dropdown in the CRM (leads, walk-ins, campaigns, imports, integrations) picks from this master.' } },
    // Client (Aug 2026): the Lead Status master was hard to find under Administration › Masters,
    // so it's surfaced here in the Leads area too. Opens the SAME masters screen on Lead Status.
    { id: 'leadstatus', label: 'Lead Status', spec: { dyn: 'leadStatusMaster',
      sub: 'Add, edit, activate/deactivate the Lead Status values used in the lead form and the Status filter. Same master as Administration › Masters › Lead Status.' } },
    { id: 'dup', label: 'Duplicate Rules', spec: { dyn: 'duplicateRules',
      sub: 'The organisation-wide duplicate rule every new lead is checked against (a campaign can still override it): match by phone and/or email, the scope of the check (whole organisation / branch / vertical / campaign) and what happens to a repeat enquiry.' } },
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
      sub: 'Fee proposals with line items, discounts, validity & revisions. PDF + email/WhatsApp. Convert to enrolment, then raise the GST invoice from Finance › Fee Invoices.' } },
    { id: 'targets', label: 'Target & Incentive', spec: { dyn: 'targetIncentive',
      sub: 'Named targets (Individual / Team / Branch / Vertical / Course) across Leads · Walk-ins · Admissions · Revenue · Collection · Meetings, over Monthly / Quarterly / Half-Yearly / Yearly / Custom periods, with an Incentive Plan whose achievement slabs compute the earned incentive.' } },
    { id: 'counsellor', label: 'Counsellor Performance', spec: { dyn: 'counsellorPerformance',
      sub: 'Leads handled, activity, conversion %, revenue, TAT, follow-up adherence & enrolments — with a leaderboard.' } },
  ] },

  /* ---------------- Engagement & Workflow ---------------- */
  { id: 'engage', label: 'Engagement & Workflow', icon: 'engage', subs: [
    { id: 'wabot', label: 'WhatsBot', spec: { dyn: 'whatsBot',
      sub: 'Automatic WhatsApp replies — a welcome message, keyword answers (e.g. "fee", "course") and an out-of-hours reply. A counsellor can take over any chat from Live Chat.' } },
    { id: 'aibot', label: 'AI Bot', spec: { dyn: 'aiBot',
      sub: 'AI answers on WhatsApp from your knowledge (courses, fees, FAQs you write here), with human hand-over on chosen words (price, complaint, call me). Uses the Gemini / DeepSeek key from Settings; replies only when no WhatsBot keyword rule matched.' } },
    { id: 'wabulk', label: 'Bulk WhatsApp', spec: { dyn: 'bulkWhatsApp',
      sub: 'Send an approved WhatsApp template to a filtered list of leads, with delivery and read status. Anyone who replies STOP is never messaged again.' } },
    { id: 'journeys', label: 'Automation Journeys (Workflow)', spec: { dyn: 'journeys',
      sub: 'Automatic follow-up journeys — on a new lead, stage change, no response, fee due or birthday — that send the right message at the right time.' } },
    { id: 'inbox', label: 'WhatsApp Live Chat', spec: { dyn: 'waChat',
      sub: 'Live WhatsApp inbox — bot auto-replies, lead qualification, quick replies & human hand-over.' } },
    { id: 'waaccount', label: 'WhatsApp Account', spec: { dyn: 'waAccount',
      sub: 'Connected numbers (labels, default sender), Verify / Register phone / Disconnect, webhook health and the webhook setup checklist.' } },
    { id: 'templates', label: 'Message Templates', spec: { dyn: 'templates',
      sub: 'WhatsApp, SMS and email templates with merge fields (name, course, branch…) and a live preview.' } },
    { id: 'smstpl', label: 'SMS Templates', spec: { dyn: 'smsTemplates',
      sub: 'DLT-registered SMS templates for each branch and vertical. A matching template is sent automatically to every new lead.' } },
    { id: 'notifevents', label: 'Notification Events', spec: { dyn: 'notificationEvents',
      sub: 'Choose which events send an SMS, email or WhatsApp message, and which template each one uses. Opt-outs and business hours are always respected.' } },
  ] },

  /* ---------------- Student & Academic Administration ---------------- */
  { id: 'students', label: 'Student & Academic Administration', icon: 'students', subs: [
    { id: 'dashboard', label: 'Student Dashboard', spec: { dyn: 'studentDashboard',
      sub: 'Students at a glance — total, active and new, by branch, vertical and course, with batch allocation and fees collected. Click any card to open the list.' } },
    { id: 'all', label: 'Student Management', spec: { dyn: 'studentsList',
      sub: 'All students. A student is created when a won lead is converted (Leads › Convert to Student).' } },
    { id: 'admissions', label: 'Admissions & Enrolment', spec: { dyn: 'admissionsList',
      sub: 'Online admission applications. Share an application link; each submission arrives here to review, edit, approve (creates the student) or reject.' } },
    { id: 'courses', label: 'Courses', spec: { dyn: 'courses',
      sub: 'Course master linked to branches & verticals — code, duration, fee, level, mode, syllabus. Bundles supported.',
      actions: [['plus', 'New course', 'primary']] } },
    { id: 'batches', label: 'Batches', spec: { dyn: 'batchesList',
      sub: 'Batches for each course — trainer, schedule, capacity and dates. Assign students from their profile.' } },
    { id: 'attendance', label: 'Attendance', spec: { dyn: 'attendanceScreen',
      sub: 'Mark student attendance by batch and date — Present, Absent, Late or Excused. Parents are alerted automatically when a student is absent.' } },
    { id: 'certs', label: 'Certificates', spec: { dyn: 'certificates',
      sub: 'Issue completion, participation and merit certificates with an automatic serial number and a branded PDF. Reissue or revoke any time.' } },
    { id: 'placements', label: 'Placement Support', spec: { dyn: 'placements',
      sub: 'Post job openings for students — employer, role, location, salary and who is eligible — and track applicants from applied to selected.' } },
    { id: 'crosssell', label: 'Cross-Sell', spec: { dyn: 'crossSell',
      sub: 'Suggests a next course for students and won leads. Create a follow-up or a new lead from a suggestion, or dismiss it.' } },
  ] },

  /* ---------------- Learning & Assessment ---------------- */
  { id: 'learning', label: 'Learning & Assessment', icon: 'book', subs: [
    { id: 'syllabus', label: 'Syllabus', spec: { dyn: 'syllabus',
      sub: 'A versioned syllabus outline per course (version, structured outline / rich body, optional file to Cloudflare R2 or a link). GOVERNED by the same approval workflow (draft → submit → publish / reject / unpublish); non-approvers see only PUBLISHED items. Full list treatment: multi-filter (branch / vertical / course / status), export, column chooser, refresh, bulk-delete. RBAC syllabus.*.' } },
    { id: 'coursecontent', label: 'Course Content', spec: { dyn: 'courseContent',
      sub: 'Structured course content / lessons under a course (module/unit ordering, rich body, optional file to Cloudflare R2 or an external/YouTube link). GOVERNED by the approval workflow: a Trainer drafts + submits; an Academic Admin approves & publishes (or rejects with remarks / unpublishes). Non-approvers see only PUBLISHED items for their scope. Full list treatment: multi-filter (branch / vertical / course / status), export, column chooser, refresh, bulk-delete. RBAC course_content.*.' } },
    { id: 'material', label: 'Study Material', spec: { dyn: 'studyMaterial',
      sub: 'A study-material library — video / link / document / note items scoped to a batch, a course or a whole vertical. A published item is visible to the students it targets; an "allow parents" flag surfaces it in the parent report-card view. Filter by branch / vertical / course / type / visibility, export, choose columns, refresh, bulk-delete. RBAC material.*.' } },
    { id: 'assignments', label: 'Assignments', spec: { dyn: 'assignmentsScreen',
      sub: 'An assignment per batch (title, description, due date, attachment link, max marks) with a per-student submission tracker — assigned → submitted → graded (marks + feedback).' } },
    { id: 'tests', label: 'Tests & Scores', spec: { dyn: 'testsScreen',
      sub: 'A test per batch (quiz / mock / exam / other) with max & pass marks; per-student score entry with a computed percentage and letter grade. Result sheet per test; feeds report cards.' } },
    { id: 'questionbank', label: 'Question Bank', spec: { dyn: 'questionBank',
      sub: 'The reusable question bank behind the Assessment / Test module (Insta Infotech IT + British College of Language). Every question type — MCQ single/multi, True/False, fill-in, match-the-following, image / audio / YouTube-video MCQ, short/long answer, essay, case study, coding, practical, and language items (reading, listening, speaking, translation, vocabulary, grammar, writing) — with difficulty, marks + negative marks, an options editor for objective types, image/audio upload to Cloudflare R2, a YouTube embed with start/end seconds and a live preview, tags and an explanation. CSV import with a row-by-row error report. Full list treatment: multi-filter (category / type / difficulty / language), export (names not ids), column chooser, refresh, bulk-delete. RBAC question.*.' } },
    { id: 'questioncats', label: 'Question Categories', spec: { dyn: 'questionCategories',
      sub: 'The subject / topic taxonomy for the question bank — a subject (e.g. Programming Fundamentals, English Grammar) or a topic nested under a subject, with an optional code, branch/vertical scope and active flag. Full list treatment. RBAC question_category.*.' } },
    { id: 'testtemplates', label: 'Test Templates', spec: { dyn: 'testTemplates',
      sub: 'Reusable test-settings presets — duration, negative marking, randomisation, attempt limit, passing %, show-result mode and default instructions, per test type. Creating a test from a template copies its settings. Full list treatment. RBAC assessment_template.*.' } },
    { id: 'exams', label: 'Tests / Exams', spec: { dyn: 'tests',
      sub: 'Create and manage tests/exams assembled from the Question Bank — hand-picked questions and/or pooled sections (pick N at random from a category). Test types: practice, chapter, weekly, mock, assignment, practical, final exam. Settings: duration, total/passing marks (derived or overridden), negative marking, randomise questions/options, shuffle per attempt, questions-to-show, max attempts, availability window, instructions and how results are shown (instant / manual / after window). Live computed total marks, a builder with a question picker, draft → published → closed with validation, a student-facing PREVIEW that strips answers, create-from-template, and CSV import. Full list treatment: multi-filter (type / status / course / batch / language), export (names not ids), column chooser, refresh, bulk-delete. RBAC assessment.*.' } },
    { id: 'evaluation', label: 'Evaluation Queue', spec: { dyn: 'assessmentEvaluation',
      sub: 'The faculty EVALUATION QUEUE for the Assessment module. Two tabs: student TEST ATTEMPTS (objective portion auto-scored on submit; grade the subjective answers with per-question marks + feedback, a running total, then release) and ASSIGNMENT SUBMISSIONS (open/download the file the student uploaded to Cloudflare R2, award marks + feedback). Launch a test for a student from Tests / Exams — a timed player (live countdown, autosave, auto-submit at 0) for MCQ/subjective tests, or a file upload for assignment/practical tests. Filter by branch / vertical / status; export; refresh; run the overdue-attempt expiry sweep. RBAC assessment_attempt.* / assignment_submission.* / assessment.evaluate.' } },
    { id: 'assessmentresults', label: 'Results & Analytics', spec: { dyn: 'assessmentResults',
      sub: 'Per-test RESULTS: a scope-enforced LEADERBOARD (dense rank by score, percentile, grade, pass/fail) with pass-rate and average KPIs, and a drill-in RESULT CARD per student — score breakdown, grade badge, time taken, and analytics by topic/section, difficulty and question type. Export, refresh, column chooser. Results honour the test\'s show-result mode (instant / manual / after window). RBAC assessment.read / assessment_attempt.read.' } },
    { id: 'gradeschemes', label: 'Grade Schemes', spec: { dyn: 'gradeSchemes',
      sub: 'Configurable grading bands (India default seeded: A+ 90–100, A 80–89, B+ 70–79, B 60–69, C 50–59, Fail <50). Add/edit a scheme with a band editor validated to be contiguous over 0–100 with at least one pass band; set the default. A test can pin a scheme, else the org default applies. Full list treatment. RBAC grade_scheme.*.' } },
    { id: 'assessmentcerts', label: 'Certificates', spec: { dyn: 'assessmentCertificates',
      sub: 'Assessment certificates for a PASSED, evaluated attempt — a per-branch/vertical FY certificate number (ACRT-), grade + percentage, a generated PDF stored in Cloudflare R2, and a PUBLIC verification code (share the /verify link). Issue / revoke / download / delete. Full list treatment. RBAC assessment_certificate.* (issue / revoke). A login-free public page verifies a certificate by its code.' } },
    { id: 'progress', label: 'Academic Progress', spec: { dyn: 'reportCards',
      sub: 'Per-student, per-term report cards computed from attendance %, test scores and assignment grades (Indian grading bands; tests 50% / assignments 30% / attendance 20% over the components present). Report-card PDF; publish for a login-free PARENT VIEW (a shareable link to the card, attendance and parent-visible study material). Filter, export, choose columns, refresh, bulk-delete. RBAC reportcard.*.' } },
  ] },

  /* ---------------- Finance & Collections ---------------- */
  { id: 'finance', label: 'Finance & Collections', icon: 'finance', subs: [
    { id: 'dashboard', label: 'Finance Dashboard', spec: { dyn: 'financeDashboard',
      sub: 'Fees at a glance — invoiced, collected, outstanding and GST — by branch, vertical, course and payment mode.' } },
    { id: 'invoices', label: 'Fee Invoices', spec: { dyn: 'invoicesList',
      sub: 'GST tax invoices for enrolments (or one-off charges) with CGST/SGST or IGST, amount in words and a branded PDF.' } },
    { id: 'collection', label: 'Fee Collection', spec: { dyn: 'feeCollection',
      sub: 'Record fee payments — cash, UPI, card, cheque or online. Part payments allowed; a receipt PDF is generated automatically.' } },
    { id: 'onlinepay', label: 'Online Payments', spec: { dyn: 'onlinePayments',
      sub: 'Send a Razorpay payment link for a fee or instalment. When the student pays, the payment and receipt are recorded automatically.' } },
    { id: 'plans', label: 'Payment Plans', spec: { dyn: 'paymentPlans',
      sub: 'Instalment plans for an enrolment — full, instalments, EMI or custom — with due dates. Payments clear the oldest due first.' } },
    { id: 'dues', label: 'Fee Management', spec: { dyn: 'feeDues',
      sub: 'Outstanding fees by student with ageing (not due, 0–30, 31–60, 61–90, 90+ days), plus automatic due reminders.' } },
    { id: 'scholar', label: 'Scholarships', spec: { dyn: 'scholarships',
      sub: 'Scholarships on an enrolment — a counsellor requests, a manager approves or rejects with remarks.' } },
    // dev/103 — the manageable Discount Master: cap a discount by % AND ₹, optionally scoped by
    // branch/vertical/course (most-specific-wins). An over-cap discount is held for approval by an
    // authorized user (discount.approve = Academic Admin / Org / Super Admin) on the same screen.
    { id: 'discounts', label: 'Discount Master', spec: { dyn: 'discountMaster',
      sub: 'Maximum discount a counsellor can give, by % and by ₹, for all branches or a specific branch, vertical or course. Anything above the cap waits for approval.' } },
    { id: 'revenue', label: 'Revenue', spec: { dyn: 'revenueView',
      sub: 'Revenue two ways — money collected (after refunds) and fees billed — by branch, vertical, course, counsellor, payment mode, day or month.' } },
    { id: 'refunds', label: 'Refunds', spec: { dyn: 'refundsList',
      sub: 'Full or partial refunds with an approval step — a refund voucher (PDF) is created when it is approved.' } },
    { id: 'reports', label: 'Collection Reports', spec: { dyn: 'collectionReports',
      sub: 'Collections for any period by day, month, branch, vertical, course, counsellor or payment mode. Export to Excel, PDF or Tally.' } },
  ] },

  /* ---------------- Calls ---------------- */
  { id: 'calls', label: 'Calls', icon: 'calls', subs: [
    { id: 'overview', label: 'Calls', spec: { dyn: 'callLogs',
      sub: 'Every call, matched to its lead automatically from the phone\'s call log — duration, SIM, disposition and recording.' } },
    { id: 'dialer', label: 'Dialer', spec: { dyn: 'dialer',
      sub: 'Dial any number or click-to-call a lead. The call is logged against the lead and the phone dialer opens; outcome, duration and recording sync in from the phone\'s call log.' } },
    { id: 'click', label: 'Click-to-Call', spec: { dyn: 'dialer',
      sub: 'Find a lead and call it in one tap — logged against the lead, with disposition after the call.' } },
    { id: 'incoming', label: 'Incoming Calls', spec: { dyn: 'callLogsIncoming',
      sub: 'Every incoming call, matched to its lead — synced from the phone\'s call log. Disposition and recording inline.' } },
    { id: 'outgoing', label: 'Outgoing Calls', spec: { dyn: 'callLogsOutgoing',
      sub: 'Every outgoing call by your counsellors, matched to its lead, with duration, disposition and recording.' } },
    { id: 'missed', label: 'Missed Calls', spec: { dyn: 'callLogsMissed',
      sub: 'Missed calls from the phone\'s call log. A missed call from an unknown number becomes a lead in one click (Add as lead).' } },
    { id: 'transfer', label: 'Call Transfer', spec: gen('Calls', 'Call Transfer') },
    { id: 'conference', label: 'Conference Calling', spec: gen('Calls', 'Conference Calling') },
    { id: 'routing', label: 'Call Routing', spec: gen('Calls', 'Call Routing') },
    { id: 'logs', label: 'Call Logs', spec: { dyn: 'callLogs',
      sub: 'Every call auto-logged against its lead, imported from the phone\'s own call log. Search, filter, play the recording and log a disposition.' } },
    { id: 'recordings', label: 'Recordings', spec: { dyn: 'callRecordings',
      sub: 'Call recordings synced from the phone and attached to the lead. Play them right here.' } },
    { id: 'callsettings', label: 'Call Settings', spec: { dyn: 'callSettings',
      sub: 'Call tracking for this phone — SIMs to track, recording folder and how often calls sync.' } },
    { id: 'activityreport', label: 'Call Activity Report', spec: { dyn: 'callActivityReport',
      sub: 'Call productivity for any date range — totals, talk time, gaps between calls, by day, by counsellor and by manager.' } },
    { id: 'telSettings', label: 'Telephony Settings', spec: {
      sub: 'Provider, numbers & routing. Transfer / conference not required per requirements.',
      blocks: [{ type: 'cfg', title: 'Provider', rows: [
        { ic: 'calls', k: 'Provider', s: 'NeoDove (Exotel/Knowlarity/MyOperator/Tata ready)', v: 'NeoDove', toggle: true },
        { ic: 'phone', k: 'Dialer', s: 'Mobile + predictive', v: 'On', toggle: true },
        { ic: 'cfg', k: 'Transfer / Conference', s: 'Not required', v: 'Off', toggle: false }] }] } },
  ] },

  /* ---------------- Communication Intelligence ---------------- */
  { id: 'intel', label: 'Communication Intelligence', icon: 'intel', subs: [
    { id: 'aiintel', label: 'AI Insights', spec: { dyn: 'aiIntelligence',
      sub: 'Run an AI summary, sentiment or quality check on a call transcript or a lead\'s notes.' } },
    { id: 'activity', label: 'Call Activity', spec: { dyn: 'callActivityReport',
      sub: 'Call productivity over any date range — totals, day-wise, user-wise, manager-wise and an hourly chart.' } },
    { id: 'insights', label: 'Call Insights', spec: { dyn: 'aiIntelligence',
      sub: 'Call summaries, sentiment and quality from transcripts — pick a lead or paste / upload a transcript and run the analysis.' } },
    { id: 'ratings', label: 'Call Ratings', spec: { dyn: 'aiIntelligence',
      sub: 'AI quality score per analysed call — run the Quality analysis on a transcript to rate it.' } },
    { id: 'aiusage', label: 'AI Usage', spec: { dyn: 'aiUsage',
      sub: 'Every AI analysis run — by provider, type and user, over any date range.' } },
    { id: 'convanalytics', label: 'Conversation Analytics', spec: gen('Communication Intelligence', 'Conversation Analytics') },
    { id: 'sentiment', label: 'Sentiment Analysis', spec: p2('Sentiment & Conversation Analytics',
      'Sentiment scoring, conversation analytics & follow-up suggestions.',
      [cap('Sentiment score', 'Positive / neutral / negative', true), cap('Objection detection', 'Auto-flagged moments', true), cap('Follow-up suggestions', 'AI next step', true), cap('Conversation analytics', 'Talk ratio, pace', true)]) },
    { id: 'quality', label: 'Quality Monitoring', spec: { dyn: 'aiIntelligence',
      sub: 'AI-scored call quality — run the Quality analysis on a call transcript; scores are saved and listed per lead and counsellor.' } },
    { id: 'reclib', label: 'Recording Library', spec: { dyn: 'callRecordings',
      sub: 'Call recordings synced from the phone and attached to the lead. Play them right here.' } },
    { id: 'transcription', label: 'Call Transcription', spec: { dyn: 'aiIntelligence',
      sub: 'Paste or upload a call transcript (English, Hindi or mixed) against a lead, then run summary · sentiment · quality.' } },
    { id: 'summaries', label: 'Call Summaries', spec: { dyn: 'aiIntelligence',
      sub: 'AI summaries of calls — run Summary on a transcript; every summary is saved against its lead.' } },
    { id: 'intent', label: 'Intent Detection', spec: genP2('Communication Intelligence', 'Intent Detection') },
    { id: 'keyword', label: 'Keyword Tracking', spec: { dyn: 'keywordTracking',
      sub: 'Track the words that matter — course names, competitors, "fees", "discount" — across call transcripts, AI analyses, lead notes and WhatsApp messages, with counts and the leads that mention them.' } },
    { id: 'objection', label: 'Objection Detection', spec: genP2('Communication Intelligence', 'Objection Detection') },
    { id: 'followsug', label: 'Follow-up Suggestions', spec: genP2('Communication Intelligence', 'Follow-up Suggestions') },
    { id: 'aiset', label: 'AI Settings', spec: { dyn: 'aiSettings',
      sub: 'Choose the AI provider and set a monthly limit on AI runs.' } },
  ] },

  /* ---------------- Analytics & Reports ---------------- */
  { id: 'analytics', label: 'Analytics & Reports', icon: 'analytics', subs: [
    // Sprint 6 — all live. The catalog table is gone: the client's saved reports ARE the
    // catalog, and a hardcoded list of reports that do not exist is the fake data this
    // project's design rule forbids.
    { id: 'standard', label: 'Reports', spec: { dyn: 'savedReports',
      sub: 'Your saved reports — run, share, schedule or export any of them.' } },
    { id: 'builder', label: 'Report Builder', spec: { dyn: 'reportBuilder',
      sub: 'Build your own report — pick the data, columns, filters, grouping and dates. Save, share, schedule or export it.' } },
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
    { id: 'counselorperf', label: 'Counselor Performance', spec: { dyn: 'counsellorPerformance',
      sub: 'Leads handled, activity, conversion %, revenue, TAT, follow-up adherence & enrolments — with a leaderboard.' } },
    { id: 'revanalytics', label: 'Revenue Analytics', spec: { dyn: 'revenueView',
      sub: 'Collection (money received, net of refunds) and accrual (fee billed) grouped by branch / vertical / course / counsellor / mode / day / month.' } },
    { id: 'studentanalytics', label: 'Student Analytics', spec: { dyn: 'studentDashboard',
      sub: 'Students at a glance — total, active and new, by branch, vertical and course, with batch allocation and fees collected.' } },
    { id: 'forecasting', label: 'Forecasting', spec: { dyn: 'forecasting',
      sub: 'Expected enrolments and revenue: open leads × each pipeline\'s win rate over the last 12 months × its average net fee, plus the cash forecast of fee installments falling due — month by month.' } },
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
    { id: 'docs', label: 'Shared Documents', spec: { dyn: 'sharedDocs',
      sub: 'A shared document library — upload files into folders, share with everyone / a branch / a vertical / a role, download and track who added what.' } },
  ] },

  /* ---------------- HR & Workforce ---------------- */
  { id: 'hr', label: 'HR & Workforce', icon: 'hr', subs: [
    { id: 'directory', label: 'Employee Directory', spec: { dyn: 'hrDirectory',
      sub: 'Your staff register — employee code, designation, department, branch, joining date, contact and reporting manager.' } },
    { id: 'attendance', label: 'Attendance', spec: { dyn: 'hrAttendance',
      sub: 'Daily staff attendance (present, absent, half-day, leave, holiday) with a monthly sheet and per-employee summary.' } },
    { id: 'leaves', label: 'Leaves', spec: { dyn: 'hrLeaves',
      sub: 'Leave applications and balances — apply, approve or reject. Approved days are marked as leave in attendance.' } },
    { id: 'payroll', label: 'Salary', spec: { dyn: 'payroll',
      sub: 'Salary structure per employee (basic, HRA, allowances, PF / ESI / TDS / professional tax), monthly payroll runs that pro-rate by the HR attendance sheet (absent / unpaid leave days deducted), and payslips (PDF-ready print view).' } },
    { id: 'incentives', label: 'Incentives', spec: { dyn: 'targetIncentive',
      sub: 'Incentive plans with achievement slabs over named targets — the same engine as Performance › Target & Incentive.' } },
    { id: 'bank', label: 'Bank', spec: gen('HR & Workforce', 'Bank') },
    { id: 'performance', label: 'Performance', spec: {
      sub: 'Appraisal cycles, KRAs / goals & ratings.',
      blocks: [{ type: 'caps', title: 'Appraisals', items: [
        cap('Appraisal cycles', 'Quarterly / annual'), cap('KRAs & goals', 'Per role'),
        cap('Ratings', 'Manager + self'), cap('Linked to incentives', 'Score → payout')] }] } },
    { id: 'hiring', label: 'Hiring', spec: {
      sub: 'Job posts, candidate pipeline, interviews & offers.',
      blocks: [emptyTable('Hiring pipeline', ['Role', 'Applicants', 'Interview', 'Offer', 'Status'], 'No open positions yet')] } },
  ] },

  /* ---------------- Operations (ERP Batch 5 — live) ---------------- */
  { id: 'ops', label: 'Operations', icon: 'ops', subs: [
    { id: 'catalog', label: 'Catalog', spec: { dyn: 'catalogList',
      sub: 'The org-wide master of items / products / services the institute deals in — books, kits, merchandise, service items. Item code (auto ITM-), category, unit, price (₹), GST % and HSN/SAC (India), active. Used by inventory and procurement. Full list treatment: multi-filter, export, columns, refresh, bulk-delete.' } },
    { id: 'inventory', label: 'Inventory', spec: { dyn: 'inventoryList',
      sub: 'Per-branch/location stock of catalog items — quantity on hand, a receipt / issue / adjustment "Stock movement" that writes a movement log, and a low-stock threshold + flag. Receiving a purchase order increments stock automatically. Branch-scoped; full list treatment + a movement log.' } },
    { id: 'assets', label: 'Assets', spec: { dyn: 'assetsList',
      sub: 'The equipment / furniture / IT register — asset code (auto AST-), category, branch/location, purchase date + cost (₹), status (in-use / in-repair / retired), assigned-to (user), vendor, warranty + AMC dates. Lifecycle. Full list treatment.' } },
    { id: 'vendors', label: 'Vendor Management', spec: { dyn: 'vendorsList',
      sub: 'The vendor master — name, GSTIN (India), category, contact, address, optional bank details, active. Used by procurement and assets. Full list treatment: multi-filter, export, columns, refresh, bulk-delete.' } },
    { id: 'procure', label: 'Procurement', spec: { dyn: 'procurementList',
      sub: 'Purchase orders to a vendor for catalog items — line items (qty × ₹ price, per-line discount + GST), PO number (auto PO-), draft → sent → received → closed. Receiving a PO increments inventory. Branded PO PDF (the quotation/receipt PDF pipeline). India GST throughout. Full list treatment.' } },
  ] },

  /* ---------------- Administration ---------------- */
  { id: 'admin', label: 'Administration', icon: 'admin', subs: [
    { id: 'branches', label: 'Branch Management', spec: { dyn: 'branches',
      sub: 'Your branches and the verticals under each one.' } },
    { id: 'verticalmgmt', label: 'Vertical Management', spec: { dyn: 'verticals',
      sub: 'Business lines (brands) under each Branch — different per Branch. SMTP configured per vertical.' } },
    { id: 'pipelines', label: 'Pipeline Management', spec: { dyn: 'pipelines',
      sub: 'Sales pipelines and their stages — a vertical can have several pipelines.' } },
    { id: 'users', label: 'Users', spec: { dyn: 'users',
      sub: 'Create / edit / deactivate, bulk import & SSO (Google / Microsoft). Assign to multiple branches / pipelines.',
      actions: [['plus', 'Add user', 'primary']] } },
    { id: 'roles', label: 'Roles & Permissions', spec: { dyn: 'roles',
      sub: 'Custom roles — module, field & record-level. Partial roles instead of full modules.',
      actions: [['plus', 'New role', 'primary']] } },
    { id: 'courseconfig', label: 'Course Configuration', spec: { dyn: 'courses',
      sub: 'Configure courses & fees. Approval step for fee changes.',
      actions: [['plus', 'New course', 'primary']] } },
    // Admin › Masters re-enabled 2026-09-30 at the client's request (it was hidden on 2026-09-26).
    // 2026-10-05 (client): Sources are no longer managed here — Leads › Lead Source Master owns them.
    { id: 'masters', label: 'Masters', spec: { dyn: 'mastersAdmin',
      sub: 'Every dropdown master in one place — add, edit, view and activate/deactivate values (states, cities, courses, levels, Lead Status, tags & more). Lead Sources are managed under Leads › Lead Source Master.' } },
    { id: 'workflow', label: 'Workflow Automation', spec: { dyn: 'journeys',
      sub: 'Admin-built automation rules — triggers (new lead, stage change, no response, fee due, birthday) → conditions → actions. The same engine as Engagement › Automation Journeys.' } },
    { id: 'integrations', label: 'Integrations', spec: {
      // A catalogue of what can be connected and WHERE — not a live status (the old "Live" badges
      // claimed every tool was live even when nothing was connected; audit Oct 2026). Live
      // connection status is on Marketing › Integrations and Settings › Channels.
      sub: 'Everything the CRM can connect to, and where to set it up. Live connection status is shown on Marketing › Integrations and Settings › Channels.',
      blocks: [{ type: 'table', title: 'Available integrations', cols: ['System', 'Type', 'Set up in'], rows: [
        ['Facebook Leads (Facebook & Instagram Lead Ads)', 'Ad platform', 'Marketing › Integrations'],
        ['Meta WhatsApp (WhatsApp API)', 'Messaging', 'Engagement › WhatsApp Account'],
        ['Google Ads lead forms', 'Ad platform', 'Marketing › Integrations'],
        ['Google Sheets pull', 'Lead source', 'Marketing › Integrations (needs Google credentials)'],
        ['Google Form', 'Lead source', 'Marketing › Integrations'],
        ['IndiaMART', 'Marketplace', 'Marketing › Integrations — paste the webhook URL'],
        ['JustDial', 'Marketplace', 'Marketing › Integrations — paste the webhook URL'],
        ['TradeIndia', 'Marketplace', 'Marketing › Integrations — paste the webhook URL'],
        ['Housing.com', 'Marketplace', 'Marketing › Integrations — paste the webhook URL'],
        ['99acres', 'Marketplace', 'Marketing › Integrations — paste the webhook URL'],
        ['Custom Integration / Webhook', 'Lead source', 'Marketing › Integrations'],
        ['Website form', 'Website', 'Marketing › Integrations'],
        ['Razorpay', 'Payment', 'Settings › Channels (keys per vertical)'],
        ['SMS (DLT)', 'Messaging', 'Settings › Channels'],
        ['Gemini / DeepSeek', 'AI', 'Settings › Channels']] }] } },
    { id: 'api', label: 'API Access', spec: { dyn: 'apiModule',
      sub: 'API keys that let another system create or read leads. Every call is logged and a key can be switched off instantly.' } },
    { id: 'compliance', label: 'Compliance', spec: { dyn: 'compliance',
      sub: 'DPDP consent, opt-outs, DLT template registry, audit trail and data retention — live counts from the system, the consent wording shown on lead forms, and the retention policy for deleted records.' } },
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
    // dev/143 item 5 — Template Setup (document/ID formats). Reachable from Administration › Settings area.
    { id: 'templates', label: 'Template Setup', spec: { dyn: 'templateSetup',
      sub: 'Header, logo, footer and terms for every document — fee invoice, receipt, student and employee ID cards, quotation, certificate and marksheet.' } },
    // Client request — Finance Settings: discount / scholarship / capping limit, BOTH by
    // percentage and by amount, org-wide or per vertical. Enforced everywhere a discount
    // is applied (quotation line, enrolment). Only a permitted user changes the caps.
    { id: 'finance', label: 'Finance Settings', spec: { dyn: 'financeSettings',
      sub: 'Maximum discount and scholarship, by % and by ₹, for the whole organisation or one vertical.' } },
  ] },

  /* ---------------- Help & Support ---------------- */
  { id: 'help', label: 'Help & Support', icon: 'help', subs: [
    { id: 'features', label: "What's New / Features", spec: { dyn: 'featuresPanel',
      sub: 'Recent updates and the full list of feature modules in the CRM. Click a module to open it. This is the destination of the top-bar Features shortcut.' } },
    { id: 'tickets', label: 'Support Tickets', spec: { dyn: 'supportTickets',
      sub: 'Raise and track internal support tickets — category, priority, assignee and due time, from open to closed.' } },
    { id: 'helpcenter', label: 'Help Center', spec: { dyn: 'knowledgeBase',
      sub: 'In-app help articles maintained by Admin — categories, search and access control (the Knowledge Base).' } },
    { id: 'guides', label: 'Product Guides', spec: { dyn: 'knowledgeBase',
      sub: 'Step-by-step guides for using the system — write them as Knowledge Base articles in a "Guides" category.' } },
    { id: 'training', label: 'Training Videos', spec: { dyn: 'trainingVideos',
      sub: 'A library of training / how-to videos for staff — title, description, category, video URL (YouTube / Vimeo / MP4 / embed), thumbnail, tags, order and active flag. Staff browse and play in-app; admins manage the library. Filter by category / status / search / date, export, choose columns, refresh, bulk-delete. RBAC training.* (view vs manage).' } },
    { id: 'releases', label: 'Release Notes', spec: { dyn: 'releaseNotes',
      sub: 'What\'s new in the CRM — every release with its changes.' } },
  ] },

  /* ---------------- Franchise & Royalty (Phase 4 Batch 1) ---------------- */
  { id: 'fran', label: 'Franchise', icon: 'fran', subs: [
    { id: 'portal', label: 'Partner Portal', spec: { dyn: 'franchisePartnerPortal',
      sub: 'The franchise-owner self-service view, FIXED to the logged-in owner\'s franchise (no selector). Their dashboard (branches, students / enrolments, revenue collected, net, outstanding dues, royalty payable), their royalty invoices, compliance status and target achievement — all scoped to their own franchise. Head office keeps the full Franchise module across all franchises.' } },
    { id: 'franchises', label: 'Franchises', spec: { dyn: 'franchises',
      sub: 'Your franchises — owner, contact, GST number, status, agreement dates and the branches each one runs.' } },
    { id: 'dashboard', label: 'Franchise Dashboard', spec: { dyn: 'franchiseDashboard',
      sub: 'Each franchise at a glance — branches, students, enrolments, revenue, dues and royalty payable.' } },
    { id: 'royaltyPlans', label: 'Royalty Plans', spec: { dyn: 'royaltyPlans',
      sub: 'Royalty / revenue-share configuration per franchise (or a reusable template): % of collected revenue, % of net revenue, a fixed monthly fee, or a TIERED plan whose royalty % varies by revenue band. Optional monthly minimum guarantee + an effective date range. Live compute preview.' } },
    { id: 'royaltyStatement', label: 'Royalty Statement', spec: { dyn: 'royaltyStatement',
      sub: 'The royalty payable for a franchise + period: gross collected, refunds, net collected, the royalty rate applied, royalty amount, adjustments and the final payable — pulled from the franchise\'s branches\' collections so it reconciles with Finance.' } },
    { id: 'agreements', label: 'Agreements & Renewals', spec: { dyn: 'franchiseAgreements',
      sub: 'Franchise agreement records — agreement no, sign / start / end / renewal dates, status (Active / Expiring / Expired / Renewed) and the signed document (stored in R2). Add / Edit + document upload, plus a renewal reminder listing agreements expiring within 60 days.' } },
    { id: 'territory', label: 'Territory', spec: { dyn: 'franchiseTerritory',
      sub: 'Where each franchise may operate — city, region, pincode or area — with a warning if two franchises overlap.' } },
    { id: 'onboarding', label: 'Onboarding', spec: { dyn: 'franchiseOnboarding',
      sub: 'A per-franchise onboarding checklist materialised from a default template (application -> agreement -> fee -> branches -> royalty plan -> KYC -> territory -> training -> go-live). Each step done / pending with completed-by/at and a live progress %. Add / remove custom steps.' } },
    { id: 'royaltyInv', label: 'Royalty Invoices', spec: { dyn: 'royaltyInvoices',
      sub: 'Generate a royalty invoice for a franchise + period from its royalty statement (ROY-<FY>/#### series, separate from student invoices). Draft / Issued / Paid / Cancelled, preview + print, record payments against it. List + generate-from-statement + view.' } },
    { id: 'outstanding', label: 'Outstanding Royalties', spec: { dyn: 'outstandingRoyalties',
      sub: 'Unpaid royalty invoices by age (current, 31–60, 61–90, 90+ days) — record a payment against any of them.' } },
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
 *   • Learning & Assessment — the whole module (Oct 2026), plus its pieces elsewhere: the
 *       Assessments block on the dashboards, the student profile's Syllabus / Report Cards tabs
 *       and Tests / Assignments sections, the parent report-card link, and its permission rows
 *       in the Role editor (grants are KEPT, only not shown) — see isModuleHidden('learning').
 *
 * The full, current list lives in docs/HIDDEN_MODULES.md — keep it in step with this block.
 */
const HIDDEN_MODULES = new Set<string>([
  'ops',      // Operations — entire module hidden
  'learning', // Learning & Assessment — entire module hidden (Oct 2026)
]);

/** True when a whole module is hidden — for the module's pieces that live on OTHER screens. */
export const isModuleHidden = (id: string): boolean => HIDDEN_MODULES.has(id);

/** Role-editor permission groups that belong to Learning & Assessment (hidden with it). */
export const LEARNING_PERMISSION_MODULES = new Set<string>([
  'test', 'coursework', 'material', 'reportcard', 'results', 'syllabus', 'course_content',
  'question_category', 'question', 'assessment', 'assessment_attempt', 'assignment_submission',
  'assessment_template', 'grade_scheme', 'assessment_certificate',
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
  // Call tracking is a field/mobile feature — surface Call History, Recordings, Call
  // Settings (SIM + recording folder + permissions + tap-to-dial) and the Activity Report.
  calls: new Set(['logs', 'recordings', 'callsettings', 'activityreport']),
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
