import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, type ResultEvent, type ResultSummary } from '../api'
import { ChartTooltip } from '../components/charts'
import { Change, ChartCard, DashRow, DataTable, Legend, PageHeader, Panel, QueryState, Stat, StatusBadge, type Column } from '../components/ui'
import { date, num, pct } from '../format'
import { useChartColors } from '../theme'

const NAME: Record<string, string> = {
  HDFCBANK: 'HDFC Bank', ICICIBANK: 'ICICI Bank', RELIANCE: 'Reliance', INFY: 'Infosys', BHARTIARTL: 'Bharti Airtel',
  TCS: 'TCS', LT: 'L&T', ITC: 'ITC', KOTAKBANK: 'Kotak Bank', AXISBANK: 'Axis Bank', SBIN: 'SBI',
  HINDUNILVR: 'HUL', BAJFINANCE: 'Bajaj Finance', 'M&M': 'M&M', HDFC: 'HDFC Ltd',
}
const name = (s: string) => NAME[s] ?? s

/** An inferred session is a less certain pick when its IV drop barely stands out or barely beats the runner-up. */
const unclear = (r: ResultEvent) => r.source === 'inferred' && ((r.detect_score ?? 0) < 3 || (r.detect_margin ?? 0) < 1)

const points = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${num(v, 0)} pts`)

type Sort = 'latest' | 'impact' | 'surprise'

export function ResultsPage() {
  const events = useQuery({ queryKey: ['results'], queryFn: api.results })
  const summary = useQuery({ queryKey: ['result-summary'], queryFn: api.resultSummary })
  const [symbol, setSymbol] = useState<string>('all')
  const [sort, setSort] = useState<Sort>('latest')
  const c = useChartColors()

  const all = useMemo(() => events.data ?? [], [events.data])
  const perStock = useMemo(() => (summary.data ?? []).filter((r) => r.symbol !== 'ALL'), [summary.data])
  const overall = (summary.data ?? []).find((r) => r.symbol === 'ALL')
  const confirmed = all.filter((r) => r.source === 'confirmed').length
  const biggest = useMemo(() => [...all].sort((a, b) => Math.abs(b.nifty_points ?? 0) - Math.abs(a.nifty_points ?? 0))[0], [all])

  const moveBars = [...perStock]
    .map((r) => ({ ...r, short: name(r.symbol) }))
    .sort((a, b) => (b.median_implied_move_pct ?? 0) - (a.median_implied_move_pct ?? 0))
  const impactBars = [...perStock]
    .map((r) => ({ ...r, short: name(r.symbol) }))
    .sort((a, b) => (b.median_abs_nifty_points ?? 0) - (a.median_abs_nifty_points ?? 0))

  // Chart notes from the data, so they stay true as quarters are added.
  const overPriced = moveBars.filter((r) => (r.median_abs_move_pct ?? 0) >= (r.median_implied_move_pct ?? Infinity)).map((r) => r.short)
  const moveNote = overPriced.length
    ? `Every stock except ${overPriced.join(' and ')} moves less, at the median, than its options price for results day.`
    : 'Every stock moves less, at the median, than its options price for results day.'
  const impactNote = `${impactBars.slice(0, 3).map((r) => r.short).join(', ')} move Nifty most on results days`
    + (biggest ? `; the largest single move was ${name(biggest.symbol)}'s ${biggest.quarter} result (${points(biggest.nifty_points)}, ${date(biggest.reaction_session)}).` : '.')

  const rows = useMemo(() => {
    const xs = all.filter((r) => symbol === 'all' || r.symbol === symbol)
    if (sort === 'impact') return [...xs].sort((a, b) => Math.abs(b.nifty_points ?? 0) - Math.abs(a.nifty_points ?? 0))
    if (sort === 'surprise') return [...xs].sort((a, b) => (b.surprise ?? -1) - (a.surprise ?? -1))
    return [...xs].reverse()
  }, [all, symbol, sort])

  const summaryCols: Column<ResultSummary>[] = [
    { label: 'Stock', value: (r) => (r.symbol === 'ALL' ? 'All heavyweights' : name(r.symbol)), align: 'left' },
    { label: 'Results', value: (r) => num(r.announcements) },
    { label: 'Median |move|', value: (r) => pct(r.median_abs_move_pct, 2) },
    { label: 'Priced move', value: (r) => pct(r.median_implied_move_pct, 2) },
    { label: 'Beat priced', value: (r) => pct(r.beat_implied_share == null ? null : r.beat_implied_share * 100, 0) },
    { label: 'Median beyond Nifty', value: (r) => pct(r.median_abs_abnormal_pct, 2) },
    { label: 'IV crush', value: (r) => `${num(r.median_iv_drop_pts, 1)} pts` },
    { label: 'Up', value: (r) => pct(r.up_share == null ? null : r.up_share * 100, 0) },
    { label: 'Next 3 days follow', value: (r) => pct(r.drift_follows_share == null ? null : r.drift_follows_share * 100, 0) },
    { label: 'Median |Nifty pts|', value: (r) => num(r.median_abs_nifty_points, 1) },
    { label: 'Largest |Nifty pts|', value: (r) => num(r.max_abs_nifty_points, 0) },
    { label: 'Weight', value: (r) => pct(r.median_nifty_weight_pct, 1) },
  ]

  const eventCols: Column<ResultEvent>[] = [
    { label: 'Session', value: (r) => date(r.reaction_session), align: 'left' },
    { label: 'Stock', value: (r) => name(r.symbol), align: 'left' },
    { label: 'Quarter', value: (r) => r.quarter, align: 'left' },
    { label: 'Date', align: 'left', value: (r) => r.source === 'confirmed'
        ? <StatusBadge kind="good" label="Confirmed" />
        : unclear(r) ? <StatusBadge kind="warning" label="Unclear" /> : <span className="muted">Inferred</span> },
    { label: 'Move', value: (r) => r.return_pct == null ? '—' : <Change value={r.return_pct} text={pct(r.return_pct, 2, true)} /> },
    { label: 'Priced ±', value: (r) => pct(r.implied_move_pct, 2) },
    { label: 'Surprise', value: (r) => num(r.surprise, 2) },
    { label: 'Beyond Nifty', value: (r) => pct(r.abnormal_return_pct, 2, true) },
    { label: 'IV before → after', value: (r) => r.iv_pre == null ? '—' : `${num(r.iv_pre, 1)} → ${num(r.iv_post, 1)}` },
    { label: 'Nifty points', value: (r) => r.nifty_points == null ? '—' : <Change value={r.nifty_points} text={points(r.nifty_points)} /> },
    { label: 'Of Nifty move', value: (r) => (r.nifty_move_points == null || Math.abs(r.nifty_move_points) < 20) ? '—'
        : pct(r.share_of_nifty_move_pct, 0) },
    { label: 'Next 3 days', value: (r) => pct(r.drift_3d_pct, 2, true) },
  ]

  return (
    <>
      <PageHeader title="Results"
                  sub="Quarterly results of the 15 Nifty heavyweights since 2018: what options priced in, how the stock moved, and what it did to Nifty." />
      <QueryState error={events.error ?? summary.error} isLoading={events.isLoading || summary.isLoading}>
        <DashRow title="Overview">
          <Stat w={6} label="Results studied" value={num(all.length)}
                sub={`${num(perStock.length)} stocks · ${num(confirmed)} dates confirmed`}
                info="Since January 2018. Each result's reacting session: the same day if it came out in market hours, the next session if after the close. Confirmed from news reports where checked; otherwise inferred from the collapse in the stock's option IV once the result is out." />
          <Stat w={6} label="Typical move vs priced" value={`${pct(overall?.median_abs_move_pct, 1)} vs ${pct(overall?.median_implied_move_pct, 1)}`}
                sub="Median |move| vs options' priced move"
                info="Actual: the median |move| on the reacting session. Priced: the result's own one-day standard deviation, priced the evening before, taken from the two nearest expiries' IVs (the extra variance only the result explains)." />
          <Stat w={6} label="Beat the priced move" value={pct(overall?.beat_implied_share == null ? null : overall.beat_implied_share * 100, 0)}
                tone={overall?.beat_implied_share != null && overall.beat_implied_share < 0.32 ? 'good' : undefined}
                sub="Fair pricing would give about 32%"
                info="Share of results that moved more than ±1 priced move. If options priced results fairly, about 32% would. Below that means options have overpriced results risk: the IV crush after the result usually pays the seller." />
          <Stat w={6} label="Biggest Nifty hit" value={biggest ? points(biggest.nifty_points) : '—'}
                tone={biggest?.nifty_points != null && biggest.nifty_points < 0 ? 'critical' : undefined}
                sub={biggest ? `${name(biggest.symbol)}, ${date(biggest.reaction_session)}${biggest.share_of_nifty_move_pct != null ? ` · ${pct(biggest.share_of_nifty_move_pct, 0)} of the fall` : ''}` : undefined}
                info="Nifty points = the stock's index weight at the previous close × its move × the index level. Weights are estimated from daily prices (they reproduce the index within about a point a day)." />

          <ChartCard w={12} title="Priced vs actual move, by stock"
                     subtitle="Median over each stock's results, % of the stock price"
                     note={moveNote}
                     legend={<Legend items={[{ label: 'Priced move (options)', color: c.series[1], shape: 'rect' },
                                             { label: 'Actual |move|', color: c.series[0], shape: 'rect' }]} />}
                     table={{ columns: summaryCols, rows: summary.data ?? [] }}>
            <ResponsiveContainer width="100%" height={380}>
              <BarChart data={moveBars} layout="vertical" barGap={2} margin={{ top: 8, right: 24, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={c.grid} horizontal={false} />
                <XAxis type="number" stroke={c.axis} tickLine={false} tick={{ fill: c.muted, fontSize: 11 }}
                       tickFormatter={(v: number) => pct(v, 0)} />
                <YAxis type="category" dataKey="short" width={104} interval={0} axisLine={false} tickLine={false}
                       tick={{ fill: c.textSecondary, fontSize: 12 }} />
                <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} isAnimationActive={false}
                         content={(p) => <ChartTooltip {...p} format={(v) => pct(v, 2)} />} />
                <Bar dataKey="median_implied_move_pct" name="Priced move" fill={c.series[1]} radius={[0, 4, 4, 0]} isAnimationActive={false} />
                <Bar dataKey="median_abs_move_pct" name="Actual |move|" fill={c.series[0]} radius={[0, 4, 4, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard w={12} title="Nifty points from a typical result"
                     subtitle="Median |Nifty points| the stock added or took away on its results day"
                     note={impactNote}
                     table={{ columns: summaryCols, rows: summary.data ?? [] }}>
            <ResponsiveContainer width="100%" height={380}>
              <BarChart data={impactBars} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={c.grid} horizontal={false} />
                <XAxis type="number" stroke={c.axis} tickLine={false} tick={{ fill: c.muted, fontSize: 11 }}
                       tickFormatter={(v: number) => num(v, 0)} />
                <YAxis type="category" dataKey="short" width={104} interval={0} axisLine={false} tickLine={false}
                       tick={{ fill: c.textSecondary, fontSize: 12 }} />
                <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} isAnimationActive={false}
                         content={(p) => <ChartTooltip {...p} format={(v) => `${num(v, 1)} pts`} />} />
                <Bar dataKey="median_abs_nifty_points" name="Median |Nifty points|" fill={c.series[0]} radius={[0, 4, 4, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </DashRow>

        <DashRow title="Every result">
          <Panel w={24} flush title="Results"
                 info={<>
                   <p>Move: reacting-session close against the previous close (adjusted for splits and bonuses). Priced ±: the one-day move options priced the evening before. Surprise = |move| ÷ priced move. Beyond Nifty: the move minus what the stock's beta to Nifty explains.</p>
                   <p>Date: Confirmed from news reports; Inferred from the IV collapse (finds 16 of 20 confirmed sessions; HDFC Bank's small IV moves make its inferred dates unreliable); Unclear when the pick barely stands out.</p>
                 </>}
                 right={
                   <div className="filters">
                     <label className="field"><span className="lbl">Stock</span>
                       <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                         <option value="all">All</option>
                         {perStock.map((r) => <option key={r.symbol} value={r.symbol}>{name(r.symbol)}</option>)}
                       </select>
                     </label>
                     <div className="seg" role="group" aria-label="Sort">
                       <button aria-pressed={sort === 'latest'} onClick={() => setSort('latest')}>Latest</button>
                       <button aria-pressed={sort === 'impact'} onClick={() => setSort('impact')}>Nifty impact</button>
                       <button aria-pressed={sort === 'surprise'} onClick={() => setSort('surprise')}>Surprise</button>
                     </div>
                   </div>
                 }>
            <DataTable columns={eventCols} rows={rows} maxHeight={620} bare />
          </Panel>
        </DashRow>
      </QueryState>
    </>
  )
}
