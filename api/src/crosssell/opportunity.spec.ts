import { CrossSellOpportunityService, courseFamily, matchScore, periodWindow, saleTypeOf } from './opportunity.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';

/** Client 12 Nov 2026 — Cross-Sell as per the mockup. */
describe('cross-sell scoring + types', () => {
  it('course family is the first word', () => {
    expect(courseFamily('German A1')).toBe('german');
    expect(courseFamily('Data Science - Advanced')).toBe('data');
  });

  it('match % = rule weight + fully paid + recent + next level, capped at 99', () => {
    expect(matchScore({ basis: 'rule', weight: 85 }).pct).toBe(85);
    expect(matchScore({ basis: 'vertical' }).pct).toBe(60);
    const s = matchScore({ basis: 'rule', weight: 85, fullyPaid: true, recent: true, sameFamily: true });
    expect(s.pct).toBe(99);
    expect(s.parts.map(([k]) => k)).toEqual(['Cross-sell rule', 'Fees fully paid', 'Enrolled in the last 6 months', 'Next step in the same course family']);
  });

  it('type: rule wins; else another vertical = cross-vertical; same family = upsell / downsell by fee; else cross-sell', () => {
    expect(saleTypeOf({ ruleType: 'downsell', sameFamily: true })).toBe('downsell');
    expect(saleTypeOf({ fromVertical: 1, toVertical: 2 })).toBe('cross_vertical');
    expect(saleTypeOf({ fromVertical: 1, toVertical: 1, sameFamily: true, fromFee: 15000, toFee: 18000 })).toBe('upsell');
    expect(saleTypeOf({ fromVertical: 1, toVertical: 1, sameFamily: true, fromFee: 18000, toFee: 9000 })).toBe('downsell');
    expect(saleTypeOf({ fromVertical: 1, toVertical: 1 })).toBe('cross_sell');
  });

  it('period windows are IST dates with a same-length previous period', () => {
    expect(periodWindow('this_month', undefined, undefined, '2026-11-19')).toEqual({ from: '2026-11-01', to: '2026-12-01', prevFrom: '2026-10-02', prevTo: '2026-11-01' });
    expect(periodWindow('last_month', undefined, undefined, '2026-11-19')).toMatchObject({ from: '2026-10-01', to: '2026-11-01' });
    expect(periodWindow('custom', '2026-11-01', '2026-11-10', '2026-11-19')).toMatchObject({ from: '2026-11-01', to: '2026-11-11', prevFrom: '2026-10-22' });
    expect(periodWindow('all')).toEqual({ from: null, to: null, prevFrom: null, prevTo: null });
  });
});

describe('opportunity stage guards', () => {
  const ADMIN = { permissionKey: 'crosssell.act', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] } as any;
  const mk = (stage: string) => {
    const calls: string[] = [];
    const db: any = {
      query: jest.fn(async (sql: string) => { calls.push(sql); return []; }),
      one: jest.fn(async (sql: string) => {
        calls.push(sql);
        if (/FROM cross_sell_opportunity o/.test(sql)) return { id: 5, stage, lead_id: 1, course_name: 'German A2', owner_id: 3, history: [] };
        return null;
      }),
      tx: jest.fn(),
    };
    return { svc: new CrossSellOpportunityService(db, new ScopeResolverService(), {} as any), calls };
  };

  it('"Converted" cannot be typed in — it comes from Sale Closure', async () => {
    const { svc } = mk('negotiation');
    await expect(svc.update(5, { stage: 'converted' }, { id: 3 }, ADMIN)).rejects.toThrow(/Sale Closure/);
  });

  it('"Lost" needs a reason', async () => {
    const { svc } = mk('contacted');
    await expect(svc.update(5, { stage: 'lost' }, { id: 3 }, ADMIN)).rejects.toThrow(/why it was lost/i);
  });

  it('a converted opportunity is closed', async () => {
    const { svc } = mk('converted');
    await expect(svc.update(5, { stage: 'contacted' }, { id: 3 }, ADMIN)).rejects.toThrow(/converted/);
  });

  it('a stage move writes the history row', async () => {
    const { svc, calls } = mk('contacted');
    await svc.update(5, { stage: 'interested' }, { id: 3 }, ADMIN);
    expect(calls.some((s) => /UPDATE cross_sell_opportunity SET stage = \$1/.test(s))).toBe(true);
    expect(calls.some((s) => /INSERT INTO cross_sell_opportunity_history/.test(s))).toBe(true);
  });

  it('reconcile converts on an ACTIVE enrolment for the same contact + course only', async () => {
    const { svc, calls } = mk('new');
    await svc.reconcile();
    const sql = calls.find((s) => /WITH hit AS/.test(s))!;
    expect(sql).toContain(`e.status = 'active'`);
    expect(sql).toContain('e.lead_id = o.lead_id AND e.course_id = o.course_id');
    expect(sql).toContain(`o.stage NOT IN ('converted', 'lost')`);
  });
});
