/**
 * Add-record forms — field specs ported verbatim from the prototype's SPEC_FORMS,
 * with live master/hierarchy dropdowns and wired saves where APIs exist.
 * Unwired forms render exactly but tell the user which sprint makes them live.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { UserPicker } from './userpicker';
import { AddMasterModal } from './mastermodal';
import { PhoneInput } from './phonefield';
import { toast, useRef_, Named, RefData, selectableUsers } from './refdata';

export interface FormField {
  label: string; type?: string; req?: boolean; opts?: string[] | null; hint?: string;
  /** refdata source for id-valued selects (enables cascading + wired saves) */
  src?: keyof Pick<RefData, 'branches' | 'verticals' | 'pipelines' | 'campaigns' | 'sources' | 'masterSources' | 'users' | 'courses' | 'followupTypes' | 'dispositions' | 'statuses' | 'budgets' | 'states' | 'cities'>;
  /** default value on the ADD form (never on Edit — an edit prefill always wins). */
  def?: string;
  /** UAT-R2 — a STRING-valued select whose options come from a master list (RefData key).
   *  Unlike `src` (which stores an id and cascades), `mopts` stores the master's NAME, so
   *  the column/JSON stays text and edit-prefill is trivial. Carries the ＋ Master add. */
  mopts?: keyof Pick<RefData, 'trainings' | 'visitPurposes' | 'walkinStatuses'>;
  /** client update #5 (Task module only) — render the logged-in user as "Myself",
   *  pinned to the top of the user list and selected by default. Scoped per field,
   *  so Lead Owner / Counsellor dropdowns elsewhere keep showing real names. */
  self?: boolean;
}
export const F = (label: string, type?: string, req?: 0 | 1 | boolean, opts?: string[] | 0 | null, hint?: string, src?: FormField['src'], self?: 0 | 1 | boolean, def?: string): FormField =>
  ({ label, type, req: !!req, opts: opts || null, hint: hint || '', src, self: !!self, def });

/** Label used for the current user inside Task-module user dropdowns. */
export const SELF_LABEL = 'Myself';

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
  { src: 'verticals', parent: 'Branch Access', fk: 'branch_id' },
  { src: 'pipelines', parent: 'Vertical', fk: 'vertical_id', strict: true },
  { src: 'campaigns', parent: 'Pipeline', fk: 'pipeline_id', strict: true },
  { src: 'sources', parent: 'Campaign', fk: 'campaign_id', strict: true },
  { src: 'cities', parent: 'State', fk: 'parent_id' },
];

export const SPEC_FORMS: Record<string, { title: string; fields: FormField[] }> = {
  'leads.all': { title: 'Add Lead', fields: [
    F('Name', 'text', 1), F('Mobile Number', 'tel', 1, 0, 'de-dup key'), F('Alternate Number', 'tel'), F('WhatsApp Number', 'tel'), F('Email ID', 'email'),
    // Sprint 4 — the `birthday` automation journey needs a date to fire on.
    F('Date of Birth', 'date', 0, 0, 'used by the Birthday automation journey'),
    F('Branch', 'select', 1, 0, 'master', 'branches'), F('Vertical', 'select', 1, 0, 'filtered by Branch', 'verticals'), F('Pipeline', 'select', 1, 0, 'filtered by Vertical', 'pipelines'),
    F('Campaign', 'select', 1, 0, 'filtered by Pipeline', 'campaigns'), F('Lead Source', 'select', 1, 0, 'filtered by Campaign', 'sources'),
    F('Course', 'select', 0, 0, 'master', 'courses'), { ...F('Training Mode', 'select', 0, 0, 'master'), mopts: 'trainings' }, F('Course Fee', 'number'), F('City / Location', 'text'),
    F('Lead Owner / Assigned Counsellor', 'select', 0, 0, 'Users', 'users'), F('Lead Status', 'select', 0, 0, 'default: New', 'statuses'),
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
    F('Date & Time of Visit', 'datetime', 1, 0, 'auto-stamped'),
    { ...F('Purpose of Visit', 'select', 1, 0, 'master'), mopts: 'visitPurposes' }, F('Course Interested', 'select', 0, 0, 'filtered by Vertical', 'courses'),
    // DEF-S34-02 — these three RENDERED but were never SENT and had no columns (migration 027).
    F('Course Fee', 'number', 0, 0, 'auto-filled from the Course master \u00b7 editable'),
    F('How did you hear about us?', 'select', 0, 0, 'Lead Source master', 'masterSources'),
    F('Counsellor Assigned', 'select', 1, 0, 'Users \u00b7 owns the lead immediately', 'users'),
    // ticked by default: a walk-in becoming an assigned lead IS the point of this screen.
    // Untick it to log a visit (a fee query from an existing student) without a lead;
    // tick it later on Edit and it converts through the same LeadIngestionService.
    F('Convert to Lead', 'checkbox', 0, 0, 'creates the lead and assigns it to the counsellor', undefined, 0, '1'),
    F('Remarks', 'textarea')] },
  'dash.referrals': { title: 'Add Referral', fields: [
    F('Referrer Type', 'select', 1, ['Existing Student', 'Parent', 'Employee', 'Alumni', 'Partner']), F('Referrer Name', 'text', 1, 0, 'Student / Employee name'),
    F('Referrer Contact Number', 'tel', 1), F('Referred Person Name', 'text', 1), F('Referred Person Contact Number', 'tel', 1, 0, 'de-dup key'),
    F('Referred Person WhatsApp Number', 'tel'), F('Referred Person Email', 'email'), F('Relationship to Referrer', 'text'),
    F('Branch', 'select', 1, 0, 'master', 'branches'), F('Vertical', 'select', 1, 0, 'filtered by Branch', 'verticals'),
    F('Pipeline', 'select', 1, 0, 'filtered by Vertical', 'pipelines'), F('Campaign', 'select', 1, 0, 'filtered by Pipeline', 'campaigns'),
    F('Lead Source', 'select', 1, 0, 'filtered by Campaign', 'sources'),
    F('Course Interested', 'select', 0, 0, 'filtered by Vertical', 'courses'), F('Incentive / Reward Applicable', 'text', 0, 0, 'auto-computed'),
    F('Referral Status', 'select', 1, ['Pending', 'Converted', 'Rewarded', 'Rejected'])] },
  // UAT-R2 #4 — Source Category, Cost per Lead removed (backend keeps its defaults). Campaign
  // stays: it is the required parent that supplies the source's Branch › Vertical › Pipeline path.
  'leads.sources': { title: 'Add Lead Source', fields: [
    F('Source Name', 'text', 1), F('Campaign', 'select', 1, 0, 'parent link', 'campaigns'),
    F('Status', 'select', 0, ['Active', 'Inactive'])] },
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
  'students.courses': { title: 'Add Course', fields: [
    F('Course Name', 'text', 1), F('Course Code', 'text', 1), F('Branch', 'select', 1, 0, 'master', 'branches'), F('Vertical', 'select', 1, 0, 'filtered by Branch', 'verticals'),
    F('Duration', 'number', 0, 0, 'weeks / months'), F('Standard Fee', 'number'), F('Eligibility Criteria', 'text'), { ...F('Training Mode', 'select', 0, 0, 'master'), mopts: 'trainings' }, F('Status', 'select', 0, ['Active', 'Inactive'])] },
  'students.batches': { title: 'Add Batch', fields: [
    F('Batch Name / Code', 'text', 1, 0, 'e.g. JAVA-JUL26-EVE'), F('Course', 'select', 1, 0, 'master', 'courses'), F('Branch', 'auto', 1, 0, 'Auto-filled from Course/Vertical'),
    F('Start Date', 'date', 1), F('End Date', 'date', 1), F('Class Timing', 'text', 1), F('Capacity (Max Seats)', 'number', 1), F('Trainer / Faculty Assigned', 'select', 0, 0, 'Employee master', 'users'),
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
    F('Branch Head', 'select', 0, 0, 'Employee master', 'users'), F('Status', 'select', 0, ['Active', 'Inactive'])] },
  'admin.verticals': { title: 'Add Vertical', fields: [
    F('Vertical Name', 'text', 1), F('Vertical Code', 'text', 1, 0, 'e.g. TLA'), F('Branch', 'select', 1, 0, 'master · parent link', 'branches'), F('Vertical Head', 'select', 0, 0, 'Employee master', 'users'), F('Description', 'textarea'), F('Status', 'select', 0, ['Active', 'Inactive'])] },
  'admin.users': { title: 'Add User', fields: [
    F('Full Name', 'text', 1, 0, 'Employee master'), F('Mobile Number', 'tel', 1, 0, 'login identifier'), F('Email ID', 'email', 0, 0, 'optional'), F('Password / Login Method', 'password', 1, 0, 'encrypted / SSO'),
    F('System Role', 'roleselect', 1, 0, 'drives permissions'), F('Branch Access', 'select', 0, 0, 'blank = org-wide', 'branches'),
    F('Vertical Access', 'select', 0, 0, 'filtered by Branch', 'verticals'), F('Status', 'select', 0, ['Active', 'Deactivated'])] },
  'fran.partners': { title: 'Add Franchise Partner', fields: [
    F('Franchise ID', 'auto', 1, 0, 'Auto-generated'), F('Legal Name', 'text', 1), F('Brand Name', 'text'), F('Owner', 'text', 1), F('Mobile', 'tel', 1), F('Email', 'email'),
    F('Branch / Territory', 'text'), F('Status', 'select', 0, ['Onboarding', 'Active', 'Inactive']), F('KYC Documents', 'file')] },
  'fran.agreements': { title: 'Add Agreement', fields: [
    F('Agreement No', 'auto', 1, 0, 'Auto-generated'), F('Franchise', 'lookup', 1), F('Royalty Model', 'select', 0, ['Fixed', 'Percentage', 'Hybrid', 'Minimum']), F('Franchise Fee', 'number'),
    F('Start Date', 'date'), F('End Date', 'date'), F('Territory', 'text'), F('Signed PDF', 'file')] },
  'leads.followups': { title: 'Add Follow-up', fields: [
    F('Lead', 'leadlookup', 1, 0, 'Search lead'), F('Type', 'select', 1, 0, 'master', 'followupTypes'), F('Disposition', 'select', 0, 0, 'master', 'dispositions'),
    F('Priority', 'select', 0, ['Low', 'Medium', 'High'], 'default: Medium'),
    F('Next Follow-up Date', 'datetime', 1), F('Remarks', 'textarea')] },
  // client update #5 — Assigned To / Report To show the logged-in user as "Myself" (top of list, default).
  'dash.mytasks': { title: 'Add Task', fields: [
    F('Title', 'text', 1), F('Task Type', 'select', 0, 0, 'master', 'followupTypes'), F('Related Lead', 'leadlookup', 1, 0, 'Search lead'),
    F('Assigned To', 'select', 0, 0, 'Users', 'users', 1),
    F('Report To', 'select', 0, 0, 'Users · the assignee reports progress to them', 'users', 1),
    F('Due Date', 'datetime', 1), F('Priority', 'select', 0, ['Low', 'Medium', 'High']), F('Description', 'textarea')] },
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
    'Student Management': 'Student', 'All Students': 'Student', 'Auto-Assignment': 'Rule', 'Duplicate Rules': 'Rule',
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
export const SAVERS: Record<string, (vals: Vals, ids: Ids) => Promise<SaveResult>> = {
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
      counsellor_id: need(ids['Counsellor Assigned'], 'A walk-in must be assigned to a counsellor on add'),
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
      source_id: need(ids['Lead Source'], 'Pick a Lead Source'),
      course_id: ids['Course Interested'],
      incentive: vals['Incentive / Reward Applicable'] || undefined,
      status: (vals['Referral Status'] || 'Pending').toLowerCase(),
    });
    return 'Referral captured';
  },
  'leads.all': async (vals, ids) => {
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
      owner_id: ids['Lead Owner / Assigned Counsellor'],
      status_id: ids['Lead Status'],
      next_follow_up_at: vals['Next Follow-up Date'] || undefined,
      note: vals['Remarks / Notes'] || undefined,
      custom_fields: vals['Training Mode'] || vals['City / Location'] || vals['Course Fee']
        ? { training_mode: vals['Training Mode'] || undefined, city: vals['City / Location'] || undefined, course_fee: vals['Course Fee'] || undefined }
        : undefined,
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
      campaign_id: need(ids['Campaign'], 'Pick a campaign'),
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
      assignments: ids['System Role'] ? [{
        role_id: ids['System Role'],
        branch_id: ids['Branch Access'] ?? null,
        vertical_id: ids['Vertical Access'] ?? null,
      }] : [],
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
      branch_id: need(ids['Branch'], 'Pick a Branch'),
      vertical_id: need(ids['Vertical'], 'Pick a Vertical (filtered by the Branch)'),
      eligibility: vals['Eligibility Criteria'] || undefined,
    },
    is_active: vals['Status'] !== 'Inactive',
  });
  return { msg: `Course "${row.name}" added to the master`, row };
};
SAVERS['admin.courseconfig'] = SAVERS['students.courses'];
SAVERS['dash.quickcontact'] = SAVERS['leads.all'];
SAVERS['leads.pipeline'] = SAVERS['leads.all'];
SAVERS['leads.branch'] = SAVERS['admin.branches'];
SAVERS['leads.vertical'] = SAVERS['admin.verticals'];
SAVERS['admin.verticalmgmt'] = SAVERS['admin.verticals'];
SAVERS['admin.pipelines'] = SAVERS['leads.pipelinemaster'];

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
  const [subCampaign, setSubCampaign] = useState(false);
  const [extras, setExtras] = useState<Record<string, Named[]>>({});
  const [roles, setRoles] = useState<Named[]>([]);
  const [busy, setBusy] = useState(false);
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

  if (!spec) return null;

  /** Is `label` a real parent <select> on THIS form? (Not an 'auto' display field.) */
  const cascadeParent = (label: string) =>
    spec.fields.some((x) => x.label === label && !!x.src && (x.type === 'select' || x.type === 'multiselect'));

  const srcOptions = (f: FormField): Named[] => {
    let list: Named[] = (ref as any)[f.src!] ?? [];
    // DEF-1: never offer a deactivated user — but keep the one already selected (edit/prefill).
    if (f.src === 'users') list = selectableUsers(list, ids[f.label] ?? null);
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
      if (bid != null) list = list.filter((o) => Number((o as any).meta?.branch_id) === Number(bid));
      if (vid != null) list = list.filter((o) => Number((o as any).meta?.vertical_id) === Number(vid));
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
    setVals((x) => { const n = { ...x, [label]: value }; for (const k of clear) delete n[k]; return n; });
    setIds((x) => { const n = { ...x, [label]: id }; for (const k of clear) delete n[k]; return n; });
  };

  const save = async () => {
    if (!wired) {
      toast("This module's backend lands in a later sprint — the form is final but nothing was saved yet.");
      onClose();
      return;
    }
    setBusy(true);
    try {
      const res = await (edit ? edit.submit(vals, ids) : SAVERS[formKey](vals, ids));
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
          title="Not editable here">
          <span>{v || '—'}</span>
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
      const blocked = !!parentCfg && ids[parentCfg.parent] == null;
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
            <option value="">{blocked ? `Select ${parentCfg!.parent} first…` : 'Select…'}</option>
            {list.map((o) => <option key={o.id} value={o.id}>{o.name}{o.branch_name ? ` · ${o.branch_name}` : ''}</option>)}
          </select>
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
    if (t === 'select' || t === 'multiselect') {
      return (
        <select className="ainp" value={v} onChange={(e) => setField(f.label, e.target.value)}>
          <option value="">Select…</option>
          {(f.opts || []).map((o) => <option key={o}>{o}</option>)}
        </select>
      );
    }
    if (t === 'leadlookup') return <LeadLookup value={v} onPick={(id, label) => setField(f.label, label, id)} />;
    if (t === 'date') return <input className="ainp" type="date" value={v} onChange={(e) => setField(f.label, e.target.value)} />;
    if (t === 'datetime') return <input className="ainp" type="datetime-local" value={v} onChange={(e) => setField(f.label, e.target.value)} />;
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
            onClick={(e) => { e.preventDefault(); toast(`${isWa ? 'WhatsApp' : 'Number'} verification lands with the messaging integration (Sprint 3)`); }}>
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
    return <input className="ainp" type="text" value={v} onChange={(e) => setField(f.label, e.target.value)} />;
  };

  const isMaster = (f: FormField) => (f.type === 'select' || f.type === 'multiselect') &&
    (!!f.mopts || /master/i.test(f.hint || '') || /\b(course|vertical|pipeline|campaign|branch|source|stage|status|tag|batch|payment plan|payment terms|qualification|budget|designation|department|training mode)\b/i.test(f.label));

  /** ＋ Master → inline add modal. Rule: opens the same form as the master's own
   *  management screen — rich masters (Course) open their full spec form, generic
   *  masters open <AddMasterModal>, hierarchy fields open their full add-form;
   *  all hidden without the create permission. */
  const masterLink = (f: FormField) => {
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
              <div><b>Design-final form.</b> This module's backend lands in a later sprint — fields are final but saving is not yet live.</div>
            </div>
          )}
          <div className="form-grid">
            {spec.fields.map((f) => {
              const t = f.type || 'text';
              const span2 = t === 'textarea' || t === 'table';
              // 'checkbox' renders its own caption next to the box — don't print the hint twice
              const inField = t === 'auto' || t === 'lookup' || t === 'table' || t === 'checkbox';
              return (
                <div className={`fld ${span2 ? 'span2' : ''}`} key={f.label}>
                  <label>
                    {f.label}{f.req && !edit?.optional?.includes(f.label) ? <> <span className="star">*</span></> : null}
                    {f.hint && !inField ? <span className="fhint">{f.hint}</span> : null}
                    {masterLink(f)}
                  </label>
                  {input(f)}
                </div>
              );
            })}
          </div>
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

const DUP_SCOPES = [['Within This Campaign', 'this_campaign'], ['Within This Pipeline', 'this_pipeline'], ['All Campaigns (Global)', 'global']] as const;
const DUP_ACTIONS = [['Ignore Duplicate', 'ignore'], ['Merge Duplicate', 'merge'], ['Create Duplicate Leads', 'create'], ['Merge Duplicate & Reopen Closed Leads', 'merge_and_reopen']] as const;

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
  const [dupScope, setDupScope] = useState<string>((initial?.duplicacy_config as any)?.check_scope ?? 'this_campaign');
  const [dupAction, setDupAction] = useState<string>((initial?.duplicacy_config as any)?.on_duplicate ?? 'ignore');
  const [busy, setBusy] = useState(false);

  const verticals = ref.verticals.filter((v) => !branchId || Number(v.branch_id) === branchId);
  const pipelines = ref.pipelines.filter((p) => !verticalId || Number(p.vertical_id) === verticalId);

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
          priority, distribution_config, duplicacy_config, ...formFields,
        });
        toast('Campaign updated');
      } else {
        await api.post('/campaigns', {
          pipeline_id: pipelineId,
          name: vals['name'].trim(),
          utm: vals['utm'] ? { utm_campaign: vals['utm'] } : {},
          cost: vals['cost'] ? Number(vals['cost']) : 0,
          priority, distribution_config, duplicacy_config, ...formFields,
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
            <div className="fld"><label>Branch <span className="star">*</span><span className="fhint">{initial ? 'path locked' : 'master'}</span></label>
              {initial ? <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{initial.branch_name ?? ref.branches.find((b) => Number(b.id) === branchId)?.name ?? '—'}</div>
                : <select className="ainp" value={branchId ?? ''} onChange={(e) => { setBranchId(e.target.value ? Number(e.target.value) : undefined); setVerticalId(undefined); setPipelineId(undefined); }}>
                <option value="">Select…</option>{ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>}</div>
            <div className="fld"><label>Vertical <span className="star">*</span><span className="fhint">{initial ? 'path locked' : 'filtered by Branch'}</span></label>
              {initial ? <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{initial.vertical_name ?? ref.verticals.find((v) => Number(v.id) === verticalId)?.name ?? '—'}</div>
                : <select className="ainp" value={verticalId ?? ''} onChange={(e) => { setVerticalId(e.target.value ? Number(e.target.value) : undefined); setPipelineId(undefined); }}>
                <option value="">Select…</option>{verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>}</div>
            <div className="fld"><label>Pipeline <span className="star">*</span><span className="fhint">{initial ? 'path locked' : 'filtered by Vertical'}</span></label>
              {initial ? <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{initial.pipeline_name ?? ref.pipelines.find((p) => Number(p.id) === pipelineId)?.name ?? '—'}</div>
                : <select className="ainp" value={pipelineId ?? ''} onChange={(e) => setPipelineId(e.target.value ? Number(e.target.value) : undefined)}>
                <option value="">Select…</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>}</div>
            <div className="fld"><label>Campaign Type <span className="star">*</span></label>{sel(['Digital', 'Print', 'Event', 'Referral Drive', 'Tele-calling'], vals['type'] ?? '', (x) => setVals((s) => ({ ...s, type: x })))}</div>
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
    </div>
  );
}
