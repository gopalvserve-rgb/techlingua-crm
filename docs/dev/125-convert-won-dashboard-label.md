# dev/125 — Convert-to-student sets Lead Status = Won · Dashboard leads-card label reflects the date filter

Two client-reported bugs, both small, shipped together.

## Bug 1 — Convert-to-student must set the lead's Status = Won (not leave it "New")

Symptom. After converting a lead to a student, the lead's pipeline stage moved to the WON stage,
but the lead's Status field stayed New. A converted lead must read Status: Won in the leads list
and the lead sheet.

Root cause. Two "win the lead" code paths existed:
- EnrolmentService.winLead() (enrolment approval) already set BOTH stage_id and
  status_id = m_status(code='WON') (dev/95 item 2).
- StudentService.winLead() (the convert-to-student path, POST /students/convert, also used by bulk
  convert) moved the lead to the WON stage with direct SQL but never set status_id, bypassing the
  auto-status rule that LeadsService.update() applies. So the status field kept its old value (New).

Fix. StudentService.winLead() now issues the SAME status-set the enrolment path does, in the SAME
transaction as the stage move, keyed on the status master code WON (org-scoped, not a configurable
name), idempotent, and running even when the lead is already on the WON stage:

    UPDATE lead SET status_id = ms.id, updated_at = now()
      FROM m_status ms
     WHERE lead.id = $1 AND ms.org_id = lead.org_id AND ms.code = 'WON'
       AND lead.status_id IS DISTINCT FROM ms.id

Tests: api/src/students/students.spec.ts asserts convert issues the UPDATE lead SET status_id ...
code = 'WON' statement, and that it still runs when the lead is already on the WON stage.

## Bug 2 — Dashboard leads KPI card label must reflect the selected date filter

Symptom. The dashboard's leads count card was always titled "Today's leads" regardless of the
preset chosen in the shared date-range control (All time / Today / Yesterday / This Week / This
Month / Custom).

Fix (front-end only, web/src/dyn.tsx DashOverview). The card resolves the active preset from the
DateRange value via matchPreset() and maps it to a title:

    all       -> All-time Leads
    today     -> Today's Leads
    yesterday -> Yesterday's Leads
    week      -> This Week's Leads
    month     -> This Month's Leads
    custom    -> Leads (custom range)

The count uses kpis.total, which the /dashboard endpoint already narrows by the applied
created-date range (all-time when no preset is active, the range count once one is picked), and the
drill-through opens the Leads list on the SAME created-date window ({} for All time). Test:
web/src/dashboard.test.tsx — the MANAGER card reads "All-time Leads" by default and flips to
"Today's Leads" (with a today created-range drill-through) when the Today preset is picked.

## Deploy
Front-end + API change, no migration. Deployed via a pristine git clone + railway up; served bundle
hash confirmed changed.
