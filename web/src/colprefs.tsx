/**
 * COLUMN VISIBILITY CHOOSER (client, Aug 2026).
 *
 * Every listing gets a "Columns" control so each user picks which columns they want to see.
 * The choice is remembered PER USER, PER LIST in localStorage under
 *   tlc.cols.v1.<userId>.<listKey>
 * storing the set of HIDDEN column ids (so a column added later defaults to visible). The user
 * id is written by AuthProvider on login (tlc.uid); localStorage is per-user-per-machine, which
 * the client accepted. `TableCard` wires this generically, so it appears on every list.
 *
 * FB-2026-006 / client's 15 Nov document point 7 — "give the option to arrange the columns in any
 * table": the same chooser now moves a column up / down (▲ ▼). The ORDER is remembered per user, per
 * list under tlc.colorder.v1.<userId>.<listKey> (the full list of column ids). A column added to the
 * screen later keeps its natural place; "Reset" restores the screen's own order and shows everything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ic } from './icons';

function currentUid(): string {
  try { return localStorage.getItem('tlc.uid') || 'anon'; } catch { return 'anon'; }
}
function storageKey(listKey: string): string { return `tlc.cols.v1.${currentUid()}.${listKey}`; }
function orderKey(listKey: string): string { return `tlc.colorder.v1.${currentUid()}.${listKey}`; }

/** The saved order, cleaned: unknown ids dropped, columns it does not know inserted at their natural place. */
export function mergeColumnOrder(ids: string[], saved: string[]): string[] {
  const known = new Set(ids);
  const out = saved.filter((id, i) => known.has(id) && saved.indexOf(id) === i);
  ids.forEach((id, natural) => { if (!out.includes(id)) out.splice(Math.min(natural, out.length), 0, id); });
  return out;
}

/** Stable per-column id derived from the header labels (blank/duplicate-safe). */
export function colIds(cols: string[]): string[] {
  const seen = new Map<string, number>();
  return cols.map((c, i) => {
    const base = (c != null && String(c).trim()) || `col${i}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

export function useColumnVisibility(listKey: string | undefined, cols: string[]) {
  const ids = useMemo(() => colIds(cols), [cols.join('')]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [saved, setSaved] = useState<string[]>([]);

  useEffect(() => {
    if (!listKey) { setHidden(new Set()); setSaved([]); return; }
    try {
      const raw = localStorage.getItem(storageKey(listKey));
      setHidden(raw ? new Set(JSON.parse(raw) as string[]) : new Set());
    } catch { setHidden(new Set()); }
    try {
      const raw = localStorage.getItem(orderKey(listKey));
      const arr = raw ? JSON.parse(raw) : [];
      setSaved(Array.isArray(arr) ? arr.map(String) : []);
    } catch { setSaved([]); }
  }, [listKey]);

  // FB-2026-006 — the user's column order (ids), merged with the screen's current columns
  const order = useMemo(() => mergeColumnOrder(ids, saved), [ids, saved]);

  const persist = useCallback((next: Set<string>) => {
    if (!listKey) return;
    try { localStorage.setItem(storageKey(listKey), JSON.stringify([...next])); } catch { /* quota / private mode */ }
  }, [listKey]);

  const visibleIdx = useMemo(() => {
    const at = new Map(ids.map((id, i) => [id, i]));
    return order.map((id) => at.get(id)!).filter((i) => i != null && !hidden.has(ids[i]));
  }, [ids, order, hidden]);

  /** Move one column a place up (-1) or down (+1) in the user's order. */
  const move = useCallback((id: string, dir: -1 | 1) => {
    const cur = mergeColumnOrder(ids, saved);
    const i = cur.indexOf(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]];
    setSaved(cur);
    if (listKey) { try { localStorage.setItem(orderKey(listKey), JSON.stringify(cur)); } catch { /* quota / private mode */ } }
  }, [ids, saved, listKey]);

  const toggle = useCallback((id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        const visibleCount = ids.filter((x) => !next.has(x)).length;
        if (visibleCount <= 1) return prev; // never hide the last visible column
        next.add(id);
      }
      persist(next);
      return next;
    });
  }, [ids, persist]);

  const reset = useCallback(() => {
    setHidden(new Set()); persist(new Set());
    setSaved([]);
    if (listKey) { try { localStorage.removeItem(orderKey(listKey)); } catch { /* private mode */ } }
  }, [persist, listKey]);

  return { ids, visibleIdx, hidden, toggle, reset, order, move };
}

export function ColumnsButton({ cols, ids, hidden, onToggle, onReset, order, onMove }: {
  cols: string[]; ids: string[]; hidden: Set<string>;
  onToggle: (id: string) => void; onReset: () => void;
  /** FB-2026-006 — the user's column order (ids) and a mover; without them the list is the screen's order. */
  order?: string[]; onMove?: (id: string, dir: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const visibleCount = ids.length - hidden.size;

  return (
    <span className="colchooser" ref={wrap} style={{ position: 'relative', display: 'inline-flex' }}>
      <button className="btn" type="button" data-testid="col-chooser" aria-haspopup="menu" aria-expanded={open}
        aria-label="Choose which columns are visible" onClick={() => setOpen((o) => !o)}>
        <Ic k="cfg" />Columns
      </button>
      {open && (
        <div className="colchooser-pop" role="menu" data-testid="col-chooser-pop"
          style={{
            position: 'absolute', top: 'calc(100% + 5px)', right: 0, zIndex: 60, minWidth: 210, maxHeight: 320,
            overflow: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 11,
            boxShadow: '0 14px 38px rgba(0,0,0,.34)', padding: 7,
          }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', padding: '2px 6px 6px' }}>
            {onMove ? 'Show & arrange columns' : 'Show columns'}
          </div>
          {(order ?? ids).map((id, pos, list) => {
            const i = ids.indexOf(id);
            const c = cols[i];
            const shown = !hidden.has(id);
            const isLast = shown && visibleCount <= 1;
            const label = (c != null && String(c).trim()) ? String(c) : `Column ${i + 1}`;
            return (
              <label key={id} className="colchooser-item"
                style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 6px', fontSize: 12.5,
                  cursor: isLast ? 'not-allowed' : 'pointer', opacity: isLast ? 0.6 : 1, borderRadius: 7 }}>
                <input type="checkbox" checked={shown} disabled={isLast}
                  aria-label={`Toggle column ${label}`}
                  onChange={() => onToggle(id)} />
                <span style={{ flex: 1 }}>{label}</span>
                {onMove && (
                  <span style={{ display: 'inline-flex', gap: 2 }} onClick={(e) => e.preventDefault()}>
                    <button type="button" className="ract" disabled={pos === 0} aria-label={`Move ${label} up`} title="Move up"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMove(id, -1); }}>▲</button>
                    <button type="button" className="ract" disabled={pos === list.length - 1} aria-label={`Move ${label} down`} title="Move down"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMove(id, 1); }}>▼</button>
                  </span>
                )}
              </label>
            );
          })}
          <button className="btn" type="button" onClick={onReset} style={{ marginTop: 6, width: '100%', justifyContent: 'center' }}>
            {onMove ? 'Reset (show all, original order)' : 'Show all'}
          </button>
        </div>
      )}
    </span>
  );
}
