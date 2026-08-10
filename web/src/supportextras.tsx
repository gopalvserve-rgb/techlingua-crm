/**
 * Help & Support — ERP Batch 7 (Support extras): Training Videos + Release Notes.
 *
 * Two ORG-WIDE staff content libraries. Self-contained like learning.tsx / academics.tsx.
 * Each manage list carries the FULL treatment: filter chips (category / active / search /
 * date range), Export (values not ids), Refresh, a column chooser (TableCard fill+title),
 * and bulk-delete (useTableSelect + BulkBar + useBulkDelete). Every API route has a caller
 * here (route-reachability guard). RBAC: training.* / release_note.* (view vs manage).
 */
import { useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch } from './refdata';
import { rowActions, ConfirmModal, DetailModal } from './rowactions';
import { DateRange } from './daterange';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';
import { EnumMulti } from './dyn';

const inpStyle = { background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 } as const;
const REL_CATS = ['feature', 'fix', 'improvement'] as const;
const REL_BADGE: Record<string, string> = { feature: 'b-green', improvement: 'b-green', fix: 'b-amber' };

/** DD-MM-YYYY (India convention). */
export function fmtDMY(v?: string | null): string {
  if (!v) return '—';
  const s = String(v).slice(0, 10);
  const [y, m, d] = s.split('-');
  return y && m && d ? `${d}-${m}-${y}` : s;
}

/** Turn a YouTube/Vimeo watch URL into an embeddable one; otherwise return as-is. */
export function toEmbedUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') && u.searchParams.get('v')) return `https://www.youtube.com/embed/${u.searchParams.get('v')}`;
    if (u.hostname === 'youtu.be') return `https://www.youtube.com/embed${u.pathname}`;
    if (u.hostname.includes('vimeo.com') && /^\/\d+/.test(u.pathname)) return `https://player.vimeo.com/video${u.pathname}`;
    return url;
  } catch { return url; }
}

/* ========================= TRAINING VIDEOS ========================= */

export function TrainingVideosScreen() {
  const { can } = useAuth();
  const canManage = can('training.manage');
  const [fcat, setFcat] = useState<string[]>([]);
  const [factive, setFactive] = useState('');
  const [q, setQ] = useState('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [play, setPlay] = useState<any | null>(null);

  const cats = useFetch<string[]>(`/training-videos/categories`, [tick]);
  const qs = new URLSearchParams();
  if (fcat.length) qs.set('category', fcat.join(','));
  if (factive) qs.set('active', factive);
  if (q.trim()) qs.set('q', q.trim());
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const list = useFetch<any[]>(`/training-videos?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Training Videos', '/training-videos/bulk-delete/impact', '/training-videos/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/training-videos/${del.id}`); toast('Training video deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {canManage && <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />New training video</button></div>}
      <div className="filters">
        <EnumMulti label="Category" icon="grid" value={fcat} onChange={setFcat}
          options={(cats.data ?? []).map((c) => ({ id: c, name: c }))} />
        <label className="fchip"><Ic k="shield" />
          <select value={factive} onChange={(e) => setFactive(e.target.value)} style={inpStyle}>
            <option value="">All</option><option value="true">Active</option><option value="false">Inactive</option>
          </select></label>
        <div className="fchip"><Ic k="search" /><input style={inpStyle} placeholder="Search title / tags…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <DateRange value={range} onChange={setRange} idPrefix="tv-dr" style={{ marginLeft: 'auto' }} />
      </div>
      <BulkBar count={count} entityLabel="Training Videos" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Training videos" icon="bolt"
        select={canManage ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('training-videos.csv', rows)} onRefresh={after} />}
        cols={['Title', 'Category', 'Tags', 'Order', 'Status', 'Added', 'Actions']}
        empty="No training videos yet — add one for your staff to watch."
        rows={rows.map((v: any) => [
          { node: <div><b className="nm">{v.title}</b>{v.description ? <div className="sub">{v.description}</div> : null}</div> } as Cell,
          v.category ?? '—',
          v.tags ?? '—',
          String(v.sort_order ?? 0),
          { b: [v.active ? 'Active' : 'Inactive', v.active ? 'b-green' : 'b-gray'] } as Cell,
          fmtDMY(v.created_at),
          rowActions({
            extra: [{ k: 'eye', title: 'Watch', onClick: () => setPlay(v) }],
            onEdit: canManage ? () => setEdit(v) : undefined,
            onDelete: canManage ? () => setDel(v) : undefined,
          }),
        ])} />
      {play && <VideoPlayerModal video={play} onClose={() => setPlay(null)} />}
      {add && <TrainingModal onClose={() => setAdd(false)} onSaved={after} />}
      {edit && <TrainingModal initial={edit} onClose={() => setEdit(null)} onSaved={after} />}
      {del && <ConfirmModal title="Delete training video?" body={`Delete "${del.title}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function VideoPlayerModal({ video, onClose }: { video: any; onClose: () => void }) {
  const src = toEmbedUrl(String(video.video_url ?? ''));
  const embeddable = /youtube\.com\/embed|player\.vimeo\.com|\.mp4($|\?)/i.test(src);
  return (
    <DetailModal title={video.title} icon="bolt" width={760} onClose={onClose}>
      {embeddable ? (
        <div style={{ position: 'relative', paddingTop: '56.25%', borderRadius: 8, overflow: 'hidden', background: '#000' }}>
          <iframe title={video.title} src={src} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }} />
        </div>
      ) : (
        <div className="empty-note">This video is hosted externally. <a href={video.video_url} target="_blank" rel="noopener noreferrer">Open the video in a new tab</a>.</div>
      )}
      {video.description ? <p style={{ marginTop: 12 }}>{video.description}</p> : null}
      {video.tags ? <div className="sub" style={{ marginTop: 6 }}>Tags: {video.tags}</div> : null}
    </DetailModal>
  );
}

function TrainingModal({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!initial?.id;
  const [f, setF] = useState<any>({
    title: initial?.title ?? '', description: initial?.description ?? '', category: initial?.category ?? '',
    video_url: initial?.video_url ?? '', thumbnail_url: initial?.thumbnail_url ?? '', tags: initial?.tags ?? '',
    sort_order: initial?.sort_order ?? 0, active: initial?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!f.title.trim()) { toast('Give the training video a title.', true); return; }
    if (!f.video_url.trim()) { toast('Add the video URL.', true); return; }
    setBusy(true);
    try {
      const body = { ...f, sort_order: Number(f.sort_order) || 0 };
      if (isEdit) await api.patch(`/training-videos/${initial.id}`, body); else await api.post('/training-videos', body);
      toast(isEdit ? 'Training video updated' : 'Training video added'); onSaved(); onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={isEdit ? 'Edit training video' : 'New training video'} icon="bolt" width={560} onClose={onClose}
      footer={<button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{isEdit ? 'Save' : 'Add'}</button>}>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Title *</label><input className="ainp" value={f.title} onChange={(e) => set('title', e.target.value)} /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Description</label><textarea className="ainp" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Video URL * (YouTube / Vimeo / MP4 / embed)</label><input className="ainp" value={f.video_url} onChange={(e) => set('video_url', e.target.value)} placeholder="https://www.youtube.com/watch?v=…" /></div>
        <div className="fld"><label>Category</label><input className="ainp" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Onboarding, Sales…" /></div>
        <div className="fld"><label>Tags (comma-separated)</label><input className="ainp" value={f.tags} onChange={(e) => set('tags', e.target.value)} /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Thumbnail URL</label><input className="ainp" value={f.thumbnail_url} onChange={(e) => set('thumbnail_url', e.target.value)} /></div>
        <div className="fld"><label>Sort order</label><input className="ainp" type="number" value={f.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></div>
        <div className="fld"><label>Status</label>
          <select className="ainp" value={f.active ? 'true' : 'false'} onChange={(e) => set('active', e.target.value === 'true')}>
            <option value="true">Active</option><option value="false">Inactive</option>
          </select></div>
      </div>
    </DetailModal>
  );
}

/* ========================= RELEASE NOTES ========================= */

export function ReleaseNotesScreen() {
  const { can } = useAuth();
  const canManage = can('release_note.manage');
  const [fcat, setFcat] = useState<string[]>([]);
  const [factive, setFactive] = useState('');
  const [q, setQ] = useState('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (fcat.length) qs.set('category', fcat.join(','));
  if (factive) qs.set('active', factive);
  if (q.trim()) qs.set('q', q.trim());
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const list = useFetch<any[]>(`/release-notes?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Release Notes', '/release-notes/bulk-delete/impact', '/release-notes/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/release-notes/${del.id}`); toast('Release note deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {canManage && <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />New release note</button></div>}
      <div className="filters">
        <EnumMulti label="Category" icon="grid" value={fcat} onChange={setFcat}
          options={REL_CATS.map((c) => ({ id: c, name: c }))} />
        <label className="fchip"><Ic k="shield" />
          <select value={factive} onChange={(e) => setFactive(e.target.value)} style={inpStyle}>
            <option value="">All</option><option value="true">Published</option><option value="false">Hidden</option>
          </select></label>
        <div className="fchip"><Ic k="search" /><input style={inpStyle} placeholder="Search title / notes / version…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <DateRange value={range} onChange={setRange} idPrefix="rn-dr" style={{ marginLeft: 'auto' }} />
      </div>
      <BulkBar count={count} entityLabel="Release Notes" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Release notes" icon="doc"
        select={canManage ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('release-notes.csv', rows)} onRefresh={after} />}
        cols={['Version', 'Date', 'Title', 'Category', 'Status', 'Actions']}
        empty="No release notes yet — publish your first changelog entry."
        rows={rows.map((r: any) => [
          (r.version ? { node: <span className="mono">{r.version}</span> } : "—") as Cell,
          fmtDMY(r.release_date),
          { node: <div><b className="nm">{r.title}</b>{r.notes ? <div className="sub">{r.notes}</div> : null}</div> } as Cell,
          { b: [r.category, REL_BADGE[r.category] ?? 'b-gray'] } as Cell,
          { b: [r.active ? 'Published' : 'Hidden', r.active ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({
            onEdit: canManage ? () => setEdit(r) : undefined,
            onDelete: canManage ? () => setDel(r) : undefined,
          }),
        ])} />
      {add && <ReleaseModal onClose={() => setAdd(false)} onSaved={after} />}
      {edit && <ReleaseModal initial={edit} onClose={() => setEdit(null)} onSaved={after} />}
      {del && <ConfirmModal title="Delete release note?" body={`Delete "${del.title}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function ReleaseModal({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!initial?.id;
  const [f, setF] = useState<any>({
    version: initial?.version ?? '', release_date: initial?.release_date ? String(initial.release_date).slice(0, 10) : '',
    title: initial?.title ?? '', notes: initial?.notes ?? '', category: initial?.category ?? 'feature',
    active: initial?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!f.title.trim()) { toast('Give the release note a title.', true); return; }
    setBusy(true);
    try {
      const body: any = { ...f };
      if (!body.release_date) delete body.release_date;
      if (isEdit) await api.patch(`/release-notes/${initial.id}`, body); else await api.post('/release-notes', body);
      toast(isEdit ? 'Release note updated' : 'Release note published'); onSaved(); onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={isEdit ? 'Edit release note' : 'New release note'} icon="doc" width={560} onClose={onClose}
      footer={<button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{isEdit ? 'Save' : 'Publish'}</button>}>
      <div className="form-grid">
        <div className="fld"><label>Version</label><input className="ainp" value={f.version} onChange={(e) => set('version', e.target.value)} placeholder="v2.4.0" /></div>
        <div className="fld"><label>Release date</label><input className="ainp" type="date" value={f.release_date} onChange={(e) => set('release_date', e.target.value)} /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Title *</label><input className="ainp" value={f.title} onChange={(e) => set('title', e.target.value)} /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>What changed (notes)</label><textarea className="ainp" rows={4} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        <div className="fld"><label>Category</label>
          <select className="ainp" value={f.category} onChange={(e) => set('category', e.target.value)}>
            {REL_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select></div>
        <div className="fld"><label>Status</label>
          <select className="ainp" value={f.active ? 'true' : 'false'} onChange={(e) => set('active', e.target.value === 'true')}>
            <option value="true">Published</option><option value="false">Hidden</option>
          </select></div>
      </div>
    </DetailModal>
  );
}
