/**
 * RFC-4180 CSV parser (PROJECT_STATUS §5 listed "quoted-CSV import" as deferred —
 * this closes it). Handles, correctly:
 *   - quoted fields containing commas:      "Sharma, Priya"
 *   - quoted fields containing NEWLINES:    "Line1\nLine2"
 *   - escaped quotes inside quotes:         "He said ""hi"""
 *   - CRLF / LF / CR line endings, a UTF-8 BOM, and a trailing newline
 *   - ragged rows (short rows pad with '', long rows keep the extras)
 * Deliberately NOT split(',') — that was the bug this replaces.
 */

export interface ParsedCsv {
  headers: string[];
  /** data rows only (header excluded), each already aligned to headers.length */
  rows: string[][];
}

/** Low-level: raw records (including the header record). */
export function parseCsvRecords(input: string, delimiter = ','): string[][] {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input; // strip BOM
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => { endField(); records.push(record); record = []; };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped ""
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { endField(); i++; continue; }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      endRecord(); i++; continue;
    }
    if (ch === '\n') { endRecord(); i++; continue; }
    field += ch; i++;
  }
  // trailing field/record (file not ending in a newline)
  if (field !== '' || record.length) endRecord();

  // drop wholly empty records (blank lines)
  return records.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** Detect the delimiter from the header line: , ; | or tab (comma wins ties). */
export function sniffDelimiter(input: string): string {
  const line = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).split(/\r?\n/)[0] ?? '';
  const counts: Array<[string, number]> = [',', ';', '\t', '|'].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** Parse into { headers, rows } with rows padded/aligned to the header count. */
export function parseCsv(input: string, delimiter?: string): ParsedCsv {
  const recs = parseCsvRecords(input, delimiter ?? sniffDelimiter(input));
  if (!recs.length) return { headers: [], rows: [] };
  const headers = recs[0].map((h) => h.trim());
  const rows = recs.slice(1).map((r) => {
    const out = r.slice(0, headers.length);
    while (out.length < headers.length) out.push('');
    return out;
  });
  return { headers, rows };
}

/** Row array -> { header: value } object. */
export function rowToObject(headers: string[], row: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  headers.forEach((h, i) => { o[h] = (row[i] ?? '').trim(); });
  return o;
}

/** Serialise back to RFC-4180 CSV (used by the downloadable error report). */
export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n') + '\r\n';
}
