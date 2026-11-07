import { useState, type ReactNode } from 'react'
import { ApiError } from '../api'

export function StatTile(props: { label: string; value: ReactNode; note?: ReactNode; valueClass?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{props.label}</div>
      <div className={`tile-value ${props.valueClass ?? ''}`}>{props.value}</div>
      {props.note != null && <div className="tile-note">{props.note}</div>}
    </div>
  )
}

export interface Column<R> {
  label: string
  value: (row: R) => ReactNode
  align?: 'left' | 'right' | 'center'
}

export function DataTable<R>(props: { columns: Column<R>[]; rows: R[]; rowClass?: (row: R) => string | undefined }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th key={c.label} className={c.align === 'center' ? 'center' : undefined}
                  style={c.align === 'left' ? { textAlign: 'left' } : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r, i) => (
            <tr key={i} className={props.rowClass?.(r)}>
              {props.columns.map((c) => (
                <td key={c.label} className={c.align === 'center' ? 'center' : undefined}
                    style={c.align === 'left' ? { textAlign: 'left' } : undefined}>
                  {c.value(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A chart with its table-view twin: every value stays reachable without hovering. */
export function ChartCard<R>(props: {
  title: string
  subtitle?: string
  note?: ReactNode
  legend?: ReactNode
  table: { columns: Column<R>[]; rows: R[] }
  children: ReactNode
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{props.title}</div>
          {props.subtitle && <div className="card-sub">{props.subtitle}</div>}
        </div>
        <div className="seg" role="group" aria-label={`${props.title} view`}>
          <button aria-pressed={view === 'chart'} onClick={() => setView('chart')}>Chart</button>
          <button aria-pressed={view === 'table'} onClick={() => setView('table')}>Table</button>
        </div>
      </div>
      {view === 'chart' ? (
        <>
          {props.legend}
          {props.children}
        </>
      ) : (
        <DataTable columns={props.table.columns} rows={props.table.rows} />
      )}
      {props.note && <div className="card-note">{props.note}</div>}
    </section>
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

export function StatusBadge(props: { kind: 'good' | 'warning' | 'critical'; label: string }) {
  return (
    <span className={`status ${props.kind}`}>
      <span className="status-dot" aria-hidden="true" />
      {props.label}
    </span>
  )
}

export function QueryState(props: { error: unknown; isLoading: boolean; children: ReactNode }) {
  if (props.error) {
    const msg = props.error instanceof ApiError ? props.error.message : String(props.error)
    return <div className="message error" role="alert">Could not load data: {msg}</div>
  }
  if (props.isLoading) return <div className="message">Loading…</div>
  return <>{props.children}</>
}
