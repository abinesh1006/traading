import { createContext, useContext, useState, type ReactNode } from 'react'

export const RANGES = ['1M', '3M', '6M', '1Y', '3Y', '5Y', 'All'] as const
export type Range = (typeof RANGES)[number]

const MONTHS: Record<Exclude<Range, 'All'>, number> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, '5Y': 60 }
const KEY = 'niftyquant.range'

const Ctx = createContext<{ range: Range; setRange: (r: Range) => void } | null>(null)

function initial(): Range {
  try {
    const v = localStorage.getItem(KEY)
    return (RANGES as readonly string[]).includes(v ?? '') ? (v as Range) : '1Y'
  } catch {
    return '1Y'
  }
}

export function RangeProvider(props: { children: ReactNode }) {
  const [range, set] = useState<Range>(initial)
  const setRange = (r: Range) => {
    set(r)
    try {
      localStorage.setItem(KEY, r)
    } catch {
      // per-viewer convenience only
    }
  }
  return <Ctx.Provider value={{ range, setRange }}>{props.children}</Ctx.Provider>
}

export function useRange() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useRange outside RangeProvider')
  return v
}

/** Start date for a range, counted back from the latest date in the data (not today). */
export function rangeStart(latestIso: string, range: Range): string | null {
  if (range === 'All') return null
  const [y, m, d] = latestIso.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1 - MONTHS[range], d))
  return start.toISOString().slice(0, 10)
}

export function filterRange<R extends { trade_date: string }>(rows: R[], range: Range): R[] {
  if (!rows.length) return rows
  const start = rangeStart(rows[rows.length - 1].trade_date, range)
  return start ? rows.filter((r) => r.trade_date >= start) : rows
}

export function RangeFilter() {
  const { range, setRange } = useRange()
  return (
    <div className="seg" role="group" aria-label="Date range">
      {RANGES.map((r) => (
        <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>
      ))}
    </div>
  )
}
