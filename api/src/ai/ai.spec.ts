import { AiService } from './ai.service';
import { LlmAdapterService } from './llm-adapter.service';
import { NotConfiguredException } from '../common/not-configured.exception';

/**
 * ERP Batch 4 — AI Communication Intelligence.
 *
 * The LLM is ALWAYS mocked here — no test ever calls a real external provider. We prove:
 *  · with a (mocked) key: summary / sentiment / quality return STRUCTURED output persisted to ai_analysis;
 *  · with NO key: analyze() rethrows NotConfiguredException (a clean 503, never a 500);
 *  · transcription of a pasted transcript stores the text with no LLM call;
 *  · the JSON parser is defensive against a non-JSON model reply.
 */

/** A db double that captures the ai_analysis INSERT and echoes a row back (mimicking PG). */
function fakeDb() {
  const inserts: any[] = [];
  const db = {
    one: async (sql: string, p: any[]) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/INSERT INTO ai_analysis/.test(sql)) {
        const row = {
          id: inserts.length + 1, org_id: p[0], subject_type: p[1], subject_id: p[2], subject_label: p[3],
          analysis_type: p[4], input_source: p[5], input_ref: p[6], input_text: p[7], provider: p[8], model: p[9],
          status: p[10], output: JSON.parse(p[11]), summary_text: p[12], sentiment: p[13], quality_score: p[14],
          tokens: p[15], error: p[16], branch_id: p[17], vertical_id: p[18], pipeline_id: p[19], campaign_id: p[20],
          team_id: p[21], owner_id: p[22], created_by: p[23], created_at: new Date().toISOString(),
        };
        inserts.push(row);
        return row;
      }
      if (/FROM lead l/.test(sql)) return { id: 5, full_name: 'Asha Rao', owner_id: 9, team_id: 3, branch_id: 1, vertical_id: 2, pipeline_id: null, campaign_id: null };
      if (/FROM ai_analysis a/.test(sql)) return inserts[0] ?? null; // get()
      return null;
    },
    query: async (sql: string) => {
      if (/FROM lead_activity/.test(sql)) return [{ type: 'note', note: 'Prospect keen on IELTS evening batch.', at: '01 Aug 2026 10:00' }];
      return [];
    },
  };
  return { db, inserts };
}

const resolver = { buildScopeWhere: () => '1=1' } as any;
const scope = { allowed: true, all: true, filters: [] } as any;
const me = { id: 9, name: 'Counsellor' };

/** An adapter double: complete() returns canned JSON per type; providerStatus() = configured. */
function fakeAdapter(configured = true): LlmAdapterService {
  return {
    providerStatus: async () => [
      { provider: 'deepseek', label: 'DeepSeek', configured },
      { provider: 'gemini', label: 'Google Gemini', configured: false },
    ],
    anyConfigured: async () => configured,
    complete: async (req: any) => {
      if (/sentiment/i.test(req.user)) return { text: '{"sentiment":"positive","score":0.7,"rationale":"Keen on the course."}', provider: 'deepseek', model: 'deepseek-chat', tokens: 42 };
      if (/rubric/i.test(req.user)) return { text: '{"criteria":{"greeting":18,"needs_identified":16,"solution_offered":15,"next_step_set":14,"politeness":19},"total":82,"notes":"Set a firmer next step."}', provider: 'deepseek', model: 'deepseek-chat', tokens: 51 };
      return { text: '{"summary":"Prospect wants IELTS coaching, budget flexible.","key_points":["IELTS","evening batch"],"next_steps":["Share fees"]}', provider: 'deepseek', model: 'deepseek-chat', tokens: 33 };
    },
  } as any;
}

describe('AI analyze — the three LLM capabilities (mocked)', () => {
  it('summary returns structured output persisted to ai_analysis', async () => {
    const { db, inserts } = fakeDb();
    const svc = new AiService(db as any, resolver, fakeAdapter());
    const out = await svc.analyze({ analysis_type: 'summary', input_text: 'Long chat about IELTS...' }, me, scope);
    expect(out.analysis_type).toBe('summary');
    expect((out as any).output.summary).toMatch(/IELTS/);
    expect((out as any).output.key_points.length).toBeGreaterThan(0);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].provider).toBe('deepseek');
    expect(inserts[0].summary_text).toMatch(/IELTS/);
  });

  it('sentiment classifies + stores the sentiment column', async () => {
    const { db, inserts } = fakeDb();
    const svc = new AiService(db as any, resolver, fakeAdapter());
    const out = await svc.analyze({ analysis_type: 'sentiment', input_text: 'Great conversation' }, me, scope);
    expect(out.sentiment).toBe('positive');
    expect((out as any).output.score).toBeCloseTo(0.7);
    expect(inserts[0].sentiment).toBe('positive');
  });

  it('quality scores against the rubric (0-100) + stores quality_score', async () => {
    const { db, inserts } = fakeDb();
    const svc = new AiService(db as any, resolver, fakeAdapter());
    const out = await svc.analyze({ analysis_type: 'quality', input_text: 'Counsellor call transcript' }, me, scope);
    expect(out.quality_score).toBe(82);
    expect((out as any).output.criteria.greeting).toBe(18);
    expect(inserts[0].quality_score).toBe(82);
  });

  it('a lead subject with no pasted text gathers notes/timeline as the input', async () => {
    const { db, inserts } = fakeDb();
    const svc = new AiService(db as any, resolver, fakeAdapter());
    const out = await svc.analyze({ analysis_type: 'summary', subject_type: 'lead', subject_id: 5 }, me, scope);
    expect(out.subject_label).toBe('Asha Rao');
    expect(inserts[0].branch_id).toBe(1);
    expect(inserts[0].owner_id).toBe(9);
  });
});

describe('AI degrades cleanly when NO key is configured', () => {
  it('analyze rethrows NotConfiguredException (a 503, not a 500)', async () => {
    const { db } = fakeDb();
    const adapter = fakeAdapter(false);
    (adapter as any).complete = async () => { throw new NotConfiguredException('AI is not configured — add a DeepSeek or Gemini key.'); };
    const svc = new AiService(db as any, resolver, adapter);
    await expect(svc.analyze({ analysis_type: 'summary', input_text: 'hello' }, me, scope))
      .rejects.toMatchObject({ notConfigured: true });
  });

  it('status reports configured=false with a clear hint and never throws', async () => {
    const { db } = fakeDb();
    const svc = new AiService(db as any, resolver, fakeAdapter(false));
    const st = await svc.status();
    expect(st.configured).toBe(false);
    expect(st.providers.map((p) => p.provider).sort()).toEqual(['deepseek', 'gemini']);
    expect(st.hint).toMatch(/Settings/);
  });
});

describe('transcription + defensive parsing', () => {
  it('a pasted transcript is stored with NO LLM call', async () => {
    const { db, inserts } = fakeDb();
    const adapter = fakeAdapter();
    const spy = jest.spyOn(adapter, 'complete');
    const svc = new AiService(db as any, resolver, adapter);
    const out = await svc.analyze({ analysis_type: 'transcription', input_text: 'Agent: hello. Prospect: hi.' }, me, scope);
    expect(out.analysis_type).toBe('transcription');
    expect((out as any).output.transcript).toMatch(/hello/);
    expect(spy).not.toHaveBeenCalled();
    expect(inserts[0].provider).toBeNull();
  });

  it('a non-JSON model reply does not crash — summary falls back to the raw text', async () => {
    const { db } = fakeDb();
    const adapter = fakeAdapter();
    (adapter as any).complete = async () => ({ text: 'not json at all', provider: 'gemini', model: 'gemini-2.0-flash', tokens: null });
    const svc = new AiService(db as any, resolver, adapter);
    const out = await svc.analyze({ analysis_type: 'summary', input_text: 'some transcript text' }, me, scope);
    expect((out as any).output.summary).toBe('not json at all');
  });

  it('audio transcription is rejected as key-dependent, guiding the pasted-transcript path', async () => {
    const { db } = fakeDb();
    const svc = new AiService(db as any, resolver, fakeAdapter());
    await expect(svc.analyze({ analysis_type: 'transcription', has_audio: true }, me, scope))
      .rejects.toThrow(/paste/i);
  });
});
