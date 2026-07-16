import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inflateRawSync } from 'zlib';
import { RUPEE, buildCsv, buildXlsx, csvDate, excelSerial, xesc, zip } from './xlsx.util';

/**
 * =============================================================================
 * THESE TESTS UNZIP THE OUTPUT AND READ THE CELLS BACK.
 * =============================================================================
 *
 * The Sprint-5 quotation PDF shipped with two columns printing on top of each other while
 * 25 tests passed, because every one of them asserted the numbers were PRESENT and none
 * asserted they were READABLE. "The buffer is 4KB and contains the word Total" is that
 * same test, in a new module.
 *
 * So: a real ZIP parser, a real XML read, and assertions about what is actually in the
 * cells. If the workbook is malformed, Excel shows a repair prompt and an empty grid -
 * which no assertion about buffer length can ever see.
 */

/* ------------------------------------------------------------ a tiny unzipper */

function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const dataAt = i + 30 + nameLen + extraLen;
    const data = buf.subarray(dataAt, dataAt + compSize);
    out.set(name, method === 8 ? inflateRawSync(data).toString('utf8') : data.toString('utf8'));
    i = dataAt + compSize;
  }
  return out;
}

const COLS = [
  { label: 'Name', type: 'text' as const },
  { label: 'Net fee', type: 'money' as const },
  { label: 'Leads', type: 'number' as const },
  { label: 'Closed on', type: 'datetime' as const },
  { label: 'Won', type: 'bool' as const },
];
const ROWS: unknown[][] = [
  ['Priya Sharma', 123456700, 12, '2026-07-16T10:30:00.000Z', true],
  ['Ravi Kumar', 4999, 0, null, false],
];

describe('the ZIP container is a real ZIP', () => {
  it('round-trips through an independent unzipper', () => {
    const buf = zip([{ name: 'a.txt', data: 'hello' }, { name: 'b/c.txt', data: 'world' }]);
    const files = unzip(buf);
    expect(files.get('a.txt')).toBe('hello');
    expect(files.get('b/c.txt')).toBe('world');
  });

  it('the workbook opens - every part is present and parseable', () => {
    const files = unzip(buildXlsx({ name: 'Report', columns: COLS, rows: ROWS }));
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
      expect({ part, present: files.has(part) }).toEqual({ part, present: true });
    }
  });

  it('identical data produces a BYTE-IDENTICAL file (the fixed zip timestamp)', () => {
    const a = buildXlsx({ name: 'R', columns: COLS, rows: ROWS });
    const b = buildXlsx({ name: 'R', columns: COLS, rows: ROWS });
    expect(a.equals(b)).toBe(true);
  });
});

describe('the CELLS say what they should', () => {
  const sheet = () => unzip(buildXlsx({ name: 'Report', columns: COLS, rows: ROWS })).get('xl/worksheets/sheet1.xml')!;

  it('every header is present', () => {
    const xml = sheet();
    for (const c of COLS) expect(xml).toContain(`<t>${c.label}</t>`);
  });

  it('a text cell carries the text', () => {
    expect(sheet()).toContain('Priya Sharma');
  });

  /**
   * THE MONEY RULE. 123456700 paise = 12,34,567.00 rupees - and it must be in the file as
   * the NUMBER 1234567, styled, not as the string "12,34,567.00". A money column written
   * as text looks identical on screen and is DEAD IN A FORMULA: the client selects the
   * column, sees no total in the status bar, and re-types the report by hand.
   */
  it('MONEY IS A NUMBER IN RUPEES, not a formatted string', () => {
    const xml = sheet();
    expect(xml).toContain('<v>1234567</v>');       // 123456700 paise / 100
    expect(xml).toContain('<v>49.99</v>');         // 4999 paise
    expect(xml).not.toContain('12,34,567.00');     // NOT text
    expect(xml).not.toContain('>Rs');
  });

  it('the money cells carry the money STYLE (which is what renders the symbol + grouping)', () => {
    expect(sheet()).toMatch(/<c r="B\d+" s="4"><v>1234567<\/v><\/c>/);
  });

  /**
   * INDIAN GROUPING. `##,##,##0.00` gives 12,34,567.00. `#,##0.00` - the default anybody
   * would reach for - gives 1,234,567.00, which is not how the client reads a number.
   */
  it('the number format is the INDIAN lakh/crore grouping, and carries the rupee symbol', () => {
    const styles = unzip(buildXlsx({ name: 'R', columns: COLS, rows: ROWS })).get('xl/styles.xml')!;
    expect(styles).toContain('##,##,##0.00');
    expect(styles).toContain(RUPEE);
    expect(RUPEE).toBe('\u20B9');
  });

  /**
   * THE DELIBERATE DIFFERENCE FROM THE PDF, PINNED IN BOTH DIRECTIONS. Excel is Unicode
   * and shows the real symbol; the PDFs print "Rs." because the base-14 fonts have no
   * glyph for it. Both behaviours are asserted, each in its own file, so neither drifts
   * while the client's font decision (PROJECT_STATUS section 4d) is open. Making Excel
   * worse to match the PDF would be consistency paid for out of his spreadsheet.
   */
  it('EXCEL SHOWS THE RUPEE SYMBOL - the PDF does not, and that is on purpose', () => {
    const styles = unzip(buildXlsx({ name: 'R', columns: COLS, rows: ROWS })).get('xl/styles.xml')!;
    expect(styles).toContain('\u20B9');
    const pdfUtil = readFileSync(join(__dirname, '..', 'pdf', 'pdf.util.ts'), 'utf8');
    expect(pdfUtil).toContain('WinAnsi');
    expect(pdfUtil).toContain('has no glyph for it in Helvetica');
  });

  it('a number cell is a number; a bool is a bool; a date is a serial', () => {
    const xml = sheet();
    expect(xml).toContain('<v>12</v>');
    expect(xml).toMatch(/t="b"[^>]*><v>1<\/v>/);
    expect(xml).toContain(String(excelSerial(new Date('2026-07-16T10:30:00.000Z'))));
  });

  it('excelSerial is right for known dates (1899-12-30 epoch, 1900 leap bug included)', () => {
    expect(excelSerial(new Date('1900-01-01T00:00:00Z'))).toBe(2);
    expect(excelSerial(new Date('2026-07-16T00:00:00Z'))).toBe(46219);
  });

  it('a NULL cell is omitted, not written as the string "null"', () => {
    const xml = sheet();
    expect(xml).not.toContain('>null<');
    expect(xml).not.toContain('>undefined<');
  });

  it('the preamble carries the SCOPE NOTE into the file itself', () => {
    const xml = unzip(buildXlsx({
      name: 'R', columns: COLS, rows: ROWS,
      preamble: ['My report', 'Generated today', 'Showing only the records your role gives you access to.'],
    })).get('xl/worksheets/sheet1.xml')!;
    // A spreadsheet forwarded to somebody else must still say whose view of the data it
    // is, or two people compare two exports of "the same report", get different totals,
    // and file a bug against a report that is working correctly.
    expect(xml).toContain('Showing only the records your role gives you access to.');
  });

  it('the header row is frozen and autofiltered (a 500-row report is unusable otherwise)', () => {
    const xml = sheet();
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('<autoFilter');
  });
});

describe('the things that make Excel REFUSE to open a file', () => {
  it('XML metacharacters in the data are escaped, & first', () => {
    expect(xesc('Tom & Jerry <b>"x"</b>')).toBe('Tom &amp; Jerry &lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    expect(xesc('a & b')).not.toContain('&amp;amp;');
  });

  /** A raw control character is not "rendered oddly" - it is a repair prompt and an empty
   *  grid. A lead's remark pasted out of a PDF can carry one, and one bad character must
   *  not cost the client his whole export. */
  it('a CONTROL CHARACTER in a lead note is stripped, not written', () => {
    const note = 'bad\u0007char\u0001here';
    const xml = unzip(buildXlsx({
      name: 'R', columns: [{ label: 'Note', type: 'text' }], rows: [[note]],
    })).get('xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('badcharhere');
    expect(xml).not.toContain('\u0007');
    expect(xml).not.toContain('\u0001');
  });

  it('tab and newline SURVIVE (they are legal XML) - only the illegal ones go', () => {
    expect(xesc('a\tb\nc')).toBe('a\tb\nc');
  });

  it('a sheet name with a colon or a slash is sanitised, and truncated at 31 chars', () => {
    const wb = unzip(buildXlsx({ name: 'Leads: won / lost [2026] - a very long report name indeed', columns: COLS, rows: [] })).get('xl/workbook.xml')!;
    const name = /name="([^"]*)"/.exec(wb)![1];
    expect(name).not.toMatch(/[:\\/?*\[\]]/);
    expect(name.length).toBeLessThanOrEqual(31);
  });

  it('an EMPTY report still produces a valid workbook (the first thing a client will do)', () => {
    const files = unzip(buildXlsx({ name: 'R', columns: COLS, rows: [] }));
    expect(files.get('xl/worksheets/sheet1.xml')).toContain('<t>Name</t>');
  });

  it('a report with NO columns does not crash', () => {
    expect(() => buildXlsx({ name: 'R', columns: [], rows: [] })).not.toThrow();
  });
});

describe('CSV', () => {
  it('starts with a UTF-8 BOM, or Excel on Windows mangles every accented name', () => {
    const buf = buildCsv([{ label: 'Name', type: 'text' }], [['Priy\u0101']]);
    expect(buf[0]).toBe(0xEF); expect(buf[1]).toBe(0xBB); expect(buf[2]).toBe(0xBF);
    expect(buf.toString('utf8')).toContain('Priy\u0101');
  });

  /**
   * DEF-S6-02, FOUND BY THE LIVE SMOKE AND NOT BY ANY OF THESE TESTS.
   *
   * Every fixture in this file passes a date as a STRING, because that is what a
   * hand-written fixture looks like. `node-postgres` returns a real `Date` OBJECT, and
   * `String(new Date())` is "Thu Jul 16 2026 13:56:11 GMT+0000 (Coordinated Universal
   * Time)" — which is exactly what the client's first CSV export contained.
   *
   * So this test passes a REAL Date, deliberately. The double cannot be wrong about a
   * type it never produces — the fix is to produce it.
   */
  it('a real Date OBJECT (what pg actually returns) formats, not Date.toString()', () => {
    const out = buildCsv(
      [{ label: 'When', type: 'datetime' }],
      [[new Date('2026-07-16T13:56:11.000Z')]],
    ).toString('utf8');
    expect(out).toContain('2026-07-16 13:56');
    expect(out).not.toContain('GMT');
    expect(out).not.toContain('Coordinated Universal Time');
  });

  it('a date STRING formats identically — both paths agree', () => {
    const asDate = buildCsv([{ label: 'When', type: 'datetime' }], [[new Date('2026-07-16T13:56:11.000Z')]]).toString('utf8');
    const asString = buildCsv([{ label: 'When', type: 'datetime' }], [['2026-07-16T13:56:11.000Z']]).toString('utf8');
    expect(asDate).toBe(asString);
  });

  it('a `date` column has no time on it', () => {
    expect(csvDate(new Date('2026-07-16T13:56:11.000Z'), 'date')).toBe('2026-07-16');
    expect(csvDate(new Date('2026-07-16T13:56:11.000Z'), 'datetime')).toBe('2026-07-16 13:56');
  });

  it('the format is sortable and unambiguous (not 7/8 vs 8/7)', () => {
    const rows = [[new Date('2026-01-02T00:00:00Z')], [new Date('2026-02-01T00:00:00Z')]];
    const out = buildCsv([{ label: 'When', type: 'date' }], rows).toString('utf8');
    expect(out).toContain('2026-01-02');
    expect(out).toContain('2026-02-01');
    // as TEXT, 2026-01-02 sorts before 2026-02-01 — which is also the true order
    expect(out.indexOf('2026-01-02')).toBeLessThan(out.indexOf('2026-02-01'));
  });

  it('a value that is not a date at all is passed through, not turned into "Invalid Date"', () => {
    expect(csvDate('not a date', 'date')).toBe('not a date');
  });

  it('money is plain rupees with 2dp - a CSV has no number formats', () => {
    expect(buildCsv([{ label: 'Fee', type: 'money' }], [[123456700]]).toString('utf8')).toContain('1234567.00');
  });

  /**
   * FORMULA INJECTION. A lead whose name is `=cmd|' /C calc'!A0` is a COMMAND in a file
   * the client opens on his own laptop. A CRM whose export can run a program is a CRM
   * with a CVE.
   */
  it('a cell starting with = + - or @ is neutralised', () => {
    const out = buildCsv([{ label: 'Name', type: 'text' }], [
      ["=cmd|' /C calc'!A0"], ['+1234'], ['-x'], ['@SUM(A1)'],
    ]).toString('utf8');
    expect(out).toContain("'=cmd");
    expect(out).toContain("'+1234");
    expect(out).toContain("'-x");
    expect(out).toContain("'@SUM");
  });

  it('quotes, commas and newlines are quoted and doubled', () => {
    const out = buildCsv([{ label: 'Note', type: 'text' }], [['he said "hi", then left\nagain']]).toString('utf8');
    expect(out).toContain('"he said ""hi"", then left\nagain"');
  });

  it('CRLF line endings (what every Windows spreadsheet expects)', () => {
    expect(buildCsv([{ label: 'A', type: 'text' }], [['1'], ['2']]).toString('utf8')).toContain('A\r\n1\r\n2');
  });
});

/**
 * THE REAL CHECK, when the box has a tool for it. `unzip -t` is an INDEPENDENT
 * implementation, so it catches the class of bug where our writer and our reader make the
 * same wrong assumption and agree with each other perfectly.
 */
describe('an independent tool agrees the archive is valid', () => {
  const hasUnzip = (() => { try { execSync('which unzip', { stdio: 'ignore' }); return true; } catch { return false; } })();
  (hasUnzip ? it : it.skip)('`unzip -t` reports no errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
    const f = join(dir, 'r.xlsx');
    writeFileSync(f, buildXlsx({ name: 'Report', columns: COLS, rows: ROWS }));
    expect(execSync(`unzip -t ${f}`).toString()).toContain('No errors detected');
  });
});
