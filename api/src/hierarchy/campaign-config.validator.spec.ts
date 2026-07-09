import { BadRequestException } from '@nestjs/common';
import { validateDistributionConfig, validateDuplicacyConfig } from './campaign-config.validator';

/** Unit tests for strict NeoDove campaign config validation (QA DEF-2). */

describe('validateDistributionConfig', () => {
  it('accepts a full valid config (equal + round_robin_scope + agent ids)', () => {
    const out = validateDistributionConfig({
      mode: 'equal', batch_size: 10, agent_user_ids: [], round_robin_scope: 'campaign',
    });
    expect(out).toEqual({ mode: 'equal', batch_size: 10, agent_user_ids: [], round_robin_scope: 'campaign' });
  });

  it('applies defaults: mode on_demand, batch_size 10', () => {
    expect(validateDistributionConfig({})).toEqual({ mode: 'on_demand', batch_size: 10 });
  });

  it.each([
    [{ mode: 'bogus_mode' }, /mode must be one of/],
    [{ batch_size: 0 }, /batch_size must be a positive integer/],
    [{ batch_size: 2.5 }, /batch_size must be a positive integer/],
    [{ batch_size: -3 }, /batch_size must be a positive integer/],
    [{ round_robin_scope: 'galaxy' }, /round_robin_scope must be one of/],
    [{ agent_user_ids: ['x'] }, /agent_user_ids/],
    [{ mode: 'conditional' }, /conditions must be a non-empty array/],
    [{ mode: 'conditional', conditions: [] }, /conditions must be a non-empty array/],
    [{ mode: 'equal', conditions: [{}] }, /only allowed when mode is "conditional"/],
    [{ surprise: true }, /unknown key/],
    ['not-an-object', /must be a JSON object/],
    [[1, 2], /must be a JSON object/],
  ])('rejects %j', (input, msg) => {
    expect(() => validateDistributionConfig(input)).toThrow(BadRequestException);
    expect(() => validateDistributionConfig(input)).toThrow(msg);
  });

  it('validates the conditional rule shape', () => {
    const good = validateDistributionConfig({
      mode: 'conditional',
      conditions: [{ field: 'course', op: 'equals', value: 'IELTS', assign_to_user_ids: [4, 5] }],
    });
    expect((good.conditions as any[])[0]).toEqual({
      field: 'course', op: 'equals', value: 'IELTS', assign_to_user_ids: [4, 5],
    });

    const bad = (conditions: unknown[]) => () =>
      validateDistributionConfig({ mode: 'conditional', conditions });
    expect(bad([{ op: 'equals', value: 1, assign_to_user_ids: [1] }])).toThrow(/field must be a non-empty string/);
    expect(bad([{ field: 'course', op: 'sounds_like', value: 1, assign_to_user_ids: [1] }])).toThrow(/op must be one of/);
    expect(bad([{ field: 'course', assign_to_user_ids: [1] }])).toThrow(/value is required/);
    expect(bad([{ field: 'course', value: 'x', assign_to_user_ids: [] }])).toThrow(/assign_to_user_ids/);
    expect(bad(['nope'])).toThrow(/must be an object/);
  });
});

describe('validateDuplicacyConfig', () => {
  it('accepts a full valid config', () => {
    expect(validateDuplicacyConfig({
      check_scope: 'this_pipeline', match_key: 'phone', on_duplicate: 'merge_and_reopen', open_reassign_same_user: true,
    })).toEqual({
      check_scope: 'this_pipeline', match_key: 'phone', on_duplicate: 'merge_and_reopen', open_reassign_same_user: true,
    });
  });

  it('applies documented defaults (this_campaign / phone / ignore / reassign true)', () => {
    expect(validateDuplicacyConfig({})).toEqual({
      check_scope: 'this_campaign', match_key: 'phone', on_duplicate: 'ignore', open_reassign_same_user: true,
    });
  });

  it.each([
    [{ check_scope: 'everywhere' }, /check_scope must be one of/],
    [{ on_duplicate: 'explode' }, /on_duplicate must be one of/],
    [{ match_key: 'email' }, /match_key must be 'phone'/],
    [{ open_reassign_same_user: 'yes' }, /must be a boolean/],
    [{ extra_key: 1 }, /unknown key/],
    [null, /must be a JSON object/],
  ])('rejects %j', (input, msg) => {
    expect(() => validateDuplicacyConfig(input)).toThrow(BadRequestException);
    expect(() => validateDuplicacyConfig(input)).toThrow(msg);
  });
});
