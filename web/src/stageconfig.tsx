/**
 * Pipeline Stage Configurator — client-requested two-panel screen
 * (mockup, 2026-07-11; sanctioned addition in docs/design/01-prototype-parity-spec.md §3).
 *
 * LEFT card: "Select Pipeline :" dropdown + Edit pill, then the pipeline's
 * stages as a vertical flow of cards joined by arrow connectors; a circular
 * "+" on every connector (head / between / after last) inserts a stage at
 * that exact position. The selected stage is highlighted (accent border+tint).
 *
 * RIGHT card: "Edit Stage" / "Add Stage" — Stage Name, Tags chip input
 * (suggestions from the Tag master, stored per-stage in tags JSONB), an
 * "Additional Setting" accordion (Stage Type / Default / Active) and
 * Delete Stage (guarded: 409 when leads sit in the stage → offer deactivate)
 * + Save with dirty-state indication. Read-only without pipeline.update.
 */
import { Fragment, ReactNode, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { toast, useFetch, useRef_ } from './refdata';
import { AddModal, need } from './forms';
import { ConfirmModal } from './rowactions';

const STAGE_TYPES: Array<[string, string]> = [['open', 'Open'], ['won', 'Won'], ['lost', 'Lost']];

type Sel = { mode: 'edit'; id: number } | { mode: 'add'; after: number | null };

export function StageConfigurator({ pipeline, onBack, afterChange }: {
  pipeline: any; onBack: () => void; afterChange: () => void;
}) {
  const { can } = useAuth();
  const ref = useRef_();
  const canEdit = can('pipeline.update');

  const [pid, setPid] = useState<number>(Number(pipeline.id));
  const [tick, setTick] = useState(0);
  const stages = useFetch<any[]>(`/pipelines/${pid}/stages`, [pid, tick]);
  const rows = stages.data ?? [];
  const cur = ref.pipelines.find((p) => Number(p.id) === pid) ?? pipeline;

  const [sel, setSel] = useState<Sel | null>(null);
  const selKey = sel ? (sel.mode === 'edit' ? `e${sel.id}` : `a${sel.after}`) : '';
  const selStage = sel?.mode === 'edit' ? rows.find((s) => Number(s.id) === sel.id) : null;

  // right-panel form state
  const [name, setName] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [type, setType] = useState('open');
  const [isDefault, setIsDefault] = useState(false);
  const [active, setActive] = useState(true);
  const [accOpen, setAccOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [blockedMsg, setBlockedMsg] = useState<string | null>(null);
  const [editPl, setEditPl] = useState(false);

  // tag suggestions from the Tag master (permission-safe)
  const [tagMaster, setTagMaster] = useState<string[]>([]);
  useEffect(() => {
    api.get<any[]>('/masters/tag').then((r) => setTagMaster(r.map((t) => String(t.name)))).catch(() => setTagMaster([]));
  }, []);

  // auto-select the first stage once the flow loads
  useEffect(() => {
    if (!sel && rows.length) setSel({ mode: 'edit', id: Number(rows[0].id) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, pid]);

  // (re)fill the form whenever the selection — or the saved row — changes
  useEffect(() => {
    if (sel?.mode === 'edit' && selStage) {
      setName(selStage.name ?? '');
      setTags(Array.isArray(selStage.tags) ? selStage.tags.map(String) : []);
      setType(selStage.stage_type ?? 'open');
      setIsDefault(selStage.is_default === true);
      setActive(selStage.is_active !== false);
    } else if (sel?.mode === 'add') {
      setName(''); setTags([]); setType('open'); setIsDefault(false); setActive(true);
    }
    setTagInput('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, selStage?.updated_at]);

  const dirty = sel?.mode === 'add'
    ? name.trim().length > 0 || tags.length > 0 || type !== 'open' || isDefault
    : !!selStage && (
      name !== (selStage.name ?? '')
      || type !== (selStage.stage_type ?? 'open')
      || isDefault !== (selStage.is_default === true)
      || active !== (selStage.is_active !== false)
      || JSON.stringify(tags) !== JSON.stringify(Array.isArray(selStage.tags) ? selStage.tags.map(String) : [])
    );

  const bumped = () => { setTick((t) => t + 1); afterChange(); };

  const save = async () => {
    if (!sel) return;
    if (!name.trim()) return toast('Stage name is required', true);
    setBusy(true);
    try {
      if (sel.mode === 'add') {
        const created = await api.post<any>(`/pipelines/${pid}/stages`, {
          name: name.trim(), tags, stage_type: type, is_default: isDefault, after_stage_id: sel.after,
        });
        toast(`Stage "${created.name}" added`);
        setSel({ mode: 'edit', id: Number(created.id) });
      } else {
        await api.patch(`/stages/${sel.id}`, {
          name: name.trim(), tags, stage_type: type, is_default: isDefault, is_active: active,
        });
        toast(`Stage "${name.trim()}" updated`);
      }
      bumped();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (sel?.mode !== 'edit') return;
    setBusy(true);
    try {
      await api.del(`/stages/${sel.id}`);
      toast(`Stage "${selStage?.name ?? ''}" deleted`);
      setConfirmDel(false); setSel(null);
      bumped();
    } catch (e: any) {
      setConfirmDel(false);
      if (e instanceof ApiError && e.status === 409) setBlockedMsg(e.message);
      else toast(e.message, true);
    } finally { setBusy(false); }
  };

  const deactivateInstead = async () => {
    if (sel?.mode !== 'edit') return;
    setBusy(true);
    try {
      await api.patch(`/stages/${sel.id}`, { is_active: false });
      toast(`Stage "${selStage?.name ?? ''}" marked Inactive`);
      setBlockedMsg(null);
      bumped();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  const addTag = (v: string) => {
    const t = v.trim().replace(/,+$/, '');
    setTagInput('');
    if (!t) return;
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    setTags([...tags, t]);
  };

  const suggestions = useMemo(() => {
    const q = tagInput.trim().toLowerCase();
    return tagMaster
      .filter((t) => !tags.some((x) => x.toLowerCase() === t.toLowerCase()))
      .filter((t) => !q || t.toLowerCase().includes(q))
      .slice(0, 6);
  }, [tagMaster, tags, tagInput]);

  /* --------------------------- left flow render --------------------------- */
  const ghostAt = sel?.mode === 'add' ? (sel.after === null ? 0 : rows.findIndex((r) => Number(r.id) === sel.after) + 1) : -1;

  const plusBtn = (after: number | null) => (
    <button
      className={`sc-plus${sel?.mode === 'add' && sel.after === after ? ' on' : ''}`}
      title="Insert stage here" onClick={() => setSel({ mode: 'add', after })}>
      <Ic k="plus" w={2.6} />
    </button>
  );

  const ghostEl = (
    <div className="sc-stage ghost sel">
      <span className="nm">{name.trim() || 'New stage'}</span>
    </div>
  );

  const flow: ReactNode[] = [];
  if (rows.length > 0 && canEdit) flow.push(<div className="sc-conn head" key="head">{plusBtn(null)}</div>);
  if (ghostAt === 0 && rows.length > 0) flow.push(<Fragment key="g0">{ghostEl}<div className="sc-conn plain" key="g0c" /></Fragment>);
  rows.forEach((s, i) => {
    const isSel = sel?.mode === 'edit' && Number(s.id) === sel.id;
    flow.push(
      <button key={s.id}
        className={`sc-stage${isSel ? ' sel' : ''}${s.is_active === false ? ' off' : ''}`}
        onClick={() => setSel({ mode: 'edit', id: Number(s.id) })}>
        <span className="nm">{s.name}</span>
        {(s.is_default || s.stage_type !== 'open' || s.is_active === false) && (
          <span className="marks">
            {s.is_default ? <i className="mk def">Default</i> : null}
            {s.stage_type === 'won' ? <i className="mk won">Won</i> : s.stage_type === 'lost' ? <i className="mk lost">Lost</i> : null}
            {s.is_active === false ? <i className="mk inact">Inactive</i> : null}
          </span>
        )}
      </button>,
    );
    const isLast = i === rows.length - 1;
    if (!isLast || canEdit || ghostAt === rows.length) {
      flow.push(
        <div className={`sc-conn${isLast && ghostAt !== rows.length ? ' tail' : ''}`} key={`c${s.id}`}>
          {canEdit ? plusBtn(Number(s.id)) : null}
        </div>,
      );
    }
    if (ghostAt === i + 1) {
      flow.push(<Fragment key={`g${i + 1}`}>{ghostEl}{!isLast && <div className="sc-conn plain" />}</Fragment>);
    }
  });
  if (rows.length === 0 && canEdit) {
    flow.push(<div className="sc-conn head" key="empty-head">{plusBtn(null)}</div>);
    if (ghostAt === 0) flow.push(<Fragment key="ge">{ghostEl}</Fragment>);
  }

  /* ------------------------------- render -------------------------------- */
  const mode = sel?.mode ?? null;
  const panelTitle = mode === 'add' ? 'Add Stage' : canEdit ? 'Edit Stage' : 'Stage details';

  return (
    <>
      <div className="filters">
        <button className="fchip" style={{ cursor: 'pointer' }} onClick={onBack}>
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Ic k="chev" /></span>Back to Pipelines
        </button>
        <div className="fchip"><Ic k="list" /><b>{rows.length}</b> stages · {cur.name}{cur.vertical_name ? ` · ${cur.vertical_name}` : ''}</div>
        {!canEdit && <div className="fchip"><Ic k="eye" />Read-only — you don't have stage-edit permission</div>}
      </div>

      <div className="sc-wrap">
        {/* -------- LEFT: pipeline picker + vertical stage flow -------- */}
        <div className="card sc-left">
          <div className="card-head"><h3><Ic k="list" />Select Pipeline :</h3></div>
          <div className="sc-pick">
            <select className="ainp" value={pid}
              onChange={(e) => { setPid(Number(e.target.value)); setSel(null); }}>
              {(ref.pipelines.length ? ref.pipelines : [cur]).map((p: any) => (
                <option key={p.id} value={Number(p.id)}>{p.name}{p.vertical_name ? ` · ${p.vertical_name}` : ''}</option>
              ))}
            </select>
            {canEdit && (
              <button className="btn sc-pill" onClick={() => setEditPl(true)}><Ic k="pencil" />Edit</button>
            )}
          </div>
          <div className="sc-flow">
            {stages.loading && rows.length === 0
              ? <div className="empty-note">Loading stages…</div>
              : rows.length === 0 && !canEdit
                ? <div className="empty-note">No stages yet</div>
                : flow}
          </div>
        </div>

        {/* -------- RIGHT: add / edit stage panel -------- */}
        <div className="card sc-right">
          <div className="card-head">
            <h3><Ic k={mode === 'add' ? 'plus' : 'pencil'} />{panelTitle}</h3>
            <span className="sc-actions">
              {dirty && canEdit && <span className="sc-dirty">Unsaved changes</span>}
              {mode === 'edit' && canEdit && (
                <button className="btn sc-pill danger" onClick={() => setConfirmDel(true)}><Ic k="x" />Delete Stage</button>
              )}
              {canEdit && sel && (
                <button className="btn primary" disabled={busy || !dirty} onClick={save}><Ic k="check" />Save</button>
              )}
            </span>
          </div>
          {!sel ? (
            <div className="empty-note" style={{ padding: 26 }}>
              Select a stage on the left, or click a <b>+</b> on the flow to insert one.
            </div>
          ) : (
            <div className="sc-body">
              <div className="fld">
                <label>Stage Name{canEdit && <span className="star"> *</span>}</label>
                <input className="ainp" value={name} disabled={!canEdit} autoFocus={mode === 'add'}
                  placeholder="e.g. Meeting Scheduled"
                  onChange={(e) => setName(e.target.value)} />
              </div>

              <div className="fld">
                <label>Tags</label>
                <div className={`sc-tags${canEdit ? '' : ' ro'}`}>
                  {tags.map((t) => (
                    <span className="sc-chip" key={t}>{t}
                      {canEdit && <button title={`Remove ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}><Ic k="x" w={2.6} /></button>}
                    </span>
                  ))}
                  {canEdit && (
                    <input className="sc-taginp" placeholder={tags.length ? 'Add tags…' : 'Add tags… (e.g. Cold, Warm, Hot)'}
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); }
                        else if (e.key === 'Backspace' && !tagInput && tags.length) setTags(tags.slice(0, -1));
                      }}
                      onBlur={() => addTag(tagInput)} />
                  )}
                  {!canEdit && tags.length === 0 && <span className="sub" style={{ fontSize: 12 }}>—</span>}
                </div>
                {canEdit && suggestions.length > 0 && (
                  <div className="sc-sugg">
                    {suggestions.map((t) => (
                      <button className="mapchip" key={t} onMouseDown={(e) => e.preventDefault()} onClick={() => addTag(t)}>＋ {t}</button>
                    ))}
                  </div>
                )}
              </div>

              <button className="sc-acc" onClick={() => setAccOpen((o) => !o)}>
                <Ic k="cfg" />Additional Setting
                <span className={`chv${accOpen ? ' open' : ''}`}><Ic k="chevd" /></span>
              </button>
              {accOpen && (
                <div className="sc-accbody">
                  <div className="fld">
                    <label>Stage Type</label>
                    <select className="ainp" value={type} disabled={!canEdit} onChange={(e) => setType(e.target.value)}>
                      {STAGE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </div>
                  <label className="sc-check">
                    <input type="checkbox" checked={isDefault} disabled={!canEdit}
                      onChange={(e) => setIsDefault(e.target.checked)} />
                    <span><b>Default stage</b><em>New leads land here — one default per pipeline.</em></span>
                  </label>
                  {mode === 'edit' && (
                    <label className="sc-check">
                      <input type="checkbox" checked={active} disabled={!canEdit}
                        onChange={(e) => setActive(e.target.checked)} />
                      <span><b>Active</b><em>Inactive stages disappear from Kanban & steppers; existing leads keep the reference.</em></span>
                    </label>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {confirmDel && sel?.mode === 'edit' && (
        <ConfirmModal title="Delete stage" danger busy={busy} confirmLabel="Delete"
          body={<>Delete stage <b>{selStage?.name}</b> from <b>{cur.name}</b>? This is permanent. If any lead is
            currently in this stage the delete is blocked — you can mark it Inactive instead.</>}
          onConfirm={doDelete} onClose={() => setConfirmDel(false)} />
      )}
      {blockedMsg && (
        <ConfirmModal title="Stage still has leads" danger busy={busy} confirmLabel="Deactivate instead"
          body={<><p style={{ marginBottom: 8 }}>{blockedMsg}</p>
            Mark <b>{selStage?.name}</b> as Inactive instead? It disappears from Kanban and steppers, existing leads keep it.</>}
          onConfirm={deactivateInstead} onClose={() => setBlockedMsg(null)} />
      )}
      {editPl && (
        <AddModal formKey="leads.pipelinemaster" onClose={() => setEditPl(false)}
          onSaved={() => { ref.reload(); afterChange(); }}
          edit={{
            title: `Edit Pipeline — ${cur.name}`,
            initialVals: {
              'Pipeline Name': cur.name ?? '', 'Pipeline Code': cur.code ?? '',
              'Branch': cur.branch_name ?? '', 'Vertical': cur.vertical_name ?? '',
              'Status': cur.is_active === false ? 'Inactive' : 'Active',
            },
            lock: ['Branch', 'Vertical', 'Pipeline Stages', 'Pipeline Owner'],
            submit: async (vals) => {
              await api.patch(`/pipelines/${pid}`, {
                name: need(vals['Pipeline Name'], 'Pipeline name is required'),
                code: need(vals['Pipeline Code'], 'Pipeline code is required'),
                is_active: vals['Status'] !== 'Inactive',
              });
              return 'Pipeline updated';
            },
          }} />
      )}
    </>
  );
}
