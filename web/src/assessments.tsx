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
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { rowActions, ConfirmModal, DetailModal, Section, KV } from './rowactions';
import { useScope } from './scope';
import { FilterMulti, EnumMulti } from './dyn';
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
