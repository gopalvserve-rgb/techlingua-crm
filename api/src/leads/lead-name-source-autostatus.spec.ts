import { LeadsService, autoStatusFromStage } from './leads.service';

/**
 * dev/117 — Lead NAME + SOURCE editable on update, and a hardened stage -> status auto-rule.
 *
 * #1 LeadsService.update() persists a changed full_name (Name) and a scope-checked source_id
 *    (Source) via the same SET/activity path as any other field.
 * #2 autoStatusFromStage() keeps the stage-TYPE rule (won->Won, lost->Lost) and adds a NAME
 *    fallback so an open/untyped stage NAMED "Enrolled"/"Closed" still fires Won/Loss — the
 *    client's "Enrolled -> Won, Closed -> Loss" holds regardless of the live stage_type config.
 */
describe('dev/117 — lead name/source editable + hardened auto-status', () => {
  const scope = {} as any;

  const STAGES: Record<number, { id: number; name: string; pipeline_id: number; stage_type: string }> = {
    100: { id: 100, name: 'Negotiation', pipeline_id: 4, stage_type: 'open' },
    200: { id: 200, name: 'Enrolled', pipeline_id: 4, stage_type: 'won' },
    300: { id: 300, name: 'Closed', pipeline_id: 4, stage_type: 'lost' },
    // terminal stages misconfigured as 'open' — the NAME fallback must still fire
    400: { id: 400, name: 'Enrolled', pipeline_id: 4, stage_type: 'open' },
    500: { id: 500, name: 'Closed', pipeline_id: 4, stage_type: 'open' },
  };
  const STATUS_BY_CODE: Record<string, { id: number }> = { WON: { id: 14 }, LOST: { id: 15 } };
  const STATUS_NAME: Record<number, string> = { 10: 'New', 14: 'Won', 15: 'Lost' };
  const SOURCE_NAME: Record<number, string> = { 7: 'Website', 9: 'Walk-in' };

  function make(before: any) {
    const activities: Array<{ type: string; to: any }> = [];
    let updateSets: string[] = [];
    let updateParams: any[] = [];
    const one = async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM lead WHERE id') && sql.includes('deleted_at IS NULL')) return { ...before };
      if (sql.includes('FROM pipeline_stage WHERE id') && sql.includes('stage_type')) return STAGES[Number(params[0])] ?? null;
      if (sql.includes('SELECT name FROM pipeline_stage WHERE id')) return { name: STAGES[Number(params[0])]?.name ?? null };
      if (sql.includes('FROM m_status WHERE org_id') && sql.includes('code')) return STATUS_BY_CODE[String(params[1])] ?? null;
      if (sql.includes('SELECT name FROM m_status WHERE id')) return { name: STATUS_NAME[Number(params[0])] ?? null };
      if (sql.includes('SELECT name FROM source WHERE id')) return SOURCE_NAME[Number(params[0])] ? { name: SOURCE_NAME[Number(params[0])] } : null;
      if (sql.includes('SELECT score')) return { score: 50, temperature: 'warm', score_breakdown: [], is_flagged: false, flag_reason: null };
      return null;
    };
    const c = {
      query: async (sql: string, params: any[] = []) => {
        if (sql.startsWith('UPDATE lead SET')) { updateSets = [sql]; updateParams = params; return { rows: [{ ...before }] }; }
        if (sql.includes('INSERT INTO lead_activity')) {
          activities.push({ type: params[4], to: params[6] ? JSON.parse(params[6]) : null });
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const db: any = { one, tx: async (fn: any) => fn(c) };
    const enforcer: any = { assertRefInScope: jest.fn(async () => undefined) };
    const scoring: any = { safeRescore: async () => undefined };
    const sla: any = { safe: async (fn: any) => fn(), onStageChanged: async () => undefined, onLeadTouched: async () => undefined };
    const journeys: any = { safeFire: async () => undefined };
    const svc = new LeadsService(db, {} as any, enforcer, {} as any, scoring, sla, journeys);
    return { svc, activities, enforcer, sql: () => updateSets[0] ?? '', params: () => updateParams };
  }

  const lead = { id: 1, org_id: 1, branch_id: 2, pipeline_id: 4, stage_id: 100, status_id: 10, source_id: 7, full_name: 'Old Name' };

  describe('autoStatusFromStage() helper', () => {
    it('stage TYPE is authoritative', () => {
      expect(autoStatusFromStage('won', 'Anything')).toBe('WON');
      expect(autoStatusFromStage('lost', 'Anything')).toBe('LOST');
      expect(autoStatusFromStage('open', 'Negotiation')).toBeNull();
    });
    it('NAME fallback fires on an open/untyped terminal stage', () => {
      expect(autoStatusFromStage('open', 'Enrolled')).toBe('WON');
      expect(autoStatusFromStage('open', 'Closed')).toBe('LOST');
      expect(autoStatusFromStage(null, 'Closed - Lost')).toBe('LOST');
      expect(autoStatusFromStage('', 'Enrollment done')).toBe('WON');
    });
    it('TYPE wins over a conflicting name', () => {
      expect(autoStatusFromStage('won', 'Closed')).toBe('WON');
      expect(autoStatusFromStage('lost', 'Enrolled')).toBe('LOST');
    });
  });

  it('#1 update persists a changed full_name (Name)', async () => {
    const { svc, sql, params } = make(lead);
    await svc.update(1, { full_name: 'ZZTEST New Name' }, 1, scope);
    expect(sql()).toContain('full_name =');
    expect(params()).toContain('ZZTEST New Name');
  });

  it('#1 update persists a scope-checked source_id (Source) + logs the change', async () => {
    const { svc, sql, params, enforcer, activities } = make(lead);
    await svc.update(1, { source_id: 9 }, 1, scope);
    expect(enforcer.assertRefInScope).toHaveBeenCalledWith(scope, 'source', 9, 1);
    expect(sql()).toContain('source_id =');
    expect(params()).toContain(9);
    expect(activities.find((a) => a.type === 'field_change' && a.to?.source_id)).toBeTruthy();
  });

  it('#2 an open stage NAMED "Closed" still auto-sets status to Lost (name fallback)', async () => {
    const { svc, activities } = make(lead);
    await svc.update(1, { stage_id: 500 }, 1, scope);
    const st = activities.find((a) => a.type === 'status_change');
    expect(st?.to?.name).toBe('Lost');
  });

  // crm25aug (#1): a MANUAL pipeline stage change to "Enrolled" (a WON stage) must NOT
  // auto-set Status = WON. WON / enrolment happens ONLY through Convert-to-Student. The
  // Closed -> Lost auto-mapping is retained (tests above). These two assert the WON drop.
  it('#1 manual stage change to a WON-TYPED "Enrolled" stage does NOT set status to Won', async () => {
    const { svc, activities } = make(lead);
    await svc.update(1, { stage_id: 200 }, 1, scope); // 200 = Enrolled, stage_type 'won'
    const st = activities.find((a) => a.type === 'status_change');
    expect(st).toBeUndefined();
  });

  it('#1 an open stage NAMED "Enrolled" also does NOT auto-set status to Won', async () => {
    const { svc, activities } = make(lead);
    await svc.update(1, { stage_id: 400 }, 1, scope); // 400 = open stage named Enrolled
    const st = activities.find((a) => a.type === 'status_change');
    expect(st).toBeUndefined();
  });

  it('#1 a WON stage move still HONOURS an explicit status in the same PATCH (no forced WON, no block)', async () => {
    const { svc, activities } = make(lead);
    await svc.update(1, { stage_id: 200, status_id: 14 }, 1, scope); // explicit Won id 14
    const st = activities.find((a) => a.type === 'status_change');
    expect(st?.to?.name).toBe('Won');
  });
});
