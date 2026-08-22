# dev/126 — ＋Master link styling · leads-master scroll · Today's Follow-ups buttons · top-bar scope lag

Live commit: **8e30ef3** (prev 956528d). Served bundle changed `index-BA6DgcjI.js` → `index-1f0GE0He.js`.
Four UI polish fixes the client flagged. All front-end (`web/`). Browser-verified on the exact URLs.

## 1. ＋Master links not styled as clickable in some places
Root cause: `.mlink` had **only** a scoped rule (`.fld label .mlink,.kv .f label .mlink`) — so any
＋Master link NOT nested inside a `<label>` rendered as plain grey text with the default cursor. That
hit `LevelsField`'s `<MasterQuickAdd type="level">` (inside a `<div>`, dev/114) and every
`MasterQuickAdd` placed as a label *sibling* (dyn/admissions/assessments/learning/placements).
Fix (`web/src/styles.css`): add a standalone base rule
`.mlink{color:var(--primary);cursor:pointer;text-decoration:none}` + `.mlink:hover{text-decoration:underline}`.
Every ＋Master link is now blue + pointer + hover-underline regardless of nesting; the label-scoped rule
still applies its smaller sizing where nested. Verified on Add Course: all 6 links (Branch, Vertical,
**Levels**, Training Mode, Course Type, Status) computed `color rgb(138,123,255)` + `cursor pointer`.

## 2. Scroll broken on /m/leads/pipelinemaster and /m/leads/branch
Root cause: same class as the Roles/Leads scroll fix. The Leads-area master screens (`branches`,
`verticals`, `pipelines`, `campaigns`, `sources`) were in `LIST_SCROLL` → `.main--list` full-height
flex (overflow:hidden). Branch renders a tall "Hierarchy" `<Blocks>` tree ABOVE the table, which
squeezed the `.tbl-fill` body to a ~26px sliver (measured live) — content cut off, unreachable.
Fix (`web/src/Shell.tsx`): drop those 5 leads-master screens from `LIST_SCROLL` so `main` scrolls
normally and each `.tbl-fill` card falls back to `.tbl-scroll{max-height:62vh;overflow:auto}` with its
sticky header — the known-good Students/Roles container. `users/audit/errorLogs/walkIns/courses/followups`
keep table-only scroll. Verified: branch now `.main` (scrollHeight>clientHeight), tree + full table both
reachable; pipelinemaster renders fully.

## 3. Today's Follow-ups filter still a dropdown
dev/118 added `variant="buttons"` to `FollowupFilter` but only wired it into the Follow-ups module, not
this screen. Fix (`web/src/dyn.tsx`, `TodayFollowups`): pass `variant="buttons"`. Verified on
`/m/dash/todayfollowups`: single button row (All Follow-up · Missed · Today · Tomorrow · Next 7 · Next 30
· Custom), no `<select>`; clicking Missed filters the list.

## 4. Top-bar Branch/Vertical scope filter lags
Diagnosis (live network capture): a SINGLE branch toggle fired ~14 requests — the whole dashboard set
(`/dashboard`, `/follow-ups` ×2, `/leads`, `/ai/summary`, `/assessment-reports/*`) twice — because every
scope-dependent `useFetch` keys off the context `params`/`key`, which changed on EVERY checkbox tick; a
multi-select burst fired that storm per tick.
Fix (`web/src/scope.tsx`): DEBOUNCE the committed scope. The checkboxes + Branch›Vertical cascade still
read the live `raw` selection (instant), but the `params`/`key`/`active` that drive fetching settle
~250ms after the user stops toggling. Also memoized the selector's derived child lists so option arrays
keep stable identity. Verified: two rapid toggles → checkboxes update instantly (2 selected) and exactly
ONE batched refetch wave (single `/dashboard`) instead of a per-tick storm; no console errors.
`scope.test.tsx` updated to flush the debounce (fake timers).

## Tests
web tsc ✓ · vite build ✓ · vitest listaudit (56) ✓ · scope (11) ✓ · dashboard/followupfilter ✓.
Pre-existing failures unchanged (verified identical on the pristine tree): qa10matrix phantom-field/flaky
cluster + sprint3 calendar. No new failures introduced.

## Deploy
Pristine `git clone --depth 1` → `railway up . --path-as-root --service api ... --environment production`.
Deployment `62cae234-ac8d-4e95-ac1e-921d93ff24f8`, status Online. Served bundle confirmed changed to
`index-1f0GE0He.js`.
