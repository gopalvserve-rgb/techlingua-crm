/**
 * AI COMMUNICATION INTELLIGENCE — the AI Insights screen (ERP Batch 4).
 *
 * Credential-gated AI over the text that exists (telephony is OUT of scope): paste/upload a
 * transcript OR pick a lead/student, then run Summary / Sentiment / Quality / Transcription
 * via the configured DeepSeek or Gemini key. Results are saved to ai_analysis and shown; the
 * analyses list carries the FULL list treatment (filters · export · column-chooser · refresh
 * · bulk-delete). With NO key everything degrades to a clean "AI not configured" state — the
 * run button is disabled and the banner points the admin to Settings, never a 500.
 *
 * Follows the existing design system — banner / kpi strip / filters / TableCard / add-modal.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';

const TYPE_LABEL: Record<string, string> = {
  summary: 'Summary', sentiment: 'Sentiment', quality: 'Quality', transcription: 'Transcription',
};
const dt = (v: unknown) => (v ? new Date(String(v)).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

const typeBadge = (t: string): Cell => {
  const map: Record<string, [string, string]> = {
    summary: ['Summary', 'b-indigo'], sentiment: ['Sentiment', 'b-amber'],
    quality: ['Quality', 'b-green'], transcription: ['Transcription', 'b-gray'],
  };
  const [l, c] = map[t] ?? [t, 'b-gray'];
  return { b: [l, c] };
};
const sentimentBadge = (s: string | null): Cell => {
  if (!s) return '—' as unknown as Cell;
  const map: Record<string, string> = { positive: 'b-green', neutral: 'b-gray', negative: 'b-rose' };
  return { b: [s[0].toUpperCase() + s.slice(1), map[s] ?? 'b-gray'] };
};
const qualityCell = (q: number | null): Cell =>
  q == null ? ('—' as unknown as Cell) : { b: [`${q}/100`, q >= 75 ? 'b-green' : q >= 50 ? 'b-amber' : 'b-rose'] };

/* --------------------------------------------------------- not-configured banner */

export function AiStatusBanner({ status }: { status: any }) {
  if (!status) return null;
  if (status.configured) {
    const on = (status.providers ?? []).filter((p: any) => p.configured).map((p: any) => p.label).join(' + ');
    return (
      <div className="notice" style={{ borderColor: 'var(--success)' }}>
        <Ic k="bolt" /><div>AI is live on <b>{on}</b>. Analyses run on your configured key.</div>
      </div>
    );
  }
  return (
    <div className="notice" data-testid="ai-not-configured">
      <Ic k="bolt" />
      <div>
        <b>AI is not configured.</b> Add a DeepSeek or Gemini API key in <b>Administration › Settings › Channels › AI</b> to
        switch on summaries, sentiment and quality scoring. Until then you can still store pasted transcripts.
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- detail modal */

function AnalysisDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { data } = useFetch<any>(`/ai/analyses/${id}`);
  const a = data;
  if (!a) return null;
  const o = a.output ?? {};
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 720 }}>
        <div className="ah">
          <h3><Ic k="intel" />{TYPE_LABEL[a.analysis_type] ?? a.analysis_type} · {a.subject_label ?? 'Transcript'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="sub" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 10 }}>
            <span>Type: <b>{TYPE_LABEL[a.analysis_type]}</b></span>
            {a.provider ? <span>Model: <b>{a.provider} · {a.model}</b></span> : <span>Stored transcript</span>}
            {a.sentiment ? <span>Sentiment: <b>{a.sentiment}</b></span> : null}
            {a.quality_score != null ? <span>Quality: <b>{a.quality_score}/100</b></span> : null}
            <span>By: <b>{a.created_by_name ?? '—'}</b></span>
            <span>{dt(a.created_at)}</span>
          </div>

          {a.analysis_type === 'summary' && (
            <div className="card"><div className="card-pad">
              <div style={{ whiteSpace: 'pre-wrap' }}>{o.summary ?? a.summary_text ?? '—'}</div>
              {Array.isArray(o.key_points) && o.key_points.length ? (
                <div style={{ marginTop: 10 }}><b>Key points</b><ul>{o.key_points.map((k: string, i: number) => <li key={i}>{k}</li>)}</ul></div>
              ) : null}
              {Array.isArray(o.next_steps) && o.next_steps.length ? (
                <div><b>Next steps</b><ul>{o.next_steps.map((k: string, i: number) => <li key={i}>{k}</li>)}</ul></div>
              ) : null}
            </div></div>
          )}
          {a.analysis_type === 'sentiment' && (
            <div className="card"><div className="card-pad">
              <div>Sentiment: <b>{o.sentiment ?? a.sentiment}</b>{o.score != null ? ` (score ${o.score})` : ''}</div>
              <div className="sub" style={{ marginTop: 6 }}>{o.rationale ?? a.summary_text ?? ''}</div>
            </div></div>
          )}
          {a.analysis_type === 'quality' && (
            <div className="card"><div className="card-pad">
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Quality score: {o.total ?? a.quality_score}/100</div>
              {o.criteria ? (
                <div className="sub" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {Object.entries(o.criteria).map(([k, v]) => <span key={k}>{k.replace(/_/g, ' ')}: <b>{String(v)}</b></span>)}
                </div>
              ) : null}
              {o.notes ? <div style={{ marginTop: 8 }}>{o.notes}</div> : null}
            </div></div>
          )}
          {a.analysis_type === 'transcription' && (
            <div className="card"><div className="card-pad">
              <div style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{o.transcript ?? a.input_text ?? '—'}</div>
            </div></div>
          )}

          {a.input_text && a.analysis_type !== 'transcription' ? (
            <details style={{ marginTop: 10 }}>
              <summary className="sub">Input analysed</summary>
              <div className="sub" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 220, overflow: 'auto' }}>{a.input_text}</div>
            </details>
          ) : null}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- run panel */

function RunPanel({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const [subjectMode, setSubjectMode] = useState<'transcript' | 'lead' | 'student'>('transcript');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ id: number; label: string } | null>(null);
  const [type, setType] = useState<'summary' | 'sentiment' | 'quality' | 'transcription'>('summary');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const subj = useFetch<any[]>(subjectMode === 'transcript' || !q ? '' : `/ai/subjects?type=${subjectMode}&q=${encodeURIComponent(q)}`, [subjectMode, q]);

  const run = async () => {
    setBusy(true); setResult(null);
    try {
      const body: any = { analysis_type: type, subject_type: subjectMode };
      if (subjectMode !== 'transcript') {
        if (!picked) { toast('Pick a lead/student first, or switch to Paste transcript', true); setBusy(false); return; }
        body.subject_id = picked.id;
      }
      if (text.trim()) body.input_text = text.trim();
      const r = await api.post<any>('/ai/analyze', body);
      setResult(r);
      toast(`${TYPE_LABEL[type]} generated`);
      onDone();
    } catch (e: any) {
      if (e?.status === 503) toast('AI not configured — add a DeepSeek/Gemini key in Settings › Channels › AI', true);
      else toast(e.message, true);
    } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}><div className="card-pad">
      <div style={{ fontWeight: 700, marginBottom: 8 }}><Ic k="bolt" /> Run an analysis</div>
      <div className="filters" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <select className="ainp" value={subjectMode} onChange={(e) => { setSubjectMode(e.target.value as any); setPicked(null); setQ(''); }}>
          <option value="transcript">Paste / upload transcript</option>
          <option value="lead">Pick a lead (use its notes)</option>
          <option value="student">Pick a student</option>
        </select>
        <select className="ainp" value={type} onChange={(e) => setType(e.target.value as any)}>
          <option value="summary">Summary</option>
          <option value="sentiment">Sentiment</option>
          <option value="quality">Quality monitoring</option>
          <option value="transcription">Transcription (store transcript)</option>
        </select>
        {subjectMode !== 'transcript' && (
          <input className="ainp" style={{ width: 220 }} placeholder={`Search ${subjectMode}…`}
            value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); }} />
        )}
      </div>

      {subjectMode !== 'transcript' && q && (
        <div className="card" style={{ marginBottom: 8 }}><div className="card-pad" style={{ maxHeight: 160, overflow: 'auto' }}>
          {(subj.data ?? []).length === 0 ? <div className="sub">No matches.</div> : (subj.data ?? []).map((s) => (
            <button key={s.id} className={`fchip${picked?.id === s.id ? ' on' : ''}`} style={{ margin: 3 }}
              onClick={() => setPicked({ id: s.id, label: s.label })}>{s.label}{s.ref ? ` · ${s.ref}` : ''}</button>
          ))}
        </div></div>
      )}
      {picked && <div className="sub" style={{ marginBottom: 8 }}>Selected: <b>{picked.label}</b></div>}

      <textarea className="ainp" rows={5}
        placeholder={subjectMode === 'lead' ? 'Optional — leave blank to analyse the lead’s notes & timeline, or paste a call/chat transcript here.' : 'Paste or type the call / chat transcript to analyse…'}
        value={text} onChange={(e) => setText(e.target.value)} />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        {!configured && type !== 'transcription' && (
          <span className="sub" style={{ color: 'var(--danger)' }}>AI key not configured — add one in Settings to run this.</span>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || (!configured && type !== 'transcription')} onClick={run}>
          <Ic k="bolt" />{busy ? 'Running…' : `Run ${TYPE_LABEL[type]}`}
        </button>
      </div>

      {result && (
        <div className="card" style={{ marginTop: 10, background: 'var(--primary-soft)' }}><div className="card-pad">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{TYPE_LABEL[result.analysis_type]} result</div>
          {result.analysis_type === 'summary' && <div style={{ whiteSpace: 'pre-wrap' }}>{result.output?.summary ?? result.summary_text}</div>}
          {result.analysis_type === 'sentiment' && <div>Sentiment: <b>{result.sentiment}</b> — {result.output?.rationale ?? ''}</div>}
          {result.analysis_type === 'quality' && <div>Quality: <b>{result.quality_score}/100</b> — {result.output?.notes ?? ''}</div>}
          {result.analysis_type === 'transcription' && <div className="sub">Transcript stored ({(result.output?.transcript ?? '').length} chars).</div>}
        </div></div>
      )}
    </div></div>
  );
}

/* --------------------------------------------------------------------- screen */

export function AiIntelligence() {
  const { can } = useAuth();
  const ref = useRef_();
  const [tick, setTick] = useState(0);
  const after = () => setTick((t) => t + 1);

  const status = useFetch<any>('/ai/status', [tick]);
  const summary = useFetch<any>('/ai/summary', [tick]);
  const configured = !!status.data?.configured;

  const [f, setF] = useState<Record<string, string>>({ analysis_type: '', sentiment: '', subject_type: '', branch_id: '', vertical_id: '', owner_id: '', q: '' });
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    return p.toString();
  }, [f]);
  const listPath = '/ai/analyses' + (qs ? `?${qs}` : '');
  const list = useFetch<any[]>(listPath, [qs, tick]);
  const rows = list.data ?? [];
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const [detail, setDetail] = useState<number | null>(null);

  const ids = rows.map((r) => r.id as number);
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('AI analysis', '/ai/analyses/bulk-delete/impact', '/ai/analyses/bulk-delete', () => { after(); clear(); });

  const del = async (r: any) => {
    if (!window.confirm('Delete this AI analysis?')) return;
    try { await api.del(`/ai/analyses/${r.id}`); toast('Analysis deleted'); after(); }
    catch (e) { toast((e as Error).message, true); }
  };

  const s = summary.data?.counts ?? {};

  return (
    <>
      <AiStatusBanner status={status.data} />

      <Kpis cols={5} items={[
        { lab: 'Total analyses', val: String(s.total ?? 0), ic: 'intel' },
        { lab: 'Summaries', val: String(s.summaries ?? 0), ic: 'doc' },
        { lab: 'Positive sentiment', val: String(s.positive ?? 0), ic: 'check' },
        { lab: 'Negative sentiment', val: String(s.negative ?? 0), ic: 'bolt' },
        { lab: 'Avg quality', val: s.avg_quality != null ? `${s.avg_quality}/100` : '—', ic: 'perf' },
      ]} />

      {can('ai.run') && <RunPanel configured={configured} onDone={after} />}

      <div className="filters" style={{ margin: '12px 0', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <input className="ainp" style={{ width: 200 }} placeholder="Search subject / summary…"
          value={f.q} onChange={(e) => set('q', e.target.value)} />
        <select className="ainp" value={f.analysis_type} onChange={(e) => set('analysis_type', e.target.value)}>
          <option value="">All types</option>
          {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className="ainp" value={f.sentiment} onChange={(e) => set('sentiment', e.target.value)}>
          <option value="">Any sentiment</option>
          <option value="positive">Positive</option>
          <option value="neutral">Neutral</option>
          <option value="negative">Negative</option>
        </select>
        <select className="ainp" value={f.subject_type} onChange={(e) => set('subject_type', e.target.value)}>
          <option value="">Any subject</option>
          <option value="lead">Lead</option>
          <option value="student">Student</option>
          <option value="transcript">Transcript</option>
        </select>
        <select className="ainp" value={f.branch_id} onChange={(e) => set('branch_id', e.target.value)}>
          <option value="">All branches</option>
          {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select className="ainp" value={f.vertical_id} onChange={(e) => set('vertical_id', e.target.value)}>
          <option value="">All verticals</option>
          {ref.verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select className="ainp" value={f.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
          <option value="">Any owner</option>
          {ref.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>

      <BulkBar count={count} entityLabel="AI analysis" onDelete={() => openBulk(selected)} onClear={clear} />

      <TableCard
        listKey="aiAnalyses"
        title="AI analyses" icon="intel"
        cols={['Subject', 'Type', 'Sentiment', 'Quality', 'Summary', 'Provider', 'Branch', 'Owner', 'By', 'When', '']}
        empty="No AI analyses yet — run one above (paste a transcript or pick a lead)."
        select={can('ai.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('ai-analyses.csv', rows.map((r: any) => ({
          subject: r.subject_label, type: r.analysis_type, sentiment: r.sentiment, quality: r.quality_score,
          summary: r.summary_text, provider: r.provider, branch: r.branch_name, owner: r.owner_name,
          created_by: r.created_by_name, created_at: r.created_at,
        })))} onRefresh={after} />}
        onRowClick={(i) => setDetail(rows[i].id)}
        rows={rows.map((r): Cell[] => [
          { node: <div><b>{r.subject_label ?? 'Transcript'}</b><div className="sub">{r.subject_type}</div></div> },
          typeBadge(r.analysis_type),
          sentimentBadge(r.sentiment),
          qualityCell(r.quality_score),
          { node: <span className="sub" style={{ display: 'block', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.summary_text ?? '—'}</span> },
          r.provider ? `${r.provider}` : '—',
          r.branch_name ?? '—',
          r.owner_name ?? '—',
          r.created_by_name ?? '—',
          dt(r.created_at),
          {
            node: (
              <div className="rowacts" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn sm" title="Open" onClick={() => setDetail(r.id)}><Ic k="eye" /></button>
                {can('ai.delete') && <button className="icon-btn sm" title="Delete" onClick={() => del(r)}><Ic k="trash" /></button>}
              </div>
            ),
          },
        ])}
      />

      {bulkModal}
      {detail != null && <AnalysisDetail id={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

/* ---------------------------------------------- dashboard AI Insights panel (real) */

/**
 * The dashboard "AI Insights" card — REAL now. When a key is configured it shows the latest
 * analyses; otherwise a clean not-configured state (never a fake insight). Replaces the old
 * "switches on with the Gemini key (Phase 2)" empty shell.
 */
export function DashAiInsights({ go }: { go?: (m: string, s: string) => void }) {
  const { data } = useFetch<any>('/ai/summary');
  const configured = !!data?.configured;
  const recent: any[] = data?.recent ?? [];
  const providers = (data?.providers ?? []).filter((p: any) => p.configured).map((p: any) => p.label).join(' + ');
  return (
    <div className="card" style={{ background: 'linear-gradient(150deg,var(--primary-soft),var(--accent-soft))' }}>
      <div className="card-head">
        <h3><Ic k="intel" />AI Insights</h3>
        <span className={`bdg ${configured ? 'b-green' : 'b-indigo'}`}>{configured ? providers : 'Not configured'}</span>
      </div>
      {!configured ? (
        <div className="empty-note" data-testid="dash-ai-not-configured">
          AI insights switch on once a DeepSeek or Gemini key is added in Settings › Channels › AI.
          {go && <> <a onClick={() => go('intel', 'aiintel')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Open AI Insights</a>.</>}
        </div>
      ) : recent.length === 0 ? (
        <div className="empty-note">No analyses yet. {go && <a onClick={() => go('intel', 'aiintel')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Run one</a>}.</div>
      ) : (
        <div style={{ padding: '4px 12px 12px' }}>
          {recent.slice(0, 4).map((r) => (
            <div key={r.id} style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}>
              <div className="sub" style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                <b>{r.subject_label ?? 'Transcript'}</b>
                <span>{TYPE_LABEL[r.analysis_type] ?? r.analysis_type}{r.quality_score != null ? ` · ${r.quality_score}/100` : ''}{r.sentiment ? ` · ${r.sentiment}` : ''}</span>
              </div>
              {r.summary_text ? <div className="sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.summary_text}</div> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
