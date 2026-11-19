/**
 * TEMPLATE MANAGEMENT — Administration › Template Setup (client 12 Nov 2026).
 *
 * "Keep the existing clean interface, but organise templates by module": Finance · Students ·
 * Academics · HR · Certificates. Every document gets a BUILDER (the Fee Invoice keeps its own):
 * field groups the client listed — hide, rename, reorder; tables; wording with {{variables}};
 * custom fields; partner / university details; signatories, stamp, QR verification and barcode;
 * the page, branding and design — with the real PDF previewed live as you edit.
 *
 * Applicability: organisation → branch → vertical → course (the most specific published template
 * wins at print time, once its effective date has come). Several templates per document; a
 * default per scope; cloning to another branch; approval before publishing; versions with
 * restore; an audit log of every change. Nothing published = the document keeps its built-in
 * layout, editable under "Built-in layout".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { toast, useFetch, useRef_ } from './refdata';
import { askConfirm, askText } from './askdialog';
import { fmtDateTimeIST } from './daterange';
import { ColorIn, DnDList, ImageIn, Row, Toggle } from './invoicebuilder';
import { TemplateEditModal } from './dyn';

type Field = { key: string; label: string; visible: boolean };
interface DocCfg {
  v: 1;
  page: { size: 'A4' | 'Letter' | 'CARD'; orientation: 'portrait' | 'landscape'; margin: number };
  branding: { institute_name: string; tagline: string; title: string; show_logo: boolean; logo: string; address: string; phone: string; email: string;
    website: string; header_bg: string; header_text: string; accent: string; title_align: 'left' | 'center' | 'right' };
  groups: Array<{ key: string; title: string; visible: boolean; fields: Field[] }>;
  tables: Array<{ key: string; title: string; visible: boolean; columns: Field[] }>;
  body: string;
  custom_fields: Array<{ label: string; value: string; visible: boolean }>;
  partner: { show: boolean; name: string; text: string };
  footer: { terms: string; note: string; disclaimer: string; show_qr: boolean; show_barcode: boolean; show_generated_at: boolean;
    signatories: Array<{ label: string; name: string; image: string }>; stamp_img: string };
  design: { font_size: number; columns: 1 | 2 | 3; borders: boolean; group_titles: boolean };
}
interface TypeDef { type: string; label: string; module: string; source: string; page: string; orientation: string; groups: any[]; default_config: DocCfg }

const STATUS: Record<string, [string, string]> = {
  draft: ['Draft', 'b-gray'], pending: ['Waiting for approval', 'b-amber'], published: ['Published', 'b-green'], unpublished: ['Unpublished', 'b-gray'],
};
/** Built-in (pre-builder) settings exist for these — edited with the original modal. */
const LEGACY = new Set(['fee_receipt', 'student_id', 'employee_id', 'quotation', 'certificate', 'marksheet']);
const PRINTABLE_HERE = new Set(['admission_form', 'marksheet', 'offer_letter', 'experience_certificate']);
const dt = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const scopeLabel = (t: any) => [t.branch_name, t.vertical_name, t.course_name].filter(Boolean).join(' › ') || 'Whole organisation';

/* ============================================================== the screen */

export function TemplateManagement() {
  const { can } = useAuth();
  const cat = useFetch<{ modules: string[]; types: TypeDef[] }>('/doc-builder/catalog', []);
  const [tick, setTick] = useState(0);
  const list = useFetch<any[]>('/doc-builder/templates', [tick]);
  const legacy = useFetch<any[]>('/document-templates', [tick]);
  const [mod, setMod] = useState('all');
  const [open, setOpen] = useState<{ id: number; type: TypeDef } | null>(null);
  const [legacyEdit, setLegacyEdit] = useState<any>(null);
  const [print, setPrint] = useState<TypeDef | null>(null);
  const reload = () => setTick((t) => t + 1);
  const types = cat.data?.types ?? [];
  const tpls = list.data ?? [];
  const modules = ['Finance', 'Students', 'Academics', 'HR', 'Certificates'];

  const create = async (t: TypeDef) => {
    const name = await askText(`Name the new ${t.label} template`, `${t.label}`);
    if (!name) return;
    try { const r = await api.post<any>('/doc-builder/templates', { doc_type: t.type, name }); reload(); setOpen({ id: Number(r.id), type: t }); }
    catch (e) { toast((e as Error).message, true); }
  };
  const act = async (path: string, body: any, msg: string) => {
    try { await api.post(path, body ?? {}); toast(msg); reload(); } catch (e) { toast((e as Error).message, true); }
  };

  const docRow = (t: TypeDef) => {
    const mine = tpls.filter((x) => x.doc_type === t.type);
    const legacyRow = (legacy.data ?? []).find((l: any) => l.type === t.type);
    return (
      <div key={t.type} className="tm-doc" data-testid={`tm-doc-${t.type}`}>
        <div className="tm-doc-head">
          <div style={{ minWidth: 0 }}><b>{t.label}</b> <span className="sub">· prints {t.source} · {t.page === 'CARD' ? 'ID card (CR80)' : `A4 ${t.orientation}`}</span></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {mine.some((x) => x.status === 'published') ? <button className="btn sm" onClick={() => setPrint(t)} data-testid={`tm-print-${t.type}`}><Ic k="print" />Print</button> : null}
            {LEGACY.has(t.type) && legacyRow && can('settings.update') ? <button className="btn sm" onClick={() => setLegacyEdit(legacyRow)} title="The layout used while no template is published"><Ic k="edit" />Built-in layout</button> : null}
            {can('doctemplate.manage') ? <button className="btn sm primary" onClick={() => create(t)} data-testid={`tm-new-${t.type}`}><Ic k="plus" />New template</button> : null}
          </div>
        </div>
        {mine.length === 0 ? <div className="sub" style={{ padding: '6px 2px' }}>No template yet — it prints with the built-in layout.</div> : (
          <div className="tbl-scroll"><table className="tbl">
            <thead><tr><th>Template</th><th>Applies to</th><th>Status</th><th>Effective from</th><th>Version</th><th>Updated</th><th /></tr></thead>
            <tbody>{mine.map((x) => (
              <tr key={x.id} data-testid={`tm-tpl-${x.id}`}>
                <td><b>{x.name}</b>{x.is_default ? <span className="bdg b-indigo" style={{ marginLeft: 6 }}>Default</span> : null}
                  {x.review_note && x.status === 'draft' ? <div className="sub" style={{ color: 'var(--amber)' }}>Sent back: {x.review_note}</div> : null}</td>
                <td>{scopeLabel(x)}</td>
                <td><span className={`bdg ${STATUS[x.status]?.[1] ?? 'b-gray'}`}>{STATUS[x.status]?.[0] ?? x.status}</span></td>
                <td>{dt(x.effective_from)}</td>
                <td>{x.version_no ? `v${x.version_no}` : '—'}</td>
                <td className="sub">{fmtDateTimeIST(x.updated_at)}{x.updated_by_name ? ` · ${x.updated_by_name}` : ''}</td>
                <td><div className="rowacts" style={{ flexWrap: 'wrap' }}>
                  <button className="btn sm primary" onClick={() => setOpen({ id: Number(x.id), type: t })} data-testid={`tm-open-${x.id}`}><Ic k="grid" />Open builder</button>
                  {can('doctemplate.manage') ? <button className="icon-btn sm" title="Clone to another branch / vertical / course" onClick={() => setOpen({ id: -Number(x.id), type: t })}><Ic k="copy" /></button> : null}
                  {can('doctemplate.approve') && x.status === 'published' && !x.is_default ? <button className="icon-btn sm" title="Make default" onClick={() => act(`/doc-builder/templates/${x.id}/default`, {}, 'Default set')}><Ic k="check" /></button> : null}
                  {can('doctemplate.approve') && x.status === 'published' ? <button className="icon-btn sm" title="Unpublish" onClick={async () => { if (await askConfirm('Unpublish? Documents fall back to another template or the built-in layout.')) act(`/doc-builder/templates/${x.id}/unpublish`, {}, 'Unpublished'); }}><Ic k="power" /></button> : null}
                  {can('doctemplate.manage') ? <button className="icon-btn sm" title="Delete" onClick={async () => {
                    if (!await askConfirm(`Delete "${x.name}"? Its versions and audit log go with it.`)) return;
                    try { await api.del(`/doc-builder/templates/${x.id}`); toast('Template deleted'); reload(); } catch (e) { toast((e as Error).message, true); }
                  }}><Ic k="trash" /></button> : null}
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="seg-tabs" role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {['all', ...modules].map((m) => <button key={m} role="tab" aria-selected={mod === m} className={`btn${mod === m ? ' primary' : ''}`} onClick={() => setMod(m)}>{m === 'all' ? 'All modules' : m}</button>)}
      </div>
      <div className="notice" style={{ marginBottom: 12 }}><Ic k="bolt" /><div>
        A template applies to the <b>whole organisation</b>, a <b>branch</b>, a <b>vertical</b> or a <b>course</b> — when a document prints, the most specific
        <b> published</b> template wins (course › vertical › branch › organisation), from its effective date. Until one is published the document keeps its built-in layout.
      </div></div>
      {modules.filter((m) => mod === 'all' || mod === m).map((m) => (
        <div className="card" key={m} style={{ marginBottom: 12 }}>
          <div className="card-head"><h3><Ic k={m === 'Finance' ? 'rupee' : m === 'Students' ? 'students' : m === 'Academics' ? 'book' : m === 'HR' ? 'users' : 'award'} />{m}</h3></div>
          <div className="card-pad">
            {m === 'Finance' ? (
              <div className="tm-doc">
                <div className="tm-doc-head"><div><b>Fee Invoice</b> <span className="sub">· its own builder (fee table, GST, payment, versions)</span></div>
                  <a className="btn sm primary" href={`${location.pathname.replace(/\/[^/]+$/, '')}/invoicebuilder`} data-testid="tpl-open-builder"><Ic k="grid" />Open invoice builder</a></div>
              </div>
            ) : null}
            {types.filter((t) => t.module === m).map(docRow)}
          </div>
        </div>
      ))}
      {open ? <DocBuilder id={open.id} type={open.type} onClose={() => { setOpen(null); reload(); }} /> : null}
      {legacyEdit ? <TemplateEditModal tpl={legacyEdit} onClose={() => setLegacyEdit(null)} onSaved={reload} /> : null}
      {print ? <PrintModal type={print} onClose={() => setPrint(null)} /> : null}
    </>
  );
}

/* ================================================================ printing */

/** Documents with no other print button (admission form, marksheet, letters) print from here. */
function PrintModal({ type, onClose }: { type: TypeDef; onClose: () => void }) {
  const { can } = useAuth();
  const samples = useFetch<any[]>(`/doc-builder/samples/${type.type}`, [type.type]);
  // individual override (permission-controlled): print this one document with another published template
  const published = useFetch<any[]>(can('doctemplate.override') ? `/doc-builder/published/${type.type}` : null, [type.type]);
  const [ref, setRef] = useState('');
  const [tpl, setTpl] = useState('');
  const open = async () => {
    try {
      const res = await fetch(`/api/doc-builder/print/${type.type}/${ref}?template_id=${tpl}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message ?? `Could not print (${res.status})`);
      window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 520 }}>
      <div className="ah"><h3><Ic k="print" />Print {type.label}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
      <div className="abody"><Row label={`Which ${type.source}?`}>
        <select className="ainp" value={ref} onChange={(e) => setRef(e.target.value)} data-testid="tm-print-ref">
          <option value="">Select</option>{(samples.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
      </Row>
      {can('doctemplate.override') ? (
        <Row label="Template" hint="Leave as automatic to use the template that applies to this record">
          <select className="ainp" value={tpl} onChange={(e) => setTpl(e.target.value)} data-testid="tm-print-tpl">
            <option value="">Automatic (most specific published template)</option>
            {(published.data ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.name} — {scopeLabel(x)}</option>)}</select>
        </Row>
      ) : null}
      {!PRINTABLE_HERE.has(type.type) ? <div className="fhint">This document also prints from its own screen, automatically with the template that applies.</div> : null}
      </div>
      <div className="af"><button className="btn" onClick={onClose}>Close</button><button className="btn primary" disabled={!ref} onClick={open}><Ic k="print" />Open PDF</button></div>
    </div></div>
  );
}

/* ================================================================= builder */

const STEPS: Array<[string, string, string]> = [
  ['apply', 'Applies to & publishing', 'Branch, vertical, course, effective date, approval'],
  ['branding', 'Page & branding', 'Logo, institute, colours, title, page size'],
  ['fields', 'Fields', 'Show, hide, rename and reorder each group and field'],
  ['tables', 'Tables', 'Columns of the tables on this document'],
  ['wording', 'Wording & custom fields', 'Body text with {{variables}}, extra fields, partner'],
  ['footer', 'Footer, signatures & QR', 'Terms, signatories, stamp, QR verification, barcode'],
  ['design', 'Design', 'Font size, columns, borders'],
  ['history', 'Versions & audit log', 'Restore a version; who changed what'],
];

export function DocBuilder({ id, type, onClose }: { id: number; type: TypeDef; onClose: () => void }) {
  const { can } = useAuth();
  const ref = useRef_();
  const cloneFrom = id < 0 ? -id : null;
  const [tplId, setTplId] = useState<number | null>(cloneFrom ? null : id);
  const [tick, setTick] = useState(0);
  const d = useFetch<any>(tplId ? `/doc-builder/templates/${tplId}` : null, [tplId, tick]);
  const t = d.data;
  const [cfg, setCfg] = useState<DocCfg | null>(null);
  const [meta, setMeta] = useState<{ name: string; branch_id: string; vertical_id: string; course_id: string; effective_from: string }>({ name: '', branch_id: '', vertical_id: '', course_id: '', effective_from: '' });
  const [dirty, setDirty] = useState(false);
  const [step, setStep] = useState(cloneFrom ? 'apply' : 'fields');
  const [busy, setBusy] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [previewRef, setPreviewRef] = useState('');
  const samples = useFetch<any[]>(can('doctemplate.manage') ? `/doc-builder/samples/${type.type}` : null, [type.type]);
  const lastUrl = useRef<string | null>(null);

  // clone: make the copy first, then edit it
  useEffect(() => {
    if (!cloneFrom) return;
    (async () => {
      const name = await askText('Name the copy', 'Copy');
      if (!name) { onClose(); return; }
      try { const r = await api.post<any>(`/doc-builder/templates/${cloneFrom}/clone`, { name }); setTplId(Number(r.id)); toast('Copied — now choose where it applies'); }
      catch (e) { toast((e as Error).message, true); onClose(); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!t) return;
    setCfg(t.config);
    setMeta({ name: t.name ?? '', branch_id: t.branch_id ? String(t.branch_id) : '', vertical_id: t.vertical_id ? String(t.vertical_id) : '',
      course_id: t.course_id ? String(t.course_id) : '', effective_from: t.effective_from ? String(t.effective_from).slice(0, 10) : '' });
    setDirty(false);
  }, [t?.id, t?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const cfgKey = useMemo(() => (cfg ? JSON.stringify(cfg) : ''), [cfg]);
  useEffect(() => {
    if (!cfg || !can('doctemplate.manage')) return;
    let dead = false;
    const timer = setTimeout(async () => {
      setRendering(true);
      try {
        const res = await fetch('/api/doc-builder/preview', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ doc_type: type.type, config: cfg, ref_id: previewRef || undefined }) });
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        const url = URL.createObjectURL(await res.blob());
        if (dead) { URL.revokeObjectURL(url); return; }
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = url; setPdfUrl(url);
      } catch (e) { if (!dead) toast((e as Error).message, true); } finally { if (!dead) setRendering(false); }
    }, 600);
    return () => { dead = true; clearTimeout(timer); };
  }, [cfgKey, previewRef]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (lastUrl.current) URL.revokeObjectURL(lastUrl.current); }, []);

  const ro = !can('doctemplate.manage');
  const upd = (fn: (c: DocCfg) => DocCfg) => { setCfg((c) => (c ? fn(c) : c)); setDirty(true); };
  const setB = (patch: Partial<DocCfg['branding']>) => upd((c) => ({ ...c, branding: { ...c.branding, ...patch } }));
  const setF = (patch: Partial<DocCfg['footer']>) => upd((c) => ({ ...c, footer: { ...c.footer, ...patch } }));

  const save = async (quiet = false) => {
    if (!tplId || !cfg) return false;
    setBusy(true);
    try {
      await api.patch(`/doc-builder/templates/${tplId}`, { config: cfg, name: meta.name, branch_id: meta.branch_id || null, vertical_id: meta.vertical_id || null,
        course_id: meta.course_id || null, effective_from: meta.effective_from || null });
      setDirty(false); if (!quiet) toast('Draft saved'); setTick((x) => x + 1); return true;
    } catch (e) { toast((e as Error).message, true); return false; } finally { setBusy(false); }
  };
  const post = async (path: string, body: any, msg: string) => {
    if (dirty && !(await save(true))) return;
    setBusy(true);
    try { await api.post(path, body ?? {}); toast(msg); setTick((x) => x + 1); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const close = async () => { if (dirty && !await askConfirm('You have unsaved changes. Close without saving?')) return; onClose(); };

  if (!cfg || !t) return <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 400 }}><div className="abody">Loading the builder…</div></div></div>;
  const vOpts = ref.verticals.filter((v: any) => !meta.branch_id || Number(v.branch_id) === Number(meta.branch_id));
  const cOpts = (ref.courses as any[]).filter((c) => !meta.vertical_id || Number(c.meta?.vertical_id) === Number(meta.vertical_id));
  const varKeys = [...new Set(cfg.groups.flatMap((g) => g.fields.map((f) => f.key)).concat(['institute_name', 'branch_name', 'vertical_name']))].filter((k) => k !== 'photo');

  return (
    <div className="add-scrim" style={{ zIndex: 250 }}>
      <div className="add-modal db-shell" data-testid="doc-builder">
        <div className="ah">
          <h3><Ic k="grid" />{type.label} — {meta.name || 'template'} <span className={`bdg ${STATUS[t.status]?.[1] ?? 'b-gray'}`} style={{ marginLeft: 6 }}>{STATUS[t.status]?.[0] ?? t.status}</span>
            {dirty ? <span className="bdg b-amber" style={{ marginLeft: 6 }}>Unsaved</span> : null}</h3>
          <button className="ax" onClick={close} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="db-body">
          <nav className="db-steps">
            {STEPS.map(([k, l, h], i) => (
              <button key={k} className={`db-step${step === k ? ' on' : ''}`} onClick={() => setStep(k)} data-testid={`db-step-${k}`}>
                <span className="db-n">{String(i + 1).padStart(2, '0')}</span><span><b>{l}</b><br /><span className="sub">{h}</span></span>
              </button>
            ))}
          </nav>
          <div className="db-props">
            {step === 'apply' && (
              <>
                <Row label="Template name"><input className="ainp" value={meta.name} disabled={ro} onChange={(e) => { setMeta({ ...meta, name: e.target.value }); setDirty(true); }} data-testid="db-name" /></Row>
                <Row label="Branch" hint="Blank = every branch"><select className="ainp" value={meta.branch_id} disabled={ro} onChange={(e) => { setMeta({ ...meta, branch_id: e.target.value, vertical_id: '', course_id: '' }); setDirty(true); }} data-testid="db-branch">
                  <option value="">All branches</option>{ref.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Row>
                <Row label="Vertical" hint="Blank = every vertical"><select className="ainp" value={meta.vertical_id} disabled={ro} onChange={(e) => { setMeta({ ...meta, vertical_id: e.target.value, course_id: '' }); setDirty(true); }} data-testid="db-vertical">
                  <option value="">All verticals</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Row>
                <Row label="Course (optional)" hint="Only for documents of this course"><select className="ainp" value={meta.course_id} disabled={ro} onChange={(e) => { setMeta({ ...meta, course_id: e.target.value }); setDirty(true); }}>
                  <option value="">All courses</option>{cOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Row>
                <Row label="Effective from" hint="Blank = as soon as it is published"><input className="ainp" type="date" value={meta.effective_from} disabled={ro} onChange={(e) => { setMeta({ ...meta, effective_from: e.target.value }); setDirty(true); }} data-testid="db-effective" /></Row>
                <div className="db-pubbox">
                  {t.status === 'pending' ? <div className="notice"><Ic k="clock" /><div>Waiting for approval{t.submitted_by_name ? ` (sent by ${t.submitted_by_name})` : ''}.</div></div> : null}
                  {t.review_note && t.status === 'draft' ? <div className="notice"><Ic k="x" /><div>Sent back: {t.review_note}</div></div> : null}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    {can('doctemplate.manage') && !can('doctemplate.approve') && t.status !== 'pending' ? <button className="btn" disabled={busy} onClick={() => post(`/doc-builder/templates/${tplId}/submit`, {}, 'Sent for approval')} data-testid="db-submit"><Ic k="send" />Submit for approval</button> : null}
                    {can('doctemplate.approve') ? <button className="btn primary" disabled={busy} onClick={async () => {
                      const note = await askText(t.status === 'pending' ? 'Approve and publish — note (optional)' : 'Publish — what changed? (optional)', '');
                      if (note === null) return; post(`/doc-builder/templates/${tplId}/publish`, { note }, t.status === 'pending' ? 'Approved and published' : 'Published');
                    }} data-testid="db-publish"><Ic k="check" />{t.status === 'pending' ? 'Approve & publish' : 'Publish'}</button> : null}
                    {can('doctemplate.approve') && t.status === 'pending' ? <button className="btn danger" disabled={busy} onClick={async () => {
                      const note = await askText('What needs changing?', ''); if (!note) return; post(`/doc-builder/templates/${tplId}/reject`, { note }, 'Sent back');
                    }} data-testid="db-reject"><Ic k="x" />Send back</button> : null}
                  </div>
                  <div className="fhint" style={{ marginTop: 6 }}>Publishing creates a new version. A printed document always uses the version that was live when it printed.</div>
                </div>
              </>
            )}

            {step === 'branding' && (
              <>
                <Row label="Document title"><input className="ainp" value={cfg.branding.title} disabled={ro} onChange={(e) => setB({ title: e.target.value })} data-testid="db-title" /></Row>
                <Row label="Institute name" hint="Blank = the vertical's display name"><input className="ainp" value={cfg.branding.institute_name} disabled={ro} onChange={(e) => setB({ institute_name: e.target.value })} /></Row>
                <Row label="Tagline"><input className="ainp" value={cfg.branding.tagline} disabled={ro} onChange={(e) => setB({ tagline: e.target.value })} /></Row>
                <Toggle on={cfg.branding.show_logo} disabled={ro} onChange={(v) => setB({ show_logo: v })} label="Show logo (blank = the vertical's logo)" />
                <ImageIn label="Logo" value={cfg.branding.logo} disabled={ro} onChange={(v) => setB({ logo: v })} testid="db-logo" />
                <Row label="Address" hint="Blank = the vertical's billing address"><input className="ainp" value={cfg.branding.address} disabled={ro} onChange={(e) => setB({ address: e.target.value })} /></Row>
                <div className="form-grid">
                  <Row label="Phone"><input className="ainp" value={cfg.branding.phone} disabled={ro} onChange={(e) => setB({ phone: e.target.value })} /></Row>
                  <Row label="Email"><input className="ainp" value={cfg.branding.email} disabled={ro} onChange={(e) => setB({ email: e.target.value })} /></Row>
                  <Row label="Website"><input className="ainp" value={cfg.branding.website} disabled={ro} onChange={(e) => setB({ website: e.target.value })} /></Row>
                  <Row label="Title position"><select className="ainp" value={cfg.branding.title_align} disabled={ro} onChange={(e) => setB({ title_align: e.target.value as any })}>
                    <option value="left">Left</option><option value="center">Centre</option><option value="right">Right (in the header)</option></select></Row>
                </div>
                <Row label="Header colour"><ColorIn value={cfg.branding.header_bg} disabled={ro} onChange={(v) => setB({ header_bg: v })} /></Row>
                <Row label="Header text colour"><ColorIn value={cfg.branding.header_text} disabled={ro} onChange={(v) => setB({ header_text: v })} /></Row>
                <Row label="Accent colour"><ColorIn value={cfg.branding.accent} disabled={ro} onChange={(v) => setB({ accent: v })} /></Row>
                <div className="form-grid">
                  <Row label="Paper"><select className="ainp" value={cfg.page.size} disabled={ro} onChange={(e) => upd((c) => ({ ...c, page: { ...c.page, size: e.target.value as any } }))}>
                    <option value="A4">A4</option><option value="Letter">Letter</option><option value="CARD">ID card (CR80)</option></select></Row>
                  <Row label="Orientation"><select className="ainp" value={cfg.page.orientation} disabled={ro} onChange={(e) => upd((c) => ({ ...c, page: { ...c.page, orientation: e.target.value as any } }))}>
                    <option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></Row>
                  <Row label="Margin (pt)"><input className="ainp" type="number" value={cfg.page.margin} disabled={ro} onChange={(e) => upd((c) => ({ ...c, page: { ...c.page, margin: Number(e.target.value) } }))} /></Row>
                </div>
              </>
            )}

            {step === 'fields' && (
              <>
                <div className="fhint" style={{ marginBottom: 8 }}>Drag groups and fields to reorder; untick to hide; type to rename. Values always come from the record.</div>
                <DnDList items={cfg.groups} disabled={ro} testid="db-groups" onChange={(groups) => upd((c) => ({ ...c, groups }))}
                  render={(g, set) => (
                    <div>
                      <input className="ainp" style={{ padding: '3px 6px', fontWeight: 700, fontSize: 12.5 }} value={g.title} disabled={ro} onChange={(e) => set({ title: e.target.value } as any)} aria-label={`Title of ${g.key}`} />
                      <div style={{ marginTop: 6 }}>
                        <DnDList items={g.fields} disabled={ro} testid={`db-fields-${g.key}`} onChange={(fields) => set({ fields } as any)}
                          render={(f, setf) => <input className="ainp" style={{ padding: '2px 6px', fontSize: 12 }} value={f.label} disabled={ro} onChange={(e) => setf({ label: e.target.value })} aria-label={`Label for ${f.key}`} />} />
                      </div>
                    </div>
                  )} />
              </>
            )}

            {step === 'tables' && (cfg.tables.length === 0 ? <div className="empty-note">This document has no tables.</div> : (
              <DnDList items={cfg.tables} disabled={ro} testid="db-tables" onChange={(tables) => upd((c) => ({ ...c, tables }))}
                render={(tb, set) => (
                  <div>
                    <input className="ainp" style={{ padding: '3px 6px', fontWeight: 700, fontSize: 12.5 }} value={tb.title} disabled={ro} onChange={(e) => set({ title: e.target.value } as any)} />
                    <div style={{ marginTop: 6 }}><DnDList items={tb.columns} disabled={ro} testid={`db-cols-${tb.key}`} onChange={(columns) => set({ columns } as any)}
                      render={(f, setf) => <input className="ainp" style={{ padding: '2px 6px', fontSize: 12 }} value={f.label} disabled={ro} onChange={(e) => setf({ label: e.target.value })} />} /></div>
                  </div>
                )} />
            ))}

            {step === 'wording' && (
              <>
                <Row label="Body text" hint="Letters and certificates. Click a variable to insert it.">
                  <textarea className="ainp" rows={8} value={cfg.body} disabled={ro} onChange={(e) => upd((c) => ({ ...c, body: e.target.value }))} data-testid="db-body" />
                </Row>
                <div className="db-vars">{varKeys.map((k) => <button key={k} className="chip" type="button" disabled={ro} onClick={() => upd((c) => ({ ...c, body: `${c.body}{{${k}}}` }))}>{`{{${k}}}`}</button>)}</div>
                <h4 style={{ margin: '14px 0 6px' }}>Custom fields</h4>
                {cfg.custom_fields.map((x, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    <input type="checkbox" checked={x.visible} disabled={ro} onChange={(e) => upd((c) => ({ ...c, custom_fields: c.custom_fields.map((y, j) => (j === i ? { ...y, visible: e.target.checked } : y)) }))} />
                    <input className="ainp" placeholder="Label" value={x.label} disabled={ro} onChange={(e) => upd((c) => ({ ...c, custom_fields: c.custom_fields.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) }))} />
                    <input className="ainp" placeholder="Value — text or {{variable}}" value={x.value} disabled={ro} onChange={(e) => upd((c) => ({ ...c, custom_fields: c.custom_fields.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)) }))} />
                    <button className="icon-btn sm" disabled={ro} onClick={() => upd((c) => ({ ...c, custom_fields: c.custom_fields.filter((_, j) => j !== i) }))}><Ic k="x" /></button>
                  </div>
                ))}
                <button className="btn sm" disabled={ro || cfg.custom_fields.length >= 20} onClick={() => upd((c) => ({ ...c, custom_fields: [...c.custom_fields, { label: '', value: '', visible: true }] }))} data-testid="db-add-custom"><Ic k="plus" />Add a custom field</button>
                <h4 style={{ margin: '14px 0 6px' }}>University / partner information</h4>
                <Toggle on={cfg.partner.show} disabled={ro} onChange={(v) => upd((c) => ({ ...c, partner: { ...c.partner, show: v } }))} label="Show partner details (only where authorised)" />
                {cfg.partner.show ? (
                  <>
                    <Row label="Partner name"><input className="ainp" value={cfg.partner.name} disabled={ro} onChange={(e) => upd((c) => ({ ...c, partner: { ...c.partner, name: e.target.value } }))} /></Row>
                    <Row label="Accreditation text"><textarea className="ainp" rows={2} value={cfg.partner.text} disabled={ro} onChange={(e) => upd((c) => ({ ...c, partner: { ...c.partner, text: e.target.value } }))} /></Row>
                  </>
                ) : null}
              </>
            )}

            {step === 'footer' && (
              <>
                <Row label="Terms & conditions"><textarea className="ainp" rows={4} value={cfg.footer.terms} disabled={ro} onChange={(e) => setF({ terms: e.target.value })} /></Row>
                <Row label="Footer note"><input className="ainp" value={cfg.footer.note} disabled={ro} onChange={(e) => setF({ note: e.target.value })} /></Row>
                <Row label="Disclaimer"><input className="ainp" value={cfg.footer.disclaimer} disabled={ro} onChange={(e) => setF({ disclaimer: e.target.value })} /></Row>
                <Toggle on={cfg.footer.show_qr} disabled={ro} onChange={(v) => setF({ show_qr: v })} label="QR code — scan to verify this document online" />
                <Toggle on={cfg.footer.show_barcode} disabled={ro} onChange={(v) => setF({ show_barcode: v })} label="Barcode of the document / ID number" />
                <Toggle on={cfg.footer.show_generated_at} disabled={ro} onChange={(v) => setF({ show_generated_at: v })} label="Print date and time" />
                <h4 style={{ margin: '14px 0 6px' }}>Authorised signatories</h4>
                {cfg.footer.signatories.map((sg, i) => (
                  <div key={i} className="card" style={{ padding: 8, marginBottom: 8 }}>
                    <div className="form-grid">
                      <Row label="Title"><input className="ainp" value={sg.label} disabled={ro} onChange={(e) => setF({ signatories: cfg.footer.signatories.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) })} /></Row>
                      <Row label="Name (optional)"><input className="ainp" value={sg.name} disabled={ro} onChange={(e) => setF({ signatories: cfg.footer.signatories.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) })} /></Row>
                    </div>
                    <ImageIn label="Signature image" value={sg.image} disabled={ro} testid={`db-sig-${i}`} onChange={(v) => setF({ signatories: cfg.footer.signatories.map((y, j) => (j === i ? { ...y, image: v } : y)) })} />
                    <button className="btn sm" disabled={ro} onClick={() => setF({ signatories: cfg.footer.signatories.filter((_, j) => j !== i) })}><Ic k="trash" />Remove</button>
                  </div>
                ))}
                {cfg.footer.signatories.length < 3 ? <button className="btn sm" disabled={ro} onClick={() => setF({ signatories: [...cfg.footer.signatories, { label: 'Authorised Signatory', name: '', image: '' }] })}><Ic k="plus" />Add a signatory</button> : null}
                <ImageIn label="Stamp / seal" value={cfg.footer.stamp_img} disabled={ro} onChange={(v) => setF({ stamp_img: v })} testid="db-stamp" />
              </>
            )}

            {step === 'design' && (
              <>
                <Row label={`Font size: ${cfg.design.font_size}`}><input type="range" min={6} max={13} step={0.5} value={cfg.design.font_size} disabled={ro} onChange={(e) => upd((c) => ({ ...c, design: { ...c.design, font_size: Number(e.target.value) } }))} /></Row>
                <Row label="Field columns"><select className="ainp" value={cfg.design.columns} disabled={ro} onChange={(e) => upd((c) => ({ ...c, design: { ...c.design, columns: Number(e.target.value) as 1 | 2 | 3 } }))}>
                  <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></Row>
                <Toggle on={cfg.design.borders} disabled={ro} onChange={(v) => upd((c) => ({ ...c, design: { ...c.design, borders: v } }))} label="Table lines" />
                <Toggle on={cfg.design.group_titles} disabled={ro} onChange={(v) => upd((c) => ({ ...c, design: { ...c.design, group_titles: v } }))} label="Group headings" />
                <button className="btn sm" disabled={ro} onClick={async () => { if (await askConfirm('Reset the whole design to the default?')) { setCfg(type.default_config); setDirty(true); } }}><Ic k="refresh" />Reset to default design</button>
              </>
            )}

            {step === 'history' && (
              <>
                <h4 style={{ margin: '0 0 6px' }}>Published versions</h4>
                {(t.versions ?? []).length === 0 ? <div className="sub">Not published yet.</div> : (t.versions as any[]).map((v) => (
                  <div key={v.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                    <b>v{v.version_no}</b><span className="sub" style={{ flex: 1 }}>{fmtDateTimeIST(v.published_at)}{v.published_by_name ? ` · ${v.published_by_name}` : ''}{v.note ? ` — ${v.note}` : ''}</span>
                    {can('doctemplate.manage') ? <button className="btn sm" onClick={async () => { if (await askConfirm(`Copy version ${v.version_no} back to the draft?`)) post(`/doc-builder/templates/${tplId}/restore/${v.id}`, {}, `Version ${v.version_no} restored to the draft`); }}><Ic k="restore" />Restore</button> : null}
                  </div>
                ))}
                <h4 style={{ margin: '14px 0 6px' }}>Audit log</h4>
                {(t.audit ?? []).map((a: any, i: number) => (
                  <div key={i} className="sub" style={{ padding: '3px 0' }}><b>{String(a.action).replace(/_/g, ' ')}</b> · {fmtDateTimeIST(a.created_at)}{a.actor_name ? ` · ${a.actor_name}` : ''}{a.note ? ` — ${a.note}` : ''}</div>
                ))}
              </>
            )}
          </div>
          <div className="db-preview">
            <div className="db-prevbar">
              <span className="sub">{rendering ? 'Rendering…' : 'Live preview'}</span>
              <select className="ainp" style={{ maxWidth: 260 }} value={previewRef} onChange={(e) => setPreviewRef(e.target.value)} data-testid="db-preview-ref">
                <option value="">Sample data</option>{(samples.data ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
            </div>
            {pdfUrl ? <iframe title="Document preview" src={`${pdfUrl}#toolbar=0&navpanes=0&view=FitH`} style={{ width: '100%', flex: 1, border: 'none' }} data-testid="db-preview" />
              : <div className="empty-note">Preparing the preview…</div>}
          </div>
        </div>
        <div className="af">
          <span className="sub" style={{ flex: 1 }}>{t.status === 'published' ? 'Edits are a draft until you publish again.' : ''}</span>
          <button className="btn" onClick={close}>Close</button>
          {can('doctemplate.manage') ? <button className="btn primary" disabled={busy || !dirty} onClick={() => save()} data-testid="db-save"><Ic k="save" />{busy ? 'Saving…' : 'Save draft'}</button> : null}
        </div>
      </div>
    </div>
  );
}


/* ======================================================== public verification */

/** PUBLIC — what a scanned QR code opens (/verify/<code>). Shows only what the document prints. */
export function PublicDocVerify({ code }: { code: string }) {
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch(`/api/public/verify/${encodeURIComponent(code)}`).then(async (res) => {
      if (!res.ok) throw new Error('This verification code was not found.');
      setR(await res.json());
    }).catch((e) => setErr((e as Error).message));
  }, [code]);
  const LABEL: Record<string, string> = { course_name: 'Course', issue_date: 'Issued on', completion_date: 'Completed on', grade: 'Grade / result',
    percentage: 'Percentage', result: 'Result', designation: 'Designation', branch_name: 'Branch', vertical_name: 'Vertical', exam_name: 'Examination' };
  return (
    <div style={{ maxWidth: 560, margin: '40px auto', padding: '0 16px' }} data-testid="doc-verify">
      <div className="card" style={{ padding: 24 }}>
        {err ? <><h2 style={{ marginTop: 0 }}>Not verified</h2><p className="page-sub">{err}</p></>
          : !r ? <p className="page-sub">Checking…</p>
            : !r.valid && !r.revoked ? <><h2 style={{ marginTop: 0, color: 'var(--danger)' }}>Not verified</h2><p className="page-sub">No document matches the code <b className="mono">{r.code}</b>.</p></>
              : (
                <>
                  <h2 style={{ marginTop: 0, color: r.valid ? 'var(--success)' : 'var(--danger)' }}>{r.valid ? 'Verified ✓' : 'Revoked'}</h2>
                  <p className="page-sub">{r.valid ? `This ${r.document?.toLowerCase()} was issued by ${r.institute || 'the institute'} and is genuine.`
                    : `This ${r.document?.toLowerCase()} was issued by ${r.institute || 'the institute'} but is no longer valid.`}</p>
                  <table className="tbl"><tbody>
                    {([['Document', r.title || r.document], ['Issued to', r.holder], ['Number', r.doc_no], ['Issued by', r.institute],
                      ...Object.entries(r.details ?? {}).map(([k, v]) => [LABEL[k] ?? k, v])] as Array<[string, any]>)
                      .filter(([, v]) => v).map(([k, v]) => <tr key={k}><td style={{ width: 160, color: 'var(--muted)' }}>{k}</td><td><b>{String(v)}</b></td></tr>)}
                  </tbody></table>
                  <div className="sub" style={{ marginTop: 10 }}>Verification code {r.code}</div>
                </>
              )}
      </div>
    </div>
  );
}
