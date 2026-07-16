import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { toDateString, toIsoString, requireDateString } from './date.util';

/**
 * =============================================================================
 * DEF-S16-02 — PINNING THE PATTERN, NOT THE TWO KNOWN SITES.
 * =============================================================================
 *
 * The Sprint-6 fix for DEF-S6-02 was applied where the bug was FOUND (the CSV exporter).
 * The identical bug was still sitting in `quotation.service.ts` one commit later, and a
 * third — `{{lead.dob}}` rendering "Mon Aug 31" inside a real customer message — was
 * sitting in `template.service.ts` and had never been reported by anyone.
 *
 * Three instances of one pattern is not three bugs. So this file has two halves:
 *
 *   1. BEHAVIOUR — drive the helper with a REAL `Date` object, which is the thing every
 *      fixture in the suite fails to produce. ("A test double cannot be wrong about a
 *      type it never produces" — the team's own words, DEF-S6-02.)
 *   2. THE GREP — walk `api/src` and fail the build on any NEW `String(x).slice(0, 10)`.
 *      This is the half that closes the class: instance #4 cannot be written.
 */

/* ============================== 1. BEHAVIOUR ============================== */

describe('toDateString — the boundary between a pg Date and a date string', () => {
  it('THE DEFECT: a real pg `Date` object becomes YYYY-MM-DD, not "Mon Aug 31"', () => {
    // This is literally what node-postgres hands back for `valid_until DATE`.
    const fromPg = new Date('2026-08-31T00:00:00.000Z');
    expect(String(fromPg).slice(0, 10)).toBe('Mon Aug 31');   // <- the bug, spelled out
    expect(toDateString(fromPg)).toBe('2026-08-31');          // <- the fix
  });

  it('a bare date string passes through unchanged', () => {
    expect(toDateString('2026-08-31')).toBe('2026-08-31');
  });

  it('an ISO timestamp string is truncated to its day', () => {
    expect(toDateString('2026-08-31T13:56:11.000Z')).toBe('2026-08-31');
  });

  it('null, undefined and a cleared date input ("") are all NULL — not an error', () => {
    // A cleared <input type="date"> posts ''. Treating that as invalid is how you get 22P02.
    expect(toDateString(null)).toBeNull();
    expect(toDateString(undefined)).toBeNull();
    expect(toDateString('')).toBeNull();
    expect(toDateString('   ')).toBeNull();
  });

  it('a non-date is `undefined` so the caller can pick its own 400', () => {
    expect(toDateString('yesterday')).toBeUndefined();
    expect(toDateString('31-08-2026')).toBeUndefined();
    expect(toDateString('Mon Aug 31 2026')).toBeUndefined();
    expect(toDateString(new Date('nonsense'))).toBeUndefined();
  });

  it('the whole point: `dto?.x ?? cur.x` works when `cur.x` came from Postgres', () => {
    // DEF-S16-02 exactly: no valid_until in the body, fall back to the stored Date.
    const dto: { valid_until?: string } = {};
    const cur = { valid_until: new Date('2026-08-31T00:00:00.000Z') };
    expect(toDateString(dto?.valid_until ?? cur.valid_until)).toBe('2026-08-31');
  });

  /**
   * THE TIMEZONE TRAP — and the reason this helper does not use toISOString().
   *
   * node-postgres builds a `date` column's Date at the PROCESS'S LOCAL MIDNIGHT. This
   * suite runs under TZ=Asia/Calcutta (for the business-hours tests), which is the same
   * shape as any IST deployment. Under IST, `toISOString().slice(0, 10)` on a pg `date`
   * returns THE DAY BEFORE — a silent off-by-one on every date the client reads.
   *
   * This test constructs the Date exactly as pg does — `new Date(y, m, d)`, local
   * midnight — and it goes RED against a toISOString() implementation.
   */
  it('a pg `date` keeps its calendar day whatever the process timezone is', () => {
    const asPgBuildsIt = new Date(2026, 7, 31);            // local midnight, 31 Aug 2026
    expect(toDateString(asPgBuildsIt)).toBe('2026-08-31');
    expect(toDateString(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(toDateString(new Date(2026, 11, 31))).toBe('2026-12-31');
    // and the proof that this is not a tautology: east of UTC, the ISO day differs.
    if (asPgBuildsIt.getTimezoneOffset() < 0) {
      expect(asPgBuildsIt.toISOString().slice(0, 10)).toBe('2026-08-30');
    }
  });
});

describe('toIsoString — the DEF-S6-02 half (a timestamp on a page)', () => {
  it('a real Date becomes ISO, never "Thu Jul 16 2026 13:56:11 GMT+0000 (…)"', () => {
    const d = new Date('2026-07-16T13:56:11.000Z');
    expect(String(d)).toContain('GMT');                       // <- what the CSV printed
    expect(toIsoString(d)).toBe('2026-07-16T13:56:11.000Z');
  });
  it('null in, null out; garbage in, undefined out', () => {
    expect(toIsoString(null)).toBeNull();
    expect(toIsoString('')).toBeNull();
    expect(toIsoString('not a date')).toBeUndefined();
  });
});

describe('requireDateString — the caller keeps its own sentence', () => {
  it('throws the CALLER’s message, so "The validity date must be a date." stays the client’s', () => {
    const boom = () => requireDateString('rubbish', () => { throw new Error('The validity date must be a date.'); });
    expect(boom).toThrow('The validity date must be a date.');
  });
  it('does NOT throw for a pg Date — the DEF-S16-02 400 is gone', () => {
    expect(requireDateString(new Date('2026-08-31T00:00:00.000Z'), () => { throw new Error('nope'); }))
      .toBe('2026-08-31');
  });
  it('does NOT throw for null — an absent date is not an invalid date', () => {
    expect(requireDateString(null, () => { throw new Error('nope'); })).toBeNull();
  });
});

/* ================================ 2. THE GREP ================================ */

/**
 * THE ALLOWLIST. Every entry names a file and says, in words, why the raw slice there is
 * NOT the bug. An entry with no reason is not an entry. If you are reading this because
 * the test went red: the answer is almost certainly `toDateString()`, not a new entry.
 */
const ALLOWED: Record<string, string> = {
  'common/date.util.ts':
    'THE HELPER ITSELF. It is the one place allowed to slice, because it has already '
    + 'proven the value is a string (or converted a Date via toISOString first).',
  'common/date.util.spec.ts':
    'THIS FILE. It slices deliberately, to demonstrate the defect it exists to prevent.',
  'errorlog/error-log.service.ts':
    'NOT A DATE — `e.method?.slice(0, 10)` truncates an HTTP verb ("PROPPATCH") to fit '
    + 'the column. Nothing here is ever a Date.',
  'ingestion/import.service.ts':
    'NOT A DATE — `rows.slice(0, 10)` takes the first ten CSV rows for the preview.',
  'pdf/pdf.spec.ts':
    'NOT A DATE — slices a fixed-width byte offset out of a PDF xref line.',
  'reports/xlsx.util.ts':
    'ALREADY A STRING — operates on `iso`, the output of `toIsoString`/`.toISOString()`, '
    + 'to split an ISO timestamp into its date and time halves for the cell format.',
};

/**
 * `x.toISOString().slice(0, 10)` is SAFE and common — the value is provably a Date and
 * `toISOString` is exactly the right read. The pattern that bites is `String(x).slice`,
 * where `x` might be a Date and nobody checked. That is what we hunt.
 */
/**
 * `String(x).slice(0, 10)` — the banned shape.
 *
 * The lookbehind is not decoration: `toISOString(` ENDS WITH `String(`, so a naive
 * /String\s*\(/ flags `d.toISOString().slice(0, 10)` — the one form that is provably
 * correct — and the guard spends its life crying wolf about the right answer. (This
 * project's own lesson, twice over: the qa10 matrix's `type="month"` false alarm, and
 * `.btn.primary` before it. A harness that cries wolf is the same bug as one that misses.)
 */
const DANGEROUS = /(?<![A-Za-z0-9_$.])String\s*\([^\n]*?\)\s*\.\s*(?:slice|substring|substr)\s*\(\s*0\s*,\s*10\s*\)/;
const ANY_SLICE_10 = /\.\s*(?:slice|substring|substr)\s*\(\s*0\s*,\s*10\s*\)/;

/** Strip comments before scanning: this file's own prose explains the banned pattern by
 *  quoting it, and a guard that reads its own documentation as a violation is noise. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e)) out.push(p);
  }
  return out;
}

const SRC = join(__dirname, '..');
const FILES = walk(SRC);

describe('DEF-S16-02 — the PATTERN is closed, not just the two sites', () => {
  it('the sweep actually reads the codebase (a guard that scans nothing passes everything)', () => {
    expect(FILES.length).toBeGreaterThan(80);
    expect(FILES.some((f) => f.endsWith('quotation.service.ts'))).toBe(true);
  });

  it('NO file stringifies a possible Date and slices it — `String(x).slice(0, 10)` is banned', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const rel = relative(SRC, f).replace(/\\/g, '/');
      if (ALLOWED[rel]) continue;
      codeOnly(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        if (DANGEROUS.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    // If this is red: use `toDateString(v)` from common/date.util.ts. It handles Date,
    // string, '' and null. Do NOT add yourself to ALLOWED unless the value provably
    // cannot be a Date — and then WRITE THE REASON.
    expect(offenders).toEqual([]);
  });

  it('every `.slice(0, 10)` left in the codebase is either a Date-proven toISOString or allowlisted WITH A REASON', () => {
    const unexplained: string[] = [];
    for (const f of FILES) {
      const rel = relative(SRC, f).replace(/\\/g, '/');
      if (ALLOWED[rel]) continue;
      codeOnly(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        if (!ANY_SLICE_10.test(line)) return;
        // `x.toISOString().slice(0, 10)` is SAFE: the value is provably a Date and
        // toISOString is exactly the right read. The pattern that bites is String(x).
        if (/toISOString/.test(line)) return;
        unexplained.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(unexplained).toEqual([]);
  });

  it('the allowlist has not gone stale — every entry names a file that still exists and still slices', () => {
    const stale: string[] = [];
    for (const [rel, reason] of Object.entries(ALLOWED)) {
      expect(reason.length).toBeGreaterThan(30);   // a reason, or it is not an entry
      const p = join(SRC, rel);
      let src: string;
      try { src = readFileSync(p, 'utf8'); } catch { stale.push(`${rel} — file is gone`); continue; }
      if (!ANY_SLICE_10.test(src)) stale.push(`${rel} — no longer slices; delete this entry`);
    }
    expect(stale).toEqual([]);
  });

  it('the three known instances are gone from the three files that had them', () => {
    for (const f of ['quotations/quotation.service.ts', 'templates/template.service.ts', 'enrolments/enrolment.service.ts']) {
      const code = codeOnly(readFileSync(join(SRC, f), 'utf8'));
      expect(`${f}: ${DANGEROUS.test(code)}`).toBe(`${f}: false`);
      expect(code).toContain('date.util');
    }
  });
});
