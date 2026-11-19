/**
 * COMMUNICATION INTELLIGENCE — client 12 Nov 2026 ("AI Insights … Communication Intelligence:
 * complete this module"). Each menu item is now its own screen over ONE pipeline:
 *
 *   phone-app recording → speech-to-text (the provider the client chooses) → one AI read per call
 *   (summary, key points, next steps, sentiment, quality rubric, objections, intent, interest,
 *   follow-up) → flags for managers, keyword alerts, the lead's timeline.
 *
 *   AI Insights         overview: calls analysed, quality, sentiment, open flags, trends, objections,
 *                       intents — plus the manual analysis (paste a transcript / a lead's notes)
 *   Call Insights       every analysed call; open one for the full read, transcript and recording
 *   Call Ratings        counsellor by counsellor: average quality and the five rubric criteria
 *   Quality Monitoring  flagged calls to review, and the quality trend
 *   Call Transcription  the transcription queue, settings, recordings to queue, paste a transcript
 *   Call Summaries      search every call summary
 *
 * Everything is scoped to the user's own calls / branch / vertical by the API.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_, selectableUsers } from './refdata';
import { FilterMulti, EnumMulti } from './dyn';
import { ListActions, downloadObjectsCsv } from './listtools';
import { LeadLookup } from './forms';
import { RecordingPlayer } from './calls';
import { AiIntelligence } from './ai';
import { DonutChart, HBarChart, LineChart } from './charts';

const SENT: Record<string, [string, string]> = { positive: ['Positive', 'b-green'], neutral: ['Neutral', 'b-gray'], negative: ['Negative', 'b-rose'] };
const INTENT: Record<string, string> = { enrol_now: 'Ready to enrol', considering: 'Considering', price_shopping: 'Comparing prices', information_only: 'Just information',
  callback_requested: 'Wants a call back', not_interested: 'Not interested', wrong_number: 'Wrong number', other: 'Other' };
const CRIT: Array<[string, string]> = [['greeting', 'Greeting'], ['needs_identified', 'Needs identified'], ['solution_offered', 'Solution offered'],
  ['next_step_set', 'Next step set'], ['politeness', 'Politeness']];
const dtt = (v: unknown) => (v ? new Date(String(v)).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
const mmss = (s: unknown) => { const n = Number(s ?? 0); return n ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` : '—'; };
const qBadge = (q: number | null | undefined): Cell => (q == null ? '—' : { b: [`${q}/100`, q >= 75 ? 'b-green' : q >= 50 ? 'b-indigo' : 'b-rose'] });
const sBadge = (s: string | null | undefined): Cell => (s ? { b: SENT[s] ?? [s, 'b-gray'] } : '—');

/* ------------------------------------------------------------ status banner */

/** What is set up and what is flowing — says exactly what is missing, in plain words. */
export function CiBanner() {
  const st = useFetch<any>('/call-intel/status', []);
  const s = st.data;
  if (!s) return null;
  const missing: string[] = [];
  if (!s.stt.configured) missing.push('choose a speech-to-text provider and add its key (Administration › Settings › Channels › Speech-to-text)');
  if (!s.llm.configured) missing.push('add an AI key (Settings › Channels › AI)');
  if (!s.recordings) missing.push('install the latest Android app on the counsellors\' phones so call recordings reach the CRM');
  return (
    <div className={`notice${missing.length ? '' : ' ok'}`} style={{ marginBottom: 12 }} data-testid="ci-banner">
      <Ic k={missing.length ? 'bolt' : 'check'} />
      <div>
        {missing.length ? <><b>To analyse calls automatically:</b> {missing.join('; ')}. Until then you can paste a transcript in Call Transcription.</>
          : <><b>Call intelligence is live</b> — {s.stt.provider?.replace('_', ' ')} transcribes new recordings; each call is analysed by AI.</>}
        <div className="sub" style={{ marginTop: 4 }}>
          {s.calls_30d} calls logged in 30 days · {s.recordings} recordings received · transcripts: {s.transcripts.done} done, {s.transcripts.pending + s.transcripts.processing} waiting, {s.transcripts.failed} failed
          · {s.insights} calls analysed{s.open_flags ? ` · ${s.open_flags} flagged to review` : ''}{s.settings?.monthly_minutes_limit ? ` · ${s.minutes_this_month} of ${s.settings.monthly_minutes_limit} minutes this month` : ''}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- shared filters */

function useCiFilters() {
  const [users, setUsers] = useState<number[]>([]);
  const [sent, setSent] = useState<string[]>([]);
  const [intent, setIntent] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (users.length) p.set('user_ids', users.join(','));
    if (sent.length) p.set('sentiment', sent.join(','));
    if (intent.length) p.set('intent', intent.join(','));
    if (q.trim()) p.set('q', q.trim());
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p.toString();
  }, [users, sent, intent, q, from, to]);
  return { qs, users, setUsers, sent, setSent, intent, setIntent, q, setQ, from, setFrom, to, setTo };
}

function CiFilterBar({ f, search = true }: { f: ReturnType<typeof useCiFilters>; search?: boolean }) {
  const ref = useRef_();
  return (
    <div className="toolbar-surface" style={{ marginBottom: 12 }}><div className="filters">
      {search ? <input className="ainp" style={{ maxWidth: 240 }} placeholder="Search lead, summary, transcript" value={f.q} onChange={(e) => f.setQ(e.target.value)} /> : null}
      <FilterMulti label="Counsellor" icon="users" value={f.users} options={selectableUsers(ref.users)} onChange={f.setUsers} />
      <EnumMulti label="Sentiment" icon="chat" value={f.sent} options={Object.entries(SENT).map(([id, [name]]) => ({ id, name }))} onChange={f.setSent} />
      <EnumMulti label="Intent" icon="target" value={f.intent} options={Object.entries(INTENT).map(([id, name]) => ({ id, name }))} onChange={f.setIntent} />
      <input className="ainp" type="date" style={{ maxWidth: 160 }} value={f.from} onChange={(e) => f.setFrom(e.target.value)} aria-label="From" />
      <input className="ainp" type="date" style={{ maxWidth: 160 }} value={f.to} onChange={(e) => f.setTo(e.target.value)} aria-label="To" />
    </div></div>
  );
}

/* ------------------------------------------------------------- the call read */

export function InsightModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged?: () => void }) {
  const { can } = useAuth();
  const [tick, setTick] = useState(0);
  const d = useFetch<any>(`/call-intel/insights/${id}`, [id, tick]);
  const x = d.data;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast(msg); setTick((t) => t + 1); onChanged?.(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  if (!x) return null;
  const list = (a: unknown) => (Array.isArray(a) ? a : []);
  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 820 }} data-testid="ci-insight">
      <div className="ah"><h3><Ic k="intel" />{x.lead_name ?? 'Call'} · {x.user_name ?? '—'} · {dtt(x.call_at)}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
      <div className="abody">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <span className={`bdg ${(SENT[x.sentiment] ?? ['', 'b-gray'])[1]}`}>{(SENT[x.sentiment] ?? [x.sentiment])[0]}</span>
          {x.quality_score != null ? <span className="bdg b-indigo">Quality {x.quality_score}/100</span> : null}
          {x.intent ? <span className="bdg b-cyan">{INTENT[x.intent] ?? x.intent}</span> : null}
          {x.interest_level ? <span className="bdg b-amber">Interest: {x.interest_level}</span> : null}
          {x.flagged ? <span className="bdg b-rose">Flagged: {list(x.flag_reasons).join(' · ')}</span> : null}
          <span className="sub">{mmss(x.duration_s)} · {x.source === 'paste' ? 'pasted transcript' : `${x.stt_provider ?? ''} ${x.language ?? ''}`}</span>
        </div>
        {x.recording_id ? <div style={{ marginBottom: 10 }}><RecordingPlayer id={Number(x.recording_id)} /></div> : null}
        <h4 style={{ margin: '6px 0' }}>Summary</h4><p>{x.summary ?? '—'}</p>
        <div className="form-grid">
          <div><h4 style={{ margin: '6px 0' }}>Key points</h4>{list(x.key_points).map((k: string, i: number) => <div key={i} className="sub">• {k}</div>)}</div>
          <div><h4 style={{ margin: '6px 0' }}>Next steps</h4>{list(x.next_steps).map((k: string, i: number) => <div key={i} className="sub">• {k}</div>)}</div>
          <div><h4 style={{ margin: '6px 0' }}>Objections</h4>{list(x.objections).length ? list(x.objections).map((k: string, i: number) => <div key={i} className="sub">• {k}</div>) : <div className="sub">None raised</div>}</div>
          <div><h4 style={{ margin: '6px 0' }}>Suggested follow-up</h4><div className="sub">{x.follow_up ?? '—'}</div></div>
        </div>
        <h4 style={{ margin: '12px 0 6px' }}>Quality rubric</h4>
        {CRIT.map(([k, l]) => {
          const v = Number(x.criteria?.[k] ?? 0);
          return (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0' }}>
              <span className="sub" style={{ width: 140 }}>{l}</span>
              <div style={{ flex: 1, height: 8, background: 'var(--surface-3)', borderRadius: 4 }}><div style={{ width: `${(v / 20) * 100}%`, height: 8, background: 'var(--primary)', borderRadius: 4 }} /></div>
              <span className="mono" style={{ width: 40, textAlign: 'right' }}>{v}/20</span>
            </div>
          );
        })}
        {x.coaching ? <div className="notice" style={{ marginTop: 8 }}><Ic k="bolt" /><div><b>Coaching:</b> {x.coaching}</div></div> : null}
        <details style={{ marginTop: 10 }}><summary className="sub" style={{ cursor: 'pointer' }}>Transcript</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-body)', fontSize: 12.5, maxHeight: 320, overflow: 'auto' }}>{x.transcript}</pre></details>
        {x.flagged ? (
          <div className="card" style={{ padding: 10, marginTop: 10 }}>
            <b>Manager review</b>
            {x.reviewed_at ? <div className="sub">Reviewed by {x.reviewed_by_name ?? '—'} on {dtt(x.reviewed_at)}{x.review_note ? ` — ${x.review_note}` : ''}</div>
              : can('ai.run') ? (
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <input className="ainp" placeholder="What was discussed with the counsellor" value={note} onChange={(e) => setNote(e.target.value)} data-testid="ci-review-note" />
                  <button className="btn primary" disabled={busy} onClick={() => act(() => api.post(`/call-intel/insights/${id}/review`, { note }), 'Marked reviewed')} data-testid="ci-review"><Ic k="check" />Mark reviewed</button>
                </div>) : <div className="sub">Not reviewed yet.</div>}
          </div>
        ) : null}
      </div>
      <div className="af">
        {can('ai.run') ? <button className="btn" disabled={busy} onClick={() => act(() => api.post(`/call-intel/transcripts/${x.transcript_id}/analyse`, {}), 'Analysed again')}><Ic k="refresh" />Analyse again</button> : null}
        <span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Close</button>
      </div>
    </div></div>
  );
}

function insightRows(rows: any[], open: (id: number) => void): Cell[][] {
  return rows.map((r) => [
    { node: <div><b>{r.lead_name ?? '—'}</b><div className="sub">{dtt(r.call_at)} · {mmss(r.duration_s)}</div></div>, sort: String(r.call_at ?? '') },
    r.user_name ?? '—',
    { node: <span className="sub" style={{ display: 'block', maxWidth: 420 }}>{String(r.summary ?? '').slice(0, 180)}{String(r.summary ?? '').length > 180 ? '…' : ''}</span> },
    sBadge(r.sentiment), qBadge(r.quality_score),
    r.intent ? (INTENT[r.intent] ?? r.intent) : '—',
    r.flagged ? { b: [r.reviewed_at ? 'Reviewed' : 'Flagged', r.reviewed_at ? 'b-gray' : 'b-rose'] } : '—',
    { node: <button className="btn sm" onClick={() => open(Number(r.id))} data-testid={`ci-open-${r.id}`}><Ic k="eye" />Open</button> },
  ]);
}
const INSIGHT_COLS = ['Call', 'Counsellor', 'Summary', 'Sentiment', 'Quality', 'Intent', 'Flag', ''];
const csv = (rows: any[]) => rows.map((r) => ({ call_at: r.call_at, lead: r.lead_name, counsellor: r.user_name, sentiment: r.sentiment, quality: r.quality_score,
  intent: r.intent, interest: r.interest_level, flagged: r.flagged, reviewed: !!r.reviewed_at, objections: (r.objections ?? []).join('; '), summary: r.summary, follow_up: r.follow_up }));

/* ============================================================= AI Insights */

export function CallIntelOverview() {
  const [tab, setTab] = useState<'calls' | 'manual'>('calls');
  const f = useCiFilters();
  const o = useFetch<any>(`/call-intel/overview?${f.qs}`, [f.qs]);
  const recent = useFetch<any[]>(`/call-intel/insights?${f.qs}`, [f.qs]);
  const [open, setOpen] = useState<number | null>(null);
  const k = o.data?.kpis;
  const pct = (n: number) => (k?.calls ? `${Math.round((n * 100) / k.calls)}%` : '—');
  return (
    <>
      <div className="seg-tabs" role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <button role="tab" aria-selected={tab === 'calls'} className={`btn${tab === 'calls' ? ' primary' : ''}`} onClick={() => setTab('calls')}>Calls</button>
        <button role="tab" aria-selected={tab === 'manual'} className={`btn${tab === 'manual' ? ' primary' : ''}`} onClick={() => setTab('manual')}>Manual analysis (transcript / lead notes)</button>
      </div>
      {tab === 'manual' ? <AiIntelligence /> : (
        <>
          <CiBanner />
          <CiFilterBar f={f} search={false} />
          <Kpis cols={6} items={[
            { lab: 'Calls analysed', val: String(k?.calls ?? 0), ic: 'intel' },
            { lab: 'Average quality', val: k?.avg_quality != null ? `${k.avg_quality}/100` : '—', ic: 'perf' },
            { lab: 'Positive', val: k ? pct(k.positive) : '—', ic: 'check' },
            { lab: 'Negative', val: k ? pct(k.negative) : '—', ic: 'bolt' },
            { lab: 'Flagged to review', val: String(k?.open_flags ?? 0), ic: 'flag' },
            { lab: 'High-interest leads', val: String(k?.hot ?? 0), ic: 'target' },
          ]} />
          <div className="cs-grid" style={{ marginTop: 12 }}>
            <div className="card"><div className="card-head"><h3><Ic k="analytics" />Average quality by day</h3></div>
              <div className="card-pad">{(o.data?.trend ?? []).length ? <LineChart data={o.data.trend.map((t: any) => ({ label: t.label, value: t.avg_quality }))} fmt={(v) => String(Math.round(v))} ariaLabel="Average call quality by day" height={180} />
                : <div className="empty-note">The trend appears once calls are analysed.</div>}</div></div>
            <div className="card"><div className="card-head"><h3><Ic k="chat" />Sentiment</h3></div>
              <div className="card-pad">{k?.calls ? <DonutChart data={[{ label: 'Positive', value: k.positive }, { label: 'Neutral', value: k.neutral }, { label: 'Negative', value: k.negative }]} fmt={(v) => String(v)} ariaLabel="Call sentiment" />
                : <div className="empty-note">No calls analysed yet.</div>}</div></div>
          </div>
          <div className="cs-grid" style={{ marginTop: 12 }}>
            <div className="card"><div className="card-head"><h3><Ic k="flag" />Top objections</h3></div>
              <div className="card-pad">{(o.data?.objections ?? []).length ? <HBarChart data={o.data.objections} fmt={(v) => String(v)} ariaLabel="Top objections" /> : <div className="empty-note">No objections recorded yet.</div>}</div></div>
            <div className="card"><div className="card-head"><h3><Ic k="target" />What callers want</h3></div>
              <div className="card-pad">{(o.data?.intents ?? []).length ? <HBarChart data={o.data.intents} fmt={(v) => String(v)} ariaLabel="Caller intent" /> : <div className="empty-note">No intents yet.</div>}</div></div>
          </div>
          <div style={{ height: 12 }} />
          <TableCard title="Latest analysed calls" icon="intel" cols={INSIGHT_COLS} rows={insightRows((recent.data ?? []).slice(0, 10), setOpen)} empty="No calls analysed yet." />
          {open ? <InsightModal id={open} onClose={() => setOpen(null)} onChanged={() => { o.reload(); recent.reload(); }} /> : null}
        </>
      )}
    </>
  );
}

/* ============================================================ Call Insights */

export function CallInsights() {
  const f = useCiFilters();
  const [flag, setFlag] = useState('');
  const path = `/call-intel/insights?${f.qs}${flag ? `&flagged=${flag}` : ''}`;
  const { data, reload } = useFetch<any[]>(path, [path]);
  const [open, setOpen] = useState<number | null>(null);
  const rows = data ?? [];
  return (
    <>
      <CiBanner />
      <CiFilterBar f={f} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {[['', 'All calls'], ['true', 'Flagged'], ['open', 'Flagged, not reviewed']].map(([v, l]) => <button key={v} className={`btn sm${flag === v ? ' primary' : ''}`} onClick={() => setFlag(v)}>{l}</button>)}
      </div>
      <TableCard title={`Call insights · ${rows.length}`} icon="intel" listKey="callInsights" serial cols={INSIGHT_COLS} rows={insightRows(rows, setOpen)}
        more={<ListActions onExport={() => downloadObjectsCsv('call-insights.csv', csv(rows))} onRefresh={reload} />}
        empty="No analysed calls match. Calls appear here once a recording is transcribed and analysed, or a transcript is pasted in Call Transcription." />
      {open ? <InsightModal id={open} onClose={() => setOpen(null)} onChanged={reload} /> : null}
    </>
  );
}

/* ============================================================= Call Ratings */

export function CallRatings() {
  const f = useCiFilters();
  const { data, reload } = useFetch<any[]>(`/call-intel/ratings?${f.qs}`, [f.qs]);
  const rows = data ?? [];
  return (
    <>
      <CiBanner />
      <CiFilterBar f={f} search={false} />
      <div className="card" style={{ marginBottom: 12 }}><div className="card-head"><h3><Ic k="award" />Average quality by counsellor</h3></div>
        <div className="card-pad">{rows.length ? <HBarChart data={rows.map((r) => ({ label: r.user_name ?? '—', value: Number(r.avg_quality ?? 0) }))} fmt={(v) => `${Math.round(v)}/100`} ariaLabel="Average quality by counsellor" />
          : <div className="empty-note">Ratings appear once calls are analysed.</div>}</div></div>
      <TableCard title="Call ratings" icon="award" listKey="callRatings"
        more={<ListActions onExport={() => downloadObjectsCsv('call-ratings.csv', rows)} onRefresh={reload} />}
        cols={['Counsellor', 'Calls', 'Avg quality', 'Positive', 'Negative', 'Flagged', ...CRIT.map(([, l]) => l)]}
        empty="No ratings yet."
        rows={rows.map((r): Cell[] => [
          { node: <b>{r.user_name ?? '—'}</b> }, String(r.calls), qBadge(r.avg_quality), r.positive_pct != null ? `${r.positive_pct}%` : '—', String(r.negative), String(r.flagged),
          ...CRIT.map(([key]) => (r[key] != null ? `${r[key]}/20` : '—') as Cell),
        ])} />
    </>
  );
}

/* ======================================================= Quality Monitoring */

export function QualityMonitoring() {
  const f = useCiFilters();
  const [state, setState] = useState('open');
  const path = `/call-intel/insights?${f.qs}&flagged=${state}`;
  const { data, reload } = useFetch<any[]>(path, [path]);
  const o = useFetch<any>(`/call-intel/overview?${f.qs}`, [f.qs]);
  const [open, setOpen] = useState<number | null>(null);
  const rows = data ?? [];
  return (
    <>
      <CiBanner />
      <CiFilterBar f={f} search={false} />
      <div className="card" style={{ marginBottom: 12 }}><div className="card-head"><h3><Ic k="analytics" />Quality trend (60 days)</h3></div>
        <div className="card-pad">{(o.data?.trend ?? []).length ? <LineChart data={o.data.trend.map((t: any) => ({ label: t.label, value: t.avg_quality }))} fmt={(v) => String(Math.round(v))} ariaLabel="Quality trend" height={180} />
          : <div className="empty-note">The trend appears once calls are analysed.</div>}</div></div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {[['open', 'To review'], ['true', 'All flagged']].map(([v, l]) => <button key={v} className={`btn sm${state === v ? ' primary' : ''}`} onClick={() => setState(v)}>{l}</button>)}
        <span className="sub" style={{ alignSelf: 'center' }}>A call is flagged for low quality, negative sentiment or an objection the counsellor did not handle (threshold in Call Transcription › Settings).</span>
      </div>
      <TableCard title={`Flagged calls · ${rows.length}`} icon="flag" listKey="qualityFlags"
        more={<ListActions onExport={() => downloadObjectsCsv('flagged-calls.csv', csv(rows))} onRefresh={reload} />}
        cols={['Call', 'Counsellor', 'Why', 'Sentiment', 'Quality', 'Review', '']}
        empty={state === 'open' ? 'Nothing waiting for review.' : 'No flagged calls.'}
        rows={rows.map((r): Cell[] => [
          { node: <div><b>{r.lead_name ?? '—'}</b><div className="sub">{dtt(r.call_at)}</div></div> }, r.user_name ?? '—',
          (r.flag_reasons ?? []).join(' · ') || '—', sBadge(r.sentiment), qBadge(r.quality_score),
          r.reviewed_at ? `${r.reviewed_by_name ?? ''} ${dtt(r.reviewed_at)}` : { b: ['To review', 'b-rose'] },
          { node: <button className="btn sm" onClick={() => setOpen(Number(r.id))}><Ic k="eye" />Open</button> },
        ])} />
      {open ? <InsightModal id={open} onClose={() => setOpen(null)} onChanged={() => { reload(); o.reload(); }} /> : null}
    </>
  );
}

/* ======================================================= Call Transcription */

const LANGS: Array<[string, string]> = [['auto', 'Detect automatically'], ['hi', 'Hindi (and Hinglish)'], ['en', 'English'], ['pa', 'Punjabi'], ['bn', 'Bengali'],
  ['mr', 'Marathi'], ['gu', 'Gujarati'], ['ta', 'Tamil'], ['te', 'Telugu'], ['kn', 'Kannada'], ['ml', 'Malayalam']];
const T_STATUS: Record<string, [string, string]> = { pending: ['Waiting', 'b-amber'], processing: ['Transcribing', 'b-indigo'], done: ['Done', 'b-green'], failed: ['Failed', 'b-rose'], skipped: ['No speech', 'b-gray'] };

export function CallTranscription() {
  const { can } = useAuth();
  const [tick, setTick] = useState(0);
  const st = useFetch<any>('/call-intel/status', [tick]);
  const [status, setStatus] = useState('');
  const queue = useFetch<any[]>(`/call-intel/queue?status=${status}`, [status, tick]);
  const rec = useFetch<any[]>('/call-intel/recordings/untranscribed', [tick]);
  const [settings, setSettings] = useState<any>(null);
  const s = settings ?? st.data?.settings;
  const [leadId, setLeadId] = useState<number | undefined>();
  const [leadLabel, setLeadLabel] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const bump = () => setTick((t) => t + 1);
  const run = async (fn: () => Promise<any>, msg: string) => { setBusy(true); try { const r = await fn(); toast(msg); bump(); return r; } catch (e) { toast((e as Error).message, true); return null; } finally { setBusy(false); } };
  const t = st.data?.transcripts ?? {};
  return (
    <>
      <CiBanner />
      <Kpis cols={5} items={[
        { lab: 'Waiting', val: String((t.pending ?? 0) + (t.processing ?? 0)), ic: 'clock' },
        { lab: 'Transcribed', val: String(t.done ?? 0), ic: 'check' },
        { lab: 'Failed', val: String(t.failed ?? 0), ic: 'x' },
        { lab: 'Recordings not queued', val: String((rec.data ?? []).length), ic: 'calls' },
        { lab: 'Minutes this month', val: String(st.data?.minutes_this_month ?? 0), ic: 'clock' },
      ]} />
      <div className="cs-grid" style={{ marginTop: 12 }}>
        <div className="card"><div className="card-head"><h3><Ic k="doc" />Paste a transcript</h3></div>
          <div className="card-pad">
            <div className="fhint" style={{ marginBottom: 6 }}>For a call that was not recorded, or while recordings are not reaching the CRM yet. It is analysed straight away.</div>
            <div className="fld"><label htmlFor="ci-lead">Lead</label><LeadLookup inputId="ci-lead" value={leadLabel} onPick={(id, l) => { setLeadId(id); setLeadLabel(l); }} /></div>
            <textarea className="ainp" rows={7} placeholder="Counsellor: Hello, this is… / Lead: …" value={text} onChange={(e) => setText(e.target.value)} data-testid="ci-paste-text" />
            <button className="btn primary" style={{ marginTop: 8 }} disabled={busy || !can('ai.run') || text.trim().length < 20}
              onClick={async () => { const r = await run(() => api.post('/call-intel/paste', { lead_id: leadId, text }), 'Transcript saved'); if (r?.insight?.id) { setText(''); setOpen(Number(r.insight.id)); } else if (r?.message) toast(r.message); }}
              data-testid="ci-paste"><Ic k="bolt" />Save &amp; analyse</button>
          </div></div>
        <div className="card"><div className="card-head"><h3><Ic k="cfg" />Settings</h3></div>
          <div className="card-pad">
            {s ? (
              <>
                <div className="fld"><label>Language of the calls</label>
                  <select className="ainp" value={s.language} disabled={!can('settings.update')} onChange={(e) => setSettings({ ...s, language: e.target.value })}>
                    {LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                <label style={{ display: 'flex', gap: 8, margin: '6px 0' }}><input type="checkbox" checked={!!s.auto_transcribe} disabled={!can('settings.update')} onChange={(e) => setSettings({ ...s, auto_transcribe: e.target.checked })} />Transcribe new recordings automatically</label>
                <label style={{ display: 'flex', gap: 8, margin: '6px 0' }}><input type="checkbox" checked={!!s.auto_analyse} disabled={!can('settings.update')} onChange={(e) => setSettings({ ...s, auto_analyse: e.target.checked })} />Analyse every transcript with AI automatically</label>
                <div className="form-grid">
                  <div className="fld"><label>Skip calls shorter than (sec)</label><input className="ainp" type="number" value={s.min_duration_s} disabled={!can('settings.update')} onChange={(e) => setSettings({ ...s, min_duration_s: e.target.value })} /></div>
                  <div className="fld"><label>Monthly minutes limit (0 = none)</label><input className="ainp" type="number" value={s.monthly_minutes_limit} disabled={!can('settings.update')} onChange={(e) => setSettings({ ...s, monthly_minutes_limit: e.target.value })} /></div>
                  <div className="fld"><label>Flag calls with quality below</label><input className="ainp" type="number" value={s.flag_quality_below} disabled={!can('settings.update')} onChange={(e) => setSettings({ ...s, flag_quality_below: e.target.value })} /></div>
                </div>
                {can('settings.update') ? <button className="btn primary" disabled={busy || !settings} onClick={() => run(() => api.put('/call-intel/settings', settings), 'Settings saved').then(() => setSettings(null))} data-testid="ci-save-settings"><Ic k="save" />Save settings</button> : null}
                <div className="fhint" style={{ marginTop: 8 }}>Provider and key: Administration › Settings › Channels › Speech-to-text ({st.data?.stt?.configured ? `active: ${String(st.data.stt.provider).replace('_', ' ')}` : 'not set up yet'}).</div>
              </>
            ) : <div className="empty-note">Loading…</div>}
          </div></div>
      </div>
      <div style={{ height: 12 }} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        {[['', 'All'], ['pending,processing', 'Waiting'], ['done', 'Done'], ['failed', 'Failed'], ['skipped', 'No speech']].map(([v, l]) => <button key={v} className={`btn sm${status === v ? ' primary' : ''}`} onClick={() => setStatus(v)}>{l}</button>)}
      </div>
      <TableCard title="Transcription queue" icon="doc" listKey="ciQueue"
        more={<ListActions onExport={() => downloadObjectsCsv('transcription-queue.csv', queue.data ?? [])} onRefresh={queue.reload} />}
        cols={['Call', 'Counsellor', 'Status', 'Provider', 'Length', 'Preview', '']}
        empty="Nothing in the queue yet."
        rows={(queue.data ?? []).map((r): Cell[] => [
          { node: <div><b>{r.lead_name ?? '—'}</b><div className="sub">{dtt(r.call_at ?? r.created_at)}{r.source === 'paste' ? ' · pasted' : ''}</div></div> },
          r.user_name ?? '—', { node: <span><span className={`bdg ${(T_STATUS[r.status] ?? ['', 'b-gray'])[1]}`}>{(T_STATUS[r.status] ?? [r.status])[0]}</span>{r.error ? <div className="sub" style={{ color: 'var(--danger)' }}>{r.error}</div> : null}</span> },
          [r.provider, r.language].filter(Boolean).join(' · ') || '—', mmss(r.duration_s), { node: <span className="sub">{r.preview ?? ''}</span> },
          { node: <div className="rowacts">
            {r.insight_id ? <button className="btn sm" onClick={() => setOpen(Number(r.insight_id))}><Ic k="eye" />Insight</button> : null}
            {can('ai.run') && r.status === 'failed' && r.recording_id ? <button className="btn sm" onClick={() => run(() => api.post(`/call-intel/transcripts/${r.id}/retry`, {}), 'Queued again')}><Ic k="refresh" />Retry</button> : null}
            {can('ai.run') && r.status === 'done' && !r.insight_id ? <button className="btn sm" onClick={() => run(() => api.post(`/call-intel/transcripts/${r.id}/analyse`, {}), 'Analysed')}><Ic k="bolt" />Analyse</button> : null}
          </div> },
        ])} />
      {(rec.data ?? []).length ? (
        <>
          <div style={{ height: 12 }} />
          <TableCard title="Recordings not transcribed" icon="calls"
            cols={['Recording', 'Lead', 'Counsellor', 'Length', '']}
            rows={(rec.data ?? []).map((r): Cell[] => [
              { node: <div><b>{r.file_name ?? `#${r.id}`}</b><div className="sub">{dtt(r.created_at)}</div></div> }, r.lead_name ?? '—', r.user_name ?? '—', mmss(r.duration_s),
              { node: can('ai.run') ? <button className="btn sm" onClick={() => run(() => api.post(`/call-intel/recordings/${r.id}/transcribe`, {}), 'Queued')}><Ic k="plus" />Transcribe</button> : '' },
            ])} />
        </>
      ) : null}
      {open ? <InsightModal id={open} onClose={() => setOpen(null)} onChanged={bump} /> : null}
    </>
  );
}

/* ========================================================== Call Summaries */

export function CallSummaries() {
  const f = useCiFilters();
  const { data, reload } = useFetch<any[]>(`/call-intel/insights?${f.qs}`, [f.qs]);
  const [open, setOpen] = useState<number | null>(null);
  const rows = data ?? [];
  return (
    <>
      <CiBanner />
      <CiFilterBar f={f} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}><ListActions onExport={() => downloadObjectsCsv('call-summaries.csv', csv(rows))} onRefresh={reload} /></div>
      {rows.length === 0 ? <div className="empty-note">No call summaries match.</div> : rows.map((r) => (
        <div key={r.id} className="card" style={{ padding: 12, marginBottom: 8 }} data-testid={`ci-summary-${r.id}`}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{r.lead_name ?? '—'}</b><span className="sub">{r.user_name ?? '—'} · {dtt(r.call_at)}</span>
            <span className={`bdg ${(SENT[r.sentiment] ?? ['', 'b-gray'])[1]}`}>{(SENT[r.sentiment] ?? [r.sentiment ?? '—'])[0]}</span>
            {r.quality_score != null ? <span className="bdg b-indigo">{r.quality_score}/100</span> : null}
            <span style={{ flex: 1 }} /><button className="btn sm" onClick={() => setOpen(Number(r.id))}><Ic k="eye" />Open</button>
          </div>
          <div style={{ marginTop: 6 }}>{r.summary ?? '—'}</div>
          {r.follow_up ? <div className="sub" style={{ marginTop: 4 }}><b>Next:</b> {r.follow_up}</div> : null}
        </div>
      ))}
      {open ? <InsightModal id={open} onClose={() => setOpen(null)} onChanged={reload} /> : null}
    </>
  );
}
