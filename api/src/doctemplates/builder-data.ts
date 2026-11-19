import { amountInWordsINR, formatINR } from '../common/money.util';
import { DocType } from './builder-catalog';
import { DocData } from './builder-render';

/**
 * WHAT A DOCUMENT SAYS — one loader per document type (client 12 Nov 2026 builder). Each reads the
 * record by id and returns the field values the client listed, plus the context (branch /
 * vertical / course) the template hierarchy resolves on. The CALLER has already checked the user
 * may see the record (the existing generator, or the builder's scoped preview).
 */
type Db = { one: (sql: string, p?: unknown[]) => Promise<any>; query: (sql: string, p?: unknown[]) => Promise<any[]> };
export interface Loaded { data: DocData; ctx: { branch_id: number | null; vertical_id: number | null; course_id: number | null } }

const rs = (minor: unknown) => `Rs. ${formatINR(Number(minor ?? 0), { symbol: false })}`;
const d = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
const s = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', online: 'Online transfer', bank: 'Bank transfer' };

/** The issuing institute: the vertical is the brand; the branch is where you walk in. */
async function institute(db: Db, branchId: unknown, verticalId: unknown): Promise<Record<string, string>> {
  const r = await db.one(
    `SELECT o.name AS org_name, b.name AS branch_name, b.address AS b_address, b.contact_number AS b_phone, b.email AS b_email, b.gstin AS b_gstin,
            v.name AS vertical_name, v.display_name, v.billing_address, v.phone AS v_phone, v.email AS v_email, v.gstin AS v_gstin
       FROM organisation o
       LEFT JOIN branch b ON b.id = $1::bigint
       LEFT JOIN vertical v ON v.id = $2::bigint
      ORDER BY o.id LIMIT 1`, [num(branchId), num(verticalId)]);
  return {
    institute_name: s(r?.display_name || r?.vertical_name || r?.org_name), branch_name: s(r?.branch_name), vertical_name: s(r?.vertical_name),
    institute_address: s(r?.billing_address || r?.b_address), institute_phone: s(r?.v_phone || r?.b_phone), institute_email: s(r?.v_email || r?.b_email),
    institute_gstin: s(r?.v_gstin || r?.b_gstin),
  };
}

const base = (fields: Record<string, string>, doc_no: string, holder: string, tables: DocData['tables'] = {}): DocData =>
  ({ fields, tables, doc_no, holder, barcode: doc_no || null });

export async function loadDocData(db: Db, type: DocType, refId: number): Promise<Loaded | null> {
  switch (type) {
    case 'fee_receipt': {
      const r = await db.one(
        `SELECT fr.*, e.enrolment_no, e.net_fee_minor, COALESCE(e.exam_fee_minor, 0) AS exam_fee_minor, e.course_id, e.batch_id, e.student_profile_id,
                COALESCE(l.full_name, sp.full_name) AS student_name, COALESCE(l.phone, sp.phone) AS student_phone,
                sp.customer_no, c.name AS course_name, bt.name AS batch_name, u.name AS received_by_name,
                (SELECT svi.student_vertical_no FROM student_vertical_id svi WHERE svi.student_id = e.student_profile_id AND svi.vertical_id = fr.vertical_id LIMIT 1) AS roll_no,
                (SELECT gi.invoice_no FROM gst_invoice gi WHERE gi.enrolment_id = e.id AND gi.deleted_at IS NULL AND gi.invoice_no IS NOT NULL ORDER BY gi.id DESC LIMIT 1) AS invoice_no
           FROM fee_receipt fr JOIN enrolment e ON e.id = fr.enrolment_id
           LEFT JOIN lead l ON l.id = e.lead_id LEFT JOIN student sp ON sp.id = e.student_profile_id
           LEFT JOIN m_course c ON c.id = e.course_id LEFT JOIN batch bt ON bt.id = e.batch_id
           LEFT JOIN "user" u ON u.id = fr.received_by
          WHERE fr.id = $1::bigint AND fr.deleted_at IS NULL`, [refId]);
      if (!r) return null;
      const paid = await db.one(
        `SELECT COALESCE(sum(amount_minor), 0) AS p FROM fee_receipt WHERE enrolment_id = $1 AND deleted_at IS NULL
            AND (received_at < $2::timestamptz OR (received_at = $2::timestamptz AND id <= $3))`, [r.enrolment_id, r.received_at, r.id]);
      const alloc = await db.query(
        `SELECT COALESCE(i.label, 'Instalment ' || i.seq_no) AS comp, ip.amount_minor FROM installment_payment ip
           JOIN installment i ON i.id = ip.installment_id WHERE ip.fee_receipt_id = $1 ORDER BY i.seq_no`, [r.id]);
      const total = Number(r.net_fee_minor) + Number(r.exam_fee_minor);
      const inst = await institute(db, r.branch_id, r.vertical_id);
      const data = base({
        ...inst, receipt_no: s(r.receipt_no), receipt_date: d(r.received_at), transaction_id: s(r.reference),
        student_name: s(r.student_name), student_id: s(r.customer_no), roll_no: s(r.roll_no), enrollment_no: s(r.enrolment_no),
        student_mobile: s(r.student_phone), course_name: s(r.course_name), batch_name: s(r.batch_name),
        amount_received: rs(r.amount_minor), amount_words: amountInWordsINR(Number(r.amount_minor)), payment_mode: MODE[r.mode] ?? s(r.mode),
        total_fee: rs(total), paid_till_date: rs(paid?.p), outstanding: rs(Math.max(0, total - Number(paid?.p ?? 0))),
        received_by: s(r.received_by_name),
      }, s(r.receipt_no), s(r.student_name), {
        allocation: (alloc.length ? alloc : [{ comp: r.course_name ? `Course fee — ${r.course_name}` : 'Course fee', amount_minor: r.amount_minor }])
          .map((a: any) => ({ invoice_no: s(r.invoice_no), fee_component: s(a.comp), amount: rs(a.amount_minor) })),
      });
      return { data, ctx: { branch_id: num(r.branch_id), vertical_id: num(r.vertical_id), course_id: num(r.course_id) } };
    }
    case 'quotation': {
      const q = await db.one(
        `SELECT q.*, l.full_name, l.phone, l.email, u.name AS owner_name, u.phone AS owner_phone
           FROM quotation q LEFT JOIN lead l ON l.id = q.lead_id LEFT JOIN "user" u ON u.id = q.owner_id
          WHERE q.id = $1::bigint AND q.deleted_at IS NULL`, [refId]);
      if (!q) return null;
      const items = await db.query(
        `SELECT qi.*, c.name AS course_name FROM quotation_item qi LEFT JOIN m_course c ON c.id = qi.course_id WHERE qi.quotation_id = $1 ORDER BY qi.line_no`, [refId]);
      const inst = await institute(db, q.branch_id, q.vertical_id);
      const PLAN: Record<string, string> = { full: 'Full payment', installments: 'Instalments', custom: 'Custom schedule' };
      const data = base({
        ...inst, quote_no: `${s(q.quote_no)}${Number(q.version) > 1 ? ` (v${q.version})` : ''}`, quote_date: d(q.created_at), valid_until: d(q.valid_until),
        quote_status: s(q.status).replace(/_/g, ' '), payment_terms: PLAN[q.payment_plan] ?? s(q.payment_plan),
        customer_name: s(q.full_name), customer_mobile: s(q.phone), customer_email: s(q.email), sales_rep: s(q.owner_name), sales_rep_phone: s(q.owner_phone),
        course_fee: rs(q.subtotal_minor), discount: rs(q.discount_minor), tax: rs(q.tax_minor), total: rs(q.total_minor), total_words: amountInWordsINR(Number(q.total_minor)),
      }, s(q.quote_no), s(q.full_name), {
        lines: items.map((i: any) => ({ description: s(i.description || i.course_name), qty: s(i.qty), rate: rs(i.unit_price_minor),
          discount: rs(i.discount_minor), tax: `${Number(i.tax_pct ?? 0)}%`, amount: rs(i.total_minor) })),
      });
      return { data, ctx: { branch_id: num(q.branch_id), vertical_id: num(q.vertical_id), course_id: num(items[0]?.course_id) } };
    }
    case 'student_id': {
      const st = await db.one(
        `SELECT s.*, c.name AS course_name, bt.name AS batch_name,
                (SELECT svi.student_vertical_no FROM student_vertical_id svi WHERE svi.student_id = s.id AND svi.vertical_id = s.vertical_id LIMIT 1) AS roll_no,
                (SELECT string_agg(DISTINCT el.label, ', ') FROM enrolment_level el JOIN enrolment e ON e.id = el.enrolment_id
                  WHERE e.student_profile_id = s.id AND e.deleted_at IS NULL) AS levels
           FROM student s LEFT JOIN m_course c ON c.id = s.course_id LEFT JOIN batch bt ON bt.id = s.batch_id
          WHERE s.id = $1::bigint AND s.deleted_at IS NULL`, [refId]);
      if (!st) return null;
      const inst = await institute(db, st.branch_id, st.vertical_id);
      const issue = new Date(); const exp = new Date(issue); exp.setFullYear(exp.getFullYear() + 1);
      const year = issue.getFullYear();
      const data = base({
        ...inst, student_name: s(st.full_name), student_id: s(st.customer_no || st.roll_no || st.student_no), course_name: s(st.course_name),
        level: s(st.levels), batch_name: s(st.batch_name), session: `${year}–${String(year + 1).slice(2)}`,
        issue_date: d(issue), expiry_date: d(exp), student_mobile: s(st.phone),
        emergency_contact: s(st.guardian_mobile || st.father_mobile), blood_group: s(st.custom_fields?.blood_group),
      }, s(st.customer_no || st.roll_no || st.student_no), s(st.full_name));
      return { data, ctx: { branch_id: num(st.branch_id), vertical_id: num(st.vertical_id), course_id: num(st.course_id) } };
    }
    case 'admission_form': {
      const a = await db.one(
        `SELECT a.*, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name FROM admission a
           LEFT JOIN branch b ON b.id = a.branch_id LEFT JOIN vertical v ON v.id = a.vertical_id LEFT JOIN m_course c ON c.id = a.course_id
          WHERE a.id = $1::bigint AND a.deleted_at IS NULL`, [refId]);
      if (!a) return null;
      const x = a.data ?? {};
      const docs = await db.query(`SELECT doc_type, file_name FROM student_document WHERE admission_id = $1 AND deleted_at IS NULL ORDER BY id`, [refId]).catch(() => []);
      const inst = await institute(db, a.branch_id, a.vertical_id);
      const data = base({
        ...inst, admission_no: s(a.admission_no || `#${a.id}`), application_date: d(a.created_at), admission_status: s(a.status),
        course_name: s(a.course_name || x.course_text), student_name: s(a.full_name), dob: d(x.dob), gender: s(x.gender), nationality: s(x.nationality),
        student_mobile: s(a.phone), whatsapp: s(x.whatsapp_phone), student_email: s(a.email),
        address: [x.address_line1, x.address_line2, x.landmark, x.district, x.pincode, x.country].filter(Boolean).join(', '),
        father_name: s(x.father_name), father_mobile: s(x.father_mobile), guardian_name: s(x.guardian_name), guardian_mobile: s(x.guardian_mobile),
        qualification: s(x.qualification), institution: s(x.institution), passing_year: s(x.passing_year),
        aadhaar: x.aadhaar ? `XXXX XXXX ${String(x.aadhaar).slice(-4)}` : '', pan: s(x.pan), passport: s(x.passport),
      }, s(a.admission_no || `#${a.id}`), s(a.full_name), {
        documents: docs.map((dd: any) => ({ doc_type: s(dd.doc_type).replace(/_/g, ' '), file_name: s(dd.file_name) })),
      });
      return { data, ctx: { branch_id: num(a.branch_id), vertical_id: num(a.vertical_id), course_id: num(a.course_id) } };
    }
    case 'marksheet': {
      const at = await db.one(
        `SELECT at.*, asm.title AS exam_name, s.full_name, s.customer_no, s.student_no, s.course_id, s.batch_id, c.name AS course_name, bt.name AS batch_name,
                tr.name AS trainer_name,
                (SELECT 1 + count(*) FROM assessment_attempt o WHERE o.assessment_id = at.assessment_id AND o.deleted_at IS NULL
                   AND o.total_score > at.total_score) AS rnk
           FROM assessment_attempt at JOIN student s ON s.id = at.student_id
           LEFT JOIN assessment asm ON asm.id = at.assessment_id
           LEFT JOIN m_course c ON c.id = s.course_id LEFT JOIN batch bt ON bt.id = s.batch_id LEFT JOIN "user" tr ON tr.id = bt.trainer_id
          WHERE at.id = $1::bigint AND at.deleted_at IS NULL`, [refId]);
      if (!at) return null;
      const inst = await institute(db, at.branch_id, at.vertical_id);
      const pct = at.percentage != null ? `${Number(at.percentage).toFixed(1)}%` : (Number(at.max_score) > 0 ? `${((Number(at.total_score) * 100) / Number(at.max_score)).toFixed(1)}%` : '');
      const data = base({
        ...inst, student_name: s(at.full_name), student_id: s(at.customer_no || at.student_no), course_name: s(at.course_name), batch_name: s(at.batch_name),
        exam_name: s(at.exam_name), exam_date: d(at.submitted_at || at.evaluated_at), percentage: pct, grade: s(at.grade_label),
        result: at.is_passed == null ? '' : at.is_passed ? 'PASS' : 'FAIL', rank: s(at.rnk), trainer: s(at.trainer_name),
      }, `MS-${at.id}`, s(at.full_name), {
        subjects: [{ subject: s(at.exam_name || 'Assessment'), max_marks: s(at.max_score), obtained: s(at.total_score), grade: s(at.grade_label), percentage: pct }],
      });
      return { data, ctx: { branch_id: num(at.branch_id), vertical_id: num(at.vertical_id), course_id: num(at.course_id) } };
    }
    case 'report_card': {
      const rc = await db.one(
        `SELECT rc.*, s.full_name, s.customer_no, s.student_no, c.name AS course_name, bt.name AS batch_name, tr.name AS trainer_name
           FROM report_card rc JOIN student s ON s.id = rc.student_id
           LEFT JOIN m_course c ON c.id = rc.course_id LEFT JOIN batch bt ON bt.id = rc.batch_id LEFT JOIN "user" tr ON tr.id = bt.trainer_id
          WHERE rc.id = $1::bigint AND rc.deleted_at IS NULL`, [refId]);
      if (!rc) return null;
      const inst = await institute(db, rc.branch_id, rc.vertical_id);
      const p = (v: unknown) => (v == null ? '' : `${Number(v).toFixed(1)}%`);
      const data = base({
        ...inst, student_name: s(rc.full_name), student_id: s(rc.customer_no || rc.student_no), course_name: s(rc.course_name), batch_name: s(rc.batch_name),
        term: s(rc.term), period: [d(rc.period_from), d(rc.period_to)].filter(Boolean).join(' – '), overall_pct: p(rc.overall_pct), grade: s(rc.overall_grade),
        remarks: s(rc.remarks), trainer: s(rc.trainer_name),
      }, `RC-${rc.id}`, s(rc.full_name), {
        subjects: [
          { subject: 'Attendance', detail: rc.attendance_total != null ? `${s(rc.attendance_present)} of ${s(rc.attendance_total)} sessions` : '', percentage: p(rc.attendance_pct) },
          { subject: 'Tests', detail: rc.test_count != null ? `${s(rc.test_count)} tests` : '', percentage: p(rc.test_avg_pct) },
          { subject: 'Assignments', detail: rc.assignment_count != null ? `${s(rc.assignment_count)} assignments` : '', percentage: p(rc.assignment_avg_pct) },
          { subject: 'Overall', detail: s(rc.overall_grade), percentage: p(rc.overall_pct) },
        ].filter((x) => x.percentage || x.detail),
      });
      return { data, ctx: { branch_id: num(rc.branch_id), vertical_id: num(rc.vertical_id), course_id: num(rc.course_id) } };
    }
    case 'employee_id': case 'offer_letter': case 'experience_certificate': {
      const e = await db.one(
        `SELECT e.*, m.name AS manager_name FROM employee e LEFT JOIN employee m ON m.id = e.reporting_manager_id
          WHERE e.id = $1::bigint AND e.deleted_at IS NULL`, [refId]);
      if (!e) return null;
      const inst = await institute(db, e.branch_id, e.vertical_id);
      const active = !e.status || /active|working|probation/i.test(String(e.status));
      const data = base({
        ...inst, employee_name: s(e.name), employee_id: s(e.employee_code), designation: s(e.designation), department: s(e.department),
        joining_date: d(e.date_of_joining), employment_type: s(e.employment_type).replace(/_/g, ' '), reporting_manager: s(e.manager_name),
        employee_mobile: s(e.phone), employee_email: s(e.email), letter_date: d(new Date()),
        relieving_date: active ? 'date' : d(e.updated_at), emergency_contact: '',
      }, s(e.employee_code || `EMP-${e.id}`), s(e.name));
      return { data, ctx: { branch_id: num(e.branch_id), vertical_id: num(e.vertical_id), course_id: null } };
    }
    case 'certificate': {
      const c = await db.one(
        `SELECT ct.*, s.full_name, s.customer_no, s.student_no, c.name AS course_name, bt.name AS batch_name,
                bt.start_date, bt.end_date
           FROM certificate ct JOIN student s ON s.id = ct.student_id
           LEFT JOIN m_course c ON c.id = ct.course_id LEFT JOIN batch bt ON bt.id = ct.batch_id
          WHERE ct.id = $1::bigint AND ct.deleted_at IS NULL`, [refId]);
      if (!c) return null;
      const inst = await institute(db, c.branch_id, c.vertical_id);
      const TITLE: Record<string, string> = { completion: 'CERTIFICATE OF COMPLETION', participation: 'CERTIFICATE OF PARTICIPATION', merit: 'CERTIFICATE OF MERIT' };
      const months = c.start_date && c.end_date ? Math.max(1, Math.round((new Date(c.end_date).getTime() - new Date(c.start_date).getTime()) / (30.4 * 86_400_000))) : null;
      const data = base({
        ...inst, certificate_no: s(c.serial_no), issue_date: d(c.issue_date), student_name: s(c.full_name), student_id: s(c.customer_no || c.student_no),
        course_name: s(c.course_name), completion_date: d(c.issue_date), duration: months ? `${months} month${months === 1 ? '' : 's'}` : '',
        grade: s(c.remarks), certificate_title: TITLE[c.cert_type] ?? s(c.title).toUpperCase(),
      }, s(c.serial_no), s(c.full_name));
      data.revoked = c.status === 'revoked';
      return { data, ctx: { branch_id: num(c.branch_id), vertical_id: num(c.vertical_id), course_id: num(c.course_id) } };
    }
    default: return null;
  }
}

/** Believable sample values for the builder's preview when no record is picked. */
export function sampleDocData(type: DocType): DocData {
  const f: Record<string, string> = {
    institute_name: 'British College of Language', branch_name: 'Vikaspuri', vertical_name: 'BCL', institute_address: 'A-11, 2nd Floor, Vikaspuri, New Delhi 110018',
    institute_phone: '+91 98100 00000', institute_email: 'info@example.com', institute_gstin: '07AAAAA0000A1Z5',
    receipt_no: 'RCPT-2026-0142', receipt_date: '19 Nov 2026', transaction_id: 'UPI 4512 7788 1203', student_name: 'Riya Sharma', student_id: 'STU-000231',
    roll_no: 'BCL-2026-118', enrollment_no: 'ENR-2026-0098', student_mobile: '+91 98112 34567', course_name: 'German A1', batch_name: 'GER-A1-Weekend-Nov',
    amount_received: 'Rs. 12,000.00', amount_words: 'Rupees Twelve Thousand Only', payment_mode: 'UPI', total_fee: 'Rs. 36,000.00', paid_till_date: 'Rs. 24,000.00',
    outstanding: 'Rs. 12,000.00', received_by: 'Asha Rao', quote_no: 'QT-2026-0051', quote_date: '19 Nov 2026', valid_until: '04 Dec 2026', quote_status: 'sent',
    payment_terms: 'Instalments', customer_name: 'Riya Sharma', customer_mobile: '+91 98112 34567', customer_email: 'riya@example.com', sales_rep: 'Asha Rao',
    course_fee: 'Rs. 36,000.00', discount: 'Rs. 2,000.00', tax: 'Rs. 6,120.00', total: 'Rs. 40,120.00', total_words: 'Rupees Forty Thousand One Hundred Twenty Only',
    level: 'A1', session: '2026–27', issue_date: '19 Nov 2026', expiry_date: '19 Nov 2027', emergency_contact: '+91 98100 11111', blood_group: 'B+',
    admission_no: 'ADM-2026-0077', application_date: '18 Nov 2026', admission_status: 'pending', dob: '12 Mar 2004', gender: 'Female', nationality: 'Indian',
    whatsapp: '+91 98112 34567', student_email: 'riya@example.com', address: 'C-4, Janakpuri, New Delhi 110058', father_name: 'Rakesh Sharma',
    father_mobile: '+91 98100 22222', qualification: 'B.Com', institution: 'Delhi University', passing_year: '2025',
    exam_name: 'German A1 — Final Assessment', exam_date: '15 Nov 2026', percentage: '86.0%', grade: 'A', result: 'PASS', rank: '3', trainer: 'Klaus Weber',
    academic_head: 'Dr. Meera Kapoor', term: 'Term 1', period: '01 Aug 2026 – 15 Nov 2026', overall_pct: '84.5%', remarks: 'Consistent and attentive.',
    employee_name: 'Ankit Verma', employee_id: 'EMP-0042', designation: 'Senior Counsellor', department: 'Admissions', joining_date: '01 Dec 2026',
    employment_type: 'full time', reporting_manager: 'Puneet Thakkar', employee_mobile: '+91 98110 33333', employee_email: 'ankit@example.com',
    letter_date: '19 Nov 2026', relieving_date: '30 Sep 2026', certificate_no: 'CERT-BCL-2026-0019', completion_date: '15 Nov 2026', duration: '4 months',
    certificate_title: 'CERTIFICATE OF COMPLETION',
  };
  const tables: DocData['tables'] = {
    allocation: [{ invoice_no: 'INV/26-27/0088', fee_component: 'Instalment 2', amount: 'Rs. 12,000.00' }],
    lines: [{ description: 'German A1 (Weekend)', qty: '1', rate: 'Rs. 36,000.00', discount: 'Rs. 2,000.00', tax: '18%', amount: 'Rs. 40,120.00' }],
    documents: [{ doc_type: 'photo', file_name: 'riya.jpg' }, { doc_type: 'aadhaar', file_name: 'aadhaar.pdf' }],
    subjects: type === 'report_card'
      ? [{ subject: 'Attendance', detail: '38 of 42 sessions', percentage: '90.5%' }, { subject: 'Tests', detail: '4 tests', percentage: '82.0%' }, { subject: 'Overall', detail: 'A', percentage: '84.5%' }]
      : [{ subject: 'Listening', max_marks: '25', obtained: '22', grade: 'A', percentage: '88.0%' }, { subject: 'Reading', max_marks: '25', obtained: '21', grade: 'A', percentage: '84.0%' },
        { subject: 'Writing', max_marks: '25', obtained: '20', grade: 'B+', percentage: '80.0%' }, { subject: 'Speaking', max_marks: '25', obtained: '23', grade: 'A+', percentage: '92.0%' }],
  };
  const holder = /employee|offer|experience/.test(type) ? f.employee_name : f.student_name;
  return { fields: f, tables, doc_no: 'SAMPLE-0001', holder, barcode: 'SAMPLE-0001', verify_url: 'https://example.com/verify/SAMPLE' };
}
