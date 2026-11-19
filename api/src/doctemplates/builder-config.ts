import { CatField, DocType, docTypeDef } from './builder-catalog';

/**
 * A DOCUMENT TEMPLATE'S DESIGN (client 12 Nov 2026) — pure data, one shape for every document.
 * `sanitizeDocConfig` is the only way a config reaches the database or the renderer: groups,
 * fields and table columns are rebuilt from the catalogue (reorder / rename / hide, never invent),
 * strings are capped, colours validated, images limited to JPEG data URLs (the builder converts
 * PNG / SVG in the browser), custom fields capped at 20.
 */
export interface DocConfig {
  v: 1;
  page: { size: 'A4' | 'Letter' | 'CARD'; orientation: 'portrait' | 'landscape'; margin: number };
  branding: {
    institute_name: string; tagline: string; title: string; show_logo: boolean; logo: string;
    address: string; phone: string; email: string; website: string;
    header_bg: string; header_text: string; accent: string; title_align: 'left' | 'center' | 'right';
  };
  groups: Array<{ key: string; title: string; visible: boolean; fields: CatField[] }>;
  tables: Array<{ key: string; title: string; visible: boolean; columns: CatField[] }>;
  body: string;
  custom_fields: Array<{ label: string; value: string; visible: boolean }>;
  partner: { show: boolean; name: string; text: string };
  footer: {
    terms: string; note: string; disclaimer: string; show_qr: boolean; show_barcode: boolean; show_generated_at: boolean;
    signatories: Array<{ label: string; name: string; image: string }>; stamp_img: string;
  };
  design: { font_size: number; columns: 1 | 2 | 3; borders: boolean; group_titles: boolean };
}

export function defaultDocConfig(type: DocType): DocConfig {
  const d = docTypeDef(type)!;
  return {
    v: 1,
    page: { size: d.page === 'CARD' ? 'CARD' : 'A4', orientation: d.orientation, margin: d.page === 'CARD' ? 10 : 36 },
    branding: {
      institute_name: '', tagline: '', title: d.title, show_logo: true, logo: '', address: '', phone: '', email: '', website: '',
      header_bg: '#4f46e5', header_text: '#ffffff', accent: '#4f46e5', title_align: d.module === 'Certificates' ? 'center' : 'right',
    },
    groups: d.groups.map((g) => ({ key: g.key, title: g.title, visible: true, fields: g.fields.map((x) => ({ ...x })) })),
    tables: d.tables.map((t) => ({ key: t.key, title: t.title, visible: true, columns: t.columns.map((x) => ({ ...x })) })),
    body: d.body ?? '',
    custom_fields: [],
    partner: { show: false, name: '', text: '' },
    footer: {
      terms: '', note: '', disclaimer: d.module === 'Certificates' ? 'This certificate can be verified by scanning the QR code.' : '',
      show_qr: d.qr_default, show_barcode: d.barcode_default, show_generated_at: d.page !== 'CARD',
      signatories: d.signatories.map((label) => ({ label, name: '', image: '' })), stamp_img: '',
    },
    design: { font_size: d.page === 'CARD' ? 7 : 9.5, columns: d.page === 'CARD' ? 1 : 2, borders: true, group_titles: d.page !== 'CARD' },
  };
}

const str = (v: unknown, max: number, dflt = ''): string => (typeof v === 'string' ? v.slice(0, max) : dflt);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
const color = (v: unknown, dflt: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : dflt);
const oneOf = <T extends string | number>(v: unknown, opts: readonly T[], dflt: T): T => (opts.includes(v as T) ? (v as T) : dflt);
const num = (v: unknown, min: number, max: number, dflt: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
export const MAX_IMAGE_CHARS = 820_000;
const image = (v: unknown): string =>
  (typeof v === 'string' && v.startsWith('data:image/jpeg;base64,') && v.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/=]+$/.test(v.slice(23)) ? v : '');

/** Keep the saved order / labels / visibility for known keys; append missing; drop unknown. */
function orderedFields(saved: unknown, catalog: CatField[]): CatField[] {
  const byKey = new Map(catalog.map((c) => [c.key, c]));
  const out: CatField[] = []; const seen = new Set<string>();
  for (const s of Array.isArray(saved) ? saved : []) {
    const k = String((s as any)?.key ?? ''); const base = byKey.get(k);
    if (!base || seen.has(k)) continue;
    seen.add(k);
    out.push({ key: k, label: str((s as any).label, 60, base.label) || base.label, visible: bool((s as any).visible, base.visible) });
  }
  for (const c of catalog) if (!seen.has(c.key)) out.push({ ...c });
  return out;
}

export function sanitizeDocConfig(type: DocType, raw: unknown): DocConfig {
  const d = defaultDocConfig(type);
  const def = docTypeDef(type)!;
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const b = r.branding ?? {}; const ft = r.footer ?? {}; const g = r.design ?? {}; const p = r.page ?? {}; const pt = r.partner ?? {};
  const savedGroups: any[] = Array.isArray(r.groups) ? r.groups : [];
  const groups: DocConfig['groups'] = [];
  const seen = new Set<string>();
  for (const sg of savedGroups) {
    const cat = def.groups.find((x) => x.key === sg?.key);
    if (!cat || seen.has(cat.key)) continue;
    seen.add(cat.key);
    groups.push({ key: cat.key, title: str(sg.title, 60, cat.title), visible: bool(sg.visible, true), fields: orderedFields(sg.fields, cat.fields) });
  }
  for (const cat of def.groups) if (!seen.has(cat.key)) groups.push({ key: cat.key, title: cat.title, visible: true, fields: cat.fields.map((x) => ({ ...x })) });
  const tables = def.tables.map((cat) => {
    const st = (Array.isArray(r.tables) ? r.tables : []).find((x: any) => x?.key === cat.key);
    return { key: cat.key, title: str(st?.title, 60, cat.title), visible: bool(st?.visible, true), columns: orderedFields(st?.columns, cat.columns) };
  });
  const sigs = (Array.isArray(ft.signatories) ? ft.signatories : d.footer.signatories).slice(0, 3)
    .map((s: any) => ({ label: str(s?.label, 60), name: str(s?.name, 80), image: image(s?.image) }));
  const size = oneOf(p.size, ['A4', 'Letter', 'CARD'] as const, d.page.size);
  return {
    v: 1,
    page: { size, orientation: oneOf(p.orientation, ['portrait', 'landscape'] as const, d.page.orientation),
      margin: num(p.margin, size === 'CARD' ? 4 : 18, size === 'CARD' ? 24 : 72, d.page.margin) },
    branding: {
      institute_name: str(b.institute_name, 120), tagline: str(b.tagline, 160), title: str(b.title, 60, d.branding.title) || d.branding.title,
      show_logo: bool(b.show_logo, true), logo: image(b.logo), address: str(b.address, 300), phone: str(b.phone, 60),
      email: str(b.email, 120), website: str(b.website, 120),
      header_bg: color(b.header_bg, d.branding.header_bg), header_text: color(b.header_text, d.branding.header_text),
      accent: color(b.accent, d.branding.accent), title_align: oneOf(b.title_align, ['left', 'center', 'right'] as const, d.branding.title_align),
    },
    groups, tables,
    body: str(r.body, 4000, d.body),
    custom_fields: (Array.isArray(r.custom_fields) ? r.custom_fields : []).slice(0, 20)
      .map((x: any) => ({ label: str(x?.label, 60), value: str(x?.value, 300), visible: bool(x?.visible, true) }))
      .filter((x: { label: string }) => x.label.trim()),
    partner: { show: bool(pt.show, false), name: str(pt.name, 160), text: str(pt.text, 400) },
    footer: {
      terms: str(ft.terms, 3000), note: str(ft.note, 400), disclaimer: str(ft.disclaimer, 400, d.footer.disclaimer),
      show_qr: bool(ft.show_qr, d.footer.show_qr), show_barcode: bool(ft.show_barcode, d.footer.show_barcode),
      show_generated_at: bool(ft.show_generated_at, d.footer.show_generated_at),
      signatories: sigs, stamp_img: image(ft.stamp_img),
    },
    design: {
      font_size: num(g.font_size, 6, 13, d.design.font_size), columns: oneOf(Number(g.columns), [1, 2, 3] as const, d.design.columns),
      borders: bool(g.borders, true), group_titles: bool(g.group_titles, d.design.group_titles),
    },
  };
}

/** {{variable}} substitution from the document's field values. Unknown variables stay visible. */
export function fillDocVars(text: string, vars: Record<string, string>): string {
  return String(text ?? '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k) => (k in vars && vars[k] ? vars[k] : m));
}
