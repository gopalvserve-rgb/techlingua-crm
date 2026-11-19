import { PdfPage, buildPdf, rgb, textWidth } from '../pdf/pdf.util';
import { DocType, docTypeDef } from './builder-catalog';
import { DocConfig, fillDocVars } from './builder-config';
import { code39Bars, qrMatrix } from './qr';

/**
 * THE SHARED DOCUMENT RENDERER (client 12 Nov 2026) — one renderer for every builder document,
 * driven entirely by a DocConfig + the record's DocData. Three shapes:
 *   · A4 / Letter documents (receipt, quotation, admission form, marksheet, report card, letters)
 *   · a landscape certificate (centred title, name, wording, signatories, QR)
 *   · a CR80 ID card (85.6 × 54 mm), portrait or landscape (photo, fields, QR / barcode)
 * A template only lays data out; every value comes from the record.
 */

export interface DocData {
  fields: Record<string, string>;
  tables: Record<string, Array<Record<string, string>>>;
  photo?: Buffer | null;
  logo?: Buffer | null;          // the vertical's logo when the template has none
  verify_url?: string | null;    // the QR target
  barcode?: string | null;
  doc_no: string;
  holder: string;
  revoked?: boolean;
}

const jpeg = (dataUrl: string): Buffer | null => (dataUrl && dataUrl.startsWith('data:image/jpeg;base64,') ? Buffer.from(dataUrl.slice(23), 'base64') : null);
const MUTED = rgb('#6b7280'); const INK = rgb('#111827'); const RULE = rgb('#d9dbe3'); const SOFT = rgb('#f4f5fb');
const CARD_W = 153.07; const CARD_H = 242.65;   // CR80 in points

function drawQr(p: PdfPage, text: string, x: number, y: number, size: number) {
  let m: boolean[][];
  try { m = qrMatrix(text); } catch { return; }
  const n = m.length + 8;          // + 4-module quiet zone each side
  const cell = size / n;
  p.rect(x, y, size, size, rgb('#ffffff'));
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) {
    if (m[r][c]) p.rect(x + (c + 4) * cell, y + (r + 4) * cell, cell + 0.05, cell + 0.05, INK);
  }
}

function drawBarcode(p: PdfPage, text: string, x: number, y: number, w: number, h: number) {
  const b = code39Bars(text);
  const unit = w / (b.width + 20);
  const x0 = x + unit * 10;
  for (const [bx, bw] of b.bars) p.rect(x0 + bx * unit, y, bw * unit, h, INK);
  p.text(String(text).toUpperCase(), x, y + h + 7, { size: 6, color: MUTED, align: 'center', width: w });
}

/** Visible fields of a group as [label, value] pairs (photo handled separately). */
const pairs = (g: DocConfig['groups'][number], data: DocData): Array<[string, string]> =>
  g.fields.filter((x) => x.visible && x.key !== 'photo').map((x) => [x.label, data.fields[x.key] ?? ''] as [string, string]).filter(([, v]) => String(v).trim() !== '');

export function renderDoc(type: DocType, cfg: DocConfig, data: DocData): Buffer {
  const def = docTypeDef(type)!;
  const pages = cfg.page.size === 'CARD' ? renderCard(cfg, data) : def.module === 'Certificates' && type === 'certificate' ? renderCertificate(cfg, data) : renderSheet(cfg, data);
  return buildPdf(pages, { title: `${cfg.branding.title} ${data.doc_no}`.trim() });
}

/* -------------------------------------------------------------------- A4 */

function header(p: PdfPage, cfg: DocConfig, data: DocData, M: number, PW: number): number {
  const b = cfg.branding; const bg = rgb(b.header_bg); const fg = rgb(b.header_text);
  const H = 74;
  p.rect(0, 0, PW, H, bg);
  let x = M;
  const logo = (b.show_logo && (jpeg(b.logo) ?? data.logo)) || null;
  if (logo && p.image(logo, M, 12, 50, 50)) x = M + 60;
  const name = b.institute_name || data.fields.institute_name || '';
  p.text(PdfPage.clip(name, PW - x - M - 160, 15, 'Helvetica-Bold'), x, 30, { size: 15, font: 'Helvetica-Bold', color: fg });
  if (b.tagline) p.text(PdfPage.clip(b.tagline, PW - x - M - 160, 8.5), x, 43, { size: 8.5, color: fg });
  const contact = [b.address || data.fields.institute_address, [b.phone || data.fields.institute_phone, b.email || data.fields.institute_email, b.website].filter(Boolean).join('  ·  ')].filter(Boolean);
  contact.forEach((c, i) => p.text(PdfPage.clip(String(c), PW - x - M - 160, 7.5), x, 54 + i * 10, { size: 7.5, color: fg }));
  // title block
  const tAlign = b.title_align;
  if (tAlign === 'right') p.text(b.title, PW - M - 200, 34, { size: 14, font: 'Helvetica-Bold', color: fg, align: 'right', width: 200 });
  let y = H + 18;
  if (tAlign !== 'right') {
    p.text(b.title, M, y, { size: 15, font: 'Helvetica-Bold', color: rgb(b.accent), align: tAlign === 'center' ? 'center' : 'left', width: PW - M * 2 });
    y += 18;
  }
  if (data.revoked) { p.text('REVOKED — this document is no longer valid', M, y, { size: 10, font: 'Helvetica-Bold', color: rgb('#dc2626') }); y += 16; }
  return y;
}

function renderSheet(cfg: DocConfig, data: DocData): PdfPage[] {
  const land = cfg.page.orientation === 'landscape';
  const [w0, h0] = cfg.page.size === 'Letter' ? [612, 792] : [PdfPage.WIDTH, PdfPage.HEIGHT];
  const PW = land ? h0 : w0; const PH = land ? w0 : h0;
  const M = cfg.page.margin; const W = PW - M * 2; const fs = cfg.design.font_size; const lead = fs * 1.55;
  const accent = rgb(cfg.branding.accent);
  const pages: PdfPage[] = [];
  let p = new PdfPage(PW, PH); pages.push(p);
  let y = header(p, cfg, data, M, PW);
  const ensure = (h: number) => { if (y + h > PH - M - 30) { p = new PdfPage(PW, PH); pages.push(p); y = M; } };
  const groupTitle = (t: string) => {
    if (!cfg.design.group_titles || !t) return;
    ensure(lead * 2); p.text(t.toUpperCase(), M, y, { size: fs - 0.5, font: 'Helvetica-Bold', color: accent }); y += 4;
    p.line(M, y, M + W, y, { color: RULE }); y += lead;
  };
  // photo (top right) when an identity / student group shows it
  const photoOn = cfg.groups.some((g) => g.visible && g.fields.some((x) => x.key === 'photo' && x.visible));
  let photoBottom = 0;
  if (photoOn && data.photo) { if (p.image(data.photo, PW - M - 70, y, 70, 86)) photoBottom = y + 92; }
  const cols = cfg.design.columns;
  for (const g of cfg.groups) {
    if (!g.visible) continue;
    const kv = pairs(g, data);
    if (!kv.length) continue;
    groupTitle(g.title);
    const usable = photoBottom > y ? W - 82 : W;
    const colW = usable / cols;
    for (let i = 0; i < kv.length; i += cols) {
      ensure(lead + 2);
      let rowH = lead;
      for (let c = 0; c < cols && i + c < kv.length; c++) {
        const [k, v] = kv[i + c]; const x = M + c * colW;
        p.text(PdfPage.clip(k, colW * 0.42, fs - 0.5), x, y, { size: fs - 0.5, color: MUTED });
        const endY = p.paragraph(String(v), x + colW * 0.42, y, colW * 0.56, { size: fs, font: 'Helvetica-Bold', color: INK, leading: lead });
        rowH = Math.max(rowH, endY - y);
      }
      y += rowH;
    }
    y += lead * 0.4;
  }
  if (photoBottom > y) y = photoBottom;
  // tables
  for (const t of cfg.tables) {
    const rows = data.tables[t.key] ?? [];
    const cs = t.columns.filter((c) => c.visible);
    if (!t.visible || !rows.length || !cs.length) continue;
    groupTitle(t.title);
    // the first (description) column gets a double share when there are several columns
    const shares = cs.map((_, i) => (i === 0 && cs.length > 2 ? 2 : 1));
    const unit = W / shares.reduce((a, b) => a + b, 0);
    const xs = shares.map((_, i) => M + shares.slice(0, i).reduce((a, b) => a + b, 0) * unit);
    const ws = shares.map((sh) => sh * unit);
    ensure(lead * 2);
    p.rect(M, y - fs, W, lead + 2, SOFT);
    cs.forEach((c, i) => p.text(PdfPage.clip(c.label, ws[i] - 6, fs - 0.5, 'Helvetica-Bold'), xs[i] + 3, y, { size: fs - 0.5, font: 'Helvetica-Bold' }));
    y += lead + 2;
    for (const r of rows) {
      ensure(lead + 2);
      cs.forEach((c, i) => p.text(PdfPage.clip(String(r[c.key] ?? ''), ws[i] - 6, fs), xs[i] + 3, y, { size: fs }));
      if (cfg.design.borders) p.line(M, y + 4, M + W, y + 4, { color: RULE });
      y += lead + 2;
    }
    y += lead * 0.5;
  }
  // body wording
  if (cfg.body.trim()) {
    for (const para of fillDocVars(cfg.body, data.fields).split(/\n{1,}/)) {
      ensure(lead * 2);
      y = p.paragraph(para, M, y, W, { size: fs + 0.5, leading: lead * 1.1 }) + lead * 0.5;
    }
  }
  // custom fields
  const cf = cfg.custom_fields.filter((x) => x.visible);
  if (cf.length) {
    groupTitle('Additional details');
    for (const x of cf) {
      ensure(lead);
      p.text(x.label, M, y, { size: fs - 0.5, color: MUTED });
      y = p.paragraph(fillDocVars(x.value, data.fields), M + W * 0.3, y, W * 0.7, { size: fs, leading: lead });
    }
  }
  if (cfg.partner.show && (cfg.partner.name || cfg.partner.text)) {
    ensure(lead * 3); groupTitle('In association with');
    if (cfg.partner.name) { p.text(cfg.partner.name, M, y, { size: fs, font: 'Helvetica-Bold' }); y += lead; }
    if (cfg.partner.text) y = p.paragraph(cfg.partner.text, M, y, W, { size: fs - 0.5, color: MUTED });
  }
  if (cfg.footer.terms.trim()) {
    ensure(lead * 3); groupTitle('Terms & conditions');
    for (const para of fillDocVars(cfg.footer.terms, data.fields).split(/\n+/)) { ensure(lead); y = p.paragraph(para, M, y, W, { size: fs - 1, color: MUTED, leading: lead * 0.95 }); }
  }
  // signatures + QR / barcode
  ensure(110); y += 14;
  const sigs = cfg.footer.signatories.filter((s) => s.label || s.name || s.image);
  const qrSize = cfg.footer.show_qr && data.verify_url ? 74 : 0;
  const sigW = (W - (qrSize ? qrSize + 16 : 0)) / Math.max(1, sigs.length);
  sigs.forEach((s, i) => {
    const x = M + i * sigW;
    const img = jpeg(s.image); if (img) p.image(img, x, y, Math.min(110, sigW - 10), 36);
    p.line(x, y + 44, x + Math.min(150, sigW - 14), y + 44, { color: INK, width: 0.6 });
    if (s.name) p.text(PdfPage.clip(s.name, sigW - 10, fs), x, y + 56, { size: fs, font: 'Helvetica-Bold' });
    p.text(PdfPage.clip(s.label, sigW - 10, fs - 1), x, y + (s.name ? 67 : 56), { size: fs - 1, color: MUTED });
  });
  const stamp = jpeg(cfg.footer.stamp_img);
  if (stamp) p.image(stamp, M + Math.min(sigs.length, 2) * sigW - 70, y - 6, 60, 60);
  if (qrSize) {
    drawQr(p, data.verify_url as string, M + W - qrSize, y - 4, qrSize);
    p.text('Scan to verify', M + W - qrSize, y + qrSize + 4, { size: 6.5, color: MUTED, align: 'center', width: qrSize });
  }
  y += 84;
  if (cfg.footer.show_barcode && data.barcode) { ensure(40); drawBarcode(p, data.barcode, M, y, 180, 26); y += 40; }
  if (cfg.footer.disclaimer) { ensure(lead); y = p.paragraph(cfg.footer.disclaimer, M, y, W, { size: fs - 1.5, color: MUTED }); }
  // footer line on every page
  const stamp2 = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  pages.forEach((pg, i) => {
    pg.line(M, PH - M + 4, PW - M, PH - M + 4, { color: RULE });
    const left = [cfg.footer.note, cfg.footer.show_generated_at ? `Generated ${stamp2}` : ''].filter(Boolean).join('  ·  ');
    if (left) pg.text(PdfPage.clip(left, W - 80, 7), M, PH - M + 14, { size: 7, color: MUTED });
    pg.text(`Page ${i + 1} of ${pages.length}`, PW - M - 80, PH - M + 14, { size: 7, color: MUTED, align: 'right', width: 80 });
  });
  return pages;
}

/* ------------------------------------------------------------- certificate */

function renderCertificate(cfg: DocConfig, data: DocData): PdfPage[] {
  const land = cfg.page.orientation === 'landscape';
  const PW = land ? PdfPage.HEIGHT : PdfPage.WIDTH; const PH = land ? PdfPage.WIDTH : PdfPage.HEIGHT;
  const p = new PdfPage(PW, PH);
  const accent = rgb(cfg.branding.accent); const M = cfg.page.margin;
  // double border
  const frame = (o: number, c: string, w: number) => {
    p.line(o, o, PW - o, o, { color: rgb(c), width: w }); p.line(PW - o, o, PW - o, PH - o, { color: rgb(c), width: w });
    p.line(PW - o, PH - o, o, PH - o, { color: rgb(c), width: w }); p.line(o, PH - o, o, o, { color: rgb(c), width: w });
  };
  frame(M * 0.5, cfg.branding.accent, 2.5); frame(M * 0.5 + 6, cfg.branding.accent, 0.6);
  let y = M + 30;
  const logo = (cfg.branding.show_logo && (jpeg(cfg.branding.logo) ?? data.logo)) || null;
  if (logo) { p.image(logo, PW / 2 - 28, y - 10, 56, 56); y += 56; }
  const name = cfg.branding.institute_name || data.fields.institute_name || '';
  p.text(name, 0, y + 8, { size: 16, font: 'Helvetica-Bold', align: 'center', width: PW, color: INK }); y += 24;
  const contact = [cfg.branding.address || data.fields.institute_address, [cfg.branding.phone || data.fields.institute_phone, cfg.branding.email].filter(Boolean).join('  ·  ')].filter(Boolean).join('  ·  ');
  if (contact) { p.text(PdfPage.clip(contact, PW - M * 3, 8), 0, y, { size: 8, color: MUTED, align: 'center', width: PW }); y += 16; }
  p.text(data.fields.certificate_title || cfg.branding.title, 0, y + 22, { size: 24, font: 'Helvetica-Bold', align: 'center', width: PW, color: accent }); y += 48;
  if (data.revoked) { p.text('REVOKED', 0, y, { size: 14, font: 'Helvetica-Bold', color: rgb('#dc2626'), align: 'center', width: PW }); y += 18; }
  p.text('This is to certify that', 0, y, { size: 11, color: MUTED, align: 'center', width: PW }); y += 30;
  p.text(data.fields.student_name || data.holder, 0, y, { size: 26, font: 'Helvetica-Bold', align: 'center', width: PW, color: INK });
  const nw = Math.min(PW - M * 4, textWidth(data.fields.student_name || data.holder, 26, 'Helvetica-Bold') + 60);
  p.line((PW - nw) / 2, y + 8, (PW + nw) / 2, y + 8, { color: accent, width: 0.8 }); y += 30;
  const body = fillDocVars(cfg.body, data.fields).replace(/^This is to certify that \S.*? has /i, 'has ');
  for (const para of body.split(/\n+/)) {
    const tw = PW - M * 5;
    const lines = wrap(para, tw, 12);
    for (const ln of lines) { p.text(ln, 0, y, { size: 12, align: 'center', width: PW }); y += 17; }
  }
  // detail line (visible fields of the certificate / course groups)
  const det = cfg.groups.filter((g) => g.visible && g.key !== 'student').flatMap((g) => pairs(g, data)).map(([k, v]) => `${k}: ${v}`);
  if (det.length) { y += 6; for (const ln of wrap(det.join('  ·  '), PW - M * 4, 9)) { p.text(ln, 0, y, { size: 9, color: MUTED, align: 'center', width: PW }); y += 13; } }
  if (cfg.partner.show && (cfg.partner.name || cfg.partner.text)) {
    y += 4; p.text(`In association with ${cfg.partner.name}`.trim(), 0, y, { size: 9, font: 'Helvetica-Bold', align: 'center', width: PW }); y += 12;
    if (cfg.partner.text) for (const ln of wrap(cfg.partner.text, PW - M * 5, 8)) { p.text(ln, 0, y, { size: 8, color: MUTED, align: 'center', width: PW }); y += 11; }
  }
  // signatories along the bottom, QR bottom-right
  const sigs = cfg.footer.signatories.filter((s) => s.label || s.name || s.image);
  const by = PH - M - 70;
  const qr = cfg.footer.show_qr && data.verify_url ? 70 : 0;
  const span = PW - M * 3 - (qr ? qr + 20 : 0);
  sigs.forEach((s, i) => {
    const cx = M * 1.5 + (span / sigs.length) * (i + 0.5);
    const img = jpeg(s.image); if (img) p.image(img, cx - 50, by - 34, 100, 32);
    p.line(cx - 70, by, cx + 70, by, { color: INK, width: 0.6 });
    if (s.name) p.text(s.name, cx - 90, by + 12, { size: 9, font: 'Helvetica-Bold', align: 'center', width: 180 });
    p.text(s.label, cx - 90, by + (s.name ? 23 : 12), { size: 8, color: MUTED, align: 'center', width: 180 });
  });
  const stamp = jpeg(cfg.footer.stamp_img);
  if (stamp) p.image(stamp, PW / 2 - 30, by - 50, 60, 60);
  if (qr) { drawQr(p, data.verify_url as string, PW - M * 1.5 - qr, by - 40, qr); p.text('Scan to verify', PW - M * 1.5 - qr, by + 34, { size: 6.5, color: MUTED, align: 'center', width: qr }); }
  if (cfg.footer.disclaimer) p.text(PdfPage.clip(cfg.footer.disclaimer, PW - M * 4, 7), 0, PH - M * 0.5 - 14, { size: 7, color: MUTED, align: 'center', width: PW });
  return [p];
}

function wrap(s: string, width: number, size: number): string[] {
  const words = String(s).split(/\s+/).filter(Boolean); const out: string[] = []; let line = '';
  for (const w of words) {
    const nx = line ? `${line} ${w}` : w;
    if (textWidth(nx, size) > width && line) { out.push(line); line = w; } else line = nx;
  }
  if (line) out.push(line);
  return out;
}

/* -------------------------------------------------------------------- card */

function renderCard(cfg: DocConfig, data: DocData): PdfPage[] {
  const land = cfg.page.orientation === 'landscape';
  const PW = land ? CARD_H : CARD_W; const PH = land ? CARD_W : CARD_H;
  const p = new PdfPage(PW, PH);
  const M = cfg.page.margin; const fs = cfg.design.font_size; const fg = rgb(cfg.branding.header_text);
  const H = land ? 30 : 38;
  p.rect(0, 0, PW, H, rgb(cfg.branding.header_bg));
  const logo = (cfg.branding.show_logo && (jpeg(cfg.branding.logo) ?? data.logo)) || null;
  let tx = M;
  if (logo && p.image(logo, M, 5, H - 10, H - 10)) tx = M + H - 4;
  const name = cfg.branding.institute_name || data.fields.institute_name || '';
  p.text(PdfPage.clip(name, PW - tx - M, 8, 'Helvetica-Bold'), tx, 15, { size: 8, font: 'Helvetica-Bold', color: fg });
  p.text(PdfPage.clip(cfg.branding.title, PW - tx - M, 5.5), tx, 24, { size: 5.5, color: fg });
  let y = H + 8;
  const photoOn = cfg.groups.some((g) => g.visible && g.fields.some((x) => x.key === 'photo' && x.visible));
  const pw = land ? 50 : 50; const ph = land ? 62 : 60;
  const px = land ? M : (PW - pw) / 2;
  if (photoOn) {
    if (!(data.photo && p.image(data.photo, px, y, pw, ph))) {
      p.rect(px, y, pw, ph, SOFT);
      const ini = String(data.holder || '?').split(/\s+/).map((s) => s[0] ?? '').join('').slice(0, 2).toUpperCase();
      p.text(ini, px, y + ph / 2 + 5, { size: 16, font: 'Helvetica-Bold', color: MUTED, align: 'center', width: pw });
    }
  }
  let fx = M; let fw = PW - M * 2;
  if (land && photoOn) { fx = M + pw + 8; fw = PW - fx - M; } else if (photoOn) y += ph + fs + 8;
  const all = cfg.groups.filter((g) => g.visible).flatMap((g) => pairs(g, data));
  const nameIdx = all.findIndex(([k]) => /name/i.test(k));
  if (nameIdx >= 0) {
    p.text(PdfPage.clip(all[nameIdx][1], fw, fs + 2.5, 'Helvetica-Bold'), fx, y, { size: fs + 2.5, font: 'Helvetica-Bold', color: INK, align: land ? 'left' : 'center', width: fw });
    y += fs + 6; all.splice(nameIdx, 1);
  }
  const qr = cfg.footer.show_qr && data.verify_url ? (land ? 40 : 42) : 0;
  const barH = cfg.footer.show_barcode && data.barcode ? 18 : 0;
  const qrTop = PH - M - barH - qr;
  const sigY = PH - M - (barH ? barH + 8 : 8);
  // fields run down the card; beside the QR they narrow instead of stopping, and they end above the signature
  for (const [k, v] of all) {
    if (y > sigY - 18) break;
    const w = qr && y + 2 > qrTop ? fw - qr - 6 : fw;
    p.text(PdfPage.clip(k, fw * 0.38, fs - 1), fx, y, { size: fs - 1, color: MUTED });
    p.text(PdfPage.clip(v, w - fw * 0.4 - 2, fs, 'Helvetica-Bold'), fx + fw * 0.4, y, { size: fs, font: 'Helvetica-Bold', color: INK });
    y += fs + 3;
  }
  const sig = cfg.footer.signatories[0];
  if (qr) drawQr(p, data.verify_url as string, PW - M - qr, qrTop, qr);
  if (sig) {
    const sy = sigY;
    const img = jpeg(sig.image); if (img) p.image(img, M, sy - 20, 54, 16);
    p.line(M, sy, M + 60, sy, { color: INK, width: 0.4 });
    p.text(PdfPage.clip(sig.label, 70, 5), M, sy + 6, { size: 5, color: MUTED });
  }
  if (cfg.footer.show_barcode && data.barcode) drawBarcode(p, data.barcode, M, PH - M - 16, PW - M * 2, 10);
  if (data.revoked) p.text('REVOKED', 0, PH / 2, { size: 18, font: 'Helvetica-Bold', color: rgb('#dc2626'), align: 'center', width: PW });
  return [p];
}
