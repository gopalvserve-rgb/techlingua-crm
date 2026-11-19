/**
 * DOCUMENT BUILDER CATALOGUE — client 12 Nov 2026 ("need to create builder to customise fields").
 *
 * Every document the institute prints, grouped by module as the client asked:
 *   Finance       Fee Invoice (its own builder, 5 Nov) · Fee Receipt · Quotation
 *   Students      Student ID Card · Admission Form
 *   Academics     Marksheet · Report Card
 *   HR            Employee ID Card · Offer Letter
 *   Certificates  Course / Completion Certificate · Experience Certificate
 *
 * For each: the FIELD GROUPS from the client's lists (a builder can hide, rename and reorder any
 * field, and hide / reorder / retitle any group — never invent one), the tables it can show, the
 * page it prints on, and a default body text with {{variables}} where the document is a letter.
 * Every value comes from the record (builder-data.ts) — a template never computes data.
 */

export type DocType = 'fee_receipt' | 'quotation' | 'student_id' | 'admission_form' | 'marksheet' | 'report_card'
  | 'employee_id' | 'offer_letter' | 'certificate' | 'experience_certificate';
export type PageKind = 'A4' | 'CARD';

export interface CatField { key: string; label: string; visible: boolean }
export interface CatGroup { key: string; title: string; fields: CatField[] }
export interface CatTable { key: string; title: string; columns: CatField[] }
export interface DocTypeDef {
  type: DocType; label: string; module: 'Finance' | 'Students' | 'Academics' | 'HR' | 'Certificates';
  source: string;               // what record it prints, for the UI
  page: PageKind; orientation: 'portrait' | 'landscape';
  title: string;
  groups: CatGroup[];
  tables: CatTable[];
  body?: string;                // letter / certificate wording, {{field_key}} variables
  qr_default: boolean; barcode_default: boolean;
  signatories: string[];
}

const f = (key: string, label: string, visible = true): CatField => ({ key, label, visible });

export const DOC_TYPES: DocTypeDef[] = [
  {
    type: 'fee_receipt', label: 'Fee Receipt', module: 'Finance', source: 'a fee receipt', page: 'A4', orientation: 'portrait',
    title: 'FEE RECEIPT',
    groups: [
      { key: 'receipt', title: 'Receipt', fields: [f('receipt_no', 'Receipt No.'), f('receipt_date', 'Date'), f('transaction_id', 'Transaction ID')] },
      { key: 'student', title: 'Student', fields: [f('student_name', 'Name'), f('student_id', 'Student ID'), f('roll_no', 'Roll No.'),
        f('enrollment_no', 'Enrolment No.'), f('student_mobile', 'Mobile')] },
      { key: 'course', title: 'Course', fields: [f('course_name', 'Course'), f('batch_name', 'Batch'), f('vertical_name', 'Vertical')] },
      { key: 'payment', title: 'Payment', fields: [f('amount_received', 'Amount received'), f('amount_words', 'In words'), f('payment_mode', 'Payment mode')] },
      { key: 'balance', title: 'Balance', fields: [f('total_fee', 'Total fee'), f('paid_till_date', 'Paid till date'), f('outstanding', 'Outstanding')] },
      { key: 'footer', title: 'Received', fields: [f('received_by', 'Received by')] },
    ],
    tables: [{ key: 'allocation', title: 'Allocation', columns: [f('invoice_no', 'Invoice No.'), f('fee_component', 'Fee component'), f('amount', 'Amount')] }],
    qr_default: false, barcode_default: false, signatories: ['Authorised Signatory'],
  },
  {
    type: 'quotation', label: 'Quotation', module: 'Finance', source: 'a quotation', page: 'A4', orientation: 'portrait',
    title: 'QUOTATION',
    groups: [
      { key: 'quote', title: 'Quotation', fields: [f('quote_no', 'Quotation No.'), f('quote_date', 'Date'), f('valid_until', 'Valid until'),
        f('quote_status', 'Status'), f('payment_terms', 'Payment terms')] },
      { key: 'customer', title: 'Customer', fields: [f('customer_name', 'Name'), f('customer_mobile', 'Mobile'), f('customer_email', 'Email')] },
      { key: 'sales', title: 'Sales representative', fields: [f('sales_rep', 'Counsellor'), f('sales_rep_phone', 'Phone', false)] },
      { key: 'totals', title: 'Totals', fields: [f('course_fee', 'Course fee'), f('discount', 'Discount'), f('tax', 'Tax'), f('total', 'Total payable'), f('total_words', 'In words', false)] },
    ],
    tables: [{ key: 'lines', title: 'Course / service', columns: [f('description', 'Course / service'), f('qty', 'Qty'), f('rate', 'Course fee'),
      f('discount', 'Discount'), f('tax', 'Tax'), f('amount', 'Amount')] }],
    qr_default: false, barcode_default: false, signatories: ['Authorised Signatory'],
  },
  {
    type: 'student_id', label: 'Student ID Card', module: 'Students', source: 'a student (per vertical)', page: 'CARD', orientation: 'portrait',
    title: 'STUDENT IDENTITY CARD',
    groups: [
      { key: 'identity', title: 'Identity', fields: [f('photo', 'Photo'), f('student_name', 'Name'), f('student_id', 'Student ID')] },
      { key: 'academic', title: 'Academic', fields: [f('course_name', 'Course'), f('level', 'Level', false), f('batch_name', 'Batch'), f('session', 'Session', false)] },
      { key: 'institute', title: 'Institute', fields: [f('branch_name', 'Branch'), f('vertical_name', 'Vertical', false)] },
      { key: 'validity', title: 'Validity', fields: [f('issue_date', 'Issued'), f('expiry_date', 'Valid till')] },
      { key: 'contact', title: 'Contact', fields: [f('student_mobile', 'Mobile'), f('emergency_contact', 'Emergency', false), f('blood_group', 'Blood group', false)] },
    ],
    tables: [], qr_default: true, barcode_default: false, signatories: ['Authorised Signatory'],
  },
  {
    type: 'admission_form', label: 'Admission Form', module: 'Students', source: 'an admission (online application)', page: 'A4', orientation: 'portrait',
    title: 'ADMISSION FORM',
    groups: [
      { key: 'application', title: 'Application', fields: [f('admission_no', 'Admission No.'), f('application_date', 'Applied on'), f('admission_status', 'Status'),
        f('course_name', 'Course'), f('branch_name', 'Branch'), f('vertical_name', 'Vertical')] },
      { key: 'student', title: 'Student', fields: [f('student_name', 'Full name'), f('dob', 'Date of birth'), f('gender', 'Gender'), f('nationality', 'Nationality', false)] },
      { key: 'contact', title: 'Contact', fields: [f('student_mobile', 'Mobile'), f('whatsapp', 'WhatsApp', false), f('student_email', 'Email'), f('address', 'Address')] },
      { key: 'guardian', title: 'Parent / Guardian', fields: [f('father_name', 'Father'), f('father_mobile', 'Father mobile'), f('guardian_name', 'Guardian', false), f('guardian_mobile', 'Guardian mobile', false)] },
      { key: 'education', title: 'Education', fields: [f('qualification', 'Qualification'), f('institution', 'Institution'), f('passing_year', 'Passing year')] },
      { key: 'ids', title: 'ID proofs', fields: [f('aadhaar', 'Aadhaar', false), f('pan', 'PAN', false), f('passport', 'Passport', false)] },
    ],
    tables: [{ key: 'documents', title: 'Documents submitted', columns: [f('doc_type', 'Document'), f('file_name', 'File')] }],
    body: 'I declare that the information given above is true to the best of my knowledge.',
    qr_default: false, barcode_default: false, signatories: ['Applicant', 'Admissions Officer'],
  },
  {
    type: 'marksheet', label: 'Marksheet', module: 'Academics', source: 'an assessment attempt', page: 'A4', orientation: 'portrait',
    title: 'STATEMENT OF MARKS',
    groups: [
      { key: 'student', title: 'Student', fields: [f('photo', 'Photo', false), f('student_name', 'Name'), f('student_id', 'Student ID')] },
      { key: 'programme', title: 'Programme', fields: [f('course_name', 'Course'), f('level', 'Level', false), f('batch_name', 'Batch')] },
      { key: 'exam', title: 'Examination', fields: [f('exam_name', 'Examination'), f('exam_date', 'Date'), f('session', 'Session', false)] },
      { key: 'result', title: 'Result', fields: [f('percentage', 'Percentage'), f('grade', 'Grade'), f('result', 'Result'), f('rank', 'Rank', false), f('remarks', 'Remarks', false)] },
      { key: 'authorization', title: 'Authorisation', fields: [f('trainer', 'Trainer'), f('academic_head', 'Academic head', false)] },
    ],
    tables: [{ key: 'subjects', title: 'Subjects', columns: [f('subject', 'Subject / module'), f('max_marks', 'Maximum marks'),
      f('obtained', 'Obtained'), f('grade', 'Grade'), f('percentage', '%')] }],
    qr_default: true, barcode_default: false, signatories: ['Trainer', 'Academic Head'],
  },
  {
    type: 'report_card', label: 'Report Card', module: 'Academics', source: 'a report card', page: 'A4', orientation: 'portrait',
    title: 'REPORT CARD',
    groups: [
      { key: 'student', title: 'Student', fields: [f('photo', 'Photo', false), f('student_name', 'Name'), f('student_id', 'Student ID')] },
      { key: 'programme', title: 'Programme', fields: [f('course_name', 'Course'), f('batch_name', 'Batch'), f('term', 'Term'), f('period', 'Period')] },
      { key: 'result', title: 'Result', fields: [f('overall_pct', 'Overall %'), f('grade', 'Grade'), f('remarks', 'Remarks')] },
      { key: 'authorization', title: 'Authorisation', fields: [f('trainer', 'Trainer', false), f('academic_head', 'Academic head', false)] },
    ],
    tables: [{ key: 'subjects', title: 'Performance', columns: [f('subject', 'Area'), f('detail', 'Detail'), f('percentage', '%')] }],
    qr_default: true, barcode_default: false, signatories: ['Trainer', 'Academic Head'],
  },
  {
    type: 'employee_id', label: 'Employee ID Card', module: 'HR', source: 'an employee', page: 'CARD', orientation: 'portrait',
    title: 'EMPLOYEE IDENTITY CARD',
    groups: [
      { key: 'identity', title: 'Identity', fields: [f('photo', 'Photo'), f('employee_name', 'Name'), f('employee_id', 'Employee ID')] },
      { key: 'job', title: 'Job', fields: [f('designation', 'Designation'), f('department', 'Department'), f('branch_name', 'Branch'), f('joining_date', 'Joined', false)] },
      { key: 'contact', title: 'Contact', fields: [f('employee_mobile', 'Mobile'), f('employee_email', 'Email', false), f('emergency_contact', 'Emergency', false)] },
    ],
    tables: [], qr_default: true, barcode_default: true, signatories: ['Authorised Signatory'],
  },
  {
    type: 'offer_letter', label: 'Offer Letter', module: 'HR', source: 'an employee', page: 'A4', orientation: 'portrait',
    title: 'OFFER LETTER',
    groups: [
      { key: 'letter', title: 'Letter', fields: [f('letter_date', 'Date'), f('employee_name', 'To'), f('employee_id', 'Employee ID', false)] },
      { key: 'job', title: 'Appointment', fields: [f('designation', 'Designation'), f('department', 'Department'), f('branch_name', 'Location'),
        f('joining_date', 'Date of joining'), f('employment_type', 'Employment type'), f('reporting_manager', 'Reporting to')] },
    ],
    tables: [],
    body: 'Dear {{employee_name}},\n\nWe are pleased to offer you the position of {{designation}} in the {{department}} department at {{institute_name}}, {{branch_name}}. Your date of joining will be {{joining_date}} and you will report to {{reporting_manager}}.\n\nPlease sign and return a copy of this letter as your acceptance.\n\nWe look forward to working with you.',
    qr_default: false, barcode_default: false, signatories: ['HR Manager', 'Accepted by the candidate'],
  },
  {
    type: 'certificate', label: 'Course / Completion Certificate', module: 'Certificates', source: 'an issued certificate', page: 'A4', orientation: 'landscape',
    title: 'CERTIFICATE OF COMPLETION',
    groups: [
      { key: 'certificate', title: 'Certificate', fields: [f('certificate_no', 'Certificate No.'), f('issue_date', 'Issued on')] },
      { key: 'student', title: 'Student', fields: [f('student_name', 'Name'), f('student_id', 'Student ID', false)] },
      { key: 'course', title: 'Programme', fields: [f('course_name', 'Course / programme'), f('level', 'Level', false), f('completion_date', 'Completed on'),
        f('duration', 'Duration', false), f('grade', 'Grade / result', false), f('branch_name', 'Branch', false), f('vertical_name', 'Vertical', false)] },
    ],
    tables: [],
    body: 'This is to certify that {{student_name}} has successfully completed the {{course_name}} programme at {{institute_name}}.',
    qr_default: true, barcode_default: false, signatories: ['Academic Head', 'Director'],
  },
  {
    type: 'experience_certificate', label: 'Experience Certificate', module: 'Certificates', source: 'an employee', page: 'A4', orientation: 'portrait',
    title: 'EXPERIENCE CERTIFICATE',
    groups: [
      { key: 'letter', title: 'Certificate', fields: [f('letter_date', 'Date'), f('employee_id', 'Employee ID')] },
      { key: 'job', title: 'Employment', fields: [f('employee_name', 'Name'), f('designation', 'Designation'), f('department', 'Department'),
        f('joining_date', 'Joined on'), f('relieving_date', 'Relieved on')] },
    ],
    tables: [],
    body: 'This is to certify that {{employee_name}} worked with {{institute_name}} as {{designation}} in the {{department}} department from {{joining_date}} to {{relieving_date}}.\n\nDuring this period we found their conduct and work satisfactory. We wish them every success.',
    qr_default: true, barcode_default: false, signatories: ['HR Manager'],
  },
];

export const MODULES = ['Finance', 'Students', 'Academics', 'HR', 'Certificates'] as const;
export const docTypeDef = (t: string): DocTypeDef | undefined => DOC_TYPES.find((d) => d.type === t);
