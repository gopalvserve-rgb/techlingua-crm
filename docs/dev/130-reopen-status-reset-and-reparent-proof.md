# 130 — Re-open status reset (DEFECT 1) + re-parent re-dedup proof (client, Aug 2026)

Follows dev/129 (`a13f3e4`). API-only; no migration; no web change. Two items from the live
merge-&-reopen browser test.

## DEFECT 1 (fixed) — a re-opened lead kept status "Lost"
`merge_and_reopen` correctly moved a CLOSED lead's pipeline **stage** back to the default OPEN
stage and round-robin-reassigned it, but never touched `status_id` — so the lead showed
Stage = New Enquiry with Status = Lost (contradictory; the client would reject it).

Root cause: the re-open branch in `api/src/ingestion/merge.service.ts` `applyMerge()` set
`stage_id` only. `status_id` was left on its terminal value (Lost, id 5 live / 'LOST').

Fix: on re-open, the status is reset in the SAME `UPDATE lead` via the SHARED stage->status
mapping now extracted to `api/src/leads/auto-status.util.ts` (`autoStatusFromStage`) — the exact
rule the edit form uses (stage TYPE authoritative won->Won/lost->Lost, NAME fallback
Enrolled->Won/Closed->Lost). For an ordinary open stage ("New Enquiry") the mapping returns
null, so we fall back to the org's `NEW` status. Result: a re-opened "New Enquiry" lead now gets
Status = **New**, never Lost. A `status_change` timeline row is written so the read path (list +
detail join `m_status`) and audit trail agree. Both re-open paths share the merge core, so the
re-parent merge_and_reopen path (dev/129) is fixed by the same change.

`autoStatusFromStage` was specced in dev/117 (`lead-name-source-autostatus.spec.ts`) but never
actually implemented — that suite was silently red (import error). It is now a real leaf util,
re-exported from `leads.service.ts`, and `LeadsService.update()` uses it (so an open stage NAMED
"Enrolled"/"Closed" also forces Won/Lost, per the client rule). While making that suite compile,
the specced-but-unwired **editable Lead Source** (`source_id`) on `update()` was completed too
(scope-checked + logged), so the whole `lead-name-source-autostatus` suite is now green.

## ITEM 2 (proven; already correct) — edit-reparent re-dedup for campaign/branch/vertical
docx #5. dev/129's `reEvaluateDuplicateOnReparent` (leads.service) already re-runs the NEW
campaign's duplicate rule after a re-parent, scoped by the campaign's `check_scope`
(this_campaign / this_vertical / this_branch / global), and only when the scope actually changed
(no loop). Audit confirmed it was already correct for ALL THREE scopes — no code change needed.
Proven at the integration level in `api/src/leads/transfer-bulk.spec.ts`:
- existing: campaign-scope flag (re)link + clear-stale + merge_and_reopen round-robin;
- added (dev/130): BRANCH-scope and VERTICAL-scope re-parent tests asserting the in-scope
  duplicate lookup is scoped by the TARGET branch_id / vertical_id, the moved lead is (re)linked
  `is_duplicate` to the in-scope match, and the timeline note names the scope.

## Tests
- `api/src/ingestion/merge.spec.ts`: re-open now asserts `status_id` reset to New (id 31) + a
  `status_change` activity.
- `api/src/ingestion/ingestion.spec.ts`: the merge_and_reopen test asserts the re-opened
  Closed+Lost lead ends with an OPEN stage AND a non-Lost (New) status AND the next round-robin
  owner — DEFECT 1 nailed at the pipeline level.
- `api/src/leads/transfer-bulk.spec.ts`: + BRANCH/VERTICAL re-parent re-dedup.
- `api/src/leads/lead-name-source-autostatus.spec.ts`: now GREEN (helper implemented, source_id wired).
- `api/src/ingestion/fake-db.testkit.ts`: answers the parameterised `m_status code = $2` lookup.
- api `tsc` + build clean; jest green except the two known pre-existing failures (`capture`,
  `followup-reportto` — date-relative).

## Cleanup
Hard-purged this session's ZZTEST residue by PK: leads 875 (ZZTEST Dedup One) + 876 (ZZTEST
Dedup Two), phone +919012340199, plus their child rows (lead_activity 10, lead_merge 2,
lead_ingest_record 4, lead_sla 2, lead_stage_tat 3, message_log 1, audit_log 11). "Dedup
Three"/"Reparent" left no separate rows (folded in by merge&reopen). Zero residue confirmed for
that phone. Unrelated ZZTEST leads (476/873/874, other phones) left untouched. BCL WEB campaign
duplicate action left as "Ignore Duplicate" (client-reverted).

## Deploy
Pushed `main`; `railway up` from a pristine `--depth 1` clone. API-only — served front-end bundle
hash unchanged (no web change).
