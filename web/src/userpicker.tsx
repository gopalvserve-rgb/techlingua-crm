/**
 * Searchable user picker — the reusable dropdown behind campaign agent pools
 * (multi-select) and conditional "assign to" (single-select).
 *
 * - type-to-filter goes SERVER-SIDE (`GET /users?q=…` — the existing UAT list
 *   filters), optionally narrowed to a branch (`&branch_id=…`), so the offered
 *   users are exactly the requester's scope ∩ branch;
 * - rows show name + role badge + branch, with a checkbox in multi mode;
 * - selected users render as removable chips + an "N selected" summary;
 * - keyboard: ↑/↓ move, Enter toggles, Esc closes, Backspace pops the last chip.
 */
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Ic } from './icons';

export interface PickUser {
  id: number; name: string; role_names?: string; branch_names?: string; status?: string;
}

export function UserPicker({ value, onChange, multiple = true, branchId, placeholder, disabled, options }: {
  value: number[];
  onChange: (ids: number[]) => void;
  /** false = single-select (conditional rules' assign-to) */
  multiple?: boolean;
  /** narrows the offered users to one branch (campaign's branch by default) */
  branchId?: number;
  placeholder?: string;
  disabled?: boolean;
  /**
   * GENERIC MODE (multi-branch user access, etc.): when supplied, the picker offers
   * exactly these options (already in the caller's scope) and filters them CLIENT-SIDE
   * by the typed query — no `/users` fetch. Same searchable multi-select UI/CSS, so
   * the campaign agent pool and a Branch/Vertical Access picker are the ONE control.
   */
  options?: PickUser[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PickUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  // names of already-selected ids survive searches/branch switches
  const [known, setKnown] = useState<Record<number, PickUser>>({});
  const root = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const fetchUsers = (query: string) => {
    // Generic option mode: no network — filter the supplied options client-side.
    if (options) {
      const ql = query.trim().toLowerCase();
      const live = (ql ? options.filter((o) => o.name.toLowerCase().includes(ql)) : options)
        .filter((o) => o.status !== 'disabled');
      setRows(live);
      setActive(0);
      setKnown((k) => {
        const next = { ...k };
        for (const o of options) next[Number(o.id)] = o; // resolve ALL chip names, not just filtered
        return next;
      });
      setLoading(false);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (branchId) params.set('branch_id', String(branchId));
    const qs = params.toString();
    api.get<PickUser[]>(`/users${qs ? `?${qs}` : ''}`)
      .then((list) => {
        if (n !== seq.current) return; // stale response
        const live = list.filter((u) => u.status !== 'disabled');
        setRows(live);
        setActive(0);
        setKnown((k) => {
          const next = { ...k };
          for (const u of live) next[Number(u.id)] = u;
          return next;
        });
      })
      .catch(() => n === seq.current && setRows([]))
      .finally(() => n === seq.current && setLoading(false));
  };

  // debounced server-side search while open; instant filter in option mode (and on
  // options change, e.g. Vertical Access re-narrowing when Branch Access changes)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => fetchUsers(q), q && !options ? 220 : 0);
    return () => clearTimeout(t);
  }, [open, q, branchId, options]);

  // resolve chip names for ids selected before the first dropdown open (edit mode)
  useEffect(() => {
    if (value.some((id) => !known[id])) fetchUsers('');
  }, [value.join(',')]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const selected = useMemo(() => new Set(value.map(Number)), [value]);
  const toggle = (id: number) => {
    id = Number(id);
    if (multiple) {
      onChange(selected.has(id) ? value.filter((x) => Number(x) !== id) : [...value, id]);
      inp.current?.focus();
    } else {
      onChange(selected.has(id) ? [] : [id]);
      setOpen(false); setQ('');
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open && ['ArrowDown', 'Enter'].includes(e.key)) { e.preventDefault(); setOpen(true); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[active]) toggle(Number(rows[active].id)); }
    else if (e.key === 'Escape') { setOpen(false); }
    else if (e.key === 'Backspace' && !q && value.length) { onChange(value.slice(0, -1)); }
  };

  const chipName = (id: number) => known[id]?.name ?? `User #${id}`;

  return (
    <div className={`upick ${disabled ? 'dis' : ''}`} ref={root}>
      <div className="upick-ctl" onClick={() => { if (!disabled) { setOpen(true); inp.current?.focus(); } }}>
        <Ic k="search" className="upick-mag" />
        <div className="upick-chips">
          {value.map((id) => (
            <span className="upick-chip" key={id}>
              {chipName(Number(id))}
              {!disabled && (
                <button type="button" aria-label={`Remove ${chipName(Number(id))}`}
                  onClick={(e) => { e.stopPropagation(); onChange(value.filter((x) => Number(x) !== Number(id))); }}>
                  <Ic k="x" />
                </button>
              )}
            </span>
          ))}
          <input ref={inp} value={q} disabled={disabled}
            placeholder={value.length ? '' : placeholder ?? (multiple ? 'Search & pick users…' : 'Search & pick a user…')}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)} onKeyDown={onKey}
            role="combobox" aria-expanded={open} aria-autocomplete="list" />
        </div>
        {multiple && value.length > 0 && <span className="upick-count">{value.length} selected</span>}
        <Ic k="chevd" className="upick-caret" />
      </div>
      {open && !disabled && (
        <div className="upick-drop" role="listbox">
          {loading && rows.length === 0 && <div className="upick-empty">Searching…</div>}
          {!loading && rows.length === 0 && <div className="upick-empty">{options ? 'No matches' : 'No users match'}{q ? ` “${q}”` : ''}{!options && branchId ? ' in this branch' : ''}</div>}
          {rows.map((u, i) => {
            const id = Number(u.id);
            const sel = selected.has(id);
            return (
              <div key={id} role="option" aria-selected={sel}
                className={`upick-row ${i === active ? 'act' : ''} ${sel ? 'sel' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); toggle(id); }}>
                <span className={`upick-box ${sel ? 'on' : ''}`}>{sel && <Ic k="check" w={3} />}</span>
                <span className="upick-name">{u.name}</span>
                {u.role_names ? <span className="bdg b-indigo">{u.role_names.split(',')[0].trim()}</span> : null}
                <span className="upick-branch">{u.branch_names || 'All branches'}</span>
              </div>
            );
          })}
          {multiple && rows.length > 0 && (
            <div className="upick-foot">
              <span>{value.length} selected</span>
              {value.length > 0 && <button type="button" onMouseDown={(e) => { e.preventDefault(); onChange([]); }}>Clear all</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
