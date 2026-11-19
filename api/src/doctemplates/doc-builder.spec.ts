import { DOC_TYPES, docTypeDef } from './builder-catalog';
import { defaultDocConfig, fillDocVars, sanitizeDocConfig } from './builder-config';
import { sampleDocData } from './builder-data';
import { renderDoc } from './builder-render';
import { DocBuilderService } from './doc-builder.service';

/** Client 12 Nov 2026 — the document builder for every template. */
describe('document builder catalogue + config', () => {
  it('covers the client\'s documents, grouped by module', () => {
    const t = DOC_TYPES.map((d) => `${d.module}:${d.type}`);
    for (const x of ['Finance:fee_receipt', 'Finance:quotation', 'Students:student_id', 'Students:admission_form', 'Academics:marksheet',
      'Academics:report_card', 'HR:employee_id', 'HR:offer_letter', 'Certificates:certificate', 'Certificates:experience_certificate']) {
      expect(t).toContain(x);
    }
  });

  it('a field can be hidden, renamed and reordered — never invented; groups likewise', () => {
    const cfg = sanitizeDocConfig('fee_receipt', {
      groups: [{ key: 'balance', title: 'Dues', fields: [{ key: 'outstanding', label: 'Balance due', visible: true }, { key: 'evil', label: 'x' }] },
        { key: 'nope', title: 'x', fields: [] }],
    });
    expect(cfg.groups[0].key).toBe('balance');
    expect(cfg.groups[0].title).toBe('Dues');
    expect(cfg.groups[0].fields[0]).toEqual({ key: 'outstanding', label: 'Balance due', visible: true });
    expect(cfg.groups[0].fields.some((f) => f.key === 'evil')).toBe(false);
    expect(cfg.groups.some((g) => g.key === 'nope')).toBe(false);
    // every catalogue group is still present (appended)
    expect(cfg.groups.map((g) => g.key).sort()).toEqual(docTypeDef('fee_receipt')!.groups.map((g) => g.key).sort());
  });

  it('only JPEG data URLs are kept as images, colours validated, custom fields capped', () => {
    const cfg = sanitizeDocConfig('certificate', {
      branding: { logo: 'data:image/png;base64,AAAA', accent: 'red', header_bg: '#123ABC' },
      footer: { signatories: [{ label: 'A', image: 'data:image/jpeg;base64,/9j/AA==' }, { label: 'B' }, { label: 'C' }, { label: 'D' }] },
      custom_fields: Array.from({ length: 30 }, (_, i) => ({ label: `L${i}`, value: 'v' })),
    });
    expect(cfg.branding.logo).toBe('');
    expect(cfg.branding.accent).toBe(defaultDocConfig('certificate').branding.accent);
    expect(cfg.branding.header_bg).toBe('#123abc');
    expect(cfg.footer.signatories).toHaveLength(3);
    expect(cfg.footer.signatories[0].image).toContain('data:image/jpeg');
    expect(cfg.custom_fields).toHaveLength(20);
  });

  it('{{variables}} fill from the record, unknown ones stay visible', () => {
    expect(fillDocVars('Dear {{employee_name}}, {{nope}}', { employee_name: 'Ankit' })).toBe('Dear Ankit, {{nope}}');
  });
});

describe('the shared renderer', () => {
  it.each(DOC_TYPES.map((d) => [d.type]))('%s renders a valid PDF from sample data (with QR / barcode where on)', (type) => {
    const cfg = defaultDocConfig(type as any);
    cfg.footer.show_qr = true; cfg.footer.show_barcode = true;
    const pdf = renderDoc(type as any, cfg, sampleDocData(type as any));
    const head = pdf.subarray(0, 8).toString('latin1');
    expect(head.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.subarray(pdf.length - 6).toString('latin1')).toContain('%%EOF');
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('an ID card prints on a CR80 page; a certificate on landscape A4', () => {
    const card = renderDoc('student_id', defaultDocConfig('student_id'), sampleDocData('student_id')).toString('latin1');
    expect(card).toMatch(/\/MediaBox \[0 0 153\.07 242\.65\]/);
    const cert = renderDoc('certificate', defaultDocConfig('certificate'), sampleDocData('certificate')).toString('latin1');
    expect(cert).toMatch(/\/MediaBox \[0 0 841\.89 595\.28\]/);
  });

  it('a long marksheet breaks onto more pages', () => {
    const d = sampleDocData('marksheet');
    d.tables.subjects = Array.from({ length: 80 }, (_, i) => ({ subject: `Module ${i + 1}`, max_marks: '25', obtained: '20', grade: 'A', percentage: '80%' }));
    const pdf = renderDoc('marksheet', defaultDocConfig('marksheet'), d).toString('latin1');
    expect((pdf.match(/\/Type \/Page /g) ?? []).length).toBeGreaterThan(1);
  });
});

describe('template hierarchy + approval', () => {
  const mk = (rows: Record<string, any> = {}) => {
    const calls: Array<{ sql: string; p: unknown[] }> = [];
    const db: any = {
      query: jest.fn(async (sql: string, p: unknown[] = []) => { calls.push({ sql, p }); return []; }),
      one: jest.fn(async (sql: string, p: unknown[] = []) => {
        calls.push({ sql, p });
        if (/FROM doc_builder_template WHERE id = \$1/.test(sql)) return rows.tpl ?? null;
        return null;
      }),
      tx: jest.fn(),
    };
    return { svc: new DocBuilderService(db), calls };
  };

  it('resolve picks the most specific published, effective template (course > vertical > branch > organisation)', async () => {
    const { svc, calls } = mk();
    await svc.resolve('fee_receipt', { branch_id: 40, vertical_id: 38, course_id: 55 }, '2026-11-19');
    const q = calls.find((c) => /FROM doc_builder_template t JOIN doc_builder_template_version/.test(c.sql))!;
    expect(q.sql).toContain(`t.status = 'published'`);
    expect(q.sql).toContain('t.effective_from IS NULL OR t.effective_from <= $5::date');
    expect(q.sql).toMatch(/\(t\.course_id IS NOT NULL\) DESC, \(t\.vertical_id IS NOT NULL\) DESC, \(t\.branch_id IS NOT NULL\) DESC,\s+t\.is_default DESC/);
    expect(q.p).toEqual(['fee_receipt', 40, 38, 55, '2026-11-19']);
  });

  it('send back needs a note, and only a pending template can be sent back', async () => {
    await expect(mk({ tpl: { id: 1, status: 'draft' } }).svc.reject(1, 'x', { id: 2 })).rejects.toThrow(/waiting for approval/);
    await expect(mk({ tpl: { id: 1, status: 'pending' } }).svc.reject(1, ' ', { id: 2 })).rejects.toThrow(/what needs changing/);
  });

  it('only a published template can become the default', async () => {
    await expect(mk({ tpl: { id: 1, status: 'draft' } }).svc.setDefault(1, { id: 2 })).rejects.toThrow(/Publish/);
  });

  it('an unknown document type is refused', async () => {
    await expect(mk().svc.create({ doc_type: 'payslip' }, { id: 1 })).rejects.toThrow(/Unknown document type/);
  });
});
