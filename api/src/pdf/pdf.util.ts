/**
 * A MINIMAL, DEPENDENCY-FREE PDF WRITER.
 *
 * =============================================================================
 * WHY NOT pdfkit?
 * =============================================================================
 * A quotation PDF and a receipt PDF are: a letterhead, a table, some rules, and
 * right-aligned money. That is text placement and line drawing — the two things a
 * bare PDF content stream does natively with the base-14 fonts every reader has had
 * since 1993. pdfkit would pull fontkit + a large tree into a Railway build for it.
 * This is ~200 lines, has no install step, no version drift, and is unit-testable.
 *
 * =============================================================================
 * THE RUPEE SIGN — READ THIS BEFORE "FIXING" IT
 * =============================================================================
 * The PDFs render "Rs." and NOT "₹", on purpose. The base-14 fonts are encoded
 * WinAnsi; U+20B9 RUPEE SIGN does not exist in WinAnsiEncoding and has no glyph in
 * Helvetica — there is no character code that produces it. Printing it would emit a
 * wrong glyph or a blank box on the client's letterhead.
 *
 * Showing "₹" in a PDF requires EMBEDDING a font that has the glyph (a subset of, say,
 * Noto Sans, ~150-250KB in the repo + a TrueType subsetter). That is a real piece of
 * work with a real payoff and it is NOT hidden here: it is flagged for the client as a
 * decision (PROJECT_STATUS §4). The SCREEN shows ₹ with correct Indian grouping — see
 * common/money.util.ts `formatINR`, which is what every UI number goes through.
 * =============================================================================
 */

export interface Rgb { r: number; g: number; b: number }
export const rgb = (hex: string): Rgb => {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
};

export type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique';
const FONT_KEY: Record<FontName, string> = {
  'Helvetica': 'F1', 'Helvetica-Bold': 'F2', 'Helvetica-Oblique': 'F3',
};

/**
 * Helvetica advance widths (units/1000) for the printable WinAnsi range we use.
 * Only what a business document needs; anything unmapped falls back to 500, which
 * mis-measures a width by a hair and never crashes.
 */
const W_REG: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, 'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778,
  'H': 722, 'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778,
  'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944,
  'X': 667, 'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
  '`': 333, 'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556,
  'h': 556, 'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556,
  'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722,
  'x': 500, 'y': 500, 'z': 500, '{': 334, '|': 260, '}': 334, '~': 584,
};
/** Helvetica-Bold differs; the deltas that matter for a table header. */
const W_BOLD: Record<string, number> = {
  ...W_REG,
  ' ': 278, '.': 278, ',': 278, ':': 333, ';': 333, '-': 333, '/': 278,
  'a': 556, 'b': 611, 'c': 556, 'd': 611, 'e': 556, 'f': 333, 'g': 611, 'h': 611,
  'i': 278, 'j': 278, 'k': 556, 'l': 278, 'm': 889, 'n': 611, 'o': 611, 'p': 611,
  'q': 611, 'r': 389, 's': 556, 't': 333, 'u': 611, 'v': 556, 'w': 778, 'x': 556,
  'y': 556, 'z': 500,
  'A': 722, 'B': 722, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778, 'H': 722,
  'I': 278, 'J': 556, 'K': 722, 'L': 611, 'M': 833, 'N': 722, 'O': 778, 'P': 667,
  'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944, 'X': 667,
  'Y': 667, 'Z': 611,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556,
};

/** Width of `text` in points. Exported because the PDF needs it and so do the tests. */
export function textWidth(text: string, size: number, font: FontName = 'Helvetica'): number {
  const table = font === 'Helvetica-Bold' ? W_BOLD : W_REG;
  let w = 0;
  for (const ch of text) w += table[ch] ?? 500;
  return (w * size) / 1000;
}

/**
 * WinAnsi-safe text, in falling steps — because a person's name on their own receipt is
 * not a place to be careless.
 *
 *   1. An explicit map for symbols with a known written equivalent (₹ -> Rs., smart
 *      quotes -> straight, em dash -> hyphen).
 *   2. The character itself, if WinAnsi can carry it. Latin-1 (U+00A0-U+00FF) can, so
 *      "José" and "Müller" render exactly as typed.
 *   3. ACCENT-STRIPPING for everything else Latin: "Priyā" -> "Priya", NOT "Priy?".
 *      NFD decomposes ā into "a" + a combining macron; we drop the mark and keep the
 *      letter. This is how a transliterated Sanskrit/Hindi name (ā ī ū ṭ ḍ ṇ ś ṣ ṛ) —
 *      which this client WILL have — stays readable instead of turning into "Priy?".
 *   4. Only a character with NO Latin base (Devanagari, CJK) becomes "?" — and it becomes
 *      a VISIBLE "?", never a silent deletion. Rendering those needs an embedded Unicode
 *      font; see the header.
 */
export function toWinAnsi(text: string): string {
  const MAP: Record<string, string> = {
    '₹': 'Rs.',                                   // ₹ — see the header comment
    '₨': 'Rs.',
    '‘': "'", '’': "'", '“': '"', '”': '"',
    '–': '-', '—': '-', '…': '...', ' ': ' ', '•': '-',
  };
  const winAnsiOk = (c: number) => (c >= 32 && c <= 126) || (c >= 160 && c <= 255);
  let out = '';
  for (const ch of String(text ?? '')) {
    if (MAP[ch] !== undefined) { out += MAP[ch]; continue; }
    const c = ch.codePointAt(0)!;
    if (winAnsiOk(c)) { out += ch; continue; }
    const stripped = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (stripped && [...stripped].every((x) => winAnsiOk(x.codePointAt(0)!))) { out += stripped; continue; }
    out += '?';
  }
  return out;
}

/** Escape for a PDF literal string. */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

const f = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export interface TextOpts {
  size?: number; font?: FontName; color?: Rgb;
  align?: 'left' | 'right' | 'center';
  /** right/centre alignment needs the box the text is aligned within */
  width?: number;
}

/**
 * A4 portrait, points, ORIGIN AT TOP-LEFT (y grows downward), because every layout in
 * this file is written the way a human reads a page. The transform to PDF's
 * bottom-left origin happens in one place, on the way out.
 */
export class PdfPage {
  static readonly WIDTH = 595.28;
  static readonly HEIGHT = 841.89;
  private ops: string[] = [];

  private y(v: number) { return PdfPage.HEIGHT - v; }

  text(s: string, x: number, y: number, o: TextOpts = {}): this {
    const size = o.size ?? 10;
    const font = o.font ?? 'Helvetica';
    const str = toWinAnsi(s);
    let tx = x;
    if (o.align === 'right') tx = x + (o.width ?? 0) - textWidth(str, size, font);
    else if (o.align === 'center') tx = x + ((o.width ?? 0) - textWidth(str, size, font)) / 2;
    const c = o.color ?? { r: 0.1, g: 0.1, b: 0.15 };
    this.ops.push(
      `BT /${FONT_KEY[font]} ${f(size)} Tf ${f(c.r)} ${f(c.g)} ${f(c.b)} rg ` +
      `1 0 0 1 ${f(tx)} ${f(this.y(y))} Tm (${esc(str)}) Tj ET`,
    );
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { color?: Rgb; width?: number } = {}): this {
    const c = o.color ?? { r: 0.85, g: 0.85, b: 0.88 };
    this.ops.push(
      `${f(o.width ?? 0.7)} w ${f(c.r)} ${f(c.g)} ${f(c.b)} RG ` +
      `${f(x1)} ${f(this.y(y1))} m ${f(x2)} ${f(this.y(y2))} l S`,
    );
    return this;
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb): this {
    this.ops.push(`${f(color.r)} ${f(color.g)} ${f(color.b)} rg ${f(x)} ${f(this.y(y + h))} ${f(w)} ${f(h)} re f`);
    return this;
  }

  /** Word-wrap into `width`, returning the y after the last line. */
  paragraph(s: string, x: number, y: number, width: number, o: TextOpts & { leading?: number } = {}): number {
    const size = o.size ?? 9;
    const font = o.font ?? 'Helvetica';
    const leading = o.leading ?? size * 1.4;
    const words = toWinAnsi(s).split(/\s+/).filter(Boolean);
    let line = '';
    let cy = y;
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (textWidth(next, size, font) > width && line) {
        this.text(line, x, cy, o); cy += leading; line = w;
      } else line = next;
    }
    if (line) { this.text(line, x, cy, o); cy += leading; }
    return cy;
  }

  /** Truncate with an ellipsis so a long course name cannot overrun its column. */
  static clip(s: string, width: number, size: number, font: FontName = 'Helvetica'): string {
    const t = toWinAnsi(s);
    if (textWidth(t, size, font) <= width) return t;
    let out = t;
    while (out.length > 1 && textWidth(`${out}...`, size, font) > width) out = out.slice(0, -1);
    return `${out}...`;
  }

  get content(): string { return this.ops.join('\n'); }
}

/** Build the PDF file bytes from one or more pages. */
export function buildPdf(pages: PdfPage[], meta: { title?: string; author?: string } = {}): Buffer {
  const objs: string[] = [];
  const add = (body: string) => { objs.push(body); return objs.length; };   // 1-based object number

  const fontIds: Record<string, number> = {};
  for (const [name, key] of Object.entries(FONT_KEY)) {
    fontIds[key] = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
  }
  const resources = `<< /Font << ${Object.entries(fontIds).map(([k, id]) => `/${k} ${id} 0 R`).join(' ')} >> >>`;

  const pagesId = objs.length + 1 + pages.length * 2 + 1;   // reserved; filled below
  const pageIds: number[] = [];
  for (const p of pages) {
    const stream = p.content;
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f(PdfPage.WIDTH)} ${f(PdfPage.HEIGHT)}] ` +
      `/Resources ${resources} /Contents ${contentId} 0 R >>`,
    ));
  }
  const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  // the /Parent forward reference must be right — assert rather than ship a broken file
  if (realPagesId !== pagesId) {
    for (let i = 0; i < objs.length; i++) objs[i] = objs[i].split(`${pagesId} 0 R`).join(`${realPagesId} 0 R`);
  }
  const infoId = add(
    `<< /Title (${esc(toWinAnsi(meta.title ?? 'Document'))}) /Producer (Tech Lingua CRM) ` +
    `/Author (${esc(toWinAnsi(meta.author ?? 'Tech Lingua LLP'))}) >>`,
  );
  const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`;
  out += `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
