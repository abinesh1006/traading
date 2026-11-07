import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

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

export const RANGE_LABEL: Record<Range, string> = {
  '1M': 'Last 1 month', '3M': 'Last 3 months', '6M': 'Last 6 months', '1Y': 'Last 1 year',
  '3Y': 'Last 3 years', '5Y': 'Last 5 years', All: 'All data (since 2015)',
}

/** Grafana-style time picker: a button showing the range, opening a list of quick ranges. */
export function RangeFilter() {
  const { range, setRange } = useRange()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  const svg = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  return (
    <div className="timepicker" ref={ref}>
      <button className="icon-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Time range">
        <svg {...svg}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        {RANGE_LABEL[range]}
        <svg {...svg} className="chev"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="timepicker-menu" role="menu">
          <div className="head">Quick ranges (to the latest session)</div>
          {RANGES.map((r) => (
            <button key={r} role="menuitemradio" aria-checked={range === r} onClick={() => { setRange(r); setOpen(false) }}>
              {RANGE_LABEL[r]}{range === r && <span>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
