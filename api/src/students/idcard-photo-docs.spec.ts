import 'reflect-metadata';
import { StudentService } from './student.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { parseJpeg, PdfPage, buildPdf } from '../pdf/pdf.util';
import { studentIdCardPdf } from '../pdf/documents';

const scopeAll: ResolvedScope = { permissionKey: 'student.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' };

// a real, tiny 1x1 baseline JPEG (used to prove genuine image embedding)
const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64');

const STUDENT = {
  id: 55, org_id: 1, branch_id: 9, vertical_id: 3, full_name: 'ZZTEST Riya Sharma',
  student_no: 'STU-0055', enrollment_no: 'EN-0055', enrolment_id: 900,
  branch_name: 'Vikaspuri', vertical_name: 'BCL', course_name: 'French A1',
  batch_name: 'Morning A1', dob: '2004-05-01', phone: '+919812345678',
};

function make(over: { photoRow?: any } = {}) {
  const q: Array<{ sql: string; params: unknown[] }> = [];
  let insertId = 700;
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      q.push({ sql, params });
      if (/FROM student s/.test(sql)) return { ...STUDENT };
      if (/FROM organisation/.test(sql)) return { id: 1, name: 'Tech Lingua LLP' };
      if (/SELECT address FROM branch/.test(sql)) return { address: '12 Vikas Marg, New Delhi' };
      if (/doc_type='photo'/.test(sql) || /doc_type = 'photo'/.test(sql)) return over.photoRow ?? null;
      if (/INSERT INTO student_document/.test(sql)) return { id: ++insertId };
      if (/SELECT id, r2_key FROM student_document/.test(sql)) return { id: 810, r2_key: 'students/55/docs/abc-file.pdf' };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      q.push({ sql, params });
      // resolveIdCardVertical — the distinct verticals this student has enrolments in
      if (/FROM enrolment e/.test(sql) && /GROUP BY e\.vertical_id/.test(sql)) {
        return [{ vertical_id: 3, branch_id: 9, vertical_name: 'BCL', branch_name: 'Vikaspuri' }];
      }
      // courses enrolled in the chosen vertical
      if (/SELECT DISTINCT co\.name FROM enrolment/.test(sql)) return [{ name: 'French A1' }, { name: 'French A2' }];
      if (/FROM enrolment e/.test(sql)) return [{ name: 'French A1' }, { name: 'French A2' }];
      return [];
    },
    // transaction — ensureVerticalId runs inside it; return an already-minted vertical-wise id
    tx: async (fn: (c: any) => Promise<any>) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        q.push({ sql, params });
        if (/FROM student_vertical_id/.test(sql)) return { rows: [{ id: 500, student_vertical_no: 'SID-2026-27/0007' }] };
        return { rows: [] };
      },
    }),
  };
  const storage = {
    studentPhotoKey: (sid: number, fn: string) => `students/${sid}/photo/uuid-${fn}`,
    studentDocKey: (o: any) => `students/${o.studentId}/docs/uuid-${o.fileName}`,
    presignPut: async (k: string) => `https://r2.example/put/${k}`,
    presignGet: async (k: string) => `https://r2.example/get/${k}`,
    getObject: async () => ({ body: JPEG_1x1, contentType: 'image/jpeg' }),
    deleteObject: async () => undefined,
  };
  const deleted: string[] = [];
  storage.deleteObject = async (k?: any) => { if (k) deleted.push(String(k)); };
  const pdfAssets = { persist: async () => 'documents/student_id_card/STU-0055.pdf', presignedUrl: async () => 'https://r2.example/idcard.pdf' };
  const svc = new StudentService(db as never, resolver as never, {} as never, undefined, storage as never, undefined, undefined, pdfAssets as never);
  return { svc, q, storage, deleted };
}

const me = { id: 7 };

describe('parseJpeg + PdfPage image embedding', () => {
  it('reads a JPEG geometry and embeds it as a /DCTDecode XObject with a valid xref', () => {
    const info = parseJpeg(JPEG_1x1);
    expect(info).not.toBeNull();
    expect(info!.width).toBeGreaterThan(0);
    const p = new PdfPage();
    expect(p.image(JPEG_1x1, 40, 40, 100, 120)).toBe(true);
    const s = buildPdf([p]).toString('latin1');
    expect(s).toContain('/Subtype /Image');
    expect(s).toContain('/DCTDecode');
    expect(s).toContain('/XObject');
    // structural: startxref points at the xref table
    const at = Number(/startxref\s+(\d+)/.exec(s)![1]);
    expect(s.slice(at, at + 4)).toBe('xref');
  });
  it('returns null for non-JPEG bytes (PNG etc.) so the caller can fall back', () => {
    expect(parseJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe('StudentService — photo upload', () => {
  it('rejects a non-image content_type', async () => {
    const { svc } = make();
    await expect(svc.photoUploadUrl(55, { file_name: 'a.txt', content_type: 'text/plain' }, scopeAll)).rejects.toThrow(/JPG|PNG|image/i);
  });
  it('returns a presigned PUT url + key for a JPG', async () => {
    const { svc } = make();
    const r = await svc.photoUploadUrl(55, { file_name: 'me.jpg', content_type: 'image/jpeg' }, scopeAll);
    expect(r.r2_key).toBe('students/55/photo/uuid-me.jpg');
    expect(r.url).toContain('put');
  });
  it('attach supersedes prior photo, inserts doc_type=photo with r2_key, returns photo_url', async () => {
    const { svc, q } = make();
    const r = await svc.attachPhoto(55, { r2_key: 'students/55/photo/uuid-me.jpg', file_name: 'me.jpg', mime: 'image/jpeg', size_bytes: 1234 }, me, scopeAll);
    expect(r.photo_url).toContain('get');
    const upd = q.find((x) => /UPDATE student_document SET deleted_at/.test(x.sql) && /doc_type = 'photo'/.test(x.sql));
    expect(upd).toBeTruthy();
    const ins = q.find((x) => /INSERT INTO student_document/.test(x.sql));
    expect(ins!.params).toContain('students/55/photo/uuid-me.jpg');
  });
  it('attach rejects an r2_key that is not under this student photo prefix', async () => {
    const { svc } = make();
    await expect(svc.attachPhoto(55, { r2_key: 'students/99/photo/x.jpg' }, me, scopeAll)).rejects.toThrow(/r2_key/i);
  });
});

describe('StudentService — document upload + delete', () => {
  it('attach stores an r2_key document row (bytes stay in R2)', async () => {
    const { svc, q } = make();
    const r = await svc.attachDocument(55, { r2_key: 'students/55/docs/uuid-aadhaar.pdf', file_name: 'aadhaar.pdf', mime: 'application/pdf', size_bytes: 4096, doc_type: 'aadhaar' }, me, scopeAll);
    expect(r.doc_type).toBe('aadhaar');
    const ins = q.find((x) => /INSERT INTO student_document/.test(x.sql));
    expect(ins!.params).toContain('students/55/docs/uuid-aadhaar.pdf');
    // content column is NULL (R2-only, never a DB blob)
    expect(/,NULL,/.test(ins!.sql)).toBe(true);
  });
  it('rejects a non PDF/JPG/PNG document', async () => {
    const { svc } = make();
    await expect(svc.attachDocument(55, { r2_key: 'students/55/docs/x.exe', mime: 'application/x-msdownload' }, me, scopeAll)).rejects.toThrow(/PDF|JPG|PNG/i);
  });
  it('delete by PK soft-deletes the row AND purges the R2 object', async () => {
    const { svc, q, deleted } = make();
    const r = await svc.removeDocument(55, 810, me, scopeAll);
    expect(r.deleted).toBe(true);
    expect(q.some((x) => /UPDATE student_document SET deleted_at/.test(x.sql))).toBe(true);
    expect(deleted).toContain('students/55/docs/abc-file.pdf');
  });
});

describe('StudentService — ID card', () => {
  it('generates a real PDF with the course + branch>vertical, persisted to R2', async () => {
    const { svc } = make({ photoRow: { r2_key: 'students/55/photo/uuid-me.jpg' } });
    const { buffer, r2_key } = await svc.idCard(55, scopeAll);
    const s = buffer.toString('latin1');
    expect(s.startsWith('%PDF-')).toBe(true);
    expect(s).toContain('French A1');            // active course in this vertical
    expect(s).toContain('Vikaspuri');            // branch
    expect(s).toContain('SID-2026-27/0007');     // VERTICAL-WISE student id (client feedback)
    expect(r2_key).toContain('student_id_card');
  });
});

describe('studentIdCardPdf falls back to initials when no photo', () => {
  it('still produces a valid PDF (placeholder) without a photo', () => {
    const buf = studentIdCardPdf({ student_name: 'Asha Rao', student_no: 'STU-1', courses: ['German A1'], branch_name: 'Janakpuri', vertical_name: 'BCL' }, { org_name: 'Tech Lingua LLP' });
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-')).toBe(true);
    expect(s).toContain('German A1');
  });
});
