/**
 * =============================================================================
 * DATE NORMALISATION AT THE BOUNDARY — the one place a date becomes a string.
 * =============================================================================
 *
 * THIS FILE EXISTS BECAUSE THE SAME BUG SHIPPED TWICE.
 *
 *   DEF-S6-02 (Sprint 6)  — the CSV export printed
 *                           `Thu Jul 16 2026 13:56:11 GMT+0000 (Coordinated Universal Time)`
 *                           in every date column.
 *   DEF-S16-02 (sign-off) — `POST /quotations/:id/revise` with no `valid_until` returned
 *                           400 "The validity date must be a date.", because the
 *                           `?? cur.valid_until` fallback fed a `Date` into
 *                           `String(v).slice(0, 10)` and got `"Mon Aug 31"`.
 *
 * They are ONE bug. `node-postgres` returns a `date`/`timestamptz` column as a **Date
 * object**, and `String(aDate)` is `"Mon Aug 31 2026 00:00:00 GMT+0000 (...)"` — so
 * `.slice(0, 10)` yields `"Mon Aug 31"`, which no date regex matches and no human wants
 * to read. Every fixture in the suite passes dates as **strings**, so
 * **a test double cannot be wrong about a type it never produces** — 1,298 green tests
 * were structurally incapable of noticing either one.
 *
 * DEF-S16-02's real lesson is not "fix line 334". It is that the Sprint-6 fix went where
 * the bug was FOUND and not where the PATTERN LIVES. So the pattern now lives here, once:
 *
 *   - `toDateString(v)`  -> 'YYYY-MM-DD' | null     (a `date` column, a form field, null)
 *   - `toIsoString(v)`   -> full ISO 8601 | null    (a `timestamptz` column)
 *
 * Both accept `Date`, `string`, `null` and `undefined`, because at a boundary you do not
 * get to choose which one arrives. `date-pattern.spec.ts` then greps `api/src` and FAILS
 * THE BUILD on any new `String(x).slice(0, 10)` outside a written allowlist, so the third
 * instance cannot be written — which is the only kind of fix that closes a class.
 *
 * WHY NOT A pg TYPE PARSER? Registering a parser for OID 1082 so `date` columns arrive as
 * strings would kill the class at the source — and it would silently change the shape of
 * every date in every API response and every `.getTime()` call in the codebase, with a
 * suite whose doubles cannot see the difference. That is precisely the change this project
 * has learned not to make in a sign-off week. Noted in `docs/dev/08` §9 as Phase-2 work.
 */

/** A `date` column read back from Postgres arrives as a Date at the process's midnight. */
function isDate(v: unknown): v is Date {
  return v instanceof Date || Object.prototype.toString.call(v) === '[object Date]';
}

/**
 * Normalise anything a date can arrive as into `'YYYY-MM-DD'`, or `null`.
 *
 * - `Date`   -> its LOCAL calendar day, because that is how node-postgres builds a `date`
 *               column's Date (at the process's local midnight). See the note in the
 *               function: `toISOString()` here would be one day early under any TZ east
 *               of UTC, which is exactly what the suite runs under.
 * - `string` -> the first 10 characters IF they are already a date; an ISO timestamp
 *               (`2026-08-31T00:00:00.000Z`) and a bare `2026-08-31` both work.
 * - `''` / null / undefined -> `null`. A cleared date input posts `''`; that is NULL,
 *               not an error (the 22P02 lesson in `hierarchy.service.ts`).
 *
 * Returns `undefined` for "this is not a date" so the caller decides whether that is a
 * 400 or a default — this helper does not throw, because two callers already have their
 * own, better-worded messages and those sentences are the client's.
 */
export function toDateString(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (isDate(v)) {
    if (Number.isNaN(v.getTime())) return undefined;
    // LOCAL parts, deliberately — NOT toISOString().
    //
    // node-postgres builds a `date` column's Date at the PROCESS'S LOCAL MIDNIGHT. Under
    // TZ=Asia/Calcutta the stored day 2026-08-31 arrives as 2026-08-30T18:30:00Z, so
    // `toISOString().slice(0, 10)` would hand back 2026-08-30 — the DEF-S6-02 bug wearing
    // a different hat, silently one day early on every date the client reads.
    //
    // Reading the LOCAL parts recovers the stored calendar day whatever the deployment's
    // TZ is, so this is correct under UTC (Railway today) AND under IST (what the jest
    // suite actually runs, which is how the mistake was caught). Pinned by a test that
    // fails against the toISOString version.
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`;
  }
  const s = String(v).trim();
  if (s === '') return null;
  const head = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : undefined;
}

/**
 * The same normalisation for a full timestamp. `Date` -> ISO; a string is trusted once it
 * parses. Used where DEF-S6-02's `Date`-stringification was visible to the client.
 */
export function toIsoString(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (isDate(v)) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  const s = String(v).trim();
  if (s === '') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * `toDateString` with a caller-supplied 400. The two money modules (quotations,
 * enrolments) each want their own sentence — "The validity date must be a date." vs
 * "The start date must be a date." — so the message stays theirs and only the parsing
 * moves here.
 */
export function requireDateString(v: unknown, onInvalid: () => never): string | null {
  const d = toDateString(v);
  if (d === undefined) onInvalid();
  return d;
}
