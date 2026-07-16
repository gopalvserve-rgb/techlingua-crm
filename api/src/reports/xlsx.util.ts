import { deflateRawSync } from 'zlib';

/**
 * =============================================================================
 * A MINIMAL, DEPENDENCY-FREE .XLSX WRITER.
 * =============================================================================
 *
 * WHY NOT exceljs / xlsx?
 * The same reasoning as pdf/pdf.util.ts, and the same author's-note obligation. An
 * .xlsx is a ZIP of a handful of XML parts. What a report export needs from it is: a
 * header row, typed cells, a date format, a money format, and column widths. `exceljs`
 * is several MB installed and pulls a tree into a Railway build for that; `xlsx`
 * (SheetJS) has had a prototype-pollution advisory and a licence change. Node already
 * ships `zlib`, which is the only hard part.
 *
 * This is ~200 lines, has no install step, no version drift, no advisories to track,
 * and - the part that matters - it is a PURE FUNCTION FROM ROWS TO BYTES, so
 * `xlsx.spec.ts` UNZIPS ITS OWN OUTPUT AND READS THE CELLS BACK. A test that asserts
 * "the buffer is non-empty" is the Sprint-5 PDF lesson: 25 tests passed while the
 * Discount and Tax columns printed on top of each other, because every one of them
 * asserted the numbers were PRESENT and none asserted they were READABLE.
 *
 * =============================================================================
 * THE RUPEE SIGN - DIFFERENT FROM THE PDF, ON PURPOSE, AND SAID OUT LOUD
 * =============================================================================
 * Excel is Unicode. The rupee sign works here and it IS used here, with INDIAN DIGIT
 * GROUPING (##,##,##0.00 - the lakh/crore grouping, not the thousands one), so an Excel
 * export shows the real symbol and 12,34,567.00.
 *
 * The PDFs still print "Rs." because the base-14 PDF fonts have no rupee glyph
 * (pdf/pdf.util.ts explains why). SO THE TWO EXPORTS OF THE SAME REPORT DIFFER: Excel
 * shows the symbol, the PDF shows "Rs.". That is not an oversight and it is not hidden:
 * the client has an open decision about embedding a font (PROJECT_STATUS section 4d),
 * the PDF export carries a footnote saying so in words on the page, and xlsx.spec.ts +
 * pdf.spec.ts each pin their own behaviour so neither drifts while the decision is open.
 * Making Excel WORSE to match the PDF would be consistency for its own sake, paid for
 * out of the client's spreadsheet.
 */

/* ------------------------------------------------------------------ tiny zip */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
};

interface Entry { name: string; data: Buffer; deflated: Buffer; crc: number }

/** A ZIP container. DEFLATE, no encryption, no zip64 - an export is kilobytes. */
export function zip(files: Array<{ name: string; data: string | Buffer }>): Buffer {
  const entries: Entry[] = files.map((f) => {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    return { name: f.name, data, deflated: deflateRawSync(data), crc: crc32(data) };
  });

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // method: deflate
    local.writeUInt16LE(0, 10);           // time
    local.writeUInt16LE(0x2821, 12);      // date - deliberately fixed, so identical data
                                          // produces a byte-identical file. That is worth
                                          // more than a timestamp nobody reads.
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.deflated.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, e.deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.deflated.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + e.deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ----------------------------------------------------------------- the sheet */

export type CellType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'bool';
export interface SheetColumn { label: string; type: CellType }

/** The rupee sign, by code point. Never as a literal in source - a file that travels
 *  through a build pipeline, an editor and a terminal should not depend on all three
 *  agreeing about an encoding. */
export const RUPEE = '\u20B9';

/** XML text escape. `&` FIRST, or every other escape gets double-escaped. */
export const xesc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Excel REFUSES TO OPEN a file containing a raw control character - not "renders it
    // oddly": a repair prompt and an empty grid. A lead's remark pasted out of a PDF can
    // carry one, and one bad character must not cost the client his whole export.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const colName = (n: number): string => {
  let s = ''; let x = n + 1;
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
  return s;
};

/** Excel's serial date: days since 1899-12-30 (its 1900 leap-year bug included). */
export const excelSerial = (d: Date): number =>
  (d.getTime() - Date.UTC(1899, 11, 30)) / 86400000;

// style ids into the <cellXfs> below
const S_DEFAULT = 0, S_HEADER = 1, S_DATE = 2, S_DATETIME = 3, S_MONEY = 4, S_INT = 5;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="dd\\-mmm\\-yyyy"/>
<numFmt numFmtId="165" formatCode="dd\\-mmm\\-yyyy hh:mm"/>
<numFmt numFmtId="166" formatCode="&quot;${RUPEE}&quot;\\ ##,##,##0.00"/>
</numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * One cell.
 *
 * Values are NEVER strings-that-look-like-numbers: a money cell is a REAL NUMBER with a
 * format, so the client can select the column and read the total off the status bar. An
 * export whose totals must be re-typed by hand is a screenshot with extra steps.
 */
function cell(ref: string, type: CellType, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'money': {
      // paise -> rupees. The DIVISION HAPPENS ONCE, here. Writing the formatted string
      // as TEXT would look identical in the grid and be dead in a formula.
      const n = Number(v) / 100;
      return Number.isFinite(n) ? `<c r="${ref}" s="${S_MONEY}"><v>${n}</v></c>` : '';
    }
    case 'number': {
      const n = Number(v);
      return Number.isFinite(n) ? `<c r="${ref}" s="${Number.isInteger(n) ? S_INT : S_DEFAULT}"><v>${n}</v></c>` : '';
    }
    case 'bool':
      return `<c r="${ref}" t="b" s="${S_DEFAULT}"><v>${v === true || v === 't' || v === 'true' ? 1 : 0}</v></c>`;
    case 'date':
    case 'datetime': {
      const d = v instanceof Date ? v : new Date(String(v));
      if (Number.isNaN(d.getTime())) return `<c r="${ref}" t="inlineStr"><is><t>${xesc(v)}</t></is></c>`;
      return `<c r="${ref}" s="${type === 'date' ? S_DATE : S_DATETIME}"><v>${excelSerial(d)}</v></c>`;
    }
    default:
      // inlineStr, not a sharedStrings part: one fewer XML part to get wrong, and a
      // report has few repeated strings anyway.
      return `<c r="${ref}" t="inlineStr" s="${S_DEFAULT}"><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
  }
}

export interface SheetSpec {
  name: string;
  columns: SheetColumn[];
  rows: unknown[][];
  /** printed above the header, one line each: the title, who ran it, the scope note */
  preamble?: string[];
}

/** Rows -> a real .xlsx buffer. Pure. */
export function buildXlsx(sheet: SheetSpec): Buffer {
  const pre = sheet.preamble ?? [];
  const out: string[] = [];
  let r = 1;

  for (const line of pre) {
    out.push(`<row r="${r}"><c r="A${r}" t="inlineStr"><is><t xml:space="preserve">${xesc(line)}</t></is></c></row>`);
    r++;
  }
  if (pre.length) r++;   // a blank line between the preamble and the table

  const headerRow = r;
  out.push(`<row r="${r}">${sheet.columns.map((c, i) =>
    `<c r="${colName(i)}${r}" t="inlineStr" s="${S_HEADER}"><is><t>${xesc(c.label)}</t></is></c>`).join('')}</row>`);
  r++;

  for (const row of sheet.rows) {
    const cells = sheet.columns.map((c, i) => cell(`${colName(i)}${r}`, c.type, row[i])).filter(Boolean).join('');
    out.push(`<row r="${r}">${cells}</row>`);
    r++;
  }

  // Column widths from the ACTUAL content, capped. A report whose Name column is four
  // characters wide is a report the client re-formats before he can read it.
  const widths = sheet.columns.map((c, i) => {
    const longest = sheet.rows.reduce((m, row) => Math.max(m, String(row[i] ?? '').length), c.label.length);
    const w = c.type === 'money' ? 16 : c.type === 'datetime' ? 18 : c.type === 'date' ? 13 : Math.min(Math.max(longest + 2, 10), 48);
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  }).join('');

  const lastCol = colName(Math.max(0, sheet.columns.length - 1));
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${Math.max(1, r - 1)}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths}</cols>
<sheetData>${out.join('')}</sheetData>
${sheet.columns.length ? `<autoFilter ref="A${headerRow}:${lastCol}${Math.max(headerRow, r - 1)}"/>` : ''}
</worksheet>`;

  // Excel truncates a sheet name at 31 chars and REJECTS : \ / ? * [ ] outright. A report
  // the client names "Leads: won / lost" must not produce a file that will not open.
  const safeName = xesc(String(sheet.name || 'Report').replace(/[:\\/?*\[\]]/g, ' ').slice(0, 31));

  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets>
</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ]);
}

/* -------------------------------------------------------------------- CSV */

/**
 * CSV, with a UTF-8 BOM.
 *
 * The BOM is not cargo cult: without it, Excel on Windows opens a UTF-8 CSV in the
 * system codepage and every name with an accent in it arrives mangled - the exact
 * failure the PDF pipeline avoids by transliterating.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe, because a lead whose
 * name is `=cmd|...` is a FORMULA INJECTION in a file the client opens on his own
 * laptop. A CRM whose export can run a command is a CRM with a CVE.
 */
export function buildCsv(columns: SheetColumn[], rows: unknown[][]): Buffer {
  const q = (v: unknown, type: CellType) => {
    if (v === null || v === undefined) return '';
    let s = type === 'money' ? (Number(v) / 100).toFixed(2) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /["\,\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => q(c.label, 'text')).join(',')];
  for (const r of rows) lines.push(columns.map((c, i) => q(r[i], c.type)).join(','));
  return Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(lines.join('\r\n'), 'utf8')]);
}
