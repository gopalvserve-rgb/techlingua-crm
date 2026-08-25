import { LeadsService } from './leads.service';

/**
 * dev/95 item 2 — AUTO LEAD STATUS FROM THE STAGE TYPE.
 *
 * crm25aug (#1) UPDATE: a manual move to a WON-type stage (e.g. "Enrolled") NO LONGER forces
 * Lead Status = Won — WON / enrolment happens ONLY through Convert-to-Student. Moving to a
 * LOST/closed-type stage STILL forces Status = Lost (client kept that). An unrelated (open)
 * stage move never touches a manually-set status. These unit tests pin that contract at
 * LeadsService.update().
 */
describe('LeadsService.update — auto lead status from the stage type', () => {
  const scope = {} as any;

  const STAGES: Record<number, { id: number; name: string; pipeline_id: number; stage_type: string }> = {
    100: { id: 100, name: 'Negotiation', pipeline_id: 4, stage_type: 'open' },
    200: { id: 200, name: 'Enrolled', pipeline_id: 4, stage_type: 'won' },
    300: { id: 300, name: 'Closed', pipeline_id: 4, stage_type: 'lost' },
  };
  const STATUS_BY_CODE: Record<string, { id: number }> = { WON: { id: 14 }, LOST: { id: 15 } };
  const STATUS_NAME: Record<number, string> = { 10: 'New', 11: 'In Progress', 14: 'Won', 15: 'Lost' };

  function make(before: any) {
    const activities: Array<{ type: string; to: any }> = [];
    const one = async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM lead WHERE id') && sql.includes('deleted_at IS NULL')) return { ...before };
      if (sql.includes('FROM pipeline_stage WHERE id') && sql.includes('stage_type')) return STAGES[Number(params[0])] ?? null;
      if (sql.includes('SELECT name FROM pipeline_stage WHERE id')) return { name: STAGES[Number(params[0])]?.name ?? null };
      if (sql.includes('FROM m_status WHERE org_id') && sql.includes('code')) return STATUS_BY_CODE[String(params[1])] ?? null;
      if (sql.includes('SELECT name FROM m_status WHERE id')) return { name: STATUS_NAME[Number(params[0])] ?? null };
      if (sql.includes('SELECT score')) return { score: 50, temperature: 'warm', score_breakdown: [], is_flagged: false, flag_reason: null };
      return null;
    };
    const c = {
      query: async (sql: string, params: any[] = []) => {
        if (sql.startsWith('UPDATE lead SET')) return { rows: [{ ...before }] };
        if (sql.includes('INSERT INTO lead_activity')) {
          const type = params[4];
          const to = params[6] ? JSON.parse(params[6]) : null;
          activities.push({ type, to });
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const db: any = { one, tx: async (fn: any) => fn(c) };
    const enforcer: any = { assertRefInScope: async () => undefined };
    const scoring: any = { safeRescore: async () => undefined };
    const sla: any = { safe: async (fn: any) => fn(), onStageChanged: async () => undefined, onLeadTouched: async () => undefined };
    const journeys: any = { safeFire: async () => undefined };
    const svc = new LeadsService(db, {} as any, enforcer, {} as any, scoring, sla, journeys);
    return { svc, activities };
  }

  const leadOnOpen = { id: 1, org_id: 1, branch_id: 2, pipeline_id: 4, stage_id: 100, status_id: 10 };

  it('crm25aug #1 — stage → WON (Enrolled) does NOT auto-set status to Won', async () => {
    const { svc, activities } = make(leadOnOpen);
    await svc.update(1, { stage_id: 200 }, 1, scope);
    // The WON auto-mapping is removed for a manual stage change; only Convert-to-Student wins a lead.
    expect(activities.find((a) => a.type === 'status_change')).toBeFalsy();
  });

  it('stage → LOST (Closed) auto-sets status to Lost', async () => {
    const { svc, activities } = make(leadOnOpen);
    await svc.update(1, { stage_id: 300 }, 1, scope);
    const st = activities.find((a) => a.type === 'status_change');
    expect(st).toBeTruthy();
    expect(st!.to.name).toBe('Lost');
  });

  it('unrelated (open) stage move does NOT override a manually-set status', async () => {
    const { svc, activities } = make({ ...leadOnOpen, stage_id: 100, status_id: 11 });
    await svc.update(1, { stage_id: 100, status_id: undefined } as any, 1, scope);
    // no stage move (same stage) and no status change requested → no status_change activity
    expect(activities.find((a) => a.type === 'status_change')).toBeFalsy();
  });

  it('crm25aug #1 — an explicit status in the same PATCH as a WON stage move is HONOURED (no forced Won)', async () => {
    const { svc, activities } = make(leadOnOpen);
    await svc.update(1, { stage_id: 200, status_id: 11 } as any, 1, scope);
    const st = activities.find((a) => a.type === 'status_change');
    expect(st!.to.name).toBe('In Progress');
  });

  it('is idempotent — a WON lead already on status Won gets no redundant status_change', async () => {
    const { svc, activities } = make({ ...leadOnOpen, stage_id: 100, status_id: 14 });
    await svc.update(1, { stage_id: 200 }, 1, scope);
    expect(activities.find((a) => a.type === 'status_change')).toBeFalsy();
  });
});
