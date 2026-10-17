import { useEffect, useMemo, useRef, useState } from 'react';

/** Width of the chart container in CSS pixels so the SVG renders crisp text at 1:1. */
function useContainerWidth<T extends HTMLElement>(fallback = 640): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(240, Math.floor(el.getBoundingClientRect().width)) || fallback);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width];
}

/** Dependency-free SVG charts. Sizes are in CSS pixels; the SVG scales with its container. */

export interface Series {
  id: string;
  label: string;
  color: string;
  points: { x: string; y: number }[];
}

const PALETTE = ['#4f8cff', '#3fbf7f', '#e8b339', '#ef5b5b', '#b07cff', '#5aa9e6'];
export const seriesColor = (i: number) => PALETTE[i % PALETTE.length]!;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / exp;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * exp;
}

function formatTick(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * Multi-series line chart over a shared, sorted set of x labels (dates).
 * Missing points are treated as 0 (sparse metric storage).
 */
export function LineChart({
  series,
  height = 180,
  yFormat = formatTick,
  fillZeros = true,
  showLegend = true,
}: {
  series: Series[];
  height?: number;
  yFormat?: (v: number) => string;
  fillZeros?: boolean;
  showLegend?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const pad = { l: 44, r: 12, t: 10, b: 24 };
  const model = useMemo(() => {
    const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
    const rows = series.map((s) => {
      const map = new Map(s.points.map((p) => [p.x, p.y]));
      return xs.map((x) => (map.has(x) ? map.get(x)! : fillZeros ? 0 : null));
    });
    const max = niceMax(Math.max(0, ...rows.flat().map((v) => v ?? 0)));
    return { xs, rows, max };
  }, [series, fillZeros]);

  if (!model.xs.length) return <div className="chart-empty muted small" ref={containerRef}>–</div>;
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const xAt = (i: number) => pad.l + (model.xs.length === 1 ? innerW / 2 : (i / (model.xs.length - 1)) * innerW);
  const yAt = (v: number) => pad.t + innerH - (v / model.max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * model.max);
  const labelEvery = Math.max(1, Math.ceil(model.xs.length / 6));

  return (
    <div className="chart" ref={containerRef}>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="chart-svg" onMouseLeave={() => setHover(null)}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={width - pad.r} y1={yAt(tick)} y2={yAt(tick)} className="chart-grid" />
            <text x={pad.l - 6} y={yAt(tick) + 4} textAnchor="end" className="chart-tick">
              {yFormat(tick)}
            </text>
          </g>
        ))}
        {model.xs.map((x, i) =>
          i % labelEvery === 0 || i === model.xs.length - 1 ? (
            <text key={x} x={xAt(i)} y={height - 6} textAnchor="middle" className="chart-tick">
              {x.slice(5)}
            </text>
          ) : null,
        )}
        {series.map((s, si) => {
          const row = model.rows[si]!;
          const d = row
            .map((v, i) => (v === null ? null : `${i === 0 || row[i - 1] === null ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`))
            .filter(Boolean)
            .join(' ');
          return <path key={s.id} d={d} fill="none" stroke={s.color} strokeWidth={2} />;
        })}
        {hover !== null && <line x1={xAt(hover)} x2={xAt(hover)} y1={pad.t} y2={pad.t + innerH} className="chart-cursor" />}
        {model.xs.map((_, i) => (
          <rect
            key={i}
            x={i === 0 ? pad.l : (xAt(i - 1) + xAt(i)) / 2}
            width={model.xs.length === 1 ? innerW : i === 0 || i === model.xs.length - 1 ? innerW / (model.xs.length - 1) / 2 : innerW / (model.xs.length - 1)}
            y={pad.t}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {(showLegend || hover !== null) && (
        <div className="chart-legend">
          {hover !== null && <span className="muted">{model.xs[hover]}</span>}
          {series.map((s, si) => (
            <span key={s.id} className="chart-legend-item">
              <i style={{ background: s.color }} /> {s.label}
              {hover !== null && <strong> {yFormat(model.rows[si]![hover] ?? 0)}</strong>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Horizontal 0–100 score bar. */
export function ScoreBar({ value, label }: { value: number | null; label: string }) {
  const tone = value === null ? 'neutral' : value >= 70 ? 'ok' : value >= 40 ? 'warning' : 'error';
  return (
    <div className="score">
      <div className="score-head">
        <span>{label}</span>
        <strong>{value === null ? '–' : Math.round(value)}</strong>
      </div>
      <div className="score-track">
        <div className={`score-fill score-${tone}`} style={{ width: `${value ?? 0}%` }} />
      </div>
    </div>
  );
}

/** "+12 %" / "−8 %" with colour; `invert` when a decrease is good (e.g. cost). */
export function Delta({ current, previous, invert = false, suffix = '%' }: { current: number | null; previous: number | null | undefined; invert?: boolean; suffix?: string }) {
  if (!previous || current === null) return <span className="muted small">–</span>;
  const pct = ((current - previous) / previous) * 100;
  const good = invert ? pct < 0 : pct > 0;
  const tone = Math.abs(pct) < 1 ? 'neutral' : good ? 'ok' : 'error';
  return (
    <span className={`delta delta-${tone}`} title={`${previous.toLocaleString()} → ${current.toLocaleString()}`}>
      {pct > 0 ? '▲' : pct < 0 ? '▼' : '•'} {Math.abs(pct).toFixed(0)}
      {suffix}
    </span>
  );
}
