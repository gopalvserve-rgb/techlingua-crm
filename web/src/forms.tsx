/**
 * Add-record forms — field specs ported verbatim from the prototype's SPEC_FORMS,
 * with live master/hierarchy dropdowns and wired saves where APIs exist.
 * Unwired forms render exactly but tell the user which project phase makes them live.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { UserPicker } from './userpicker';
import { AddMasterModal } from './mastermodal';
import { PhoneInput } from './phonefield';
import { toast, useRef_, Named, RefData, selectableUsers } from './refdata';
import { findScreen } from './specs';
import { fetchLeadCfDefs, collectCf, CfDef } from './customfields';

export interface FormField {
  label: string; type?: string; req?: boolean; opts?: string[] | null; hint?: string;
  /** refdata source for id-valued selects (enables cascading + wired saves) */
  src?: keyof Pick<RefData, 'branches' | 'verticals' | 'pipelines' | 'campaigns' | 'sources' | 'masterSources' | 'users' | 'courses' | 'followupTypes' | 'dispositions' | 'statuses' | 'budgets' | 'states' | 'cities'>;
  /** default value on the ADD form (never on Edit — an edit prefill always wins). */
  def?: string;
  /** UAT-R2 — a STRING-valued select whose options come from a master list (RefData key).
   *  Unlike `src` (which stores an id and cascades), `mopts` stores the master's NAME, so
   *  the column/JSON stays text and edit-prefill is trivial. Carries the ＋ Master add. */
  mopts?: keyof Pick<RefData, 'trainings' | 'visitPurposes' | 'walkinStatuses' | 'ticketCategories' | 'courseTypes'>;
  /** client update #5 (Task module only) — render the logged-in user as "Myself",
   *  pinned to the top of the user list and selected by default. Scoped per field,
   *  so Lead Owner / Counsellor dropdowns elsewhere keep showing real names. */
  self?: boolean;
  /** Client UAT (Aug 2026) — render this field on the ADD form only, never on Edit (e.g. the
   *  walk-in Round-Robin checkbox is an assign-on-add decision, meaningless when editing). */
  addOnly?: boolean;
  /** UAT-R2 #19 — 'today' sets a date/datetime input's `min` to the start of today
   *  (no past dates). Only 'today' is supported today. */
  min?: 'today';
  /** Custom-field mapping (client, Aug 2026): when set, this field is a lead custom field —
   *  its VALUE persists into lead.custom_fields under this `cfKey` (see customfields.tsx). */
  cfKey?: string;
  /** Restrict a `src:'users'` picker to users who hold a given system role by NAME
   *  (e.g. 'Trainer' on the batch Trainer/Faculty field). Filters on the `role_names`
   *  already returned by the scoped /users list, so it stays branch/vertical-scoped;
   *  a value already stored on the record (edit prefill) is kept even if the user no
   *  longer holds that role (legacy passthrough). */
  role?: string;
}
export const F = (label: string, type?: string, req?: 0 | 1 | boolean, opts?: string[] | 0 | null, hint?: string, src?: FormField['src'], self?: 0 | 1 | boolean, def?: string): FormField =>
  ({ label, type, req: !!req, opts: opts || null, hint: hint || '', src, self: !!self, def });

/** Label used for the current user inside Task-module user dropdowns. */
export const SELF_LABEL = 'Myself';

// Course master catalogs (client feedback #13, Aug 2026) — the dropdown sets for the Course
// Type / Level / Delivery Mode fields. Values match the seeded *_def catalogs (migration 082,
// code == label) and the GET /courses/*-catalog endpoints; a course stores the picked text in
// m_course.meta (course_type / level / delivery_mode), consistent with fee / vertical_id.
export const COURSE_TYPES = ['Diploma', 'Certificate', 'Foundation', 'Crash Course', 'Advanced Diploma', 'Workshop'];
export const COURSE_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'Beginner', 'Intermediate', 'Advanced', 'Expert'];
export const DELIVERY_MODES = ['Offline', 'Online', 'Hybrid'];

const _BR = ['—'], _VERT = ['—'], _PIPE = ['—'], _COURSE = ['—'], _USERS = ['—'];
const _PLAN = ['Full Payment', '3 EMI', '6 EMI', 'Custom'];

/**
 * THE HIERARCHY CASCADE, declared once. A child <select> is filtered to its parent's
 * choice, is EMPTY (and disabled) until the parent is picked, and RESETS when the parent
 * changes — so a stale child id (e.g. a Vertical from a different Branch) can never reach
 * the payload. Course configuration follows Branch › Vertical exactly like the lead forms.
 */
export const CASCADE: Array<{ src: NonNullable<FormField['src']>; parent: string; fk: string; strict?: boolean }> = [
  { src: 'verticals', parent: 'Branch', fk: 'branch_id', strict: true },
  // (Branch Access → Vertical Access cascade is handled by the multipick renderer, which
  //  narrows Vertical Access to the verticals under the ticked branches and prunes stale ones.)
  { src: 'pipelines', parent: 'Vertical', fk: 'vertical_id', strict: true },
  { src: 'campaigns', parent: 'Pipeline', fk: 'pipeline_id', strict: true },
  { src: 'sources', parent: 'Campaign', fk: 'campaign_id', strict: true },
  { src: 'cities', parent: 'State', fk: 'parent_id' },
];

/* ──────────────────  MULTI-BRANCH USER ACCESS  ────────────────
 * A user may be granted access to SEVERAL branches (and, optionally, specific
 * verticals) at creation/edit. The `/users` API already accepts an `assignments[]`
 * array and the RBAC ScopeResolver UNIONS every active assignment, so lead
 * visibility spans all granted branches. The UI just has to emit one assignment
 * row per selected branch. Selections ride in `vals` (a string map) as CSV so the
 * existing `Ids` (number|undefined) contract is untouched:
 *   Branch Access   → "9,10"                (plain branch ids)
 *   Vertical Access → "5:9,6:10"            (verticalId:branchId, self-describing so
 *                                            the saver needs no RefData lookup)
 */
export const parseIdCsv = (s?: string): number[] =>
  (s ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
export const parseVertCsv = (s?: string): Array<{ v: number; b: number }> =>
  (s ?? '').split(',').map((t) => t.trim()).filter(Boolean)
    .map((t) => { const [v, b] = t.split(':').map(Number); return { v, b }; })
    .filter((x) => Number.isFinite(x.v) && x.v > 0);

export type AssignmentRow = {
  role_id: number; branch_id: number | null; vertical_id: number | null;
  pipeline_id?: number | null; campaign_id?: number | null; team_id?: number | null;
};

/**
 * One `user_assignment` per selected branch, all carrying the chosen System Role.
 *  • no branch + no vertical  → a single ORG-WIDE row (branch_id null) — today's meaning.
 *  • branch with selected verticals → one row PER vertical (branch+vertical scoped);
 *    a branch with none of its verticals ticked → one whole-branch row.
 *  • a vertical whose branch was NOT ticked still grants that vertical (mapped to its own branch).
 * `extra` re-emits assignment rows this form does not manage (pipeline/campaign/team
 * scoped), so an Edit reconcile never drops a user's other access.
 */
export function buildUserAssignments(
  roleId: number,
  branchIds: number[],
  verts: Array<{ v: number; b: number }>,
  extra: AssignmentRow[] = [],
): AssignmentRow[] {
  const rows: AssignmentRow[] = [];
  if (branchIds.length === 0) {
    if (verts.length === 0) rows.push({ role_id: roleId, branch_id: null, vertical_id: null });
    else for (const { v, b } of verts) rows.push({ role_id: roleId, branch_id: b || null, vertical_id: v });
  } else {
    for (const b of branchIds) {
      const vs = verts.filter((x) => x.b === b);
      if (!vs.length) rows.push({ role_id: roleId, branch_id: b, vertical_id: null });
      else for (const { v } of vs) rows.push({ role_id: roleId, branch_id: b, vertical_id: v });
    }
    for (const { v, b } of verts) if (b && !branchIds.includes(b)) rows.push({ role_id: roleId, branch_id: b, vertical_id: v });
  }
  return [...rows, ...extra];
}

/* MY TASK overhaul (dev/133) — Related-To types + Task Status maps (used by the task form spec). */
export const TASK_ENTITY_OPTS = [
  'Lead', 'Student', 'Admission', 'Enrollment', 'Course', 'Batch', 'Payment',
  'Invoice', 'Follow-up', 'Employer', 'Placement', 'Trainer', 'Staff',
];
export const TASK_STATUS_KEY: Record<string, string> = {
  'In Progress': 'in_progress', 'On Hold': 'on_hold', 'Completed': 'completed',
};
export const TASK_STATUS_LABEL: Record<string, string> = {
  in_progress: 'In Progress', on_hold: 'On Hold', completed: 'Completed', overdue: 'Overdue',
};
export const TASK_ENTITY_KEY: Record<string, string> = {
  Lead: 'lead', Student: 'student', Admission: 'admission', Enrollment: 'enrollment',
  Course: 'course', Batch: 'batch', Payment: 'payment', Invoice: 'invoice',
  'Follow-up': 'followup', Employer: 'employer', Placement: 'placement',
  Trainer: 'trainer', Staff: 'staff',
};


export const SPEC_FORMS: Record<string, { title: string; fields: FormField[] }> = {
  'leads.all': { title: 'Add Lead', fields: [
    F('Name', 'text', 1), F('Mobile Number', 'tel', 1, 0, 'de-dup key'), F('Alternate Number', 'tel'), F('WhatsApp Number', 'tel'), F('Email ID', 'email'),
    // Sprint 4 — the `birthday` automation journey needs a date to fire on.
    F('Date of Birth', 'date', 0, 0, 'used by the Birthday automation journey'),
    F('Branch', 'select', 1, 0, 'master', 'branches'), F('Vertical', 'select', 1, 0, 'filtered by Branch', 'verticals'), F('Pipeline', 'select', 1, 0, 'filtered by Vertical', 'pipelines'),
    F('Campaign', 'select', 1, 0, 'filtered by Pipeline', 'campaigns'), F('Lead Source', 'select', 1, 0, 'filtered by Campaign', 'sources'),
    F('Course', 'select', 0, 0, 'master', 'courses'), { ...F('Training Mode', 'select', 0, 0, 'master'), mopts: 'trainings' }, F('Course Fee', 'number'), F('City / Location', 'text'),
    F('Lead Counsellor', 'select', 0, 0, 'Users · optional — leave blank and tick Round-Robin', 'users'),
    // dev/84 item 3 — round-robin on a MANUAL lead: tick to auto-assign the owner via the
    // campaign distribution engine (reuses the walk-in / campaign round-robin), counsellor optional.
    { ...F('Assign via Round-Robin', 'checkbox', 0, 0, 'auto-assign the lead via the campaign round-robin — counsellor can be left blank'), addOnly: true },
    F('Lead Status', 'select', 0, 0, 'default: New', 'statuses'),
    F('Next Follow-up Date', 'datetime'), F('Created On', 'auto', 0, 0, 'Auto-stamped · edit permission by Admin'), F('Remarks / Notes', 'textarea')] },
  // Sprint 3 — a walk-in creates a REAL lead, and every lead carries the FULL path
  // (Org > Branch > Vertical > Pipeline > Campaign > Source). The prototype's walk-in form
  // stopped at Vertical, so Pipeline / Campaign / Lead Source are added here — a sanctioned
  // form-field addition (see design/01-prototype-parity-spec.md), not a nav change.
  'dash.walkins': { title: 'Add Walk-in', fields: [
    F('Name', 'text', 1), F('Mobile Number', 'tel', 1, 0, 'de-dup key'), F('Alternate Number', 'tel'), F('WhatsApp Number', 'tel'), F('Email ID', 'email'),
    F('Branch', 'select', 1, 0, 'auto if desk is Branch-locked', 'branches'), F('Vertical', 'select', 1, 0, 'filtered by Branch', 'verticals'),
    F('Pipeline', 'select', 1, 0, 'filtered by Vertical', 'pipelines'), F('Campaign', 'select', 1, 0, 'filtered by Pipeline', 'campaigns'),
    F('Lead Source', 'select', 1, 0, 'filtered by Campaign', 'sources'),
    { ...F('Date & Time of Visit', 'datetime', 1, 0, 'auto-stamped · today or later'), min: 'today' as const },
    { ...F('Purpose of Visit', 'select', 1, 0, 'master'), mopts: 'visitPurposes' }, F('Course Interested', 'select', 0, 0, 'filtered by Vertical', 'courses'),
    // DEF-S34-02 — these three RENDERED but were never SENT and had no columns (migration 027).
    F('Course Fee', 'number', 0, 0, 'auto-filled from the Course master · editable'),
    F('How did you hear about us?', 'select', 0, 0, 'Source channel master (how they heard)', 'masterSources'),
    // Client UAT (Aug 2026): Assign Counsellor is now OPTIONAL. Leave it blank and tick
    // Round-Robin to auto-assign the lead via the campaign's distribution engine.
    F('Counsellor Assigned', 'select', 0, 0, 'Users · owns the lead immediately (optional)', 'users'),
    { ...F('Assign via Round-Robin', 'checkbox', 0, 0, 'auto-assign the lead via the campaign round-robin — counsellor can be left blank'), addOnly: true },
    // ticked by default: a walk-in becoming an assigned lead IS the point of this screen.
    // Untick it to log a visit (a fee query from an existing student) without a lead;
    // tick it later on Edit and it converts through the same LeadIngestionService.
    F('Convert to Lead', 'checkbox', 0, 0, 'creates the lead and assigns it to the counsellor', undefined, 0, '1'),
    F('Remarks', 'textarea')] },
  'dash.referrals': { title: 'Add Referral', fields: [
    F('Referrer Type', 'select', 1, ['Existing Student', 'Parent', 'Employee', 'Alumni', 'Partner'], '', undefined, 0, 'Existing Student'),
    // Client Aug 2026 (#3) — existing-student search: pick a student and auto-fill the referrer
    // name / phone / branch / vertical / course. Shows only when Referrer Type = Existing Student;
    // brand-new referrers still type everything in manually.
    F('Find Existing Student', 'studentlookup', 0, 0, 'Search by name / phone / student id to auto-fill'),
    F('Referrer Name', 'text', 1, 0, 'Student / Employee name'),
    F('Referrer Contact Number', 'tel', 1), F('Referred Person Name', 'text', 1), F('Referred Person Contact Number', 'tel', 1, 0, 'de-dup key'),
    F('Referred Person WhatsApp Number', 'tel'), F('Referred Person Email', 'email'), F('Relationship to Referrer', 'text'),
    F('Branch', 'select', 1, 0, 'master', 'branches'), F('Vertical', 'select', 1, 0, 'filtered by Branch', 'verticals'),
    F('Pipeline', 'select', 1, 0, 'filtered by Vertical', 'pipelines'), F('Campaign', 'select', 1, 0, 'filtered by Pipeline', 'campaigns'),
    F('Lead Source', 'select', 1, 0, 'filtered by Campaign', 'sources'),
    F('Course Interested', 'select', 0, 0, 'filtered by Vertical', 'courses'), F('Incentive / Reward Applicable', 'text', 0, 0, 'auto-computed'),
    // UAT-R2 #20 — Assigned Counsellor: like Walk-in, owns the referred lead (else campaign distribution decides).
    F('Assigned Counsellor', 'select', 0, 0, 'Users · owns the referred lead', 'users'),
    F('Referral Status', 'select', 1, ['Pending', 'Converted', 'Rewarded', 'Rejected'])] },
  // UAT-R2 #4 — Source Category, Cost per Lead removed (backend keeps its defaults). Campaign
  // stays: it is the required parent that supplies the source's Branch › Vertical › Pipeline path.
  // UAT-R3 #21 — the Add Source form walks the FULL strict cascade Branch → Vertical →
  // Pipeline → Campaign (each empty until its parent is chosen), then the source fields.
  // Only campaign_id is sent; the source's Branch/Vertical/Pipeline path is derived from the
  // Campaign server-side (HierarchyService.createSource), so the hierarchy fields are cascade
  // filters only (EXEMPT in qa10matrix), exactly as on the Add Lead form.
  // 27aug Batch C item 1 — Campaign is now OPTIONAL: a Lead Source can exist org-wide with no
  // campaign. Branch/Vertical/Pipeline/Campaign are an optional cascade that (when chosen) scopes
  // the source under that campaign; left blank, the source is created org-level.
  'leads.sources': { title: 'Add Lead Source', fields: [
    F('Branch', 'select', 0, 0, 'optional — scope the source', 'branches'), F('Vertical', 'select', 0, 0, 'filtered by Branch', 'verticals'),
    F('Pipeline', 'select', 0, 0, 'filtered by Vertical', 'pipelines'), F('Campaign', 'select', 0, 0, 'optional — leave blank for an org-wide source', 'campaigns'),
    F('Source Name', 'text', 1, 0, 'editable'), F('Status', 'select', 0, ['Active', 'Inactive'])] },
  'leads.pipelinemaster': { title: 'Add Pipeline', fields: [
    F('Pipeline Name', 'text', 1), F('Branch', 'select', 1, 0, 'master', 'branches'), F('Vertical', 'select', 1, 0, 'filtered by Branch', 'verticals'),
    F('Pipeline Code', 'text', 1, 0, 'e.g. ADM'), F('Pipeline Stages', 'table', 0, 0, 'Default stage set added — edit after create'), F('Pipeline Owner', 'select', 0, 0, 'Users', 'users'), F('Status', 'select', 0, ['Active', 'Inactive'])] },
  'perf.closure': { title: 'Record Sales Closure', fields: [
    F('Lead / Walk-in Reference', 'leadlookup', 1, 0, 'Search lead / walk-in'), F('Branch / Vertical / Pipeline / Campaign', 'auto', 1, 0, 'Auto-pulled from Lead'),
    F('Course Finalised', 'select', 1, 0, 'Course master · filtered by Vertical', 'courses'), F('Batch Preference', 'select', 0, _PIPE, 'filtered by Course'),
    F('Closure Status', 'select', 1, ['Won', 'Lost']), F('Reason (if Lost)', 'select', 0, ['Price', 'Location', 'Timing', 'Competitor', 'Other']),
    F('Final Closure Amount', 'number', 1), F('Payment Plan Selected', 'select', 1, _PLAN, 'Payment Plan master'),
    F('Sales Owner / Counsellor', 'select', 1, 0, 'auto-filled', 'users'), F('Closure Date', 'date', 1)] },
  'perf.quotes': { title: 'Add Quotation', fields: [
    F('Quotation Number', 'auto', 1, 0, 'Auto-generated'), F('Lead / Walk-in Reference', 'leadlookup', 1), F('Branch', 'auto', 1, 0, 'Auto-pulled from Lead'), F('Vertical', 'auto', 1, 0, 'Auto-pulled from Lead'),
    F('Course & Batch', 'select', 1, 0, 'filtered', 'courses'), F('Standard Fee Amount', 'number', 1, 0, 'auto from Course'), F('Discount / Scholarship Applied', 'lookup', 0, 0, 'Discount / Scholarship master'),
    F('Final Quoted Amount', 'number', 1, 0, 'auto-computed'), F('Payment Terms Proposed', 'select', 1, _PLAN, 'Payment Plan master'), F('Validity Date', 'date', 1),
    F('Prepared By', 'select', 1, 0, 'auto-filled', 'users'), F('Status', 'select', 1, ['Draft', 'Sent', 'Accepted', 'Expired'])] },
  'perf.targets': { title: 'Add Target', fields: [
    F('Target Owner', 'select', 1, ['Individual (Counsellor)', 'Team', 'Branch']), F('Branch', 'select', 1, 0, 'master', 'branches'), F('Vertical', 'select', 1, 0, 'filtered by Branch', 'verticals'),
    F('Pipeline', 'select', 0, 0, 'filtered by Vertical', 'pipelines'), F('Target Period', 'select', 1, ['Month', 'Quarter', 'Year']), F('Target Type', 'select', 1, ['Leads Generated', 'Admissions', 'Revenue']),
    F('Target Value', 'number', 1), F('Achieved Value', 'auto', 1, 0, 'Auto-computed from closures')] },
  'students.all': { title: 'Add Student', fields: [
    F('Student Name', 'text', 1), F('Date of Birth', 'date', 1), F('Gender', 'select', 0, ['Male', 'Female', 'Other']), F('Mobile Number', 'tel', 1), F('Alternate Number', 'tel'), F('WhatsApp Number', 'tel'),
    F('Email ID', 'email'), F('Address', 'textarea'), F('Parent / Guardian Name', 'text', 1), F('Parent / Guardian Contact', 'tel', 1),
    F('Branch', 'auto', 1, 0, 'Auto-filled from Lead'), F('Vertical', 'auto', 1, 0, 'Auto-filled from Lead'), F('Course', 'select', 1, 0, 'filtered', 'courses'), F('Course Fee', 'number', 1),
    F('Payment Plan', 'select', 1, _PLAN, 'Payment Plan master'), F('Converted From (Lead/Walk-in)', 'leadlookup', 0, 0, 'auto-linked'), F('Previous Education / Qualification', 'text'),
    F('Photo & ID Proof', 'file'), F('Student ID', 'auto', 1, 0, 'Auto-generated')] },
  'students.admissions': { title: 'Add Admission', fields: [
    F('Student', 'lookup', 1, 0, 'Student master'), F('Branch', 'auto', 1, 0, 'Auto-filled from Student'), F('Vertical', 'select', 1, 0, 'filtered', 'verticals'), F('Course', 'select', 1, 0, 'filtered by Vertical', 'courses'),
    F('Batch', 'select', 1, _PIPE, 'filtered by Course · seat-checked'), F('Admission Number', 'auto', 1, 0, 'Auto-generated'), F('Admission Date', 'date', 1),
    F('Fee Plan / Payment Plan', 'select', 1, _PLAN, 'Payment Plan master'), F('Counsellor / Admission Owner', 'auto', 1, 0, 'Auto-filled from Sales Closure'),
    F('Documents Submitted', 'file', 1, 0, 'checklist / upload'), F('Admission Status', 'select', 1, ['Confirmed', 'Provisional', 'Cancelled'])] },
  // Client update #7 (Branch › Vertical) — a Course belongs to ONE Branch → ONE Vertical.
  // Branch comes first; Vertical is filtered by (and empty until) the chosen Branch, using
  // the same cascade engine as the lead forms (CASCADE / srcOptions). The old form put
  // Vertical first and offered a lone "Applicable Branch(es)" select that never related to
  // it, so the two dropdowns did nothing — the bug the client reported.
  // UAT (Aug 2026) — the course form now walks the FULL hierarchy the client asked for:
  // Branch → Vertical → Pipeline → Campaign, each STRICTLY filtered by (and empty until)
  // its parent, each resetting its descendants on change — the same cascade engine as the lead
  // forms (CASCADE / srcOptions). OWNERSHIP is unchanged: a course still BELONGS to Branch →
  // Vertical (both required, stored in meta.branch_id / meta.vertical_id, update #7/#9). Pipeline
  // and Campaign are OPTIONAL associations (stored in meta.pipeline_id / meta.campaign_id) so the
  // client can narrow a course to a specific pipeline/campaign; leaving them blank keeps the course
  // at Branch → Vertical exactly as before.
  'students.courses': { title: 'Add Course', fields: [
    F('Course Name', 'text', 1), F('Course Code', 'text', 1), F('Branch', 'select', 1, 0, 'master', 'branches'), F('Vertical', 'select', 1, 0, 'filtered by Branch', 'verticals'),
    // Course LEVELS (enrollment re-model, batch 1) — a course can have MANY levels (A1, A2, …), each
    // with its OWN fee. "+ Add level" adds rows; empty falls back to the single Standard Fee below.
    // Replaces the old single "Course Level" descriptor. Persisted via PUT /courses/:id/levels.
    F('Levels', 'levels', 0, 0, 'optional — each level carries its own fee; leave empty to use the single Standard Fee'),
    F('Duration', 'text', 0, 0, 'free text — e.g. 6 Months, 1 Year, 8 Weeks'), F('Standard Fee', 'number', 0, 0, 'used when the course has no levels'), F('Standard Exam Fee', 'number', 0, 0, 'optional — added on top, never discounted; used when the course has no levels'), F('Eligibility Criteria', 'text'), { ...F('Training Mode', 'select', 0, 0, 'master'), mopts: 'trainings' },
    // Course descriptors (client feedback #13, Aug 2026) — Level / Type / Description. dev/100 (client):
    // Delivery Mode dropped from the course UI (meta.delivery_mode kept in DB, hidden); ERP forms carry
    // NO Campaign/Pipeline (CRM-only) — the course walks Branch > Vertical only.
    // dev/106 — Course Type reads the self-manageable master (RefData.courseTypes, via /courses/type-catalog
    // which now serves m_course_type); ＋ Master adds a new type inline. Stores the label text in meta.course_type.
    { ...F('Course Type', 'select', 0, 0, 'master — add your own with ＋ Master'), mopts: 'courseTypes' },
    F('Description', 'textarea', 0, 0, 'optional — short course description'),
    F('Status', 'select', 0, ['Active', 'Inactive'])] },
  'students.batches': { title: 'Add Batch', fields: [
    F('Batch Name / Code', 'text', 1, 0, 'e.g. JAVA-JUL26-EVE'), F('Course', 'select', 1, 0, 'master', 'courses'), F('Branch', 'auto', 1, 0, 'Auto-filled from Course/Vertical'),
    F('Start Date', 'date', 1), F('End Date', 'date', 1), F('Class Timing', 'text', 1), F('Capacity (Max Seats)', 'number', 1),
    // Client feedback: offer ONLY Trainer-role users here, not every user.
    { ...F('Trainer / Faculty Assigned', 'select', 0, 0, 'Trainer-role users only', 'users'), role: 'Trainer' },
    F('Mode', 'select', 1, ['Online', 'Offline', 'Hybrid']), F('Status', 'select', 1, ['Upcoming', 'Ongoing', 'Completed', 'Cancelled'])] },
  'finance.invoices': { title: 'Add Invoice', fields: [
    F('Invoice Number', 'auto', 1, 0, 'Auto-generated'), F('Student', 'lookup', 1, 0, 'Student master'), F('Branch', 'auto', 1, 0, 'Auto-filled from Admission'), F('Vertical', 'select', 1, 0, 'invoice created & numbered per vertical', 'verticals'), F('Course / Batch', 'auto', 1, 0, 'Auto-filled from Admission'),
    F('Invoice Date', 'date', 1), F('Total Amount', 'number', 1), F('Tax / GST Amount', 'number', 1, 0, 'auto-computed'), F('Discount / Scholarship Applied', 'number', 0, 0, 'auto from Quotation'),
    F('Net Payable Amount', 'number', 1, 0, 'auto-computed'), F('Due Date', 'date', 1), F('Payment Status', 'select', 1, ['Unpaid', 'Partially Paid', 'Paid'])] },
  'finance.collection': { title: 'Record Payment', fields: [
    F('Student', 'lookup', 1, 0, 'Student master'), F('Invoice Reference', 'lookup', 1, 0, 'Invoice master'), F('Amount Collected', 'number', 1), F('Payment Mode', 'select', 1, ['Cash', 'Card', 'UPI', 'Bank Transfer', 'Cheque']),
    F('Transaction / Reference ID', 'text', 0, 0, 'digital/bank only'), F('Receipt Number', 'auto', 1, 0, 'Auto-generated'), F('Collected By', 'select', 1, 0, 'auto-filled', 'users'),
    F('Collection Date', 'date', 1, 0, 'auto-filled'), F('Balance Remaining', 'auto', 1, 0, 'Auto-computed')] },
  'finance.plans': { title: 'Add Payment Plan', fields: [
    F('Payment Plan Name', 'text', 1), F('Applicable Course(s)', 'select', 0, 0, 'multi-select · master', 'courses'), F('Total Fee Amount', 'number', 1), F('Number of Instalments', 'number', 1),
    F('Instalment Schedule', 'table', 1, 0, 'Instalment # · Amount · Due date'), F('Late Fee Rule', 'text', 0, 0, 'amount/% + grace period'), F('Branch / Vertical Applicability', 'select', 0, 0, undefined, 'branches')] },
  'finance.scholar': { title: 'Add Scholarship', fields: [
    F('Scholarship Name', 'text', 1), F('Scholarship Type', 'select', 1, ['Merit-based', 'Need-based', 'Sibling', 'Staff Ward']), F('Eligibility Criteria', 'textarea', 1), F('Discount Value', 'number', 1, 0, '% or flat'),
    F('Applicable Course / Vertical', 'select', 1, 0, 'multi-select', 'courses'), F('Branch', 'select', 0, 0, 'multi-select', 'branches'), F('Validity From', 'date', 1), F('Validity To', 'date', 1), F('Approved By', 'select', 1, 0, 'Users', 'users')] },
  'finance.discounts': { title: 'Add Discount', fields: [
    F('Discount Name / Reason', 'text', 1), F('Discount Type', 'select', 1, ['Flat Amount', 'Percentage']), F('Discount Value', 'number', 1), F('Applicable Course / Batch', 'select', 1, 0, undefined, 'courses'),
    F('Branch / Vertical', 'auto', 1, 0, 'Auto-filled from Quotation'), F('Approval Required / Approved By', 'select', 1, 0, 'Users', 'users'), F('Validity', 'date')] },
  'finance.refunds': { title: 'Add Refund', fields: [
    F('Student', 'lookup', 1, 0, 'Student master'), F('Invoice / Payment Reference', 'lookup', 1), F('Refund Amount', 'number', 1), F('Reason for Refund', 'select', 1, ['Course Cancelled', 'Duplicate Payment', 'Dissatisfaction', 'Other']),
    F('Branch', 'auto', 1, 0, 'Auto-filled from Invoice'), F('Refund Mode', 'select', 1, ['Bank Transfer', 'Original Payment Mode', 'Cheque']), F('Approved By', 'select', 1, 0, 'Users', 'users'),
    F('Refund Date', 'date', 1), F('Status', 'select', 1, ['Requested', 'Approved', 'Processed', 'Rejected'])] },
  'hr.directory': { title: 'Add Employee', fields: [
    F('Employee Name', 'text', 1), F('Employee ID', 'auto', 1, 0, 'Auto-generated'), F('Mobile Number', 'tel', 1), F('Email', 'email', 1), F('Designation', 'select', 1, ['Counsellor', 'Trainer', 'Front Desk', 'Manager'], 'master'),
    F('Department', 'select', 1, ['Sales', 'Academics', 'Finance', 'Admin', 'Marketing']), F('Branch', 'select', 1, 0, 'master', 'branches'), F('Vertical', 'select', 0, 0, 'multi-select · filtered by Branch', 'verticals'),
    F('Reporting Manager', 'select', 0, 0, 'Employee master', 'users'), F('Date of Joining', 'date', 1), F('System Role / Access Level', 'select', 0, ['Admin', 'Branch Manager', 'Counsellor', 'Front Desk', 'Finance'], 'links to Add User'),
    F('Status', 'select', 1, ['Active', 'On Leave', 'Relieved'])] },
  'admin.branches': { title: 'Add Branch', fields: [
    F('Branch Name', 'text', 1), F('Branch Code', 'text', 1, 0, 'used in IDs / invoice #'), F('Branch Type', 'select', 0, ['Company Branch', 'Franchise Branch'], 'Franchise → links to Franchise module'), F('Address', 'textarea'),
    F('State', 'select', 0, 0, 'master', 'states'), F('City', 'select', 0, 0, 'filtered by State', 'cities'), F('Contact Number', 'tel'), F('Branch Email', 'email'),
    F('Branch Head', 'select', 0, 0, 'Employee master', 'users'),
    F('Legal Name', 'text', 0, 0, 'registered name on the GST tax invoice'),
    F('GSTIN', 'text', 0, 0, '15-char GSTIN of this branch (seller)'),
    F('PAN', 'text', 0, 0, 'branch PAN'),
    F('Status', 'select', 0, ['Active', 'Inactive'])] },
  'admin.verticals': { title: 'Add Vertical', fields: [
    F('Vertical Name', 'text', 1), F('Vertical Code', 'text', 1, 0, 'e.g. TLA'), F('Branch', 'select', 1, 0, 'master · parent link', 'branches'), F('Vertical Head', 'select', 0, 0, 'Employee master', 'users'), F('Description', 'textarea'),
    // dev/88 (client) — the vertical's billing / document identity. These feed the vertical's
    // GST invoices / receipts (seller GSTIN + legal/display name + billing address).
    F('Display Name', 'text', 0, 0, 'brand / legal name shown on invoices & receipts'),
    F('GST Number', 'text', 0, 0, '15-char GSTIN of this vertical (seller)'),
    F('Billing Address', 'textarea', 0, 0, 'printed on the vertical’s GST invoices & receipts'),
    F('Phone', 'tel', 0, 0, 'vertical contact number'),
    F('Email', 'email', 0, 0, 'vertical contact email'),
    // dev/132 ITEM B — bank accounts are now MULTIPLE (add-more rows with a required/active
    // checkbox) + UPI + QR, managed by the VerticalBanksEditor on the EDIT form. The single
    // UPI id is here so it can be set at Add time too.
    F('UPI ID', 'text', 0, 0, 'VPA for QR / UPI collections — e.g. techlingua@hdfcbank'),
    F('Status', 'select', 0, ['Active', 'Inactive'])] },
  'admin.users': { title: 'Add User', fields: [
    F('Full Name', 'text', 1, 0, 'Employee master'), F('Mobile Number', 'tel', 1, 0, 'login identifier'), F('Email ID', 'email', 0, 0, 'optional'), F('Password / Login Method', 'password', 1, 0, 'encrypted / SSO'),
    F('System Role', 'roleselect', 1, 0, 'drives permissions'), F('Branch Access', 'multipick', 0, 0, 'select branch(es)', 'branches'),
    F('Vertical Access', 'multipick', 0, 0, 'optional', 'verticals'),
    // Client (Aug 2026) — a USER's reporting manager (distinct from the task-level Report To).
    F('Reports To', 'select', 0, 0, 'reporting manager · active users', 'users'),
    F('Status', 'select', 0, ['Active', 'Deactivated'])] },
  'fran.partners': { title: 'Add Franchise Partner', fields: [
    F('Franchise ID', 'auto', 1, 0, 'Auto-generated'), F('Legal Name', 'text', 1), F('Brand Name', 'text'), F('Owner', 'text', 1), F('Mobile', 'tel', 1), F('Email', 'email'),
    F('Branch / Territory', 'text'), F('Status', 'select', 0, ['Onboarding', 'Active', 'Inactive']), F('KYC Documents', 'file')] },
  'fran.agreements': { title: 'Add Agreement', fields: [
    F('Agreement No', 'auto', 1, 0, 'Auto-generated'), F('Franchise', 'lookup', 1), F('Royalty Model', 'select', 0, ['Fixed', 'Percentage', 'Hybrid', 'Minimum']), F('Franchise Fee', 'number'),
    F('Start Date', 'date'), F('End Date', 'date'), F('Territory', 'text'), F('Signed PDF', 'file')] },
  'leads.followups': { title: 'Add Follow-up', fields: [
    F('Lead', 'leadlookup', 1, 0, 'Search lead'), F('Type', 'select', 1, 0, 'master', 'followupTypes'), F('Disposition', 'select', 0, 0, 'master', 'dispositions'),
    F('Priority', 'select', 0, ['Low', 'Medium', 'High'], 'default: Medium'),
    { ...F('Next Follow-up Date', 'datetime', 1), min: 'today' as const }, F('Remarks', 'textarea')] },
  // client update #5 — Assigned To / Report To show the logged-in user as "Myself" (top of list, default).
  // Client Aug 2026 (#2) — Branch + Vertical are first-class on a Task. They cascade via the
  // shared CASCADE (Vertical filters by Branch) and are persisted on the follow-up/task record.
  'dash.mytasks': { title: 'Add Task', fields: [
    F('Title', 'text', 1), F('Task Type', 'select', 0, 0, 'master', 'followupTypes'), F('Related Lead', 'leadlookup', 1, 0, 'Search lead'),
    F('Branch', 'select', 0, 0, 'Branch (task scope)', 'branches'),
    F('Vertical', 'select', 0, 0, 'Vertical (filtered by the Branch)', 'verticals'),
    // MY TASK overhaul (dev/133) — Related-To entity link (type + searchable record) + Task Status.
    F('Related To', 'select', 0, TASK_ENTITY_OPTS, 'link this task to a record of this type'),
    F('Related Record', 'entitylookup', 0, 0, 'search the record of the chosen type'),
    F('Task Status', 'select', 0, ['In Progress', 'On Hold', 'Completed'], 'Overdue is derived from the due date'),
    F('Assigned To', 'select', 0, 0, 'Users', 'users', 1),
    F('Report To', 'select', 0, 0, 'Users · the assignee reports progress to them', 'users', 1),
    { ...F('Due Date', 'datetime', 1), min: 'today' as const }, F('Priority', 'select', 0, ['Low', 'Medium', 'High']), F('Description', 'textarea'),
    F('Completion Remark', 'textarea', 0, 0, 'outcome captured when the task is Completed')] },
  // Support & Tickets (post-Phase-1 client request) — an INTERNAL staff ticket. Category is
  // the Ticket Category MASTER (＋Master quick-add). Branch/Vertical are SENT (they set the
  // ticket's RBAC scope) — so, unlike the lead forms where they are cascade-only, they are
  // NOT exempt in the qa10 matrix. Assignee respects the no-deactivated-user rule.
  'help.tickets': { title: 'Raise a Ticket', fields: [
    F('Subject', 'text', 1),
    { ...F('Category', 'select', 0, 0, 'master · admin-managed'), mopts: 'ticketCategories' },
    F('Priority', 'select', 1, ['Low', 'Medium', 'High', 'Urgent'], 'default: Medium', undefined, 0, 'Medium'),
    F('Branch', 'select', 0, 0, 'sets the ticket’s RBAC scope', 'branches'),
    F('Vertical', 'select', 0, 0, 'filtered by Branch', 'verticals'),
    F('Assignee', 'select', 0, 0, 'Users · active only', 'users'),
    F('Description', 'textarea')] },
  // Cross-Sell rule (post-Phase-1 client request) — the admin map "current course ->
  // suggested course". Both are id-valued Course selects (m_course); the saver sends both
  // ids, so the qa10 matrix covers every rendered field.
  'crosssell.rules': { title: 'New Cross-Sell Rule', fields: [
    F('Current Course', 'select', 1, 0, 'the course the contact already has', 'courses'),
    F('Suggest Course', 'select', 1, 0, 'the additional course to recommend', 'courses'),
    F('Note', 'text', 0, 0, 'optional — why this pairing')] },
};
SPEC_FORMS['dash.quickcontact'] = { ...SPEC_FORMS['leads.all'], title: 'Quick Add Lead' };
SPEC_FORMS['leads.branch'] = { ...SPEC_FORMS['admin.branches'] };
SPEC_FORMS['leads.vertical'] = { ...SPEC_FORMS['admin.verticals'] };
SPEC_FORMS['admin.verticalmgmt'] = { ...SPEC_FORMS['admin.verticals'] };
SPEC_FORMS['admin.pipelines'] = { ...SPEC_FORMS['leads.pipelinemaster'] };
SPEC_FORMS['admin.courseconfig'] = { ...SPEC_FORMS['students.courses'], title: 'Configure Course' };
SPEC_FORMS['leads.pipeline'] = { ...SPEC_FORMS['leads.all'] };

export const MULTI_ADD: Record<string, Array<[string, string]>> = {
  'admin.branches': [['Add Branch', 'admin.branches'], ['Add Vertical', 'admin.verticals']],
  'leads.branch': [['Add Branch', 'admin.branches'], ['Add Vertical', 'admin.verticals']],
};

/** Derive "Add X" entity name from a submenu label (ported from prototype). */
export function entFromLabel(label: string): string {
  const map: Record<string, string> = {
    'Pipeline (Kanban)': 'Lead', Kanban: 'Lead', Leads: 'Lead', 'All Leads': 'Lead', 'Lead Sources': 'Source',
    'Counsellor Performance': 'Counsellor', 'Message Templates': 'Template', 'Study Material': 'Material',
    'Student Management': 'Student', 'All Students': 'Student', 'Duplicate Rules': 'Rule',
    'SLA & TAT': 'Rule', 'Custom Fields': 'Field', 'Tests & Scores': 'Test', 'Agreements & Renewals': 'Agreement',
    'Targets & Performance': 'Target', 'Branches & Verticals': 'Branch', 'Branch Management': 'Branch',
    'Vertical Management': 'Vertical', 'Pipeline Management': 'Pipeline', Branch: 'Branch', Vertical: 'Vertical',
    Pipeline: 'Pipeline', Campaign: 'Campaign', 'Follow-ups': 'Follow-up', 'Monthly Targets': 'Target',
    'Sale Closure': 'Closure', 'Employee Directory': 'Employee',
  };
  if (map[label]) return map[label];
  let l = label.replace(/^All\s+/, '').replace(/\s*\(.*\)/, '').split('&')[0].split('·')[0].trim();
  if (/ies$/.test(l)) l = l.replace(/ies$/, 'y');
  else if (/(ches|shes|sses|xes)$/.test(l)) l = l.replace(/es$/, '');
  else if (/s$/.test(l)) l = l.replace(/s$/, '');
  return l;
}

/* ------------------------- wired save adapters ------------------------- */

type Vals = Record<string, string>;
type Ids = Record<string, number | undefined>;
/** Savers may return the created row so callers can auto-select it (e.g. ＋ Master → full course form). */
type SaveResult = string | { msg: string; row?: Named };
/** Optional side-channel so a saver can persist lead custom-field values (custom_fields JSONB). */
export type SaveExtra = { customFields?: Record<string, unknown> };

export const need = (v: string | number | undefined, msg: string) => {
  if (v === undefined || v === '' || v === null) { toast(msg, true); throw new Error(msg); }
  return v;
};

/**
 * THE SAVERS ARE THE CONTRACT. `qa10matrix.test.tsx` renders every form below, fills
 * EVERY control it renders, and proves — field by field, with a differential probe — that
 * the value reaches the request body. A field that renders but is not sent here FAILS
 * THE BUILD. That rule exists because this class of bug has reached the client THREE
 * times (DEF-2 Edit Branch · DEF-S2-02 campaign dates · DEF-S34-02 walk-in).
 */
export const SAVERS: Record<string, (vals: Vals, ids: Ids, extra?: SaveExtra) => Promise<SaveResult>> = {
  /**
   * Sprint 3 — WALK-IN. Creates a REAL lead (through the one server-side
   * LeadIngestionService) with the counsellor as its owner: "assign on add".
   *
   * DEF-S34-02: Course Fee, "How did you hear about us?" and Convert to Lead used to be
   * rendered and thrown away. They are sent now, and they have columns (migration 027).
   */
  'dash.walkins': async (vals, ids) => {
    await api.post('/walk-ins', {
      visitor_name: need(vals['Name'], 'Name is required'),
      phone: need(vals['Mobile Number'], 'Mobile Number is required'),
      alt_phone: vals['Alternate Number'] || undefined,
      whatsapp_phone: vals['WhatsApp Number'] || undefined,
      email: vals['Email ID'] || undefined,
      branch_id: need(ids['Branch'], 'Pick a Branch'),
      vertical_id: need(ids['Vertical'], 'Pick a Vertical'),
      campaign_id: need(ids['Campaign'], 'Pick a Campaign (a walk-in becomes a lead, and every lead carries the full path)'),
      source_id: need(ids['Lead Source'], 'Pick a Lead Source'),
      // Counsellor OPTIONAL (client UAT, Aug 2026); when Round-Robin is ticked the campaign
      // distribution engine assigns the owner and the counsellor can be left blank.
      counsellor_id: ids['Counsellor Assigned'] || undefined,
      round_robin: vals['Assign via Round-Robin'] === '1',
      visited_at: vals['Date & Time of Visit'] || undefined,
      purpose: vals['Purpose of Visit'] || undefined,
      course_id: ids['Course Interested'],
      course_fee: vals['Course Fee'] || undefined,
      heard_about_source_id: ids['How did you hear about us?'],
      convert_to_lead: vals['Convert to Lead'] === '1',
      remarks: vals['Remarks'] || undefined,
    });
    return vals['Convert to Lead'] === '1'
      ? 'Walk-in recorded and assigned'
      : 'Walk-in recorded (no lead created — tick "Convert to Lead" to convert it)';
  },
  /** Sprint 3 — REFERRAL. The referred person becomes a lead; the referrer is kept. */
  'dash.referrals': async (vals, ids) => {
    await api.post('/referrals', {
      referrer_type: need(vals['Referrer Type'], 'Pick a referrer type'),
      referrer_name: need(vals['Referrer Name'], 'Referrer name is required'),
      referrer_phone: vals['Referrer Contact Number'] || undefined,
      referred_name: need(vals['Referred Person Name'], 'Referred person name is required'),
      referred_phone: need(vals['Referred Person Contact Number'], 'Referred person contact number is required'),
      referred_whatsapp: vals['Referred Person WhatsApp Number'] || undefined,
      referred_email: vals['Referred Person Email'] || undefined,
      relationship: vals['Relationship to Referrer'] || undefined,
      branch_id: need(ids['Branch'], 'Pick a Branch'),
      vertical_id: need(ids['Vertical'], 'Pick a Vertical'),
      campaign_id: need(ids['Campaign'], 'Pick a Campaign (the referred person becomes a lead)'),
      owner_id: ids['Assigned Counsellor'],
      source_id: need(ids['Lead Source'], 'Pick a Lead Source'),
      course_id: ids['Course Interested'],
      incentive: vals['Incentive / Reward Applicable'] || undefined,
      status: (vals['Referral Status'] || 'Pending').toLowerCase(),
    });
    return 'Referral captured';
  },
  'leads.all': async (vals, ids, extra) => {
    // Legacy built-in custom slots (Training Mode / City / Course Fee) PLUS any admin-defined
    // custom fields the Add Lead form rendered (extra.customFields, keyed by field_key). Both
    // land in lead.custom_fields — the mapping the client asked for.
    const legacy: Record<string, unknown> = {};
    if (vals['Training Mode']) legacy.training_mode = vals['Training Mode'];
    if (vals['City / Location']) legacy.city = vals['City / Location'];
    if (vals['Course Fee']) legacy.course_fee = vals['Course Fee'];
    const custom_fields = { ...legacy, ...(extra?.customFields ?? {}) };
    await api.post('/leads', {
      full_name: need(vals['Name'], 'Name is required'),
      phone: need(vals['Mobile Number'], 'Mobile Number is required'),
      alt_phone: vals['Alternate Number'] || undefined,
      // DEF-S2-03: WhatsApp Number is stored (lead.whatsapp_phone), not discarded
      whatsapp_phone: vals['WhatsApp Number'] || undefined,
      // Sprint 4: the `birthday` journey trigger fires on this — so it must be SENT, not
      // merely rendered (qa/09).
      dob: vals['Date of Birth'] || undefined,
      email: vals['Email ID'] || undefined,
      campaign_id: need(ids['Campaign'], 'Pick a Campaign (Branch › Vertical › Pipeline › Campaign)'),
      source_id: need(ids['Lead Source'], 'Pick a Lead Source'),
      course_id: ids['Course'],
      owner_id: ids['Lead Counsellor'],
      // dev/84 item 3 — when ticked, the API ignores owner_id and the campaign round-robin
      // engine assigns the owner (same flag shape as the walk-in round-robin).
      round_robin: vals['Assign via Round-Robin'] === '1',
      status_id: ids['Lead Status'],
      next_follow_up_at: vals['Next Follow-up Date'] || undefined,
      note: vals['Remarks / Notes'] || undefined,
      custom_fields: Object.keys(custom_fields).length ? custom_fields : undefined,
    });
    return 'Lead added';
  },
  'leads.followups': async (vals, ids) => {
    await api.post('/follow-ups', {
      lead_id: need(ids['Lead'], 'Pick a lead'),
      type_id: ids['Type'],
      disposition_id: ids['Disposition'],
      priority: (vals['Priority'] || 'Medium').toLowerCase(),
      scheduled_at: need(vals['Next Follow-up Date'], 'Follow-up date is required'),
      notes: vals['Remarks'] || undefined,
    });
    return 'Follow-up scheduled';
  },
  'dash.mytasks': async (vals, ids) => {
    await api.post('/follow-ups', {
      lead_id: need(ids['Related Lead'], 'Pick the related lead'),
      type_id: ids['Task Type'],
      owner_id: ids['Assigned To'],
      report_to_id: ids['Report To'] ?? null,
      // Client Aug 2026 (#2) — Branch + Vertical persisted on the task.
      branch_id: ids['Branch'] ?? null,
      vertical_id: ids['Vertical'] ?? null,
      // MY TASK overhaul (dev/133) — Related-To entity link, task status, and kind='task' so the
      // lead-activity timeline labels it "Task" (not "Follow-up").
      entity_type: vals['Related To'] ? TASK_ENTITY_KEY[vals['Related To']] : null,
      entity_id: vals['Related To'] ? (ids['Related Record'] ?? null) : null,
      task_status: TASK_STATUS_KEY[vals['Task Status']] || 'in_progress',
      completion_note: vals['Completion Remark'] || null,
      kind: 'task',
      scheduled_at: need(vals['Due Date'], 'Due date is required'),
      priority: (vals['Priority'] || 'Medium').toLowerCase(),
      notes: [vals['Title'], vals['Description']].filter(Boolean).join(' — ') || undefined,
    });
    return 'Task created';
  },
  'admin.branches': async (vals, ids) => {
    const row = await api.post<Named>('/branches', {
      name: need(vals['Branch Name'], 'Branch name is required'),
      code: need(vals['Branch Code'], 'Branch code is required'),
      address: vals['Address'] || undefined,
      branch_type: vals['Branch Type'] || undefined,
      state_id: ids['State'] ?? undefined,
      city_id: ids['City'] ?? undefined,
      contact_number: vals['Contact Number'] || undefined,
      email: vals['Branch Email'] || undefined,
      head_user_id: ids['Branch Head'] ?? undefined,
      legal_name: vals['Legal Name'] || undefined,
      gstin: vals['GSTIN'] ? String(vals['GSTIN']).trim().toUpperCase() : undefined,
      pan: vals['PAN'] ? String(vals['PAN']).trim().toUpperCase() : undefined,
      // QA-10 sweep: the Status select on the Add form must be honoured on create
      is_active: vals['Status'] !== 'Inactive',
    });
    return { msg: 'Branch created', row };
  },
  'admin.verticals': async (vals, ids) => {
    const row = await api.post<Named>('/verticals', {
      branch_id: need(ids['Branch'], 'Pick a branch'),
      name: need(vals['Vertical Name'], 'Vertical name is required'),
      code: need(vals['Vertical Code'], 'Vertical code is required'),
      head_user_id: ids['Vertical Head'] ?? undefined,
      description: vals['Description'] || undefined,
      // dev/88 — billing / document identity + bank details.
      display_name: vals['Display Name'] || undefined,
      gstin: vals['GST Number'] ? String(vals['GST Number']).trim().toUpperCase() : undefined,
      billing_address: vals['Billing Address'] || undefined,
      phone: vals['Phone'] || undefined,
      email: vals['Email'] || undefined,
      upi_id: vals['UPI ID'] || undefined,
      is_active: vals['Status'] !== 'Inactive',
    });
    return { msg: 'Vertical created', row };
  },
  'leads.pipelinemaster': async (vals, ids) => {
    // UAT-R2 #9 — the stages the user built with "Add row" are persisted verbatim; an
    // empty editor falls back to the default stage set (backend HierarchyService.buildStageSeed).
    const stages = parseStageRows(vals['Pipeline Stages'])
      .filter((s) => s.name.trim())
      .map((s) => ({ name: s.name.trim(), stage_type: s.stage_type, is_default: !!s.is_default }));
    const row = await api.post<Named>('/pipelines', {
      vertical_id: need(ids['Vertical'], 'Pick a vertical'),
      name: need(vals['Pipeline Name'], 'Pipeline name is required'),
      code: need(vals['Pipeline Code'], 'Pipeline code is required'),
      owner_user_id: ids['Pipeline Owner'] ?? undefined,
      is_active: vals['Status'] !== 'Inactive',
      stages: stages.length ? stages : undefined,
    });
    return { msg: stages.length ? `Pipeline created with ${stages.length} stage${stages.length > 1 ? 's' : ''}` : 'Pipeline created (default stages added)', row };
  },
  'leads.sources': async (vals, ids) => {
    // UAT-R2 #4 — channel + cost_per_lead no longer collected; backend keeps its defaults.
    // UAT-R2 #17 — return the created row so a ＋ quick-add auto-selects it live.
    const row = await api.post<Named>('/sources', {
      campaign_id: ids['Campaign'] || undefined,   // OPTIONAL (item 1) — org-level source when blank
      name: need(vals['Source Name'], 'Source name is required'),
      is_active: vals['Status'] !== 'Inactive',
    });
    return { msg: 'Source connected', row };
  },
  'admin.users': async (vals, ids) => {
    const row = await api.post<Named>('/users', {
      name: need(vals['Full Name'], 'Name is required'),
      phone: need(vals['Mobile Number'], 'Mobile Number is required'),
      email: vals['Email ID'] || undefined,
      password: need(vals['Password / Login Method'], 'Password is required'),
      // MULTI-BRANCH: one user_assignment per selected branch (blank branches = one org-wide row).
      assignments: ids['System Role'] ? buildUserAssignments(ids['System Role'], parseIdCsv(vals['Branch Access']), parseVertCsv(vals['Vertical Access'])) : [],
      // Reporting manager (client, Aug 2026) — the user this person reports to.
      report_to_id: ids['Reports To'] ?? null,
      // QA-10 sweep: Status is a live select on Add User — honour it (same mapping as Edit)
      status: vals['Status'] === 'Deactivated' ? 'disabled' : 'active',
    });
    return { msg: 'User created', row };
  },
};
SAVERS['students.courses'] = async (vals, ids) => {
  const row = await api.post<Named>('/masters/course', {
    name: need(vals['Course Name'], 'Course name is required'),
    code: need(vals['Course Code'], 'Course code is required'),
    meta: {
      mode: vals['Training Mode'] || undefined,
      duration: vals['Duration'] || undefined,
      fee: vals['Standard Fee'] || undefined,
      // EXAM FEE (dev/140 item 3) — single exam fee for a course WITHOUT levels; added on top, never discounted.
      exam_fee: vals['Standard Exam Fee'] || undefined,
      branch_id: need(ids['Branch'], 'Pick a Branch'),
      vertical_id: need(ids['Vertical'], 'Pick a Vertical (filtered by the Branch)'),
      // dev/100 (client): Campaign/Pipeline are CRM-only — not sent from the ERP course form.
      eligibility: vals['Eligibility Criteria'] || undefined,
      // Course descriptors (client feedback #13) — stored in meta like fee/vertical_id. The single
      // "Course Level" descriptor is superseded by the per-level Levels editor (course_level table).
      course_type: vals['Course Type'] || undefined,
      // dev/100 (client): delivery_mode dropped from the course UI (column kept in DB, not written here).
      description: vals['Description'] || undefined,
    },
    is_active: vals['Status'] !== 'Inactive',
  });
  // Course LEVELS (enrollment re-model, batch 1) — persist the per-level fees to the course_level
  // table. A course with no levels rows keeps its single Standard Fee (meta.fee) — nothing to sync.
  const levels = levelsPayload(vals['Levels']);
  if (row?.id) { try { await api.put(`/courses/${row.id}/levels`, { levels }); } catch { /* levels re-savable from Edit */ } }
  return { msg: levels.length ? `Course "${row.name}" added with ${levels.length} level${levels.length > 1 ? 's' : ''}` : `Course "${row.name}" added to the master`, row };
};
SAVERS['admin.courseconfig'] = SAVERS['students.courses'];
SAVERS['dash.quickcontact'] = SAVERS['leads.all'];
SAVERS['leads.pipeline'] = SAVERS['leads.all'];
SAVERS['leads.branch'] = SAVERS['admin.branches'];
SAVERS['leads.vertical'] = SAVERS['admin.verticals'];
SAVERS['admin.verticalmgmt'] = SAVERS['admin.verticals'];
SAVERS['admin.pipelines'] = SAVERS['leads.pipelinemaster'];

// Support & Tickets — raise an internal ticket. Priority is normalised to the API's
// lowercase enum; Category carries the master NAME; Branch/Vertical set the RBAC scope.
SAVERS['help.tickets'] = async (vals, ids) => {
  await api.post('/support-tickets', {
    subject: need(vals['Subject'], 'A subject is required'),
    category: vals['Category'] || undefined,
    priority: (vals['Priority'] || 'Medium').toLowerCase(),
    branch_id: ids['Branch'],
    vertical_id: ids['Vertical'],
    assignee_id: ids['Assignee'],
    description: vals['Description'] || undefined,
  });
  return 'Ticket raised';
};

// Cross-Sell rule — map a current course to a suggested course. Both ids are required;
// POST /cross-sell/rules validates them and refuses a self-referential or duplicate rule.
SAVERS['crosssell.rules'] = async (vals, ids) => {
  await api.post('/cross-sell/rules', {
    source_course_id: need(ids['Current Course'], 'Pick the current course'),
    target_course_id: need(ids['Suggest Course'], 'Pick the course to suggest'),
    note: vals['Note'] || undefined,
  });
  return 'Cross-sell rule added';
};

/* ---------------------- header action resolution ----------------------
 * SINGLE SOURCE OF TRUTH for the buttons a screen's header shows and what
 * each Add/New button opens. The shell renders `headerActions(mod,sub)` and
 * routes clicks through `resolveAdd(key,label)`; the button-audit test walks
 * the same two functions, so "every add-capable screen opens a real form" is
 * proven, not asserted by hand.
 *
 * The old shell auto-injected an "Add X" onto ANY screen with a table/form
 * block or a `dyn` view, which silently put a dead Add on read-only
 * dashboards (Today's Follow-ups, Quick Stats, Fee Collection, every report)
 * that dead-ended on a placeholder toast. Auto-inject is now an explicit
 * ALLOWLIST: only these list screens (whose dyn has no add of its own and
 * whose form is wired) get a header Add. Everything else must declare its Add
 * as a real `actions` entry or render its own in-component button. */
export const ADD_INJECT: Record<string, string> = {
  'leads.vertical': 'leads.vertical',
  'leads.pipelinemaster': 'leads.pipelinemaster',
  'leads.sources': 'leads.sources',
  'admin.branches': 'admin.branches',
  'admin.verticalmgmt': 'admin.verticalmgmt',
  'admin.pipelines': 'admin.pipelines',
  'work.tasks': 'dash.mytasks',
};

export const addLike = (l: string) => /^(add|new|record|create|quick add)/i.test(l);

export type AddTarget =
  | { kind: 'campaign' } | { kind: 'roles' } | { kind: 'form'; formKey: string } | { kind: 'none' };

/** What an Add/New button opens. Never resolves to a placeholder for a wired screen. */
export function resolveAdd(key: string, label: string): AddTarget {
  if (key === 'leads.campaigns') return { kind: 'campaign' };
  if (key === 'admin.roles') return { kind: 'roles' };
  const multiKey = MULTI_ADD[key]?.find(([l]) => l === label)?.[1];
  const formKey = multiKey
    || ADD_INJECT[key]
    || (SPEC_FORMS[key] ? key : /lead/i.test(label) ? 'leads.all' : /task/i.test(label) ? 'dash.mytasks' : key);
  return SPEC_FORMS[formKey] ? { kind: 'form', formKey } : { kind: 'none' };
}

/** True when a wired SAVER (or the campaign/roles modal) backs a form key. */
export function isWiredForm(formKey: string): boolean {
  return formKey === 'leads.campaigns' || formKey === 'admin.roles' || !!SAVERS[formKey];
}

/** The header buttons a screen shows, exactly what the shell renders. */
export function headerActions(modId: string, subId: string): Array<[string, string, string?]> {
  const screen = findScreen(modId, subId);
  if (!screen) return [];
  const spec = screen.sub.spec;
  const key = `${modId}.${subId}`;
  let acts: Array<[string, string, string?]> = (spec.actions || []).slice();
  const multi = MULTI_ADD[key];
  if (multi) {
    acts = acts.filter((a) => !addLike(a[1]));
    [...multi].reverse().forEach(([label]) => acts.unshift(['plus', label, 'primary']));
  } else if (!acts.some((a) => addLike(a[1])) && ADD_INJECT[key] && spec.tag !== 'p2') {
    acts.unshift(['plus', `Add ${entFromLabel(screen.sub.label)}`, 'primary']);
  }
  return acts;
}

/* ------------------------------ inputs ------------------------------ */

export function LeadLookup({ value, onPick, inputId }: {
  value: string; onPick: (id: number | undefined, label: string) => void;
  /** so a caller's <label htmlFor> can point at the real input — a label with nothing
   *  associated is orphaned text to a screen reader (and to the test harness). */
  inputId?: string;
}) {
  const [q, setQ] = useState(value);
  const [opts, setOpts] = useState<Array<{ id: number; full_name: string; phone: string }>>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim().length < 2) { setOpts([]); return; }
      api.get<{ rows: any[] }>(`/leads?q=${encodeURIComponent(q.trim())}&limit=8`)
        .then((r) => setOpts(r.rows)).catch(() => setOpts([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div>
      <input id={inputId} className="ainp" placeholder="Search lead by name / phone…" value={q}
        onChange={(e) => { setQ(e.target.value); onPick(undefined, e.target.value); }} />
      {opts.length > 0 && (
        <div className="card" style={{ marginTop: 4, maxHeight: 150, overflowY: 'auto' }}>
          {opts.map((o) => (
            <div className="lrow" key={o.id} style={{ cursor: 'pointer', padding: '8px 12px' }}
              onClick={() => { setQ(`${o.full_name} · ${o.phone}`); setOpts([]); onPick(o.id, o.full_name); }}>
              <div className="gr"><div className="t1">{o.full_name}</div><div className="t2 mono">{o.phone}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Client Aug 2026 (#3) — Add Referral: when the referrer is an EXISTING student, search the
 * student directory (by name / phone / student id) and pick them, so the counsellor does not
 * re-type known info. Reuses the same GET /students?q= search the Student Management list uses;
 * the picked student's id is handed up so the form can auto-fill from GET /students/:id.
 */
export function StudentLookup({ onPick }: { onPick: (id: number, row: any) => void }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim().length < 2) { setOpts([]); return; }
      setBusy(true);
      // GET /students returns a BARE ARRAY (unlike /leads which returns { rows }); handle both.
      api.get<any>(`/students?q=${encodeURIComponent(q.trim())}&limit=8`)
        .then((r) => setOpts(Array.isArray(r) ? r : (r?.rows ?? []))).catch(() => setOpts([])).finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div>
      <input className="ainp" data-testid="referral-student-search"
        placeholder="Search existing student by name / phone / student id…" value={q}
        onChange={(e) => setQ(e.target.value)} />
      {busy && <div className="sub" style={{ padding: '4px 2px' }}>Searching…</div>}
      {opts.length > 0 && (
        <div className="card" style={{ marginTop: 4, maxHeight: 180, overflowY: 'auto' }}>
          {opts.map((o) => (
            <div className="lrow" key={o.id} style={{ cursor: 'pointer', padding: '8px 12px' }}
              onClick={() => { setQ(`${o.full_name} · ${o.phone ?? ''}`); setOpts([]); onPick(Number(o.id), o); }}>
              <div className="gr">
                <div className="t1">{o.full_name}</div>
                <div className="t2 mono">{[o.student_no, o.phone].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * MY TASK overhaul (dev/133) — the "Related To" record picker. A task can be linked to a
 * record of one of 13 TYPES; this searches that type via GET /follow-ups/entity-search and
 * hands the picked {id,label} up. Depends on the sibling "Related To" TYPE select (passed in
 * as `type`); disabled until a type is chosen. Mirrors the LeadLookup/StudentLookup pattern.
 */
export function EntityLookup({ type, value, onPick }: {
  type?: string; value: string; onPick: (id: number | undefined, label: string) => void;
}) {
  const key = type ? TASK_ENTITY_KEY[type] : undefined;
  const [q, setQ] = useState(value);
  const [opts, setOpts] = useState<Array<{ id: number; label: string }>>([]);
  useEffect(() => { setQ(value); }, [value]);
  useEffect(() => { setOpts([]); }, [key]);
  useEffect(() => {
    if (!key) { setOpts([]); return; }
    const t = setTimeout(() => {
      // Empty query is allowed — the endpoint returns the first matches so the user can pick
      // without typing (short lists like Trainer/Staff).
      api.get<Array<{ id: number; label: string }>>(
        `/follow-ups/entity-search?type=${encodeURIComponent(key)}&q=${encodeURIComponent(q.trim())}&limit=10`)
        .then((r) => setOpts(Array.isArray(r) ? r : [])).catch(() => setOpts([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, key]);
  return (
    <div>
      <input className="ainp" data-testid="task-entity-search"
        placeholder={key ? `Search ${type}…` : 'Pick a "Related To" type first'}
        disabled={!key} value={q}
        onChange={(e) => { setQ(e.target.value); onPick(undefined, e.target.value); }} />
      {opts.length > 0 && (
        <div className="card" style={{ marginTop: 4, maxHeight: 160, overflowY: 'auto' }}>
          {opts.map((o) => (
            <div className="lrow" key={o.id} style={{ cursor: 'pointer', padding: '8px 12px' }}
              onClick={() => { setQ(o.label); setOpts([]); onPick(o.id, o.label); }}>
              <div className="gr"><div className="t1">{o.label}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------- ＋ Master link wiring -------------------- */

/** refdata src -> generic master type key (POST /api/masters/<type>). */
const SRC_MASTER: Partial<Record<NonNullable<FormField['src']>, string>> = {
  courses: 'course', statuses: 'status', followupTypes: 'followup_type',
  dispositions: 'disposition', budgets: 'budget', states: 'state', cities: 'city',
  // "How did you hear about us?" -> the Lead Source MASTER (m_source), so ＋ Master adds
  // a new one exactly the way every other master-backed select does.
  masterSources: 'source',
};
/** mopts (string-valued master selects) -> generic master type key (POST /api/masters/<type>). */
const MOPTS_MASTER: Record<NonNullable<FormField['mopts']>, string> = {
  trainings: 'training', visitPurposes: 'visit_purpose', walkinStatuses: 'walkin_status',
  ticketCategories: 'ticket_category',
  // dev/106 — Course Type is now a self-manageable master; ＋ Master adds a new type inline.
  courseTypes: 'course_type',
};
/** Masters whose dedicated management screen has a richer form: ＋ Master opens that
 *  full form (client: adding a Course from a lead must show all course fields,
 *  not just Name/Code). Rule: ＋ Master = the master's own management-screen form. */
const SRC_MASTER_FORM: Partial<Record<NonNullable<FormField['src']>, string>> = {
  courses: 'students.courses',
};
/** Hierarchy-bound srcs open their full add-form inline instead (not generic masters). */
const SRC_FORM: Partial<Record<NonNullable<FormField['src']>, { form: string; perm: string }>> = {
  branches: { form: 'admin.branches', perm: 'branch.create' },
  verticals: { form: 'admin.verticals', perm: 'vertical.create' },
  pipelines: { form: 'leads.pipelinemaster', perm: 'pipeline.create' },
  sources: { form: 'leads.sources', perm: 'source.create' },
  users: { form: 'admin.users', perm: 'user.create' },
};

/* ---------------------------- the modal ---------------------------- */

/** Edit mode (UAT): prefill the same spec form, lock non-editable fields, submit PATCH. */
export interface EditSpec {
  title: string;
  initialVals?: Vals;
  initialIds?: Ids;
  /** field labels rendered read-only (not part of the PATCH whitelist).
   *  DEF-2: reserve this for genuinely immutable fields (hierarchy parent links).
   *  Never use it to hide a field the backend simply does not persist yet. */
  lock?: string[];
  /** labels whose "required" star is dropped in edit mode (e.g. Password = leave blank to keep) */
  optional?: string[];
  /** dev/88 — an arbitrary node rendered below the form grid (e.g. the vertical logo uploader,
   *  which needs the record id and the presigned-R2 flow that a plain field type can't do). */
  extra?: ReactNode;
  /** Course levels editor (enrollment re-model, batch 1) — the course id to fetch existing
   *  levels for on an Edit, so the repeatable Levels editor reopens fully populated. */
  levelsCourseId?: number;
  submit: (vals: Vals, ids: Ids) => Promise<string>;
}

/* ------------------------------------------------------------------ *
 * UAT-R2 #9 — Pipeline "Add row" stage editor.                        *
 * The old `table` field rendered a dead "+ Add row" label with no     *
 * handler and no state, so nothing was ever collected — the exact bug *
 * the client hit. This is a real, structured sub-editor: add / edit / *
 * reorder / delete stage rows, one default landing stage, serialised  *
 * into the field's value as JSON so the saver can persist it.         *
 * ------------------------------------------------------------------ */
export type StageRow = { id?: number; name: string; stage_type: string; is_default?: boolean; is_active?: boolean };

export function parseStageRows(v: unknown): StageRow[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const a = JSON.parse(v);
    if (!Array.isArray(a)) return [];
    return a
      .filter((x) => x && typeof x === 'object' && typeof (x as any).name === 'string')
      .map((x: any) => ({
        id: x.id != null ? Number(x.id) : undefined,
        name: String(x.name),
        stage_type: ['open', 'won', 'lost'].includes(x.stage_type) ? x.stage_type : 'open',
        is_default: x.is_default === true,
        is_active: x.is_active !== false,
      }));
  } catch { return []; }
}

/**
 * UAT-R2 #9 (Edit) — persist the stage edits made in the Add/Edit Pipeline form's stage
 * editor against the live pipeline: create new rows, patch changed ones, delete removed
 * ones (the backend 409-guards a stage that still holds leads — we surface that and keep
 * the stage), then reorder to the final sequence. Returns a human message.
 */
export async function reconcilePipelineStages(
  pipelineId: number, original: StageRow[], finalRows: StageRow[],
): Promise<string> {
  const rows = finalRows.filter((r) => r.name.trim());
  // 1) create new rows (no id) — appended, id captured for the reorder
  for (const r of rows) {
    if (r.id == null) {
      const created = await api.post<{ id: number }>(`/pipelines/${pipelineId}/stages`, {
        name: r.name.trim(), stage_type: r.stage_type, is_default: false,
      });
      r.id = Number(created.id);
    } else {
      await api.patch(`/stages/${r.id}`, {
        name: r.name.trim(), stage_type: r.stage_type, is_active: r.is_active !== false,
      });
    }
  }
  // 2) exactly one default landing stage
  const def = rows.find((r) => r.is_default) ?? rows[0];
  if (def?.id != null) await api.patch(`/stages/${def.id}`, { is_default: true });
  // 3) delete rows the user removed (guard: a stage with leads stays, with a notice)
  const keep = new Set(rows.map((r) => r.id));
  const blocked: number[] = [];
  const warnings: string[] = [];
  for (const o of original) {
    if (o.id != null && !keep.has(o.id)) {
      try { await api.del(`/stages/${o.id}`); }
      catch (e: any) { blocked.push(o.id); warnings.push(e?.message || `Could not delete "${o.name}"`); }
    }
  }
  // 4) reorder to the final sequence (blocked-delete stages retained at the end)
  const order = [...rows.map((r) => r.id), ...blocked].filter((x): x is number => x != null);
  if (order.length) await api.put(`/pipelines/${pipelineId}/stages/order`, { order });
  if (warnings.length) throw new Error(warnings.join(' '));
  return `Pipeline updated (${rows.length} stage${rows.length === 1 ? '' : 's'})`;
}

function StageTableField({ value, disabled, onChange }: {
  value: string; disabled?: boolean; onChange: (json: string) => void;
}) {
  const [rows, setRows] = useState<StageRow[]>(() => parseStageRows(value));
  const commit = (next: StageRow[]) => { setRows(next); onChange(JSON.stringify(next)); };
  const add = () => commit([...rows, { name: '', stage_type: 'open', is_default: rows.length === 0, is_active: true }]);
  const setName = (i: number, name: string) => commit(rows.map((r, j) => (j === i ? { ...r, name } : r)));
  const setType = (i: number, stage_type: string) => commit(rows.map((r, j) => (j === i ? { ...r, stage_type } : r)));
  const setDefault = (i: number) => commit(rows.map((r, j) => ({ ...r, is_default: j === i })));
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    if (next.length && !next.some((r) => r.is_default)) next[0] = { ...next[0], is_default: true };
    commit(next);
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const n = [...rows]; [n[i], n[j]] = [n[j], n[i]]; commit(n);
  };
  return (
    <div className="sc-rows" data-stage-editor>
      {rows.length === 0 && (
        <div className="empty-note" style={{ padding: '6px 2px', textAlign: 'left' }}>
          No stages added — click <b>＋ Add row</b> to build this pipeline's stages, or leave empty to seed the default set.
        </div>
      )}
      {rows.map((r, i) => (
        <div className="sc-row" key={i}>
          <span className="sc-row-ord">{i + 1}</span>
          <input className="ainp" placeholder="Stage name (e.g. Contacted)" value={r.name} disabled={disabled}
            onChange={(e) => setName(i, e.target.value)} />
          <select className="ainp sc-row-type" value={r.stage_type} disabled={disabled}
            onChange={(e) => setType(i, e.target.value)}>
            <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option>
          </select>
          <label className="sc-row-def" title="Default landing stage — new leads start here">
            <input type="radio" name="stage-default-row" checked={!!r.is_default} disabled={disabled}
              onChange={() => setDefault(i)} />Default
          </label>
          <span className="sc-row-mv">
            <button type="button" className="sc-row-btn" title="Move up" disabled={disabled || i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="sc-row-btn" title="Move down" disabled={disabled || i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="sc-row-btn danger" title="Remove stage" disabled={disabled} onClick={() => remove(i)}><Ic k="x" w={2.6} /></button>
          </span>
        </div>
      ))}
      {!disabled && (
        <button type="button" className="sc-addrow" onClick={add}><Ic k="plus" w={2.6} />Add row</button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * COURSE LEVELS (enrollment re-model, batch 1).                       *
 * A course can have MANY levels (A1, A2, … from the course_level_def  *
 * catalog), each with its OWN fee (and an optional per-level          *
 * duration). This is the repeatable sub-editor that replaces the old  *
 * single "Course Level" descriptor: one row per level (level picker + *
 * fee), a "＋ Add level" button and a remove-row. Serialised into the *
 * field value as JSON; the saver PUTs it to /courses/:id/levels after *
 * the course is created/updated. A course with NO levels keeps its    *
 * single Standard Fee (meta.fee) — backward compatible.               *
 * ------------------------------------------------------------------ */
export type LevelRow = { code: string; label?: string; fee: string; exam?: string; duration?: string };

/** Parse the field value (JSON string) into level rows. `fee` is kept as a rupee string. */
export function parseLevelRows(v: unknown): LevelRow[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const a = JSON.parse(v);
    if (!Array.isArray(a)) return [];
    return a.filter((x) => x && typeof x === 'object').map((x: any) => ({
      code: String(x.code ?? x.label ?? ''),
      label: x.label != null ? String(x.label) : undefined,
      fee: x.fee != null && x.fee !== '' ? String(x.fee)
        : (x.fee_minor != null ? String(Number(x.fee_minor) / 100) : ''),
      // EXAM FEE (dev/140 item 3) — per-level, kept as a rupee string; added on top, never discounted.
      exam: x.exam != null && x.exam !== '' ? String(x.exam)
        : (x.exam_fee_minor != null ? String(Number(x.exam_fee_minor) / 100) : ''),
      duration: x.duration != null ? String(x.duration) : undefined,
    }));
  } catch { return []; }
}

/** The API payload (rupee fee → the API converts to paise) for PUT /courses/:id/levels. */
export function levelsPayload(v?: string): Array<{ code: string; label?: string; fee: string; exam_fee?: string; duration?: string; ordering: number }> {
  return parseLevelRows(v).filter((r) => r.code.trim()).map((r, i) => ({
    code: r.code.trim(),
    label: r.label && r.label.trim() ? r.label.trim() : undefined,
    fee: r.fee ?? '',
    // EXAM FEE (dev/140 item 3) — the API accepts exam_fee (rupees) alongside fee.
    exam_fee: r.exam != null && String(r.exam).trim() !== '' ? String(r.exam).trim() : undefined,
    duration: r.duration && r.duration.trim() ? r.duration.trim() : undefined,
    ordering: i,
  }));
}

function LevelsField({ value, courseId, onChange }: {
  value: string; courseId?: number; onChange: (json: string) => void;
}) {
  const ref = useRef_();
  const levelOpts = (ref.courseLevels?.length ? ref.courseLevels : COURSE_LEVELS.map((c) => ({ id: c, name: c })));
  const [rows, setRows] = useState<LevelRow[]>(() => parseLevelRows(value));
  const [loaded, setLoaded] = useState(!courseId);
  // Edit — fetch the course's stored levels once, so the editor reopens fully populated.
  useEffect(() => {
    if (!courseId || loaded) return;
    let dead = false;
    (async () => {
      try {
        const got = await api.get<any[]>(`/courses/${courseId}/levels`);
        if (dead) return;
        const mapped = (got ?? []).map((r) => ({
          code: String(r.code), label: r.label ?? undefined,
          fee: r.fee_minor != null ? String(Number(r.fee_minor) / 100) : '',
          exam: r.exam_fee_minor != null && Number(r.exam_fee_minor) > 0 ? String(Number(r.exam_fee_minor) / 100) : '',
          duration: r.duration ?? undefined,
        }));
        setRows(mapped); onChange(JSON.stringify(mapped));
      } catch { /* leave empty on error */ }
      finally { if (!dead) setLoaded(true); }
    })();
    return () => { dead = true; };
  }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: LevelRow[]) => { setRows(next); onChange(JSON.stringify(next)); };
  const add = () => commit([...rows, { code: '', fee: '' }]);
  const setCode = (i: number, code: string) => commit(rows.map((r, j) => (j === i ? { ...r, code } : r)));
  const setFee = (i: number, fee: string) => commit(rows.map((r, j) => (j === i ? { ...r, fee } : r)));
  const setExam = (i: number, exam: string) => commit(rows.map((r, j) => (j === i ? { ...r, exam } : r)));
  const remove = (i: number) => commit(rows.filter((_, j) => j !== i));
  return (
    <div className="sc-rows" data-levels-editor>
      {/* dev/114 — Level is a self-manageable master (m_level). The picker below offers the
          master's codes (RefData.courseLevels, via /courses/level-catalog); ＋ Master adds a new
          level code to the master and it becomes selectable immediately (RefData reloads). */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2 }}>
        <MasterQuickAdd type="level" />
      </div>
      {rows.length === 0 && (
        <div className="empty-note" style={{ padding: '6px 2px', textAlign: 'left' }}>
          No levels — click <b>＋ Add level</b> to add levels (e.g. A1, A2, …), each with its own fee.
          Leave empty to use the single <b>Standard Fee</b> below.
        </div>
      )}
      {rows.map((r, i) => (
        <div className="sc-row" key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="sc-row-ord">{i + 1}</span>
          <select className="ainp" data-testid={`level-code-${i}`} value={r.code} style={{ flex: '1 1 40%' }}
            onChange={(e) => setCode(i, e.target.value)}>
            <option value="">Level…</option>
            {levelOpts.map((o: any) => <option key={String(o.id)} value={String(o.name)}>{o.name}</option>)}
          </select>
          <input className="ainp" type="number" min="0" placeholder="Fee (₹)" data-testid={`level-fee-${i}`}
            value={r.fee} style={{ flex: '1 1 30%' }} onChange={(e) => setFee(i, e.target.value)} />
          <input className="ainp" type="number" min="0" placeholder="Exam fee (₹)" title="Exam fee — added on top, never discounted" data-testid={`level-exam-${i}`}
            value={r.exam ?? ''} style={{ flex: '1 1 30%' }} onChange={(e) => setExam(i, e.target.value)} />
          <button type="button" className="sc-row-btn danger" title="Remove level"
            data-testid={`level-remove-${i}`} onClick={() => remove(i)}><Ic k="x" w={2.6} /></button>
        </div>
      ))}
      <button type="button" className="sc-addrow" data-testid="level-add" onClick={add}>
        <Ic k="plus" w={2.6} />Add level
      </button>
    </div>
  );
}

const LEAD_ADD_FORMS = new Set(['leads.all', 'dash.quickcontact', 'leads.pipeline']);
/** The lead Add forms whose custom fields should render + persist into lead.custom_fields. */
export const isLeadAddForm = (k: string) => LEAD_ADD_FORMS.has(k);

/** A custom-field DEFINITION → a renderable FormField (its value maps back via `cfKey`). */
export function cfToFormField(d: CfDef): FormField {
  const type = d.data_type === 'bool' ? 'checkbox'
    : d.data_type === 'number' ? 'number'
    : d.data_type === 'date' ? 'date'
    : (d.data_type === 'select' || d.data_type === 'multiselect') ? 'select'
    : 'text';
  return {
    label: d.label, type, req: !!d.required,
    opts: (d.data_type === 'select' || d.data_type === 'multiselect') ? (d.options ?? []) : null,
    hint: '', cfKey: d.field_key,
  };
}

export function AddModal({ formKey, onClose, onSaved, onSavedRow, edit }: {
  formKey: string; onClose: () => void; onSaved?: () => void;
  /** Fires with the created row (when the saver returns one) so the opener can auto-select it. */
  onSavedRow?: (row: Named) => void; edit?: EditSpec;
}) {
  const ref = useRef_();
  const { can, me } = useAuth();
  const spec = SPEC_FORMS[formKey];
  const wired = !!SAVERS[formKey] || !!edit;
  // Spec defaults apply on ADD only — an edit prefill is the record, and always wins.
  // (This is how "Convert to Lead" ships ticked without a special case in the modal.)
  const [vals, setVals] = useState<Vals>(() => {
    if (edit?.initialVals) return edit.initialVals;
    const seed: Vals = {};
    for (const f of SPEC_FORMS[formKey]?.fields ?? []) if (f.def !== undefined) seed[f.label] = f.def;
    return seed;
  });
  const [ids, setIds] = useState<Ids>(edit?.initialIds ?? {});
  const [masterAdd, setMasterAdd] = useState<{ type: string; field: string } | null>(null);
  const [masterForm, setMasterForm] = useState<{ form: string; field: string } | null>(null);
  const [subForm, setSubForm] = useState<{ form: string; field: string } | null>(null);
  // ＋ Add Branch / ＋ Add Vertical quick-add beside Branch Access (opens the real create form).
  const [accessAdd, setAccessAdd] = useState<{ form: string } | null>(null);
  const [subCampaign, setSubCampaign] = useState(false);
  const [extras, setExtras] = useState<Record<string, Named[]>>({});
  const [roles, setRoles] = useState<Named[]>([]);
  const [busy, setBusy] = useState(false);
  // Custom fields (client, Aug 2026): the admin-defined lead fields render on the Add Lead form
  // and their values persist into lead.custom_fields. Add-form only; the lead Edit is the sheet.
  const leadForm = isLeadAddForm(formKey) && !edit;
  const [cfDefs, setCfDefs] = useState<CfDef[]>([]);
  const needsRoles = useMemo(() => spec?.fields.some((f) => f.type === 'roleselect'), [spec]);

  useEffect(() => {
    if (needsRoles) api.get<Named[]>('/roles').then(setRoles).catch(() => setRoles([]));
  }, [needsRoles]);

  // client update #5 — preselect "Myself" on self-aware user selects (Task module).
  const uid = me?.user?.id;
  useEffect(() => {
    if (!spec || !uid || edit) return; // add-form only — never touch an edit prefill
    const selfFields = spec.fields.filter((f) => f.self && f.src === 'users');
    if (!selfFields.length) return;
    setVals((v) => {
      const next = { ...v };
      for (const f of selfFields) if (next[f.label] === undefined) next[f.label] = SELF_LABEL;
      return next;
    });
    setIds((x) => {
      const next = { ...x };
      for (const f of selfFields) if (next[f.label] === undefined) next[f.label] = Number(uid);
      return next;
    });
  }, [formKey, uid]);

  useEffect(() => {
    if (!leadForm) { setCfDefs([]); return; }
    let live = true;
    fetchLeadCfDefs().then((d) => { if (live) setCfDefs(d); });
    return () => { live = false; };
  }, [leadForm]);

  // Dynamic custom-field inputs appended to the lead form (skip any whose label collides with a
  // standard field so a custom "Course Fee" can never shadow the built-in one).
  const cfFields: FormField[] = useMemo(() => {
    if (!leadForm || !spec) return [];
    const existing = new Set(spec.fields.map((f) => f.label));
    return cfDefs.filter((d) => !existing.has(d.label)).map(cfToFormField);
  }, [leadForm, cfDefs, spec]);

  if (!spec) return null;

  /** Is `label` a real parent <select> on THIS form? (Not an 'auto' display field.) */
  const cascadeParent = (label: string) =>
    spec.fields.some((x) => x.label === label && !!x.src && (x.type === 'select' || x.type === 'multiselect'));

  /** UAT-R3b #16 — a Course field is GATED only on forms that carry BOTH a real Branch AND a
   *  real Vertical <select> (Add Lead, Quick Add, Walk-in, Referral). Forms whose Branch/Vertical
   *  are 'auto' (Admission, Quotation, Enrolment) are never gated. */
  const courseGated = () => cascadeParent('Branch') && cascadeParent('Vertical');

  const srcOptions = (f: FormField): Named[] => {
    let list: Named[] = (ref as any)[f.src!] ?? [];
    // DEF-1: never offer a deactivated user — but keep the one already selected (edit/prefill).
    if (f.src === 'users') list = selectableUsers(list, ids[f.label] ?? null);
    // Role-restricted user picker (e.g. batch Trainer/Faculty → Trainer role only). The scoped
    // /users list already carries `role_names` (comma-joined), so this stays branch/vertical-scoped.
    // A value already stored on the record (edit prefill) is kept even if that user isn't a Trainer
    // any more, so an existing batch's assigned trainer never drops out of the dropdown.
    if (f.src === 'users' && f.role) {
      const want = f.role.trim().toLowerCase();
      const keep = ids[f.label] ?? null;
      const holdsRole = (u: Named) => String((u as any).role_names ?? '')
        .split(',').map((r) => r.trim().toLowerCase()).includes(want);
      list = list.filter((u) => holdsRole(u) || (keep != null && Number(u.id) === Number(keep)));
    }
    // cascade by parent selection where the hierarchy applies. A child is filtered to its
    // parent's choice; where the parent select is present on THIS form but not yet chosen,
    // the child is EMPTY (you can't pick a Vertical before its Branch). Forms that carry a
    // child without its parent select (e.g. Admission, whose Branch is auto-filled) keep the
    // full list, exactly as before.
    for (const cc of CASCADE) {
      if (f.src !== cc.src) continue;
      const pid = ids[cc.parent];
      if (pid != null) list = list.filter((o) => Number((o as any)[cc.fk]) === Number(pid));
      else if (cc.strict && cascadeParent(cc.parent)) list = [];
    }
    // UAT-R2 #16 — a Course belongs to ONE Branch → ONE Vertical (update #7 stored
    // meta.branch_id / meta.vertical_id). On any form that carries a Branch and/or Vertical
    // selection, offer ONLY the courses whose Branch+Vertical match — in Leads and Walk-in
    // exactly, and harmlessly elsewhere (an 'auto' Branch/Vertical sets no id, so the list
    // stays full, as before).
    if (f.src === 'courses') {
      const bid = ids['Branch']; const vid = ids['Vertical'];
      // UAT-R3b #16 — GATE the Course dropdown on Branch + Vertical. On a gated form the Course
      // list is EMPTY until BOTH are chosen (the renderer then shows "choose Branch and Vertical
      // first"); once both are set, only that Branch+Vertical's courses show. Ungated forms keep
      // the old harmless filter-when-set behaviour.
      if (courseGated()) {
        if (bid == null || vid == null) return [];
        list = list.filter((o) => Number((o as any).meta?.branch_id) === Number(bid)
                                && Number((o as any).meta?.vertical_id) === Number(vid));
      } else {
        if (bid != null) list = list.filter((o) => Number((o as any).meta?.branch_id) === Number(bid));
        if (vid != null) list = list.filter((o) => Number((o as any).meta?.vertical_id) === Number(vid));
      }
    }
    const fresh = (extras[f.label] ?? []).filter((e) => !list.some((o) => Number(o.id) === Number(e.id)));
    let out = [...list, ...fresh];
    // client update #5 — Task module: the logged-in user shows as "Myself", pinned first.
    if (f.self && f.src === 'users' && me?.user?.id) {
      const uid = Number(me.user.id);
      out = [{ id: uid, name: SELF_LABEL } as Named, ...out.filter((o) => Number(o.id) !== uid)];
    }
    return out;
  };

  // Changing a parent RESETS every descendant select, so a stale child id (a Vertical left
  // over from another Branch) can never be submitted. Walks the CASCADE transitively:
  // Branch → Vertical → Pipeline → Campaign → Lead Source.
  const setField = (label: string, value: string, id?: number) => {
    const clear: string[] = [];
    const walk = (parent: string) => {
      for (const cf of spec.fields) {
        if (!cf.src || clear.includes(cf.label)) continue;
        if (CASCADE.some((cc) => cc.src === cf.src && cc.parent === parent)) { clear.push(cf.label); walk(cf.label); }
      }
    };
    walk(label);
    // UAT-R3b #16 — Course is gated on Branch + Vertical but is NOT part of the CASCADE chain,
    // so reset any Course select when either changes (a stale course from another Branch/Vertical
    // must never survive to submit).
    if (label === 'Branch' || label === 'Vertical') {
      for (const cf of spec.fields) if (cf.src === 'courses' && !clear.includes(cf.label)) clear.push(cf.label);
    }
    // MY TASK overhaul (dev/133) — changing the Related-To TYPE clears the picked record.
    if (label === 'Related To' && !clear.includes('Related Record')) clear.push('Related Record');
    setVals((x) => { const n = { ...x, [label]: value }; for (const k of clear) delete n[k]; return n; });
    setIds((x) => { const n = { ...x, [label]: id }; for (const k of clear) delete n[k]; return n; });
  };

  const save = async () => {
    if (!wired) {
      toast("This form's design is final; its data entry activates with the module backend in a later project phase — nothing was saved.");
      onClose();
      return;
    }
    let extra: SaveExtra | undefined;
    if (leadForm) {
      const specLabels = new Set(spec.fields.map((f) => f.label));
      const activeCf = cfDefs.filter((d) => !specLabels.has(d.label));
      for (const d of activeCf) {
        const raw = vals[d.label];
        const missing = d.data_type === 'bool' ? raw !== '1' : (raw === undefined || raw === '');
        if (d.required && missing) { toast(`${d.label} is required`, true); return; }
      }
      extra = { customFields: collectCf(activeCf, (key) => {
        const def = activeCf.find((x) => x.field_key === key);
        return def ? vals[def.label] : undefined;
      }) };
    }
    setBusy(true);
    try {
      const res = await (edit ? edit.submit(vals, ids) : SAVERS[formKey](vals, ids, extra));
      toast(typeof res === 'string' ? res : res.msg);
      if (typeof res !== 'string' && res.row) onSavedRow?.(res.row);
      onSaved?.();
      onClose();
    } catch (e: any) {
      if (e?.message && !String(e.message).includes('required') && !String(e.message).includes('Pick')) toast(e.message, true);
    } finally { setBusy(false); }
  };

  const input = (f: FormField) => {
    const t = f.type || 'text';
    const v = vals[f.label] ?? '';
    if (edit?.lock?.includes(f.label)) {
      return (
        <div className="ainp" style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-dim)', background: 'var(--surface-3)' }}
          title="Read-only — derived from the parent record">
          <Ic k="lock" w={2} /><span>{v || '—'}</span>
        </div>
      );
    }
    // UAT-R2 — a STRING-valued select whose options come from a master (RefData) list,
    // plus any value just quick-added via ＋ Master. Stores the NAME (text), not an id.
    if (t === 'select' && f.mopts) {
      const base: Named[] = (ref as any)[f.mopts] ?? [];
      const fresh = (extras[f.label] ?? []).filter((e) => !base.some((o) => o.name === e.name));
      const list = [...base, ...fresh];
      return (
        <select className="ainp" value={v} onChange={(e) => setField(f.label, e.target.value)}>
          <option value="">Select…</option>
          {list.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
        </select>
      );
    }
    if (t === 'select' && f.src) {
      const list = srcOptions(f);
      // Branch › Vertical (and the rest of the chain): the child is disabled with a "pick
      // the parent first" hint until its parent select carries a value.
      const parentCfg = CASCADE.find((cc) => cc.src === f.src && cc.strict && cascadeParent(cc.parent));
      // UAT-R3b #16 — Course gating: empty + a message until BOTH Branch and Vertical are chosen,
      // then "No courses for this Branch & Vertical" if none match.
      const courseGate = f.src === 'courses' && courseGated();
      const coursePick = courseGate && (ids['Branch'] == null || ids['Vertical'] == null);
      const courseNone = courseGate && !coursePick && list.length === 0;
      const blocked = (!!parentCfg && ids[parentCfg.parent] == null) || coursePick;
      // client update #3 — course fee auto-fetch from the Course master (meta.fee)
      const courseFee = f.src === 'courses' && ids[f.label]
        ? (list.find((o) => Number(o.id) === Number(ids[f.label])) as any)?.meta?.fee
        : undefined;
      return (
        <>
          <select className="ainp" disabled={blocked} value={ids[f.label] ?? ''}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : undefined;
              const nm = list.find((o) => Number(o.id) === id)?.name ?? '';
              setField(f.label, nm, id);
              if (f.src === 'courses') {
                const fee = (list.find((o) => Number(o.id) === id) as any)?.meta?.fee;
                const feeField = spec.fields.find((x) => /course fee|standard fee/i.test(x.label));
                if (fee != null && fee !== '' && feeField) {
                  setVals((x) => ({ ...x, [feeField.label]: String(fee) })); // pre-fill, stays editable
                }
              }
            }}>
            <option value="">{coursePick ? 'Please choose Branch and Vertical first'
              : courseNone ? 'No courses for this Branch & Vertical'
              : (blocked && parentCfg) ? `Select ${parentCfg.parent} first…`
              : 'Select…'}</option>
            {list.map((o) => <option key={o.id} value={o.id}>{o.name}{o.branch_name ? ` · ${o.branch_name}` : ''}</option>)}
          </select>
          {coursePick && <div className="fhint" style={{ marginTop: 4, display: 'block' }}>Please choose Branch and Vertical first</div>}
          {courseNone && <div className="fhint" style={{ marginTop: 4, display: 'block', color: 'var(--danger)' }}>No courses for this Branch &amp; Vertical</div>}
          {courseFee != null && courseFee !== '' && (
            <div className="fhint" style={{ marginTop: 4, display: 'block', color: 'var(--success)' }}>
              Course fee: ₹{courseFee} (auto-fetched from Course master)
            </div>
          )}
        </>
      );
    }
    if (t === 'roleselect') {
      return (
        <select className="ainp" value={ids[f.label] ?? ''}
          onChange={(e) => setField(f.label, '', e.target.value ? Number(e.target.value) : undefined)}>
          <option value="">Select…</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      );
    }
    // Multi-branch / multi-vertical access — the SAME searchable multi-select the
    // campaign agent pool uses (UserPicker in generic option mode), fed from RefData.
    // Selections ride in `vals` as CSV (see parseIdCsv / parseVertCsv).
    if (t === 'multipick' && f.src === 'branches') {
      const selected = parseIdCsv(v);
      const opts = ((ref as any).branches as Named[] ?? []).map((b) => ({ id: Number(b.id), name: b.name }));
      return (
        <UserPicker options={opts} value={selected} hideBranch
          placeholder="Select branch(es)…"
          onChange={(arr) => setVals((x) => {
            const kept = parseVertCsv(x['Vertical Access']).filter((z) => arr.includes(z.b)); // drop verticals of un-ticked branches
            return { ...x, 'Branch Access': arr.join(','), 'Vertical Access': kept.map((z) => `${z.v}:${z.b}`).join(',') };
          })} />
      );
    }
    if (t === 'multipick' && f.src === 'verticals') {
      const bids = parseIdCsv(vals['Branch Access']);
      const all = (ref as any).verticals as Named[] ?? [];
      // Client (Aug 2026): show each vertical as its "Branch → Vertical" path so the admin can
      // tell same-named verticals apart and see the parent branch. branch_name rides on the
      // vertical RefData row; fall back to joining the branch name from the branches RefData.
      const branchName = new Map(((ref as any).branches as Named[] ?? []).map((b) => [Number(b.id), b.name]));
      const opts = all.filter((vt) => bids.includes(Number((vt as any).branch_id))).map((vt) => {
        const bn = (vt as any).branch_name || branchName.get(Number((vt as any).branch_id));
        return { id: Number(vt.id), name: bn ? `${bn} → ${vt.name}` : vt.name };
      });
      const vb = new Map(all.map((vt) => [Number(vt.id), Number((vt as any).branch_id)]));
      const selected = parseVertCsv(v).map((z) => z.v);
      const blocked = bids.length === 0;
      return (
        <UserPicker options={opts} value={selected} disabled={blocked} hideBranch
          placeholder={blocked ? 'Select access first…' : 'Tick verticals to narrow access…'}
          onChange={(arr) => setVals((x) => ({ ...x, [f.label]: arr.map((vid) => `${vid}:${vb.get(Number(vid)) ?? ''}`).join(',') }))} />
      );
    }
    if (t === 'select' || t === 'multiselect' || t === 'multipick') {
      return (
        <select className="ainp" value={v} onChange={(e) => setField(f.label, e.target.value)}>
          <option value="">Select…</option>
          {(f.opts || []).map((o) => <option key={o}>{o}</option>)}
        </select>
      );
    }
    if (t === 'leadlookup') return <LeadLookup value={v} onPick={(id, label) => setField(f.label, label, id)} />;
    // MY TASK overhaul (dev/133) — Related-To record picker, driven by the sibling 'Related To' type.
    if (t === 'entitylookup') return <EntityLookup type={vals['Related To']} value={v} onPick={(id, label) => setField(f.label, label, id)} />;
    if (t === 'studentlookup') return (
      <StudentLookup onPick={async (id, row) => {
        // Optimistic fill from the search row, then reconcile with the authoritative record.
        const apply = (s: any) => {
          // Order matters: Branch first (clears Vertical/Course), then Vertical (clears Course),
          // then Course, then the plain text fields — so the cascade never wipes a value we set.
          if (s.branch_id != null) setField('Branch', s.branch_name ?? '', Number(s.branch_id));
          if (s.vertical_id != null) setField('Vertical', s.vertical_name ?? '', Number(s.vertical_id));
          if (s.course_id != null) setField('Course Interested', s.course_name ?? '', Number(s.course_id));
          if (s.full_name) setField('Referrer Name', String(s.full_name));
          if (s.phone) setField('Referrer Contact Number', String(s.phone));
        };
        apply(row);
        try { const full = await api.get<any>(`/students/${id}`); apply(full); } catch { /* keep the row fill */ }
      }} />
    );
    if (t === 'date') return <input className="ainp" type="date" value={v} onChange={(e) => setField(f.label, e.target.value)} />;
    if (t === 'datetime') {
      // #19 — min='today' blocks a past Date of Visit in the picker (server also validates).
      const min = f.min === 'today' ? `${new Date().toLocaleDateString('en-CA')}T00:00` : undefined;
      return <input className="ainp" type="datetime-local" min={min} value={v} onChange={(e) => setField(f.label, e.target.value)} />;
    }
    if (t === 'number') return <input className="ainp" type="number" placeholder="0" value={v} onChange={(e) => setField(f.label, e.target.value)} />;
    if (t === 'password') return <input className="ainp" type="password" value={v} onChange={(e) => setField(f.label, e.target.value)} />;
    if (t === 'tel') {
      const isWa = /whatsapp/i.test(f.label);
      // client update #2 — country-code selector on every phone field (default +91)
      return (
        <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <PhoneInput value={v} onChange={(nv) => setField(f.label, nv)} placeholder={f.label} />
          </div>
          <button className={`verify ${isWa ? 'wa' : ''}`} title="Verify" style={{ position: 'static', flex: '0 0 auto', alignSelf: 'center' }}
            onClick={(e) => { e.preventDefault(); toast(`${isWa ? 'WhatsApp' : 'Number'} numbers are format-checked automatically (country code + length).`); }}>
            <Ic k={isWa ? 'wa' : 'check'} w={isWa ? 2 : 2.6} />
          </button>
        </div>
      );
    }
    if (t === 'email') return <input className="ainp" type="email" placeholder="name@email.com" value={v} onChange={(e) => setField(f.label, e.target.value)} />;
    if (t === 'textarea') return <textarea className="ainp" value={v} onChange={(e) => setField(f.label, e.target.value)} />;
    if (t === 'file') return <input className="ainp" type="file" style={{ padding: '7px 10px' }} />;
    if (t === 'checkbox') return (
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: 'var(--text-muted)', padding: '5px 0' }}>
        <input type="checkbox" aria-label={f.label} style={{ accentColor: 'var(--primary)', width: 16, height: 16 }}
          checked={v === '1'} onChange={(e) => setField(f.label, e.target.checked ? '1' : '')} />
        {f.hint || f.label}
      </label>
    );
    if (t === 'lookup') return (
      <div className="ainp" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, color: 'var(--text-dim)' }}>
        <span>{f.hint || 'Search…'}</span><Ic k="search" />
      </div>
    );
    if (t === 'auto') return (
      <div className="ainp" style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-dim)', background: 'var(--surface-3)' }}>
        <Ic k="bolt" /><span>{f.hint || 'Auto-generated'}</span>
      </div>
    );
    if (t === 'table') return (
      <StageTableField value={v} disabled={!!edit?.lock?.includes(f.label)}
        onChange={(json) => setField(f.label, json)} />
    );
    // Course Levels — repeatable per-level fee editor (enrollment re-model, batch 1).
    if (t === 'levels') return (
      <LevelsField value={v} courseId={edit?.levelsCourseId}
        onChange={(json) => setField(f.label, json)} />
    );
    return <input className="ainp" type="text" value={v} onChange={(e) => setField(f.label, e.target.value)} />;
  };

  const isMaster = (f: FormField) => (f.type === 'select' || f.type === 'multiselect') &&
    (!!f.mopts || /master/i.test(f.hint || '') || /\b(course|vertical|pipeline|campaign|branch|source|stage|status|tag|batch|payment plan|payment terms|qualification|budget|designation|department|training mode)\b/i.test(f.label));

  /** ＋ Master → inline add modal. Rule: opens the same form as the master's own
   *  management screen — rich masters (Course) open their full spec form, generic
   *  masters open <AddMasterModal>, hierarchy fields open their full add-form;
   *  all hidden without the create permission. */
  const masterLink = (f: FormField) => {
    if (f.cfKey) return null; // custom fields never carry a ＋ Master link
    if (!isMaster(f)) return null;
    if (edit?.lock?.includes(f.label)) return null;
    const mt = (f.src ? SRC_MASTER[f.src] : undefined) ?? (f.mopts ? MOPTS_MASTER[f.mopts] : undefined);
    const mf = f.src ? SRC_MASTER_FORM[f.src] : undefined;
    const hf = f.src ? SRC_FORM[f.src] : undefined;
    const isCamp = f.src === 'campaigns';
    if (mt && !can('master.create')) return null;
    if (hf && !can(hf.perm)) return null;
    if (isCamp && !can('campaign.create')) return null;
    return (
      <a className="mlink" onClick={(e) => {
        e.preventDefault();
        if (mf) setMasterForm({ form: mf, field: f.label }); // full management-screen form
        else if (mt) setMasterAdd({ type: mt, field: f.label });
        else if (isCamp) setSubCampaign(true);
        else if (hf) setSubForm({ form: hf.form, field: f.label });
        else toast('Manage master lists under Administration › Settings');
      }}>＋ Master</a>
    );
  };

  /** ＋ Add Branch / ＋ Add Vertical shortcuts beside Branch Access — open the real
   *  create forms and inject the new row into the access pickers (reuses the master-add
   *  pattern; multipick-aware so the value rides the CSV, not a single select). */
  const accessLinks = (f: FormField) => {
    if (f.type !== 'multipick' || f.src !== 'branches') return null;
    return (
      <>
        {can('branch.create') && <a className="mlink" onClick={(e) => { e.preventDefault(); setAccessAdd({ form: 'admin.branches' }); }}>＋ Add Branch</a>}
        {can('vertical.create') && <a className="mlink" onClick={(e) => { e.preventDefault(); setAccessAdd({ form: 'admin.verticals' }); }}>＋ Add Vertical</a>}
      </>
    );
  };

  return (
    <div className="add-scrim">
      <div className="add-modal">
        <div className="ah">
          <h3><Ic k={edit ? 'pencil' : 'plus'} />{edit ? edit.title : spec.title}</h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody">
          {!wired && (
            <div className="notice"><Ic k="bolt" />
              <div><b>Design-final form.</b> This module's data entry activates with its backend in a later project phase — the fields are final; nothing is saved yet.</div>
            </div>
          )}
          <div className="form-grid">
            {[...spec.fields, ...cfFields]
              .filter((f) => !(f.addOnly && edit))
              // Client Aug 2026 (#3) — the existing-student search shows only when the referrer
              // is an Existing Student; other referrer types keep the manual-entry path.
              .filter((f) => f.type !== 'studentlookup' || vals['Referrer Type'] === 'Existing Student')
              .map((f) => {
              const t = f.type || 'text';
              const span2 = t === 'textarea' || t === 'table' || t === 'levels';
              // 'checkbox' renders its own caption next to the box — don't print the hint twice
              const inField = t === 'auto' || t === 'lookup' || t === 'table' || t === 'checkbox';
              return (
                <div className={`fld ${span2 ? 'span2' : ''}`} key={f.label}>
                  <label>
                    {f.label}{f.req && !edit?.optional?.includes(f.label) ? <> <span className="star">*</span></> : null}
                    {edit?.lock?.includes(f.label) ? <span className="fhint">read-only · derived</span> : (f.hint && !inField ? <span className="fhint">{f.hint}</span> : null)}
                    {masterLink(f)}
                    {accessLinks(f)}
                  </label>
                  {input(f)}
                </div>
              );
            })}
          </div>
          {edit?.extra}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />{edit ? 'Save changes' : 'Save'}</button>
        </div>
      </div>
      {masterAdd && (
        <AddMasterModal type={masterAdd.type} onClose={() => setMasterAdd(null)}
          onCreated={(row) => {
            setExtras((x) => ({ ...x, [masterAdd.field]: [...(x[masterAdd.field] ?? []), row] }));
            setField(masterAdd.field, row.name, Number(row.id)); // auto-select the new value
            ref.reload();
          }} />
      )}
      {masterForm && (
        <AddModal formKey={masterForm.form} onClose={() => setMasterForm(null)}
          onSavedRow={(row) => {
            setExtras((x) => ({ ...x, [masterForm.field]: [...(x[masterForm.field] ?? []), row] }));
            setField(masterForm.field, row.name, Number(row.id)); // auto-select the new value
            const fee = (row as any)?.meta?.fee; // course fee auto-fetch, same as manual select
            const feeField = spec.fields.find((x) => /course fee|standard fee/i.test(x.label));
            if (fee != null && fee !== '' && feeField) setVals((x) => ({ ...x, [feeField.label]: String(fee) }));
            ref.reload();
          }} />
      )}
      {subForm && <AddModal formKey={subForm.form} onClose={() => setSubForm(null)}
        onSaved={() => ref.reload()}
        onSavedRow={(row) => {
          // UAT-R2 #17 — a Source (or other hierarchy master) added via ＋ quick-add must
          // appear in this dropdown and be selected WITHOUT a page refresh. Inject the new
          // row into the live options (extras) and auto-select it, exactly like ＋ Master.
          setExtras((x) => ({ ...x, [subForm.field]: [...(x[subForm.field] ?? []), row] }));
          setField(subForm.field, row.name, Number(row.id));
          ref.reload();
        }} />}
      {accessAdd && <AddModal formKey={accessAdd.form} onClose={() => setAccessAdd(null)}
        onSaved={() => ref.reload()}
        onSavedRow={(row) => {
          // Show the new branch/vertical in the access pickers without a page refresh and
          // auto-tick it. Branch/Vertical Access ride in `vals` as CSV; a vertical only shows
          // under a ticked branch, so adding a vertical also ticks its parent branch.
          ref.reload();
          setVals((x) => {
            if (accessAdd.form === 'admin.branches') {
              const bids = parseIdCsv(x['Branch Access']);
              if (!bids.includes(Number(row.id))) bids.push(Number(row.id));
              return { ...x, 'Branch Access': bids.join(',') };
            }
            const bid = Number((row as any).branch_id);
            const bids = parseIdCsv(x['Branch Access']);
            if (bid && !bids.includes(bid)) bids.push(bid);
            const verts = parseVertCsv(x['Vertical Access']);
            if (!verts.some((z) => z.v === Number(row.id))) verts.push({ v: Number(row.id), b: bid });
            return { ...x, 'Branch Access': bids.join(','), 'Vertical Access': verts.map((z) => `${z.v}:${z.b}`).join(',') };
          });
        }} />}
      {subCampaign && <CampaignModal onClose={() => setSubCampaign(false)} onSaved={() => ref.reload()} />}
    </div>
  );
}

/* ---------------------- NeoDove campaign modal ---------------------- */

const DIST_OPTS = [
  ['On Demand', 'on_demand', 'Leads stay unassigned until a user assigns it to themselves or clicks Start Calling — then the system assigns ten leads at a time.'],
  ['Equal', 'equal', 'Distributes leads equally among all agents in the campaign, ensuring fair allocation.'],
  ['Conditional', 'conditional', 'Assigns leads based on set conditions, ensuring the right leads go to the right agents.'],
] as const;
const COND_FIELDS = [
  ['course', 'Course'], ['city', 'City'], ['state', 'State'], ['priority', 'Priority'],
  ['temperature', 'Temperature'], ['source', 'Source'], ['qualification', 'Qualification'],
  ['budget', 'Budget'], ['full_name', 'Full name'], ['email', 'Email'],
] as const;
const COND_OPS = [['equals', 'equals'], ['not_equals', 'not equals'], ['contains', 'contains'], ['in', 'is one of (comma-sep)']] as const;
type CondRow = { field: string; op: string; value: string; assign_to_user_ids: number[] };

// Client change (Jul 2026): scope options are exactly these four — "Within This
// Pipeline" was REMOVED at the client's request.
const DUP_SCOPES = [['Within This Campaign', 'this_campaign'], ['Within This Vertical', 'this_vertical'], ['Within This Branch', 'this_branch'], ['All / Global', 'global']] as const;
// Client change (Jul 2026): five actions — the last two are new/relabelled.
const DUP_ACTIONS = [['Ignore Duplicate', 'ignore'], ['Merge Duplicate', 'merge'], ['Create Duplicate Leads', 'create'], ['Merge & Reopen Closed Leads — assign to round-robin user', 'merge_and_reopen'], ['Flag All These Types of Leads', 'flag']] as const;

/** `initial` switches the same NeoDove modal into edit mode (PATCH /campaigns/:id, path locked). */
export function CampaignModal({ onClose, onSaved, initial }: { onClose: () => void; onSaved?: () => void; initial?: any }) {
  const ref = useRef_();
  // DEF-S2-02 — Campaign Type / Marketing Channel / Start Date / End Date are stored
  // (migration 024) and therefore PREFILLED here, sent on save, and back on re-open.
  const day = (v: unknown) => (v ? String(v).slice(0, 10) : '');
  const [vals, setVals] = useState<Record<string, string>>(() => (initial ? {
    name: String(initial.name ?? ''),
    utm: String((initial.utm as any)?.utm_campaign ?? ''),
    cost: initial.cost != null && Number(initial.cost) !== 0 ? String(initial.cost) : '',
    type: String(initial.campaign_type ?? ''),
    channel: String(initial.marketing_channel ?? ''),
    start: day(initial.start_date),
    end: day(initial.end_date),
  } : {} as Record<string, string>));
  const [branchId, setBranchId] = useState<number | undefined>(initial ? Number(initial.branch_id) : undefined);
  const [verticalId, setVerticalId] = useState<number | undefined>(initial ? Number(initial.vertical_id) : undefined);
  const [pipelineId, setPipelineId] = useState<number | undefined>(initial ? Number(initial.pipeline_id) : undefined);
  const [dist, setDist] = useState<'on_demand' | 'equal' | 'conditional'>(
    (initial?.distribution_config as any)?.mode ?? 'on_demand');
  // agent pool (searchable multi-select) + conditional rule rows (single-select assign-to)
  const [agents, setAgents] = useState<number[]>(() =>
    Array.isArray((initial?.distribution_config as any)?.agent_user_ids)
      ? ((initial!.distribution_config as any).agent_user_ids as number[]).map(Number) : []);
  const [conds, setConds] = useState<CondRow[]>(() =>
    (Array.isArray((initial?.distribution_config as any)?.conditions)
      ? ((initial!.distribution_config as any).conditions as any[]) : []).map((c) => ({
      field: String(c.field ?? 'course'), op: String(c.op ?? 'equals'),
      value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? ''),
      assign_to_user_ids: Array.isArray(c.assign_to_user_ids) ? c.assign_to_user_ids.map(Number) : [],
    })));
  // §4.1 — On Demand hands out `batch_size` leads per "Start Calling" click (default 10)
  const [batchSize, setBatchSize] = useState<string>(
    String((initial?.distribution_config as any)?.batch_size ?? 10));
  const [priority, setPriority] = useState(initial?.priority ?? 'med');
  // #23 — campaign managers (multi-user). SEPARATE from the agent pool below: a
  // manager is a management/visibility role and is NEVER auto-assigned leads.
  const [managers, setManagers] = useState<number[]>(() =>
    Array.isArray((initial as any)?.manager_user_ids)
      ? ((initial as any).manager_user_ids as number[]).map(Number) : []);
  // Back-compat: a campaign saved with the removed `this_pipeline` scope shows as
  // "Within This Campaign" (the value migration 040 also writes).
  const _initScope = (initial?.duplicacy_config as any)?.check_scope ?? 'this_campaign';
  const [dupScope, setDupScope] = useState<string>(_initScope === 'this_pipeline' ? 'this_campaign' : _initScope);
  const [dupAction, setDupAction] = useState<string>((initial?.duplicacy_config as any)?.on_duplicate ?? 'ignore');
  const [busy, setBusy] = useState(false);
  const { can } = useAuth();
  // UAT (Aug 2026) — ＋ quick-add for the campaign's masters. The rich CampaignModal did not
  // reuse AddModal's ＋ Master wiring, so there was NO way to add a Branch / Vertical / Pipeline
  // from inside Create Campaign (the client reported "masters not working"). A nested create form
  // opens here; on save its row is injected into the live cascade (`extra`) AND auto-selected, and
  // RefData is reloaded — so the new value is usable immediately, no page refresh.
  const [quickAdd, setQuickAdd] = useState<{ form: string; field: 'Branch' | 'Vertical' | 'Pipeline' } | null>(null);
  const [extra, setExtra] = useState<{ branches: Named[]; verticals: Named[]; pipelines: Named[] }>(
    { branches: [], verticals: [], pipelines: [] });

  // UAT-R3 #20 — STRICT cascade: a child is EMPTY until its parent is chosen, so the user
  // is walked Branch → Vertical → Pipeline in order and only valid children appear.
  // Just-quick-added rows (`extra`) are merged in so they appear before RefData reload lands.
  const allBranches = [...ref.branches, ...extra.branches.filter((b) => !ref.branches.some((r) => Number(r.id) === Number(b.id)))];
  const allVerticals = [...ref.verticals, ...extra.verticals.filter((v) => !ref.verticals.some((r) => Number(r.id) === Number(v.id)))];
  const allPipelines = [...ref.pipelines, ...extra.pipelines.filter((p) => !ref.pipelines.some((r) => Number(r.id) === Number(p.id)))];
  const verticals = branchId ? allVerticals.filter((v) => Number(v.branch_id) === branchId) : [];
  const pipelines = verticalId ? allPipelines.filter((p) => Number(p.vertical_id) === verticalId) : [];

  /** Inject + auto-select a just-created master, then reload RefData. */
  const onQuickAdded = (field: 'Branch' | 'Vertical' | 'Pipeline', row: Named) => {
    const id = Number(row.id);
    if (field === 'Branch') {
      setExtra((x) => ({ ...x, branches: [...x.branches, row] }));
      setBranchId(id); setVerticalId(undefined); setPipelineId(undefined);
    } else if (field === 'Vertical') {
      // STAMP the parent FK so the row is visible in the filtered cascade even if the create
      // API's returned row omits it (the live /verticals returns RETURNING *, but be robust).
      const bid = Number((row as any).branch_id) || branchId;
      const stamped = { ...row, branch_id: bid } as Named;
      setExtra((x) => ({ ...x, verticals: [...x.verticals, stamped] }));
      if (bid) setBranchId(bid);
      setVerticalId(id); setPipelineId(undefined);
    } else {
      const vid = Number((row as any).vertical_id) || verticalId;
      const bid = Number((row as any).branch_id) || branchId;
      const stamped = { ...row, vertical_id: vid, branch_id: bid } as Named;
      setExtra((x) => ({ ...x, pipelines: [...x.pipelines, stamped] }));
      if (bid) setBranchId(bid);
      if (vid) setVerticalId(vid);
      setPipelineId(id);
    }
    ref.reload();
  };

  /** ＋ quick-add link beside a master dropdown (add mode only; permission-gated). */
  const qLink = (field: 'Branch' | 'Vertical' | 'Pipeline', form: string, perm: string) =>
    (!initial && can(perm)
      ? <a className="mlink" onClick={(e) => { e.preventDefault(); setQuickAdd({ form, field }); }}>＋ Add {field}</a>
      : null);

  const save = async () => {
    if (!vals['name']?.trim()) return toast('Campaign Name is required', true);
    if (!pipelineId) return toast('Pick Branch › Vertical › Pipeline', true);
    // Campaign Type + Start Date carry a required star on a NEW campaign. On an EXISTING
    // one they may be blank (campaigns created before migration 024 have neither), so the
    // client is never locked out of renaming a legacy campaign.
    if (!initial && !vals['type']) return toast('Campaign Type is required', true);
    if (!initial && !vals['start']) return toast('Start Date is required', true);
    if (vals['start'] && vals['end'] && vals['end'] < vals['start']) {
      return toast('End Date cannot be before Start Date', true);
    }
    // Build a validator-clean NeoDove config: `conditions` may only be sent in
    // conditional mode and must be non-empty there (from the rule builder below).
    const prevDist = (initial?.distribution_config as any) ?? {};
    if (dist === 'equal' && agents.length === 0) {
      return toast('Equal distribution needs at least one agent — search and tick the users to rotate leads across', true);
    }
    const size = Number(batchSize);
    if (!Number.isInteger(size) || size <= 0) {
      return toast('Leads per hand-out must be a positive whole number (the On Demand batch size)', true);
    }
    const distribution_config: Record<string, unknown> = {
      mode: dist,
      batch_size: size,
      round_robin_scope: prevDist.round_robin_scope ?? 'campaign',
      agent_user_ids: agents,
    };
    if (dist === 'conditional') {
      if (!conds.length) return toast('Conditional distribution needs at least one condition', true);
      for (let i = 0; i < conds.length; i++) {
        if (!conds[i].value.trim()) return toast(`Condition ${i + 1}: enter a value to match`, true);
        if (!conds[i].assign_to_user_ids.length) return toast(`Condition ${i + 1}: pick the user to assign matching leads to`, true);
      }
      distribution_config.conditions = conds.map((c) => ({
        field: c.field, op: c.op,
        value: c.op === 'in' ? c.value.split(',').map((v) => v.trim()).filter(Boolean) : c.value.trim(),
        assign_to_user_ids: c.assign_to_user_ids,
      }));
    }
    const prevDup = (initial?.duplicacy_config as any) ?? {};
    const duplicacy_config = {
      check_scope: dupScope,
      match_key: prevDup.match_key ?? 'phone',
      on_duplicate: dupAction,
      open_reassign_same_user: prevDup.open_reassign_same_user ?? true,
    };
    // every field the modal renders goes in the body (qa/09 rule)
    const formFields = {
      campaign_type: vals['type'] || null,
      marketing_channel: vals['channel'] || null,
      start_date: vals['start'] || null,
      end_date: vals['end'] || null,
    };
    setBusy(true);
    try {
      if (initial) {
        await api.patch(`/campaigns/${initial.id}`, {
          name: vals['name'].trim(),
          utm: vals['utm'] ? { utm_campaign: vals['utm'] } : {},
          cost: vals['cost'] ? Number(vals['cost']) : 0,
          priority, distribution_config, duplicacy_config, manager_user_ids: managers, ...formFields,
        });
        toast('Campaign updated');
      } else {
        await api.post('/campaigns', {
          pipeline_id: pipelineId,
          name: vals['name'].trim(),
          utm: vals['utm'] ? { utm_campaign: vals['utm'] } : {},
          cost: vals['cost'] ? Number(vals['cost']) : 0,
          priority, distribution_config, duplicacy_config, manager_user_ids: managers, ...formFields,
        });
        toast('Campaign created');
      }
      onSaved?.(); onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  const txt = (k: string, ph = '', type = 'text') => (
    <input className="ainp" type={type} placeholder={ph} value={vals[k] ?? ''} onChange={(e) => setVals((x) => ({ ...x, [k]: e.target.value }))} />
  );
  const sel = (opts: string[], v: string, set: (x: string) => void) => (
    <select className="ainp" value={v} onChange={(e) => set(e.target.value)}>
      <option value="">Select…</option>
      {opts.map((o) => <option key={o}>{o}</option>)}
    </select>
  );

  return (
    <div className="add-scrim">
      <div className="add-modal">
        <div className="ah"><h3><Ic k={initial ? 'pencil' : 'plus'} />{initial ? 'Edit Campaign' : 'Create Campaign'}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld"><label>Campaign Name <span className="star">*</span></label>{txt('name')}</div>
            <div className="fld"><label>Branch <span className="star">*</span><span className="fhint">{initial ? 'path locked' : 'master'}</span>{qLink('Branch', 'admin.branches', 'branch.create')}</label>
              {initial ? <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{initial.branch_name ?? allBranches.find((b) => Number(b.id) === branchId)?.name ?? '—'}</div>
                : <select className="ainp" value={branchId ?? ''} onChange={(e) => { setBranchId(e.target.value ? Number(e.target.value) : undefined); setVerticalId(undefined); setPipelineId(undefined); }}>
                <option value="">Select…</option>{allBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>}</div>
            <div className="fld"><label>Vertical <span className="star">*</span><span className="fhint">{initial ? 'path locked' : 'filtered by Branch'}</span>{branchId ? qLink('Vertical', 'admin.verticals', 'vertical.create') : null}</label>
              {initial ? <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{initial.vertical_name ?? allVerticals.find((v) => Number(v.id) === verticalId)?.name ?? '—'}</div>
                : <select className="ainp" disabled={!branchId} value={verticalId ?? ''} onChange={(e) => { setVerticalId(e.target.value ? Number(e.target.value) : undefined); setPipelineId(undefined); }}>
                <option value="">{branchId ? 'Select…' : 'Select Branch first…'}</option>{verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>}</div>
            <div className="fld"><label>Pipeline <span className="star">*</span><span className="fhint">{initial ? 'path locked' : 'filtered by Vertical'}</span>{verticalId ? qLink('Pipeline', 'leads.pipelinemaster', 'pipeline.create') : null}</label>
              {initial ? <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{initial.pipeline_name ?? allPipelines.find((p) => Number(p.id) === pipelineId)?.name ?? '—'}</div>
                : <select className="ainp" disabled={!verticalId} value={pipelineId ?? ''} onChange={(e) => setPipelineId(e.target.value ? Number(e.target.value) : undefined)}>
                <option value="">{verticalId ? 'Select…' : 'Select Vertical first…'}</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>}</div>
            {/* dev/131 (task #213 item 4) — Campaign Type is a self-manageable master (m_campaign_type).
                The select reads ref.campaignTypes; ＋ Master adds a new type inline (blue .mlink). A legacy
                value not in the master still shows so an old campaign never loses its type. */}
            <div className="fld"><label>Campaign Type <span className="star">*</span>
              {/* dev/132 (ITEM E) — the ＋ Master quick-add renders on BOTH add and edit (was add-only). */}
              <MasterQuickAdd type="campaign_type" onAdded={(row) => setVals((s) => ({ ...s, type: row.name }))} /></label>
              <select className="ainp" data-testid="campaign-type-select" value={vals['type'] ?? ''} onChange={(e) => setVals((s) => ({ ...s, type: e.target.value }))}>
                <option value="">Select…</option>
                {(ref.campaignTypes ?? []).map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                {vals['type'] && !(ref.campaignTypes ?? []).some((t) => t.name === vals['type']) ? <option value={vals['type']}>{vals['type']}</option> : null}
              </select></div>
            <div className="fld"><label>Marketing Channel</label>{sel(['Google', 'Meta', 'SMS', 'Hoarding', 'Email'], vals['channel'] ?? '', (x) => setVals((s) => ({ ...s, channel: x })))}</div>
            <div className="fld"><label>Start Date <span className="star">*</span></label><input className="ainp" type="date" value={vals['start'] ?? ''} onChange={(e) => setVals((x) => ({ ...x, start: e.target.value }))} /></div>
            <div className="fld"><label>End Date</label><input className="ainp" type="date" value={vals['end'] ?? ''} onChange={(e) => setVals((x) => ({ ...x, end: e.target.value }))} /></div>
            {/* MONEY, so a number input: as free text, `Number(vals['cost'])` turned anything
                non-numeric into NaN and the API stored 0 without telling anyone.
                (Found by the generic qa10 probe.) */}
            <div className="fld"><label>Campaign Budget / Spend</label>{txt('cost', '₹', 'number')}</div>
            <div className="fld"><label>UTM / Tracking Code<span className="fhint">digital only</span></label>{txt('utm', 'utm_campaign')}</div>
          </div>
          <div className="sechead">Lead Distribution</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {DIST_OPTS.map(([t, key, d]) => (
              <label className={`distopt ${dist === key ? 'sel' : ''}`} key={key} onClick={() => setDist(key)}>
                <input type="radio" name="dist" checked={dist === key} readOnly />
                <div><div className="dt">{t}</div><div className="dd">{d}</div></div>
              </label>
            ))}
          </div>
          {dist !== 'conditional' && (
            <div className="fld" style={{ marginTop: 12 }}>
              <label>Agents{dist === 'equal' ? <span className="star"> *</span> : null}
                <span className="fhint">{dist === 'equal'
                  ? 'round-robin rotates over exactly these users'
                  : 'optional — leave empty to let any agent in scope self-assign'}</span></label>
              <UserPicker value={agents} onChange={setAgents} branchId={branchId}
                placeholder="Search users by name / email / phone…" />
            </div>
          )}
          {dist === 'on_demand' && (
            <div className="fld" style={{ marginTop: 12, maxWidth: 260 }}>
              <label>Leads per hand-out <span className="fhint">Start Calling assigns this many at a time</span></label>
              <input className="ainp" type="number" min={1} aria-label="Leads per hand-out"
                value={batchSize} onChange={(e) => setBatchSize(e.target.value)} />
            </div>
          )}
          {dist === 'conditional' && (
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em' }}>
                Conditions <span className="fhint">first matching rule assigns the lead</span></label>
              <div style={{ marginTop: 7 }}>
                {conds.map((c, i) => {
                  const set = (patch: Partial<CondRow>) => setConds((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <div className="condrow" key={i}>
                      <select className="ainp" value={c.field} onChange={(e) => set({ field: e.target.value })}>
                        {COND_FIELDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                      </select>
                      <select className="ainp" value={c.op} onChange={(e) => set({ op: e.target.value })}>
                        {COND_OPS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                      </select>
                      <input className="ainp" placeholder={c.op === 'in' ? 'IELTS, PTE' : 'value'} value={c.value}
                        onChange={(e) => set({ value: e.target.value })} />
                      <UserPicker multiple={false} value={c.assign_to_user_ids} branchId={branchId}
                        onChange={(ids) => set({ assign_to_user_ids: ids })} placeholder="Assign to user…" />
                      <button className="ax2" title="Remove condition" onClick={() => setConds((xs) => xs.filter((_, j) => j !== i))}><Ic k="trash" /></button>
                    </div>
                  );
                })}
              </div>
              <button className="setcond" onClick={() => setConds((xs) => [...xs, { field: 'course', op: 'equals', value: '', assign_to_user_ids: [] }])}>
                <Ic k="plus" />Add condition
              </button>
            </div>
          )}
          <div className="sechead">Campaign Managers</div>
          <div className="fld">
            <label>Who will be managing this campaign?
              <span className="fhint">management &amp; visibility only — managers are NOT auto-assigned leads</span></label>
            <UserPicker value={managers} onChange={setManagers} branchId={branchId}
              placeholder="Search users to manage this campaign…" />
          </div>
          <div className="sechead">Additional Settings</div>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', padding: 0 }}>
            <div className="fld"><label>Priority</label>
              <select className="ainp" value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="low">Low</option><option value="med">Medium</option><option value="high">High</option>
              </select></div>
            <div className="fld"><label>Check for Duplicates</label>
              <select className="ainp" value={dupScope} onChange={(e) => setDupScope(e.target.value)}>
                {DUP_SCOPES.map(([t, k]) => <option key={k} value={k}>{t}</option>)}
              </select></div>
            <div className="fld"><label>If Duplicate Found</label>
              <select className="ainp" value={dupAction} onChange={(e) => setDupAction(e.target.value)}>
                {DUP_ACTIONS.map(([t, k]) => <option key={k} value={k}>{t}</option>)}
              </select></div>
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button>
        </div>
      </div>
      {quickAdd && (
        <AddModal formKey={quickAdd.form} onClose={() => setQuickAdd(null)}
          onSaved={() => ref.reload()}
          onSavedRow={(row) => onQuickAdded(quickAdd.field, row)} />
      )}
    </div>
  );
}

/* -------------------- Reusable ＋ Master quick-add (Students & Academics) --------------------
 * The SAME ＋ Master affordance the Leads add/edit form + lead sheet use: a generic master
 * opens <AddMasterModal>, a Course opens the full Courses management form (students.courses) —
 * both gated by master.create. On add, RefData is refreshed so the new value is immediately
 * selectable, and onAdded(row) lets the host auto-select the just-created row. Drop
 * <MasterQuickAdd type="course|status|source|qualification|budget|tag|state|city" .../> inside
 * a field <label>, exactly beside its master-backed <select>. */
export function MasterQuickAdd({ type, onAdded }: { type: string; onAdded?: (row: Named) => void }) {
  const auth = useAuth();
  const can = auth?.can ?? (() => false); // hidden outside an AuthProvider (e.g. isolated unit tests)
  const ref = useRef_();
  const [open, setOpen] = useState(false);
  if (!can('master.create')) return null;
  const done = (row: Named) => { onAdded?.(row); ref.reload(); setOpen(false); };
  return (
    <>
      <a className="mlink" onClick={(e) => { e.preventDefault(); setOpen(true); }}>＋ Master</a>
      {open && createPortal(type === 'course'
        ? <AddModal formKey="students.courses" onClose={() => setOpen(false)} onSavedRow={done} />
        : <AddMasterModal type={type} onClose={() => setOpen(false)} onCreated={done} />, document.body)}
    </>
  );
}
