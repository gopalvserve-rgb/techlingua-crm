/** Generic spec-driven block renderer — mirrors the prototype's renderBlock(). */
import { Fragment, ReactNode } from 'react';
import { Block, KpiItem } from './specs';
import { Ic, checkS } from './icons';

/* A table/list cell: plain string, badge {b:[text,klass]}, mono {mono}, or raw node */
export type Cell = string | number | { b: [string, string] } | { mono: string; dim?: boolean } | { node: ReactNode };

export function renderCell(c: Cell, i?: number): ReactNode {
  if (c == null) return '—';
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  if ('b' in c) return <span className={`bdg ${c.b[1]}`}>{c.b[0]}</span>;
  if ('mono' in c) return <span className={`mono${c.dim ? ' sub' : ''}`}>{c.mono}</span>;
  return c.node;
}

const AV_GRADS = ['#7c83ff,#6366f1', '#22d3ee,#0891b2', '#fb7185,#e11d48', '#34d399,#059669', '#fbbf24,#d97706', '#a78bfa,#7c3aed'];
export const avGrad = (seed: number | string) => {
  const n = typeof seed === 'number' ? seed : String(seed).split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
  return AV_GRADS[Math.abs(n) % AV_GRADS.length];
};
export const initials = (name: string) => (name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

export function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'lg' }) {
  return (
    <div className={size === 'sm' ? 'av-sm' : 'av-lg'} style={{ background: `linear-gradient(135deg,${avGrad(name)})` }}>
      {initials(name)}
    </div>
  );
}

export function TempBadge({ temperature, score }: { temperature?: string | null; score?: number | null }) {
  if (!temperature) return <span className="bdg b-gray">—</span>;
  const cls = temperature === 'hot' ? 'b-hot' : temperature === 'warm' ? 'b-warm' : 'b-cold';
  const label = temperature[0].toUpperCase() + temperature.slice(1);
  return (
    <span className={`bdg ${cls}`} style={temperature === 'cold' ? { color: 'var(--cold)' } : undefined}>
      <span className="d" style={{ background: 'currentColor' }} />
      {label}{score != null && Number(score) > 0 ? ` ${score}` : ''}
    </span>
  );
}

export function Kpis({ items, cols = 4 }: { items: KpiItem[]; cols?: number }) {
  const icTone = (ic?: string) =>
    (({ rupee: 'amber', check: 'green', clock: 'rose', leads: 'indigo', users: 'cyan', students: 'indigo' } as Record<string, string>)[ic ?? ''] || 'indigo');
  return (
    <div className="kpi-strip" style={{ gridTemplateColumns: `repeat(${cols},1fr)` }}>
      {items.map((k, i) => (
        <div className="card kpi" key={i}>
          <div className={`ic ${icTone(k.ic)}`}><Ic k={k.ic || 'bolt'} /></div>
          <div className="lab">{k.lab}</div>
          <div className="val">{k.val}</div>
          {k.delta ? (
            <div className={`delta ${k.tone || 'flat'}`}>
              {k.tone === 'up' && <Ic k="up" w={2.4} />}
              {k.tone === 'down' && <Ic k="down" w={2.4} />}
              {k.delta}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function TableCard({ title, cols, rows, more, empty, onRowClick, icon = 'list', rowClass }: {
  title?: string; cols: string[]; rows: Cell[][]; more?: ReactNode; empty?: string;
  onRowClick?: (rowIndex: number) => void; icon?: string;
  /** optional per-row tint class (e.g. error-log severity highlighting) */
  rowClass?: (rowIndex: number) => string | undefined;
}) {
  return (
    <div className="card">
      {title && (
        <div className="card-head">
          <h3><Ic k={icon} />{title}</h3>
          {more ? <span className="more">{more}</span> : null}
        </div>
      )}
      <div className="scroll-x">
        <table className="tbl">
          <thead><tr>{cols.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td className="empty" colSpan={cols.length}>{empty || 'No records yet'}</td></tr>
            ) : rows.map((r, ri) => (
              <tr key={ri} className={rowClass?.(ri) || undefined} onClick={onRowClick ? () => onRowClick(ri) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}>
                {r.map((c, ci) => <td key={ci}>{renderCell(c)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ListCard({ title, rows, more, empty, icon = 'list', children }: {
  title: string; rows: Array<{ ic?: string; tone?: string; t1: ReactNode; t2?: ReactNode; rt?: ReactNode }>;
  more?: ReactNode; empty?: string; icon?: string; children?: ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-head"><h3><Ic k={icon} />{title}</h3>{more ? <span className="more">{more}</span> : null}</div>
      {rows.length === 0 && !children ? <div className="lrow empty">{empty || 'Nothing here yet'}</div> :
        rows.map((r, i) => (
          <div className="lrow" key={i}>
            <div className={`ic-t ${r.tone || 'b-indigo'}`}><Ic k={r.ic || 'bolt'} /></div>
            <div className="gr"><div className="t1">{r.t1}</div><div className="t2">{r.t2 || ''}</div></div>
            {r.rt ? <span className="rt">{r.rt}</span> : null}
          </div>
        ))}
      {children}
    </div>
  );
}

export function HBars({ title, rows, empty }: { title: string; rows: Array<{ label: string; val: string; pct: number; color: string }>; empty?: string }) {
  return (
    <div className="card">
      <div className="card-head"><h3><Ic k="analytics" />{title}</h3></div>
      <div className="card-pad">
        {rows.length === 0 ? <div className="empty-note">{empty || 'No data yet'}</div> : (
          <div className="hbars">
            {rows.map((r, i) => (
              <div className="hbar" key={i}>
                <div className="top"><span>{r.label}</span><b>{r.val}</b></div>
                <div className="track"><div className="fill" style={{ width: `${Math.min(r.pct, 100)}%`, background: r.color }} /></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Funnel({ title, rows, empty }: { title: string; rows: Array<{ label: string; val: string; sub?: string; pct: number; color: string }>; empty?: string }) {
  return (
    <div className="card">
      <div className="card-head"><h3><Ic k="analytics" />{title}</h3></div>
      <div className="card-pad">
        {rows.length === 0 ? <div className="empty-note">{empty || 'The funnel fills as leads arrive'}</div> : (
          <div className="funnel">
            {rows.map((r, i) => (
              <div className="fr" key={i}>
                <div className="fl">{r.label}</div>
                <div className="ft" style={{ width: `${Math.max(r.pct, 8)}%`, background: r.color }}>{r.val}</div>
                <div className="fv">{r.sub || ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function BarsCard({ title, series }: { title: string; series: Array<{ day: string; leads: number; won: number }> }) {
  const max = Math.max(1, ...series.map((s) => s.leads));
  return (
    <div className="card">
      <div className="card-head">
        <h3><Ic k="analytics" />{title}</h3>
        <div className="legend">
          <span className="li"><span className="sw" style={{ background: 'var(--primary)' }} />Leads</span>
          <span className="li"><span className="sw" style={{ background: 'var(--accent)' }} />Converted</span>
        </div>
      </div>
      <div className="card-pad">
        {series.every((s) => s.leads === 0 && s.won === 0) ? (
          <div className="empty-note">Lead inflow charts fill as leads arrive over the next 14 days</div>
        ) : (
          <>
            <div className="bars">
              {series.map((s, i) => (
                <div className="col" key={i}>
                  <div className="bar" style={{ height: `${(s.leads / max) * 130}px` }} title={`${s.leads} leads`} />
                  <div className="bar alt" style={{ height: `${(s.won / max) * 130}px` }} title={`${s.won} converted`} />
                </div>
              ))}
            </div>
            <div className="bars-x">{series.map((s, i) => <span key={i}>{new Date(s.day).getDate()}</span>)}</div>
          </>
        )}
      </div>
    </div>
  );
}

/** Fallback renderer for static spec blocks (ported prototype block types). */
export function Blocks({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((b, i) => <Fragment key={i}><BlockView b={b} /></Fragment>)}</>;
}

function BlockView({ b }: { b: Block }): JSX.Element | null {
  switch (b.type) {
    case 'kpis':
      return <Kpis items={b.items as KpiItem[]} cols={typeof b.cols === 'number' ? b.cols : 4} />;
    case 'table':
      return <TableCard title={b.title} cols={b.cols as string[]} rows={(b.rows || []) as Cell[][]} more={b.more} empty={b.empty} />;
    case 'caps':
      return (
        <div className="card caps">
          <h4>{b.title || 'Capabilities'}</h4>
          {(b.items || []).map((c: any, i: number) => (
            <div className="cap" key={i}>
              <div className={`ck ${c.p2 ? 'p2' : ''}`}>{checkS}</div>
              <div><div>{c.t}</div>{c.d ? <div className="cd">{c.d}</div> : null}</div>
            </div>
          ))}
        </div>
      );
    case 'cfg':
      return (
        <div className="card">
          <div className="card-head"><h3><Ic k="cfg" />{b.title}</h3></div>
          {(b.rows || []).map((r: any, i: number) => (
            <div className="cfg-row" key={i}>
              <div className="ci"><Ic k={r.ic || 'cfg'} /></div>
              <div className="cg"><div className="ct">{r.k}</div><div className="cs">{r.s || ''}</div></div>
              <span className="cv">{r.v || ''}</span>
              {r.toggle !== undefined ? <div className={`toggle ${r.toggle ? 'on' : ''}`} /> : null}
            </div>
          ))}
        </div>
      );
    case 'list':
      return <ListCard title={b.title || ''} rows={(b.rows || []) as any[]} more={b.more} empty={b.empty} />;
    case 'hbars':
      return <HBars title={b.title || ''} rows={(b.rows || []) as any[]} empty={b.empty} />;
    case 'funnel':
      return <Funnel title={b.title || ''} rows={(b.rows || []) as any[]} empty={b.empty} />;
    case 'donut':
      return (
        <div className="card">
          <div className="card-head"><h3><Ic k="finance" />{b.title}</h3></div>
          <div className="card-pad">
            {!(b.slices || []).length ? <div className="empty-note">{b.empty || 'No data yet'}</div> : (
              <DonutChart center={b.center || ''} slices={b.slices!} />
            )}
          </div>
        </div>
      );
    case 'builder': {
      const cl: Record<string, string> = { trig: 'bn-trig', cond: 'bn-cond', act: 'bn-act', wait: 'bn-wait', end: 'bn-end' };
      const ic: Record<string, string> = { trig: 'bolt', cond: 'filter', act: 'check', wait: 'clock', end: 'target' };
      return (
        <div className="card">
          <div className="card-head"><h3><Ic k="bolt" />{b.title}</h3></div>
          <div className="builder">
            {(b.steps || []).map((s, i) => (
              <div className="bstep" key={i}>
                <div className="rail"><div className={`bnode ${cl[s.k]}`}><Ic k={ic[s.k]} /></div><div className="bline" /></div>
                <div className="bbody"><div className="bt">{s.t}</div><div className="bd">{s.d}</div></div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case 'form':
      return (
        <div className="card">
          <div className="card-head"><h3><Ic k="doc" />{b.title}</h3></div>
          <div className="form-grid">
            {(b.fields || []).map((f, i) => (
              <div className={`fld ${f.span === 2 ? 'span2' : ''}`} key={i}>
                <label>{f.label}{f.req ? <> <span className="star">*</span></> : null}</label>
                <div className={`inp ${f.req ? 'req' : ''}`}>
                  {f.val ? <span>{f.val}</span> : <span className="ph">{f.ph || '—'}</span>}
                  <Ic k="chevd" />
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    case 'tree':
      return (
        <div className="card">
          <div className="card-head"><h3><Ic k="grid" />{b.title}</h3></div>
          <div className="tree">{(b.nodes || []).map((n: any, i: number) => <TreeNode n={n} key={i} />)}</div>
        </div>
      );
    case 'bignum':
      return (
        <div className="card bignum">
          <div className="l">{b.l}</div><div className="v">{b.v}</div>
          <div className="s"><span className={`bdg ${b.tone || 'b-indigo'}`}>{b.s}</span></div>
        </div>
      );
    case 'row2':
      return (
        <div className="row2" style={{ gridTemplateColumns: String(b.cols) }}>
          {(b.items || []).map((x: Block, i: number) => <Fragment key={i}><BlockView b={x} /></Fragment>)}
        </div>
      );
    case 'p2notice':
      return (
        <div className="notice">
          <Ic k="bolt" />
          <div><b>Planned for Phase 2.</b> Structure confirmed during requirements discovery — the screen below is the final design; build is scheduled after Phase 1 go-live.</div>
        </div>
      );
    case 'notice':
      return <div className="notice"><Ic k="bolt" /><div>{b.text}</div></div>;
    default:
      return null;
  }
}

export function DonutChart({ center, slices }: { center: string; slices: Array<{ label: string; pct: number; color: string }> }) {
  let off = 25;
  const segs = slices.map((s, i) => {
    const el = (
      <circle key={i} cx="21" cy="21" r="15.9" fill="transparent" stroke={s.color} strokeWidth="6"
        strokeDasharray={`${s.pct} ${100 - s.pct}`} strokeDashoffset={off} />
    );
    off = (off - s.pct + 100) % 100;
    return el;
  });
  return (
    <div className="donut-wrap">
      <svg width="130" height="130" viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--surface-3)" strokeWidth="6" />
        {segs}
        <text x="21" y="20.5" textAnchor="middle" fontSize="6" fontWeight="700" fill="var(--text)">{center}</text>
        <text x="21" y="26" textAnchor="middle" fontSize="3" fill="var(--text-muted)">collected</text>
      </svg>
      <div className="donut-legend">
        {slices.map((s, i) => (
          <div className="dl" key={i}><span className="sw" style={{ background: s.color }} />{s.label}<span className="vv">{s.pct}%</span></div>
        ))}
      </div>
    </div>
  );
}

function TreeNode({ n }: { n: any }) {
  return (
    <div>
      <div className="trow">
        <Ic k={n.icon || 'grid'} /><b>{n.label}</b><span className="ttg">{n.tag || ''}</span>
      </div>
      {n.children?.length ? <div className="tchild">{n.children.map((c: any, i: number) => <TreeNode n={c} key={i} />)}</div> : null}
    </div>
  );
}
