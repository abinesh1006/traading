import { useQueryClient } from '@tanstack/react-query'
import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import { ApiError } from '../api'

export type Tone = 'good' | 'warning' | 'critical'
type Span = 3 | 4 | 5 | 6 | 8 | 9 | 10 | 12 | 14 | 15 | 16 | 18 | 24

const ic = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/** Dashboard toolbar: title and description left; controls, then refresh, right. */
export function PageHeader(props: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  const qc = useQueryClient()
  const [spin, setSpin] = useState(false)
  const refresh = async () => {
    setSpin(true)
    await qc.invalidateQueries()
    setSpin(false)
  }
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{props.title}</h1>
        {props.sub != null && <p className="page-sub">{props.sub}</p>}
      </div>
      <div className="page-actions">
        {props.actions}
        <button className="icon-btn" onClick={refresh} title="Refresh: reload data and recompute" aria-label="Refresh">
          <svg {...ic} style={spin ? { animation: 'spin .8s linear infinite' } : undefined}>
            <path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" />
          </svg>
          Refresh
        </button>
      </div>
    </div>
  )
}

/** Collapsible dashboard row, like a Grafana row panel. */
export function DashRow(props: { title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true)
  return (
    <section className="dash-row">
      <button className="dash-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg {...ic}><path d="M6 9l6 6 6-6" /></svg>
        {props.title}
        {props.count != null && <span className="count">({props.count} panels)</span>}
      </button>
      {open && <div className="grid">{props.children}</div>}
    </section>
  )
}

export function Grid(props: { children: ReactNode }) {
  return <div className="grid">{props.children}</div>
}

export function SectionHeader(props: { title: string; sub?: ReactNode }) {
  return (
    <div className="section-head">
      <h2 className="section-title">{props.title}</h2>
      {props.sub != null && <span className="section-sub">{props.sub}</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

/** (i) icon whose popover holds the panel description. */
export function Info(props: { children: ReactNode }) {
  return (
    <span className="info" tabIndex={0} aria-label="Panel description">
      <svg {...ic}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
      <span className="tip" role="tooltip">{props.children}</span>
    </span>
  )
}

export function Panel(props: {
  title?: string
  info?: ReactNode
  right?: ReactNode
  tools?: ReactNode
  w?: Span
  h?: number
  flush?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const style: CSSProperties = { ...(props.h ? { minHeight: props.h } : {}), ...props.style }
  return (
    <section className={`panel${props.w ? ` w-${props.w}` : ''} ${props.className ?? ''}`} style={style}>
      {(props.title || props.tools || props.right) && (
        <div className="panel-header">
          {props.title && <div className="panel-title">{props.title}</div>}
          {props.info != null && <Info>{props.info}</Info>}
          <div className="spacer" />
          {props.right}
          {props.tools && <div className="panel-tools">{props.tools}</div>}
        </div>
      )}
      <div className={`panel-body${props.flush ? ' flush' : ''}`}>{props.children}</div>
    </section>
  )
}

/** Description popover content: first line in full ink, the rest secondary. */
function describe(...parts: Array<ReactNode | undefined>): ReactNode | undefined {
  const xs = parts.filter((p) => p != null && p !== '')
  return xs.length ? xs.map((p, i) => <p key={i}>{p}</p>) : undefined
}

/** Plain panel (kept name: Card). Subtitle moves into the (i) description. */
export function Card(props: { title?: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; w?: Span }) {
  const flush = (props.className ?? '').includes('flush')
  return (
    <Panel title={props.title} info={describe(props.subtitle)} right={props.actions} flush={flush} w={props.w}>
      {props.children}
    </Panel>
  )
}

/* ------------------------------------------------------------------ */
/* Stat panels                                                         */
/* ------------------------------------------------------------------ */

/** Tiny area sparkline drawn behind a stat value. */
export function Sparkline(props: { values: Array<number | null>; color: string }) {
  const id = useId().replace(/:/g, '')
  const pts = props.values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null)
  if (pts.length < 2) return null
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const W = 100, H = 40
  const X = (x: number) => ((x - x0) / (x1 - x0 || 1)) * W
  const Y = (y: number) => H - 2 - ((y - y0) / (y1 - y0 || 1)) * (H - 4)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(2)},${Y(p[1]).toFixed(2)}`).join('')
  return (
    <div className="spark" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: props.color, stopOpacity: 0.32 }} />
            <stop offset="100%" style={{ stopColor: props.color, stopOpacity: 0.02 }} />
          </linearGradient>
        </defs>
        <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id})`} />
        <path d={line} fill="none" style={{ stroke: props.color }} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

/** Grafana stat panel: title, big value (coloured by tone), sub line, optional sparkline. */
export function Stat(props: {
  label: string; value: ReactNode; sub?: ReactNode; valueClass?: string; tone?: Tone; title?: string
  info?: ReactNode; spark?: Array<number | null>; sparkColor?: string; w?: Span; children?: ReactNode
}) {
  return (
    <section className={`panel stat-panel${props.spark ? ' has-spark' : ''}${props.tone ? ` tone-${props.tone}` : ''}${props.w ? ` w-${props.w}` : ''}`} title={props.title}>
      <div className="panel-header">
        <div className="panel-title">{props.label}</div>
        {props.info != null && <Info>{props.info}</Info>}
      </div>
      {props.spark && <Sparkline values={props.spark} color={props.sparkColor ?? 'var(--series-1)'} />}
      <div className="panel-body">
        <div className={`stat-value ${props.valueClass ?? ''}`}>{props.value}</div>
        {props.sub != null && <div className="stat-sub">{props.sub}</div>}
        {props.children}
      </div>
    </section>
  )
}

/** A row of stat panels that wraps to fit. */
export function StatStrip(props: { children: ReactNode; className?: string }) {
  return <div className={`stat-grid ${props.className ?? ''}`}>{props.children}</div>
}

/** Kept for older pages: same as a stat panel. */
export function StatTile(props: { label: string; value: ReactNode; note?: ReactNode; valueClass?: string; tone?: Tone }) {
  return <Stat label={props.label} value={props.value} sub={props.note} valueClass={props.valueClass} tone={props.tone} />
}

/* ------------------------------------------------------------------ */
/* Gauges                                                              */
/* ------------------------------------------------------------------ */

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const
}
const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1)
  return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}`
}

/**
 * Grafana-style gauge: a 240° arc filled to the value, coloured by the threshold band it sits in,
 * with the threshold bands drawn as a thin outer ring.
 */
export function Gauge(props: {
  value: number | null; min: number; max: number; text: string
  bands: Array<{ to: number; color: string }>; scale?: [string, string]; note?: ReactNode
}) {
  const { min, max } = props
  const START = -120, END = 120
  const ang = (v: number) => START + ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * (END - START)
  const color = props.value == null ? 'var(--text-muted)' : (props.bands.find((b) => props.value! <= b.to) ?? props.bands[props.bands.length - 1]).color
  const starts = props.bands.map((_, i) => (i === 0 ? min : props.bands[i - 1].to))
  return (
    <div className="gauge">
      <svg viewBox="0 0 200 128" role="img" aria-label={props.text}>
        {props.bands.map((b, i) => {
          const a0 = ang(starts[i]), a1 = ang(Math.min(b.to, max))
          return a1 > a0 ? <path key={i} d={arc(100, 100, 93, a0 + 1, a1 - 1)} style={{ stroke: b.color, opacity: 0.75 }} strokeWidth={3} strokeLinecap="round" fill="none" /> : null
        })}
        <path d={arc(100, 100, 76, START, END)} style={{ stroke: 'var(--hover)' }} strokeWidth={14} strokeLinecap="round" fill="none" />
        {props.value != null && <path d={arc(100, 100, 76, START, Math.max(START + 0.5, ang(props.value)))} style={{ stroke: color, filter: `drop-shadow(0 0 6px ${color})` }} strokeWidth={14} strokeLinecap="round" fill="none" />}
        <text x="100" y="108" textAnchor="middle" className="gauge-value" style={{ fontSize: 28, fill: color }}>{props.text}</text>
      </svg>
      {props.scale && <div className="gauge-scale"><span>{props.scale[0]}</span><span>{props.scale[1]}</span></div>}
      {props.note != null && <div className="gauge-note">{props.note}</div>}
    </div>
  )
}

/** Horizontal bar gauge rows (gradient mode), with an optional reference mark (e.g. 50%). */
export function BarGauge(props: {
  rows: Array<{ label: ReactNode; value: number | null; text: string; color: string }>
  min: number; max: number; mark?: number
}) {
  const pos = (v: number) => `${((Math.min(props.max, Math.max(props.min, v)) - props.min) / (props.max - props.min)) * 100}%`
  return (
    <div className="bargauge">
      {props.rows.map((r, i) => (
        <div className="bg-row" key={i}>
          <div className="bg-label">{r.label}</div>
          <div className="bg-track">
            {r.value != null && (
              <div className="bg-fill" style={{ width: pos(r.value), background: `linear-gradient(90deg, color-mix(in srgb, ${r.color} 30%, transparent), ${r.color})`, boxShadow: `0 0 12px -2px ${r.color}` }} />
            )}
            {props.mark != null && <div className="bg-mark" style={{ left: pos(props.mark) }} />}
          </div>
          <div className="bg-value" style={{ color: r.color }}>{r.text}</div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tables, charts, legend                                              */
/* ------------------------------------------------------------------ */

export interface Column<R> {
  label: string
  value: (row: R) => ReactNode
  align?: 'left' | 'right' | 'center'
}

export function DataTable<R>(props: {
  columns: Column<R>[]; rows: R[]; rowClass?: (row: R) => string | undefined; maxHeight?: number; bare?: boolean
}) {
  if (!props.rows.length) return <EmptyState title="No data" detail="Nothing to show for this selection." />
  const cls = (c: Column<R>) => (c.align === 'center' ? 'center' : undefined)
  const style = (c: Column<R>) => (c.align === 'left' ? { textAlign: 'left' as const } : undefined)
  return (
    <div className="table-wrap" style={props.maxHeight ? { maxHeight: props.maxHeight } : undefined}>
      <table>
        <thead>
          <tr>{props.columns.map((c) => <th key={c.label} className={cls(c)} style={style(c)}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {props.rows.map((r, i) => (
            <tr key={i} className={props.rowClass?.(r)}>
              {props.columns.map((c) => <td key={c.label} className={cls(c)} style={style(c)}>{c.value(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Time-series / chart panel with a table-view twin, so every value stays reachable without hovering.
 * Subtitle and note go into the (i) description; the latest value sits in the header.
 */
export function ChartCard<R>(props: {
  title: string
  subtitle?: string
  value?: ReactNode
  change?: ReactNode
  note?: ReactNode
  legend?: ReactNode
  actions?: ReactNode
  table: { columns: Column<R>[]; rows: R[] }
  w?: Span
  children: ReactNode
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  return (
    <Panel
      title={props.title} w={props.w}
      info={describe(props.subtitle, props.note)}
      right={props.value != null ? <span className="panel-last"><b>{props.value}</b>{props.change}</span> : undefined}
      tools={
        <>
          {props.actions}
          <button className="tool" aria-pressed={view === 'chart'} onClick={() => setView('chart')} title="Chart" aria-label="Chart view">
            <svg {...ic}><path d="M3 17l5-6 4 4 8-9" /></svg>
          </button>
          <button className="tool" aria-pressed={view === 'table'} onClick={() => setView('table')} title="Table" aria-label="Table view">
            <svg {...ic}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16" /></svg>
          </button>
        </>
      }
      flush={view === 'table'}>
      {view === 'chart' ? (
        <>
          {props.children}
          {props.legend}
        </>
      ) : (
        <DataTable columns={props.table.columns} rows={props.table.rows} maxHeight={300} />
      )}
    </Panel>
  )
}

export function Legend(props: { items: Array<{ label: string; color: string; shape?: 'line' | 'rect' }> }) {
  return (
    <div className="legend">
      {props.items.map((it) => (
        <span key={it.label} className="legend-key">
          <span className={it.shape === 'rect' ? 'swatch-rect' : 'swatch-line'} style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  )
}

export function StatusBadge(props: { kind: Tone; label: string }) {
  return (
    <span className={`status ${props.kind}`}>
      <span className="status-dot" aria-hidden="true" />
      {props.label}
    </span>
  )
}

/** Signed change with an arrow, coloured by direction. */
export function Change(props: { value: number | null | undefined; text: string; pill?: boolean }) {
  const v = props.value
  const cls = v == null || v === 0 ? 'neutral' : v > 0 ? 'up' : 'down'
  const arrow = v == null || v === 0 ? '' : v > 0 ? '▲ ' : '▼ '
  return <span className={`${props.pill ? 'pill ' : ''}${cls}`}>{arrow}{props.text}</span>
}

export function EmptyState(props: { title: string; detail?: ReactNode }) {
  return (
    <div className="state-box">
      <div className="state-title">{props.title}</div>
      {props.detail != null && <div className="state-detail">{props.detail}</div>}
    </div>
  )
}

export function QueryState(props: { error: unknown; isLoading: boolean; children: ReactNode }) {
  if (props.error) {
    const msg = props.error instanceof ApiError ? props.error.message : String(props.error)
    return (
      <div className="state-box error" role="alert">
        <div className="state-title">Could not load data</div>
        <div className="state-detail">{msg}</div>
      </div>
    )
  }
  if (props.isLoading) {
    return (
      <div className="state-box" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <div className="state-detail">Loading…</div>
      </div>
    )
  }
  return <>{props.children}</>
}
