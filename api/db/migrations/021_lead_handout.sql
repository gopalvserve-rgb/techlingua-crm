-- 021 — Sprint 2 / WS4: ON-DEMAND "START CALLING" HAND-OUT
--
-- PROJECT_DOCUMENTATION §4.1: "On Demand — leads stay unassigned until a user
-- self-assigns or clicks 'Start Calling'; the system then hands out 10 leads at a
-- time." The 10 is `campaign.distribution_config.batch_size` (default 10, set per
-- campaign — already validated by campaign-config.validator since Sprint 1).
--
-- The pool itself needs no new column: an on_demand lead simply has
-- `lead.owner_id IS NULL` (the distribution engine leaves it unassigned). What we
-- record here is the HAND-OUT — which agent claimed which leads, when, and how far
-- they have worked through the batch. That gives:
--   · the agent a working queue with progress ("3 of 10"),
--   · managers a pool/hand-out audit ("who pulled what and when"),
--   · the (optional, default-OFF) anti-hoarding guardrail something to test.
--
-- RACE SAFETY lives in the claim query, not in the schema: leads are claimed with
-- `FOR UPDATE ... SKIP LOCKED`, exactly like the import queue (018), so two agents
-- clicking Start Calling at the same instant get disjoint batches. UNIQUE(lead_id)
-- on lead_handout_item is the belt to that braces: even a hand-written concurrent
-- claim can never put one lead into two batches.

-- 1) lead_handout — one batch handed to one agent from one campaign's pool
CREATE TABLE IF NOT EXISTS lead_handout (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  branch_id      BIGINT NOT NULL REFERENCES branch(id),
  vertical_id    BIGINT NOT NULL REFERENCES vertical(id),
  pipeline_id    BIGINT NOT NULL REFERENCES pipeline(id),
  campaign_id    BIGINT NOT NULL REFERENCES campaign(id),
  user_id        BIGINT NOT NULL REFERENCES "user"(id),   -- the agent who pulled

  requested_size INT NOT NULL,          -- what was asked for (campaign batch_size)
  size           INT NOT NULL,          -- what the pool could actually give
  actioned_count INT NOT NULL DEFAULT 0,

  -- open      = the agent's live working queue
  -- completed = every lead in the batch was actioned (a disposition was logged)
  -- closed    = superseded by a newer pull (guardrail OFF); the leads STAY assigned
  status         VARCHAR(12) NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'completed', 'closed')),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_lead_handout_user     ON lead_handout(user_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_lead_handout_campaign ON lead_handout(campaign_id, created_at DESC);

-- 2) lead_handout_item — the leads in the batch, in the order they were handed out
CREATE TABLE IF NOT EXISTS lead_handout_item (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handout_id     BIGINT NOT NULL REFERENCES lead_handout(id) ON DELETE CASCADE,
  lead_id        BIGINT NOT NULL REFERENCES lead(id),
  position       INT NOT NULL,                    -- 1..size — the "3 of 10" counter
  actioned_at    TIMESTAMPTZ,                     -- set when the agent logs a disposition
  disposition_id BIGINT REFERENCES m_disposition(id),
  UNIQUE (lead_id)                                -- a lead can only ever be in ONE batch
);
CREATE INDEX IF NOT EXISTS idx_lead_handout_item_batch ON lead_handout_item(handout_id, position);

-- 3) the pool query's index: unassigned, live leads of a campaign, in hand-out order
--    (priority band, then oldest first). Partial — the pool is a small slice of lead.
CREATE INDEX IF NOT EXISTS idx_lead_pool_unassigned
  ON lead(campaign_id, priority, created_at, id)
  WHERE owner_id IS NULL AND deleted_at IS NULL AND is_active;

-- 4) permission: lead.pull — "Start Calling: pull my next batch from the pool".
--    Deliberately NOT lead.assign: assign is a manager handing someone else's lead
--    to a user; pull is an agent claiming unassigned work for themselves. Counsellors
--    and Telecallers get it (own scope) — they are the ones who do the calling.
INSERT INTO permission (key, module, action) VALUES ('lead.pull', 'lead', 'pull')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('Super Admin',        'all'),
      ('Organization Admin', 'all'),
      ('Branch Manager',     'branch'),
      ('Vertical Manager',   'vertical'),
      ('Team Leader',        'team'),
      ('Counsellor',         'own'),
      ('Telecaller',         'own')
    ) AS t(role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
      SELECT ro.id, p.id, r.scope
        FROM role ro JOIN permission p ON p.key = 'lead.pull'
       WHERE ro.name = r.role_name AND ro.is_system
      ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 5) audit_log.action must accept 'handout'.
--    (`audit_log_action_check` is an enumerated CHECK — 015 and 019 each widened it;
--    the hand-out adds its own verb. Without this the whole claim transaction rolls
--    back on the audit insert: caught by the live smoke, never let out of the door.)
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('create','update','delete','login','export','transfer',
                    'permission_change','merge','restore','handout'));

-- 6) the anti-hoarding guardrail — CONFIGURABLE, DEFAULT OFF.
--    §4 defines no hoarding rule, so the default must not change today's behaviour:
--    an agent may pull a fresh batch whenever they like (the unworked leads of the
--    previous batch stay assigned to them and remain in their lead list).
--    Flip `enabled` to true (ONE app_setting row — no deploy) to require that
--    `min_actioned_pct` % of the previous batch is actioned before pulling again.
INSERT INTO app_setting (key, value) VALUES
  ('handout_guard', '{"enabled": false, "min_actioned_pct": 100}'::jsonb)
ON CONFLICT (key) DO NOTHING;
