import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, type ChainRow, type OptionChain } from '../api'
import { ChartTooltip } from '../components/charts'
import { ChartCard, Legend, QueryState, StatTile, type Column } from '../components/ui'
import { compact, date, num, pct } from '../format'
import { useChartColors } from '../theme'

const WINDOWS = [10, 20, 40, 0] as const // strikes each side of spot; 0 = all

interface View {
  strike: number
  ce_oi: number | null
  pe_oi: number | null
  ce_chg: number | null
  pe_chg: number | null
  row: ChainRow
}

function toContracts(units: number | null, lot: number | null): number | null {
  return units == null || !lot ? units : units / lot
}

export function ChainPage() {
  const daily = useQuery({ queryKey: ['daily'], queryFn: api.daily })
  const latest = daily.data?.[daily.data.length - 1]?.trade_date
  const [pickedDate, setPickedDate] = useState<string>()
  const [expiry, setExpiry] = useState<string>()
  const [window, setWindow] = useState<number>(20)
  const tradeDate = pickedDate ?? latest

  const q = useQuery({
    queryKey: ['chain', tradeDate, expiry],
    queryFn: () => api.chain(tradeDate!, expiry),
    enabled: !!tradeDate,
    placeholderData: (prev) => prev,
  })

  return (
    <>
      <h1 className="page-title">Option chain (end of day)</h1>
      <p className="page-sub">Nifty options for one trading day and expiry, from the NSE F&amp;O bhavcopy. OI and volume in contracts.</p>
      <div className="filters">
        <label>Date
          <input type="date" value={tradeDate ?? ''} max={latest}
                 onChange={(e) => { setPickedDate(e.target.value || undefined); setExpiry(undefined) }} />
        </label>
        <label>Expiry
          <select value={q.data?.expiry ?? ''} onChange={(e) => setExpiry(e.target.value)} disabled={!q.data}>
            {(q.data?.expiries ?? []).map((x) => <option key={x} value={x}>{date(x)}</option>)}
          </select>
        </label>
        <label>Strikes
          <div className="seg" role="group" aria-label="Strike window">
            {WINDOWS.map((w) => (
              <button key={w} aria-pressed={window === w} onClick={() => setWindow(w)}>{w === 0 ? 'All' : `±${w}`}</button>
            ))}
          </div>
        </label>
      </div>
      <QueryState error={q.error ?? daily.error} isLoading={q.isLoading || daily.isLoading}>
        {q.data && <ChainView chain={q.data} window={window} fetching={q.isFetching} />}
      </QueryState>
    </>
  )
}

function ChainView(props: { chain: OptionChain; window: number; fetching: boolean }) {
  const c = useChartColors()
  const { chain } = props
  const lot = chain.lot_size
  const spot = chain.spot_close
  const all: View[] = chain.rows.map((r) => ({
    strike: r.strike,
    ce_oi: toContracts(r.ce_oi_units, lot), pe_oi: toContracts(r.pe_oi_units, lot),
    ce_chg: toContracts(r.ce_oi_change_units, lot), pe_chg: toContracts(r.pe_oi_change_units, lot),
    row: r,
  }))
  const atmIdx = spot == null ? -1 : all.reduce((best, v, i) =>
    Math.abs(v.strike - spot) < Math.abs(all[best].strike - spot) ? i : best, 0)
  const atm = atmIdx >= 0 ? all[atmIdx].strike : undefined
  const rows = props.window && atmIdx >= 0
    ? all.slice(Math.max(0, atmIdx - props.window), atmIdx + props.window + 1)
    : all

  const ceTotal = all.reduce((s, v) => s + (v.ce_oi ?? 0), 0)
  const peTotal = all.reduce((s, v) => s + (v.pe_oi ?? 0), 0)
  const maxBy = (k: 'ce_oi' | 'pe_oi') => all.reduce<View | undefined>((m, v) => (v[k] ?? 0) > (m?.[k] ?? 0) ? v : m, undefined)

  const legend = <Legend items={[
    { label: 'Calls (CE)', color: c.series[0], shape: 'rect' },
    { label: 'Puts (PE)', color: c.series[1], shape: 'rect' },
  ]} />

  const bars = (ceKey: 'ce_oi' | 'ce_chg', peKey: 'pe_oi' | 'pe_chg') => (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={rows} barGap={2} barCategoryGap="20%" margin={{ top: 16, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={c.grid} vertical={false} />
        <XAxis dataKey="strike" stroke={c.axis} tickLine={false} minTickGap={24}
               tick={{ fill: c.muted, fontSize: 11 }} tickFormatter={(v: number) => num(v)} />
        <YAxis width={64} axisLine={false} tickLine={false} tick={{ fill: c.muted, fontSize: 11 }}
               tickFormatter={(v: number) => compact(v)} />
        <ReferenceLine y={0} stroke={c.axis} />
        {atm != null && (
          <ReferenceLine x={atm} stroke={c.textSecondary}
                         label={{ value: `Spot ${num(spot, 2)}`, position: 'top', fill: c.textSecondary, fontSize: 11 }} />
        )}
        <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} isAnimationActive={false}
                 content={(p) => <ChartTooltip {...p} format={(v) => num(v)} labelFormat={(s) => `Strike ${num(Number(s))}`} />} />
        <Bar dataKey={ceKey} name="Calls (CE)" fill={c.series[0]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        <Bar dataKey={peKey} name="Puts (PE)" fill={c.series[1]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )

  const columns: Column<View>[] = [
    { label: 'CE OI', value: (v) => num(v.ce_oi) },
    { label: 'CE OI chg', value: (v) => num(v.ce_chg) },
    { label: 'CE volume', value: (v) => num(v.row.ce_volume_contracts) },
    { label: 'CE Δ', value: (v) => num(v.row.ce_delta, 2) },
    { label: 'CE IV', value: (v) => pct(v.row.ce_iv_pct, 1) },
    { label: 'CE close', value: (v) => num(v.row.ce_close, 2) },
    { label: 'Strike', value: (v) => num(v.strike), align: 'center' },
    { label: 'PE close', value: (v) => num(v.row.pe_close, 2) },
    { label: 'PE IV', value: (v) => pct(v.row.pe_iv_pct, 1) },
    { label: 'PE Δ', value: (v) => num(v.row.pe_delta, 2) },
    { label: 'PE volume', value: (v) => num(v.row.pe_volume_contracts) },
    { label: 'PE OI chg', value: (v) => num(v.pe_chg) },
    { label: 'PE OI', value: (v) => num(v.pe_oi) },
  ]

  // Smile: OTM side only (puts below the forward, calls at/above), liquid strikes only: at least 0.5%
  // of the busiest strike's volume on that side (min 10 contracts). Thinly traded strikes can carry a
  // closing price from hours earlier; same rule as the daily IV summary (greeks.liquid_mask).
  const fwd = chain.forward ?? spot
  const busiest = (k: 'ce_volume_contracts' | 'pe_volume_contracts') => Math.max(0, ...chain.rows.map((r) => r[k] ?? 0))
  const ceMin = Math.max(10, 0.005 * busiest('ce_volume_contracts'))
  const peMin = Math.max(10, 0.005 * busiest('pe_volume_contracts'))
  const smile = rows.map((v) => ({
    strike: v.strike,
    ce: fwd != null && v.strike >= fwd && (v.row.ce_volume_contracts ?? 0) >= ceMin ? v.row.ce_iv_pct : null,
    pe: fwd != null && v.strike < fwd && (v.row.pe_volume_contracts ?? 0) >= peMin ? v.row.pe_iv_pct : null,
  }))
  const smilePts = smile.filter((s) => s.ce != null || s.pe != null)
  const atmIv = (() => {
    if (fwd == null) return null
    const pts = smilePts.map((s) => ({ k: s.strike, iv: (s.ce ?? s.pe) as number }))
    const i = pts.findIndex((p) => p.k >= fwd)
    if (i <= 0) return null
    const a = pts[i - 1], b = pts[i]
    return a.iv + (b.iv - a.iv) * (fwd - a.k) / (b.k - a.k)
  })()
  const smileCols: Column<View>[] = [
    { label: 'Strike', value: (v) => num(v.strike), align: 'left' },
    { label: 'Call IV', value: (v) => pct(v.row.ce_iv_pct, 2) },
    { label: 'Put IV', value: (v) => pct(v.row.pe_iv_pct, 2) },
    { label: 'Call Δ', value: (v) => num(v.row.ce_delta, 3) },
    { label: 'Put Δ', value: (v) => num(v.row.pe_delta, 3) },
    { label: 'Gamma', value: (v) => num(v.row.ce_gamma ?? v.row.pe_gamma, 5) },
    { label: 'Call θ / day', value: (v) => num(v.row.ce_theta, 2) },
    { label: 'Put θ / day', value: (v) => num(v.row.pe_theta, 2) },
    { label: 'Vega / vol pt', value: (v) => num(v.row.ce_vega ?? v.row.pe_vega, 2) },
  ]

  return (
    <div className={props.fetching ? 'loading-frame' : undefined}>
      <div className="tiles">
        <StatTile label="Nifty spot close" value={num(spot, 2)} note={date(chain.trade_date)} />
        <StatTile label="India VIX" value={num(chain.vix_close, 2)} />
        <StatTile label="PCR (OI), this expiry" value={ceTotal ? num(peTotal / ceTotal, 2) : '—'} />
        <StatTile label="Max put OI strike" value={num(maxBy('pe_oi')?.strike)} note={`${num(maxBy('pe_oi')?.pe_oi ?? null)} contracts`} />
        <StatTile label="Max call OI strike" value={num(maxBy('ce_oi')?.strike)} note={`${num(maxBy('ce_oi')?.ce_oi ?? null)} contracts`} />
        <StatTile label="Lot size" value={num(lot)} note={`Expiry ${date(chain.expiry)}`} />
        <StatTile label="Forward, this expiry" value={num(chain.forward, 2)} note="From put-call parity" />
        <StatTile label="ATM IV, this expiry" value={pct(atmIv, 1)} note="Interpolated at the forward" />
      </div>
      <div className="stack">
        <ChartCard title="Implied volatility smile" subtitle="% a year, out-of-the-money side of each strike; liquid strikes only"
                   note="Puts below the forward, calls above. A steeper left side means downside protection is priced higher."
                   legend={<Legend items={[{ label: 'Put IV (below forward)', color: c.series[1] }, { label: 'Call IV (above forward)', color: c.series[0] }]} />}
                   table={{ columns: smileCols, rows }}>
          {smilePts.length ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={smile} margin={{ top: 16, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="strike" stroke={c.axis} tickLine={false} minTickGap={24}
                       tick={{ fill: c.muted, fontSize: 11 }} tickFormatter={(v: number) => num(v)} />
                <YAxis width={64} axisLine={false} tickLine={false} domain={['auto', 'auto']}
                       tick={{ fill: c.muted, fontSize: 11 }} tickFormatter={(v: number) => pct(v, 0)} />
                {atm != null && (
                  <ReferenceLine x={atm} stroke={c.textSecondary}
                                 label={{ value: `Forward ${num(fwd, 0)}`, position: 'top', fill: c.textSecondary, fontSize: 11 }} />
                )}
                <Tooltip cursor={{ stroke: c.axis, strokeWidth: 1 }} isAnimationActive={false}
                         content={(p) => <ChartTooltip {...p} format={(v) => pct(v, 2)} labelFormat={(s) => `Strike ${num(Number(s))}`} />} />
                <Line dataKey="pe" name="Put IV" stroke={c.series[1]} strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
                <Line dataKey="ce" name="Call IV" stroke={c.series[0]} strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : <div className="message">No IV for this date: IV is computed for options that traded, before expiry day.</div>}
        </ChartCard>
        <ChartCard title="Open interest by strike" subtitle="Contracts outstanding at the close" legend={legend}
                   table={{ columns, rows }}>
          {bars('ce_oi', 'pe_oi')}
        </ChartCard>
        <ChartCard title="Change in open interest by strike" subtitle="Contracts added (+) or closed (−) today" legend={legend}
                   table={{ columns, rows }}>
          {bars('ce_chg', 'pe_chg')}
        </ChartCard>
        <section className="card">
          <div className="card-head"><div className="card-title">Chain</div></div>
          <ChainTable columns={columns} rows={rows} atm={atm} />
        </section>
      </div>
    </div>
  )
}

function ChainTable(props: { columns: Column<View>[]; rows: View[]; atm?: number }) {
  return (
    <div className="table-wrap" style={{ maxHeight: 560 }}>
      <table>
        <thead>
          <tr>{props.columns.map((c) => <th key={c.label} className={c.align === 'center' ? 'center' : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.strike} className={r.strike === props.atm ? 'highlight' : undefined}>
              {props.columns.map((c) => <td key={c.label} className={c.align === 'center' ? 'center' : undefined}>{c.value(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
