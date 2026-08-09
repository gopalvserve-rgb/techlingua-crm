/**
 * OPERATIONS — ERP Batch 5 UI (Catalog · Inventory · Assets · Vendors · Procurement).
 *
 * Every listing carries the FULL list treatment: multi-select FilterMulti filters, Export
 * (values-not-ids), column chooser (TableCard fill+title), Refresh, and bulk-delete. India-first:
 * ₹ currency (fmtINR), GST %, HSN/SAC, vendor GSTIN, DD-MMM-YYYY dates.
 *
 *  · CatalogScreen     — org-wide item/product/service master (₹ price, GST%, HSN, active).
 *  · InventoryScreen   — per-branch stock + a receipt/issue/adjustment "Stock movement" + a
 *                        movement log; low-stock flag; per-row threshold.
 *  · AssetsScreen      — equipment/furniture/IT register + lifecycle (in-use/in-repair/retired).
 *  · VendorsScreen     — vendor master (GSTIN, contact, address, bank).
 *  · ProcurementScreen — purchase orders (GST line items) → send → receive (increments inventory)
 *                        → close, with a branded PO PDF.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_, selectableUsers } from './refdata';
import { rowActions, ConfirmModal, DetailModal, Section, KV } from './rowactions';
import { DateRange } from './daterange';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { fmtINR, parseRupees, minorToInput, computeTotals, LineDraft } from './money';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';

const fmtDate = (v?: string | null) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const uniq = (xs: any[]) => Array.from(new Set(xs.filter(Boolean)));
const asOpts = (vals: string[]) => vals.map((v) => ({ id: v, name: v }));

/* ============================================================ CATALOG === */
export function CatalogScreen() {
  const { can } = useAuth();
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [fCat, setFCat] = useState<number[]>([]);
  const [fType, setFType] = useState<number[]>([]);
  const [fActive, setFActive] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (fActive) qs.set('active', fActive);
  const list = useFetch<any[]>(`/catalog?${qs.toString()}`, [qs.toString(), tick]);
  const allRows = list.data ?? [];
  const cats = uniq(allRows.map((r) => r.category)) as string[];
  const rows = allRows.filter((r) =>
    (!fCat.length || fCat.map(String).includes(String(r.category))) &&
    (!fType.length || fType.map(String).includes(String(r.item_type))));
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Catalog item', '/catalog/bulk-delete/impact', '/catalog/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/catalog/${del.id}`); toast('Item deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('catalog.create') && <div className="page-actions"><button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />New item</button></div>}
      <div className="filters">
        <label className="fchip"><Ic k="search" /><input placeholder="Search item / code / HSN" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
        <FilterMulti label="Category" icon="grid" value={fCat as any} options={asOpts(cats) as any} onChange={setFCat as any} />
        <FilterMulti label="Type" icon="doc" value={fType as any} options={asOpts(['product', 'service']) as any} onChange={setFType as any} />
        <label className="fchip"><Ic k="shield" /><select value={fActive} onChange={(e) => setFActive(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }}><option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      </div>
      <BulkBar count={count} entityLabel="Catalog item" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Catalog" icon="grid"
        select={can('catalog.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('catalog.csv', rows.map((r: any) => ({
          item_code: r.item_code, name: r.name, category: r.category, type: r.item_type, unit: r.unit,
          price: (Number(r.price_minor) / 100).toFixed(2), gst_pct: r.tax_pct, hsn: r.hsn_code, active: r.is_active ? 'Yes' : 'No',
        })))} onRefresh={after} />}
        cols={['Item', 'Category', 'Type', 'Unit', 'Price (₹)', 'GST %', 'HSN/SAC', 'Active', 'Actions']}
        empty="No catalog items yet — add books, kits, merchandise or service items."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.name}</b><div className="sub mono">{r.item_code}</div></div> } as Cell,
          r.category ?? '—',
          { b: [r.item_type === 'service' ? 'Service' : 'Product', r.item_type === 'service' ? 'b-blue' : 'b-gray'] } as Cell,
          r.unit ?? '—',
          fmtINR(r.price_minor),
          `${Number(r.tax_pct)}%`,
          r.hsn_code ?? '—',
          { b: [r.is_active ? 'Active' : 'Inactive', r.is_active ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({ onEdit: can('catalog.update') ? () => setEdit(r) : undefined, onDelete: can('catalog.delete') ? () => setDel(r) : undefined }),
        ])} />
      {edit && <CatalogForm item={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); after(); }} />}
      {del && <ConfirmModal title="Delete item?" body={`Delete "${del.name}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function CatalogForm({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !item?.id;
  const [f, setF] = useState<any>({
    item_code: item.item_code ?? '', name: item.name ?? '', category: item.category ?? '',
    item_type: item.item_type ?? 'product', unit: item.unit ?? 'pcs',
    price: item.price_minor != null ? minorToInput(item.price_minor) : '', tax_pct: item.tax_pct ?? '0',
    hsn_code: item.hsn_code ?? '', description: item.description ?? '', is_active: item.is_active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, tax_pct: Number(f.tax_pct || 0) };
      if (isNew) await api.post('/catalog', body); else await api.patch(`/catalog/${item.id}`, body);
      toast(isNew ? 'Item created' : 'Item updated'); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={isNew ? 'New catalog item' : `Edit — ${item.name}`} icon="grid" width={620} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button></div>}>
      <div className="form-grid">
        <div className="fld"><label>Item code {isNew ? '(auto if blank)' : ''}</label><input className="ainp" value={f.item_code} onChange={(e) => set('item_code', e.target.value)} placeholder="ITM-…" /></div>
        <div className="fld"><label>Name *</label><input className="ainp" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="fld"><label>Category</label><input className="ainp" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Books / Kits / Merchandise / Service" /></div>
        <div className="fld"><label>Type</label><select className="ainp" value={f.item_type} onChange={(e) => set('item_type', e.target.value)}><option value="product">Product</option><option value="service">Service</option></select></div>
        <div className="fld"><label>Unit</label><input className="ainp" value={f.unit} onChange={(e) => set('unit', e.target.value)} placeholder="pcs / kg / hour" /></div>
        <div className="fld"><label>Price (₹)</label><input className="ainp" value={f.price} onChange={(e) => set('price', e.target.value)} placeholder="0.00" /></div>
        <div className="fld"><label>GST %</label><input className="ainp" value={f.tax_pct} onChange={(e) => set('tax_pct', e.target.value)} placeholder="0 / 5 / 12 / 18 / 28" /></div>
        <div className="fld"><label>HSN / SAC</label><input className="ainp" value={f.hsn_code} onChange={(e) => set('hsn_code', e.target.value)} /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Description</label><input className="ainp" value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
        <label className="fld" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active</label>
      </div>
    </DetailModal>
  );
}

/* ============================================================ VENDORS === */
export function VendorsScreen() {
  const { can } = useAuth();
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [fCat, setFCat] = useState<number[]>([]);
  const [fActive, setFActive] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (fActive) qs.set('active', fActive);
  const list = useFetch<any[]>(`/vendors?${qs.toString()}`, [qs.toString(), tick]);
  const allRows = list.data ?? [];
  const cats = uniq(allRows.map((r) => r.category)) as string[];
  const rows = allRows.filter((r) => (!fCat.length || fCat.map(String).includes(String(r.category))));
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Vendor', '/vendors/bulk-delete/impact', '/vendors/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/vendors/${del.id}`); toast('Vendor deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('vendor.create') && <div className="page-actions"><button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />New vendor</button></div>}
      <div className="filters">
        <label className="fchip"><Ic k="search" /><input placeholder="Search name / GSTIN / phone" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
        <FilterMulti label="Category" icon="grid" value={fCat as any} options={asOpts(cats) as any} onChange={setFCat as any} />
        <label className="fchip"><Ic k="shield" /><select value={fActive} onChange={(e) => setFActive(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }}><option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      </div>
      <BulkBar count={count} entityLabel="Vendor" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Vendors" icon="users"
        select={can('vendor.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('vendors.csv', rows.map((r: any) => ({
          name: r.name, gstin: r.gstin, category: r.category, contact: r.contact_person, phone: r.phone, email: r.email, city: r.city, state: r.state, active: r.is_active ? 'Yes' : 'No',
        })))} onRefresh={after} />}
        cols={['Vendor', 'GSTIN', 'Category', 'Contact', 'City', 'Active', 'Actions']}
        empty="No vendors yet — add your suppliers with GSTIN and contact details."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.name}</b><div className="sub mono">{r.phone ?? '—'}</div></div> } as Cell,
          { mono: r.gstin ?? '—' } as Cell,
          r.category ?? '—',
          r.contact_person ?? '—',
          r.city ?? '—',
          { b: [r.is_active ? 'Active' : 'Inactive', r.is_active ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({ onView: () => setView(r), onEdit: can('vendor.update') ? () => setEdit(r) : undefined, onDelete: can('vendor.delete') ? () => setDel(r) : undefined }),
        ])} />
      {edit && <VendorForm vendor={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); after(); }} />}
      {view && <VendorDetail id={view.id} onClose={() => setView(null)} />}
      {del && <ConfirmModal title="Delete vendor?" body={`Delete "${del.name}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function VendorDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const d = useFetch<any>(`/vendors/${id}`, [id]);
  const v = d.data;
  const dash = (x: any) => (x == null || x === '' ? '—' : x);
  if (!v) return <DetailModal title="Vendor" icon="users" onClose={onClose}><div className="empty-note">Loading…</div></DetailModal>;
  return (
    <DetailModal title={`Vendor — ${v.name}`} icon="users" width={640} onClose={onClose}>
      <Section title="Details"><KV rows={[['GSTIN', <span className="mono">{dash(v.gstin)}</span>], ['Category', dash(v.category)], ['Contact person', dash(v.contact_person)], ['Phone', <span className="mono">{dash(v.phone)}</span>], ['Email', dash(v.email)], ['Status', v.is_active ? 'Active' : 'Inactive']]} /></Section>
      <Section title="Address"><KV rows={[['Address', dash(v.address)], ['City', dash(v.city)], ['State', dash(v.state)], ['Pincode', dash(v.pincode)]]} /></Section>
      <Section title="Bank (optional)"><KV rows={[['Bank', dash(v.bank_name)], ['Account', <span className="mono">{dash(v.bank_account)}</span>], ['IFSC', <span className="mono">{dash(v.bank_ifsc)}</span>]]} /></Section>
      {v.notes ? <Section title="Notes"><div style={{ fontSize: 13 }}>{v.notes}</div></Section> : null}
    </DetailModal>
  );
}

function VendorForm({ vendor, onClose, onSaved }: { vendor: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !vendor?.id;
  const [f, setF] = useState<any>({
    name: vendor.name ?? '', gstin: vendor.gstin ?? '', category: vendor.category ?? '', contact_person: vendor.contact_person ?? '',
    phone: vendor.phone ?? '', email: vendor.email ?? '', address: vendor.address ?? '', city: vendor.city ?? '', state: vendor.state ?? '',
    pincode: vendor.pincode ?? '', bank_name: vendor.bank_name ?? '', bank_account: vendor.bank_account ?? '', bank_ifsc: vendor.bank_ifsc ?? '',
    notes: vendor.notes ?? '', is_active: vendor.is_active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true);
    try { if (isNew) await api.post('/vendors', f); else await api.patch(`/vendors/${vendor.id}`, f); toast(isNew ? 'Vendor created' : 'Vendor updated'); onSaved(); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const F = ([k, label, ph]: [string, string, string?]) => (
    <div className="fld" key={k}><label>{label}</label><input className="ainp" value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={ph} /></div>
  );
  return (
    <DetailModal title={isNew ? 'New vendor' : `Edit — ${vendor.name}`} icon="users" width={680} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button></div>}>
      <Section title="Vendor"><div className="form-grid">
        {F(['name', 'Name *'])}{F(['gstin', 'GSTIN', '27AAPFU0939F1ZV'])}{F(['category', 'Category'])}{F(['contact_person', 'Contact person'])}{F(['phone', 'Phone'])}{F(['email', 'Email'])}
      </div></Section>
      <Section title="Address"><div className="form-grid">
        {F(['address', 'Address'])}{F(['city', 'City'])}{F(['state', 'State'])}{F(['pincode', 'Pincode (6 digits)'])}
      </div></Section>
      <Section title="Bank (optional)"><div className="form-grid">
        {F(['bank_name', 'Bank name'])}{F(['bank_account', 'Account number'])}{F(['bank_ifsc', 'IFSC'])}
        <label className="fld" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active</label>
      </div></Section>
    </DetailModal>
  );
}

/* ========================================================== INVENTORY === */
export function InventoryScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [fB, setFB] = useState<number[]>(gScope.branch ? [gScope.branch] : []);
  const [low, setLow] = useState(false);
  const [q, setQ] = useState('');
  const [moveItem, setMoveItem] = useState<any | null>(null);
  const [movements, setMovements] = useState(false);
  const [thresh, setThresh] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (low) qs.set('low', '1');
  if (q) qs.set('q', q);
  const list = useFetch<any[]>(`/inventory?${qs.toString()}`, [qs.toString(), tick]);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Stock record', '/inventory/bulk-delete/impact', '/inventory/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/inventory/${del.id}`); toast('Stock record deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      <div className="page-actions" style={{ display: 'flex', gap: 8 }}>
        {can('inventory.manage') && <button className="btn primary" onClick={() => setMoveItem({})}><Ic k="refresh" />Stock movement</button>}
        <button className="btn" onClick={() => setMovements(true)}><Ic k="list" />Movement log</button>
      </div>
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <label className="fchip"><Ic k="search" /><input placeholder="Search item / code" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
        <label className="fchip" style={{ cursor: 'pointer' }}><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Low stock only</label>
      </div>
      <BulkBar count={count} entityLabel="Stock record" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Inventory" icon="grid"
        select={can('inventory.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('inventory.csv', rows.map((r: any) => ({
          item_code: r.item_code, item: r.item_name, branch: r.branch_name, location: r.location,
          on_hand: r.qty_on_hand, unit: r.unit, low_threshold: r.low_stock_threshold, low_stock: r.low_stock ? 'Yes' : 'No',
        })))} onRefresh={after} />}
        cols={['Item', 'Branch', 'Location', 'On hand', 'Threshold', 'Status', 'Actions']}
        empty="No stock yet — receive a purchase order or record a stock movement."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.item_name}</b><div className="sub mono">{r.item_code}</div></div> } as Cell,
          r.branch_name ?? '—',
          r.location ?? 'Main',
          { node: <span><b>{Number(r.qty_on_hand)}</b> <span className="sub">{r.unit ?? ''}</span></span> } as Cell,
          Number(r.low_stock_threshold) || '—',
          r.low_stock ? ({ b: ['Low stock', 'b-rose'] } as Cell) : ({ b: ['OK', 'b-green'] } as Cell),
          rowActions({
            extra: can('inventory.manage') ? [
              { k: 'refresh', title: 'Move stock', onClick: () => setMoveItem(r) },
              { k: 'shield', title: 'Set threshold', onClick: () => setThresh(r) },
            ] : [],
            onDelete: can('inventory.delete') ? () => setDel(r) : undefined,
          }),
        ])} />
      {moveItem && <StockMovementForm preset={moveItem} branches={rd.branches} onClose={() => setMoveItem(null)} onSaved={() => { setMoveItem(null); after(); }} />}
      {movements && <MovementsModal branches={rd.branches} onClose={() => setMovements(false)} />}
      {thresh && <ThresholdForm row={thresh} onClose={() => setThresh(null)} onSaved={() => { setThresh(null); after(); }} />}
      {del && <ConfirmModal title="Delete stock record?" body={`Remove "${del.item_name}" stock at ${del.branch_name}? The movement history is kept.`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function StockMovementForm({ preset, branches, onClose, onSaved }: { preset: any; branches: any[]; onClose: () => void; onSaved: () => void }) {
  const items = useFetch<any[]>('/catalog?active=active', []);
  const [f, setF] = useState<any>({
    item_id: preset.item_id ?? '', branch_id: preset.branch_id ?? '', location: preset.location ?? 'Main',
    movement_type: 'receipt', qty: '', reason: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/inventory/adjust', { ...f, item_id: Number(f.item_id), branch_id: Number(f.branch_id), qty: Number(f.qty) });
      toast('Stock updated'); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title="Stock movement" icon="refresh" width={560} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Apply</button></div>}>
      <div className="form-grid">
        <div className="fld"><label>Item *</label><select className="ainp" value={f.item_id} onChange={(e) => set('item_id', e.target.value)}><option value="">Select item</option>{(items.data ?? []).map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.item_code})</option>)}</select></div>
        <div className="fld"><label>Branch *</label><select className="ainp" value={f.branch_id} onChange={(e) => set('branch_id', e.target.value)}><option value="">Select branch</option>{branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="fld"><label>Location</label><input className="ainp" value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Main" /></div>
        <div className="fld"><label>Movement</label><select className="ainp" value={f.movement_type} onChange={(e) => set('movement_type', e.target.value)}><option value="receipt">Receipt (+ in)</option><option value="issue">Issue (− out)</option><option value="adjustment">Adjustment</option></select></div>
        <div className="fld"><label>Quantity *</label><input className="ainp" value={f.qty} onChange={(e) => set('qty', e.target.value)} placeholder="0" /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Reason / note</label><input className="ainp" value={f.reason} onChange={(e) => set('reason', e.target.value)} /></div>
      </div>
    </DetailModal>
  );
}

function ThresholdForm({ row, onClose, onSaved }: { row: any; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(String(row.low_stock_threshold ?? 0));
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await api.patch(`/inventory/${row.id}/threshold`, { low_stock_threshold: Number(v) }); toast('Threshold updated'); onSaved(); } catch (e: any) { toast(e.message, true); } finally { setBusy(false); } };
  return (
    <DetailModal title={`Low-stock threshold — ${row.item_name}`} icon="shield" width={420} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button></div>}>
      <div className="fld"><label>Flag as low stock when on-hand ≤</label><input className="ainp" value={v} onChange={(e) => setV(e.target.value)} placeholder="0 (off)" /></div>
    </DetailModal>
  );
}

function MovementsModal({ branches, onClose }: { branches: any[]; onClose: () => void }) {
  const [fB, setFB] = useState<number[]>([]);
  const [fType, setFType] = useState<number[]>([]);
  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fType.length) qs.set('type', fType.map(String).join(','));
  const list = useFetch<any[]>(`/inventory/movements?${qs.toString()}`, [qs.toString()]);
  const rows = list.data ?? [];
  return (
    <DetailModal title="Stock movement log" icon="list" width={860} onClose={onClose}>
      <div className="filters" style={{ marginBottom: 8 }}>
        <FilterMulti label="Branch" icon="branch" value={fB} options={branches} onChange={setFB} />
        <FilterMulti label="Type" icon="doc" value={fType as any} options={asOpts(['receipt', 'issue', 'adjustment']) as any} onChange={setFType as any} />
        <ListActions onExport={() => downloadObjectsCsv('stock-movements.csv', rows.map((r: any) => ({ date: r.created_at, item: r.item_name, branch: r.branch_name, type: r.movement_type, qty_delta: r.qty_delta, qty_after: r.qty_after, reason: r.reason, by: r.created_by_name })))} />
      </div>
      <TableCard title="Movements" icon="list"
        cols={['Date', 'Item', 'Branch', 'Type', 'Δ Qty', 'On hand', 'Reason', 'By']}
        empty="No movements yet."
        rows={rows.map((m: any) => [
          fmtDate(m.created_at), m.item_name, m.branch_name ?? '—',
          { b: [m.movement_type, m.movement_type === 'receipt' ? 'b-green' : m.movement_type === 'issue' ? 'b-rose' : 'b-amber'] } as Cell,
          { node: <b style={{ color: Number(m.qty_delta) >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{Number(m.qty_delta) >= 0 ? '+' : ''}{Number(m.qty_delta)}</b> } as Cell,
          Number(m.qty_after), m.reason ?? '—', m.created_by_name ?? '—',
        ])} />
    </DetailModal>
  );
}

/* ============================================================= ASSETS === */
const ASSET_STATUS: Record<string, [string, string]> = {
  in_use: ['In use', 'b-green'], in_repair: ['In repair', 'b-amber'], retired: ['Retired', 'b-gray'],
};
export function AssetsScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [fB, setFB] = useState<number[]>(gScope.branch ? [gScope.branch] : []);
  const [fStatus, setFStatus] = useState<number[]>([]);
  const [fCat, setFCat] = useState<number[]>([]);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fStatus.length) qs.set('status', fStatus.map(String).join(','));
  if (q) qs.set('q', q);
  const list = useFetch<any[]>(`/assets?${qs.toString()}`, [qs.toString(), tick]);
  const allRows = list.data ?? [];
  const cats = uniq(allRows.map((r) => r.category)) as string[];
  const rows = allRows.filter((r) => (!fCat.length || fCat.map(String).includes(String(r.category))));
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Asset', '/assets/bulk-delete/impact', '/assets/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/assets/${del.id}`); toast('Asset deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('asset.create') && <div className="page-actions"><button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />New asset</button></div>}
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Status" icon="shield" value={fStatus as any} options={asOpts(['in_use', 'in_repair', 'retired']) as any} onChange={setFStatus as any} />
        <FilterMulti label="Category" icon="grid" value={fCat as any} options={asOpts(cats) as any} onChange={setFCat as any} />
        <label className="fchip"><Ic k="search" /><input placeholder="Search name / code / serial" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
      </div>
      <BulkBar count={count} entityLabel="Asset" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Assets" icon="grid"
        select={can('asset.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('assets.csv', rows.map((r: any) => ({
          asset_code: r.asset_code, name: r.name, category: r.category, branch: r.branch_name, location: r.location,
          status: r.status, assigned_to: r.assigned_to_name, cost: (Number(r.cost_minor) / 100).toFixed(2),
          purchase_date: r.purchase_date, warranty_until: r.warranty_until, vendor: r.vendor_name,
        })))} onRefresh={after} />}
        cols={['Asset', 'Category', 'Branch', 'Status', 'Assigned to', 'Cost (₹)', 'Warranty', 'Actions']}
        empty="No assets yet — register equipment, furniture or IT."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.name}</b><div className="sub mono">{r.asset_code}</div></div> } as Cell,
          r.category ?? '—',
          r.branch_name ?? '—',
          { b: ASSET_STATUS[r.status] ?? [r.status, 'b-gray'] } as Cell,
          r.assigned_to_name ?? '—',
          fmtINR(r.cost_minor),
          fmtDate(r.warranty_until),
          rowActions({ onView: () => setView(r), onEdit: can('asset.update') ? () => setEdit(r) : undefined, onDelete: can('asset.delete') ? () => setDel(r) : undefined }),
        ])} />
      {edit && <AssetForm asset={edit} rd={rd} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); after(); }} />}
      {view && <AssetDetail id={view.id} onClose={() => setView(null)} />}
      {del && <ConfirmModal title="Delete asset?" body={`Delete "${del.name}" (${del.asset_code})?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function AssetDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const d = useFetch<any>(`/assets/${id}`, [id]);
  const a = d.data;
  const dash = (x: any) => (x == null || x === '' ? '—' : x);
  if (!a) return <DetailModal title="Asset" icon="grid" onClose={onClose}><div className="empty-note">Loading…</div></DetailModal>;
  return (
    <DetailModal title={`Asset — ${a.name}`} icon="grid" width={640} onClose={onClose}>
      <Section title="Overview"><KV rows={[
        ['Code', <span className="mono">{dash(a.asset_code)}</span>], ['Category', dash(a.category)],
        ['Status', (ASSET_STATUS[a.status]?.[0]) ?? a.status], ['Assigned to', dash(a.assigned_to_name)],
        ['Placement', `${dash(a.branch_name)}${a.vertical_name ? ' › ' + a.vertical_name : ''}${a.location ? ' · ' + a.location : ''}`],
        ['Serial no.', <span className="mono">{dash(a.serial_no)}</span>],
      ]} /></Section>
      <Section title="Purchase & warranty"><KV rows={[
        ['Purchase date', fmtDate(a.purchase_date)], ['Cost', fmtINR(a.cost_minor)], ['Vendor', dash(a.vendor_name)],
        ['Warranty until', fmtDate(a.warranty_until)], ['AMC until', fmtDate(a.amc_until)],
      ]} /></Section>
      {a.notes ? <Section title="Notes"><div style={{ fontSize: 13 }}>{a.notes}</div></Section> : null}
    </DetailModal>
  );
}

function AssetForm({ asset, rd, onClose, onSaved }: { asset: any; rd: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !asset?.id;
  const [f, setF] = useState<any>({
    asset_code: asset.asset_code ?? '', name: asset.name ?? '', category: asset.category ?? '',
    branch_id: asset.branch_id ?? '', vertical_id: asset.vertical_id ?? '', location: asset.location ?? '',
    serial_no: asset.serial_no ?? '', purchase_date: asset.purchase_date ?? '', cost: asset.cost_minor != null ? minorToInput(asset.cost_minor) : '',
    vendor_id: asset.vendor_id ?? '', status: asset.status ?? 'in_use', assigned_to: asset.assigned_to ?? '',
    warranty_until: asset.warranty_until ?? '', amc_until: asset.amc_until ?? '', notes: asset.notes ?? '',
  });
  const vendors = useFetch<any[]>('/vendors?active=active', []);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const vOpts = rd.verticals.filter((v: any) => !f.branch_id || Number(v.branch_id) === Number(f.branch_id));
  const users = selectableUsers(rd.users, asset.assigned_to);
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, branch_id: f.branch_id ? Number(f.branch_id) : undefined, vertical_id: f.vertical_id ? Number(f.vertical_id) : null,
        vendor_id: f.vendor_id ? Number(f.vendor_id) : null, assigned_to: f.assigned_to ? Number(f.assigned_to) : null };
      if (isNew) await api.post('/assets', body); else await api.patch(`/assets/${asset.id}`, body);
      toast(isNew ? 'Asset created' : 'Asset updated'); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={isNew ? 'New asset' : `Edit — ${asset.name}`} icon="grid" width={700} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button></div>}>
      <Section title="Identity"><div className="form-grid">
        <div className="fld"><label>Asset code {isNew ? '(auto if blank)' : ''}</label><input className="ainp" value={f.asset_code} onChange={(e) => set('asset_code', e.target.value)} placeholder="AST-…" /></div>
        <div className="fld"><label>Name *</label><input className="ainp" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="fld"><label>Category</label><input className="ainp" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="IT / Furniture / Equipment" /></div>
        <div className="fld"><label>Serial no.</label><input className="ainp" value={f.serial_no} onChange={(e) => set('serial_no', e.target.value)} /></div>
      </div></Section>
      <Section title="Placement & status"><div className="form-grid">
        <div className="fld"><label>Branch *</label><select className="ainp" value={f.branch_id} onChange={(e) => { set('branch_id', e.target.value); set('vertical_id', ''); }}><option value="">Select</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="fld"><label>Vertical</label><select className="ainp" value={f.vertical_id} onChange={(e) => set('vertical_id', e.target.value)} disabled={!f.branch_id}><option value="">—</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div className="fld"><label>Location</label><input className="ainp" value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Room / floor" /></div>
        <div className="fld"><label>Status</label><select className="ainp" value={f.status} onChange={(e) => set('status', e.target.value)}><option value="in_use">In use</option><option value="in_repair">In repair</option><option value="retired">Retired</option></select></div>
        <div className="fld"><label>Assigned to</label><select className="ainp" value={f.assigned_to} onChange={(e) => set('assigned_to', e.target.value)}><option value="">—</option>{users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      </div></Section>
      <Section title="Purchase & warranty"><div className="form-grid">
        <div className="fld"><label>Purchase date</label><input className="ainp" type="date" value={f.purchase_date ?? ''} onChange={(e) => set('purchase_date', e.target.value)} /></div>
        <div className="fld"><label>Cost (₹)</label><input className="ainp" value={f.cost} onChange={(e) => set('cost', e.target.value)} placeholder="0.00" /></div>
        <div className="fld"><label>Vendor</label><select className="ainp" value={f.vendor_id} onChange={(e) => set('vendor_id', e.target.value)}><option value="">—</option>{(vendors.data ?? []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div className="fld"><label>Warranty until</label><input className="ainp" type="date" value={f.warranty_until ?? ''} onChange={(e) => set('warranty_until', e.target.value)} /></div>
        <div className="fld"><label>AMC until</label><input className="ainp" type="date" value={f.amc_until ?? ''} onChange={(e) => set('amc_until', e.target.value)} /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Notes</label><input className="ainp" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      </div></Section>
    </DetailModal>
  );
}

/* ======================================================== PROCUREMENT === */
const PO_STATUS: Record<string, [string, string]> = {
  draft: ['Draft', 'b-gray'], sent: ['Sent', 'b-blue'], received: ['Received', 'b-green'],
  closed: ['Closed', 'b-gray'], cancelled: ['Cancelled', 'b-rose'],
};
export function ProcurementScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [fB, setFB] = useState<number[]>(gScope.branch ? [gScope.branch] : []);
  const [fStatus, setFStatus] = useState<number[]>([]);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [q, setQ] = useState('');
  const [create, setCreate] = useState(false);
  const [view, setView] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fStatus.length) qs.set('status', fStatus.map(String).join(','));
  if (q) qs.set('q', q);
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const list = useFetch<any[]>(`/purchase-orders?${qs.toString()}`, [qs.toString(), tick]);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Purchase order', '/purchase-orders/bulk-delete/impact', '/purchase-orders/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/purchase-orders/${del.id}`); toast('PO deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('procurement.create') && <div className="page-actions"><button className="btn primary" onClick={() => setCreate(true)}><Ic k="plus" />New purchase order</button></div>}
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Status" icon="shield" value={fStatus as any} options={asOpts(['draft', 'sent', 'received', 'closed', 'cancelled']) as any} onChange={setFStatus as any} />
        <label className="fchip"><Ic k="search" /><input placeholder="Search PO / vendor" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
        <DateRange value={range} onChange={setRange} idPrefix="po-dr" style={{ marginLeft: 'auto' }} />
      </div>
      <BulkBar count={count} entityLabel="Purchase order" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Purchase Orders" icon="doc"
        select={can('procurement.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('purchase-orders.csv', rows.map((r: any) => ({
          po_no: r.po_no, vendor: r.vendor_name, branch: r.branch_name, status: r.status,
          order_date: r.order_date, subtotal: (Number(r.subtotal_minor) / 100).toFixed(2),
          gst: (Number(r.tax_minor) / 100).toFixed(2), total: (Number(r.total_minor) / 100).toFixed(2),
        })))} onRefresh={after} />}
        cols={['PO', 'Vendor', 'Branch', 'Order date', 'GST (₹)', 'Total (₹)', 'Status', 'Actions']}
        empty="No purchase orders yet — raise one to a vendor for catalog items."
        rows={rows.map((r: any) => [
          { node: <b className="nm mono">{r.po_no}</b> } as Cell,
          r.vendor_name ?? '—',
          r.branch_name ?? '—',
          fmtDate(r.order_date),
          fmtINR(r.tax_minor),
          fmtINR(r.total_minor),
          { b: PO_STATUS[r.status] ?? [r.status, 'b-gray'] } as Cell,
          rowActions({
            extra: [{ k: 'eye', title: 'Open', onClick: () => setView(r) }, { k: 'doc', title: 'PDF', onClick: () => window.open(`/api/purchase-orders/${r.id}/pdf`, '_blank', 'noopener') }],
            onDelete: can('procurement.delete') ? () => setDel(r) : undefined,
          }),
        ])} />
      {create && <POForm rd={rd} onClose={() => setCreate(false)} onSaved={() => { setCreate(false); after(); }} />}
      {view && <PODetail id={view.id} onClose={() => setView(null)} onChanged={after} />}
      {del && <ConfirmModal title="Delete purchase order?" body={`Delete ${del.po_no}?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

const EMPTY_LINE = () => ({ item_id: '', description: '', hsn_code: '', qty: '1', unit_price: '', discount_type: 'amount' as const, discount_value: '', tax_pct: '0' });
function POForm({ rd, onClose, onSaved }: { rd: any; onClose: () => void; onSaved: () => void }) {
  const vendors = useFetch<any[]>('/vendors?active=active', []);
  const items = useFetch<any[]>('/catalog?active=active', []);
  const [f, setF] = useState<any>({ vendor_id: '', branch_id: '', vertical_id: '', location: 'Main', order_date: '', expected_date: '', notes: '', terms: '' });
  const [lines, setLines] = useState<any[]>([EMPTY_LINE()]);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const vOpts = rd.verticals.filter((v: any) => !f.branch_id || Number(v.branch_id) === Number(f.branch_id));
  const setLine = (i: number, k: string, v: any) => setLines((ls) => ls.map((l, ix) => ix === i ? { ...l, [k]: v } : l));
  const pickItem = (i: number, itemId: string) => {
    const it = (items.data ?? []).find((x: any) => String(x.id) === String(itemId));
    setLines((ls) => ls.map((l, ix) => ix === i ? {
      ...l, item_id: itemId,
      description: it ? it.name : l.description, hsn_code: it ? (it.hsn_code ?? '') : l.hsn_code,
      unit_price: it ? minorToInput(it.price_minor) : l.unit_price, tax_pct: it ? String(it.tax_pct ?? 0) : l.tax_pct,
    } : l));
  };
  const totals = useMemo(() => computeTotals(lines.map((l) => ({ description: l.description, qty: l.qty, unit_price: l.unit_price, discount_type: l.discount_type, discount_value: l.discount_value, tax_pct: l.tax_pct } as LineDraft))), [lines]);

  const save = async (asSent: boolean) => {
    setBusy(true);
    try {
      const body = {
        vendor_id: Number(f.vendor_id), branch_id: Number(f.branch_id),
        vertical_id: f.vertical_id ? Number(f.vertical_id) : null, location: f.location || 'Main',
        order_date: f.order_date || undefined, expected_date: f.expected_date || undefined,
        notes: f.notes || undefined, terms: f.terms || undefined, status: asSent ? 'sent' : 'draft',
        items: lines.filter((l) => l.description || l.item_id).map((l) => ({
          item_id: l.item_id ? Number(l.item_id) : null, description: l.description, hsn_code: l.hsn_code || null,
          qty: Number(l.qty || 0), unit_price: l.unit_price, discount_type: l.discount_type, discount_value: l.discount_value || 0, tax_pct: Number(l.tax_pct || 0),
        })),
      };
      const r = await api.post<any>('/purchase-orders', body);
      toast(`Purchase order ${r.po_no} created`); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  return (
    <DetailModal title="New purchase order" icon="doc" width={900} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ marginRight: 'auto', fontSize: 13 }}>{totals.error ? <span style={{ color: 'var(--danger)' }}>{totals.error}</span> : <span>GST <b>{fmtINR(totals.tax_minor)}</b> · Total <b>{fmtINR(totals.total_minor)}</b></span>}</div>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" onClick={() => save(false)} disabled={busy || !!totals.error}>Save draft</button>
        <button className="btn primary" onClick={() => save(true)} disabled={busy || !!totals.error}><Ic k="check" />Save & send</button>
      </div>}>
      <Section title="Header"><div className="form-grid">
        <div className="fld"><label>Vendor *</label><select className="ainp" value={f.vendor_id} onChange={(e) => set('vendor_id', e.target.value)}><option value="">Select vendor</option>{(vendors.data ?? []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div className="fld"><label>Branch *</label><select className="ainp" value={f.branch_id} onChange={(e) => { set('branch_id', e.target.value); set('vertical_id', ''); }}><option value="">Select branch</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="fld"><label>Vertical</label><select className="ainp" value={f.vertical_id} onChange={(e) => set('vertical_id', e.target.value)} disabled={!f.branch_id}><option value="">—</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div className="fld"><label>Receiving location</label><input className="ainp" value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Main" /></div>
        <div className="fld"><label>Order date</label><input className="ainp" type="date" value={f.order_date} onChange={(e) => set('order_date', e.target.value)} /></div>
        <div className="fld"><label>Expected date</label><input className="ainp" type="date" value={f.expected_date} onChange={(e) => set('expected_date', e.target.value)} /></div>
      </div></Section>
      <Section title="Line items">
        <div style={{ overflowX: 'auto' }}>
          <table className="mini-tbl" style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr>
              <th style={{ textAlign: 'left' }}>Item</th><th style={{ textAlign: 'left' }}>Description</th><th>HSN</th><th>Qty</th><th>Rate ₹</th><th>Disc</th><th>GST%</th><th style={{ textAlign: 'right' }}>Amount</th><th></th>
            </tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const lt = totals.lines[i];
                return (
                  <tr key={i}>
                    <td><select className="ainp" style={{ minWidth: 130 }} value={l.item_id} onChange={(e) => pickItem(i, e.target.value)}><option value="">— free text —</option>{(items.data ?? []).map((it: any) => <option key={it.id} value={it.id}>{it.name}</option>)}</select></td>
                    <td><input className="ainp" style={{ minWidth: 140 }} value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} /></td>
                    <td><input className="ainp" style={{ width: 64 }} value={l.hsn_code} onChange={(e) => setLine(i, 'hsn_code', e.target.value)} /></td>
                    <td><input className="ainp" style={{ width: 52 }} value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} /></td>
                    <td><input className="ainp" style={{ width: 78 }} value={l.unit_price} onChange={(e) => setLine(i, 'unit_price', e.target.value)} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <input className="ainp" style={{ width: 54 }} value={l.discount_value} onChange={(e) => setLine(i, 'discount_value', e.target.value)} />
                      <select className="ainp" style={{ width: 44 }} value={l.discount_type} onChange={(e) => setLine(i, 'discount_type', e.target.value)}><option value="amount">₹</option><option value="percent">%</option></select>
                    </td>
                    <td><input className="ainp" style={{ width: 48 }} value={l.tax_pct} onChange={(e) => setLine(i, 'tax_pct', e.target.value)} /></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{lt?.error ? <span style={{ color: 'var(--danger)' }} title={lt.error}>—</span> : fmtINR(lt?.total_minor ?? 0)}</td>
                    <td><button className="btn sm danger" onClick={() => setLines((ls) => ls.length > 1 ? ls.filter((_, ix) => ix !== i) : ls)}><Ic k="trash" /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="btn sm" onClick={() => setLines((ls) => [...ls, EMPTY_LINE()])}><Ic k="plus" />Add line</button>
          <span className="sub">Subtotal {fmtINR(totals.subtotal_minor)} · Discount {fmtINR(totals.discount_minor)} · GST {fmtINR(totals.tax_minor)} · <b>Total {fmtINR(totals.total_minor)}</b></span>
        </div>
      </Section>
      <Section title="Notes & terms"><div className="form-grid">
        <div className="fld"><label>Notes</label><input className="ainp" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        <div className="fld"><label>Terms</label><input className="ainp" value={f.terms} onChange={(e) => set('terms', e.target.value)} /></div>
      </div></Section>
    </DetailModal>
  );
}

function PODetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const d = useFetch<any>(`/purchase-orders/${id}`, [id]);
  const po = d.data;
  const [busy, setBusy] = useState(false);
  const [confirmRecv, setConfirmRecv] = useState(false);
  const dash = (x: any) => (x == null || x === '' ? '—' : x);
  if (!po) return <DetailModal title="Purchase order" icon="doc" onClose={onClose}><div className="empty-note">Loading…</div></DetailModal>;

  const act = async (fn: () => Promise<any>, ok: string) => { setBusy(true); try { await fn(); toast(ok); d.reload?.(); onChanged(); } catch (e: any) { toast(e.message, true); } finally { setBusy(false); } };
  const receive = () => act(() => api.post(`/purchase-orders/${id}/receive`, {}), 'Received — inventory updated');
  const setStatus = (status: string, msg: string) => act(() => api.post(`/purchase-orders/${id}/status`, { status }), msg);

  return (
    <DetailModal title={`Purchase order — ${po.po_no}`} icon="doc" width={820} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => window.open(`/api/purchase-orders/${id}/pdf`, '_blank', 'noopener')}><Ic k="doc" />PDF</button>
        {po.status === 'draft' && can('procurement.update') && <button className="btn" onClick={() => setStatus('sent', 'PO marked sent')} disabled={busy}>Mark sent</button>}
        {(po.status === 'sent' || po.status === 'draft') && can('procurement.receive') && <button className="btn primary" onClick={() => setConfirmRecv(true)} disabled={busy}><Ic k="check" />Receive → stock</button>}
        {po.status === 'received' && can('procurement.update') && <button className="btn" onClick={() => setStatus('closed', 'PO closed')} disabled={busy}>Close</button>}
        {(po.status === 'draft' || po.status === 'sent') && can('procurement.update') && <button className="btn danger" onClick={() => setStatus('cancelled', 'PO cancelled')} disabled={busy}>Cancel</button>}
      </div>}>
      <Section title="Summary"><KV rows={[
        ['Vendor', `${dash(po.vendor_name)}${po.vendor_gstin ? ' · ' + po.vendor_gstin : ''}`],
        ['Status', (PO_STATUS[po.status]?.[0]) ?? po.status],
        ['Placement', `${dash(po.branch_name)}${po.vertical_name ? ' › ' + po.vertical_name : ''} · ${po.location}`],
        ['Order date', fmtDate(po.order_date)], ['Expected', fmtDate(po.expected_date)],
        ['Received', po.received_at ? `${fmtDate(po.received_at)}${po.received_by_name ? ' by ' + po.received_by_name : ''}` : '—'],
      ]} /></Section>
      <Section title="Line items">
        <TableCard title="Items" icon="doc"
          cols={['#', 'Item / description', 'HSN', 'Qty', 'Rate', 'Disc', 'GST', 'Amount']}
          empty="No line items."
          rows={(po.items ?? []).map((it: any) => [
            it.line_no,
            { node: <div><b>{it.description}</b>{it.item_code ? <div className="sub mono">{it.item_code}</div> : null}</div> } as Cell,
            it.hsn_code ?? '—', Number(it.qty), fmtINR(it.unit_price_minor),
            Number(it.discount_minor) ? fmtINR(it.discount_minor) : '—',
            `${Number(it.tax_pct)}% · ${fmtINR(it.tax_minor)}`, fmtINR(it.total_minor),
          ])} />
        <div style={{ marginTop: 8, textAlign: 'right', fontSize: 13 }}>
          Subtotal {fmtINR(po.subtotal_minor)} · Discount {fmtINR(po.discount_minor)} · <b>GST {fmtINR(po.tax_minor)}</b> · <b>Total {fmtINR(po.total_minor)}</b>
        </div>
      </Section>
      {(po.notes || po.terms) && <Section title="Notes & terms"><KV rows={[['Notes', dash(po.notes)], ['Terms', dash(po.terms)]]} /></Section>}
      {confirmRecv && <ConfirmModal title="Receive this PO?" body="Receiving marks the PO received and adds each catalog line's quantity into inventory at the PO's branch/location." confirmLabel="Receive" busy={busy} onConfirm={() => { setConfirmRecv(false); receive(); }} onClose={() => setConfirmRecv(false)} />}
    </DetailModal>
  );
}
