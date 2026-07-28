-- 041 — Lead transfer + bulk actions (client request, Jul 2026)
--
-- Two related features share this migration:
--   A) LEAD TRANSFER — move a lead to another Branch/Vertical/(Pipeline)/Campaign.
--      No schema change is needed for the transfer itself: a lead already carries the
--      full denormalised path (branch_id/vertical_id/pipeline_id/campaign_id/source_id),
--      and the transfer re-denormalises all of them in one transaction exactly like the
--      pipeline re-parent (hierarchy.updatePipeline). It writes a lead_activity of type
--      'transfer' (already in the enum since 023) + an audit_log 'transfer' row.
--   B) BULK PAUSE/RESUME — a per-lead paused flag. A paused lead is EXCLUDED from the
--      hand-out pool, the SLA-breach sweep and the overdue-escalation sweep until resumed.
--      It is NOT deactivated (is_active stays true) and NOT deleted — it simply parks.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DROP/ADD the enumerated CHECK.

-- B) the paused flag ---------------------------------------------------------
ALTER TABLE lead ADD COLUMN IF NOT EXISTS paused    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS paused_by BIGINT NULL REFERENCES "user"(id) ON DELETE SET NULL;

-- partial index: the sweeps read WHERE paused IS NOT TRUE, and the Leads list can offer a
-- "paused only" filter — both benefit from an index over the rare paused rows.
CREATE INDEX IF NOT EXISTS ix_lead_paused ON lead (paused) WHERE paused;

-- A) lead_activity gains the 'pause' / 'resume' verbs so the timeline records the parking.
--    'transfer' is already in the enum (023/038). Same enumerated-CHECK story as those.
ALTER TABLE lead_activity DROP CONSTRAINT IF EXISTS lead_activity_type_check;
ALTER TABLE lead_activity ADD  CONSTRAINT lead_activity_type_check
  CHECK (type IN ('create','stage_change','status_change','assign','follow_up','note',
                  'message','call_log','field_change','merge','transfer','disposition',
                  'cross_sell','pause','resume'));
