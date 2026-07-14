-- ---------------------------------------------------------------------------
-- 027 — DEF-S34-01 / DEF-S34-02 / DEF-S34-03 (QA-12, Sprint 3+4 acceptance)
--
-- 1) WALK-IN & REFERRAL: give every field the form RENDERS a column to live in.
--    This is the THIRD instance of the phantom-field class the client caught himself
--    (Edit Branch -> DEF-2; campaign dates -> DEF-S2-02; Add Lead WhatsApp -> DEF-S2-03).
--    `web/src/qa10matrix.test.tsx` is rewritten in the same commit to be GENERIC and
--    EXHAUSTIVE, so a fourth instance fails the build instead of reaching him.
--
-- 2) WALK-IN & REFERRAL now carry campaign_id / source_id themselves. They used to
--    borrow the path from the lead they created — which breaks the moment a walk-in
--    has NO lead yet (see `convert_to_lead` below), and made the Edit form unable to
--    show the path the visit was captured under.
--
-- 3) DEF-S34-01 — backfill `lead_sla`. Migration 025 §9 backfilled `lead_stage_tat`
--    and ONLY that, so every lead that existed before Sprint 3 (including the client's
--    real lead 31) has no SLA clock and can never breach, never be measured and never
--    appear in the manager breach view. Fixed here, idempotently.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a NOT EXISTS guard on every backfill.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1) WALK-IN — the three phantom fields, plus the two contact fields that were sent
--    to the LEAD but never stored on the walk-in (so Edit could not prefill them).
-- ---------------------------------------------------------------------------
ALTER TABLE walk_in ADD COLUMN IF NOT EXISTS alt_phone      VARCHAR(20);
ALTER TABLE walk_in ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(20);
ALTER TABLE walk_in ADD COLUMN IF NOT EXISTS course_fee     NUMERIC(12,2);

-- "How did you hear about us?" maps to the LEAD SOURCE MASTER (m_source) — the same
-- master `source.master_source_id` already points at. It is NOT the campaign-scoped
-- `source` row (that is the "Lead Source" field); it is how the visitor found us.
ALTER TABLE walk_in ADD COLUMN IF NOT EXISTS heard_about_source_id BIGINT REFERENCES m_source(id);

-- "Convert to Lead" is now REAL. Default TRUE: the walk-in screen's whole premise is
-- assign-on-add, so the checkbox ships CHECKED and existing rows (which all created a
-- lead) are correctly described by TRUE. Unticking it logs the visit WITHOUT creating a
-- lead (a fee query from an existing student is a visit, not a prospect); ticking it
-- later on the Edit form converts through the ONE LeadIngestionService, exactly like
-- every other capture channel.
ALTER TABLE walk_in ADD COLUMN IF NOT EXISTS convert_to_lead BOOLEAN NOT NULL DEFAULT TRUE;

-- the walk-in's own copy of the path it was captured under (see header note 2)
ALTER TABLE walk_in ADD COLUMN IF NOT EXISTS campaign_id BIGINT REFERENCES campaign(id);
ALTER TABLE walk_in ADD COLUMN IF NOT EXISTS source_id   BIGINT REFERENCES source(id);

-- ---------------------------------------------------------------------------
-- 2) REFERRAL — same story: the form sends the referred person's WhatsApp + Email to
--    the lead, but the referral row had nowhere to keep them, so Edit could neither
--    prefill nor persist them.
-- ---------------------------------------------------------------------------
ALTER TABLE referral ADD COLUMN IF NOT EXISTS referred_whatsapp VARCHAR(20);
ALTER TABLE referral ADD COLUMN IF NOT EXISTS referred_email    VARCHAR(255);
ALTER TABLE referral ADD COLUMN IF NOT EXISTS campaign_id BIGINT REFERENCES campaign(id);
ALTER TABLE referral ADD COLUMN IF NOT EXISTS source_id   BIGINT REFERENCES source(id);

-- ---------------------------------------------------------------------------
-- 3) BACKFILL the new path columns from the lead each row already created.
--    (Rows created before this migration always have a lead — conversion was
--    unconditional — so nothing is lost.)
-- ---------------------------------------------------------------------------
UPDATE walk_in w
   SET campaign_id = l.campaign_id, source_id = l.source_id
  FROM lead l
 WHERE l.id = w.lead_id AND w.campaign_id IS NULL;

UPDATE referral r
   SET campaign_id = l.campaign_id, source_id = l.source_id
  FROM lead l
 WHERE l.id = r.lead_id AND r.campaign_id IS NULL;

-- every pre-existing walk-in DID create a lead, so it is a converted walk-in
UPDATE walk_in SET convert_to_lead = TRUE WHERE lead_id IS NOT NULL AND convert_to_lead IS NOT TRUE;

CREATE INDEX IF NOT EXISTS idx_walkin_campaign ON walk_in(campaign_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_referral_campaign ON referral(campaign_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4) DEF-S34-01 — SLA BACKFILL (idempotent).
--
-- Migration 025 §9 deliberately backfilled only TAT, on the reasoning that "a policy
-- cannot be breached retroactively by a lead nobody was told to respond to". In
-- practice that leaves every historical lead permanently invisible to SLA — it can
-- never be measured, never breach and never reach the manager breach view — and it
-- would silently swallow every lead the client imports from his current system by CSV.
-- That is the wrong trade. We backfill, and we make the retroactive part honest:
--
--   * the clock starts at the lead's `created_at` and is due `threshold_minutes` later,
--     exactly as `SlaService.onLeadCreated` would have started it;
--   * if the lead was ALREADY touched (its first activity after creation), the clock is
--     recorded as SATISFIED at that moment, with the real elapsed time — so the
--     response-time averages on the SLA screen are true history, not zeros;
--   * if it was never touched and its due time is already past, it is recorded as
--     BREACHED AT THE MOMENT IT WAS DUE and ALREADY NOTIFIED. `notified_at` is the
--     column the worker claims on (`WHERE satisfied_at IS NULL AND notified_at IS NULL`),
--     so a historical breach SHOWS in the manager view and on the badge, but does NOT
--     fire a retroactive alert storm at the client on the next tick.
--     (Importing 5,000 historical leads must not send 5,000 "SLA breached" alerts.)
--
-- Idempotent twice over: the NOT EXISTS guard, and `uq_lead_sla_clock`.
-- The same statement lives in SlaService.backfillFirstResponseClocks(), which the
-- worker runs once at boot — so a policy created LATER also gets its clocks.
-- ---------------------------------------------------------------------------
INSERT INTO lead_sla (lead_id, policy_id, metric, stage_id, started_at, due_at,
                      satisfied_at, elapsed_seconds, breached_at, notified_at)
SELECT l.id,
       p.id,
       'first_response',
       NULL,
       l.created_at,
       l.created_at + (p.threshold_minutes || ' minutes')::interval,
       t.touched_at,
       CASE WHEN t.touched_at IS NOT NULL
            THEN GREATEST(0, EXTRACT(EPOCH FROM (t.touched_at - l.created_at))::int)
       END,
       CASE WHEN t.touched_at IS NULL
             AND l.created_at + (p.threshold_minutes || ' minutes')::interval <= now()
            THEN l.created_at + (p.threshold_minutes || ' minutes')::interval
       END,
       CASE WHEN t.touched_at IS NULL
             AND l.created_at + (p.threshold_minutes || ' minutes')::interval <= now()
            THEN now()
       END
  FROM lead l
  -- the SAME "most specific policy wins" rule SlaService.policyFor() applies:
  -- a pipeline-scoped policy beats a global one. (first_response is never stage-scoped.)
  JOIN LATERAL (
       SELECT sp.id, sp.threshold_minutes
         FROM sla_policy sp
        WHERE sp.is_active AND sp.deleted_at IS NULL
          AND sp.metric = 'first_response'
          AND (sp.pipeline_id IS NULL OR sp.pipeline_id = l.pipeline_id)
          AND sp.stage_id IS NULL
        ORDER BY (sp.pipeline_id IS NOT NULL) DESC, sp.id
        LIMIT 1
  ) p ON TRUE
  -- "first human touch" = the first activity recorded after the lead was created.
  LEFT JOIN LATERAL (
       SELECT MIN(a.occurred_at) AS touched_at
         FROM lead_activity a
        WHERE a.lead_id = l.id
          AND a.type <> 'create'
          AND a.occurred_at > l.created_at
  ) t ON TRUE
 WHERE l.deleted_at IS NULL
   AND l.is_active
   AND NOT EXISTS (
       SELECT 1 FROM lead_sla s WHERE s.lead_id = l.id AND s.metric = 'first_response'
   )
ON CONFLICT DO NOTHING;
