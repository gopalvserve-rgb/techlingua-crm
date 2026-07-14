-- 024 — QA-10 (Sprint 2 acceptance): the DEF-2 class, again.
-- Fields the Add/Edit forms have always RENDERED but the schema never STORED.
-- Rule (docs/qa/09): never leave a live input the backend does not persist.
-- Idempotent: safe to re-run on boot.

-- ---------------------------------------------------------------------------
-- DEF-S2-02 — Campaign: Campaign Type, Marketing Channel, Start Date, End Date.
-- All four render on the campaign modal (Start Date even carries a required *),
-- none had a column, so every typed value was discarded on save.
-- ---------------------------------------------------------------------------
ALTER TABLE campaign ADD COLUMN IF NOT EXISTS campaign_type     VARCHAR(32);
ALTER TABLE campaign ADD COLUMN IF NOT EXISTS marketing_channel VARCHAR(32);
ALTER TABLE campaign ADD COLUMN IF NOT EXISTS start_date        DATE;
ALTER TABLE campaign ADD COLUMN IF NOT EXISTS end_date          DATE;

-- a campaign window must not run backwards (NULLs allowed — both optional in the DB)
DO $$ BEGIN
  ALTER TABLE campaign ADD CONSTRAINT campaign_dates_chk
    CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- DEF-S2-03 — Lead: WhatsApp Number. Rendered on Add Lead (tel), never stored.
-- Its own column (not a custom field): it is a first-class contact channel —
-- the lead sheet's WhatsApp action uses it when present.
-- ---------------------------------------------------------------------------
ALTER TABLE lead ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(24);

-- ---------------------------------------------------------------------------
-- DEF-S2-07 — Start Calling: re-actioning a lead in a hand-out batch created a
-- SECOND open follow-up. Remember the follow-up the batch created for this lead
-- so a re-action RESCHEDULES it instead of stacking another one.
-- ---------------------------------------------------------------------------
ALTER TABLE lead_handout_item ADD COLUMN IF NOT EXISTS follow_up_id BIGINT;

DO $$ BEGIN
  ALTER TABLE lead_handout_item ADD CONSTRAINT lead_handout_item_follow_up_fk
    FOREIGN KEY (follow_up_id) REFERENCES follow_up(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
