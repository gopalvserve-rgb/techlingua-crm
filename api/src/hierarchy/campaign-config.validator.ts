import { BadRequestException } from '@nestjs/common';

/**
 * Strict validation of the campaign NeoDove configs (QA DEF-2, PROJECT_DOC §4).
 * Applied on BOTH create and update; invalid input -> 400 with a clear message.
 * Returns the normalised config (defaults applied) for storage.
 */

export const DISTRIBUTION_MODES = ['on_demand', 'equal', 'conditional'] as const;
export const ROUND_ROBIN_SCOPES = ['branch', 'vertical', 'pipeline', 'campaign'] as const;
export const DUPLICACY_CHECK_SCOPES = ['this_campaign', 'this_pipeline', 'global'] as const;
export const DUPLICACY_ACTIONS = ['ignore', 'merge', 'create', 'merge_and_reopen'] as const;
export const CONDITION_OPS = ['equals', 'not_equals', 'contains', 'in'] as const;

function fail(message: string): never {
  throw new BadRequestException(message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertKnownKeys(obj: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length) fail(`${label}: unknown key(s) ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
}

function isIdArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => Number.isInteger(x) && (x as number) > 0);
}

/** distribution_config: { mode, batch_size, round_robin_scope?, agent_user_ids?, conditions? } */
export function validateDistributionConfig(input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) fail('distribution_config must be a JSON object');
  assertKnownKeys(input, ['mode', 'batch_size', 'round_robin_scope', 'agent_user_ids', 'conditions'], 'distribution_config');

  const mode = input.mode ?? 'on_demand';
  if (typeof mode !== 'string' || !(DISTRIBUTION_MODES as readonly string[]).includes(mode)) {
    fail(`distribution_config.mode must be one of: ${DISTRIBUTION_MODES.join(', ')} (got '${String(input.mode)}')`);
  }

  const batchSize = input.batch_size ?? 10;
  if (!Number.isInteger(batchSize) || (batchSize as number) <= 0) {
    fail(`distribution_config.batch_size must be a positive integer (got '${String(input.batch_size)}')`);
  }

  if (input.round_robin_scope !== undefined
    && (typeof input.round_robin_scope !== 'string'
      || !(ROUND_ROBIN_SCOPES as readonly string[]).includes(input.round_robin_scope))) {
    fail(`distribution_config.round_robin_scope must be one of: ${ROUND_ROBIN_SCOPES.join(', ')} (got '${String(input.round_robin_scope)}')`);
  }

  if (input.agent_user_ids !== undefined && !isIdArray(input.agent_user_ids)) {
    fail('distribution_config.agent_user_ids must be an array of positive integer user ids');
  }
  const agentIds = (input.agent_user_ids as number[] | undefined) ?? [];
  if (new Set(agentIds).size !== agentIds.length) {
    fail('distribution_config.agent_user_ids must not contain duplicate user ids');
  }
  // Equal round-robin needs a concrete pool to rotate over; On Demand may leave it
  // empty (anyone in scope self-assigns) and Conditional assigns through its rules.
  if (mode === 'equal' && agentIds.length === 0) {
    fail('distribution_config.agent_user_ids must contain at least one user when mode is "equal" (pick the agents to rotate leads across)');
  }

  let conditions: Record<string, unknown>[] | undefined;
  if (mode === 'conditional') {
    if (!Array.isArray(input.conditions) || input.conditions.length === 0) {
      fail('distribution_config.conditions must be a non-empty array when mode is "conditional"');
    }
    conditions = (input.conditions as unknown[]).map((c, i) => validateCondition(c, i));
  } else if (input.conditions !== undefined) {
    fail('distribution_config.conditions is only allowed when mode is "conditional"');
  }

  return {
    mode,
    batch_size: batchSize,
    ...(input.round_robin_scope !== undefined ? { round_robin_scope: input.round_robin_scope } : {}),
    ...(input.agent_user_ids !== undefined ? { agent_user_ids: input.agent_user_ids } : {}),
    ...(conditions ? { conditions } : {}),
  };
}

/** One rule of the conditional rule-builder: { field, op?, value, assign_to_user_ids }. */
function validateCondition(c: unknown, index: number): Record<string, unknown> {
  const label = `distribution_config.conditions[${index}]`;
  if (!isPlainObject(c)) fail(`${label} must be an object`);
  assertKnownKeys(c, ['field', 'op', 'value', 'assign_to_user_ids'], label);

  if (typeof c.field !== 'string' || !c.field.trim()) fail(`${label}.field must be a non-empty string`);

  const op = c.op ?? 'equals';
  if (typeof op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(op)) {
    fail(`${label}.op must be one of: ${CONDITION_OPS.join(', ')} (got '${String(c.op)}')`);
  }

  const scalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v);
  if (c.value === undefined || (!scalar(c.value) && !(Array.isArray(c.value) && c.value.every(scalar)))) {
    fail(`${label}.value is required and must be a scalar or an array of scalars`);
  }

  if (!isIdArray(c.assign_to_user_ids) || (c.assign_to_user_ids as number[]).length === 0) {
    fail(`${label}.assign_to_user_ids must be a non-empty array of user ids`);
  }
  if (new Set(c.assign_to_user_ids as number[]).size !== (c.assign_to_user_ids as number[]).length) {
    fail(`${label}.assign_to_user_ids must not contain duplicate user ids`);
  }

  return { field: c.field.trim(), op, value: c.value, assign_to_user_ids: c.assign_to_user_ids };
}

/** duplicacy_config: { check_scope, match_key, on_duplicate, open_reassign_same_user } */
export function validateDuplicacyConfig(input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) fail('duplicacy_config must be a JSON object');
  assertKnownKeys(input, ['check_scope', 'match_key', 'on_duplicate', 'open_reassign_same_user'], 'duplicacy_config');

  const checkScope = input.check_scope ?? 'this_campaign';
  if (typeof checkScope !== 'string' || !(DUPLICACY_CHECK_SCOPES as readonly string[]).includes(checkScope)) {
    fail(`duplicacy_config.check_scope must be one of: ${DUPLICACY_CHECK_SCOPES.join(', ')} (got '${String(input.check_scope)}')`);
  }

  const matchKey = input.match_key ?? 'phone';
  if (matchKey !== 'phone') {
    fail(`duplicacy_config.match_key must be 'phone' (got '${String(input.match_key)}')`);
  }

  const onDuplicate = input.on_duplicate ?? 'ignore';
  if (typeof onDuplicate !== 'string' || !(DUPLICACY_ACTIONS as readonly string[]).includes(onDuplicate)) {
    fail(`duplicacy_config.on_duplicate must be one of: ${DUPLICACY_ACTIONS.join(', ')} (got '${String(input.on_duplicate)}')`);
  }

  const reassign = input.open_reassign_same_user ?? true;
  if (typeof reassign !== 'boolean') {
    fail('duplicacy_config.open_reassign_same_user must be a boolean');
  }

  return { check_scope: checkScope, match_key: matchKey, on_duplicate: onDuplicate, open_reassign_same_user: reassign };
}
