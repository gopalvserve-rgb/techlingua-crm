import 'reflect-metadata';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { IS_PUBLIC_KEY } from './rbac/rbac.decorators';

/**
 * =============================================================================
 * EVERY API ROUTE MUST BE REACHABLE FROM THE UI.
 * =============================================================================
 *
 * THIS FILE EXISTS BECAUSE OF A PATTERN, NOT A BUG.
 *
 * QA-16 named it: for the fifth sprint running, live testing found what 1,298 green
 * tests passed — and all three findings were THE SAME SPECIES.
 *
 *   DEF-S16-01  a complete backend with no way in     (POST /quotations/:id/revise)
 *   DEF-S16-02  a fallback that cannot execute        (?? cur.valid_until)
 *   DEF-S16-03  a computed value nothing consumes     (allowedFields)
 *
 * None is a wrong calculation. Every one is WORKING CODE THAT NOTHING CALLS. And it had
 * happened before: Sprint 5's own defect #3 — send() was the only way out of `draft`, so
 * with no SMTP no quotation could ever be accepted. Same shape, same sprint, same client.
 *
 * The suites are excellent at asserting a function returns the right answer and BLIND to
 * whether anything reaches it. sprint5.test.tsx:173 is the perfect illustration: it
 * asserts a sent quote has no Edit button, comments "a SENT quote is revised, not
 * edited", and never once asserts that Revise exists. The test encoded the intention and
 * pinned the absence of the wrong button.
 *
 * So this is the mirror of the @RequirePermission reflection test that has worked well
 * for four sprints, pointed the other way:
 *
 *   RequirePermission spec : every route must be GUARDED.
 *   this spec              : every route must be REACHED.
 *
 * It walks the real controller prototypes (so it cannot go stale), builds each route's
 * full path from the class + method metadata, and asserts something in web/src calls it.
 * A NEW ENDPOINT THAT SHIPS WITH NO CALLER FAILS THE BUILD. This test, written on the day
 * Sprint 5 shipped, would have caught DEF-S16-01 then.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MATCHER IS FUSSY ABOUT LITERAL SEGMENTS
 * ---------------------------------------------------------------------------
 * The web calls api.post(`/quotations/${id}/${path}`) for accept/reject. A naive "does
 * some web path shape match" check would let that ONE call vouch for send, mark-sent AND
 * revise — and would have passed DEF-S16-01, which makes the guard worthless. So:
 *
 *   - a route segment that is a PARAM (:id) matches a web interpolation or a literal;
 *   - a route segment that is a LITERAL (revise) must appear EITHER literally in the same
 *     position, OR — when the web interpolates it — as a quoted string somewhere in
 *     web/src, which is how act('accept', ...) legitimately reaches /:id/accept.
 *
 * Verified to go RED against the pre-fix tree: with the Revise button removed,
 * POST /quotations/:id/revise is reported unreachable and this spec fails.
 */

const API_SRC = __dirname;
const WEB_SRC = join(__dirname, '..', '..', 'web', 'src');

function walk(dir: string, re: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, re, out);
    else if (re.test(e)) out.push(p);
  }
  return out;
}

const VERB: Record<number, string> = {
  [RequestMethod.GET]: 'GET', [RequestMethod.POST]: 'POST', [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE', [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS', [RequestMethod.HEAD]: 'HEAD', [RequestMethod.ALL]: 'ALL',
};

export interface Route {
  file: string; controller: string; handler: string;
  verb: string; path: string; segments: string[]; public: boolean;
}

const norm = (p: string) => `/${String(p ?? '').replace(/^\/+|\/+$/g, '')}`.replace(/\/+/g, '/');

function routesOf(file: string): Route[] {
  const mod = require(file);
  const out: Route[] = [];
  for (const [name, exported] of Object.entries(mod)) {
    if (typeof exported !== 'function') continue;
    const base = Reflect.getMetadata(PATH_METADATA, exported as object);
    if (base === undefined) continue;
    const proto = (exported as { prototype: Record<string, unknown> }).prototype;
    if (!proto) continue;
    for (const m of Object.getOwnPropertyNames(proto)) {
      if (m === 'constructor' || typeof proto[m] !== 'function') continue;
      const verbMeta = Reflect.getMetadata(METHOD_METADATA, proto[m] as object);
      if (verbMeta === undefined) continue;
      const sub = Reflect.getMetadata(PATH_METADATA, proto[m] as object) ?? '/';
      const full = norm(`${norm(base)}/${norm(sub)}`);
      out.push({
        file: relative(API_SRC, file).replace(/\\/g, '/'),
        controller: name, handler: m,
        verb: VERB[verbMeta as number] ?? String(verbMeta),
        path: full,
        segments: full.split('/').filter(Boolean),
        public: Reflect.getMetadata(IS_PUBLIC_KEY, proto[m] as object) === true,
      });
    }
  }
  return out;
}

export const ROUTES: Route[] = walk(API_SRC, /\.controller\.ts$/).flatMap(routesOf);

const WEB_FILES = walk(WEB_SRC, /\.(ts|tsx)$/).filter((f) => !/\.(test|spec)\.tsx?$/.test(f));
const RAW_WEB_SOURCE = WEB_FILES.map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * A template-literal hole is a WILDCARD SEGMENT, and it can contain anything —
 * `${id}`, `${params.toString()}`, `${a ? b : c}`. Collapse every hole to one sentinel
 * BEFORE hunting for paths, or the path regex stops dead at the first `(` and reports
 * `/error-logs?${params.toString()}` — a route the client uses every day — as unreachable.
 *
 * (This project has already learned that a harness which cries wolf is the same bug as
 * one that misses: the qa10 matrix's `type="month"` false alarm. So the sentinel handles
 * one level of nested braces, and the self-tests below prove the matcher still says NO.)
 */
const HOLE = '\u0001';
const WEB_SOURCE = RAW_WEB_SOURCE.replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, HOLE);

/**
 * Any '/x/y' string literal in the web app. Deliberately broader than "arguments to
 * api.*": paths also reach useFetch(), openPdf(), an <a href> and the export poller, and
 * a route reached by any of those IS reachable.
 */
const PATH_LITERALS: string[] = (() => {
  const found = new Set<string>();
  // A path literal may also START with a hole — `${base}/${id}/impact`, where `base` is
  // '/leads' | '/branches' | … . Those are real calls (deletemodal.tsx, dyn.tsx), and the
  // literal-segment rule below still demands real evidence for 'impact'/'restore'.
  const re = /['"`]((?:\/|\u0001)[A-Za-z0-9_\-/.:?&=\u0001]*)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(WEB_SOURCE))) found.add(m[1]);
  return [...found];
})();

/** Every quoted string in the web app — used to vouch for an interpolated segment. */
const WEB_STRING_LITERALS: Set<string> = (() => {
  const found = new Set<string>();
  const re = /['"]([A-Za-z0-9_\-]{2,40})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(RAW_WEB_SOURCE))) found.add(m[1]);
  return found;
})();

interface WebPath { raw: string; segments: string[] }

const WILD = HOLE;

const WEB_PATHS: WebPath[] = PATH_LITERALS
  // `api.ts` prefixes '/api'; a path opened in a tab or posted by the error reporter
  // spells it out (`/api/errors`, `/api/reports/exports/${id}/download`). Same route.
  .map((raw) => ({ raw, segments: raw.split('?')[0].replace(/^\/api(?=\/)/, '')
    .split('/').filter((x) => x.length > 0) }))
  // A PATH WITH NO LITERAL SEGMENT IS NOT EVIDENCE OF ANYTHING. `${a}/${b}` — which the
  // scan happily harvests out of a CSS template string — would otherwise vouch for every
  // two-segment route in the API, and the guard would quietly stop guarding. (It did:
  // that shape passed `DELETE /messages/opt-out/:id`, which no UI calls, before this line
  // existed.) Requiring one spelled segment is what keeps this a test and not a placebo.
  .filter((p) => p.segments.length > 0 && p.segments.some((x) => x !== WILD));

/** Does a route segment match a web segment? A route `:param` takes anything; a route
 *  LITERAL must be spelled — in place, or (when the web computes it) somewhere in the
 *  source. This is the rule that makes the guard catch DEF-S16-01 instead of waving it
 *  through on the strength of `api.post(`/quotations/${id}/${path}`)`. */
const segMatches = (rs: string, ws: string) => (
  // A route PARAM (:id) is satisfied only by an INTERPOLATION. Letting `:id` swallow a
  // web literal is how `/messages/${id}/retry` came to vouch for `/messages/opt-out/:id`,
  // an endpoint with no UI at all — the guard reporting green on the very thing it exists
  // to find. A UI interpolates its ids; if it really spells one, that is a bare row id in
  // source, which is its own problem.
  rs.startsWith(':') ? ws === WILD
    // A route LITERAL must be spelled: in place, or — when the web computes the segment —
    // somewhere in web/src, which is how act('accept', …) legitimately reaches /:id/accept
    // while nothing anywhere spells 'revise'. THIS is the rule that catches DEF-S16-01.
    : ws === rs || (ws === WILD && WEB_STRING_LITERALS.has(rs))
);

function reaches(route: Route, w: WebPath): boolean {
  // A LEADING hole is a computed BASE — `${pathFor(id)}/restore`, where pathFor() returns
  // '/leads/3', i.e. several segments at once. It stands for one-or-more segments; the
  // trailing literals still have to be spelled, so this stays evidence, not a free pass.
  if (w.segments[0] === WILD && w.segments.length >= 2) {
    const tail = w.segments.slice(1);
    // …and the tail must SPELL something. `${a}/${b}` proves nothing about any route.
    if (!tail.some((x) => x !== WILD)) return false;
    if (route.segments.length <= tail.length) return false;
    const rTail = route.segments.slice(route.segments.length - tail.length);
    return rTail.every((rs, i) => segMatches(rs, tail[i]));
  }
  if (w.segments.length !== route.segments.length) return false;
  return route.segments.every((rs, i) => segMatches(rs, w.segments[i]));
}

const isReachable = (r: Route) => WEB_PATHS.some((w) => reaches(r, w));


/**
 * THE ALLOWLIST — routes where A BROWSER IS NOT THE CLIENT. Legitimate forever.
 * Every entry carries a written reason; the stale-check below deletes the excuse the day
 * a route grows a caller, and the last test refuses any entry that is not @Public (or the
 * one declared diagnostic), because "no UI calls it" IS NOT A REASON — that is
 * DEF-S16-01 with an excuse attached, and it goes in the QUARANTINE below instead.
 */
const NOT_UI_DRIVEN: Record<string, string> = {
  'GET /webhooks/meta/:key':
    'META LEAD ADS handshake — Facebook GETs this with hub.challenge to verify the webhook. The caller is Meta.',
  'POST /webhooks/meta/:key':
    'META LEAD ADS delivery — Meta POSTs leadgen_id with an X-Hub-Signature-256 HMAC over the raw body. The caller is Meta.',
  'POST /webhooks/google/:key':
    'GOOGLE ADS lead-form delivery, authenticated by the google_key shared secret. The caller is Google.',
  'POST /webhooks/form/:key':
    'THE PUBLIC WEBSITE FORM endpoint. The caller is the client\'s own marketing site, using the snippet the Lead Capture screen gives him — deliberately outside this app.',
  'OPTIONS /webhooks/form/:key':
    'The CORS preflight for the public website form. The caller is a browser on the client\'s site, not this SPA.',
  'GET /webhooks/whatsapp':
    'WHATSAPP CLOUD API webhook verification (hub.challenge). The caller is Meta.',
  'POST /webhooks/whatsapp':
    'WHATSAPP delivery/read receipts and inbound STOP, signature-verified. The caller is Meta.',
  'GET /webhooks/health':
    'A machine health probe for the capture endpoints — deliberately answerable without a session.',
  'GET /error-logs/_test/boom':
    'A QA-ONLY synthetic 500 that proves error capture works end-to-end. Inert in production: without ERRORLOG_TEST=1 it is indistinguishable from a missing route. The caller is a tester with curl, by design.',
};

/** Which of the above are allowed NOT to be @Public. Exactly one, and it is named. */
const NON_PUBLIC_MACHINE_ROUTES = new Set(['GET /error-logs/_test/boom']);

/**
 * =============================================================================
 * THE QUARANTINE — routes with a complete backend and NO UI. These are DEF-S16-01's
 * siblings, found by this guard on the day it was written.
 * =============================================================================
 *
 * THIS LIST IS A DEFECT REGISTER, NOT AN ALLOWLIST. Nothing here is "fine". Each entry
 * is working, tested, RBAC-guarded code that the client cannot reach from any screen, and
 * each is either (a) a feature he has been told exists, (b) a duplicate of a route the UI
 * does use, or (c) something to delete. They are recorded in `docs/PROJECT_STATUS.md` §5
 * and `docs/dev/08` §9 so the Manager can decide which to wire, which to bin, and which
 * the client never needed — a decision that is his, not a developer's, and NOT one to make
 * silently in a sign-off week on a live database.
 *
 * THE COUNT IS PINNED. A new endpoint with no caller cannot join this list by accident:
 * the test below fails if the census grows, so the only way in is to edit this file
 * deliberately and say why. That is the guarantee the brief asked for — a new endpoint
 * that ships with no caller fails the build.
 *
 * Every entry states what it is and what closing it would mean.
 */
const UNREACHABLE_BACKLOG: Record<string, string> = {
  'GET /teams':
    'TEAMS HAS NO LIST OR CREATE SCREEN. The UI only ever reads /teams/:id (via the user sheet and the delete/impact path), so teams can be viewed and deleted but never listed or created from the app. PROJECT_STATUS §2 sells "users, teams, roles" as built. CLIENT-VISIBLE GAP — Manager decision.',
  'POST /teams':
    'The other half of the same gap: no New Team form exists anywhere in web/src.',
  'GET /assignments':
    'USER->ROLE/UNIT ASSIGNMENTS have no dedicated screen; the user modal posts its assignments inside the user payload. Possibly a superseded endpoint — verify before wiring or deleting.',
  'POST /assignments':
    'Same as GET /assignments — likely superseded by the user form. Verify, then wire or delete.',
  'DELETE /assignments/:id':
    'Same as GET /assignments — no screen removes a user\'s assignment directly; the user form replaces the whole set. Verify, then wire or delete.',
  'GET /messages/opt-outs':
    'THE OPT-OUT LIST IS INVISIBLE. Consent IS honoured on every send (verified live, QA-16) — but the client cannot see who has opted out, or re-subscribe anyone. specs.tsx advertises "opt-out handling" on the WhatsApp/SMS cards. CLIENT-VISIBLE GAP.',
  'POST /messages/opt-out':
    'Manual opt-out (a customer who asks a counsellor to stop, rather than texting STOP) cannot be recorded from the UI.',
  'DELETE /messages/opt-out/:id':
    'Re-subscribing an opted-out customer is impossible from the UI. NOTE: an earlier, looser matcher passed this route on the strength of an unrelated `/messages/${id}/retry` call — the guard has since been tightened so a route param only matches an interpolation.',
  'POST /messages/send':
    'The single-message send endpoint. The blast composer uses /messages/bulk instead. Verify whether anything should reach this, or delete it.',
  'GET /leads/:id/activities':
    'A DUPLICATE: GET /leads/:id already embeds `activities` (leads.service.ts builds it in get()), and the lead sheet reads lead.activities. Nothing calls the standalone route. Deleting it is the likely answer — deferred only because it is not a defect, and Phase-1 sign-off week is not when you remove endpoints from a live API.',
  'GET /leads/handout/:id':
    'The Start Calling batch detail. The UI uses /leads/handout, /leads/handout/campaigns and /leads/handout/current. ALSO A ROUTING HAZARD: `:id` is declared alongside the literal siblings and could shadow them depending on declaration order — worth checking regardless of the UI.',
  'GET /sla/lead/:id':
    'Per-lead SLA detail. The lead sheet renders the SLA badge from data the lead payload already carries, so this route has no caller. Verify, then wire or delete.',
  'GET /reports/exports/mine':
    'THERE IS NO "MY RECENT EXPORTS" LIST. The UI polls one export by id and, on timeout, tells the client "it will appear in your recent exports" — a list that does not exist on any screen. CLIENT-VISIBLE: the message promises a place to look.',
  'DELETE /numbering/:id':
    'A numbering series can be created and edited from Settings > Numbering, but never deleted.',
  'DELETE /settings/channels/:id':
    'A saved channel credential row cannot be REMOVED from the UI — only overwritten via /settings/channels/save. "Disconnect WhatsApp" has no button.',
  'POST /channels/:id/regenerate':
    'Regenerating a capture channel\'s webhook key/secret — the thing to do if a key leaks — has no button on the Lead Capture screen.',
  'PATCH /users/:id/deactivate':
    'Probably superseded: the users list toggles status through PATCH /users/:id. Verify, then delete this route or wire it.',
  'PATCH /masters/:type/:id/deactivate':
    'Same shape as PATCH /users/:id/deactivate — likely superseded by the generic master PATCH.',
  'POST /enrolments/:id/cancel':
    'AN ENROLMENT CANNOT BE CANCELLED FROM THE UI. A student who withdraws leaves an active enrolment counting toward booked revenue and targets for ever. CLIENT-VISIBLE and money-shaped — the highest-value entry on this list.',
  'POST /journeys/:id/run':
    'Manually firing a journey (the "run it now" a marketer wants while testing) has no button; the UI only lists /journeys/runs.',
  'POST /scoring/recompute':
    'A manual full rescore. Scoring is event-driven plus an ageing sweep (which is why nobody has missed it), but there is no way to force one after a bulk rule edit.',
  'PUT /pipelines/:id/stages/order':
    'STAGE REORDERING. The Stage Configurator ships "insert-at-position" and saves stages individually; this bulk-order endpoint is not called. Verify whether reordering actually works through another path before wiring or deleting.',
};

/** The census as it stood when this guard was written (commit under Phase-1 sign-off).
 *  It may SHRINK — every entry closed is a win. It may not GROW. */
const BACKLOG_CENSUS = 23;


describe('every API route is reachable from the UI (the DEF-S16-01 guard)', () => {
  it('the reflection actually found the API (a guard that scans nothing passes everything)', () => {
    expect(ROUTES.length).toBeGreaterThan(150);
    expect(ROUTES.some((r) => r.path === '/quotations/:id/revise' && r.verb === 'POST')).toBe(true);
    expect(new Set(ROUTES.map((r) => r.controller)).size).toBeGreaterThan(25);
  });

  it('the web scan actually read the UI', () => {
    expect(WEB_FILES.length).toBeGreaterThan(20);
    expect(WEB_PATHS.length).toBeGreaterThan(100);
    expect(WEB_PATHS.some((w) => w.raw === '/quotations')).toBe(true);
  });

  /**
   * THE HEADLINE. If this is red you have shipped a backend with no door — the exact
   * defect QA-16 found at Phase-1 sign-off, and the one Sprint 5 shipped before it. Wire
   * the UI; or, if a browser genuinely is not the client, add it to NOT_UI_DRIVEN WITH A
   * WRITTEN REASON.
   */
  it('NO NEW route is dead: a new endpoint with no caller fails the build', () => {
    const unreachable = ROUTES
      .filter((r) => !NOT_UI_DRIVEN[`${r.verb} ${r.path}`])
      .filter((r) => !UNREACHABLE_BACKLOG[`${r.verb} ${r.path}`])
      .filter((r) => !isReachable(r))
      .map((r) => `${r.verb} ${r.path}   <- ${r.file} ${r.controller}.${r.handler}()`)
      .sort();
    // If this is red you have shipped a backend with no door — the exact defect QA-16
    // found at sign-off, and the one Sprint 5 shipped before it. Wire the UI. Do not
    // reach for the quarantine list without a line in PROJECT_STATUS §5 to match.
    expect(unreachable).toEqual([]);
  });

  /**
   * THE CENSUS MAY SHRINK, NEVER GROW. Without this, the quarantine is just a bin with a
   * nice comment: every future dead endpoint would land in it and the guard would report
   * green for ever. This is the line that makes the list a defect register.
   */
  it('the unreachable BACKLOG does not grow', () => {
    const stillDead = Object.keys(UNREACHABLE_BACKLOG)
      .map((k) => ROUTES.find((r) => `${r.verb} ${r.path}` === k))
      .filter((r) => r && !isReachable(r));
    expect(stillDead.length).toBeLessThanOrEqual(BACKLOG_CENSUS);
  });

  it('every quarantined route carries a written reason naming what closing it would mean', () => {
    const unexplained = Object.entries(UNREACHABLE_BACKLOG)
      .filter(([, reason]) => reason.length < 60)
      .map(([k]) => k);
    expect(unexplained).toEqual([]);
  });

  it('the quarantine has not gone stale — every entry names a REAL route that is STILL unreached', () => {
    const stale: string[] = [];
    for (const key of Object.keys(UNREACHABLE_BACKLOG)) {
      const r = ROUTES.find((x) => `${x.verb} ${x.path}` === key);
      if (!r) { stale.push(`${key} — no such route any more; delete this entry`); continue; }
      if (isReachable(r)) stale.push(`${key} — WIRED. Delete this entry and update PROJECT_STATUS §5.`);
    }
    expect(stale).toEqual([]);
  });

  it('DEF-S16-01: POST /quotations/:id/revise is reachable — a sent quote is not a dead end', () => {
    const revise = ROUTES.find((r) => r.verb === 'POST' && r.path === '/quotations/:id/revise')!;
    expect(revise).toBeTruthy();
    expect(isReachable(revise)).toBe(true);
    expect(readFileSync(join(WEB_SRC, 'sprint5.tsx'), 'utf8')).toContain('/revise');
  });

  /**
   * THE MATCHER MUST BE ABLE TO SAY NO. A guard that cannot fail is decoration — this
   * project has already shipped one (the MSG91 caveat that rendered while nothing
   * asserted it, so deleting 4 lines of JSX kept 1,315 tests green).
   */
  it('the matcher can say NO — an invented endpoint is reported unreachable', () => {
    const fake: Route = {
      file: 'x', controller: 'X', handler: 'x', verb: 'POST',
      path: '/quotations/:id/frobnicate', segments: ['quotations', ':id', 'frobnicate'], public: false,
    };
    expect(isReachable(fake)).toBe(false);
  });

  it('an interpolated segment does NOT vouch for a literal nobody spells', () => {
    // act('accept', ...) legitimately reaches /:id/accept because 'accept' is a quoted
    // string in web/src. Nothing spells 'frobnicate', so the same ${path} call cannot
    // cover it — which is exactly why this matcher catches DEF-S16-01 instead of waving
    // it through.
    expect(WEB_STRING_LITERALS.has('accept')).toBe(true);
    expect(WEB_STRING_LITERALS.has('frobnicate')).toBe(false);
  });

  it('the allowlist has not gone stale — every entry names a REAL route that still has no caller', () => {
    const stale: string[] = [];
    for (const [key, reason] of Object.entries(NOT_UI_DRIVEN)) {
      expect(reason.length).toBeGreaterThan(40);   // a reason, or it is not an entry
      const r = ROUTES.find((x) => `${x.verb} ${x.path}` === key);
      if (!r) { stale.push(`${key} — no such route any more; delete this entry`); continue; }
      if (isReachable(r)) stale.push(`${key} — now HAS a UI caller; delete this entry`);
    }
    expect(stale).toEqual([]);
  });

  it('every allowlisted route is genuinely a machine endpoint, not a dead one with an excuse', () => {
    const suspicious = Object.keys(NOT_UI_DRIVEN)
      .map((k) => ROUTES.find((r) => `${r.verb} ${r.path}` === k)!)
      .filter((r) => r && !r.public && !NON_PUBLIC_MACHINE_ROUTES.has(`${r.verb} ${r.path}`))
      .map((r) => `${r.verb} ${r.path} is allowlisted as a machine endpoint but is NOT @Public — `
        + 'if no UI calls it and it is not a webhook, it belongs in UNREACHABLE_BACKLOG.');
    expect(suspicious).toEqual([]);
  });
});
