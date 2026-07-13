-- 019 — Sprint 2, WS2: DUPLICACY ACTIONS (execute merge / merge & reopen).
--
-- Migration 018 shipped duplicate DETECTION and left a deliberate seam:
-- `merge` / `merge_and_reopen` were recorded on lead_ingest_record.pending_action
-- (+ duplicate_of_id) but never executed. This migration closes that seam.
--
-- NeoDove §4 actions, all four now real:
--   ignore           -> drop the incoming record, keep the existing lead
--   create           -> a second lead, flagged is_duplicate + duplicate_of_id
--   merge            -> fold the incoming payload into the EXISTING lead
--                       (fill blanks; on conflict keep existing + record the
--                        incoming value in the timeline/diff — never destructive)
--   merge_and_reopen -> merge AND move a won/lost lead back to an open stage
--
-- Owner rule (§4): a merge NEVER re-runs round-robin. The existing lead keeps
-- its owner; an open duplicate stays with the same user.

-- 1) lead: point a duplicate at the lead it duplicates -----------------------
--    (merged_into_id already exists from 005 — used for merged-away tombstones)
ALTER TABLE lead ADD COLUMN IF NOT EXISTS duplicate_of_id BIGINT NULL REFERENCES lead(id);
CREATE INDEX IF NOT EXISTS idx_lead_duplicate_of ON lead(duplicate_of_id) WHERE duplicate_of_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_merged_into  ON lead(merged_into_id)  WHERE merged_into_id IS NOT NULL;

-- 2) lead_merge — the auditable merge record + the DIFF the UI shows ---------
--    source_lead_id is NULL for an ingest-time merge (the incoming record never
--    became a lead); it is set when a user merges two existing leads.
CREATE TABLE IF NOT EXISTS lead_merge (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  target_lead_id BIGINT NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  source_lead_id BIGINT NULL REFERENCES lead(id) ON DELETE SET NULL,
  channel        VARCHAR(16) NOT NULL DEFAULT 'manual',
  action         VARCHAR(20) NOT NULL CHECK (action IN ('merge','merge_and_reopen')),
  reopened       BOOLEAN NOT NULL DEFAULT FALSE,
  -- { filled: {field:{to}}, conflicts: {field:{kept,incoming}},
  --   custom_filled: {...}, custom_conflicts: {...}, tags_added: [...] }
  diff           JSONB NOT NULL DEFAULT '{}',
  actor_id       BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_merge_target ON lead_merge(target_lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_merge_source ON lead_merge(source_lead_id);

-- 3) ingest ledger: record the action that was ACTUALLY executed -------------
--    pending_action stays (018) and now means "recorded but not executed".
ALTER TABLE lead_ingest_record ADD COLUMN IF NOT EXISTS applied_action VARCHAR(24) NULL;
ALTER TABLE lead_ingest_record ADD COLUMN IF NOT EXISTS merge_id BIGINT NULL REFERENCES lead_merge(id) ON DELETE SET NULL;

-- 4) audit_log must accept action='merge' -----------------------------------
--    ...and 'restore': the AuditInterceptor has emitted action='restore' for
--    soft-delete restores since 015, but the CHECK never allowed it, so those
--    audit writes were failing silently (the interceptor swallows audit errors).
--    Fixed here — restores are audited from now on.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_action_check
  CHECK (action IN ('create','update','delete','login','export','transfer',
                    'permission_change','merge','restore'));

-- 5) permission: lead.merge --------------------------------------------------
INSERT INTO permission (key, module, action) VALUES ('lead.merge','lead','merge')
ON CONFLICT (key) DO NOTHING;

-- Granted where lead.update already is, and never wider than the role's own lead
-- scope: a merge rewrites a lead, so it inherits that scope (a Counsellor can
-- only merge leads they own). Marketing Manager (read-only) is excluded.
DO $$
DECLARE
  r RECORD;
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
      FROM role ro
      JOIN permission p ON p.key = 'lead.merge'
     WHERE ro.name = r.role_name AND ro.is_system
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 6) BACKFILL of the WS1 seam ------------------------------------------------
-- Rows the CSV workstream ingested under a merge/merge_and_reopen policy were
-- created as a SECOND flagged lead and carry pending_action. We deliberately do
-- NOT retro-merge them: those leads may already have been worked (owner, notes,
-- follow-ups) and an automatic merge would rewrite a record a human has touched.
-- Instead we make them visible and actionable: the duplicate pointer is
-- backfilled onto the lead, so the lead detail screen shows "duplicate of #X"
-- and offers a MANUAL merge with a full diff preview (RBAC: lead.merge).
UPDATE lead l
   SET duplicate_of_id = r.duplicate_of_id
  FROM lead_ingest_record r
 WHERE r.lead_id = l.id
   AND r.duplicate_of_id IS NOT NULL
   AND l.duplicate_of_id IS NULL
   AND l.merged_into_id IS NULL;

-- ...and mark those ledger rows as "awaiting a human decision" rather than
-- leaving them looking pending-but-unowned forever.
UPDATE lead_ingest_record
   SET applied_action = 'create_pending_review'
 WHERE pending_action IN ('merge','merge_and_reopen')
   AND applied_action IS NULL;
