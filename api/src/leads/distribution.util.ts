/**
 * NeoDove distribution engine helpers (Sprint 2+ — campaign agent pool).
 *
 * Pure functions so the round-robin + conditional matching logic unit-tests
 * without a DB. The service (leads.service.create) owns the transactional
 * cursor bump on campaign_distribution_state.
 *
 * BEFORE this change leads were created with owner_id straight from the DTO
 * (null when omitted) — distribution_config.agent_user_ids was stored but
 * NEVER consulted, and campaign_distribution_state was never written. Now:
 *   - equal:       round-robin across exactly distribution_config.agent_user_ids
 *   - conditional: first matching rule assigns from its assign_to_user_ids
 *                  (round-robin within the rule's pool when it has >1 user)
 *   - on_demand:   leads stay unassigned (agents self-assign in scope)
 * An explicit dto.owner_id always wins over auto-assignment.
 */

export interface DistributionCondition {
  field: string;
  op?: 'equals' | 'not_equals' | 'contains' | 'in';
  value: unknown;
  assign_to_user_ids: number[];
}

export interface DistributionConfig {
  mode?: 'on_demand' | 'equal' | 'conditional';
  batch_size?: number;
  round_robin_scope?: string;
  agent_user_ids?: number[];
  conditions?: DistributionCondition[];
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** Loose scalar compare: '12' == 12, case-insensitive strings. */
const scalarEq = (a: unknown, b: unknown): boolean => norm(a) === norm(b);

/** Evaluate ONE condition against the lead context (field -> value map). */
export function evalCondition(cond: DistributionCondition, ctx: Record<string, unknown>): boolean {
  const lead = ctx[cond.field];
  const op = cond.op ?? 'equals';
  switch (op) {
    case 'equals':
      return scalarEq(lead, cond.value);
    case 'not_equals':
      return !scalarEq(lead, cond.value);
    case 'contains':
      if (Array.isArray(cond.value)) return cond.value.some((v) => norm(lead).includes(norm(v)));
      return norm(lead).includes(norm(cond.value)) && norm(cond.value) !== '';
    case 'in': {
      const hay = Array.isArray(cond.value) ? cond.value : [cond.value];
      return hay.some((v) => scalarEq(lead, v));
    }
    default:
      return false;
  }
}

/** First matching rule (order = priority), or null when none match. */
export function matchCondition(
  conditions: DistributionCondition[] | undefined, ctx: Record<string, unknown>,
): { rule: DistributionCondition; index: number } | null {
  for (let i = 0; i < (conditions?.length ?? 0); i++) {
    const rule = (conditions as DistributionCondition[])[i];
    if (Array.isArray(rule.assign_to_user_ids) && rule.assign_to_user_ids.length && evalCondition(rule, ctx)) {
      return { rule, index: i };
    }
  }
  return null;
}

/**
 * Cursor -> pool pick. The stored cursor is a monotonically increasing counter
 * (bumped once per auto-assignment); the modulo is applied HERE, at pick time,
 * so editing the agent pool (shrink/grow/reorder) can never point the cursor
 * outside the pool — the next lead simply continues the rotation over the
 * CURRENT pool. Returns null for an empty pool.
 */
export function pickFromPool(pool: number[], cursor: number): number | null {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const idx = ((cursor % pool.length) + pool.length) % pool.length; // negative-safe
  return pool[idx];
}
