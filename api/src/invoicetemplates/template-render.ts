import { formatINR } from '../common/money.util';
import { PdfPage, Rgb, buildPdf, parseJpeg, rgb } from '../pdf/pdf.util';
import { InvoiceTemplateConfig, fillVars } from './template-config';
import { InvoiceTplData } from './template-data';

/**
 * RENDER a fee invoice from a template (client 5 Nov 2026). One renderer for everything: the
 * builder's live preview, its PDF preview and the real invoice PDF are the same bytes, so what the
 * Super Admin designs is exactly what prints.
 */

const money = (minor: number | null | undefined) => formatINR(Number(minor ?? 0), { symbol: false });
const hex = (h: string): Rgb => rgb(h);
const mix = (h: string, t: number): Rgb => { // tint toward white (t = 0..1 of white)
  const c = hex(h); return { r: c.r + (1 - c.r) * t, g: c.g + (1 - c.g) * t, b: c.b + (1 - c.b) * t };
};
const INK = rgb('#1f2937');
const MUTED = rgb('#6b7280');
const RULE = rgb('#d9dbe3');

function jpegOf(dataUrl: string): Buffer | null {
  if (!dataUrl || !dataUrl.startsWith('data:image/jpeg;base64,')) return null;
  const b = Buffer.from(dataUrl.slice(23), 'base64');
  return parseJpeg(b) ? b : null;
}
/** draw a JPEG data URL fitted into (maxW × maxH); returns the drawn size */
function drawImg(p: PdfPage, dataUrl: string, x: number, y: number, maxW: number, maxH: number, alignRight = false): { w: number; h: number } {
  const buf = jpegOf(dataUrl);
  if (!buf) return { w: 0, h: 0 };
  const info = parseJpeg(buf)!;
  const s = Math.min(maxW / info.width, maxH / info.height);
  const w = info.width * s; const h = info.height * s;
  p.image(buf, alignRight ? x + maxW - w : x, y, w, h);
  return { w, h };
}

export function pageSize(cfg: InvoiceTemplateConfig): { w: number; h: number } {
  const [w, h] = cfg.page.size === 'Letter' ? [612, 792] : [PdfPage.WIDTH, PdfPage.HEIGHT];
  return cfg.page.orientation === 'landscape' ? { w: h, h: w } : { w, h };
}

export function renderInvoiceTemplate(cfg: InvoiceTemplateConfig, data: InvoiceTplData, meta: { title?: string } = {}): Buffer {
  const { w: PW, h: PH } = pageSize(cfg);
  const M = cfg.page.margin;
  const W = PW - M * 2;
  const fs = cfg.design.font_size;
  const gap = cfg.design.spacing === 'compact' ? 6 : cfg.design.spacing === 'relaxed' ? 14 : 10;
  const accent = cfg.branding.accent;
  const FOOT = 34;                               // reserved for the page footer
  const pages: PdfPage[] = [];
  let p = new PdfPage(PW, PH); pages.push(p);
  let y = M;
  const vars = { ...data.vars };
  const fill = (s: string) => fillVars(s, vars);

  const newPage = () => {
    p = new PdfPage(PW, PH); pages.push(p);
    y = M;
    // a slim running header on continuation pages
    p.text(`${cfg.branding.institute_name || data.seller.name}  ·  ${cfg.branding.title}  ${vars.invoice_number}`, M, y + 8, { size: fs - 1, color: MUTED });
    y += 18;
    p.line(M, y, PW - M, y, { color: RULE }); y += 10;
  };
  const ensure = (need: number) => { if (y + need > PH - M - FOOT) newPage(); };
  const sectionTitle = (t: string) => {
    if (!t) return;
    ensure(fs + 14);
    p.text(t.toUpperCase(), M, y + fs, { size: fs - 0.5, font: 'Helvetica-Bold', color: hex(accent) });
    y += fs + 6;
  };
  /** label : value grid, `cols` columns, skipping empty values */
  const grid = (pairs: Array<[string, string]>, cols: number) => {
    const shown = pairs.filter(([, v]) => v && v.trim());
    if (!shown.length) return;
    const cw = W / cols;
    const rowH = fs * 2.4;
    for (let i = 0; i < shown.length; i += cols) {
      ensure(rowH);
      shown.slice(i, i + cols).forEach(([k, v], j) => {
        const x = M + j * cw;
        p.text(k, x, y + fs - 1, { size: fs - 1.5, color: MUTED });
        p.text(PdfPage.clip(v, cw - 10, fs, 'Helvetica-Bold'), x, y + fs * 2.05, { size: fs, font: 'Helvetica-Bold', color: INK });
      });
      y += rowH;
    }
  };
  const para = (title: string, text: string) => {
    const t = fill(text || '').trim();
    if (!t) return;
    ensure(fs * 3);
    p.text(title, M, y + fs, { size: fs - 1, font: 'Helvetica-Bold', color: MUTED });
    y += fs + 4;
    for (const line of t.split(/\r?\n/)) { ensure(fs * 1.5); y = p.paragraph(line || ' ', M, y + fs, W, { size: fs, color: INK, leading: fs * 1.4 }) - fs + 2; }
    y += gap - 2;
  };

  const SECTIONS: Record<string, () => void> = {
    header: () => {
      const b = cfg.branding;
      const band = b.header_bg.toLowerCase() !== '#ffffff';
      const top = band ? 0 : M;
      const bandH = 96;
      if (band) p.rect(0, 0, PW, bandH + (M > 30 ? 6 : 0), hex(b.header_bg));
      else p.rect(0, 0, PW, 4, hex(accent));
      const tc = band ? hex(b.header_text) : INK;
      const sub = band ? mix(b.header_text, 0.25) : MUTED;
      let x = M; let hy = top + (band ? 20 : 4);
      if (b.show_logo && b.logo) { const dim = drawImg(p, b.logo, M, hy, 110, 52); if (dim.w) x = M + dim.w + 12; }
      const name = b.institute_name || data.seller.name || data.org_name;
      const leftW = W * 0.58 - (x - M);
      p.text(PdfPage.clip(name, leftW, 16, 'Helvetica-Bold'), x, hy + 14, { size: 16, font: 'Helvetica-Bold', color: tc });
      let ly = hy + 27;
      const line = (s: string) => { if (s && s.trim()) { p.text(PdfPage.clip(s, leftW, fs - 1), x, ly, { size: fs - 1, color: sub }); ly += fs + 1.5; } };
      line(b.tagline);
      if (b.branch_name && data.seller.branch) line(`${data.seller.branch} branch`);
      line(b.address || data.seller.address);
      line([b.phone || data.seller.phone, b.email || data.seller.email, b.website].filter(Boolean).join('  ·  '));
      const gst = b.gstin || data.seller.gstin; if (gst) line(`GSTIN: ${gst}`);
      // title block
      const align = b.title_align;
      const tx = align === 'left' ? M : M; const tw = W;
      const titleY = align === 'left' ? Math.max(ly + 6, hy + 14) : hy + 14;
      p.text(b.title, tx, titleY, { size: 17, font: 'Helvetica-Bold', color: band ? tc : hex(accent), align, width: tw });
      p.text(vars.invoice_number, tx, titleY + 16, { size: 10.5, font: 'Helvetica-Bold', color: tc, align, width: tw });
      if (vars.invoice_date) p.text(vars.invoice_date, tx, titleY + 29, { size: fs - 1, color: sub, align, width: tw });
      y = Math.max(band ? bandH + 14 : ly + 10, align === 'left' ? titleY + 40 : 0, y);
      if (!band) { p.line(M, y - 4, PW - M, y - 4, { color: RULE }); y += 6; }
    },
    invoice_info: () => {
      const t = cfg.sections.find((s) => s.key === 'invoice_info')?.title; if (t) sectionTitle(t);
      grid(cfg.invoice_fields.filter((f) => f.visible && !(f.key === 'invoice_number' && cfg.sections.find((s) => s.key === 'header')?.visible))
        .map((f) => [f.label, vars[f.key] ?? '']), cfg.page.orientation === 'landscape' ? 6 : 4);
      y += gap - 4;
    },
    student_info: () => {
      sectionTitle(cfg.sections.find((s) => s.key === 'student_info')?.title ?? '');
      const fields = cfg.student_fields.filter((f) => f.visible);
      const nameF = fields.find((f) => f.key === 'student_name');
      if (nameF && vars.student_name) { ensure(fs * 3); p.text(vars.student_name, M, y + fs + 3, { size: fs + 4, font: 'Helvetica-Bold', color: INK }); y += fs + 10; }
      grid(fields.filter((f) => f.key !== 'student_name').map((f) => [f.label, vars[f.key] ?? '']), cfg.page.orientation === 'landscape' ? 5 : 3);
      y += gap - 4;
    },
    fee_table: () => {
      sectionTitle(cfg.sections.find((s) => s.key === 'fee_table')?.title ?? '');
      const hide = new Set<string>(data.supply === 'inter' ? ['cgst', 'sgst'] : ['igst']);
      const CAT: Record<string, { width: number; align: 'left' | 'right' | 'center' }> = {
        sno: { width: 6.5, align: 'center' }, description: { width: 26, align: 'left' }, course: { width: 16, align: 'left' }, fee_type: { width: 10, align: 'left' },
        hsn_sac: { width: 9, align: 'left' }, qty: { width: 5, align: 'right' }, course_fee: { width: 11, align: 'right' }, discount: { width: 10, align: 'right' },
        taxable: { width: 11, align: 'right' }, tax_rate: { width: 7.5, align: 'right' }, cgst: { width: 9, align: 'right' }, sgst: { width: 9, align: 'right' },
        igst: { width: 9, align: 'right' }, total: { width: 12, align: 'right' },
      };
      const cols = cfg.columns.filter((c) => c.visible && !hide.has(c.key));
      if (!cols.length) return;
      const totalW = cols.reduce((s, c) => s + CAT[c.key].width, 0);
      let cx = M;
      const geo = cols.map((c) => { const w = (CAT[c.key].width / totalW) * W; const g = { ...c, x: cx, w, align: CAT[c.key].align }; cx += w; return g; });
      const rowH = fs + (cfg.design.spacing === 'compact' ? 8 : 11);
      const head = () => {
        ensure(rowH * 2);
        p.rect(M, y, W, rowH, mix(accent, 0.86));
        for (const g of geo) p.text(PdfPage.clip(g.label, g.w - 6, fs - 1, 'Helvetica-Bold'), g.x + 3, y + rowH / 2 + (fs - 1) / 2.8, { size: fs - 1, font: 'Helvetica-Bold', color: INK, align: g.align, width: g.w - 6 });
        y += rowH;
      };
      head();
      const cell = (it: any, k: string): string => {
        switch (k) {
          case 'sno': return String(it.sno ?? '');
          case 'description': return it.description; case 'course': return it.course; case 'fee_type': return it.fee_type;
          case 'hsn_sac': return it.hsn_sac || '-'; case 'qty': return String(it.qty ?? '');
          case 'course_fee': return it.rate_minor != null ? money(it.rate_minor) : ''; case 'discount': return it.discount_minor ? money(it.discount_minor) : '-';
          case 'taxable': return it.taxable_minor != null ? money(it.taxable_minor) : ''; case 'tax_rate': return it.gst_pct != null ? `${Number(it.gst_pct)}%` : '';
          case 'cgst': return it.cgst_minor != null ? money(it.cgst_minor) : ''; case 'sgst': return it.sgst_minor != null ? money(it.sgst_minor) : '';
          case 'igst': return it.igst_minor != null ? money(it.igst_minor) : ''; case 'total': return it.total_minor != null ? money(it.total_minor) : '';
          default: return '';
        }
      };
      const rows: any[] = [...data.items, ...cfg.extra_rows.map((x, i) => ({
        sno: data.items.length + i + 1, description: fill(x.description), course: '', fee_type: 'Other', hsn_sac: '', qty: '',
        rate_minor: null, discount_minor: 0, taxable_minor: null, gst_pct: null, cgst_minor: null, sgst_minor: null, igst_minor: null,
        total_minor: x.amount ? Math.round(Number(x.amount) * 100) : null,
      }))];
      rows.forEach((it, i) => {
        if (y + rowH > PH - M - FOOT) { newPage(); head(); }
        if (cfg.design.striped && i % 2 === 1) p.rect(M, y, W, rowH, rgb('#f7f7fb'));
        for (const g of geo) p.text(PdfPage.clip(cell(it, g.key), g.w - 6, fs), g.x + 3, y + rowH / 2 + fs / 2.8, { size: fs, color: INK, align: g.align, width: g.w - 6 });
        y += rowH;
        if (cfg.design.borders) p.line(M, y, PW - M, y, { color: RULE, width: 0.4 });
      });
      if (cfg.design.borders) { for (const g of geo.slice(1)) p.line(g.x, y - rowH * rows.length, g.x, y, { color: RULE, width: 0.3 }); }
      y += gap;
    },
    summary: () => {
      const hide = new Set<string>(data.supply === 'inter' ? ['cgst', 'sgst'] : ['igst']);
      const rows = cfg.summary.filter((s) => s.visible && !hide.has(s.key)).map((s) => ({ ...s, v: data.sums[s.key] }))
        .filter((s) => s.v != null && !(['discount', 'round_off', 'coupon_discount'].includes(s.key) && !Number(s.v)));
      if (!rows.length) return;
      const bw = Math.min(260, W * 0.5); const bx = PW - M - bw;
      for (const s of rows) {
        const strong = s.key === 'grand_total';
        const h = strong ? fs + 12 : fs + 6;
        ensure(h + 4);
        if (strong) { p.line(bx, y + 1, PW - M, y + 1, { color: RULE }); p.rect(bx, y + 3, bw, h, mix(accent, 0.9)); }
        const val = s.key === 'discount' || s.key === 'coupon_discount' ? `- ${money(s.v)}` : s.key === 'round_off' ? `${Number(s.v) > 0 ? '+ ' : '- '}${money(Math.abs(Number(s.v)))}` : money(s.v);
        const size = strong ? fs + 2 : fs;
        p.text(s.label + (strong ? ' (INR)' : ''), bx + 6, y + h / 2 + size / 2.5 + (strong ? 3 : 0), { size, font: strong ? 'Helvetica-Bold' : 'Helvetica', color: strong ? INK : MUTED });
        p.text(val, bx, y + h / 2 + size / 2.5 + (strong ? 3 : 0), { size, font: strong ? 'Helvetica-Bold' : 'Helvetica', color: strong ? hex(accent) : INK, align: 'right', width: bw - 6 });
        y += h + (strong ? 4 : 0);
      }
      y += gap;
    },
    amount_words: () => {
      if (!data.amount_in_words) return;
      ensure(fs * 3.5);
      p.text('Amount in words', M, y + fs, { size: fs - 1, color: MUTED });
      y = p.paragraph(data.amount_in_words, M, y + fs * 2.3, W, { size: fs + 0.5, font: 'Helvetica-Bold', color: INK, leading: fs * 1.4 }) + gap - fs;
      y += fs;
    },
    payment: () => {
      const pairs = cfg.payment_fields.filter((f) => f.visible).map((f) => [f.label, vars[f.key] ?? ''] as [string, string]);
      const hasBank = !!(cfg.footer.bank_details.trim() || cfg.footer.upi_id.trim() || cfg.footer.upi_qr);
      if (!pairs.some(([, v]) => v) && !hasBank) return;
      sectionTitle(cfg.sections.find((s) => s.key === 'payment')?.title ?? '');
      grid(pairs, cfg.page.orientation === 'landscape' ? 5 : 4);
      if (hasBank) {
        const qrSize = cfg.footer.upi_qr ? 78 : 0;
        ensure(Math.max(qrSize, fs * 5) + 6);
        const startY = y;
        if (cfg.footer.upi_qr) drawImg(p, cfg.footer.upi_qr, PW - M - qrSize, y, qrSize, qrSize);
        const tw = W - (qrSize ? qrSize + 14 : 0);
        if (cfg.footer.bank_details.trim()) {
          p.text('Bank account', M, y + fs, { size: fs - 1, font: 'Helvetica-Bold', color: MUTED }); y += fs + 3;
          for (const l of fill(cfg.footer.bank_details).split(/\r?\n/)) { y = p.paragraph(l || ' ', M, y + fs, tw, { size: fs, color: INK, leading: fs * 1.35 }) - fs + 1; }
        }
        if (cfg.footer.upi_id.trim()) { p.text(`UPI: ${cfg.footer.upi_id}`, M, y + fs + 4, { size: fs, font: 'Helvetica-Bold', color: INK }); y += fs + 6; }
        y = Math.max(y, startY + qrSize) + gap;
      }
    },
    custom: () => {
      const rows = cfg.custom_fields.filter((c) => c.visible).map((c) => [c.label, fill(c.value)] as [string, string]);
      if (!rows.some(([, v]) => v)) return;
      sectionTitle(cfg.sections.find((s) => s.key === 'custom')?.title ?? '');
      grid(rows, 3); y += gap - 4;
    },
    notes_terms: () => {
      para('Notes', data.notes);
      para('Terms & conditions', data.terms || cfg.footer.terms);
      para('Refund policy', cfg.footer.refund_policy);
      para('Payment instructions', cfg.footer.payment_instructions);
    },
    footer: () => {
      const f = cfg.footer;
      const blockH = 92;
      ensure(blockH);
      const sx = PW - M - 180;
      if (f.stamp_img) drawImg(p, f.stamp_img, sx - 110, y, 90, 70);
      if (f.signature_img) drawImg(p, f.signature_img, sx, y + 2, 180, 40, true);
      p.line(sx, y + 48, PW - M, y + 48, { color: RULE });
      p.text(f.signature_label, sx, y + 60, { size: fs - 1, color: MUTED, align: 'right', width: 180 });
      p.text(cfg.branding.institute_name || data.seller.name, sx, y + 72, { size: fs, font: 'Helvetica-Bold', color: INK, align: 'right', width: 180 });
      if (f.accountant_name) p.text(`Accountant: ${f.accountant_name}`, M, y + 60, { size: fs - 1, color: MUTED });
      if (f.thank_you) p.text(fill(f.thank_you), M, y + 74, { size: fs + 0.5, font: 'Helvetica-Bold', color: hex(accent) });
      y += blockH;
    },
  };

  for (const s of cfg.sections) if (s.visible && SECTIONS[s.key]) SECTIONS[s.key]();

  // running footer + watermark on every page
  const gen = `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  pages.forEach((pg, i) => {
    const fy = PH - M + 4;
    pg.line(M, fy - 12, PW - M, fy - 12, { color: RULE });
    const left = [fill(cfg.footer.note), cfg.footer.show_generated_at ? gen : ''].filter(Boolean).join('  ·  ');
    if (left) pg.text(PdfPage.clip(left, W - 80, fs - 2), M, fy, { size: fs - 2, color: MUTED });
    if (cfg.footer.show_page_number) pg.text(`Page ${i + 1} of ${pages.length}`, M, fy, { size: fs - 2, color: MUTED, align: 'right', width: W });
    if (data.status === 'draft') pg.text('DRAFT', M, PH / 2, { size: 64, font: 'Helvetica-Bold', color: rgb('#e5e7eb'), align: 'center', width: W });
    else if (data.status === 'cancelled') pg.text('CANCELLED', M, PH / 2, { size: 60, font: 'Helvetica-Bold', color: rgb('#fca5a5'), align: 'center', width: W });
  });
  return buildPdf(pages, { title: meta.title ?? `Fee Invoice ${data.vars.invoice_number ?? ''}`, author: data.org_name || 'Tech Lingua' });
}
