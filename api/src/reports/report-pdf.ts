import { formatINR } from '../common/money.util';
import { PdfPage, buildPdf, rgb, textWidth } from '../pdf/pdf.util';
import { BuiltQuery } from './query-builder';

/**
 * A REPORT AS A PDF — landscape, paginated, with the columns fitted to the page.
 *
 * =============================================================================
 * THE LESSON THIS FILE IS BUILT ON
 * =============================================================================
 * The Sprint-5 quotation PDF shipped with its Discount and Tax columns printing on top
 * of each other — `10% 4,500.0018% 7,290.00` — while 25 PDF tests passed, because every
 * one of them asserted the numbers were PRESENT and none asserted they were READABLE.
 *
 * A report PDF is that risk with the volume turned up: the client picks the columns, so
 * the widths are not knowable in advance. Two rules follow, and report-pdf.spec.ts pins
 * both by parsing the real bytes:
 *
 *   1. WIDTHS ARE COMPUTED FROM THE ACTUAL CONTENT and then scaled to the page. Nothing
 *      is hard-coded, because nothing can be.
 *   2. EVERY CELL IS CLIPPED TO ITS OWN COLUMN, unconditionally. A value that does not
 *      fit is truncated with an ellipsis — visibly short, never silently overlapping.
 *      A truncated cell is a nuisance; two numbers printed on top of each other is a
 *      document that lies.
 *
 * A report with more columns than fit legibly is REFUSED with a message naming the
 * number, rather than rendered as a grey smear. "Too many columns for a PDF — 14 is
 * about the limit at this width; export to Excel, or group the report" is a sentence a
 * client can act on.
 */

const INK = rgb('#111827');
const MUTED = rgb('#6b7280');
const RULE = rgb('#e5e7eb');
const BRAND = rgb('#4f46e5');
const BG = rgb('#f3f4f6');

const M = 32;
// A4 LANDSCAPE, from the class constants — not 842x595 typed in here. A page size that
// disagrees with the MediaBox by a point is the kind of thing that renders fine and
// prints wrong.
const PAGE_W = PdfPage.LANDSCAPE_WIDTH;
const PAGE_H = PdfPage.LANDSCAPE_HEIGHT;
const W = PAGE_W - M * 2;

export interface ReportDoc {
  title: string;
  subtitle?: string;
  columns: BuiltQuery['columns'];
  rows: unknown[][];
  /** printed in the footer of every page: who ran it, in whose scope, when */
  footnotes: string[];
  org_name: string;
}

const fmt = (v: unknown, type: string): string => {
  if (v === null || v === undefined) return '';
  switch (type) {
    // symbol:false => "12,34,567.00". The base-14 PDF fonts HAVE NO RUPEE GLYPH — see
    // pdf/pdf.util.ts. The column header carries "(Rs.)" instead, so the unit is stated
    // once per column rather than mis-drawn on every row.
    case 'money': return formatINR(Number(v), { symbol: false });
    case 'number': return String(v);
    case 'bool': return v === true || v === 't' || v === 'true' ? 'Yes' : 'No';
    case 'date': {
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    case 'datetime': {
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? String(v)
        : `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
    }
    default: return String(v);
  }
};

export const MAX_PDF_COLUMNS = 14;

export class TooManyColumnsError extends Error {}

/** Column widths from the real content, scaled to the page. Pure — the spec calls it
 *  directly and checks that the widths sum to the printable width and that none is
 *  narrower than its own header. */
export function fitColumns(doc: ReportDoc): number[] {
  const natural = doc.columns.map((c, i) => {
    const header = textWidth(`${c.label} `, 8, 'Helvetica-Bold');
    // Sample the first 200 rows, not all of them: an export of 20,000 rows must not
    // spend a second measuring text to decide a column is wide.
    const body = doc.rows.slice(0, 200).reduce((m, r) => Math.max(m, textWidth(fmt(r[i], c.type), 8)), 0);
    return Math.max(header, Math.min(body, 220)) + 10;
  });
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= W) {
    // Spread the slack proportionally rather than leaving a gutter on the right.
    const slack = (W - total) / natural.length;
    return natural.map((w) => w + slack);
  }
  // Squeeze proportionally, but never below what the HEADER needs, or the column
  // heading itself becomes an ellipsis and the reader cannot tell what he is looking at.
  const minima = doc.columns.map((c) => textWidth(`${c.label} `, 8, 'Helvetica-Bold') + 8);
  const minTotal = minima.reduce((a, b) => a + b, 0);
  if (minTotal > W) throw new TooManyColumnsError(
    `These ${doc.columns.length} columns do not fit a PDF page even at minimum width. `
    + `Export to Excel (which scrolls), or remove a few columns.`,
  );
  const scale = (W - minTotal) / (total - minTotal);
  return natural.map((w, i) => minima[i] + (w - minima[i]) * scale);
}

export function reportPdf(doc: ReportDoc): Buffer {
  if (doc.columns.length > MAX_PDF_COLUMNS) {
    throw new TooManyColumnsError(
      `A PDF fits about ${MAX_PDF_COLUMNS} columns legibly and this report has ${doc.columns.length}. `
      + `Export it to Excel instead, or group the report so it is narrower.`,
    );
  }
  const widths = fitColumns(doc);
  const xs: number[] = [];
  let acc = M;
  for (const w of widths) { xs.push(acc); acc += w; }

  const pages: PdfPage[] = [];
  let p!: PdfPage;
  let y = 0;
  let pageNo = 0;

  const header = () => {
    p = new PdfPage(PAGE_W, PAGE_H);
    pages.push(p);
    pageNo++;
    p.rect(0, 0, PAGE_W, 4, BRAND);
    y = 44;
    p.text(doc.title, M, y, { size: 16, font: 'Helvetica-Bold', color: INK });
    if (doc.subtitle) { y += 14; p.text(doc.subtitle, M, y, { size: 9, color: MUTED }); }
    y += 22;
    p.rect(M, y - 3, W, 18, BG);
    doc.columns.forEach((c, i) => {
      // The unit lives in the HEADER, once — "Net fee (Rs.)". Repeating "Rs." on 500
      // rows costs width the numbers need and tells the reader nothing new.
      const label = c.type === 'money' ? `${c.label} (Rs.)` : c.label;
      p.text(PdfPage.clip(label, widths[i] - 8, 8, 'Helvetica-Bold'), xs[i] + 4, y + 9, {
        size: 8, font: 'Helvetica-Bold', color: MUTED,
        align: c.type === 'money' || c.type === 'number' ? 'right' : 'left',
        width: widths[i] - 8,
      });
    });
    y += 22;
  };

  header();

  for (const row of doc.rows) {
    if (y > PAGE_H - 46) { footer(p, doc, pageNo); header(); }
    doc.columns.forEach((c, i) => {
      const text = fmt(row[i], c.type);
      // CLIPPED. Unconditionally. See the header of this file.
      p.text(PdfPage.clip(text, widths[i] - 8, 8), xs[i] + 4, y, {
        size: 8, color: INK,
        align: c.type === 'money' || c.type === 'number' ? 'right' : 'left',
        width: widths[i] - 8,
      });
    });
    y += 6;
    p.line(M, y, PAGE_W - M, y, { color: RULE, width: 0.3 });
    y += 11;
  }

  if (!doc.rows.length) {
    p.text('No rows matched this report.', M, y + 8, { size: 10, color: MUTED });
  }

  footer(p, doc, pageNo);
  // A total page count needs a second pass, and a report is not a book. "Page 3" is
  // honest and enough; "Page 3 of 7" that says "of 1" on every page is not.
  return buildPdf(pages, { title: doc.title, author: doc.org_name });
}

function footer(p: PdfPage, doc: ReportDoc, pageNo: number) {
  const yy = PAGE_H - 26;
  p.line(M, yy - 8, PAGE_W - M, yy - 8, { color: RULE });
  const note = [...doc.footnotes,
    // THE RUPEE FOOTNOTE. The Excel export of this same report prints the real symbol;
    // this one cannot (no glyph in the base-14 fonts). Rather than let the client
    // discover that the two files disagree, the page says so.
    'Amounts are in Indian Rupees (Rs.). The Excel export of this report shows the rupee symbol; PDF fonts have no glyph for it.',
  ].join('  ·  ');
  p.text(PdfPage.clip(note, W - 60, 7), M, yy, { size: 7, color: MUTED });
  p.text(`Page ${pageNo}`, M, yy, { size: 7, color: MUTED, align: 'right', width: W });
}
