import { LeadsService } from './leads.service';

/**
 * dev/84 item 3 — ROUND-ROBIN on a MANUAL lead create.
 *
 * The client asked for an "Assign via round-robin" option on the manual Add-Lead flow that
 * auto-assigns the owner via the SAME campaign distribution engine walk-ins / CSV / webhook
 * leads use — never a re-implementation. In LeadsService.create(), `dto.round_robin` DROPS any
 * picked owner and passes owner_id:null to the shared LeadIngestionService, whose ingest path
 * then runs resolvePool + pickOwner (the race-safe campaign_distribution_state cursor). These
 * unit tests pin that contract at the create() boundary: round_robin ⇒ owner_id null to the
 * engine (engine assigns); no round_robin ⇒ the picked owner is forced through unchanged.
 */
describe('LeadsService.create — round-robin flag hands owner selection to the engine', () => {
  const scope = {} as any;
  const scored = { score: 50, temperature: 'warm', score_breakdown: [] };

  function make() {
    const captured: any[] = [];
    const db: any = { one: async () => scored };
    const enforcer: any = { assertRefInScope: async () => undefined };
    const ingestion: any = {
      ingestAndReturn: async (_payload: any, ctx: any) => {
        captured.push(ctx);
        return { outcome: { duplicate_of: null }, lead: { id: 1, full_name: 'ZZTEST' } };
      },
    };
    const scoring: any = { safeRescore: async () => undefined };
    const sla: any = { safe: async (fn: any) => fn(), onLeadCreated: async () => undefined };
    const svc = new LeadsService(db, {} as any, enforcer, ingestion, scoring, sla);
    return { svc, captured };
  }

  const base = { full_name: 'ZZTEST RR', phone: '9990001111', campaign_id: 5, source_id: 7 };

  it('round_robin:true ⇒ owner_id null reaches the engine even when an owner was picked', async () => {
    const { svc, captured } = make();
    await svc.create({ ...base, owner_id: 99, round_robin: true } as any, 1, scope);
    expect(captured).toHaveLength(1);
    expect(captured[0].owner_id).toBeNull();           // engine (round-robin) assigns, not the pick
  });

  it('no round_robin ⇒ the picked owner is forced through to the engine unchanged', async () => {
    const { svc, captured } = make();
    await svc.create({ ...base, owner_id: 99 } as any, 1, scope);
    expect(captured[0].owner_id).toBe(99);
  });

  it('no owner + no round_robin ⇒ owner_id null (campaign distribution decides as before)', async () => {
    const { svc, captured } = make();
    await svc.create({ ...base } as any, 1, scope);
    expect(captured[0].owner_id).toBeNull();
  });
});
