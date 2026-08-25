/**
 * ASSESSMENTS — Batch A UI: the QUESTION BANK (Students & Academics › Assessments).
 *
 * Two screens, each with the FULL list treatment (multi-select FilterMulti/EnumMulti, Export
 * showing names-not-ids, TableCard column chooser, Refresh, bulk-delete):
 *   · QuestionBankScreen      — the question bank + add/edit form for EVERY q_type (options
 *                               editor for objective types, image/audio upload to R2 via a
 *                               presigned PUT, YouTube embed fields with a live preview iframe,
 *                               subjective types show just the prompt + explanation) + CSV import.
 *   · QuestionCategoriesScreen — the subject/topic taxonomy (small list + add/edit).
 *
 * MEDIA RULE: images/audio go to Cloudflare R2 through the presigned-URL flow; the row stores
 * only the r2_key. YouTube "video" questions store the URL/id + start/end seconds — never a file.
 * India-first, scope-aware. RBAC question.* / question_category.*.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { MasterQuickAdd } from './forms';
import { rowActions, ConfirmModal, DetailModal, Section, KV, fmtFull } from './rowactions';
import { useScope } from './scope';
import { FilterMulti, EnumMulti } from './dyn';
import { DateRange } from './daterange';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';

/* ------------------------------------------------------------------ shared ---- */

export const Q_TYPE_GROUPS: Array<{ group: string; types: Array<[string, string]> }> = [
  { group: 'Objective', types: [
    ['mcq_single', 'MCQ (single answer)'], ['mcq_multi', 'MCQ (multiple answers)'], ['true_false', 'True / False'],
    ['fill_blank', 'Fill in the blank'], ['match_following', 'Match the following'],
    ['image_mcq', 'Image MCQ'], ['audio_mcq', 'Audio MCQ'], ['video_mcq', 'Video MCQ (YouTube)'],
  ] },
  { group: 'Subjective', types: [
    ['short_answer', 'Short answer'], ['long_answer', 'Long answer'], ['essay', 'Essay'],
    ['case_study', 'Case study'], ['coding', 'Coding'], ['practical', 'Practical'],
  ] },
  { group: 'Language', types: [
    ['reading', 'Reading'], ['listening', 'Listening'], ['speaking', 'Speaking'],
    ['translation', 'Translation'], ['vocabulary', 'Vocabulary'], ['grammar', 'Grammar'], ['writing', 'Writing'],
  ] },
];
const Q_TYPE_LABEL: Record<string, string> = Object.fromEntries(Q_TYPE_GROUPS.flatMap((g) => g.types));
const Q_TYPE_OPTS = Q_TYPE_GROUPS.flatMap((g) => g.types).map(([id, name]) => ({ id, name }));
const OBJECTIVE = new Set(['mcq_single', 'mcq_multi', 'true_false', 'image_mcq', 'audio_mcq', 'video_mcq', 'match_following']);
const DIFF_OPTS = [{ id: 'easy', name: 'Easy' }, { id: 'medium', name: 'Medium' }, { id: 'hard', name: 'Hard' }];
const DIFF_BADGE: Record<string, string> = { easy: 'b-green', medium: 'b-amber', hard: 'b-rose' };
const asOpts = (vals: string[]) => vals.map((v) => ({ id: v, name: v }));

/** Extract an 11-char YouTube video id from a full URL or a bare id. */
function youtubeId(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|\/embed\/|youtu\.be\/|\/v\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function youtubeEmbed(url?: string | null, start?: number | null, end?: number | null): string | null {
  const id = youtubeId(url);
  if (!id) return null;
  const p = new URLSearchParams();
  if (start != null && Number(start) > 0) p.set('start', String(Math.trunc(Number(start))));
  if (end != null && Number(end) > 0) p.set('end', String(Math.trunc(Number(end))));
  return `https://www.youtube.com/embed/${id}${p.toString() ? `?${p}` : ''}`;
}

/** Upload a file straight to R2 via a presigned PUT; returns the r2_key. */
async function uploadToR2(file: File): Promise<string> {
  const { url, r2_key } = await api.post<{ url: string; r2_key: string }>('/questions/upload-url', {
    kind: 'question', file_name: file.name, content_type: file.type || 'application/octet-stream',
  });
  const res = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return r2_key;
}

/* ============================================================ QUESTION BANK === */
export function QuestionBankScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fCat, setFCat] = useState<number[]>([]);
  const [fType, setFType] = useState<string[]>([]);
  const [fDiff, setFDiff] = useState<string[]>([]);
  const [fLang, setFLang] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [imp, setImp] = useState(false);
  const after = () => setTick((t) => t + 1);

  const cats = useFetch<any[]>('/question-categories', [tick]);
  const catOpts = (cats.data ?? []).map((c: any) => ({ id: c.id, name: c.parent_name ? `${c.parent_name} › ${c.name}` : c.name }));

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fCat.length) qs.set('category_id', fCat.join(','));
  if (fType.length) qs.set('q_type', fType.join(','));
  if (fDiff.length) qs.set('difficulty', fDiff.join(','));
  if (fLang.length) qs.set('language', fLang.join(','));
  if (q) qs.set('q', q);
  const list = useFetch<any[]>(`/questions?${qs.toString()}`, [qs.toString(), tick]);
  const summary = useFetch<any>('/questions/summary', [tick]);
  const rows = list.data ?? [];
  const langs = Array.from(new Set(rows.map((r: any) => r.language).filter(Boolean))) as string[];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Question', '/questions/bulk-delete/impact', '/questions/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/questions/${del.id}`); toast('Question deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };
  const s = summary.data;
  const mediaTag = (r: any) => r.has_video ? 'Video' : r.has_image ? 'Image' : r.has_audio ? 'Audio' : '—';

  return (
    <>
      <div className="page-actions" style={{ display: 'flex', gap: 8 }}>
        {can('question.import') && <button className="btn" onClick={() => setImp(true)}><Ic k="export" />Import CSV</button>}
        {can('question.create') && <button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />Add question</button>}
      </div>
      <Kpis items={[
        { lab: 'Questions', val: String(s?.total ?? 0), ic: 'doc' },
        { lab: 'Active', val: String(s?.active ?? 0), ic: 'check' },
        { lab: 'Easy', val: String(s?.easy ?? 0), ic: 'shield' },
        { lab: 'Medium / Hard', val: `${s?.medium ?? 0} / ${s?.hard ?? 0}`, ic: 'bolt' },
      ]} />
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
        <FilterMulti label="Category" icon="doc" value={fCat} options={catOpts} onChange={setFCat} />
        <EnumMulti label="Type" icon="list" value={fType} options={Q_TYPE_OPTS} onChange={setFType} />
        <EnumMulti label="Difficulty" icon="bolt" value={fDiff} options={DIFF_OPTS} onChange={setFDiff} />
        <EnumMulti label="Language" icon="grid" value={fLang} options={asOpts(langs)} onChange={setFLang} />
        <label className="fchip"><Ic k="search" /><input placeholder="Search text / tags" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
      </div>
      <BulkBar count={count} entityLabel="Question" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Question Bank" icon="doc"
        select={can('question.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('questions.csv', rows.map((r: any) => ({
          question: r.body, category: r.category_name, type: Q_TYPE_LABEL[r.q_type] ?? r.q_type, difficulty: r.difficulty,
          marks: r.marks, negative_marks: r.negative_marks, language: r.language, media: mediaTag(r),
          options: r.option_count, branch: r.branch_name, vertical: r.vertical_name, active: r.active ? 'Yes' : 'No',
        })))} onRefresh={after} />}
        cols={['Question', 'Category', 'Type', 'Difficulty', 'Marks', 'Language', 'Media', 'Active', 'Actions']}
        empty="No questions yet — add your first, or import a CSV."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{String(r.body).slice(0, 90)}{String(r.body).length > 90 ? '…' : ''}</b>{r.tags?.length ? <div className="sub">{r.tags.slice(0, 4).map((t: string) => `#${t}`).join(' ')}</div> : null}</div> } as Cell,
          r.category_name ?? '—',
          { b: [Q_TYPE_LABEL[r.q_type] ?? r.q_type, 'b-indigo'] } as Cell,
          { b: [r.difficulty, DIFF_BADGE[r.difficulty] ?? 'b-gray'] } as Cell,
          String(r.marks),
          r.language ?? '—',
          mediaTag(r),
          { b: [r.active ? 'Active' : 'Inactive', r.active ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({ onView: () => setView(r), onEdit: can('question.update') ? () => setEdit(r) : undefined, onDelete: can('question.delete') ? () => setDel(r) : undefined }),
        ])} />
      {edit && <QuestionForm q={edit} rd={rd} catOpts={catOpts} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); after(); }} />}
      {view && <QuestionDetail id={view.id} onClose={() => setView(null)} />}
      {del && <ConfirmModal title="Delete question?" body={`Delete this ${Q_TYPE_LABEL[del.q_type] ?? del.q_type} question?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {imp && <ImportModal onClose={() => setImp(false)} onDone={() => { setImp(false); after(); }} />}
      {bulkModal}
    </>
  );
}

function QuestionDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const d = useFetch<any>(`/questions/${id}`, [id]);
  const e = d.data;
  if (!e) return <DetailModal title="Question" icon="doc" onClose={onClose}><div className="empty-note">Loading…</div></DetailModal>;
  const embed = youtubeEmbed(e.youtube_url, e.youtube_start_sec, e.youtube_end_sec);
  return (
    <DetailModal title={Q_TYPE_LABEL[e.q_type] ?? e.q_type} icon="doc" width={680} onClose={onClose}>
      <Section title="Question"><div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{e.body}</div></Section>
      <Section title="Details"><KV rows={[
        ['Category', e.category_name ?? '—'], ['Difficulty', e.difficulty], ['Marks', `${e.marks} (−${e.negative_marks})`],
        ['Language', e.language ?? '—'], ['Placement', `${e.branch_name ?? '—'}${e.vertical_name ? ' › ' + e.vertical_name : ''}`],
        ['Status', e.active ? 'Active' : 'Inactive'],
      ]} /></Section>
      {e.image_url ? <Section title="Image"><img src={e.image_url} alt="question" style={{ maxWidth: '100%', borderRadius: 8 }} /></Section> : null}
      {e.audio_url ? <Section title="Audio"><audio controls src={e.audio_url} style={{ width: '100%' }} /></Section> : null}
      {embed ? <Section title="Video"><div style={{ position: 'relative', paddingTop: '56%' }}><iframe title="yt" src={embed} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, borderRadius: 8 }} allowFullScreen /></div></Section> : null}
      {e.options?.length ? <Section title="Options"><div style={{ display: 'grid', gap: 6 }}>
        {e.options.map((o: any) => (
          <div key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <span className={`bdg ${o.is_correct ? 'b-green' : 'b-gray'}`}>{o.is_correct ? '✓' : '·'}</span>
            <span>{o.body}{o.match_key ? ` → ${o.match_key}` : ''}</span>
            {o.image_url ? <img src={o.image_url} alt="opt" style={{ height: 34, borderRadius: 4 }} /> : null}
          </div>
        ))}
      </div></Section> : null}
      {e.explanation ? <Section title="Explanation"><div style={{ fontSize: 13 }}>{e.explanation}</div></Section> : null}
    </DetailModal>
  );
}

function QuestionForm({ q, rd, catOpts, onClose, onSaved }: { q: any; rd: any; catOpts: any[]; onClose: () => void; onSaved: () => void }) {
  const isNew = !q?.id;
  const [loaded, setLoaded] = useState(!q?.id);
  const [f, setF] = useState<any>({
    q_type: q.q_type ?? 'mcq_single', difficulty: q.difficulty ?? 'medium', marks: q.marks ?? 1, negative_marks: q.negative_marks ?? 0,
    body: q.body ?? '', category_id: q.category_id ?? '', branch_id: q.branch_id ?? '', vertical_id: q.vertical_id ?? '',
    language: q.language ?? '', explanation: q.explanation ?? '', tags: (q.tags ?? []).join(', '),
    image_r2_key: q.image_r2_key ?? null, audio_r2_key: q.audio_r2_key ?? null,
    youtube_url: q.youtube_url ?? '', youtube_start_sec: q.youtube_start_sec ?? '', youtube_end_sec: q.youtube_end_sec ?? '',
    active: q.active !== false,
  });
  const [opts, setOpts] = useState<any[]>([{ body: '', is_correct: false }, { body: '', is_correct: false }]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const isObjective = OBJECTIVE.has(f.q_type);
  const isMatch = f.q_type === 'match_following';

  // Load the full question (options + presigned media) when editing.
  useEffect(() => {
    if (!q?.id) return;
    api.get<any>(`/questions/${q.id}`).then((full) => {
      setOpts((full.options ?? []).length ? full.options.map((o: any) => ({ body: o.body, is_correct: o.is_correct, ordering: o.ordering, match_key: o.match_key, image_r2_key: o.image_r2_key, image_url: o.image_url })) : [{ body: '', is_correct: false }, { body: '', is_correct: false }]);
      setImageUrl(full.image_url ?? null); setAudioUrl(full.audio_url ?? null);
      setLoaded(true);
    }).catch((e) => { toast(e.message, true); setLoaded(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const vOpts = rd.verticals.filter((v: any) => !f.branch_id || Number(v.branch_id) === Number(f.branch_id));
  const embed = youtubeEmbed(f.youtube_url, f.youtube_start_sec, f.youtube_end_sec);

  const upload = async (file: File | undefined, target: 'image' | 'audio' | number) => {
    if (!file) return;
    setUploading(String(target));
    try {
      const key = await uploadToR2(file);
      const localUrl = URL.createObjectURL(file);
      if (target === 'image') { set('image_r2_key', key); setImageUrl(localUrl); }
      else if (target === 'audio') { set('audio_r2_key', key); setAudioUrl(localUrl); }
      else { setOpts((p) => p.map((o, i) => i === target ? { ...o, image_r2_key: key, image_url: localUrl } : o)); }
      toast('Uploaded to storage');
    } catch (e: any) { toast(e.message, true); } finally { setUploading(''); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        q_type: f.q_type, difficulty: f.difficulty, marks: Number(f.marks), negative_marks: Number(f.negative_marks),
        body: f.body, category_id: f.category_id ? Number(f.category_id) : null,
        branch_id: f.branch_id ? Number(f.branch_id) : null, vertical_id: f.vertical_id ? Number(f.vertical_id) : null,
        language: f.language || null, explanation: f.explanation || null,
        tags: String(f.tags).split(',').map((t: string) => t.trim()).filter(Boolean),
        image_r2_key: f.image_r2_key || null, audio_r2_key: f.audio_r2_key || null,
        youtube_url: f.youtube_url || null,
        youtube_start_sec: f.youtube_start_sec === '' ? null : Number(f.youtube_start_sec),
        youtube_end_sec: f.youtube_end_sec === '' ? null : Number(f.youtube_end_sec),
        active: f.active,
        options: isObjective ? opts.filter((o) => (o.body ?? '').trim() || o.image_r2_key || o.match_key) : [],
      };
      if (isNew) await api.post('/questions', body); else await api.patch(`/questions/${q.id}`, body);
      toast(isNew ? 'Question created' : 'Question updated'); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  return (
    <DetailModal title={isNew ? 'Add question' : 'Edit question'} icon="doc" width={780} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy || !loaded}><Ic k="check" />Save</button></div>}>
      {!loaded ? <div className="empty-note">Loading…</div> : <>
      <Section title="Type & classification"><div className="form-grid">
        <div className="fld"><label>Question type *</label><select className="ainp" value={f.q_type} onChange={(e) => set('q_type', e.target.value)}>
          {Q_TYPE_GROUPS.map((g) => <optgroup key={g.group} label={g.group}>{g.types.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</optgroup>)}
        </select></div>
        <div className="fld"><label>Difficulty</label><select className="ainp" value={f.difficulty} onChange={(e) => set('difficulty', e.target.value)}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div>
        <div className="fld"><label>Category</label><select className="ainp" value={f.category_id} onChange={(e) => set('category_id', e.target.value)}><option value="">—</option>{catOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="fld"><label>Language (optional)</label><input className="ainp" value={f.language} onChange={(e) => set('language', e.target.value)} placeholder="e.g. English, Hindi" /></div>
        <div className="fld"><label>Marks</label><input className="ainp" type="number" step="0.5" value={f.marks} onChange={(e) => set('marks', e.target.value)} /></div>
        <div className="fld"><label>Negative marks</label><input className="ainp" type="number" step="0.25" value={f.negative_marks} onChange={(e) => set('negative_marks', e.target.value)} /></div>
        <div className="fld"><label>Branch</label><select className="ainp" value={f.branch_id} onChange={(e) => { set('branch_id', e.target.value); set('vertical_id', ''); }}><option value="">— org-wide —</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="fld"><label>Vertical</label><select className="ainp" value={f.vertical_id} onChange={(e) => set('vertical_id', e.target.value)} disabled={!f.branch_id}><option value="">—</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
      </div></Section>

      <Section title="Question text"><div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Prompt *</label><textarea className="ainp" rows={3} value={f.body} onChange={(e) => set('body', e.target.value)} placeholder="The question as the student sees it" /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Tags (comma-separated)</label><input className="ainp" value={f.tags} onChange={(e) => set('tags', e.target.value)} placeholder="javascript, loops" /></div>
      </div></Section>

      <Section title="Media (optional — stored in Cloudflare R2)"><div className="form-grid">
        <div className="fld"><label>Image {uploading === 'image' ? '(uploading…)' : ''}</label>
          <input type="file" accept="image/*" onChange={(e) => upload(e.target.files?.[0], 'image')} />
          {imageUrl ? <img src={imageUrl} alt="q" style={{ marginTop: 6, maxHeight: 120, borderRadius: 6 }} /> : null}
        </div>
        <div className="fld"><label>Audio {uploading === 'audio' ? '(uploading…)' : ''}</label>
          <input type="file" accept="audio/*" onChange={(e) => upload(e.target.files?.[0], 'audio')} />
          {audioUrl ? <audio controls src={audioUrl} style={{ marginTop: 6, width: '100%' }} /> : null}
        </div>
        <div className="fld"><label>YouTube URL / video id</label><input className="ainp" value={f.youtube_url} onChange={(e) => set('youtube_url', e.target.value)} placeholder="https://youtube.com/watch?v=…" /></div>
        <div className="fld"><label>Start / end (seconds)</label><div style={{ display: 'flex', gap: 6 }}>
          <input className="ainp" type="number" min={0} value={f.youtube_start_sec} onChange={(e) => set('youtube_start_sec', e.target.value)} placeholder="start" />
          <input className="ainp" type="number" min={0} value={f.youtube_end_sec} onChange={(e) => set('youtube_end_sec', e.target.value)} placeholder="end" />
        </div></div>
        {embed ? <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Preview</label>
          <div style={{ position: 'relative', paddingTop: '48%', maxWidth: 480 }}><iframe title="ytprev" src={embed} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, borderRadius: 8 }} allowFullScreen /></div>
        </div> : null}
      </div></Section>

      {isObjective ? (
        <Section title={`Options${isMatch ? ' (with match key)' : ''}`}>
          <div style={{ display: 'grid', gap: 8 }}>
            {opts.map((o, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input type={f.q_type === 'mcq_single' || f.q_type === 'true_false' ? 'radio' : 'checkbox'} name="correctopt"
                  checked={!!o.is_correct} onChange={(e) => setOpts((p) => p.map((x, j) => {
                    if (f.q_type === 'mcq_single' || f.q_type === 'true_false') return { ...x, is_correct: j === i };
                    return j === i ? { ...x, is_correct: e.target.checked } : x;
                  }))} title="Mark correct" />
                <input className="ainp" style={{ flex: 1, minWidth: 160 }} value={o.body ?? ''} placeholder={`Option ${i + 1}`} onChange={(e) => setOpts((p) => p.map((x, j) => j === i ? { ...x, body: e.target.value } : x))} />
                {isMatch ? <input className="ainp" style={{ width: 150 }} value={o.match_key ?? ''} placeholder="matches →" onChange={(e) => setOpts((p) => p.map((x, j) => j === i ? { ...x, match_key: e.target.value } : x))} /> : null}
                <label className="btn" style={{ cursor: 'pointer' }}><Ic k="doc" />img<input type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0], i)} /></label>
                {o.image_url ? <img src={o.image_url} alt="opt" style={{ height: 30, borderRadius: 4 }} /> : null}
                <button className="btn" type="button" onClick={() => setOpts((p) => p.filter((_, j) => j !== i))} disabled={opts.length <= 2}><Ic k="trash" /></button>
              </div>
            ))}
            <div><button className="btn" type="button" onClick={() => setOpts((p) => [...p, { body: '', is_correct: false }])}><Ic k="plus" />Add option</button></div>
          </div>
        </Section>
      ) : null}

      <Section title="Explanation (shown after scoring)"><div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}><textarea className="ainp" rows={2} value={f.explanation} onChange={(e) => set('explanation', e.target.value)} placeholder="Model answer / rationale (optional)" /></div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />Active</label>
      </div></Section>
      </>}
    </DetailModal>
  );
}

/* --------------------------------------------------------------- CSV import --- */
function parseCsv(text: string): any[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length);
  if (!lines.length) return [];
  const split = (line: string): string[] => {
    const out: string[] = []; let cur = ''; let inq = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inq) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inq = false; else cur += ch; }
      else if (ch === '"') inq = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out;
  };
  const headers = split(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const row: any = {};
    headers.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onFile = (file?: File) => {
    if (!file) return;
    setFileName(file.name);
    const r = new FileReader();
    r.onload = () => { try { setRows(parseCsv(String(r.result))); setReport(null); } catch (e: any) { toast(e.message, true); } };
    r.readAsText(file);
  };
  const run = async () => {
    if (!rows.length) { toast('Choose a CSV first.', true); return; }
    setBusy(true);
    try { const res = await api.post<any>('/questions/import', { rows }); setReport(res); if (res.imported) toast(`${res.imported} question(s) imported`); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title="Import questions (CSV)" icon="doc" width={640} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={onClose}>Close</button>
        {report && report.imported ? <button className="btn primary" onClick={onDone}><Ic k="check" />Done</button>
          : <button className="btn primary" onClick={run} disabled={busy || !rows.length}><Ic k="export" />Import {rows.length || ''}</button>}
      </div>}>
      <div className="empty-note" style={{ marginBottom: 10 }}>
        Columns: <b>q_type, body, category, difficulty, marks, negative_marks, language, tags</b> and for objective types
        <b> option_1…option_6</b> + <b>correct</b> (the correct option number(s), e.g. <code>2</code> or <code>1,3</code>).
        Category is matched by name or code. Unknown types/categories are reported row-by-row.
      </div>
      <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
      {fileName ? <div style={{ marginTop: 8, fontSize: 13 }}>{fileName} — <b>{rows.length}</b> row(s) parsed</div> : null}
      {report ? (
        <div className="sheet-sec" style={{ marginTop: 12 }}>
          <h5>Result: {report.imported} imported, {report.failed} failed</h5>
          {report.errors?.length ? <div style={{ maxHeight: 220, overflow: 'auto', fontSize: 12.5 }}>
            {report.errors.map((e: any, i: number) => <div key={i} style={{ color: 'var(--danger)' }}>Row {e.row}: {e.message}</div>)}
          </div> : <div className="empty-note">No errors.</div>}
        </div>
      ) : null}
    </DetailModal>
  );
}

/* ======================================================= QUESTION CATEGORIES === */
export function QuestionCategoriesScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fActive, setFActive] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fActive.length === 1) qs.set('active', fActive[0] === 'active' ? '1' : '0');
  if (q) qs.set('q', q);
  const list = useFetch<any[]>(`/question-categories?${qs.toString()}`, [qs.toString(), tick]);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Category', '/question-categories/bulk-delete/impact', '/question-categories/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/question-categories/${del.id}`); toast('Category deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('question_category.create') && <div className="page-actions"><button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />Add category</button></div>}
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
        <EnumMulti label="Status" icon="shield" value={fActive} options={[{ id: 'active', name: 'Active' }, { id: 'inactive', name: 'Inactive' }]} onChange={setFActive} />
        <label className="fchip"><Ic k="search" /><input placeholder="Search name / code" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
      </div>
      <BulkBar count={count} entityLabel="Category" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Question Categories" icon="grid"
        select={can('question_category.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('question-categories.csv', rows.map((r: any) => ({
          name: r.name, code: r.code, parent: r.parent_name, branch: r.branch_name, vertical: r.vertical_name,
          questions: r.question_count, active: r.active ? 'Yes' : 'No',
        })))} onRefresh={after} />}
        cols={['Category', 'Code', 'Parent', 'Branch', 'Vertical', 'Questions', 'Active', 'Actions']}
        empty="No categories yet — add a subject (e.g. Programming Fundamentals) or a topic."
        rows={rows.map((r: any) => [
          { node: <b className="nm">{r.name}</b> } as Cell,
          r.code ? { mono: r.code } as Cell : '—',
          r.parent_name ?? '—',
          r.branch_name ?? '—',
          r.vertical_name ?? '—',
          String(r.question_count ?? 0),
          { b: [r.active ? 'Active' : 'Inactive', r.active ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({ onEdit: can('question_category.update') ? () => setEdit(r) : undefined, onDelete: can('question_category.delete') ? () => setDel(r) : undefined }),
        ])} />
      {edit && <CategoryForm cat={edit} rd={rd} all={rows} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); after(); }} />}
      {del && <ConfirmModal title="Delete category?" body={`Delete "${del.name}"? Questions keep their content; only the category link is cleared.`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function CategoryForm({ cat, rd, all, onClose, onSaved }: { cat: any; rd: any; all: any[]; onClose: () => void; onSaved: () => void }) {
  const isNew = !cat?.id;
  const [f, setF] = useState<any>({
    name: cat.name ?? '', code: cat.code ?? '', parent_id: cat.parent_id ?? '', branch_id: cat.branch_id ?? '',
    vertical_id: cat.vertical_id ?? '', description: cat.description ?? '', active: cat.active !== false,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const vOpts = rd.verticals.filter((v: any) => !f.branch_id || Number(v.branch_id) === Number(f.branch_id));
  const parents = all.filter((c) => !c.parent_id && Number(c.id) !== Number(cat.id));
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: f.name, code: f.code || null, parent_id: f.parent_id ? Number(f.parent_id) : null,
        branch_id: f.branch_id ? Number(f.branch_id) : null, vertical_id: f.vertical_id ? Number(f.vertical_id) : null,
        description: f.description || null, active: f.active };
      if (isNew) await api.post('/question-categories', body); else await api.patch(`/question-categories/${cat.id}`, body);
      toast(isNew ? 'Category created' : 'Category updated'); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={isNew ? 'Add category' : `Edit — ${cat.name}`} icon="grid" width={560} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button></div>}>
      <div className="form-grid">
        <div className="fld"><label>Name *</label><input className="ainp" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Programming Fundamentals / English Grammar" /></div>
        <div className="fld"><label>Code</label><input className="ainp" value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="PROG" /></div>
        <div className="fld"><label>Parent subject (for a topic)</label><select className="ainp" value={f.parent_id} onChange={(e) => set('parent_id', e.target.value)}><option value="">— none (this is a subject) —</option>{parents.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="fld"><label>Branch</label><select className="ainp" value={f.branch_id} onChange={(e) => { set('branch_id', e.target.value); set('vertical_id', ''); }}><option value="">— org-wide —</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="fld"><label>Vertical</label><select className="ainp" value={f.vertical_id} onChange={(e) => set('vertical_id', e.target.value)} disabled={!f.branch_id}><option value="">—</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Description</label><input className="ainp" value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />Active</label>
      </div>
    </DetailModal>
  );
}

/* ============================================================ TESTS / EXAMS === */
/**
 * Assessment Batch B — Tests/Exams. A test is assembled from the Batch A question bank
 * (hand-picked links and/or pooled sections), carries full settings (duration, marks,
 * negative marking, randomisation, attempt limit, availability window, show-result mode),
 * and moves draft → published → closed. Reusable settings live in Test Templates.
 */
export const TEST_TYPE_OPTS = [
  { id: 'practice', name: 'Practice' }, { id: 'chapter', name: 'Chapter' }, { id: 'weekly', name: 'Weekly' },
  { id: 'mock', name: 'Mock' }, { id: 'assignment', name: 'Assignment' }, { id: 'practical', name: 'Practical' },
  { id: 'final_exam', name: 'Final Exam' },
];
const TEST_TYPE_LABEL: Record<string, string> = Object.fromEntries(TEST_TYPE_OPTS.map((t) => [t.id, t.name]));
const STATUS_OPTS = [{ id: 'draft', name: 'Draft' }, { id: 'pending_approval', name: 'Pending approval' }, { id: 'published', name: 'Published' }, { id: 'closed', name: 'Closed' }];
const STATUS_BADGE: Record<string, string> = { draft: 'b-gray', pending_approval: 'b-amber', published: 'b-green', closed: 'b-rose' };
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', pending_approval: 'Pending approval', published: 'Published', closed: 'Closed' };
const SHOW_RESULT_OPTS = [
  { id: 'instant', name: 'Instant — right after submit' },
  { id: 'manual', name: 'Manual — faculty releases results' },
  { id: 'after_end', name: 'After the window ends' },
];
const fmtDT = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v); if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};
const toLocalInput = (v?: string | null) => {
  if (!v) return '';
  const d = new Date(v); if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function AssessmentTestsScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fType, setFType] = useState<string[]>([]);
  const [fStatus, setFStatus] = useState<string[]>([]);
  const [fCourse, setFCourse] = useState<number[]>([]);
  const [fLang, setFLang] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [fromTmpl, setFromTmpl] = useState(false);
  const [imp, setImp] = useState(false);
  const [launch, setLaunch] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fType.length) qs.set('test_type', fType.join(','));
  if (fStatus.length) qs.set('status', fStatus.join(','));
  if (fCourse.length) qs.set('course_id', fCourse.join(','));
  if (fLang.length) qs.set('language', fLang.join(','));
  if (q) qs.set('q', q);
  const list = useFetch<any[]>(`/assessments?${qs.toString()}`, [qs.toString(), tick]);
  const summary = useFetch<any>('/assessments/summary', [tick]);
  const rows = list.data ?? [];
  const langs = Array.from(new Set(rows.map((r: any) => r.language).filter(Boolean))) as string[];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Test', '/assessments/bulk-delete/impact', '/assessments/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/assessments/${del.id}`); toast('Test deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };
  const doPublish = async (r: any) => { try { const res = await api.post<any>(`/assessments/${r.id}/publish`, {}); toast(`Published — total ${res.total_marks ?? r.total_marks} marks`); after(); } catch (e: any) { toast(e.message, true); } };
  const doClose = async (r: any) => { try { await api.post(`/assessments/${r.id}/close`, {}); toast('Test closed'); after(); } catch (e: any) { toast(e.message, true); } };
  const doSubmit = async (r: any) => { try { await api.post(`/assessments/${r.id}/submit`, {}); toast('Submitted for approval'); after(); } catch (e: any) { toast(e.message, true); } };
  const doUnpublish = async (r: any) => { try { await api.post(`/assessments/${r.id}/unpublish`, {}); toast('Unpublished — back to draft'); after(); } catch (e: any) { toast(e.message, true); } };
  const doReject = async (r: any) => { const remarks = window.prompt('Reason / changes requested (sent back to the trainer):', ''); if (remarks == null) return; if (!remarks.trim()) { toast('Remarks are required', true); return; } try { await api.post(`/assessments/${r.id}/reject`, { remarks }); toast('Sent back to draft with remarks'); after(); } catch (e: any) { toast(e.message, true); } };
  const s = summary.data;

  return (
    <>
      <div className="page-actions" style={{ display: 'flex', gap: 8 }}>
        {can('assessment.create') && <button className="btn" onClick={() => setImp(true)}><Ic k="export" />Import CSV</button>}
        {can('assessment.create') && <button className="btn" onClick={() => setFromTmpl(true)}><Ic k="doc" />New from template</button>}
        {can('assessment.create') && <button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />Create test</button>}
      </div>
      <Kpis items={[
        { lab: 'Tests', val: String(s?.total ?? 0), ic: 'doc' },
        { lab: 'Draft', val: String(s?.draft ?? 0), ic: 'pencil' },
        { lab: 'Published', val: String(s?.published ?? 0), ic: 'check' },
        { lab: 'Closed', val: String(s?.closed ?? 0), ic: 'shield' },
      ]} />
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
        <EnumMulti label="Type" icon="list" value={fType} options={TEST_TYPE_OPTS} onChange={setFType} />
        <EnumMulti label="Status" icon="shield" value={fStatus} options={STATUS_OPTS} onChange={setFStatus} />
        <FilterMulti label="Course" icon="doc" value={fCourse} options={rd.courses} onChange={setFCourse} />
        <EnumMulti label="Language" icon="grid" value={fLang} options={asOpts(langs)} onChange={setFLang} />
        <label className="fchip"><Ic k="search" /><input placeholder="Search title" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
      </div>
      <BulkBar count={count} entityLabel="Test" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Tests / Exams" icon="doc"
        select={can('assessment.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('tests.csv', rows.map((r: any) => ({
          title: r.title, type: TEST_TYPE_LABEL[r.test_type] ?? r.test_type, course: r.course_name, batch: r.batch_name,
          language: r.language, duration_min: r.duration_min, total_marks: r.total_marks, passing_marks: r.passing_marks,
          passing_pct: r.passing_pct, questions: r.question_count, sections: r.section_count, status: r.status,
          starts: fmtDT(r.start_at), ends: fmtDT(r.end_at), template: r.template_name, branch: r.branch_name, vertical: r.vertical_name,
        })))} onRefresh={after} />}
        cols={['Title', 'Type', 'Course', 'Batch', 'Duration', 'Total / Pass', 'Questions', 'Window', 'Status', 'Actions']}
        empty="No tests yet — create one, start from a template, or import a CSV."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.title}</b>{r.template_name ? <div className="sub">from {r.template_name}</div> : null}</div> } as Cell,
          { b: [TEST_TYPE_LABEL[r.test_type] ?? r.test_type, 'b-indigo'] } as Cell,
          r.course_name ?? '—',
          r.batch_name ?? '—',
          r.duration_min ? `${r.duration_min} min` : '—',
          `${r.total_marks}${r.passing_marks != null ? ' / ' + r.passing_marks : (r.passing_pct != null ? ' / ' + r.passing_pct + '%' : '')}`,
          String(Number(r.question_count ?? 0) + (Number(r.section_count ?? 0) ? ` +${r.section_count} pool` : '')),
          { node: <span className="sub">{r.start_at || r.end_at ? `${fmtDT(r.start_at)} → ${fmtDT(r.end_at)}` : 'Always open'}</span> } as Cell,
          { node: <div><span className={`badge ${(r.review_remarks && r.status==='draft') ? 'b-rose' : (STATUS_BADGE[r.status] ?? 'b-gray')}`}>{(r.review_remarks && r.status==='draft') ? 'Changes requested' : (STATUS_LABEL[r.status] ?? r.status)}</span>{(r.review_remarks && r.status==='draft') ? <div className="sub" title={r.review_remarks} style={{maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>“{r.review_remarks}”</div> : null}</div> } as Cell,
          rowActions({
            onView: () => setPreview(r),
            onEdit: can('assessment.update') ? () => setEdit(r) : undefined,
            onDelete: can('assessment.delete') ? () => setDel(r) : undefined,
            extra: [
              ...(can('assessment_attempt.create') && r.status === 'published' ? [{ k: 'bolt', title: 'Launch / Take', onClick: () => setLaunch(r) }] : []),
              // Trainer (has submit, NOT publish): Submit a draft for approval
              ...(can('assessment.submit') && !can('assessment.publish') && r.status === 'draft' ? [{ k: 'send', title: 'Submit for approval', onClick: () => doSubmit(r) }] : []),
              // Academic Admin / approver (has publish): approve a pending test, or reject with remarks
              ...(can('assessment.publish') && r.status === 'pending_approval' ? [{ k: 'check', title: 'Approve & publish', onClick: () => doPublish(r) }] : []),
              ...(can('assessment.publish') && r.status === 'pending_approval' ? [{ k: 'x', title: 'Reject (send back with remarks)', onClick: () => doReject(r) }] : []),
              // Approver may also publish a draft directly (admin shortcut)
              ...(can('assessment.publish') && r.status === 'draft' ? [{ k: 'check', title: 'Publish', onClick: () => doPublish(r) }] : []),
              ...(can('assessment.publish') && r.status === 'published' ? [{ k: 'restore', title: 'Unpublish', onClick: () => doUnpublish(r) }] : []),
              ...(can('assessment.publish') && r.status === 'published' ? [{ k: 'shield', title: 'Close', onClick: () => doClose(r) }] : []),
            ],
          }),
        ])} />
      {edit && <TestBuilder test={edit} rd={rd} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); after(); }} />}
      {preview && <TestPreview id={preview.id} title={preview.title} onClose={() => setPreview(null)} />}
      {fromTmpl && <NewFromTemplate rd={rd} onClose={() => setFromTmpl(false)} onCreated={(id) => { setFromTmpl(false); after(); setEdit({ id }); }} />}
      {del && <ConfirmModal title="Delete test?" body={`Delete "${del.title}"? Question links are removed; the bank questions are kept.`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {imp && <TestImportModal onClose={() => setImp(false)} onDone={() => { setImp(false); after(); }} />}
      {launch && <LaunchTest test={launch} onClose={() => setLaunch(null)} onDone={after} />}
      {bulkModal}
    </>
  );
}

function TestBuilder({ test, rd, onClose, onSaved }: { test: any; rd: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !test?.id;
  const [loaded, setLoaded] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<any>({
    title: '', description: '', test_type: 'practice', course_id: '', batch_id: '', language: '',
    branch_id: '', vertical_id: '', duration_min: 30, max_attempts: 1,
    negative_marking: false, default_negative: 0, randomize_questions: false, randomize_options: false,
    shuffle_per_attempt: false, questions_to_show: '', pass_mode: 'marks', passing_marks: '', passing_pct: '',
    start_at: '', end_at: '', show_result_mode: 'instant', instructions: '', zoom_link: '',
    total_marks_manual: false, total_marks: '',
  });
  const [picked, setPicked] = useState<any[]>([]);
  const [sections, setSections] = useState<any[]>([]);
  const [computed, setComputed] = useState<number>(0);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  const cats = useFetch<any[]>('/question-categories', []);
  const catOpts = (cats.data ?? []).map((c: any) => ({ id: c.id, name: c.parent_name ? `${c.parent_name} › ${c.name}` : c.name }));
  const batches = useFetch<any[]>('/batches', []);
  const batchList = (batches.data ?? []).filter((b: any) => (!f.branch_id || Number(b.branch_id) === Number(f.branch_id)) && (!f.vertical_id || Number(b.vertical_id) === Number(f.vertical_id)));
  const vOpts = rd.verticals.filter((v: any) => !f.branch_id || Number(v.branch_id) === Number(f.branch_id));

  useEffect(() => {
    if (isNew) return;
    api.get<any>(`/assessments/${test.id}`).then((a) => {
      setF({
        title: a.title ?? '', description: a.description ?? '', test_type: a.test_type ?? 'practice',
        course_id: a.course_id ?? '', batch_id: a.batch_id ?? '', language: a.language ?? '',
        branch_id: a.branch_id ?? '', vertical_id: a.vertical_id ?? '',
        duration_min: a.duration_min ?? 30, max_attempts: a.max_attempts ?? 1,
        negative_marking: !!a.negative_marking, default_negative: a.default_negative ?? 0,
        randomize_questions: !!a.randomize_questions, randomize_options: !!a.randomize_options,
        shuffle_per_attempt: !!a.shuffle_per_attempt, questions_to_show: a.questions_to_show ?? '',
        pass_mode: a.passing_pct != null ? 'pct' : 'marks', passing_marks: a.passing_marks ?? '', passing_pct: a.passing_pct ?? '',
        start_at: toLocalInput(a.start_at), end_at: toLocalInput(a.end_at),
        show_result_mode: a.show_result_mode ?? 'instant', instructions: a.instructions ?? '', zoom_link: a.zoom_link ?? '',
        total_marks_manual: !!a.total_marks_manual, total_marks: a.total_marks ?? '',
        status: a.status,
      });
      setPicked((a.questions ?? []).map((qq: any) => ({
        question_id: qq.question_id, body: qq.body, q_type: qq.q_type, difficulty: qq.difficulty,
        marks: qq.marks, marks_override: qq.marks_override ?? '', category_name: qq.category_name,
      })));
      setSections((a.sections ?? []).map((sc: any) => ({
        section_id: sc.id, title: sc.title, pool_from_category_id: sc.pool_from_category_id ?? '', pool_pick_count: sc.pool_pick_count ?? '',
        pool_available: sc.pool_available, pool_category_name: sc.pool_category_name,
      })));
      setComputed(Number(a.computed_total ?? a.total_marks ?? 0));
      setLoaded(true);
    }).catch((e) => { toast(e.message, true); setLoaded(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveHand = picked.reduce((sum, p) => sum + (p.marks_override !== '' && p.marks_override != null ? Number(p.marks_override) : Number(p.marks || 0)), 0);
  const status = f.status ?? 'draft';

  const buildBody = () => ({
    title: f.title, description: f.description || null, test_type: f.test_type,
    course_id: f.course_id ? Number(f.course_id) : null, batch_id: f.batch_id ? Number(f.batch_id) : null,
    language: f.language || null, branch_id: f.branch_id ? Number(f.branch_id) : null, vertical_id: f.vertical_id ? Number(f.vertical_id) : null,
    duration_min: Number(f.duration_min) || 0, max_attempts: Number(f.max_attempts) || 1,
    negative_marking: f.negative_marking, default_negative: Number(f.default_negative) || 0,
    randomize_questions: f.randomize_questions, randomize_options: f.randomize_options, shuffle_per_attempt: f.shuffle_per_attempt,
    questions_to_show: f.questions_to_show === '' ? null : Number(f.questions_to_show),
    passing_marks: f.pass_mode === 'marks' && f.passing_marks !== '' ? Number(f.passing_marks) : null,
    passing_pct: f.pass_mode === 'pct' && f.passing_pct !== '' ? Number(f.passing_pct) : null,
    start_at: f.start_at || null, end_at: f.end_at || null,
    show_result_mode: f.show_result_mode, instructions: f.instructions || null, zoom_link: f.zoom_link || null,
    total_marks_manual: f.total_marks_manual, total_marks: f.total_marks_manual && f.total_marks !== '' ? Number(f.total_marks) : null,
    questions: picked.map((p, i) => ({ question_id: p.question_id, marks_override: p.marks_override === '' ? null : Number(p.marks_override), ordering: i + 1 })),
    sections: sections.filter((s) => s.pool_from_category_id).map((s, i) => ({
      title: s.title || 'Pooled section', pool_from_category_id: Number(s.pool_from_category_id),
      pool_pick_count: s.pool_pick_count === '' ? 1 : Number(s.pool_pick_count), ordering: i + 1,
    })),
  });

  const save = async (thenPublish?: boolean): Promise<void> => {
    if (!f.title.trim()) { toast('A test title is required.', true); return; }
    setBusy(true);
    try {
      const body = buildBody();
      let id = test.id;
      if (isNew) { const r = await api.post<any>('/assessments', body); id = r.id; } else { await api.patch(`/assessments/${test.id}`, body); }
      if (thenPublish) { const res = await api.post<any>(`/assessments/${id}/publish`, {}); toast(`Published — total ${res.total_marks} marks`); }
      else toast(isNew ? 'Test created' : 'Test saved');
      onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const doClose = async () => { setBusy(true); try { await api.post(`/assessments/${test.id}/close`, {}); toast('Test closed'); onSaved(); } catch (e: any) { toast(e.message, true); } finally { setBusy(false); } };

  const addPicked = (qq: any) => setPicked((p) => p.some((x) => Number(x.question_id) === Number(qq.id)) ? p : [...p, { question_id: qq.id, body: qq.body, q_type: qq.q_type, difficulty: qq.difficulty, marks: qq.marks, marks_override: '', category_name: qq.category_name }]);
  const move = (i: number, d: number) => setPicked((p) => { const j = i + d; if (j < 0 || j >= p.length) return p; const n = [...p]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  // Incremental persistence for a saved test — the dedicated add/remove/reorder + pool seams.
  const syncQuestions = async () => {
    try {
      const r = await api.post<any>(`/assessments/${test.id}/questions`, { questions: picked.map((p, i) => ({ question_id: p.question_id, marks_override: p.marks_override === '' ? null : Number(p.marks_override), ordering: i + 1 })) });
      setComputed(Number(r.total_marks ?? 0)); toast(`Questions saved — total ${r.total_marks}`);
    } catch (e: any) { toast(e.message, true); }
  };
  const savePool = async (sc: any) => {
    if (!sc.pool_from_category_id) { toast('Choose a category first.', true); return; }
    try {
      const r = await api.post<any>(`/assessments/${test.id}/section-pool`, { title: sc.title || 'Pooled section', pool_from_category_id: Number(sc.pool_from_category_id), pool_pick_count: sc.pool_pick_count === '' ? 1 : Number(sc.pool_pick_count), section_id: sc.section_id ?? null });
      setComputed(Number(r.total_marks ?? 0)); toast('Pool saved'); if (r.section_id) setSections((p) => p.map((x) => x === sc ? { ...x, section_id: r.section_id } : x));
    } catch (e: any) { toast(e.message, true); }
  };

  return (
    <DetailModal title={isNew ? 'Create test' : `Edit — ${f.title || 'test'}`} icon="doc" width={880} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="sub" style={{ marginRight: 'auto' }}>Live total (hand-picked): <b>{liveHand}</b>{sections.some((s) => s.pool_from_category_id) ? ' + pooled (computed on save)' : ''}{!isNew ? ` · saved total ${computed}` : ''}</span>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        {!isNew && status === 'published' && <button className="btn" onClick={doClose} disabled={busy}><Ic k="shield" />Close test</button>}
        <button className="btn" onClick={() => save(false)} disabled={busy || !loaded}><Ic k="check" />Save draft</button>
        {status !== 'closed' && <button className="btn primary" onClick={() => save(true)} disabled={busy || !loaded}><Ic k="check" />Save & publish</button>}
      </div>}>
      {!loaded ? <div className="empty-note">Loading…</div> : <>
      <Section title="Test details"><div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Title *</label><input className="ainp" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Java Fundamentals — Mock Test" /></div>
        <div className="fld"><label>Test type *</label><select className="ainp" value={f.test_type} onChange={(e) => set('test_type', e.target.value)}>{TEST_TYPE_OPTS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <div className="fld"><label>Language (optional)</label><input className="ainp" value={f.language} onChange={(e) => set('language', e.target.value)} placeholder="English, Hindi…" /></div>
        <div className="fld"><label>Branch</label><select className="ainp" value={f.branch_id} onChange={(e) => { set('branch_id', e.target.value); set('vertical_id', ''); set('batch_id', ''); }}><option value="">— org-wide —</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="fld"><label>Vertical</label><select className="ainp" value={f.vertical_id} onChange={(e) => { set('vertical_id', e.target.value); set('batch_id', ''); }} disabled={!f.branch_id}><option value="">—</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div className="fld"><label>Course</label><MasterQuickAdd type="course" onAdded={(row) => set('course_id', String(row.id))} /><select className="ainp" value={f.course_id} onChange={(e) => set('course_id', e.target.value)}><option value="">—</option>{rd.courses.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="fld"><label>Batch</label><select className="ainp" value={f.batch_id} onChange={(e) => set('batch_id', e.target.value)}><option value="">—</option>{batchList.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Description</label><input className="ainp" value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
      </div></Section>

      <Section title="Settings"><div className="form-grid">
        <div className="fld"><label>Duration (minutes)</label><input className="ainp" type="number" min={0} value={f.duration_min} onChange={(e) => set('duration_min', e.target.value)} /><span className="sub">0 = untimed (assignments/practicals)</span></div>
        <div className="fld"><label>Max attempts</label><input className="ainp" type="number" min={1} value={f.max_attempts} onChange={(e) => set('max_attempts', e.target.value)} /></div>
        <div className="fld"><label>Questions to show (optional)</label><input className="ainp" type="number" min={1} value={f.questions_to_show} onChange={(e) => set('questions_to_show', e.target.value)} placeholder="pick N at random" /></div>
        <div className="fld"><label>Show result</label><select className="ainp" value={f.show_result_mode} onChange={(e) => set('show_result_mode', e.target.value)}>{SHOW_RESULT_OPTS.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        <div className="fld"><label>Available from</label><input className="ainp" type="datetime-local" value={f.start_at} onChange={(e) => set('start_at', e.target.value)} /></div>
        <div className="fld"><label>Available until</label><input className="ainp" type="datetime-local" value={f.end_at} onChange={(e) => set('end_at', e.target.value)} /></div>
        <div className="fld"><label>Passing by</label><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="ainp" value={f.pass_mode} onChange={(e) => set('pass_mode', e.target.value)} style={{ width: 110 }}><option value="marks">Marks</option><option value="pct">Percent</option></select>
          {f.pass_mode === 'marks'
            ? <input className="ainp" type="number" min={0} step="0.5" value={f.passing_marks} onChange={(e) => set('passing_marks', e.target.value)} placeholder="passing marks" />
            : <input className="ainp" type="number" min={0} max={100} step="1" value={f.passing_pct} onChange={(e) => set('passing_pct', e.target.value)} placeholder="passing %" />}
        </div></div>
        <div className="fld"><label>Total marks</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={f.total_marks_manual} onChange={(e) => set('total_marks_manual', e.target.checked)} />Override (else derived)</label>
          {f.total_marks_manual ? <input className="ainp" type="number" min={0} step="0.5" value={f.total_marks} onChange={(e) => set('total_marks', e.target.value)} placeholder="total marks" /> : <span className="sub">Derived from questions{sections.some((s)=>s.pool_from_category_id)?' + pools':''}: {liveHand || computed}</span>}
        </div>
        <div className="fld" style={{ gridColumn: '1 / -1', display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.negative_marking} onChange={(e) => set('negative_marking', e.target.checked)} />Negative marking</label>
          {f.negative_marking ? <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>default −<input className="ainp" style={{ width: 80 }} type="number" min={0} step="0.25" value={f.default_negative} onChange={(e) => set('default_negative', e.target.value)} /></span> : null}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.randomize_questions} onChange={(e) => set('randomize_questions', e.target.checked)} />Randomise questions</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.randomize_options} onChange={(e) => set('randomize_options', e.target.checked)} />Randomise options</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.shuffle_per_attempt} onChange={(e) => set('shuffle_per_attempt', e.target.checked)} />Shuffle each attempt</label>
        </div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Instructions (shown before the test)</label><textarea className="ainp" rows={2} value={f.instructions} onChange={(e) => set('instructions', e.target.value)} /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Zoom Link (optional)</label><input className="ainp" type="url" value={f.zoom_link} onChange={(e) => set('zoom_link', e.target.value)} placeholder="https://zoom.us/j/… (for proctored / online sessions)" /><span className="sub">Shown to students on the attempt screen to join the proctored session.</span></div>
      </div></Section>

      <QuestionPicker rd={rd} catOpts={catOpts} picked={picked} onAdd={addPicked} />

      <Section title={`Selected questions (${picked.length})`}>
        {picked.length === 0 ? <div className="empty-note">No hand-picked questions yet — add from the picker above, or configure a pooled section below.</div> : (
          <div style={{ display: 'grid', gap: 6 }}>
            {picked.map((p, i) => (
              <div key={p.question_id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid var(--line)', paddingBottom: 4 }}>
                <span className="sub" style={{ width: 22 }}>{i + 1}.</span>
                <span className={`bdg ${DIFF_BADGE[p.difficulty] ?? 'b-gray'}`}>{p.difficulty}</span>
                <span style={{ flex: 1 }}>{String(p.body).slice(0, 80)}{String(p.body).length > 80 ? '…' : ''}</span>
                <span className="sub">{Q_TYPE_LABEL[p.q_type] ?? p.q_type}</span>
                <input className="ainp" style={{ width: 74 }} type="number" step="0.5" value={p.marks_override} placeholder={String(p.marks)} title="Marks (blank = default)" onChange={(e) => setPicked((pp) => pp.map((x, j) => j === i ? { ...x, marks_override: e.target.value } : x))} />
                <button className="btn" type="button" title="Up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button className="btn" type="button" title="Down" onClick={() => move(i, 1)} disabled={i === picked.length - 1}>↓</button>
                <button className="btn" type="button" title="Remove" onClick={() => setPicked((pp) => pp.filter((_, j) => j !== i))}><Ic k="trash" /></button>
              </div>
            ))}
          </div>
        )}
        {!isNew && picked.length ? <div style={{ marginTop: 8 }}><button className="btn" type="button" onClick={syncQuestions}><Ic k="check" />Save questions now</button></div> : null}
      </Section>

      <Section title="Pooled sections (pick N random from a category)">
        <div style={{ display: 'grid', gap: 8 }}>
          {sections.map((sc, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="ainp" style={{ width: 180 }} value={sc.title} placeholder="Section title" onChange={(e) => setSections((p) => p.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
              <select className="ainp" style={{ minWidth: 200 }} value={sc.pool_from_category_id} onChange={(e) => setSections((p) => p.map((x, j) => j === i ? { ...x, pool_from_category_id: e.target.value } : x))}>
                <option value="">— category to pool from —</option>{catOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>pick <input className="ainp" style={{ width: 70 }} type="number" min={1} value={sc.pool_pick_count} onChange={(e) => setSections((p) => p.map((x, j) => j === i ? { ...x, pool_pick_count: e.target.value } : x))} /></span>
              {!isNew ? <button className="btn" type="button" title="Save this pool" onClick={() => savePool(sc)}><Ic k="check" />Save pool</button> : null}
              <button className="btn" type="button" title="Remove section" onClick={() => setSections((p) => p.filter((_, j) => j !== i))}><Ic k="trash" /></button>
            </div>
          ))}
          <div><button className="btn" type="button" onClick={() => setSections((p) => [...p, { title: 'Section', pool_from_category_id: '', pool_pick_count: 2 }])}><Ic k="plus" />Add pooled section</button></div>
        </div>
      </Section>
      </>}
    </DetailModal>
  );
}

function QuestionPicker({ rd, catOpts, picked, onAdd }: { rd: any; catOpts: any[]; picked: any[]; onAdd: (q: any) => void }) {
  const [fCat, setFCat] = useState<number[]>([]);
  const [fType, setFType] = useState<string[]>([]);
  const [fDiff, setFDiff] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<number[]>([]);
  const qs = new URLSearchParams();
  if (fCat.length) qs.set('category_id', fCat.join(','));
  if (fType.length) qs.set('q_type', fType.join(','));
  if (fDiff.length) qs.set('difficulty', fDiff.join(','));
  if (q) qs.set('q', q);
  qs.set('active', '1');
  const bank = useFetch<any[]>(`/questions?${qs.toString()}`, [qs.toString()]);
  const pickedIds = new Set(picked.map((p) => Number(p.question_id)));
  const rows = (bank.data ?? []).filter((r: any) => !pickedIds.has(Number(r.id)));
  const addSelected = () => { rows.filter((r: any) => sel.includes(Number(r.id))).forEach((r: any) => onAdd(r)); setSel([]); };
  return (
    <Section title="Question picker (from the Question Bank)">
      <div className="filters" style={{ marginBottom: 8 }}>
        <FilterMulti label="Category" icon="doc" value={fCat} options={catOpts} onChange={setFCat} />
        <EnumMulti label="Type" icon="list" value={fType} options={Q_TYPE_OPTS} onChange={setFType} />
        <EnumMulti label="Difficulty" icon="bolt" value={fDiff} options={DIFF_OPTS} onChange={setFDiff} />
        <label className="fchip"><Ic k="search" /><input placeholder="Search text / tags" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
        {sel.length ? <button className="btn primary" type="button" onClick={addSelected}><Ic k="plus" />Add {sel.length} selected</button> : null}
      </div>
      <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 4 }}>
        {rows.length === 0 ? <div className="empty-note">No matching bank questions (or all already added).</div> : rows.map((r: any) => (
          <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '2px 0' }}>
            <input type="checkbox" checked={sel.includes(Number(r.id))} onChange={(e) => setSel((p) => e.target.checked ? [...p, Number(r.id)] : p.filter((x) => x !== Number(r.id)))} />
            <span className={`bdg ${DIFF_BADGE[r.difficulty] ?? 'b-gray'}`}>{r.difficulty}</span>
            <span style={{ flex: 1 }}>{String(r.body).slice(0, 80)}{String(r.body).length > 80 ? '…' : ''}</span>
            <span className="sub">{Q_TYPE_LABEL[r.q_type] ?? r.q_type} · {r.marks}m</span>
            <button className="btn" type="button" onClick={() => onAdd(r)}><Ic k="plus" />Add</button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function TestPreview({ id, title, onClose }: { id: number; title: string; onClose: () => void }) {
  const d = useFetch<any>(`/assessments/${id}/preview`, [id]);
  const p = d.data;
  return (
    <DetailModal title={`Preview — ${title}`} icon="eye" width={720} onClose={onClose}>
      {!p ? <div className="empty-note">Assembling…</div> : <>
        <div className="empty-note" style={{ marginBottom: 10 }}>This is the student-facing set (correct answers are stripped). {p.assessment.duration_min ? `${p.assessment.duration_min} min · ` : ''}{p.assessment.total_marks} marks · {p.question_count} questions.{p.assessment.negative_marking ? ' Negative marking on.' : ''}</div>
        {p.main_questions?.length ? <Section title="Questions">{p.main_questions.map((qq: any, i: number) => <PreviewQ key={qq.id} n={i + 1} q={qq} />)}</Section> : null}
        {(p.sections ?? []).map((sc: any) => (
          <Section key={sc.id} title={`${sc.title} (pooled)`}>{sc.questions.map((qq: any, i: number) => <PreviewQ key={qq.id} n={i + 1} q={qq} />)}</Section>
        ))}
        {!p.question_count ? <div className="empty-note">No questions resolved — add questions or a valid pool.</div> : null}
      </>}
    </DetailModal>
  );
}
function PreviewQ({ n, q }: { n: number; q: any }) {
  const embed = youtubeEmbed(q.youtube_url, q.youtube_start_sec, q.youtube_end_sec);
  return (
    <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--line)' }}>
      <div style={{ fontSize: 13.5 }}><b>{n}.</b> {q.body} <span className="sub">({q.marks}m{q.negative_marks ? `, −${q.negative_marks}` : ''})</span></div>
      {q.image_url ? <img src={q.image_url} alt="q" style={{ maxHeight: 120, borderRadius: 6, marginTop: 6 }} /> : null}
      {q.audio_url ? <audio controls src={q.audio_url} style={{ width: '100%', marginTop: 6 }} /> : null}
      {embed ? <div style={{ position: 'relative', paddingTop: '40%', maxWidth: 380, marginTop: 6 }}><iframe title="yt" src={embed} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, borderRadius: 8 }} allowFullScreen /></div> : null}
      {q.options?.length ? <div style={{ display: 'grid', gap: 3, marginTop: 5 }}>{q.options.map((o: any, i: number) => (
        <div key={o.id} style={{ fontSize: 13 }}><span className="sub">{String.fromCharCode(65 + i)}.</span> {o.body}{o.match_key ? ` → ${o.match_key}` : ''}</div>
      ))}</div> : null}
    </div>
  );
}

function NewFromTemplate({ rd, onClose, onCreated }: { rd: any; onClose: () => void; onCreated: (id: number) => void }) {
  const tmpls = useFetch<any[]>('/assessment-templates', []);
  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!templateId) { toast('Choose a template.', true); return; }
    setBusy(true);
    try { const r = await api.post<any>('/assessments/from-template', { template_id: Number(templateId), title: title || undefined }); toast('Test created from template'); onCreated(r.id); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title="New test from a template" icon="doc" width={520} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={create} disabled={busy}><Ic k="check" />Create</button></div>}>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Template *</label><select className="ainp" value={templateId} onChange={(e) => setTemplateId(e.target.value)}><option value="">— choose —</option>{(tmpls.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name} ({TEST_TYPE_LABEL[t.test_type] ?? t.test_type})</option>)}</select></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Title (optional)</label><input className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="defaults to the template name" /></div>
        <div className="empty-note" style={{ gridColumn: '1 / -1' }}>The template's settings are copied into a new draft; add questions in the builder that opens next.</div>
      </div>
    </DetailModal>
  );
}

function TestImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const onFile = (file?: File) => {
    if (!file) return;
    setFileName(file.name);
    const r = new FileReader();
    r.onload = () => { try { setRows(parseCsv(String(r.result))); setReport(null); } catch (e: any) { toast(e.message, true); } };
    r.readAsText(file);
  };
  const run = async () => {
    if (!rows.length) { toast('Choose a CSV first.', true); return; }
    setBusy(true);
    try { const res = await api.post<any>('/assessments/import', { rows }); setReport(res); if (res.imported) toast(`${res.imported} test(s) imported`); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title="Import tests (CSV)" icon="doc" width={620} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={onClose}>Close</button>
        {report && report.imported ? <button className="btn primary" onClick={onDone}><Ic k="check" />Done</button>
          : <button className="btn primary" onClick={run} disabled={busy || !rows.length}><Ic k="export" />Import {rows.length || ''}</button>}
      </div>}>
      <div className="empty-note" style={{ marginBottom: 10 }}>
        Columns: <b>title, test_type, course, batch, language, duration_min, passing_marks, passing_pct, negative_marking, max_attempts, instructions</b>.
        Course/batch are matched by name. Each row creates a DRAFT test — add questions in the builder afterwards. Unknown types/courses are reported row-by-row.
      </div>
      <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
      {fileName ? <div style={{ marginTop: 8, fontSize: 13 }}>{fileName} — <b>{rows.length}</b> row(s) parsed</div> : null}
      {report ? (
        <div className="sheet-sec" style={{ marginTop: 12 }}>
          <h5>Result: {report.imported} imported, {report.failed} failed</h5>
          {report.errors?.length ? <div style={{ maxHeight: 220, overflow: 'auto', fontSize: 12.5 }}>{report.errors.map((e: any, i: number) => <div key={i} style={{ color: 'var(--danger)' }}>Row {e.row}: {e.message}</div>)}</div> : <div className="empty-note">No errors.</div>}
        </div>
      ) : null}
    </DetailModal>
  );
}

/* ======================================================= TEST TEMPLATES === */
export function AssessmentTemplatesScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fType, setFType] = useState<string[]>([]);
  const [fActive, setFActive] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fType.length) qs.set('test_type', fType.join(','));
  if (fActive.length === 1) qs.set('active', fActive[0] === 'active' ? '1' : '0');
  if (q) qs.set('q', q);
  const list = useFetch<any[]>(`/assessment-templates?${qs.toString()}`, [qs.toString(), tick]);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Template', '/assessment-templates/bulk-delete/impact', '/assessment-templates/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/assessment-templates/${del.id}`); toast('Template deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('assessment_template.create') && <div className="page-actions"><button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />Add template</button></div>}
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
        <EnumMulti label="Type" icon="list" value={fType} options={TEST_TYPE_OPTS} onChange={setFType} />
        <EnumMulti label="Status" icon="shield" value={fActive} options={[{ id: 'active', name: 'Active' }, { id: 'inactive', name: 'Inactive' }]} onChange={setFActive} />
        <label className="fchip"><Ic k="search" /><input placeholder="Search name" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
      </div>
      <BulkBar count={count} entityLabel="Template" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Test Templates" icon="doc"
        select={can('assessment_template.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('test-templates.csv', rows.map((r: any) => ({
          name: r.name, type: TEST_TYPE_LABEL[r.test_type] ?? r.test_type, duration_min: r.duration_min,
          negative_marking: r.negative_marking ? 'Yes' : 'No', default_negative: r.default_negative,
          randomize_questions: r.randomize_questions ? 'Yes' : 'No', randomize_options: r.randomize_options ? 'Yes' : 'No',
          max_attempts: r.max_attempts, passing_pct: r.passing_pct, show_result: r.show_result_mode,
          used_by_tests: r.used_count, branch: r.branch_name, vertical: r.vertical_name, active: r.active ? 'Yes' : 'No',
        })))} onRefresh={after} />}
        cols={['Name', 'Type', 'Duration', 'Negative', 'Randomise', 'Attempts', 'Pass %', 'Result', 'Used by', 'Active', 'Actions']}
        empty="No templates yet — add a preset (e.g. Standard MCQ Mock) to speed up test creation."
        rows={rows.map((r: any) => [
          { node: <b className="nm">{r.name}</b> } as Cell,
          { b: [TEST_TYPE_LABEL[r.test_type] ?? r.test_type, 'b-indigo'] } as Cell,
          r.duration_min ? `${r.duration_min} min` : '—',
          { b: [r.negative_marking ? `−${r.default_negative}` : 'Off', r.negative_marking ? 'b-amber' : 'b-gray'] } as Cell,
          `${r.randomize_questions ? 'Q' : ''}${r.randomize_options ? '/O' : ''}` || '—',
          String(r.max_attempts),
          r.passing_pct != null ? `${r.passing_pct}%` : '—',
          r.show_result_mode,
          String(r.used_count ?? 0),
          { b: [r.active ? 'Active' : 'Inactive', r.active ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({ onEdit: can('assessment_template.update') ? () => setEdit(r) : undefined, onDelete: can('assessment_template.delete') ? () => setDel(r) : undefined }),
        ])} />
      {edit && <TemplateForm tmpl={edit} rd={rd} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); after(); }} />}
      {del && <ConfirmModal title="Delete template?" body={`Delete "${del.name}"? Tests already created from it are kept.`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function TemplateForm({ tmpl, rd, onClose, onSaved }: { tmpl: any; rd: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !tmpl?.id;
  const [f, setF] = useState<any>({
    name: tmpl.name ?? '', test_type: tmpl.test_type ?? 'mock', branch_id: tmpl.branch_id ?? '', vertical_id: tmpl.vertical_id ?? '',
    duration_min: tmpl.duration_min ?? 30, negative_marking: !!tmpl.negative_marking, default_negative: tmpl.default_negative ?? 0.25,
    randomize_questions: tmpl.randomize_questions ?? true, randomize_options: tmpl.randomize_options ?? true, shuffle_per_attempt: !!tmpl.shuffle_per_attempt,
    questions_to_show: tmpl.questions_to_show ?? '', max_attempts: tmpl.max_attempts ?? 1, passing_pct: tmpl.passing_pct ?? 40,
    show_result_mode: tmpl.show_result_mode ?? 'instant', instructions: tmpl.instructions ?? '', active: tmpl.active !== false,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const vOpts = rd.verticals.filter((v: any) => !f.branch_id || Number(v.branch_id) === Number(f.branch_id));
  const save = async () => {
    if (!f.name.trim()) { toast('A template name is required.', true); return; }
    setBusy(true);
    try {
      const body = { ...f, branch_id: f.branch_id ? Number(f.branch_id) : null, vertical_id: f.vertical_id ? Number(f.vertical_id) : null,
        duration_min: Number(f.duration_min) || 0, default_negative: Number(f.default_negative) || 0, max_attempts: Number(f.max_attempts) || 1,
        questions_to_show: f.questions_to_show === '' ? null : Number(f.questions_to_show), passing_pct: f.passing_pct === '' ? null : Number(f.passing_pct),
        instructions: f.instructions || null };
      if (isNew) await api.post('/assessment-templates', body); else await api.patch(`/assessment-templates/${tmpl.id}`, body);
      toast(isNew ? 'Template created' : 'Template updated'); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={isNew ? 'Add template' : `Edit — ${tmpl.name}`} icon="doc" width={620} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button></div>}>
      <div className="form-grid">
        <div className="fld"><label>Name *</label><input className="ainp" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Standard MCQ Mock" /></div>
        <div className="fld"><label>Test type</label><select className="ainp" value={f.test_type} onChange={(e) => set('test_type', e.target.value)}>{TEST_TYPE_OPTS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <div className="fld"><label>Branch</label><select className="ainp" value={f.branch_id} onChange={(e) => { set('branch_id', e.target.value); set('vertical_id', ''); }}><option value="">— org-wide —</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="fld"><label>Vertical</label><select className="ainp" value={f.vertical_id} onChange={(e) => set('vertical_id', e.target.value)} disabled={!f.branch_id}><option value="">—</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div className="fld"><label>Duration (minutes)</label><input className="ainp" type="number" min={0} value={f.duration_min} onChange={(e) => set('duration_min', e.target.value)} /></div>
        <div className="fld"><label>Max attempts</label><input className="ainp" type="number" min={1} value={f.max_attempts} onChange={(e) => set('max_attempts', e.target.value)} /></div>
        <div className="fld"><label>Questions to show</label><input className="ainp" type="number" min={1} value={f.questions_to_show} onChange={(e) => set('questions_to_show', e.target.value)} placeholder="optional" /></div>
        <div className="fld"><label>Passing %</label><input className="ainp" type="number" min={0} max={100} value={f.passing_pct} onChange={(e) => set('passing_pct', e.target.value)} /></div>
        <div className="fld"><label>Show result</label><select className="ainp" value={f.show_result_mode} onChange={(e) => set('show_result_mode', e.target.value)}>{SHOW_RESULT_OPTS.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        <div className="fld"><label>Default negative</label><input className="ainp" type="number" min={0} step="0.25" value={f.default_negative} onChange={(e) => set('default_negative', e.target.value)} disabled={!f.negative_marking} /></div>
        <div className="fld" style={{ gridColumn: '1 / -1', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.negative_marking} onChange={(e) => set('negative_marking', e.target.checked)} />Negative marking</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.randomize_questions} onChange={(e) => set('randomize_questions', e.target.checked)} />Randomise questions</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.randomize_options} onChange={(e) => set('randomize_options', e.target.checked)} />Randomise options</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.shuffle_per_attempt} onChange={(e) => set('shuffle_per_attempt', e.target.checked)} />Shuffle each attempt</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />Active</label>
        </div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Default instructions</label><textarea className="ainp" rows={2} value={f.instructions} onChange={(e) => set('instructions', e.target.value)} /></div>
      </div>
    </DetailModal>
  );
}

/* ==================================================================================
 *  BATCH C — student attempt player · assignment submission · faculty evaluation
 * ================================================================================== */

const ATTEMPT_STATUS_OPTS = [
  { id: 'in_progress', name: 'In progress' }, { id: 'submitted', name: 'Submitted' },
  { id: 'evaluated', name: 'Evaluated' }, { id: 'expired', name: 'Expired' },
];
const ATTEMPT_BADGE: Record<string, string> = { in_progress: 'b-amber', submitted: 'b-indigo', evaluated: 'b-green', expired: 'b-gray' };
const SUB_STATUS_OPTS = [{ id: 'submitted', name: 'Submitted' }, { id: 'evaluated', name: 'Evaluated' }, { id: 'returned', name: 'Returned' }];
const SUB_BADGE: Record<string, string> = { submitted: 'b-indigo', evaluated: 'b-green', returned: 'b-amber' };
const OBJECTIVE_TAKE = new Set(['mcq_single', 'mcq_multi', 'true_false', 'image_mcq', 'audio_mcq', 'video_mcq']);
const fmtClock = (ms: number) => {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${p(h)}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
};

/** A small student chooser used by the launch + submit flows. */
function StudentSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const students = useFetch<any[]>('/students', []);
  return (
    <select className="ainp" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— choose a student —</option>
      {(students.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.full_name}{s.student_no ? ` (${s.student_no})` : ''}</option>)}
    </select>
  );
}

/** Launch a published test for a student: assignment/practical → file submission; else → the player. */
function LaunchTest({ test, onClose, onDone }: { test: any; onClose: () => void; onDone: () => void }) {
  const [studentId, setStudentId] = useState('');
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const isFile = test.test_type === 'assignment' || test.test_type === 'practical';

  const start = async () => {
    if (!studentId) { toast('Choose a student.', true); return; }
    setBusy(true);
    try {
      const r = await api.post<any>(`/assessments/${test.id}/attempts`, { student_id: Number(studentId) });
      setAttemptId(r.attempt.id);
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  if (attemptId) return <TakeTestPlayer attemptId={attemptId} onClose={() => { setAttemptId(null); onClose(); onDone(); }} />;

  return (
    <DetailModal title={`Launch — ${test.title}`} icon="bolt" width={520} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        {!isFile && <button className="btn primary" onClick={start} disabled={busy || !studentId}><Ic k="bolt" />Start attempt</button>}
      </div>}>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Student *</label><StudentSelect value={studentId} onChange={setStudentId} /></div>
        <div className="empty-note" style={{ gridColumn: '1 / -1' }}>
          {isFile
            ? 'This is an assignment / practical test — the student submits a file below.'
            : `A timed attempt will start now${test.duration_min ? ` (${test.duration_min} min)` : ''}. Up to ${test.max_attempts} attempt(s) per student.`}
        </div>
        {test.zoom_link ? <div className="empty-note" style={{ gridColumn: '1 / -1' }}><Ic k="bolt" /> Proctored session: <a href={test.zoom_link} target="_blank" rel="noopener noreferrer">Join proctored session</a></div> : null}
      </div>
      {isFile && studentId ? <AssignmentSubmitInline testId={test.id} studentId={Number(studentId)} onDone={() => { onClose(); onDone(); }} /> : null}
    </DetailModal>
  );
}

/** File-submission block for an assignment/practical test (presigned R2 upload). */
function AssignmentSubmitInline({ testId, studentId, onDone }: { testId: number; studentId: number; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file) { toast('Choose a file first.', true); return; }
    setBusy(true);
    try {
      const { url, r2_key } = await api.post<{ url: string; r2_key: string }>('/submissions/upload-url', { file_name: file.name, content_type: file.type || 'application/octet-stream' });
      const put = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      await api.post(`/assessments/${testId}/submissions`, { student_id: studentId, file_r2_key: r2_key, original_filename: file.name, mime: file.type || null, size_bytes: file.size });
      toast('Submission uploaded'); onDone();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="sheet-sec" style={{ marginTop: 12 }}>
      <h5>Upload submission (PDF / DOC / DOCX / image)</h5>
      <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <div style={{ marginTop: 10 }}><button className="btn primary" onClick={submit} disabled={busy || !file}><Ic k="export" />Submit file</button></div>
    </div>
  );
}

/** THE TAKE-TEST PLAYER — loads a started attempt, renders every q_type, live countdown,
 *  autosave, and Submit (auto-submits at 0). */
function TakeTestPlayer({ attemptId, onClose }: { attemptId: number; onClose: () => void }) {
  const [data, setData] = useState<any | null>(null);
  const [ans, setAns] = useState<Record<number, { selected: number[]; text: string; match: Record<string, string> }>>({});
  const [result, setResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const saveTimer = useRef<any>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    api.get<any>(`/attempts/${attemptId}`).then((d) => {
      setData(d);
      const seed: any = {};
      for (const q of d.questions) seed[q.question_id] = {
        selected: (q.selected_option_ids ?? []).map(Number),
        text: q.answer_text ?? '',
        match: (() => { try { return q.answer_text && q.q_type === 'match_following' ? JSON.parse(q.answer_text) : {}; } catch { return {}; } })(),
      };
      setAns(seed);
      if (d.due_at) setLeft(new Date(d.due_at).getTime() - new Date(d.server_time).getTime());
    }).catch((e) => toast(e.message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  // countdown → auto-submit at 0
  useEffect(() => {
    if (left == null) return;
    const t = setInterval(() => setLeft((v) => (v == null ? v : v - 1000)), 1000);
    return () => clearInterval(t);
  }, [left == null]);
  useEffect(() => {
    if (left != null && left <= 0 && !submittedRef.current && data && !result) { void doSubmit(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const payload = () => (data?.questions ?? []).map((q: any) => ({
    question_id: q.question_id,
    selected_option_ids: ans[q.question_id]?.selected ?? [],
    answer_text: q.q_type === 'match_following' ? JSON.stringify(ans[q.question_id]?.match ?? {}) : (ans[q.question_id]?.text ?? ''),
  }));

  const scheduleSave = () => {
    if (result || submittedRef.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { await api.patch(`/attempts/${attemptId}/answers`, { answers: payload() }); } catch { /* silent autosave */ }
    }, 1500);
  };

  const setSel = (q: any, id: number) => {
    setAns((p) => {
      const cur = p[q.question_id] ?? { selected: [], text: '', match: {} };
      let selected: number[];
      if (q.q_type === 'mcq_multi') selected = cur.selected.includes(id) ? cur.selected.filter((x) => x !== id) : [...cur.selected, id];
      else selected = [id];
      return { ...p, [q.question_id]: { ...cur, selected } };
    });
    scheduleSave();
  };
  const setText = (q: any, v: string) => { setAns((p) => ({ ...p, [q.question_id]: { ...(p[q.question_id] ?? { selected: [], text: '', match: {} }), text: v } })); scheduleSave(); };
  const setMatch = (q: any, optId: number, v: string) => { setAns((p) => { const cur = p[q.question_id] ?? { selected: [], text: '', match: {} }; return { ...p, [q.question_id]: { ...cur, match: { ...cur.match, [optId]: v } } }; }); scheduleSave(); };

  const doSubmit = async (auto = false) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setBusy(true);
    try {
      clearTimeout(saveTimer.current);
      const r = await api.post<any>(`/attempts/${attemptId}/submit`, { answers: payload() });
      setResult(r);
      if (!auto) toast('Attempt submitted');
    } catch (e: any) { submittedRef.current = false; toast(e.message, true); } finally { setBusy(false); }
  };

  if (!data) return <DetailModal title="Loading attempt…" icon="doc" width={760} onClose={onClose}><div className="empty-note">Loading…</div></DetailModal>;

  if (result) {
    const instant = result.show_result_mode === 'instant' && !result.has_subjective && result.status === 'evaluated';
    return (
      <DetailModal title="Attempt submitted" icon="check" width={520} onClose={onClose}>
        {instant ? (
          <div style={{ textAlign: 'center', padding: 8 }}>
            <div style={{ fontSize: 30, fontWeight: 700 }}>{result.total_score} / {result.max_score}</div>
            <div className="sub" style={{ marginTop: 4 }}>Auto-scored objective test.</div>
            {result.is_passed != null ? <div style={{ marginTop: 8 }}><span className={`badge ${result.is_passed ? 'b-green' : 'b-rose'}`}>{result.is_passed ? 'PASSED' : 'FAILED'}</span></div> : null}
          </div>
        ) : (
          <div className="empty-note">Your response has been submitted for evaluation. Results will be released by your faculty.</div>
        )}
      </DetailModal>
    );
  }

  return (
    <DetailModal title={data.assessment_title} icon="doc" width={820} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
        {left != null ? <span className={`badge ${left < 60_000 ? 'b-rose' : 'b-indigo'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>⏱ {fmtClock(left)}</span> : <span className="sub">Untimed</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={busy}>Close</button>
          <button className="btn primary" onClick={() => doSubmit(false)} disabled={busy}><Ic k="check" />Submit attempt</button>
        </div>
      </div>}>
      {left != null && left < 60_000 ? <div className="empty-note" style={{ color: 'var(--danger)', marginBottom: 8 }}>Less than a minute remaining — the attempt auto-submits at 0.</div> : null}
      {data.zoom_link ? <div className="empty-note" style={{ marginBottom: 10 }}><Ic k="bolt" /> Proctored session: <a href={data.zoom_link} target="_blank" rel="noopener noreferrer">Join proctored session</a></div> : null}
      {data.questions.map((q: any, i: number) => (
        <div key={q.question_id} style={{ marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid var(--line)' }}>
          <div style={{ fontSize: 14 }}><b>{i + 1}.</b> {q.body} <span className="sub">({q.marks}m)</span></div>
          {q.image_url ? <img src={q.image_url} alt="q" style={{ maxHeight: 140, borderRadius: 6, marginTop: 6 }} /> : null}
          {q.audio_url ? <audio controls src={q.audio_url} style={{ width: '100%', marginTop: 6 }} /> : null}
          {youtubeEmbed(q.youtube_url, q.youtube_start_sec, q.youtube_end_sec) ? <div style={{ position: 'relative', paddingTop: '38%', maxWidth: 420, marginTop: 6 }}><iframe title="yt" src={youtubeEmbed(q.youtube_url, q.youtube_start_sec, q.youtube_end_sec)!} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, borderRadius: 8 }} allowFullScreen /></div> : null}
          <div style={{ marginTop: 8 }}>
            {OBJECTIVE_TAKE.has(q.q_type) ? (
              <div style={{ display: 'grid', gap: 5 }}>
                {q.options.map((o: any, oi: number) => (
                  <label key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
                    <input type={q.q_type === 'mcq_multi' ? 'checkbox' : 'radio'} name={`q${q.question_id}`}
                      checked={(ans[q.question_id]?.selected ?? []).includes(o.id)} onChange={() => setSel(q, o.id)} />
                    <span className="sub">{String.fromCharCode(65 + oi)}.</span> {o.body}
                    {o.image_url ? <img src={o.image_url} alt="opt" style={{ maxHeight: 44, borderRadius: 4 }} /> : null}
                  </label>
                ))}
              </div>
            ) : q.q_type === 'fill_blank' ? (
              <input className="ainp" value={ans[q.question_id]?.text ?? ''} onChange={(e) => setText(q, e.target.value)} placeholder="Type your answer" />
            ) : q.q_type === 'match_following' ? (
              <div style={{ display: 'grid', gap: 5 }}>
                {q.options.map((o: any) => (
                  <div key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
                    <span style={{ minWidth: 160 }}>{o.body}</span> →
                    <input className="ainp" style={{ flex: 1 }} value={ans[q.question_id]?.match?.[o.id] ?? ''} onChange={(e) => setMatch(q, o.id, e.target.value)} placeholder="matching value" />
                  </div>
                ))}
              </div>
            ) : (
              <textarea className="ainp" rows={q.q_type === 'writing' || q.q_type === 'essay' || q.q_type === 'long_answer' || q.q_type === 'case_study' ? 6 : 3}
                value={ans[q.question_id]?.text ?? ''} onChange={(e) => setText(q, e.target.value)} placeholder="Write your response" />
            )}
          </div>
        </div>
      ))}
    </DetailModal>
  );
}

/* ------------------------------------------------------- FACULTY EVALUATION ---- */

export function AssessmentEvaluationScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [tab, setTab] = useState<'attempts' | 'submissions'>('attempts');
  const [tick, setTick] = useState(0);
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fStatus, setFStatus] = useState<string[]>([]);
  const [evalAttempt, setEvalAttempt] = useState<any | null>(null);
  const [evalSub, setEvalSub] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fStatus.length) qs.set('status', fStatus.join(','));
  const attempts = useFetch<any[]>(`/attempts?${qs.toString()}`, [tab, qs.toString(), tick]);
  const submissions = useFetch<any[]>(`/submissions?${qs.toString()}`, [tab, qs.toString(), tick]);
  const aRows = attempts.data ?? [];
  const sRows = submissions.data ?? [];

  const runExpiry = async () => {
    setBusy(true);
    try { const r = await api.post<any>('/attempts/expire', {}); toast(r.expired ? `${r.expired} overdue attempt(s) expired & scored` : 'No overdue attempts'); after(); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-actions" style={{ display: 'flex', gap: 8 }}>
        <div className="seg">
          <button className={`seg-btn ${tab === 'attempts' ? 'on' : ''}`} onClick={() => setTab('attempts')}>Attempts</button>
          <button className={`seg-btn ${tab === 'submissions' ? 'on' : ''}`} onClick={() => setTab('submissions')}>Assignment submissions</button>
        </div>
        {can('assessment_attempt.update') && <button className="btn" onClick={runExpiry} disabled={busy}><Ic k="clock" />Run expiry sweep</button>}
      </div>
      <Kpis items={tab === 'attempts' ? [
        { lab: 'Attempts', val: String(aRows.length), ic: 'doc' },
        { lab: 'Awaiting evaluation', val: String(aRows.filter((r: any) => r.status === 'submitted').length), ic: 'clock' },
        { lab: 'Evaluated', val: String(aRows.filter((r: any) => r.status === 'evaluated').length), ic: 'check' },
        { lab: 'Expired', val: String(aRows.filter((r: any) => r.status === 'expired').length), ic: 'shield' },
      ] : [
        { lab: 'Submissions', val: String(sRows.length), ic: 'doc' },
        { lab: 'Awaiting evaluation', val: String(sRows.filter((r: any) => r.status === 'submitted').length), ic: 'clock' },
        { lab: 'Evaluated', val: String(sRows.filter((r: any) => r.status === 'evaluated').length), ic: 'check' },
      ]} />
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
        <EnumMulti label="Status" icon="shield" value={fStatus} options={tab === 'attempts' ? ATTEMPT_STATUS_OPTS : SUB_STATUS_OPTS} onChange={setFStatus} />
      </div>
      {tab === 'attempts' ? (
        <TableCard fill title="Attempt evaluation queue" icon="doc"
          more={<ListActions onExport={() => downloadObjectsCsv('attempts.csv', aRows.map((r: any) => ({
            student: r.student_name, student_no: r.student_no, test: r.assessment_title, type: TEST_TYPE_LABEL[r.test_type] ?? r.test_type,
            attempt: r.attempt_no, status: r.status, auto: r.auto_score, manual: r.manual_score, total: r.total_score, max: r.max_score,
            passed: r.is_passed == null ? '' : (r.is_passed ? 'Yes' : 'No'), submitted: fmtDT(r.submitted_at), branch: r.branch_name, vertical: r.vertical_name,
          })))} onRefresh={after} />}
          cols={['Student', 'Test', 'Attempt', 'Auto', 'Total / Max', 'Result', 'Status', 'Submitted', 'Actions']}
          empty="No attempts yet — launch a test for a student from Tests / Exams."
          rows={aRows.map((r: any) => [
            { node: <div><b className="nm">{r.student_name}</b>{r.student_no ? <div className="sub">{r.student_no}</div> : null}</div> } as Cell,
            { node: <div>{r.assessment_title}<div className="sub">{TEST_TYPE_LABEL[r.test_type] ?? r.test_type}</div></div> } as Cell,
            `#${r.attempt_no}`,
            r.auto_score != null ? String(r.auto_score) : '—',
            r.total_score != null ? `${r.total_score} / ${r.max_score}` : `— / ${r.max_score}`,
            { node: r.is_passed == null ? <span className="sub">—</span> : <span className={`badge ${r.is_passed ? 'b-green' : 'b-rose'}`}>{r.is_passed ? 'Pass' : 'Fail'}</span> } as Cell,
            { b: [r.status, ATTEMPT_BADGE[r.status] ?? 'b-gray'] } as Cell,
            fmtDT(r.submitted_at),
            rowActions({
              onView: () => setEvalAttempt(r),
              extra: can('assessment.evaluate') && (r.status === 'submitted' || r.status === 'evaluated') ? [{ k: 'check', title: 'Evaluate', onClick: () => setEvalAttempt(r) }] : [],
            }),
          ])} />
      ) : (
        <TableCard fill title="Assignment submission queue" icon="doc"
          more={<ListActions onExport={() => downloadObjectsCsv('submissions.csv', sRows.map((r: any) => ({
            student: r.student_name, student_no: r.student_no, test: r.assessment_title, file: r.original_filename,
            status: r.status, marks: r.marks, max: r.max_marks, passed: r.is_passed == null ? '' : (r.is_passed ? 'Yes' : 'No'),
            submitted: fmtDT(r.submitted_at), branch: r.branch_name, vertical: r.vertical_name,
          })))} onRefresh={after} />}
          cols={['Student', 'Test', 'File', 'Marks / Max', 'Result', 'Status', 'Submitted', 'Actions']}
          empty="No submissions yet — an assignment/practical test collects a file from the student."
          rows={sRows.map((r: any) => [
            { node: <div><b className="nm">{r.student_name}</b>{r.student_no ? <div className="sub">{r.student_no}</div> : null}</div> } as Cell,
            r.assessment_title,
            { node: r.file_url ? <a href={r.file_url} target="_blank" rel="noreferrer">{r.original_filename ?? 'file'}</a> : (r.original_filename ?? '—') } as Cell,
            r.marks != null ? `${r.marks} / ${r.max_marks}` : `— / ${r.max_marks}`,
            { node: r.is_passed == null ? <span className="sub">—</span> : <span className={`badge ${r.is_passed ? 'b-green' : 'b-rose'}`}>{r.is_passed ? 'Pass' : 'Fail'}</span> } as Cell,
            { b: [r.status, SUB_BADGE[r.status] ?? 'b-gray'] } as Cell,
            fmtDT(r.submitted_at),
            rowActions({ extra: can('assessment.evaluate') ? [{ k: 'check', title: 'Evaluate', onClick: () => setEvalSub(r) }] : [] }),
          ])} />
      )}
      {evalAttempt && <AttemptEvaluationModal attemptId={evalAttempt.id} onClose={() => setEvalAttempt(null)} onSaved={() => { setEvalAttempt(null); after(); }} />}
      {evalSub && <SubmissionEvaluationModal sub={evalSub} onClose={() => setEvalSub(null)} onSaved={() => { setEvalSub(null); after(); }} />}
    </>
  );
}

function AttemptEvaluationModal({ attemptId, onClose, onSaved }: { attemptId: number; onClose: () => void; onSaved: () => void }) {
  const { can } = useAuth();
  const [d, setD] = useState<any | null>(null);
  const [marks, setMarks] = useState<Record<number, string>>({});
  const [fb, setFb] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<any>(`/attempts/${attemptId}`).then((x) => {
      setD(x);
      const m: any = {}; const f: any = {};
      for (const q of x.questions) { if (!q.objective) { m[q.question_id] = q.evaluator_marks != null ? String(q.evaluator_marks) : ''; f[q.question_id] = q.evaluator_feedback ?? ''; } }
      setMarks(m); setFb(f);
    }).catch((e) => toast(e.message, true));
  }, [attemptId]);

  const subj = (d?.questions ?? []).filter((q: any) => !q.objective);
  const runningManual = subj.reduce((s: number, q: any) => s + (marks[q.question_id] !== '' && marks[q.question_id] != null ? Number(marks[q.question_id]) : 0), 0);
  const total = Number(d?.auto_score ?? 0) + runningManual;

  const save = async () => {
    setBusy(true);
    try {
      const answers = subj.map((q: any) => ({ question_id: q.question_id, evaluator_marks: marks[q.question_id] === '' ? null : Number(marks[q.question_id]), evaluator_feedback: fb[q.question_id] || null }));
      const r = await api.patch<any>(`/attempts/${attemptId}/evaluate`, { answers });
      toast(`Evaluated — total ${r.total_score} / ${r.max_score}`); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  if (!d) return <DetailModal title="Loading attempt…" icon="doc" width={760} onClose={onClose}><div className="empty-note">Loading…</div></DetailModal>;
  const readOnly = !can('assessment.evaluate');

  return (
    <DetailModal title={`Evaluate — ${d.student_name}`} icon="check" width={820} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
        <span className="sub">Auto {d.auto_score ?? 0} + Manual {runningManual} = <b>{total}</b> / {d.max_score}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={busy}>Close</button>
          {!readOnly && <button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save evaluation</button>}
        </div>
      </div>}>
      <div className="empty-note" style={{ marginBottom: 10 }}>{d.assessment_title} · Attempt #{d.attempt_no} · {d.status}. Objective answers are auto-scored; grade the subjective ones below.</div>
      {d.questions.map((q: any, i: number) => (
        <div key={q.question_id} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--line)' }}>
          <div style={{ fontSize: 13.5 }}><b>{i + 1}.</b> {q.body} <span className="sub">({q.marks}m)</span>
            {q.objective ? <span className={`badge ${q.is_correct ? 'b-green' : 'b-rose'}`} style={{ marginLeft: 6 }}>{q.is_correct ? `+${q.awarded_marks}` : `${q.awarded_marks}`}</span> : <span className="badge b-amber" style={{ marginLeft: 6 }}>subjective</span>}
          </div>
          {q.objective ? (
            <div style={{ display: 'grid', gap: 3, marginTop: 5 }}>
              {q.options.map((o: any, oi: number) => {
                const chosen = (q.selected_option_ids ?? []).includes(o.id);
                return <div key={o.id} style={{ fontSize: 13, color: o.is_correct ? 'var(--success)' : (chosen ? 'var(--danger)' : 'var(--text)') }}>
                  {chosen ? '☑' : '☐'} <span className="sub">{String.fromCharCode(65 + oi)}.</span> {o.body} {o.is_correct ? '✓' : ''}
                </div>;
              })}
              {q.q_type === 'fill_blank' ? <div className="sub">Typed: “{q.answer_text || '—'}”</div> : null}
            </div>
          ) : (
            <div style={{ marginTop: 6 }}>
              <div style={{ background: 'var(--surface-2, rgba(127,127,127,.08))', borderRadius: 6, padding: 8, fontSize: 13, whiteSpace: 'pre-wrap' }}>{q.answer_text || <span className="sub">No response</span>}</div>
              {q.file_r2_key ? <div className="sub" style={{ marginTop: 4 }}>Attached file answer</div> : null}
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <label style={{ fontSize: 12 }}>Marks (0–{q.marks})</label>
                <input className="ainp" style={{ width: 90 }} type="number" min={0} max={q.marks} step="0.5" disabled={readOnly}
                  value={marks[q.question_id] ?? ''} onChange={(e) => setMarks((p) => ({ ...p, [q.question_id]: e.target.value }))} />
                <input className="ainp" style={{ flex: 1 }} placeholder="Feedback (optional)" disabled={readOnly}
                  value={fb[q.question_id] ?? ''} onChange={(e) => setFb((p) => ({ ...p, [q.question_id]: e.target.value }))} />
              </div>
            </div>
          )}
        </div>
      ))}
    </DetailModal>
  );
}

function SubmissionEvaluationModal({ sub, onClose, onSaved }: { sub: any; onClose: () => void; onSaved: () => void }) {
  const { can } = useAuth();
  const [marks, setMarks] = useState<string>(sub.marks != null ? String(sub.marks) : '');
  const [feedback, setFeedback] = useState<string>(sub.feedback ?? '');
  const [status, setStatus] = useState<string>(sub.status === 'submitted' ? 'evaluated' : sub.status);
  const [busy, setBusy] = useState(false);
  const readOnly = !can('assessment.evaluate');
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.patch<any>(`/submissions/${sub.id}/evaluate`, { marks: marks === '' ? null : Number(marks), feedback: feedback || null, status });
      toast(`Saved — ${r.marks ?? '—'} / ${r.max_marks}`); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`Evaluate submission — ${sub.student_name}`} icon="check" width={560} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button>{!readOnly && <button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button>}</div>}>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Submitted file</label>
          {sub.file_url ? <a className="btn" href={sub.file_url} target="_blank" rel="noreferrer"><Ic k="export" />Open {sub.original_filename ?? 'file'}</a> : <span className="sub">{sub.original_filename ?? '—'}</span>}
        </div>
        <div className="fld"><label>Marks (0–{sub.max_marks})</label><input className="ainp" type="number" min={0} max={sub.max_marks} step="0.5" value={marks} onChange={(e) => setMarks(e.target.value)} disabled={readOnly} /></div>
        <div className="fld"><label>Status</label><select className="ainp" value={status} onChange={(e) => setStatus(e.target.value)} disabled={readOnly}>{SUB_STATUS_OPTS.filter((o) => o.id !== 'submitted').map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Feedback</label><textarea className="ainp" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} disabled={readOnly} /></div>
      </div>
    </DetailModal>
  );
}

/* ============================================================================
 * BATCH D — RESULTS · ANALYTICS · GRADING · CERTIFICATES · DASHBOARDS
 * ==========================================================================*/

/** Auth-aware PDF open (window.open can't set headers, so fetch as a blob first). */
async function openPdfAuthed(path: string) {
  try {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`Could not open the PDF (${res.status}).`);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e: any) { toast(e.message, true); }
}

function useStudentsD(branchIds: number[], verticalIds: number[]) {
  const p = new URLSearchParams(); p.set('limit', '500');
  if (branchIds.length) p.set('branch_id', branchIds.join(','));
  if (verticalIds.length) p.set('vertical_id', verticalIds.join(','));
  return useFetch<any[]>(`/students?${p.toString()}`, [p.toString()]);
}

const GRADE_BADGE = (g?: string | null) => {
  if (!g) return 'b-gray';
  if (/^A/.test(g)) return 'b-green';
  if (/^B/.test(g)) return 'b-indigo';
  if (/^C/.test(g)) return 'b-amber';
  return 'b-rose';
};

/** A tiny horizontal bar (percentage 0..100). */
function Bar({ label, pct, sub, color }: { label: string; pct: number; sub?: string; color?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
        <span>{label}</span><span className="sub">{sub ?? `${Math.round(pct)}%`}</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: color ?? 'var(--indigo)' }} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- RESULTS ---- */
export function AssessmentResultsScreen() {
  const rd = useRef_();
  const { can } = useAuth();
  const { scope: gScope } = useScope();
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fCourse, setFCourse] = useState<number[]>([]);
  const [tick, setTick] = useState(0);
  const [testId, setTestId] = useState('');
  const [card, setCard] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const after = () => setTick((t) => t + 1);
  const bulkIssue = async () => {
    if (!testId) return;
    setBusy(true);
    try { const r = await api.post<any>('/assessment-certificates/bulk-issue', { assessment_id: Number(testId) }); toast(r.issued ? `${r.issued} certificate(s) issued` : 'No new certificates to issue (all passed students already have one)'); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  // Governance: release results/grades to students (results.publish — Academic Admin / Super Admin)
  const releaseAll = async () => {
    if (!testId) return;
    setBusy(true);
    try { const r = await api.post<any>(`/assessments/${testId}/release-results`, {}); toast(r.released ? `${r.released} result(s) released to students` : 'No pending results to release'); after(); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const releaseOne = async (r: any) => {
    try { await api.post(`/attempts/${r.attempt_id}/release-result`, {}); toast('Result released to student'); after(); }
    catch (e: any) { toast(e.message, true); }
  };

  const tqs = new URLSearchParams();
  if (fB.length) tqs.set('branch_id', fB.join(','));
  if (fV.length) tqs.set('vertical_id', fV.join(','));
  if (fCourse.length) tqs.set('course_id', fCourse.join(','));
  const tests = useFetch<any[]>(`/assessments?${tqs.toString()}`, [tqs.toString(), tick]);
  const board = useFetch<any>(testId ? `/assessments/${testId}/results` : null, [testId, tick]);
  const b = board.data;
  const rows: any[] = b?.results ?? [];

  return (
    <>
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
        <FilterMulti label="Course" icon="doc" value={fCourse} options={rd.courses} onChange={setFCourse} />
        <label className="fchip"><Ic k="doc" />
          <select value={testId} onChange={(e) => setTestId(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12, minWidth: 200 }}>
            <option value="">— choose a test —</option>
            {(tests.data ?? []).filter((t: any) => t.status !== 'draft').map((t: any) => <option key={t.id} value={t.id}>{t.title} ({TEST_TYPE_LABEL[t.test_type] ?? t.test_type})</option>)}
          </select></label>
      </div>
      {b && (
        <Kpis cols={4} items={[
          { lab: 'Students', val: String(b.summary.students), ic: 'users' },
          { lab: 'Passed', val: String(b.summary.passed), ic: 'check' },
          { lab: 'Pass rate', val: `${b.summary.pass_rate}%`, ic: 'target' },
          { lab: 'Average %', val: `${b.summary.avg_pct}%`, ic: 'bolt' },
        ]} />
      )}
      {b && (can('results.publish') || (can('assessment_certificate.issue') && b.summary.passed > 0)) && (
        <div className="page-actions" style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
          {can('results.publish') && <button className="btn primary" onClick={releaseAll} disabled={busy}><Ic k="send" />Release results to students</button>}
          {can('assessment_certificate.issue') && b.summary.passed > 0 && <button className="btn" onClick={bulkIssue} disabled={busy}><Ic k="shield" />Issue certificates for all passed ({b.summary.passed})</button>}
        </div>
      )}
      <TableCard fill title={b ? `Leaderboard — ${b.assessment.title}` : 'Results'} icon="doc" listKey="assessment-results"
        more={<ListActions onExport={() => downloadObjectsCsv('results.csv', rows.map((r: any) => ({
          rank: r.rank, student: r.student_name, student_no: r.student_no, score: r.total_score, max: r.max_score,
          percentage: r.percentage, grade: r.grade_label, result: r.is_passed ? 'Pass' : 'Fail', percentile: r.percentile,
          branch: r.branch_name, vertical: r.vertical_name,
        })))} onRefresh={after} />}
        cols={['Rank', 'Student', 'Score', '%', 'Grade', 'Result', 'Percentile', 'Actions']}
        empty={testId ? 'No evaluated results for this test yet.' : 'Choose a test to see its leaderboard.'}
        rows={rows.map((r: any) => [
          { node: <b>#{r.rank}</b> } as Cell,
          { node: <div><b className="nm">{r.student_name}</b>{r.student_no ? <div className="sub">{r.student_no}</div> : null}</div> } as Cell,
          `${r.total_score} / ${r.max_score}`,
          `${r.percentage}%`,
          { node: <span className={`badge ${GRADE_BADGE(r.grade_label)}`}>{r.grade_label ?? '—'}</span> } as Cell,
          { node: <span className={`badge ${r.is_passed ? 'b-green' : 'b-rose'}`}>{r.is_passed ? 'Pass' : 'Fail'}</span> } as Cell,
          `${r.percentile}%`,
          rowActions({ onView: () => setCard(r), extra: can('results.publish') ? [{ k: 'send', title: 'Release this result', onClick: () => releaseOne(r) }] : [] }),
        ])} />
      {card && <ResultCardModal attemptId={card.attempt_id} studentId={card.student_id} onClose={() => setCard(null)} />}
    </>
  );
}

function ResultCardModal({ attemptId, studentId, onClose }: { attemptId: number; studentId: number; onClose: () => void }) {
  const res = useFetch<any>(`/attempts/${attemptId}/result`, [attemptId]);
  const rep = useFetch<any>(studentId ? `/assessment-reports/student?student_id=${studentId}` : null, [studentId]);
  const d = res.data;
  const overall = rep.data;
  return (
    <DetailModal title="Result card" icon="doc" width={720} onClose={onClose}>
      {!d ? <div className="sub">Loading…</div> : d.available === false ? (
        <div className="empty" style={{ padding: 24 }}>{d.reason || 'This result is not available yet.'}</div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <b style={{ fontSize: 16 }}>{d.student_name}</b>
              <div className="sub">{d.assessment_title} · Attempt #{d.attempt_no}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span className={`badge ${GRADE_BADGE(d.grade_label)}`} style={{ fontSize: 15 }}>{d.grade_label ?? '—'}</span>
              <div className={`badge ${d.is_passed ? 'b-green' : 'b-rose'}`} style={{ marginTop: 4 }}>{d.is_passed ? 'Passed' : 'Failed'}</div>
            </div>
          </div>
          <Kpis cols={4} items={[
            { lab: 'Score', val: `${d.total_score ?? '—'} / ${d.max_score}`, ic: 'doc' },
            { lab: 'Percentage', val: d.percentage != null ? `${d.percentage}%` : '—', ic: 'target' },
            { lab: 'Time taken', val: d.time_taken_sec != null ? `${Math.floor(d.time_taken_sec / 60)}m ${d.time_taken_sec % 60}s` : '—', ic: 'clock' },
            { lab: 'Auto / Manual', val: `${d.auto_score ?? 0} / ${d.manual_score ?? 0}`, ic: 'bolt' },
          ]} />
          {overall?.kpis && (
            <Section title="This student — across all tests">
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
                <KV rows={[
                  ['Attempts', String(overall.kpis.attempts)],
                  ['Avg %', overall.kpis.avg_pct != null ? `${overall.kpis.avg_pct}%` : '—'],
                  ['Pass rate', overall.kpis.pass_rate != null ? `${overall.kpis.pass_rate}%` : '—'],
                  ['Certificates', String(overall.kpis.certificates)],
                ]} />
              </div>
              {(overall.trend ?? []).length > 1 ? overall.trend.map((t: any, i: number) => (
                <Bar key={i} label={t.label} pct={t.percentage} sub={`${t.percentage}%${t.grade ? ` · ${t.grade}` : ''}`} color="var(--indigo)" />
              )) : null}
            </Section>
          )}
          {d.analytics && (
            <>
              <Section title="Answer summary">
                <KV rows={[
                  ['Correct', String(d.analytics.counts.correct)],
                  ['Incorrect', String(d.analytics.counts.incorrect)],
                  ['Unattempted', String(d.analytics.counts.unattempted)],
                  d.analytics.counts.subjective_pending ? ['Pending eval', String(d.analytics.counts.subjective_pending)] : null,
                ]} />
              </Section>
              {d.analytics.by_topic?.length ? (
                <Section title="By topic / section">
                  {d.analytics.by_topic.map((t: any) => <Bar key={t.key} label={t.key} pct={t.score_pct} sub={`${t.correct}/${t.total} · ${t.score_pct}%`} color="var(--indigo)" />)}
                </Section>
              ) : null}
              {d.analytics.by_difficulty?.length ? (
                <Section title="By difficulty">
                  {d.analytics.by_difficulty.map((t: any) => <Bar key={t.key} label={t.key} pct={t.accuracy_pct} sub={`${t.correct}/${t.total} correct`} color="var(--green)" />)}
                </Section>
              ) : null}
              {d.analytics.by_type?.length ? (
                <Section title="By question type">
                  {d.analytics.by_type.map((t: any) => <Bar key={t.key} label={Q_TYPE_LABEL[t.key] ?? t.key} pct={t.accuracy_pct} sub={`${t.correct}/${t.total} correct`} color="var(--amber)" />)}
                </Section>
              ) : null}
            </>
          )}
        </>
      )}
    </DetailModal>
  );
}

/* ------------------------------------------------------------ GRADE SCHEMES -- */
const DEFAULT_BANDS = [
  { label: 'Fail', min_pct: 0, max_pct: 50, is_pass: false },
  { label: 'C', min_pct: 50, max_pct: 60, is_pass: true },
  { label: 'B', min_pct: 60, max_pct: 70, is_pass: true },
  { label: 'B+', min_pct: 70, max_pct: 80, is_pass: true },
  { label: 'A', min_pct: 80, max_pct: 90, is_pass: true },
  { label: 'A+', min_pct: 90, max_pct: 100, is_pass: true },
];
function validateBandsClient(bands: any[]): string | null {
  if (bands.length < 2) return 'A scheme needs at least two bands.';
  const bs = bands.map((b) => ({ ...b, min_pct: Number(b.min_pct), max_pct: Number(b.max_pct) }));
  for (const b of bs) {
    if (!String(b.label).trim()) return 'Every band needs a label.';
    if (!Number.isFinite(b.min_pct) || !Number.isFinite(b.max_pct)) return `Band "${b.label}" has a non-numeric bound.`;
    if (b.min_pct < 0 || b.max_pct > 100) return `Band "${b.label}" must lie within 0–100.`;
    if (b.min_pct >= b.max_pct) return `Band "${b.label}" has min ≥ max.`;
  }
  const sorted = [...bs].sort((a, b) => a.min_pct - b.min_pct);
  if (sorted[0].min_pct !== 0) return 'The lowest band must start at 0%.';
  if (sorted[sorted.length - 1].max_pct !== 100) return 'The highest band must end at 100%.';
  for (let i = 1; i < sorted.length; i++) if (sorted[i].min_pct !== sorted[i - 1].max_pct) return `Bands must be contiguous — "${sorted[i - 1].label}" ends at ${sorted[i - 1].max_pct}% but "${sorted[i].label}" starts at ${sorted[i].min_pct}%.`;
  if (!bs.some((b) => b.is_pass)) return 'At least one band must be a PASS band.';
  return null;
}

export function GradeSchemesScreen() {
  const rd = useRef_();
  const { can } = useAuth();
  const { scope: gScope } = useScope();
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [tick, setTick] = useState(0);
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  const list = useFetch<any[]>(`/grade-schemes?${qs.toString()}`, [qs.toString(), tick]);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Grade scheme', '/grade-schemes/bulk-delete/impact', '/grade-schemes/bulk-delete', () => { after(); clear(); });

  const setDefault = async (r: any) => { try { await api.post(`/grade-schemes/${r.id}/set-default`, {}); toast(`"${r.name}" is now the default`); after(); } catch (e: any) { toast(e.message, true); } };
  const doDelete = async () => { try { await api.del(`/grade-schemes/${del.id}`); toast('Scheme deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('grade_scheme.create') && <div className="page-actions"><button className="btn primary" onClick={() => setEdit({ id: null, name: '', bands: DEFAULT_BANDS.map((b) => ({ ...b })) })}><Ic k="plus" />New grade scheme</button></div>}
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
      </div>
      <BulkBar count={count} entityLabel="Grade scheme" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Grade Schemes" icon="grid" listKey="grade-schemes"
        select={can('grade_scheme.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('grade-schemes.csv', rows.map((r: any) => ({ name: r.name, default: r.is_default ? 'Yes' : 'No', bands: r.band_count, branch: r.branch_name, vertical: r.vertical_name, active: r.active ? 'Yes' : 'No' })))} onRefresh={after} />}
        cols={['Name', 'Default', 'Bands', 'Scope', 'Active', 'Actions']}
        empty="No grade schemes — the India default is seeded on first run."
        rows={rows.map((r: any) => [
          r.name,
          { node: r.is_default ? <span className="badge b-green">Default</span> : <span className="sub">—</span> } as Cell,
          String(r.band_count),
          r.branch_name || r.vertical_name ? [r.branch_name, r.vertical_name].filter(Boolean).join(' · ') : 'Org-wide',
          { b: [r.active ? 'active' : 'inactive', r.active ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({
            onView: () => setEdit(r),
            extra: [
              ...(can('grade_scheme.update') && !r.is_default ? [{ k: 'check', title: 'Make default', onClick: () => setDefault(r) }] : []),
            ],
            onDelete: can('grade_scheme.delete') && !r.is_default ? () => setDel(r) : undefined,
          }),
        ])} />
      {edit && <GradeSchemeModal scheme={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); after(); }} />}
      {del && <ConfirmModal title="Delete grade scheme?" body={`Delete "${del.name}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function GradeSchemeModal({ scheme, onClose, onSaved }: { scheme: any; onClose: () => void; onSaved: () => void }) {
  const isNew = scheme.id == null;
  const [name, setName] = useState(scheme.name ?? '');
  const [active, setActive] = useState(scheme.active !== false);
  const [bands, setBands] = useState<any[]>(() => (scheme.bands?.length ? scheme.bands.map((b: any) => ({ ...b })) : DEFAULT_BANDS.map((b) => ({ ...b }))));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');

  useEffect(() => {
    if (!isNew && scheme.id != null && !scheme.bands) {
      api.get<any>(`/grade-schemes/${scheme.id}`).then((full) => { setName(full.name); setActive(full.active); setBands(full.bands.map((b: any) => ({ ...b }))); }).catch(() => {});
    }
  }, [scheme.id]);

  const upd = (i: number, patch: any) => setBands((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const addBand = () => setBands((bs) => [...bs, { label: '', min_pct: bs.length ? bs[bs.length - 1].max_pct : 0, max_pct: 100, is_pass: true }]);
  const rm = (i: number) => setBands((bs) => bs.filter((_, j) => j !== i));

  const save = async () => {
    setErr('');
    if (!name.trim()) return setErr('Give the grade scheme a name.');
    const v = validateBandsClient(bands);
    if (v) return setErr(v);
    setBusy(true);
    try {
      const body = { name: name.trim(), active, bands: bands.map((b) => ({ label: String(b.label).trim(), min_pct: Number(b.min_pct), max_pct: Number(b.max_pct), is_pass: !!b.is_pass })) };
      if (isNew) await api.post('/grade-schemes', body); else await api.patch(`/grade-schemes/${scheme.id}`, body);
      toast('Grade scheme saved'); onSaved();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <DetailModal title={isNew ? 'New grade scheme' : 'Edit grade scheme'} icon="grid" width={640} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="fld"><label>Name *</label><input className="ainp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. India Standard" /></div>
      <label className="chk" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
      <Section title="Bands (contiguous 0–100, at least one pass)">
        <table className="mini-table" style={{ width: '100%', fontSize: 13 }}>
          <thead><tr><th>Label</th><th>Min %</th><th>Max %</th><th>Pass</th><th></th></tr></thead>
          <tbody>
            {bands.map((b, i) => (
              <tr key={i}>
                <td><input className="ainp" style={{ width: 80 }} value={b.label} onChange={(e) => upd(i, { label: e.target.value })} /></td>
                <td><input className="ainp" style={{ width: 70 }} type="number" value={b.min_pct} onChange={(e) => upd(i, { min_pct: e.target.value })} /></td>
                <td><input className="ainp" style={{ width: 70 }} type="number" value={b.max_pct} onChange={(e) => upd(i, { max_pct: e.target.value })} /></td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!b.is_pass} onChange={(e) => upd(i, { is_pass: e.target.checked })} /></td>
                <td><button className="btn ghost sm" onClick={() => rm(i)}><Ic k="trash" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn sm" style={{ marginTop: 8 }} onClick={addBand}><Ic k="plus" />Add band</button>
      </Section>
      {err && <div className="form-err" style={{ color: 'var(--rose)', marginTop: 8 }}>{err}</div>}
    </DetailModal>
  );
}

/* --------------------------------------------------------------- CERTIFICATES */
export function AssessmentCertificatesScreen() {
  const rd = useRef_();
  const { can } = useAuth();
  const { scope: gScope } = useScope();
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fstat, setFstat] = useState('');
  const [tick, setTick] = useState(0);
  const [issue, setIssue] = useState(false);
  const [revoke, setRevoke] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fstat) qs.set('status', fstat);
  const list = useFetch<any[]>(`/assessment-certificates?${qs.toString()}`, [qs.toString(), tick]);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Certificate', '/assessment-certificates/bulk-delete/impact', '/assessment-certificates/bulk-delete', () => { after(); clear(); });

  const doRevoke = async (reason: string) => { try { await api.post(`/assessment-certificates/${revoke.id}/revoke`, { reason }); toast('Certificate revoked'); setRevoke(null); after(); } catch (e: any) { toast(e.message, true); } };
  const doDelete = async () => { try { await api.del(`/assessment-certificates/${del.id}`); toast('Certificate deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };
  const copyVerify = (code: string) => { const link = `${window.location.origin}/verify/certificate/${code}`; navigator.clipboard?.writeText(link); toast('Verification link copied'); };

  return (
    <>
      {can('assessment_certificate.issue') && <div className="page-actions"><button className="btn primary" onClick={() => setIssue(true)}><Ic k="plus" />Issue certificate</button></div>}
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
        <label className="fchip"><Ic k="shield" />
          <select value={fstat} onChange={(e) => setFstat(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
            <option value="">All</option><option value="issued">Issued</option><option value="revoked">Revoked</option></select></label>
      </div>
      <BulkBar count={count} entityLabel="Certificate" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Assessment Certificates" icon="shield" listKey="assessment-certificates"
        select={can('assessment_certificate.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('certificates.csv', rows.map((r: any) => ({
          certificate_no: r.certificate_no, student: r.student_name, student_no: r.student_no, title: r.title,
          test: r.assessment_title, grade: r.grade_label, percentage: r.percentage, issued: fmtFull(r.issued_on),
          status: r.status, verify_code: r.verify_code, branch: r.branch_name, vertical: r.vertical_name,
        })))} onRefresh={after} />}
        cols={['Certificate No', 'Student', 'Test', 'Grade', '%', 'Issued', 'Status', 'Actions']}
        empty="No certificates issued yet — issue one for a passed, evaluated attempt."
        rows={rows.map((r: any) => [
          { mono: r.certificate_no } as Cell,
          { node: <div><b className="nm">{r.student_name}</b>{r.student_no ? <div className="sub">{r.student_no}</div> : null}</div> } as Cell,
          r.assessment_title ?? '—',
          { node: <span className={`badge ${GRADE_BADGE(r.grade_label)}`}>{r.grade_label ?? '—'}</span> } as Cell,
          r.percentage != null ? `${r.percentage}%` : '—',
          fmtFull(r.issued_on),
          { b: [r.status, r.status === 'issued' ? 'b-green' : 'b-red'] } as Cell,
          rowActions({
            extra: [
              { k: 'doc', title: 'Download PDF', onClick: async () => { try { const { url } = await api.get<any>(`/assessment-certificates/${r.id}/file`); if (url) window.open(url, '_blank', 'noopener'); else openPdfAuthed(`/assessment-certificates/${r.id}/pdf`); } catch { openPdfAuthed(`/assessment-certificates/${r.id}/pdf`); } } },
              { k: 'link', title: 'Copy verification link', onClick: () => copyVerify(r.verify_code) },
              ...(can('assessment_certificate.revoke') && r.status === 'issued' ? [{ k: 'shield', title: 'Revoke', onClick: () => setRevoke(r) }] : []),
            ],
            onDelete: can('assessment_certificate.delete') ? () => setDel(r) : undefined,
          }),
        ])} />
      {issue && <IssueAssessmentCertModal rd={rd} onClose={() => setIssue(false)} onSaved={() => { setIssue(false); after(); }} />}
      {revoke && <RevokeCertModal cert={revoke} onClose={() => setRevoke(null)} onConfirm={doRevoke} />}
      {del && <ConfirmModal title="Delete certificate?" body={`Delete ${del.certificate_no} for ${del.student_name}?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function IssueAssessmentCertModal({ rd, onClose, onSaved }: { rd: any; onClose: () => void; onSaved: () => void }) {
  const [fB, setFB] = useState<number[]>([]);
  const [fV, setFV] = useState<number[]>([]);
  const students = useStudentsD(fB, fV);
  const [studentId, setStudentId] = useState('');
  const [attemptId, setAttemptId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const attempts = useFetch<any[]>(studentId ? `/attempts?student_id=${studentId}&status=evaluated` : null, [studentId]);
  const passed = (attempts.data ?? []).filter((a: any) => a.is_passed === true);

  const save = async () => {
    setErr('');
    if (!attemptId) return setErr('Choose a passed, evaluated attempt.');
    setBusy(true);
    try {
      const r = await api.post<any>('/assessment-certificates', { attempt_id: Number(attemptId), title: title.trim() || undefined });
      toast(`Certificate ${r.certificate_no} issued`); onSaved();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <DetailModal title="Issue certificate" icon="shield" width={560} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Issuing…' : 'Issue'}</button></>}>
      <div className="filters" style={{ marginBottom: 8 }}>
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
      </div>
      <div className="fld"><label>Student *</label>
        <select className="ainp" value={studentId} onChange={(e) => { setStudentId(e.target.value); setAttemptId(''); }}>
          <option value="">— choose —</option>
          {(students.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.full_name} ({s.student_no ?? s.id})</option>)}
        </select></div>
      <div className="fld"><label>Passed attempt *</label>
        <select className="ainp" value={attemptId} onChange={(e) => setAttemptId(e.target.value)} disabled={!studentId}>
          <option value="">{studentId ? (passed.length ? '— choose a passed attempt —' : 'No passed evaluated attempts for this student') : 'Choose a student first'}</option>
          {passed.map((a: any) => <option key={a.id} value={a.id}>{a.assessment_title} — {a.total_score}/{a.max_score} ({a.attempt_no ? `#${a.attempt_no}` : ''})</option>)}
        </select></div>
      <div className="fld"><label>Title (optional)</label><input className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Certificate of Achievement — …" /></div>
      {err && <div className="form-err" style={{ color: 'var(--rose)', marginTop: 8 }}>{err}</div>}
    </DetailModal>
  );
}

function RevokeCertModal({ cert, onClose, onConfirm }: { cert: any; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <DetailModal title="Revoke certificate" icon="shield" width={480} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" onClick={() => onConfirm(reason)}>Revoke</button></>}>
      <p className="sub">Revoke <b>{cert.certificate_no}</b> for {cert.student_name}? Public verification will show it as revoked.</p>
      <div className="fld"><label>Reason (optional)</label><input className="ainp" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </DetailModal>
  );
}

/* ------------------------------------------------- PUBLIC certificate verify -- */
export function PublicCertificateVerify({ code }: { code: string }) {
  const [state, setState] = useState<{ loading: boolean; data?: any }>({ loading: true });
  useEffect(() => {
    fetch(`/api/public/verify/certificate/${encodeURIComponent(code)}`)
      .then((r) => r.json()).then((data) => setState({ loading: false, data }))
      .catch(() => setState({ loading: false, data: { valid: false, reason: 'Could not reach the verification service.' } }));
  }, [code]);
  const d = state.data;
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg, #0b1020)', padding: 20 }}>
      <div style={{ maxWidth: 520, width: '100%', background: 'var(--card, #fff)', borderRadius: 14, padding: 28, boxShadow: '0 10px 40px rgba(0,0,0,.2)' }}>
        {state.loading ? <div className="sub">Verifying…</div> : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 40 }}>{d?.valid ? '✅' : (d?.revoked ? '⛔' : '❌')}</div>
              <h2 style={{ margin: '8px 0 0' }}>{d?.valid ? 'Certificate verified' : (d?.revoked ? 'Certificate revoked' : 'Not verified')}</h2>
              {!d?.valid && <div className="sub" style={{ marginTop: 6 }}>{d?.reason}</div>}
            </div>
            {(d?.valid || d?.revoked) && (
              <KV rows={[
                ['Certificate No', d.certificate_no],
                ['Student', d.student_name],
                d.assessment_title ? ['Test', d.assessment_title] : null,
                d.title ? ['Title', d.title] : null,
                d.grade_label ? ['Grade', `${d.grade_label}${d.percentage != null ? ` (${d.percentage}%)` : ''}`] : null,
                ['Issued on', fmtFull(d.issued_on)],
                d.org_name ? ['Issued by', d.org_name] : null,
              ]} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
