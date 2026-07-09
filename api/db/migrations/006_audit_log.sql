-- 006: global append-only audit log — covers all entities (RBAC changes, transfers, exports).
-- Distinct from lead_activity (lead-facing timeline). Month-range partitioning deferred with lead partitioning.

CREATE TABLE audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT REFERENCES organisation(id),
  actor_id    BIGINT REFERENCES "user"(id),
  entity_type VARCHAR(60) NOT NULL,
  entity_id   BIGINT,
  action      VARCHAR(20) NOT NULL
              CHECK (action IN ('create','update','delete','login','export','transfer','permission_change')),
  before      JSONB,
  after       JSONB,
  ip          VARCHAR(45),
  user_agent  TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_actor  ON audit_log(actor_id, occurred_at);
