import { CallIntelService, parseInsight } from './call-intel.service';
import { SttAdapterService } from './stt-adapter.service';

/** Client 12 Nov 2026 — AI Insights / Communication Intelligence pipeline. */
describe('call insight parsing + flags', () => {
  const good = JSON.stringify({
    summary: 'Prospect asked about German A1 weekend batches and fees.', key_points: ['weekend batch', 'fees'], next_steps: ['send fee plan'],
    sentiment: 'positive', sentiment_score: 0.6, criteria: { greeting: 18, needs_identified: 16, solution_offered: 17, next_step_set: 15, politeness: 19 },
    quality_score: 85, coaching: 'Confirm the start date.', objections: ['fees too high'], objections_handled: true, intent: 'considering',
    interest_level: 'high', follow_up_suggestion: 'Call back on Friday with the instalment plan.',
  });

  it('normalises a good answer and does not flag it', () => {
    const x = parseInsight(`Here you go: ${good}`, 50);
    expect(x.quality_score).toBe(85);
    expect(x.sentiment).toBe('positive');
    expect(x.intent).toBe('considering');
    expect(x.objections).toEqual(['fees too high']);
    expect(x.flagged).toBe(false);
  });

  it('flags low quality, negative sentiment and an unanswered objection', () => {
    const x = parseInsight(JSON.stringify({ criteria: { greeting: 5, needs_identified: 5, solution_offered: 5, next_step_set: 5, politeness: 5 },
      sentiment: 'negative', objections: ['no time'], objections_handled: false }), 50);
    expect(x.quality_score).toBe(25);
    expect(x.flag_reasons).toEqual(['Quality 25/100 is below 50', 'Negative sentiment', 'Objection not handled']);
    expect(x.flagged).toBe(true);
  });

  it('never trusts the model: junk becomes safe defaults, numbers are clamped', () => {
    const x = parseInsight('not json at all', 50);
    expect(x.sentiment).toBe('neutral');
    expect(x.intent).toBe('other');
    expect(x.quality_score).toBe(0);
    const y = parseInsight(JSON.stringify({ quality_score: 400, sentiment_score: 9, intent: 'hack', criteria: { greeting: 99 } }), 50);
    expect(y.quality_score).toBe(100);
    expect(y.sentiment_score).toBe(1);
    expect(y.criteria.greeting).toBe(20);
    expect(y.intent).toBe('other');
  });
});

describe('speech-to-text adapter', () => {
  const mk = (provider: string, resp: any) => {
    const channels: any = { resolve: jest.fn(async () => ({ provider, config: {}, secrets: { api_key: 'k' } })) };
    const svc = new SttAdapterService(channels);
    const calls: Array<{ url: string; init: any }> = [];
    svc.http = jest.fn(async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => resp, text: async () => '' }; });
    return { svc, calls };
  };

  it('OpenAI Whisper: multipart to /audio/transcriptions with the model and language', async () => {
    const { svc, calls } = mk('openai_whisper', { text: 'namaste, German course ke baare mein' });
    const r = await svc.transcribe(Buffer.from('x'), 'audio/mpeg', 'c.mp3', 'hi');
    expect(r.text).toContain('German');
    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect((calls[0].init.body as FormData).get('model')).toBe('whisper-1');
    expect((calls[0].init.body as FormData).get('language')).toBe('hi');
  });

  it('Deepgram: raw audio, Token auth, speaker-labelled lines from diarized words', async () => {
    const { svc, calls } = mk('deepgram', { results: { channels: [{ detected_language: 'hi', alternatives: [{ transcript: 'hello hi',
      words: [{ word: 'hello', punctuated_word: 'Hello,', speaker: 0 }, { word: 'hi', punctuated_word: 'hi.', speaker: 1 }] }] }] } });
    const r = await svc.transcribe(Buffer.from('x'), 'audio/mp4', 'c.m4a', 'auto');
    expect(calls[0].url).toMatch(/^https:\/\/api\.deepgram\.com\/v1\/listen\?.*detect_language=true/);
    expect(calls[0].init.headers.Authorization).toBe('Token k');
    expect(r.text).toBe('Speaker 1: Hello,\nSpeaker 2: hi.');
    expect(r.language).toBe('hi');
  });

  it('Sarvam: subscription-key header and an Indian language code', async () => {
    const { svc, calls } = mk('sarvam', { transcript: 'theek hai', language_code: 'hi-IN' });
    const r = await svc.transcribe(Buffer.from('x'), 'audio/wav', 'c.wav', 'hi');
    expect(calls[0].url).toBe('https://api.sarvam.ai/speech-to-text');
    expect(calls[0].init.headers['api-subscription-key']).toBe('k');
    expect((calls[0].init.body as FormData).get('language_code')).toBe('hi-IN');
    expect(r.text).toBe('theek hai');
  });

  it('no key → not configured, nothing is sent', async () => {
    const svc = new SttAdapterService({ resolve: jest.fn(async () => null) } as any);
    svc.http = jest.fn();
    await expect(svc.transcribe(Buffer.from('x'), 'audio/mpeg', 'c.mp3')).rejects.toThrow(/not configured/);
    expect(svc.http).not.toHaveBeenCalled();
  });
});

describe('the worker', () => {
  it('with no speech-to-text key and no AI key it queues and sends nothing', async () => {
    const sql: string[] = [];
    const db: any = { query: jest.fn(async (s: string) => { sql.push(s); return []; }), one: jest.fn(async () => null) };
    const stt: any = { active: jest.fn(async () => null), transcribe: jest.fn() };
    const llm: any = { anyConfigured: jest.fn(async () => false), complete: jest.fn() };
    const svc = new CallIntelService(db, {} as any, llm, stt);
    const out = await svc.tick();
    expect(out).toEqual({ enqueued: 0, transcribed: 0, analysed: 0 });
    expect(stt.transcribe).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
    expect(sql.some((s) => /INSERT INTO call_transcript/.test(s))).toBe(false);
  });
});
