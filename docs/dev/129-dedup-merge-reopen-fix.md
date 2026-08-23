# 129 — Duplicate-handling fixes: re-dedup on re-parent + merge & reopen (client, Aug 2026)

Supersedes the live `86dcf4a`. Three duplicate-handling bugs the client reported, fixed in the
shared ingestion pipeline + the lead re-parent path. No migration.

## Bug 1 — editing a lead's Campaign/Branch/Vertical did not re-apply the duplicate rule
A re-parent (Transfer, or the Edit-lead form when a new Campaign is picked — `web/src/leadsheet.tsx`
routes that through `POST /leads/:id/transfer`) moved the lead onto the new path but never re-ran the
NEW campaign's duplicate rule. A lead unique in its old campaign could silently stay un-flagged in a
scope where it is a duplicate (and vice-versa).

Fix (`api/src/leads/leads.service.ts`): `transferOneLead()` now calls a new
`reEvaluateDuplicateOnReparent()` AFTER the transfer commits, only when the scope actually changed
(campaign/branch/vertical) — no loop. It:
- finds a DIFFERENT in-scope lead with the same E.164 phone/WhatsApp (scope = the new campaign's
  `check_scope`: campaign / vertical / branch / global), preferring a CLOSED match;
- (re)links the moved lead — `is_duplicate` + `duplicate_of_id` — so the Duplicates panel reflects the
  new scope, or CLEARS a stale flag when nothing matches; writes a timeline note either way;
- applies the campaign action: `merge` / `merge_and_reopen` fold the moved lead's data into the in-scope
  match (non-destructive; the edited lead is never tombstoned), and for `merge_and_reopen` a CLOSED match
  is re-opened (won/lost → the pipeline's default OPEN stage) and handed to the next round-robin agent of
  ITS OWN campaign. `flag`/`create`/`ignore` just link (an already-existing lead can't be dropped).
`resolveTransferTarget()` now also carries `duplicacy_config`. `LeadMergeService` is injected into
`LeadsService` (optional/trailing so the hand-built unit doubles are unchanged).

## Bug 2 — "merge & reopen" a closed lead was not working off the interactive forms
Root cause: the manual **Add Lead** / **walk-in** / **referral** paths pass `duplicate_policy:
'always_create'`, which HARD-CODED the action to `create` — so the campaign's `merge` / `merge_and_reopen`
rule NEVER ran off those forms. Creating a duplicate by hand under a "merge & reopen" campaign just made a
flagged second lead; the closed lead never re-opened.

Fix (`api/src/ingestion/lead-ingestion.service.ts` `ingestInner`): a human-entered lead now HONOURS the
campaign's configured action too. The one DEF-S2-01 guarantee preserved is that a human lead is never
SILENTLY swallowed — an `ignore` rule falls back to `create` (land + flag), and the fresh idempotency key
still prevents a replay-skip of a deliberate re-add. The reopen round-robin re-hand-off also fires for a
human-entered duplicate (the `policy === 'campaign'` gate on that branch was dropped).

## Bug 3 — audit of all actions × scopes
- Actions: `ignore` (drop the incoming; a human lead falls back to create+flag), `create` (second linked
  lead), `merge` (fold into existing, existing owner kept — §4), `merge_and_reopen` (fold + reopen a
  CLOSED lead + next round-robin agent), `flag` (land the duplicate flagged is_duplicate + linked). All
  verified for automated channels AND the interactive forms.
- Scopes: `this_campaign` / `this_vertical` / `this_branch` / `global` (legacy `this_pipeline` normalised
  to `this_campaign`) — unchanged from dev/20, re-confirmed on both ingest and re-parent re-dedup.

## Tests
- `api/src/ingestion/ingestion.spec.ts`: manual `always_create` now honours merge & reopen (reopens the
  closed lead + round-robin) and merge (folds, no second lead); the old "manual always creates under a
  merge campaign" test rewritten to the new (correct) behaviour; `ignore -> create` guarantee retained.
- `api/src/leads/transfer-bulk.spec.ts`: re-parent re-dedup — flag scope (re)links + logs; no in-scope
  match clears a stale flag; merge & reopen scope folds into a CLOSED match + reopens + round-robin.
- api `tsc` clean; ingestion/merge/returning-student/import/lead-merge-rbac/transfer-bulk/round-robin/
  reassign-all/lead-autostatus green. Pre-existing failures unchanged (api `capture`, `followup-reportto`).

## Deploy
Pushed `main`; `railway up` from a pristine `--depth 1` clone. No migration.
