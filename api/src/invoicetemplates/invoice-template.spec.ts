import { inflateSync } from 'zlib';
import { COLUMN_CATALOG, defaultConfig, fillVars, sanitizeConfig } from './template-config';
import { sampleTplData } from './template-data';
import { renderInvoiceTemplate } from './template-render';
import { InvoiceTemplateService } from './invoice-template.service';

/** client 5 Nov 2026 — Fee Invoice Template Builder. */
const pdfText = (buf: Buffer) => {
  const raw = buf.toString('latin1');
  // the writer emits uncompressed content streams; pull every (string) Tj
  return [...raw.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1')).join(' | ');
};
void inflateSync;

describe('sanitizeConfig', () => {
  it('fills a missing / junk config with the professional default', () => {
    const c = sanitizeConfig({ junk: true, layout: 'nope' });
    expect(c.layout).toBe('professional');
    expect(c.columns.map((x) => x.key)).toEqual(COLUMN_CATALOG.map((x) => x.key));
    expect((c as any).junk).toBeUndefined();
  });

  it('keeps the saved ORDER, labels and visibility, drops unknown keys, appends missing ones', () => {
    const c = sanitizeConfig({
      columns: [{ key: 'total', label: 'Net Amount', visible: true }, { key: 'evil', label: 'x', visible: true }, { key: 'sno', label: '#', visible: false }],
      sections: [{ key: 'summary', visible: true }, { key: 'header', visible: true }],
    });
    expect(c.columns.slice(0, 2)).toEqual([{ key: 'total', label: 'Net Amount', visible: true }, { key: 'sno', label: '#', visible: false }]);
    expect(c.columns.some((x) => (x.key as string) === 'evil')).toBe(false);
    expect(c.columns).toHaveLength(COLUMN_CATALOG.length);
    expect(c.sections.slice(0, 2).map((s) => s.key)).toEqual(['summary', 'header']);
  });

  it('accepts only #rrggbb colours and JPEG data URLs (no script, no remote image)', () => {
    const c = sanitizeConfig({ branding: { accent: 'red;background:url(x)', logo: 'https://evil/logo.png', header_bg: '#FF0000' },
      footer: { upi_qr: 'data:image/png;base64,AAAA', stamp_img: 'data:image/jpeg;base64,/9j/4AAQ' } });
    expect(c.branding.accent).toBe('#4f46e5');
    expect(c.branding.header_bg).toBe('#ff0000');
    expect(c.branding.logo).toBe('');
    expect(c.footer.upi_qr).toBe('');
    expect(c.footer.stamp_img).toBe('data:image/jpeg;base64,/9j/4AAQ');
  });

  it('fills {{variables}} and leaves unknown ones visible', () => {
    expect(fillVars('Dear {{student_name}}, ref {{ nope }}', { student_name: 'Riya' })).toBe('Dear Riya, ref {{ nope }}');
  });
});

describe('renderInvoiceTemplate', () => {
  it('renders a PDF with the configured title, labels, and the student / totals data', () => {
    const cfg = defaultConfig('professional');
    cfg.branding.title = 'FEE INVOICE';
    cfg.branding.institute_name = 'British College of Language';
    cfg.summary.find((s) => s.key === 'grand_total')!.label = 'Total Payable';
    const buf = renderInvoiceTemplate(cfg, sampleTplData('intra'));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const t = pdfText(buf);
    expect(t).toContain('FEE INVOICE');
    expect(t).toContain('British College of Language');
    expect(t).toContain('Riya Sharma');
    expect(t).toContain('Total Payable (INR)');
    expect(t).toContain('20,500.00');
  });

  it('GST columns are conditional: CGST + SGST intra-state, IGST inter-state', () => {
    const cfg = defaultConfig('professional');
    const intra = pdfText(renderInvoiceTemplate(cfg, sampleTplData('intra')));
    const inter = pdfText(renderInvoiceTemplate(cfg, sampleTplData('inter')));
    expect(intra).toContain('CGST'); expect(intra).not.toContain('IGST');
    expect(inter).toContain('IGST'); expect(inter).not.toContain('CGST');
  });

  it('a hidden section or column does not print; order follows the config', () => {
    const cfg = defaultConfig('professional');
    cfg.sections.find((s) => s.key === 'payment')!.visible = false;
    cfg.columns.find((c) => c.key === 'hsn_sac')!.visible = false;
    const t = pdfText(renderInvoiceTemplate(cfg, sampleTplData('intra')));
    expect(t).not.toContain('PAYMENT DETAILS');
    expect(t).not.toContain('HSN/SAC');
    expect(t).toContain('FEE DETAILS');
  });

  it('a long fee table flows onto more pages with "Page x of n"', () => {
    const data = sampleTplData('intra');
    data.items = Array.from({ length: 60 }, (_, i) => ({ ...data.items[0], sno: i + 1, description: `Line ${i + 1}` }));
    const t = pdfText(renderInvoiceTemplate(defaultConfig('professional'), data));
    expect(t).toMatch(/Page 1 of [2-9]/);
    expect(t).toContain('Line 60');
  });

  it('a draft carries the DRAFT watermark', () => {
    const data = { ...sampleTplData('intra'), status: 'draft' };
    expect(pdfText(renderInvoiceTemplate(defaultConfig('minimal'), data))).toContain('DRAFT');
  });
});

describe('InvoiceTemplateService — which design an invoice renders with', () => {
  const make = (rows: Record<string, any>) => new InvoiceTemplateService({
    one: async (sql: string) => {
      if (/FROM invoice_template_version WHERE id/.test(sql)) return rows.version ?? null;
      if (/JOIN invoice_template_version v ON v.id = t.published_version_id/.test(sql)) return rows.current ?? null;
      return null;
    },
    query: async () => [],
  } as never);

  it('an issued invoice uses the version it was ISSUED with, not the current default', async () => {
    const v1 = defaultConfig('minimal'); v1.branding.title = 'V1 TITLE';
    const cur = defaultConfig('professional'); cur.branding.title = 'CURRENT';
    const svc = make({ version: { config: v1 }, current: { id: 9, config: cur } });
    expect((await svc.configForInvoice({ status: 'issued', template_version_id: 3, branch_id: 1 }))!.branding.title).toBe('V1 TITLE');
  });

  it('an invoice issued before templates existed keeps the built-in layout (null)', async () => {
    const svc = make({ current: { id: 9, config: defaultConfig('professional') } });
    expect(await svc.configForInvoice({ status: 'issued', template_version_id: null, branch_id: 1 })).toBeNull();
  });

  it('a draft previews the current published default', async () => {
    const cur = defaultConfig('detailed'); cur.branding.title = 'CURRENT';
    const svc = make({ current: { id: 9, config: cur } });
    expect((await svc.configForInvoice({ status: 'draft', branch_id: 1 }))!.branding.title).toBe('CURRENT');
  });
});
