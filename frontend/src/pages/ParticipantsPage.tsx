import { useQuery } from '@tanstack/react-query'
import { api, type ClientType, type ParticipantPosition } from '../api'
import { TimeSeriesChart } from '../components/charts'
import { Change, ChartCard, DashRow, EmptyState, Legend, PageHeader, QueryState, Stat, type Column } from '../components/ui'
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

const signed = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${num(v)}`)

export function ParticipantsPage() {
  const q = useQuery({ queryKey: ['participants'], queryFn: api.participants })
  const daily = useQuery({ queryKey: ['daily'], queryFn: api.daily })
  const { range } = useRange()
  const c = useChartColors()
  const allWide = pivot(q.data ?? [])
  const wide = filterRange(allWide, range)
  const last = allWide[allWide.length - 1]
  const prev = allWide[allWide.length - 2]

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
      <PageHeader
        title="Positioning"
        sub={<>Index futures by participant, from NSE's participant-wise OI file{last ? <> · as of <strong>{date(last.trade_date)}</strong></> : null}</>}
        actions={<RangeFilter />}
      />
      <QueryState error={q.error} isLoading={q.isLoading}>
        {last ? (
          <DashRow title={`Latest session · ${date(last.trade_date)}`}>
            {PARTICIPANTS.map((p, i) => {
              const lp = last.long_pct[p] ?? null
              const n = last.net[p] ?? null
              const pn = prev?.net[p] ?? null
              const dn = n != null && pn != null ? n - pn : null
              const side = n == null ? null : n >= 0 ? 'long' : 'short'
              return (
                <Stat key={p} w={6} label={NAMES[p]} value={signed(n)}
                      tone={side === 'long' ? 'good' : side === 'short' ? 'critical' : undefined}
                      sub={<>Net {side ?? '—'} · <Change value={dn} text={`${signed(dn)} d/d`} /></>}
                      spark={wide.map((w) => w.net[p] ?? null)} sparkColor={c.series[i]}
                      info="Net index futures (long − short contracts). Sparkline: net position over the selected range.">
                  <div className="split" role="img" aria-label={`${NAMES[p]}: ${pct(lp, 1)} long`}>
                    <span className="l" style={{ width: `${lp ?? 0}%` }} />
                    <span className="s" style={{ width: lp == null ? 0 : `${100 - lp}%` }} />
                  </div>
                  <div className="split-legend">
                    <span>Long {pct(lp, 1)}</span><span>Short {lp == null ? '—' : pct(100 - lp, 1)}</span>
                  </div>
                </Stat>
              )
            })}
          </DashRow>
        ) : (
          <EmptyState title="No participant data" detail="Run the NSE download to fetch participant-wise OI." />
        )}
        <DashRow title="History">
          <ChartCard w={12}
            title="Long share by participant"
            subtitle="Long ÷ (long + short) index futures. A ratio, so comparable across lot-size changes."
            legend={legend}
            table={{ columns: tableCols(longPct, (v) => pct(v, 1)), rows: [...wide].reverse() }}>
            <TimeSeriesChart rows={wide} series={series(longPct)} format={(v) => pct(v, 1)} axisFormat={(v) => pct(v, 0)}
                             referenceY={{ y: 50, label: '50%' }} height={300} endLabels syncId="pos" />
          </ChartCard>
          <ChartCard
            title="Net position by participant"
            subtitle="Long − short index futures, contracts"
            legend={legend}
            note={lotChanges.length
              ? `Contract counts jump when NSE changes the lot size: ${lotChanges.map((l) => `${date(l.trade_date)} (${l.from}→${l.to})`).join(', ')}.`
              : undefined}
            w={12}
            table={{ columns: tableCols(net, (v) => num(v)), rows: [...wide].reverse() }}>
            <TimeSeriesChart rows={wide} series={series(net)} format={(v) => num(v)}
                             axisFormat={(v) => `${num(v / 1000)}K`}
                             referenceY={{ y: 0 }} height={300} endLabels syncId="pos" />
          </ChartCard>
        </DashRow>
      </QueryState>
    </>
  )
}
