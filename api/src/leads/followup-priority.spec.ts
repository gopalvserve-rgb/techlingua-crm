import { BadRequestException } from '@nestjs/common';
import { FOLLOWUP_PRIORITIES, assertPriority } from './followups.service';

/** Client update #4 — follow-up/task priority validation (low | medium | high). */
describe('follow-up priority', () => {
  it('accepts the three sanctioned values', () => {
    for (const p of FOLLOWUP_PRIORITIES) expect(assertPriority(p)).toBe(p);
  });

  it.each([['urgent'], ['med'], ['HIGH'], [''], [null], [42]])('rejects %p with 400', (bad) => {
    expect(() => assertPriority(bad)).toThrow(BadRequestException);
  });

  it('error message lists the allowed values', () => {
    try { assertPriority('urgent'); } catch (e: any) {
      expect(e.message).toContain('low, medium, high');
    }
  });
});
