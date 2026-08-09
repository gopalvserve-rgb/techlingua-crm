/**
 * COLUMN VISIBILITY CHOOSER (client, Aug 2026).
 *
 * Every listing gets a "Columns" control so each user picks which columns they want to see.
 * The choice is remembered PER USER, PER LIST in localStorage under
 *   tlc.cols.v1.<userId>.<listKey>
 * storing the set of HIDDEN column ids (so a column added later defaults to visible). The user
 * id is written by AuthProvider on login (tlc.uid); localStorage is per-user-per-machine, which
 * the client accepted. `TableCard` wires this generically, so it appears on every list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ic } from './icons';

function currentUid(): string {
  try { return localStorage.getItem('tlc.uid') || 'anon'; } catch { return 'anon'; }
}
function storageKey(listKey: string): string { return `tlc.cols.v1.${currentUid()}.${listKey}`; }

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

  useEffect(() => {
    if (!listKey) { setHidden(new Set()); return; }
    try {
      const raw = localStorage.getItem(storageKey(listKey));
      setHidden(raw ? new Set(JSON.parse(raw) as string[]) : new Set());
    } catch { setHidden(new Set()); }
  }, [listKey]);

  const persist = useCallback((next: Set<string>) => {
    if (!listKey) return;
    try { localStorage.setItem(storageKey(listKey), JSON.stringify([...next])); } catch { /* quota / private mode */ }
  }, [listKey]);

  const visibleIdx = useMemo(
    () => ids.map((_, i) => i).filter((i) => !hidden.has(ids[i])),
    [ids, hidden],
  );

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

  const reset = useCallback(() => { setHidden(new Set()); persist(new Set()); }, [persist]);

  return { ids, visibleIdx, hidden, toggle, reset };
}

export function ColumnsButton({ cols, ids, hidden, onToggle, onReset }: {
  cols: string[]; ids: string[]; hidden: Set<string>;
  onToggle: (id: string) => void; onReset: () => void;
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
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', padding: '2px 6px 6px' }}>Show columns</div>
          {cols.map((c, i) => {
            const id = ids[i];
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
                <span>{label}</span>
              </label>
            );
          })}
          <button className="btn" type="button" onClick={onReset} style={{ marginTop: 6, width: '100%', justifyContent: 'center' }}>
            Show all
          </button>
        </div>
      )}
    </span>
  );
}
