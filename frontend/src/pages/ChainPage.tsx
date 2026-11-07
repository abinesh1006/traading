import { useQuery } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, type ChainRow, type OptionChain } from '../api'
import { ChartTooltip } from '../components/charts'
import { ChartCard, DashRow, EmptyState, Legend, PageHeader, Panel, QueryState, Stat, type Column } from '../components/ui'
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

  const controls = (
    <div className="filters">
      <label className="field"><span className="lbl">Date</span>
        <input type="date" value={tradeDate ?? ''} max={latest}
               onChange={(e) => { setPickedDate(e.target.value || undefined); setExpiry(undefined) }} />
      </label>
      <label className="field"><span className="lbl">Expiry</span>
        <select value={q.data?.expiry ?? ''} onChange={(e) => setExpiry(e.target.value)} disabled={!q.data}>
          {(q.data?.expiries ?? []).map((x) => <option key={x} value={x}>{date(x)}</option>)}
        </select>
      </label>
      <div className="field"><span className="lbl">Strikes</span>
        <div className="seg" role="group" aria-label="Strike window">
          {WINDOWS.map((w) => (
            <button key={w} aria-pressed={window === w} onClick={() => setWindow(w)}>{w === 0 ? 'All' : `±${w}`}</button>
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <>
      <PageHeader title="Option chain"
                  sub="Nifty options at the close, from the NSE F&O bhavcopy. OI and volume in contracts."
                  actions={controls} />
      <QueryState error={q.error ?? daily.error} isLoading={q.isLoading || daily.isLoading}>
        {q.data && (q.data.rows.length
          ? <ChainView chain={q.data} window={window} fetching={q.isFetching} />
          : <EmptyState title="No option chain for this date and expiry" detail="Pick another trading day." />)}
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
  const maxCe = maxBy('ce_oi')
  const maxPe = maxBy('pe_oi')

  // Max pain: the expiry price at which option holders' total payoff (writers' loss) is smallest.
  const maxPain = all.length ? all.reduce<{ k: number; pain: number } | null>((best, cand) => {
    const K = cand.strike
    const pain = all.reduce((s, v) =>
      s + (v.ce_oi ?? 0) * Math.max(0, K - v.strike) + (v.pe_oi ?? 0) * Math.max(0, v.strike - K), 0)
    return best == null || pain < best.pain ? { k: K, pain } : best
  }, null)?.k ?? null : null

  const legend = <Legend items={[
    { label: 'Calls (CE)', color: c.series[0], shape: 'rect' },
    { label: 'Puts (PE)', color: c.series[1], shape: 'rect' },
  ]} />

  const bars = (ceKey: 'ce_oi' | 'ce_chg', peKey: 'pe_oi' | 'pe_chg') => (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={rows} barGap={2} barCategoryGap="22%" margin={{ top: 18, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={c.grid} vertical={false} />
        <XAxis dataKey="strike" stroke={c.axis} tickLine={false} minTickGap={28} tickMargin={8}
               tick={{ fill: c.muted, fontSize: 11.5 }} tickFormatter={(v: number) => num(v)} />
        <YAxis width={56} axisLine={false} tickLine={false} tick={{ fill: c.muted, fontSize: 11.5 }}
               tickFormatter={(v: number) => compact(v)} />
        <ReferenceLine y={0} stroke={c.axis} />
        {atm != null && (
          <ReferenceLine x={atm} stroke={c.textSecondary} strokeDasharray="4 4"
                         label={{ value: `Spot ${num(spot, 2)}`, position: 'top', fill: c.textSecondary, fontSize: 11.5 }} />
        )}
        <Tooltip cursor={{ fill: c.grid, opacity: 0.6 }} isAnimationActive={false}
                 content={(p) => <ChartTooltip {...p} format={(v) => num(v)} labelFormat={(s) => `Strike ${num(Number(s))}`} />} />
        <Bar dataKey={ceKey} name="Calls (CE)" fill={c.series[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        <Bar dataKey={peKey} name="Puts (PE)" fill={c.series[1]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )

  const columns: Column<View>[] = [
    { label: 'CE OI', value: (v) => num(v.ce_oi) },
    { label: 'CE OI chg', value: (v) => num(v.ce_chg) },
    { label: 'CE volume', value: (v) => num(v.row.ce_volume_contracts) },
    { label: 'CE close', value: (v) => num(v.row.ce_close, 2) },
    { label: 'Strike', value: (v) => num(v.strike), align: 'center' },
    { label: 'PE close', value: (v) => num(v.row.pe_close, 2) },
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
  const dist = (k: number | null | undefined) => (k == null || spot == null ? '' : ` · ${pct(((k - spot) / spot) * 100, 1, true)}`)

  return (
    <div className={props.fetching ? 'loading-frame' : undefined}>
      <DashRow title="Summary">
        <Stat w={3} label="Spot close" value={num(spot, 2)} sub={date(chain.trade_date)} />
        <Stat w={3} label="Forward" value={num(chain.forward, 2)} sub="Put-call parity" />
        <Stat w={3} label="ATM IV" value={pct(atmIv, 1)} sub={`India VIX ${num(chain.vix_close, 2)}`} />
        <Stat w={3} label="PCR (OI)" value={ceTotal ? num(peTotal / ceTotal, 2) : '—'} sub="This expiry" />
        <Stat w={3} label="Max pain" value={num(maxPain)} sub={`Strike${dist(maxPain)}`} />
        <Stat w={3} label="Resistance" value={num(maxCe?.strike)} sub={`Call OI wall${dist(maxCe?.strike)}`} />
        <Stat w={3} label="Support" value={num(maxPe?.strike)} sub={`Put OI wall${dist(maxPe?.strike)}`} />
        <Stat w={3} label="Expiry" value={date(chain.expiry).slice(0, 6)} sub={`Lot size ${num(lot)}`} />
      </DashRow>

      <DashRow title={`Chain · expiry ${date(chain.expiry)}`}>
        <Panel w={24} flush title="Option chain"
               info="Calls left, puts right, strike in the middle. In-the-money cells are shaded; OI bars scale to the largest OI shown; the blue line marks spot.">
          <ChainTable rows={rows} atm={atm} spot={spot} />
        </Panel>
      </DashRow>
      <DashRow title="Open interest & volatility">
          <ChartCard w={12} title="Open interest by strike" subtitle="Contracts outstanding at the close" legend={legend}
                     table={{ columns, rows }}>
            {bars('ce_oi', 'pe_oi')}
          </ChartCard>
          <ChartCard w={12} title="Change in open interest" subtitle="Contracts added (+) or closed (−) today" legend={legend}
                     table={{ columns, rows }}>
            {bars('ce_chg', 'pe_chg')}
          </ChartCard>
        <ChartCard w={24} title="Implied volatility smile" subtitle="% a year · out-of-the-money side of each strike · liquid strikes only"
                   value={pct(atmIv, 1)} change={<span className="muted">ATM IV at the forward</span>}
                   note="Puts below the forward, calls above. A steeper left side means downside protection is priced higher."
                   legend={<Legend items={[{ label: 'Put IV (below forward)', color: c.series[1] }, { label: 'Call IV (above forward)', color: c.series[0] }]} />}
                   table={{ columns: smileCols, rows }}>
          {smilePts.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={smile} margin={{ top: 18, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="strike" stroke={c.axis} tickLine={false} minTickGap={28} tickMargin={8}
                       tick={{ fill: c.muted, fontSize: 11.5 }} tickFormatter={(v: number) => num(v)} />
                <YAxis width={52} axisLine={false} tickLine={false} domain={['auto', 'auto']}
                       tick={{ fill: c.muted, fontSize: 11.5 }} tickFormatter={(v: number) => pct(v, 0)} />
                {atm != null && (
                  <ReferenceLine x={atm} stroke={c.textSecondary} strokeDasharray="4 4"
                                 label={{ value: `Forward ${num(fwd, 0)}`, position: 'top', fill: c.textSecondary, fontSize: 11.5 }} />
                )}
                <Tooltip cursor={{ stroke: c.axis, strokeWidth: 1 }} isAnimationActive={false}
                         content={(p) => <ChartTooltip {...p} format={(v) => pct(v, 2)} labelFormat={(s) => `Strike ${num(Number(s))}`} />} />
                <Line dataKey="pe" name="Put IV" stroke={c.series[1]} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: c.series[1] }} connectNulls isAnimationActive={false} />
                <Line dataKey="ce" name="Call IV" stroke={c.series[0]} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: c.series[0] }} connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : <EmptyState title="No IV for this date" detail="IV is computed for options that traded, before expiry day." />}
        </ChartCard>
      </DashRow>
    </div>
  )
}

function BarCell(props: { v: number | null; max: number; side: 'ce' | 'pe'; text: string; itm: boolean }) {
  const w = props.v && props.max ? Math.min(100, (props.v / props.max) * 100) : 0
  return (
    <td className={`bar ${props.side}${props.itm ? ' itm' : ''}`} style={{ ['--w' as string]: `${w}%` }}>
      <span>{props.text}</span>
    </td>
  )
}

const chgClass = (v: number | null) => (v == null ? '' : v > 0 ? 'chg-up' : v < 0 ? 'chg-down' : '')
const signedNum = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${num(v)}`)

function ChainTable(props: { rows: View[]; atm?: number; spot: number | null }) {
  const { spot } = props
  const mx = (f: (v: View) => number | null) => Math.max(0, ...props.rows.map((r) => Math.abs(f(r) ?? 0)))
  const maxOi = Math.max(mx((v) => v.ce_oi), mx((v) => v.pe_oi))
  // Spot line goes above the first strike at or above spot.
  const spotBefore = spot == null ? -1 : props.rows.findIndex((v) => v.strike >= spot)
  return (
    <div className="table-wrap ladder">
      <table>
        <thead>
          <tr className="group">
            <th colSpan={6} style={{ textAlign: 'center' }}>CALLS</th>
            <th className="strike-h"> </th>
            <th colSpan={6} style={{ textAlign: 'center' }}>PUTS</th>
          </tr>
          <tr className="cols">
            <th>OI</th><th>OI chg</th><th>Volume</th><th>IV</th><th>Δ</th><th>LTP</th>
            <th className="strike-h">Strike</th>
            <th>LTP</th><th>Δ</th><th>IV</th><th>Volume</th><th>OI chg</th><th>OI</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((v, i) => {
            const r = v.row
            const isAtm = v.strike === props.atm
            const ceItm = spot != null && v.strike < spot
            const peItm = spot != null && v.strike > spot
            const ce = ceItm ? 'itm' : ''
            const pe = peItm ? 'itm' : ''
            return (
              <Fragment key={v.strike}>
                {i === spotBefore && spotBefore > 0 && (
                  <tr className="spot-row" aria-hidden="true">
                    <td colSpan={6} />
                    <td className="strike-spot" data-label={`Spot ${num(spot, 2)}`} />
                    <td colSpan={6} />
                  </tr>
                )}
                <tr className={isAtm ? 'atm' : undefined}>
                  <BarCell v={v.ce_oi} max={maxOi} side="ce" text={num(v.ce_oi)} itm={ceItm} />
                  <td className={`${ce} ${chgClass(v.ce_chg)}`}>{signedNum(v.ce_chg)}</td>
                  <td className={ce}>{num(r.ce_volume_contracts)}</td>
                  <td className={ce}>{pct(r.ce_iv_pct, 1)}</td>
                  <td className={ce}>{num(r.ce_delta, 2)}</td>
                  <td className={`ltp ${ce}`}>{num(r.ce_close, 2)}</td>
                  <td className="strike">{num(v.strike)}{isAtm && <small>ATM</small>}</td>
                  <td className={`ltp ${pe}`}>{num(r.pe_close, 2)}</td>
                  <td className={pe}>{num(r.pe_delta, 2)}</td>
                  <td className={pe}>{pct(r.pe_iv_pct, 1)}</td>
                  <td className={pe}>{num(r.pe_volume_contracts)}</td>
                  <td className={`${pe} ${chgClass(v.pe_chg)}`}>{signedNum(v.pe_chg)}</td>
                  <BarCell v={v.pe_oi} max={maxOi} side="pe" text={num(v.pe_oi)} itm={peItm} />
                </tr>
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
