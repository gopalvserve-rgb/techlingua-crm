import { SlaService } from './sla.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';

/**
 * SLA POLICIES + CLOCKS + TAT.
 *
 * The model the client is buying:
 *   · a policy is CONFIGURABLE per stage and per pipeline; the MOST SPECIFIC one wins
 *   · first_response starts at lead creation and stops at the first human touch
 *   · stage_duration runs while the lead sits in a stage
 *   · TAT per stage is recorded on every move (that is what feeds the Sprint-6 reports)
 *   · the breach LIST is scoped — a Branch Manager's "manager view" is their branch
 */

type Call = { sql: string; params: unknown[] };

function build(rows: Record<string, any[]> = {}) {
  const calls: Call[] = [];
  const pick = (sql: string) => {
    const s = sql.replace(/\s+/g, ' ');
    if (/FROM sla_policy WHERE is_active/.test(s)) return rows.policy ?? [];
    if (/FROM lead WHERE id/.test(s)) return rows.lead ?? [{ id: 1, pipeline_id: 4, stage_id: 11, created_at: '2026-07-14T09:00:00Z' }];
    if (/FROM lead_stage_tat WHERE lead_id/.test(s)) return rows.openTat ?? [];
    return [];
  };
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return pick(sql); },
    one: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return pick(sql)[0] ?? {}; },
  } as unknown as DatabaseService;
  return { svc: new SlaService(db, new ScopeResolverService()), calls };
}
const sqlOf = (calls: Call[], re: RegExp) => calls.filter((c) => re.test(c.sql.replace(/\s+/g, ' ')));

const scope = (over: Partial<ResolvedScope>): ResolvedScope => ({
  permissionKey: 'sla.read', allowed: true, all: false, filters: [], allowedFields: null, deniedFields: [], ...over,
});

/* -------------------------- policy selection -------------------------- */

describe('policy selection — most specific wins (stage > pipeline > global)', () => {
  it('the lookup orders stage-specific first, then pipeline-specific, then global', async () => {
    const { svc, calls } = build({ policy: [{ id: 1, threshold_minutes: 60 }] });
    await svc.onLeadCreated(1);
    const lookup = sqlOf(calls, /FROM sla_policy WHERE is_active/)[0];
    expect(lookup.sql.replace(/\s+/g, ' '))
      .toContain('ORDER BY (stage_id IS NOT NULL) DESC, (pipeline_id IS NOT NULL) DESC, id');
    expect(lookup.sql.replace(/\s+/g, ' ')).toContain('LIMIT 1');
    // and a global policy (pipeline_id IS NULL) is still eligible for any pipeline
    expect(lookup.sql).toContain('pipeline_id IS NULL OR pipeline_id = $2');
  });

  it('NO policy = no clock (SLA is opt-in; an org with no policy is not permanently breaching)', async () => {
    const { svc, calls } = build({ policy: [] });
    await svc.onLeadCreated(1);
    expect(sqlOf(calls, /INSERT INTO lead_sla/)).toHaveLength(0);
    // ...but the TAT row is still opened — TAT is measured whether or not an SLA exists
    expect(sqlOf(calls, /INSERT INTO lead_stage_tat/)).toHaveLength(1);
  });
});

/* -------------------------- clocks -------------------------- */

describe('first-response clock', () => {
  it('starts at LEAD CREATION and is due threshold_minutes later', async () => {
    const { svc, calls } = build({ policy: [{ id: 1, threshold_minutes: 60 }] });
    await svc.onLeadCreated(1);
    const ins = sqlOf(calls, /INSERT INTO lead_sla/)[0];
    expect(ins.sql).toContain("'first_response'");
    expect(ins.sql).toContain("$3 + ($4 || ' minutes')::interval");   // due = created + threshold
    expect(ins.params).toEqual([1, 1, '2026-07-14T09:00:00Z', '60']);
    expect(ins.sql).toContain('ON CONFLICT DO NOTHING');              // idempotent replay
  });

  it('a human touch STOPS it and records the elapsed time (the TAT number)', async () => {
    const { svc, calls } = build();
    await svc.onLeadTouched(42);
    const upd = sqlOf(calls, /UPDATE lead_sla/)[0];
    expect(upd.sql).toContain("metric = 'first_response'");
    expect(upd.sql).toContain('satisfied_at IS NULL');   // only an OPEN clock is stopped
    expect(upd.sql).toContain('elapsed_seconds');
    expect(upd.params).toEqual([42]);
  });

  it('a LATE response still stops the clock (satisfied_at > due_at = "responded, but breached")', async () => {
    const { svc, calls } = build();
    await svc.onLeadTouched(42);
    // the update is unconditional on due_at — a late stop is a stop, and the TAT report wants it
    expect(sqlOf(calls, /UPDATE lead_sla/)[0].sql).not.toContain('due_at');
  });
});

describe('stage TAT + stage_duration clock', () => {
  it('a stage move CLOSES the open TAT row with its duration and OPENS the next', async () => {
    const { svc, calls } = build({
      policy: [{ id: 2, threshold_minutes: 4320 }],
      openTat: [{ id: 77, stage_id: 11 }],
    });
    await svc.onStageChanged(1, 12);
    const close = sqlOf(calls, /UPDATE lead_stage_tat/)[0];
    expect(close.sql).toContain('exited_at = now()');
    expect(close.sql).toContain('seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - entered_at))::int)');
    expect(close.params).toEqual([77]);
    const open = sqlOf(calls, /INSERT INTO lead_stage_tat/)[0];
    expect(open.params).toEqual([1, 4, 12]);      // lead, pipeline, the NEW stage
  });

  it('leaving a stage SATISFIES that stage\'s duration clock', async () => {
    const { svc, calls } = build({ policy: [{ id: 2, threshold_minutes: 60 }], openTat: [{ id: 77, stage_id: 11 }] });
    await svc.onStageChanged(1, 12);
    const sat = sqlOf(calls, /UPDATE lead_sla.*stage_duration/s)[0];
    expect(sat.sql).toContain("metric = 'stage_duration'");
    expect(sat.params).toEqual([1, 11]);          // the stage being LEFT
  });

  it('a "move" to the SAME stage is a no-op (kanban drag back onto its own column)', async () => {
    const { svc, calls } = build({ openTat: [{ id: 77, stage_id: 11 }] });
    await svc.onStageChanged(1, 11);
    expect(sqlOf(calls, /UPDATE lead_stage_tat/)).toHaveLength(0);
    expect(sqlOf(calls, /INSERT INTO lead_stage_tat/)).toHaveLength(0);
  });

  it('a stage move also counts as a human touch (it stops the first-response clock)', async () => {
    const { svc, calls } = build({ openTat: [{ id: 77, stage_id: 11 }] });
    await svc.onStageChanged(1, 12);
    expect(sqlOf(calls, /UPDATE lead_sla.*first_response/s).length).toBeGreaterThan(0);
  });
});

/* -------------------------- reads + scoping -------------------------- */

describe('the breach list is SCOPED (the manager view cannot leak another branch)', () => {
  it('a branch manager only sees their branch', async () => {
    const { svc, calls } = build();
    await svc.breaches(scope({ filters: [{ kind: 'branch', branchId: 9 }] }));
    const q = calls.find((c) => /FROM lead_sla s/.test(c.sql))!;
    expect(q.sql).toContain('l.branch_id = $1');
    expect(q.params[0]).toBe(9);
    expect(q.sql).toContain('s.satisfied_at IS NULL AND s.due_at <= now()');
  });

  it('a counsellor only sees breaches on their OWN leads', async () => {
    const { svc, calls } = build();
    await svc.breaches(scope({ filters: [{ kind: 'own', userId: 3 }] }));
    expect(calls.find((c) => /FROM lead_sla s/.test(c.sql))!.sql).toContain('l.owner_id = $1');
  });

  it('the SLA summary is scoped too', async () => {
    const { svc, calls } = build();
    await svc.summary(scope({ filters: [{ kind: 'vertical', verticalId: 1 }] }));
    for (const c of calls) expect(c.sql).toContain('l.vertical_id = $1');
  });
});

/* -------------------------- validation -------------------------- */

describe('policy validation', () => {
  const bad = async (dto: any, msg: RegExp) => {
    const { svc } = build();
    await expect(svc.createPolicy(dto, 1)).rejects.toThrow(msg);
  };
  it('needs a name', () => bad({ metric: 'first_response', threshold_minutes: 60 }, /name is required/));
  it('needs a known metric', () => bad({ name: 'x', metric: 'vibes', threshold_minutes: 60 }, /first_response or stage_duration/));
  it('needs a positive threshold', () => bad({ name: 'x', metric: 'first_response', threshold_minutes: 0 }, /positive/));
  it('a stage_duration policy must name a STAGE (else it is meaningless)', () =>
    bad({ name: 'x', metric: 'stage_duration', threshold_minutes: 60 }, /must name a stage/));
  it('rejects a negative escalation delay', () =>
    bad({ name: 'x', metric: 'first_response', threshold_minutes: 60, escalate_after_minutes: -5 }, /0 or more/));
});

describe('SLA bookkeeping never breaks the operation that triggered it', () => {
  it('safe() swallows a failure (a lead must still save if its clock hiccups)', async () => {
    const { svc } = build();
    await expect(svc.safe(async () => { throw new Error('boom'); }, 'test')).resolves.toBeUndefined();
  });
});
