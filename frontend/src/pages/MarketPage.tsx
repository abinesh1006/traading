import { useQuery } from '@tanstack/react-query'
import { api, type DailyMarket, type IvDaily } from '../api'
import { TimeSeriesChart } from '../components/charts'
import { ChartCard, Legend, QueryState, StatTile, type Column } from '../components/ui'
import { date, num, pct, signClass } from '../format'
import { filterRange, RangeFilter, useRange } from '../range'
import { useChartColors } from '../theme'

type Metric = {
  title: string
  subtitle: string
  value: (r: DailyMarket) => number | null
  format: (v: number) => string
  axisFormat?: (v: number) => string
  referenceY?: { y: number; label?: string }
  note?: string
}

const METRICS: Metric[] = [
  { title: 'Nifty 50', subtitle: 'Daily close', value: (r) => r.spot_close, format: (v) => num(v, 2), axisFormat: (v) => num(v) },
  { title: 'India VIX', subtitle: 'Daily close', value: (r) => r.vix_close, format: (v) => num(v, 2) },
  {
    title: 'Put-call ratio (OI), nearest expiry', subtitle: 'Put OI ÷ call OI',
    value: (r) => r.near_pcr_oi, format: (v) => num(v, 2), referenceY: { y: 1 },
    note: 'Above 1: more put open interest than call open interest on the nearest expiry.',
  },
  {
    title: 'ATM straddle, nearest expiry', subtitle: '% of spot: the move the market prices in by expiry',
    value: (r) => r.atm_straddle_pct, format: (v) => pct(v, 2),
    note: 'Resets each expiry, so it saw-tooths: read it together with days to expiry.',
  },
  {
    title: 'Futures basis, near month', subtitle: 'Futures close vs spot close, %',
    value: (r) => r.basis_pct, format: (v) => pct(v, 2), referenceY: { y: 0 },
  },
]

export function MarketPage() {
  const q = useQuery({ queryKey: ['daily'], queryFn: api.daily })
  const { range } = useRange()
  const c = useChartColors()
  const rows = filterRange(q.data ?? [], range)
  const last = q.data?.[q.data.length - 1]

  return (
    <>
      <h1 className="page-title">Market overview</h1>
      <p className="page-sub">End-of-day Nifty state from NSE files. Latest trading day: {date(last?.trade_date)}</p>
      <div className="filters">
        <RangeFilter />
      </div>
      <QueryState error={q.error} isLoading={q.isLoading}>
        {last && (
          <div className="tiles">
            <StatTile label="Nifty 50" value={num(last.spot_close, 2)}
                      note={<span className={signClass(last.spot_return_pct)}>{pct(last.spot_return_pct, 2, true)} on the day</span>} />
            <StatTile label="India VIX" value={num(last.vix_close, 2)} />
            <StatTile label="PCR (OI), nearest expiry" value={num(last.near_pcr_oi, 2)}
                      note={`Expiry ${date(last.near_expiry)}`} />
            <StatTile label="ATM straddle" value={pct(last.atm_straddle_pct, 2)}
                      note={`${num(last.atm_straddle, 1)} pts · ${last.days_to_expiry ?? '—'} days to expiry`} />
            <StatTile label="Max put OI strike" value={num(last.max_pe_oi_strike)} note="Nearest expiry" />
            <StatTile label="Max call OI strike" value={num(last.max_ce_oi_strike)} note="Nearest expiry" />
            <StatTile label="Futures basis" value={pct(last.basis_pct, 2, true)}
                      note={`Near month, expiry ${date(last.fut_expiry)}`} />
          </div>
        )}
        <div className={`grid-2 ${q.isFetching ? 'loading-frame' : ''}`}>
          {METRICS.map((m) => {
            const columns: Column<DailyMarket>[] = [
              { label: 'Date', value: (r) => date(r.trade_date), align: 'left' },
              { label: m.title, value: (r) => { const v = m.value(r); return v == null ? '—' : m.format(v) } },
            ]
            return (
              <ChartCard key={m.title} title={m.title} subtitle={m.subtitle} note={m.note}
                         table={{ columns, rows: [...rows].reverse() }}>
                <TimeSeriesChart
                  rows={rows} syncId="market" format={m.format} axisFormat={m.axisFormat}
                  referenceY={m.referenceY}
                  series={[{ key: 'v', label: m.title, color: c.series[0], value: m.value }]}
                />
              </ChartCard>
            )
          })}
        </div>
      </QueryState>
      <VolatilitySection />
    </>
  )
}

/** Implied vs realised volatility and skew, from IV computed on every option's close. */
function VolatilitySection() {
  const q = useQuery({ queryKey: ['iv'], queryFn: api.iv })
  const { range } = useRange()
  const c = useChartColors()
  const rows = filterRange(q.data ?? [], range)
  const last = q.data?.[q.data.length - 1]
  const volSeries = [
    { key: 'iv', label: 'ATM IV 30d', color: c.series[0], value: (r: IvDaily) => r.iv_30d },
    { key: 'vix', label: 'India VIX', color: c.series[1], value: (r: IvDaily) => r.vix_close },
    { key: 'rv', label: 'Realised 20d', color: c.series[2], value: (r: IvDaily) => r.rv_20d },
  ]
  const fmt = (v: number) => pct(v, 1)
  const volCols: Column<IvDaily>[] = [
    { label: 'Date', value: (r) => date(r.trade_date), align: 'left' },
    ...volSeries.map((s) => ({ label: s.label, value: (r: IvDaily) => { const v = s.value(r); return v == null ? '—' : fmt(v) } })),
  ]
  const skewCols: Column<IvDaily>[] = [
    { label: 'Date', value: (r) => date(r.trade_date), align: 'left' },
    { label: 'Expiry', value: (r) => date(r.skew_expiry) },
    { label: '25Δ put IV', value: (r) => pct(r.iv_25d_put, 1) },
    { label: 'ATM IV', value: (r) => pct(r.skew_atm_iv, 1) },
    { label: '25Δ call IV', value: (r) => pct(r.iv_25d_call, 1) },
    { label: 'Risk reversal', value: (r) => num(r.rr_25d, 2) },
  ]
  return (
    <>
      <h2 className="section-title">Volatility</h2>
      <QueryState error={q.error} isLoading={q.isLoading}>
        {last && (
          <div className="tiles">
            <StatTile label="ATM IV, 30-day" value={pct(last.iv_30d, 1)} note={`India VIX ${num(last.vix_close, 2)}`} />
            <StatTile label="ATM IV, nearest expiry" value={pct(last.near_atm_iv, 1)} note={`Expiry ${date(last.near_expiry)}`} />
            <StatTile label="Realised vol, 20 sessions" value={pct(last.rv_20d, 1)}
                      note={last.iv_30d != null && last.rv_20d != null ? `IV − RV ${num(last.iv_30d - last.rv_20d, 1)} pts` : undefined} />
            <StatTile label="Skew, 25Δ risk reversal" value={num(last.rr_25d, 2)}
                      note={`Put IV − call IV, expiry ${date(last.skew_expiry)}`} />
          </div>
        )}
        <div className={`grid-2 ${q.isFetching ? 'loading-frame' : ''}`}>
          <ChartCard title="Implied vs realised volatility" subtitle="% a year"
                     note="ATM IV from monthly expiries, interpolated to 30 days. VIX sits a little higher: it also prices the skew."
                     legend={<Legend items={volSeries.map((s) => ({ label: s.label, color: s.color }))} />}
                     table={{ columns: volCols, rows: [...rows].reverse() }}>
            <TimeSeriesChart rows={rows} syncId="market" format={fmt} series={volSeries} />
          </ChartCard>
          <ChartCard title="Skew: 25-delta risk reversal" subtitle="Put IV minus call IV, vol points"
                     note="Above 0: downside protection costs more than upside calls, the usual state for Nifty."
                     table={{ columns: skewCols, rows: [...rows].reverse() }}>
            <TimeSeriesChart rows={rows} syncId="market" format={(v) => num(v, 2)} referenceY={{ y: 0 }}
                             series={[{ key: 'rr', label: 'Risk reversal', color: c.series[0], value: (r: IvDaily) => r.rr_25d }]} />
          </ChartCard>
        </div>
      </QueryState>
    </>
  )
}
