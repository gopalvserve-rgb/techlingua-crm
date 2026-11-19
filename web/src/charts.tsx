/**
 * CHARTS — client 12 Nov 2026 ("Analytics & Reports: complete on priority").
 *
 * Small dependency-free SVG charts used by the Report Builder, saved reports and Counselor
 * Performance. One rule set (dataviz method): one value axis only, thin marks with 4px rounded
 * data-ends, categorical hues in a FIXED order (never cycled — past six slices fold into
 * "Other"), text in text colours (never the series colour), a hover tooltip on every mark, and a
 * table view always beside the chart (the report grid). Colours come from CSS tokens
 * (--viz-*) with their own dark-mode steps in styles.css.
 */
import { useMemo, useRef, useState } from 'react';

export interface ChartDatum { label: string; value: number }
type Fmt = (v: number) => string;

const SLOTS = 6;   // categorical slots — a 7th slice folds into "Other"
const slot = (i: number) => `var(--viz-${(i % SLOTS) + 1})`;

function Tip({ tip }: { tip: { x: number; y: number; title: string; value: string } | null }) {
  if (!tip) return null;
  return (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
      <div className="viz-tip-t">{tip.title}</div>
      <div className="viz-tip-v">{tip.value}</div>
    </div>
  );
}

/** Horizontal bars — magnitude by category (counsellor, source, campaign…). Labels sit left,
 *  values at each bar's end; long lists keep the first 15 and say so. */
export function HBarChart({ data, fmt, max = 15, ariaLabel }: { data: ChartDatum[]; fmt: Fmt; max?: number; ariaLabel: string }) {
  const rows = data.slice(0, max);
  const top = Math.max(1, ...rows.map((d) => d.value));
  const [tip, setTip] = useState<{ x: number; y: number; title: string; value: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  return (
    <div className="viz-root viz-hbars" ref={box} role="img" aria-label={ariaLabel} onMouseLeave={() => setTip(null)}>
      {rows.map((d, i) => (
        <div className="viz-hrow" key={i}
          onMouseMove={(e) => { const r = box.current!.getBoundingClientRect(); setTip({ x: e.clientX - r.left + 12, y: e.clientY - r.top + 12, title: d.label, value: fmt(d.value) }); }}>
          <div className="viz-hlabel" title={d.label}>{d.label || '—'}</div>
          <div className="viz-htrack">
            <div className="viz-hbar" style={{ width: `${Math.max((d.value / top) * 100, d.value > 0 ? 1.5 : 0)}%` }} />
            <span className="viz-hval">{fmt(d.value)}</span>
          </div>
        </div>
      ))}
      {data.length > max ? <div className="viz-more">+ {data.length - max} more in the table below</div> : null}
      <Tip tip={tip} />
    </div>
  );
}

/** Line — one measure over time (day / month buckets). Crosshair + tooltip on hover, the last
 *  point labelled, x labels thinned so they never collide. */
export function LineChart({ data, fmt, ariaLabel, height = 220 }: { data: ChartDatum[]; fmt: Fmt; ariaLabel: string; height?: number }) {
  const W = 640; const H = height; const L = 56; const R = 16; const T = 14; const B = 30;
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(1, ...data.map((d) => d.value));
  const nice = useMemo(() => niceMax(top), [top]);
  const x = (i: number) => L + (data.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (data.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / nice);
  const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  const every = Math.max(1, Math.ceil(data.length / 8));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => nice * f);
  if (!data.length) return null;
  const last = data.length - 1;
  return (
    <div className="viz-root viz-line" role="img" aria-label={ariaLabel}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const svg = e.currentTarget; const r = svg.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          let best = 0; let bd = Infinity;
          data.forEach((_, i) => { const dd = Math.abs(x(i) - px); if (dd < bd) { bd = dd; best = i; } });
          setHover(best);
        }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="viz-grid" />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="viz-axis">{fmt(t)}</text>
          </g>
        ))}
        {data.map((d, i) => (i % every === 0 || i === last) ? (
          <text key={i} x={x(i)} y={H - 10} textAnchor="middle" className="viz-axis">{shortLabel(d.label)}</text>
        ) : null)}
        <polyline points={pts} className="viz-stroke" fill="none" />
        {hover != null ? (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="viz-cross" />
            <circle cx={x(hover)} cy={y(data[hover].value)} r={5} className="viz-dot" />
          </>
        ) : (
          <circle cx={x(last)} cy={y(data[last].value)} r={4} className="viz-dot" />
        )}
        {hover == null ? (
          <text x={Math.min(x(last), W - R - 4)} y={y(data[last].value) - 10} textAnchor="end" className="viz-val">{fmt(data[last].value)}</text>
        ) : null}
      </svg>
      {hover != null ? (
        <div className="viz-tip viz-tip-fixed" style={{ left: `${(x(hover) / W) * 100}%` }} role="tooltip">
          <div className="viz-tip-t">{data[hover].label}</div>
          <div className="viz-tip-v">{fmt(data[hover].value)}</div>
        </div>
      ) : null}
    </div>
  );
}

/** Donut — share of a whole. At most 6 slices in the fixed slot order; the rest fold into
 *  "Other". A legend with value + % always sits beside it (identity is never colour alone). */
export function DonutChart({ data, fmt, ariaLabel }: { data: ChartDatum[]; fmt: Fmt; ariaLabel: string }) {
  const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, SLOTS - (sorted.length > SLOTS ? 1 : 0));
  const rest = sorted.slice(head.length);
  const slices = rest.length ? [...head, { label: 'Other', value: rest.reduce((a, d) => a + d.value, 0) }] : head;
  const total = slices.reduce((a, d) => a + d.value, 0);
  const [hover, setHover] = useState<number | null>(null);
  if (!total) return <div className="empty-note">Nothing to chart in this range.</div>;
  const R = 70; const r = 44; const C = 90;
  let a0 = -Math.PI / 2;
  const arcs = slices.map((d) => {
    const a1 = a0 + (d.value / total) * Math.PI * 2;
    const path = arcPath(C, C, R, r, a0, a1);
    a0 = a1;
    return path;
  });
  const h = hover != null ? slices[hover] : null;
  return (
    <div className="viz-root viz-donut" role="img" aria-label={ariaLabel}>
      <svg viewBox="0 0 180 180" width={180} height={180} onMouseLeave={() => setHover(null)}>
        {arcs.map((p, i) => (
          <path key={i} d={p} style={{ fill: slices[i].label === 'Other' ? 'var(--viz-other)' : slot(i) }} className="viz-slice"
            opacity={hover == null || hover === i ? 1 : 0.45} onMouseEnter={() => setHover(i)} />
        ))}
        <text x={C} y={C - 2} textAnchor="middle" className="viz-center">{h ? fmt(h.value) : fmt(total)}</text>
        <text x={C} y={C + 14} textAnchor="middle" className="viz-axis">{h ? `${Math.round((h.value / total) * 100)}%` : 'Total'}</text>
      </svg>
      <div className="viz-legend">
        {slices.map((d, i) => (
          <div key={i} className={`viz-li${hover === i ? ' on' : ''}`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="viz-sw" style={{ background: d.label === 'Other' ? 'var(--viz-other)' : slot(i) }} />
            <span className="viz-ln" title={d.label}>{d.label || '—'}</span>
            <span className="viz-lv">{fmt(d.value)}</span>
            <span className="viz-lp">{Math.round((d.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function arcPath(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  // a full circle needs two arcs
  if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
  return `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`;
}

/** 0 → the next 1/2/5 × 10^n above the data max, so axis ticks are round numbers. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** "2026-11-05" → "5 Nov", "2026-11" → "Nov 26"; anything else unchanged. */
export function shortLabel(s: string): string {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${Number(m[3])} ${MON[Number(m[2]) - 1]}`;
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return `${MON[Number(m[2]) - 1]} ${m[1].slice(2)}`;
  return s;
}
