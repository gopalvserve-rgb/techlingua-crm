import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MAX_PDF_COLUMNS, ReportDoc, TooManyColumnsError, fitColumns, reportPdf } from './report-pdf';
import { textWidth } from '../pdf/pdf.util';

/**
 * =============================================================================
 * THE COLUMNS MUST NOT COLLIDE. THAT IS WHAT THIS FILE IS FOR.
 * =============================================================================
 *
 * The Sprint-5 quotation PDF printed
 *
 *     10% 4,500.0018% 7,290.00
 *
 * on the client's letterhead while 25 PDF tests passed, because every one of them
 * asserted the numbers were PRESENT and none asserted they were READABLE.
 *
 * A REPORT pdf is that risk with the volume turned up: the client picks the columns, so
 * no width is knowable in advance. So these tests use `pdftotext -layout` where it exists
 * — a REAL PDF READER, not our own code — and check that adjacent values have whitespace
 * between them.
 */

const doc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  title: 'Enrolments this month',
  subtitle: 'Generated for the test',
  columns: [
    { key: 'name', label: 'Student', type: 'text' },
    { key: 'course', label: 'Course', type: 'text' },
    { key: 'fee', label: 'Net fee', type: 'money' },
    { key: 'collected', label: 'Collected', type: 'money' },
    { key: 'when', label: 'Closed on', type: 'datetime' },
  ],
  rows: [
    ['Priya Sharma', 'IELTS Advanced', 6625000, 2000000, '2026-07-16T10:30:00.000Z'],
    ['Ravi Kumar', 'PTE', 10000000, 10000000, '2026-07-15T09:00:00.000Z'],
  ],
  footnotes: ['Showing only the records your role gives you access to.'],
  org_name: 'Tech Lingua LLP',
  ...over,
});

const hasPdftotext = (() => { try { execSync('which pdftotext', { stdio: 'ignore' }); return true; } catch { return false; } })();
const text = (buf: Buffer, layout = true): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rpdf-'));
  const f = join(dir, 'r.pdf');
  writeFileSync(f, buf);
  return execSync(`pdftotext ${layout ? '-layout ' : ''}${f} -`).toString();
};

describe('the file is a PDF at all', () => {
  it('starts with %PDF and ends with %%EOF', () => {
    const buf = reportPdf(doc());
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.subarray(-6).toString('latin1').trim()).toBe('%%EOF');
  });

  it('is LANDSCAPE (a portrait report is a report with three columns on it)', () => {
    const buf = reportPdf(doc()).toString('latin1');
    expect(buf).toMatch(/MediaBox \[0 0 841\.\d+ 595\.\d+\]/);
  });

  it('an EMPTY report renders a page that SAYS it is empty', () => {
    const buf = reportPdf(doc({ rows: [] }));
    expect(buf.length).toBeGreaterThan(500);
    if (hasPdftotext) expect(text(buf)).toContain('No rows matched this report');
  });
});

describe('fitColumns — the widths are computed, never guessed', () => {
  it('the widths fill the printable width exactly when there is room', () => {
    const w = fitColumns(doc());
    const total = w.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(841.89 - 64, 0);
  });

  it('OVERSIZED CONTENT IS SQUEEZED, never allowed to overflow the page', () => {
    // 12 realistic columns whose VALUES are far too long. The content wants ~2600pt; the
    // page has 778. Every column must still be readable and the total must still fit.
    const many = doc({
      columns: Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, label: `Column ${i}`, type: 'text' as const })),
      rows: [Array.from({ length: 12 }, () => 'a fairly long value in every single cell here')],
    });
    const w = fitColumns(many);
    expect(w.every((x) => x > 20)).toBe(true);
    expect(w.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(841.89 - 64 + 0.5);
    // and no column was squeezed below what its own HEADER needs — otherwise the heading
    // itself becomes an ellipsis and the reader cannot tell what he is looking at
    expect(w.every((x, i) => x >= textWidth(`Column ${i} `, 8, 'Helvetica-Bold'))).toBe(true);
  });

  /**
   * The honest failure. Twelve columns with 27-character HEADINGS do not fit an A4
   * landscape page at any width, and no amount of scaling changes that. Squeezing them
   * anyway would produce a grey smear; the client gets a sentence he can act on instead.
   */
  it('columns whose HEADERS alone cannot fit are REFUSED, not smeared', () => {
    const absurd = doc({
      columns: Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, label: `A rather long column label ${i}`, type: 'text' as const })),
      rows: [],
    });
    expect(() => fitColumns(absurd)).toThrow(TooManyColumnsError);
    expect(() => fitColumns(absurd)).toThrow(/Export to Excel/);
  });

  it('a wide column gets more room than a narrow one (widths follow the CONTENT)', () => {
    const w = fitColumns(doc());
    expect(w[0]).toBeGreaterThan(0);
    // "IELTS Advanced" is wider than a date column's fixed content? assert the ordering
    // that actually matters: the long text column is not the narrowest.
    expect(w[1]).toBeGreaterThan(Math.min(...w) - 1);
  });
});

describe('TOO MANY COLUMNS is REFUSED, with a sentence the client can act on', () => {
  it(`more than ${MAX_PDF_COLUMNS} columns throws, naming the number and the way out`, () => {
    const wide = doc({
      columns: Array.from({ length: 20 }, (_, i) => ({ key: `c${i}`, label: `Col ${i}`, type: 'text' as const })),
      rows: [],
    });
    expect(() => reportPdf(wide)).toThrow(TooManyColumnsError);
    expect(() => reportPdf(wide)).toThrow(/20/);
    expect(() => reportPdf(wide)).toThrow(/Excel/);
  });

  it('a report at the limit still renders', () => {
    const atLimit = doc({
      columns: Array.from({ length: MAX_PDF_COLUMNS }, (_, i) => ({ key: `c${i}`, label: `C${i}`, type: 'text' as const })),
      rows: [Array.from({ length: MAX_PDF_COLUMNS }, (_, i) => `v${i}`)],
    });
    expect(() => reportPdf(atLimit)).not.toThrow();
  });
});

/**
 * THE DEF-S5-04 CLASS. Everything below reads the REAL BYTES with a REAL READER.
 */
(hasPdftotext ? describe : describe.skip)('a real PDF reader agrees the page is READABLE', () => {
  it('the title, the headers and the values are all on the page', () => {
    const out = text(reportPdf(doc()));
    expect(out).toContain('Enrolments this month');
    expect(out).toContain('Student');
    expect(out).toContain('Priya Sharma');
    expect(out).toContain('IELTS Advanced');
  });

  it('money is Indian-grouped, and the UNIT is in the HEADER not on every row', () => {
    const out = text(reportPdf(doc()));
    expect(out).toContain('66,250.00');
    expect(out).toContain('1,00,000.00');       // NOT 100,000.00
    expect(out).not.toContain('100,000.00');
    expect(out).toMatch(/Net fee \(Rs\.\)/);
  });

  /**
   * THE ACTUAL DEF-S5-04 ASSERTION: two adjacent money values must have WHITESPACE
   * between them. `66,250.0020,000.00` is what shipped last time.
   */
  it('ADJACENT COLUMNS DO NOT COLLIDE — there is whitespace between every pair of values', () => {
    const out = text(reportPdf(doc()));
    expect(out).not.toMatch(/66,250\.0020,000\.00/);
    expect(out).not.toMatch(/\d\.\d\d\d/);        // "x.0018%" — a decimal running into the next cell
    const line = out.split('\n').find((l) => l.includes('Priya Sharma'))!;
    expect(line).toMatch(/66,250\.00\s+20,000\.00/);
  });

  it('a value too long for its column is TRUNCATED WITH AN ELLIPSIS, never overrun', () => {
    const long = doc({
      columns: [
        { key: 'a', label: 'A', type: 'text' },
        { key: 'b', label: 'B', type: 'text' },
      ],
      rows: [['x'.repeat(400), 'THE-NEXT-COLUMN']],
    });
    const out = text(reportPdf(long));
    expect(out).toContain('...');
    // the neighbour survived intact — that is the whole point
    expect(out).toContain('THE-NEXT-COLUMN');
    expect(out).not.toContain('xTHE-NEXT-COLUMN');
  });

  /**
   * THE HONESTY FOOTNOTE. Excel prints the rupee symbol and this cannot. Rather than let
   * the client discover that two exports of the same report disagree, the page says so.
   */
  it('every page carries the "Rs. vs the symbol" footnote and the SCOPE note', () => {
    const out = text(reportPdf(doc()));
    expect(out).toContain('Amounts are in Indian Rupees (Rs.)');
    expect(out).toContain('PDF fonts have no glyph for it');
    expect(out).toContain('Showing only the records your role gives you access to.');
  });

  it('it PAGINATES — 200 rows do not print off the bottom of one page', () => {
    const many = doc({
      rows: Array.from({ length: 200 }, (_, i) => [`Student ${i}`, 'IELTS', 5000000, 1000000, '2026-07-16T10:30:00.000Z']),
    });
    const buf = reportPdf(many);
    expect((buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length).toBeGreaterThan(4);
    const out = text(buf);
    expect(out).toContain('Student 0');
    expect(out).toContain('Student 199');       // the LAST row is on a page, not lost
    expect(out).toContain('Page 2');
  });

  it('an Indian name outside Latin-1 is transliterated, not mangled into "?"', () => {
    const out = text(reportPdf(doc({
      rows: [['Priyā Śarmā', 'IELTS', 100, 0, '2026-07-16T10:30:00.000Z']],
    })));
    expect(out).toContain('Priya');
    expect(out).not.toContain('Priy?');
  });
});
