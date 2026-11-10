/**
 * FEE INVOICE TEMPLATE BUILDER (client 5 Nov 2026 — "Template Setting For Fee Invoice").
 * Administration › Fee Invoice Builder. Left: templates + the 8 builder steps the client listed.
 * Centre: the A4 invoice, LIVE — it is the real PDF the server renders from the design as you
 * edit (what you see is exactly what prints). Right: the properties of the chosen step, with
 * drag-and-drop ordering of sections, fields, fee-table columns and summary rows.
 * Templates are versioned: Save keeps a draft; Publish creates a new version; an invoice keeps the
 * version it was issued with; restore any earlier version; per-branch default templates.
 */
import { DragEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { toast, useFetch, useRef_ } from './refdata';
import { askConfirm, askText } from './askdialog';
import { fmtDateTimeIST } from './daterange';

type Field = { key: string; label: string; visible: boolean };
export interface TplConfig {
  v: 1; layout: 'professional' | 'minimal' | 'detailed';
  page: { size: 'A4' | 'Letter'; orientation: 'portrait' | 'landscape'; margin: number };
  branding: { institute_name: string; tagline: string; title: string; show_logo: boolean; logo: string; branch_name: boolean;
    address: string; phone: string; email: string; website: string; gstin: string; header_bg: string; header_text: string; accent: string;
    title_align: 'left' | 'right' | 'center' };
  sections: Array<{ key: string; visible: boolean; title: string }>;
  invoice_fields: Field[]; student_fields: Field[]; payment_fields: Field[];
  columns: Field[]; extra_rows: Array<{ description: string; amount: string }>; summary: Field[];
  custom_fields: Array<{ label: string; value: string; visible: boolean }>;
  footer: { terms: string; refund_policy: string; payment_instructions: string; bank_details: string; upi_qr: string; upi_id: string;
    signature_label: string; signature_img: string; stamp_img: string; accountant_name: string; thank_you: string;
    show_generated_at: boolean; show_page_number: boolean; note: string };
  design: { font_size: number; spacing: 'compact' | 'normal' | 'relaxed'; borders: boolean; striped: boolean; rounded_header: boolean };
}

const STEPS: Array<{ id: string; n: string; label: string; hint: string }> = [
  { id: 'page', n: '01', label: 'Page Setup', hint: 'Paper size, orientation, margins and the order of sections' },
  { id: 'branding', n: '02', label: 'Branding & Header', hint: 'Logo, institute details, colours and title' },
  { id: 'fields', n: '03', label: 'Invoice Fields', hint: 'Invoice & student fields, custom fields' },
  { id: 'table', n: '04', label: 'Fee Table', hint: 'Columns, totals and extra rows' },
  { id: 'payment', n: '05', label: 'Payment Section', hint: 'Payment details, bank details and UPI QR' },
  { id: 'footer', n: '06', label: 'Footer & Terms', hint: 'Terms, refund policy, signature and stamp' },
  { id: 'design', n: '07', label: 'Advanced Design', hint: 'Font size, spacing, borders' },
  { id: 'publish', n: '08', label: 'Preview & Publish', hint: 'Branch, default, publish and version history' },
];
const SECTION_LABEL: Record<string, string> = {
  header: 'Branding & header', invoice_info: 'Invoice information', student_info: 'Student information', fee_table: 'Fee breakdown table',
  summary: 'Calculation summary', amount_words: 'Amount in words', payment: 'Payment details', custom: 'Additional details (custom fields)',
  notes_terms: 'Terms, refund policy & instructions', footer: 'Signature, stamp & footer',
};
const STATUS_BADGE: Record<string, [string, string]> = {
  draft: ['Draft — not published', 'b-gray'], published: ['Published', 'b-green'], unpublished: ['Unpublished', 'b-amber'],
};

/* ------------------------------------------------------------ small widgets */

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="fld" style={{ marginBottom: 10 }}>
      <label>{label}</label>{children}{hint && <span className="fhint">{hint}</span>}
    </div>
  );
}
function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '4px 0' }}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />{label}
    </label>
  );
}
function ColorIn({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <input type="color" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={{ width: 38, height: 28, padding: 0, border: '1px solid var(--line)' }} />
      <input className="ainp mono" style={{ width: 92 }} value={value} disabled={disabled} onChange={(e) => /^#[0-9a-f]{0,6}$/i.test(e.target.value) && onChange(e.target.value)} />
    </span>
  );
}

/** PNG / JPG / SVG → a JPEG data URL (white background, ≤ 700 px) the PDF writer can embed. */
async function toJpeg(file: File, maxW = 700): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error('That file is not an image.')); img.src = url; });
    const s = Math.min(1, maxW / (img.naturalWidth || maxW));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((img.naturalWidth || maxW) * s)); c.height = Math.max(1, Math.round((img.naturalHeight || maxW / 2) * s));
    const g = c.getContext('2d')!; g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.9; let out = c.toDataURL('image/jpeg', q);
    while (out.length > 800_000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
    if (out.length > 800_000) throw new Error('That image is too large — use one under about 500 KB.');
    return out;
  } finally { URL.revokeObjectURL(url); }
}
function ImageIn({ label, value, onChange, disabled, testid }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; testid: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <Row label={label} hint="PNG, JPG or SVG — converted for the PDF automatically.">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {value ? <img src={value} alt="" style={{ maxHeight: 44, maxWidth: 120, border: '1px solid var(--line)', borderRadius: 4, background: '#fff' }} /> : <span className="sub">None</span>}
        <input ref={ref} type="file" accept="image/png,image/jpeg,image/svg+xml" hidden data-testid={testid}
          onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { onChange(await toJpeg(f)); } catch (err) { toast((err as Error).message, true); } }} />
        <button className="btn sm" type="button" disabled={disabled} onClick={() => ref.current?.click()}><Ic k="up" />{value ? 'Replace' : 'Upload'}</button>
        {value && <button className="btn sm" type="button" disabled={disabled} onClick={() => onChange('')}><Ic k="x" />Remove</button>}
      </div>
    </Row>
  );
}

/** A drag-and-drop ordered list (with ↑ ↓ for keyboard users) of rows that can be shown/hidden
 *  and relabelled. */
function DnDList<T extends { key: string; visible: boolean }>({ items, onChange, render, disabled, testid }: {
  items: T[]; onChange: (next: T[]) => void; render: (it: T, set: (patch: Partial<T>) => void) => ReactNode; disabled?: boolean; testid: string;
}) {
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items]; const [x] = next.splice(from, 1); next.splice(to, 0, x); onChange(next);
  };
  return (
    <div data-testid={testid} style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
      {items.map((it, i) => (
        <div key={it.key} draggable={!disabled}
          onDragStart={(e: DragEvent) => { drag.current = i; e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={(e: DragEvent) => { e.preventDefault(); setOver(i); }}
          onDragLeave={() => setOver((o) => (o === i ? null : o))}
          onDrop={(e: DragEvent) => { e.preventDefault(); if (drag.current != null) move(drag.current, i); drag.current = null; setOver(null); }}
          data-testid={`${testid}-${it.key}`}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', background: over === i ? 'var(--primary-soft, #eef2ff)' : i % 2 ? 'var(--surface-2, #fafafa)' : 'var(--surface, #fff)',
            borderTop: i ? '1px solid var(--line)' : 'none', opacity: it.visible ? 1 : 0.55, cursor: disabled ? 'default' : 'grab' }}>
          <span title="Drag to reorder" style={{ color: 'var(--text-muted)', userSelect: 'none' }}>⋮⋮</span>
          <input type="checkbox" checked={it.visible} disabled={disabled} title={it.visible ? 'Shown — untick to hide' : 'Hidden — tick to show'}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, visible: e.target.checked } : x)))} />
          <div style={{ flex: 1, minWidth: 0 }}>{render(it, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))))}</div>
          <button className="icon-btn sm" type="button" disabled={disabled || i === 0} title="Move up" onClick={() => move(i, i - 1)}>↑</button>
          <button className="icon-btn sm" type="button" disabled={disabled || i === items.length - 1} title="Move down" onClick={() => move(i, i + 1)}>↓</button>
        </div>
      ))}
    </div>
  );
}
const labelEdit = (disabled?: boolean) => (it: Field, set: (p: Partial<Field>) => void) => (
  <input className="ainp" style={{ padding: '3px 6px', fontSize: 12.5 }} value={it.label} disabled={disabled} onChange={(e) => set({ label: e.target.value })} aria-label={`Label for ${it.key}`} />
);

/* ------------------------------------------------------------ the screen */

export function InvoiceTemplateBuilder() {
  const { can } = useAuth();
  const canEdit = can('settings.update');
  const ref = useRef_();
  const list = useFetch<any[]>('/invoice-templates', []);
  const catalog = useFetch<any>('/invoice-templates/catalog', []);
  const invoices = useFetch<any[]>('/invoices?limit=50', []);
  const [selId, setSelId] = useState<number | null>(null);
  const [tpl, setTpl] = useState<any | null>(null);
  const [cfg, setCfg] = useState<TplConfig | null>(null);
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [step, setStep] = useState('page');
  const [previewWith, setPreviewWith] = useState<string>('sample:intra');
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verTick, setVerTick] = useState(0);
  const versions = useFetch<any[]>(selId ? `/invoice-templates/${selId}/versions` : null, [selId, verTick]);
  const templates = list.data ?? [];

  // first load: open the default template (or the first one)
  useEffect(() => {
    if (selId == null && templates.length) setSelId(Number((templates.find((t) => t.is_default) ?? templates[0]).id));
  }, [templates.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = async (id: number) => {
    try {
      const t = await api.get<any>(`/invoice-templates/${id}`);
      setTpl(t); setCfg(t.config); setName(t.name); setBranchId(t.branch_id ? String(t.branch_id) : ''); setDirty(false);
    } catch (e) { toast((e as Error).message, true); }
  };
  useEffect(() => { if (selId != null) void load(selId); }, [selId]);

  const set = (fn: (c: TplConfig) => TplConfig) => { setCfg((c) => (c ? fn(c) : c)); setDirty(true); };
  const setB = (patch: Partial<TplConfig['branding']>) => set((c) => ({ ...c, branding: { ...c.branding, ...patch } }));
  const setF = (patch: Partial<TplConfig['footer']>) => set((c) => ({ ...c, footer: { ...c.footer, ...patch } }));
  const setD = (patch: Partial<TplConfig['design']>) => set((c) => ({ ...c, design: { ...c.design, ...patch } }));
  const setP = (patch: Partial<TplConfig['page']>) => set((c) => ({ ...c, page: { ...c.page, ...patch } }));

  // LIVE PREVIEW — the real PDF, re-rendered ~0.6 s after the last change
  const lastUrl = useRef<string | null>(null);
  const cfgKey = useMemo(() => (cfg ? JSON.stringify(cfg) : ''), [cfg]);
  useEffect(() => {
    if (!cfg) return;
    let dead = false;
    const t = setTimeout(async () => {
      setRendering(true);
      try {
        const [kind, val] = previewWith.split(':');
        const path = kind === 'invoice' ? `/invoice-templates/preview/invoice/${val}` : '/invoice-templates/preview';
        const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ config: cfg, supply: kind === 'sample' ? val : undefined }) });
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        const url = URL.createObjectURL(await res.blob());
        if (dead) { URL.revokeObjectURL(url); return; }
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = url; setPdfUrl(url);
      } catch (e) { if (!dead) toast((e as Error).message, true); } finally { if (!dead) setRendering(false); }
    }, 600);
    return () => { dead = true; clearTimeout(t); };
  }, [cfgKey, previewWith]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (lastUrl.current) URL.revokeObjectURL(lastUrl.current); }, []);

  const confirmDiscard = async () => !dirty || await askConfirm('You have unsaved changes to this template. Discard them?');
  const save = async (quiet = false) => {
    if (!tpl || !cfg) return false;
    setBusy(true);
    try {
      const t = await api.patch<any>(`/invoice-templates/${tpl.id}`, { name, branch_id: branchId ? Number(branchId) : null, config: cfg });
      setTpl(t); setCfg(t.config); setDirty(false); list.reload();
      if (!quiet) toast('Draft saved — publish it to use it on new invoices.');
      return true;
    } catch (e) { toast((e as Error).message, true); return false; } finally { setBusy(false); }
  };
  const create = async (from?: number) => {
    if (!await confirmDiscard()) return;
    const nm = await askText(from ? 'Name for the copy' : 'Name for the new invoice template', from ? `Copy of ${name}` : 'Fee Invoice');
    if (!nm?.trim()) return;
    let layout = 'professional';
    if (!from) layout = (await askText('Start from which layout? Type professional, minimal or detailed', 'professional'))?.trim().toLowerCase() || 'professional';
    try {
      const t = from ? await api.post<any>(`/invoice-templates/${from}/duplicate`, {}) : await api.post<any>('/invoice-templates', { name: nm.trim(), layout });
      if (from && nm.trim() !== t.name) await api.patch(`/invoice-templates/${t.id}`, { name: nm.trim() });
      list.reload(); setSelId(Number(t.id)); toast(from ? 'Template duplicated.' : 'Template created — design it, then Publish.');
    } catch (e) { toast((e as Error).message, true); }
  };
  const act = async (what: 'publish' | 'unpublish' | 'default' | 'delete') => {
    if (!tpl) return;
    if (dirty && what !== 'delete' && !(await save(true))) return;
    try {
      if (what === 'publish') {
        const note = await askText('What changed in this version? (optional)', '');
        if (note === null) return;
        const r = await api.post<any>(`/invoice-templates/${tpl.id}/publish`, { note: note || undefined });
        toast(`Version ${r.version_no} published — new invoices${tpl.branch_id ? ` of ${tpl.branch_name}` : ''} use it; issued invoices keep their version.`);
      } else if (what === 'unpublish') {
        if (!await askConfirm('Unpublish this template? New invoices fall back to the next default (or the built-in layout). Issued invoices are not affected.')) return;
        await api.post(`/invoice-templates/${tpl.id}/unpublish`, {}); toast('Unpublished.');
      } else if (what === 'default') {
        await api.post(`/invoice-templates/${tpl.id}/default`, {}); toast(`Now the default invoice template${tpl.branch_id ? ` for ${tpl.branch_name}` : ' (all branches)'}.`);
      } else {
        if (!await askConfirm(`Delete the template "${tpl.name}"? Issued invoices keep their design.`)) return;
        await api.del(`/invoice-templates/${tpl.id}`); toast('Template deleted.'); setSelId(null); setTpl(null); setCfg(null);
      }
      list.reload(); setVerTick((x) => x + 1); if (what !== 'delete') await load(tpl.id);
    } catch (e) { toast((e as Error).message, true); }
  };
  const restore = async (v: any) => {
    if (!tpl || !await confirmDiscard()) return;
    try {
      await api.post(`/invoice-templates/${tpl.id}/restore/${v.id}`, {});
      await load(tpl.id); toast(`Version ${v.version_no} restored into the draft — Publish to make it live.`);
    } catch (e) { toast((e as Error).message, true); }
  };
  const applyLayout = async (layout: string) => {
    if (!cfg || !catalog.data?.layouts?.[layout]) return;
    if (!await askConfirm(`Apply the ${layout} layout? Columns, sections, colours and spacing are reset; your branding text, images and footer text are kept.`)) return;
    const L = catalog.data.layouts[layout] as TplConfig;
    set((c) => ({ ...L, branding: { ...L.branding, ...c.branding, header_bg: L.branding.header_bg, header_text: L.branding.header_text },
      footer: { ...L.footer, ...c.footer }, custom_fields: c.custom_fields, extra_rows: c.extra_rows }));
  };

  const vars: string[] = catalog.data?.variables ?? [];
  const ro = !canEdit;

  const panel = !cfg ? null : (() => {
    switch (step) {
      case 'page': return (
        <>
          <Row label="Layout preset" hint="Professional, minimal or detailed — a starting point you can change">
            <div style={{ display: 'flex', gap: 6 }}>
              {(['professional', 'minimal', 'detailed'] as const).map((l) => (
                <button key={l} type="button" className={`btn sm${cfg.layout === l ? ' primary' : ''}`} disabled={ro} onClick={() => void applyLayout(l)}>{l[0].toUpperCase() + l.slice(1)}</button>
              ))}
            </div>
          </Row>
          <div className="form-grid">
            <Row label="Paper size"><select className="ainp" value={cfg.page.size} disabled={ro} onChange={(e) => setP({ size: e.target.value as any })}><option>A4</option><option>Letter</option></select></Row>
            <Row label="Orientation"><select className="ainp" value={cfg.page.orientation} disabled={ro} onChange={(e) => setP({ orientation: e.target.value as any })}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></Row>
          </div>
          <Row label={`Margin — ${cfg.page.margin} pt`}><input type="range" min={18} max={72} value={cfg.page.margin} disabled={ro} onChange={(e) => setP({ margin: Number(e.target.value) })} /></Row>
          <div className="sechead" style={{ margin: '8px 0 6px' }}>Sections — drag to arrange, untick to hide</div>
          <DnDList testid="ib-sections" disabled={ro} items={cfg.sections} onChange={(sections) => set((c) => ({ ...c, sections }))}
            render={(it, s) => (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12.5, minWidth: 0, flex: 1 }}>{SECTION_LABEL[it.key] ?? it.key}</span>
                {['student_info', 'fee_table', 'payment', 'custom', 'invoice_info'].includes(it.key) && (
                  <input className="ainp" style={{ width: 110, padding: '3px 6px', fontSize: 12 }} placeholder="Heading" value={it.title} disabled={ro} onChange={(e) => s({ title: e.target.value })} aria-label={`Heading for ${it.key}`} />
                )}
              </div>
            )} />
        </>
      );
      case 'branding': return (
        <>
          <Row label="Institute name" hint="Blank = the invoice's vertical / legal name (e.g. BCL / Insta Infotech)"><input className="ainp" value={cfg.branding.institute_name} disabled={ro} onChange={(e) => setB({ institute_name: e.target.value })} data-testid="ib-inst" /></Row>
          <Row label="Tagline (optional)"><input className="ainp" value={cfg.branding.tagline} disabled={ro} onChange={(e) => setB({ tagline: e.target.value })} /></Row>
          <div className="form-grid">
            <Row label="Invoice title"><input className="ainp" value={cfg.branding.title} disabled={ro} onChange={(e) => setB({ title: e.target.value })} data-testid="ib-title" /></Row>
            <Row label="Title position"><select className="ainp" value={cfg.branding.title_align} disabled={ro} onChange={(e) => setB({ title_align: e.target.value as any })}><option value="right">Right</option><option value="left">Left</option><option value="center">Centre</option></select></Row>
          </div>
          <Toggle label="Show logo" on={cfg.branding.show_logo} disabled={ro} onChange={(v) => setB({ show_logo: v })} />
          <ImageIn label="Logo" value={cfg.branding.logo} disabled={ro} onChange={(v) => setB({ logo: v })} testid="ib-logo" />
          <Toggle label="Show the invoice's branch name" on={cfg.branding.branch_name} disabled={ro} onChange={(v) => setB({ branch_name: v })} />
          <div className="sub" style={{ margin: '6px 0' }}>Address, contact and GSTIN default to the invoice's branch / vertical. Fill these only to override them.</div>
          <Row label="Address"><textarea className="ainp" rows={2} value={cfg.branding.address} disabled={ro} onChange={(e) => setB({ address: e.target.value })} /></Row>
          <div className="form-grid">
            <Row label="Contact number"><input className="ainp" value={cfg.branding.phone} disabled={ro} onChange={(e) => setB({ phone: e.target.value })} /></Row>
            <Row label="Email"><input className="ainp" value={cfg.branding.email} disabled={ro} onChange={(e) => setB({ email: e.target.value })} /></Row>
            <Row label="Website"><input className="ainp" value={cfg.branding.website} disabled={ro} onChange={(e) => setB({ website: e.target.value })} /></Row>
            <Row label="GSTIN"><input className="ainp" value={cfg.branding.gstin} disabled={ro} onChange={(e) => setB({ gstin: e.target.value.toUpperCase() })} /></Row>
          </div>
          <div className="form-grid">
            <Row label="Header background" hint="White = no band"><ColorIn value={cfg.branding.header_bg} disabled={ro} onChange={(v) => setB({ header_bg: v })} /></Row>
            <Row label="Header text"><ColorIn value={cfg.branding.header_text} disabled={ro} onChange={(v) => setB({ header_text: v })} /></Row>
            <Row label="Accent colour"><ColorIn value={cfg.branding.accent} disabled={ro} onChange={(v) => setB({ accent: v })} /></Row>
          </div>
        </>
      );
      case 'fields': return (
        <>
          <div className="sechead" style={{ marginBottom: 6 }}>Invoice information</div>
          <DnDList testid="ib-invfields" disabled={ro} items={cfg.invoice_fields} onChange={(invoice_fields) => set((c) => ({ ...c, invoice_fields }))} render={labelEdit(ro)} />
          <div className="sechead" style={{ margin: '12px 0 6px' }}>Student information</div>
          <DnDList testid="ib-stufields" disabled={ro} items={cfg.student_fields} onChange={(student_fields) => set((c) => ({ ...c, student_fields }))} render={labelEdit(ro)} />
          <div className="sechead" style={{ margin: '12px 0 6px' }}>Custom fields</div>
          <div className="sub" style={{ marginBottom: 6 }}>Any text, with variables such as <span className="mono">{'{{student_name}}'}</span>. Shown in the "Additional details" section (switch it on under Page Setup).</div>
          {cfg.custom_fields.map((cf, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input className="ainp" style={{ width: 120 }} placeholder="Label" value={cf.label} disabled={ro} onChange={(e) => set((c) => ({ ...c, custom_fields: c.custom_fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))} />
              <input className="ainp" style={{ flex: 1 }} placeholder="Value or {{variable}}" value={cf.value} disabled={ro} onChange={(e) => set((c) => ({ ...c, custom_fields: c.custom_fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) }))} />
              <button className="icon-btn sm" type="button" disabled={ro} title="Remove" onClick={() => set((c) => ({ ...c, custom_fields: c.custom_fields.filter((_, j) => j !== i) }))}><Ic k="x" /></button>
            </div>
          ))}
          <button className="btn sm" type="button" disabled={ro} data-testid="ib-addcustom" onClick={() => set((c) => ({ ...c, custom_fields: [...c.custom_fields, { label: '', value: '', visible: true }],
            sections: c.sections.map((s) => (s.key === 'custom' ? { ...s, visible: true } : s)) }))}><Ic k="plus" />Add custom field</button>
          <details style={{ marginTop: 10 }}><summary className="sub" style={{ cursor: 'pointer' }}>Available variables</summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>{vars.map((v) => <span key={v} className="bdg b-gray mono" style={{ fontSize: 10.5 }}>{`{{${v}}}`}</span>)}</div>
          </details>
        </>
      );
      case 'table': return (
        <>
          <div className="sechead" style={{ marginBottom: 6 }}>Fee table columns</div>
          <div className="sub" style={{ marginBottom: 6 }}>CGST + SGST print for an intra-state invoice and IGST for inter-state, automatically.</div>
          <DnDList testid="ib-columns" disabled={ro} items={cfg.columns} onChange={(columns) => set((c) => ({ ...c, columns }))} render={labelEdit(ro)} />
          <div className="sechead" style={{ margin: '12px 0 6px' }}>Calculation summary</div>
          <div className="sub" style={{ marginBottom: 6 }}>Values come from the invoice and fee records — the template never calculates money. A row with no value on an invoice is skipped.</div>
          <DnDList testid="ib-summary" disabled={ro} items={cfg.summary} onChange={(summary) => set((c) => ({ ...c, summary }))} render={labelEdit(ro)} />
          <div className="sechead" style={{ margin: '12px 0 6px' }}>Extra fee rows (display only)</div>
          <div className="sub" style={{ marginBottom: 6 }}>Printed under the fee lines (e.g. "Study material — included"); not added to the totals.</div>
          {cfg.extra_rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input className="ainp" style={{ flex: 1 }} placeholder="Description" value={r.description} disabled={ro} onChange={(e) => set((c) => ({ ...c, extra_rows: c.extra_rows.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) }))} />
              <input className="ainp" style={{ width: 90 }} placeholder="Amount" value={r.amount} disabled={ro} onChange={(e) => set((c) => ({ ...c, extra_rows: c.extra_rows.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[^0-9.]/g, '') } : x)) }))} />
              <button className="icon-btn sm" type="button" disabled={ro} title="Remove" onClick={() => set((c) => ({ ...c, extra_rows: c.extra_rows.filter((_, j) => j !== i) }))}><Ic k="x" /></button>
            </div>
          ))}
          <button className="btn sm" type="button" disabled={ro} onClick={() => set((c) => ({ ...c, extra_rows: [...c.extra_rows, { description: '', amount: '' }] }))}><Ic k="plus" />Add row</button>
        </>
      );
      case 'payment': return (
        <>
          <div className="sechead" style={{ marginBottom: 6 }}>Payment details (latest payment on the enrolment)</div>
          <DnDList testid="ib-payfields" disabled={ro} items={cfg.payment_fields} onChange={(payment_fields) => set((c) => ({ ...c, payment_fields }))} render={labelEdit(ro)} />
          <Row label="Bank account details" hint="Printed in the payment section"><textarea className="ainp" rows={3} value={cfg.footer.bank_details} disabled={ro} onChange={(e) => setF({ bank_details: e.target.value })} placeholder={'Bank: HDFC Bank\nA/c: 50200012345678 · IFSC: HDFC0001234'} /></Row>
          <Row label="UPI ID"><input className="ainp" value={cfg.footer.upi_id} disabled={ro} onChange={(e) => setF({ upi_id: e.target.value })} placeholder="institute@hdfcbank" /></Row>
          <ImageIn label="UPI QR code (image)" value={cfg.footer.upi_qr} disabled={ro} onChange={(v) => setF({ upi_qr: v })} testid="ib-qr" />
        </>
      );
      case 'footer': return (
        <>
          <Row label="Terms and conditions"><textarea className="ainp" rows={3} value={cfg.footer.terms} disabled={ro} onChange={(e) => setF({ terms: e.target.value })} data-testid="ib-terms" /></Row>
          <Row label="Refund policy"><textarea className="ainp" rows={2} value={cfg.footer.refund_policy} disabled={ro} onChange={(e) => setF({ refund_policy: e.target.value })} /></Row>
          <Row label="Payment instructions"><textarea className="ainp" rows={2} value={cfg.footer.payment_instructions} disabled={ro} onChange={(e) => setF({ payment_instructions: e.target.value })} /></Row>
          <Row label="Thank-you message"><input className="ainp" value={cfg.footer.thank_you} disabled={ro} onChange={(e) => setF({ thank_you: e.target.value })} /></Row>
          <div className="form-grid">
            <Row label="Signature label"><input className="ainp" value={cfg.footer.signature_label} disabled={ro} onChange={(e) => setF({ signature_label: e.target.value })} /></Row>
            <Row label="Accountant name"><input className="ainp" value={cfg.footer.accountant_name} disabled={ro} onChange={(e) => setF({ accountant_name: e.target.value })} /></Row>
          </div>
          <ImageIn label="Authorised signature (image)" value={cfg.footer.signature_img} disabled={ro} onChange={(v) => setF({ signature_img: v })} testid="ib-sign" />
          <ImageIn label="Institute stamp (image)" value={cfg.footer.stamp_img} disabled={ro} onChange={(v) => setF({ stamp_img: v })} testid="ib-stamp" />
          <Row label="Footer note (every page)"><input className="ainp" value={cfg.footer.note} disabled={ro} onChange={(e) => setF({ note: e.target.value })} placeholder="e.g. This is a computer-generated invoice." /></Row>
          <Toggle label="Show generated date & time" on={cfg.footer.show_generated_at} disabled={ro} onChange={(v) => setF({ show_generated_at: v })} />
          <Toggle label="Show page numbers" on={cfg.footer.show_page_number} disabled={ro} onChange={(v) => setF({ show_page_number: v })} />
        </>
      );
      case 'design': return (
        <>
          <Row label={`Base font size — ${cfg.design.font_size} pt`}><input type="range" min={7} max={12} step={0.5} value={cfg.design.font_size} disabled={ro} onChange={(e) => setD({ font_size: Number(e.target.value) })} /></Row>
          <Row label="Spacing"><select className="ainp" value={cfg.design.spacing} disabled={ro} onChange={(e) => setD({ spacing: e.target.value as any })}><option value="compact">Compact</option><option value="normal">Normal</option><option value="relaxed">Relaxed</option></select></Row>
          <Toggle label="Table borders" on={cfg.design.borders} disabled={ro} onChange={(v) => setD({ borders: v })} />
          <Toggle label="Striped table rows" on={cfg.design.striped} disabled={ro} onChange={(v) => setD({ striped: v })} />
          <div className="sub" style={{ marginTop: 8 }}>Visibility rules: GST columns and totals show only for the supply type that charges them; summary rows with no value (e.g. no discount) are skipped; empty fields are not printed.</div>
        </>
      );
      case 'publish': return (
        <>
          <Row label="Applies to" hint="A branch template overrides the global one for that branch's invoices">
            <select className="ainp" value={branchId} disabled={ro} onChange={(e) => { setBranchId(e.target.value); setDirty(true); }} data-testid="ib-branch">
              <option value="">All branches (global)</option>
              {(ref.branches ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Row>
          <div className="notice" style={{ marginBottom: 10 }}><Ic k="shield" /><div>
            <b>Save draft</b> keeps your changes without affecting any invoice. <b>Publish</b> creates a new version that every invoice
            issued from now on uses{tpl?.is_default ? '' : ' (once this template is the default)'}. An issued invoice always keeps the version it was issued with.
          </div></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <button className="btn primary" type="button" disabled={ro || busy} onClick={() => void act('publish')} data-testid="ib-publish"><Ic k="check" />Publish{dirty ? ' changes' : ''}</button>
            {tpl?.status === 'published' && !tpl?.is_default && <button className="btn" type="button" disabled={ro} onClick={() => void act('default')} data-testid="ib-default"><Ic k="award" />Make default</button>}
            {tpl?.status === 'published' && <button className="btn" type="button" disabled={ro} onClick={() => void act('unpublish')}><Ic k="ban" />Unpublish</button>}
            <button className="btn" type="button" disabled={ro} onClick={() => void act('delete')} style={{ color: 'var(--danger)' }}><Ic k="trash" />Delete</button>
          </div>
          <div className="sechead" style={{ marginBottom: 6 }}>Version history</div>
          {!(versions.data ?? []).length ? <div className="empty-note">Not published yet.</div> : (
            <table className="minitbl" style={{ width: '100%' }} data-testid="ib-versions">
              <thead><tr><th>Version</th><th>Published</th><th style={{ textAlign: 'right' }}>Invoices</th><th /></tr></thead>
              <tbody>{(versions.data ?? []).map((v: any) => (
                <tr key={v.id}>
                  <td><b>v{v.version_no}</b>{Number(tpl?.published_version_no) === Number(v.version_no) ? <> <span className="bdg b-green">Live</span></> : null}
                    {v.note ? <div className="sub" style={{ fontSize: 11 }}>{v.note}</div> : null}</td>
                  <td className="sub">{fmtDateTimeIST(v.published_at)}{v.published_by_name ? ` · ${v.published_by_name}` : ''}</td>
                  <td style={{ textAlign: 'right' }}>{Number(v.invoices)}</td>
                  <td><button className="btn sm" type="button" disabled={ro} onClick={() => void restore(v)}>Restore</button></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </>
      );
      default: return null;
    }
  })();

  return (
    <div data-testid="invoice-builder" style={{ display: 'grid', gridTemplateColumns: '230px minmax(0,1fr) 380px', gap: 12, alignItems: 'start' }}>
      {/* LEFT — templates + steps */}
      <div className="card" style={{ padding: 12, position: 'sticky', top: 8 }}>
        <div className="sechead" style={{ marginBottom: 6 }}>Templates</div>
        {!templates.length && !list.loading && <div className="empty-note" style={{ marginBottom: 8 }}>No invoice template yet. Invoices use the built-in layout until one is published.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }} data-testid="ib-templates">
          {templates.map((t) => (
            <button key={t.id} type="button" className={`btn sm${Number(t.id) === selId ? ' primary' : ''}`} style={{ justifyContent: 'flex-start', textAlign: 'left' }}
              onClick={async () => { if (Number(t.id) !== selId && await confirmDiscard()) setSelId(Number(t.id)); }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
              {t.is_default && <span className="bdg b-green" style={{ fontSize: 10 }}>Default</span>}
            </button>
          ))}
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button className="btn sm" type="button" onClick={() => void create()} data-testid="ib-new"><Ic k="plus" />New</button>
            {tpl && <button className="btn sm" type="button" onClick={() => void create(tpl.id)} data-testid="ib-duplicate"><Ic k="copy" />Duplicate</button>}
          </div>
        )}
        {cfg && STEPS.map((s) => (
          <button key={s.id} type="button" onClick={() => setStep(s.id)} data-testid={`ib-step-${s.id}`} title={s.hint}
            style={{ display: 'flex', gap: 8, width: '100%', textAlign: 'left', padding: '7px 8px', border: 'none', borderRadius: 6, cursor: 'pointer',
              background: step === s.id ? 'var(--primary-soft, #eef2ff)' : 'transparent', color: step === s.id ? 'var(--primary, #4f46e5)' : 'var(--text)', fontWeight: step === s.id ? 600 : 500, fontSize: 13 }}>
            <span className="mono" style={{ opacity: 0.6 }}>{s.n}</span>{s.label}
          </button>
        ))}
      </div>

      {/* CENTRE — the live A4 invoice */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="card-head" style={{ gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ flex: 1, minWidth: 0 }}><Ic k="doc" />
            {tpl ? <input className="ainp" style={{ maxWidth: 260, fontWeight: 600 }} value={name} disabled={ro} onChange={(e) => { setName(e.target.value); setDirty(true); }} aria-label="Template name" data-testid="ib-name" /> : 'Fee Invoice Builder'}
            {tpl && <span className={`bdg ${(STATUS_BADGE[tpl.status] ?? ['', 'b-gray'])[1]}`} style={{ marginLeft: 8 }}>{(STATUS_BADGE[tpl.status] ?? [tpl.status])[0]}{tpl.published_version_no ? ` · v${tpl.published_version_no}` : ''}</span>}
            {tpl?.is_default && <span className="bdg b-indigo" style={{ marginLeft: 4 }}>Default{tpl.branch_name ? ` · ${tpl.branch_name}` : ' · all branches'}</span>}
            {dirty && <span className="bdg b-amber" style={{ marginLeft: 4 }}>Unsaved changes</span>}
          </h3>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <select className="ainp" style={{ width: 210 }} value={previewWith} onChange={(e) => setPreviewWith(e.target.value)} aria-label="Preview with" data-testid="ib-previewwith">
              <option value="sample:intra">Sample data · intra-state</option>
              <option value="sample:inter">Sample data · inter-state</option>
              {(invoices.data ?? []).slice(0, 50).map((i: any) => <option key={i.id} value={`invoice:${i.id}`}>{i.invoice_no || 'Draft'} · {i.buyer_name}</option>)}
            </select>
            {pdfUrl && <a className="btn sm" href={pdfUrl} target="_blank" rel="noreferrer"><Ic k="eye" />PDF</a>}
            {canEdit && tpl && <button className="btn sm primary" type="button" disabled={busy || !dirty} onClick={() => void save()} data-testid="ib-save"><Ic k="check" />Save draft</button>}
          </span>
        </div>
        <div style={{ background: '#525659', padding: 0, position: 'relative', height: 'calc(100vh - 210px)', minHeight: 520 }}>
          {rendering && <span className="bdg b-gray" style={{ position: 'absolute', top: 8, right: 12, zIndex: 2 }}>Updating…</span>}
          {pdfUrl ? <iframe title="Invoice preview" src={`${pdfUrl}#toolbar=0&navpanes=0&view=FitH`} style={{ width: '100%', height: '100%', border: 'none' }} data-testid="ib-preview" />
            : <div className="empty-note" style={{ color: '#fff', paddingTop: 80 }}>{templates.length ? 'Rendering…' : 'Create a template to start designing.'}</div>}
        </div>
      </div>

      {/* RIGHT — properties of the chosen step */}
      <div className="card" style={{ padding: 14, maxHeight: 'calc(100vh - 140px)', overflowY: 'auto' }} data-testid="ib-panel">
        {cfg ? <>
          <div className="sechead" style={{ marginBottom: 2 }}>{STEPS.find((s) => s.id === step)?.n} · {STEPS.find((s) => s.id === step)?.label}</div>
          <div className="sub" style={{ marginBottom: 12 }}>{STEPS.find((s) => s.id === step)?.hint}</div>
          {ro && <div className="notice" style={{ marginBottom: 10 }}><Ic k="lock" /><div>Read-only — designing invoices needs Settings permission.</div></div>}
          {panel}
        </> : (
          canEdit ? (
            <div>
              <div className="sub" style={{ marginBottom: 10 }}>Start a fee invoice design from a layout.</div>
              <button className="btn primary" type="button" onClick={() => void create()} data-testid="ib-start"><Ic k="plus" />New invoice template</button>
            </div>
          ) : <div className="empty-note">No template to show.</div>
        )}
      </div>
    </div>
  );
}
