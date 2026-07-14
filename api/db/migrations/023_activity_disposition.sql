-- 023 — lead_activity.type must accept 'disposition' (Sprint 2 / WS4)
--
-- The Start Calling queue logs the CALL OUTCOME on the lead's timeline: the agent
-- picks a disposition ("Connected", "Not picking up", …), optionally moves the stage
-- and schedules the next follow-up, and the batch progress advances. That outcome is
-- its own timeline event — not a note, not a follow-up — so `lead_activity.type` needs
-- the verb. Same story as 022 (audit_log.action): the CHECK is enumerated (005), the
-- in-memory test double enforced no constraints, and the live smoke caught it.
-- Both fake DBs now validate against these lists, so the next verb cannot ship without
-- its migration.
ALTER TABLE lead_activity DROP CONSTRAINT IF EXISTS lead_activity_type_check;
ALTER TABLE lead_activity ADD  CONSTRAINT lead_activity_type_check
  CHECK (type IN ('create','stage_change','status_change','assign','follow_up','note',
                  'message','call_log','field_change','merge','transfer','disposition'));
