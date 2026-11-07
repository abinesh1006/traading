import { useQuery } from '@tanstack/react-query'
import { api, type ClientType, type ParticipantPosition } from '../api'
import { TimeSeriesChart } from '../components/charts'
import { ChartCard, Legend, QueryState, StatTile, type Column } from '../components/ui'
import { date, num, pct } from '../format'
import { filterRange, RangeFilter, useRange } from '../range'
import { useChartColors } from '../theme'

// Color follows the entity: these slots never change with filtering.
const PARTICIPANTS: ClientType[] = ['FII', 'DII', 'Client', 'Pro']
const NAMES: Record<ClientType, string> = { FII: 'FII', DII: 'DII', Client: 'Client (retail)', Pro: 'Pro (prop desks)' }

interface WideRow {
  trade_date: string
  long_pct: Partial<Record<ClientType, number | null>>
  net: Partial<Record<ClientType, number | null>>
}

function pivot(rows: ParticipantPosition[]): WideRow[] {
  const byDate = new Map<string, WideRow>()
  for (const r of rows) {
    let w = byDate.get(r.trade_date)
    if (!w) {
      w = { trade_date: r.trade_date, long_pct: {}, net: {} }
      byDate.set(r.trade_date, w)
    }
    w.long_pct[r.client_type] = r.fut_index_long_pct
    w.net[r.client_type] = r.fut_index_net
  }
  return [...byDate.values()].sort((a, b) => a.trade_date.localeCompare(b.trade_date))
}

export function ParticipantsPage() {
  const q = useQuery({ queryKey: ['participants'], queryFn: api.participants })
  const daily = useQuery({ queryKey: ['daily'], queryFn: api.daily })
  const { range } = useRange()
  const c = useChartColors()
  const wide = filterRange(pivot(q.data ?? []), range)
  const last = wide[wide.length - 1]

  // Lot-size changes make contract counts jump; mark them on the net-position chart.
  const lotChanges: Array<{ trade_date: string; from: number; to: number }> = []
  const d = daily.data ?? []
  for (let i = 1; i < d.length; i++) {
    const a = d[i - 1].lot_size, b = d[i].lot_size
    if (a != null && b != null && a !== b) lotChanges.push({ trade_date: d[i].trade_date, from: a, to: b })
  }

  const legend = <Legend items={PARTICIPANTS.map((p, i) => ({ label: NAMES[p], color: c.series[i] }))} />
  const series = (pick: (w: WideRow, p: ClientType) => number | null) =>
    PARTICIPANTS.map((p, i) => ({ key: p, label: p, color: c.series[i], value: (w: WideRow) => pick(w, p) }))
  const tableCols = (pick: (w: WideRow, p: ClientType) => number | null, fmt: (v: number | null) => string): Column<WideRow>[] => [
    { label: 'Date', value: (w) => date(w.trade_date), align: 'left' },
    ...PARTICIPANTS.map((p) => ({ label: NAMES[p], value: (w: WideRow) => fmt(pick(w, p)) })),
  ]
  const longPct = (w: WideRow, p: ClientType) => w.long_pct[p] ?? null
  const net = (w: WideRow, p: ClientType) => w.net[p] ?? null

  return (
    <>
      <h1 className="page-title">Positioning</h1>
      <p className="page-sub">Index futures positions by participant type, from NSE's daily participant-wise OI file.</p>
      <div className="filters"><RangeFilter /></div>
      <QueryState error={q.error} isLoading={q.isLoading}>
        {last && (
          <div className="tiles">
            {PARTICIPANTS.map((p) => (
              <StatTile key={p} label={`${NAMES[p]} long %`} value={pct(last.long_pct[p] ?? null, 1)}
                        note={`Net ${num(last.net[p] ?? null)} contracts · ${date(last.trade_date)}`} />
            ))}
          </div>
        )}
        <div className={`stack ${q.isFetching ? 'loading-frame' : ''}`}>
          <ChartCard
            title="Index futures: long share by participant"
            subtitle="Long ÷ (long + short) contracts. A ratio, so comparable across lot-size changes."
            legend={legend}
            table={{ columns: tableCols(longPct, (v) => pct(v, 1)), rows: [...wide].reverse() }}>
            <TimeSeriesChart rows={wide} series={series(longPct)} format={(v) => pct(v, 1)}
                             referenceY={{ y: 50, label: '50%' }} height={300} endLabels syncId="pos" />
          </ChartCard>
          <ChartCard
            title="Index futures: net position by participant"
            subtitle="Long − short, in contracts"
            legend={legend}
            note={lotChanges.length
              ? `Contract counts jump when NSE changes the lot size: ${lotChanges.map((l) => `${date(l.trade_date)} (${l.from}→${l.to})`).join(', ')}.`
              : undefined}
            table={{ columns: tableCols(net, (v) => num(v)), rows: [...wide].reverse() }}>
            <TimeSeriesChart rows={wide} series={series(net)} format={(v) => num(v)}
                             referenceY={{ y: 0 }} height={300} endLabels syncId="pos" />
          </ChartCard>
        </div>
      </QueryState>
    </>
  )
}
