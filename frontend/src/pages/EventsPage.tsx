import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, type EventCategory, type EventImpact, type MarketEvent } from '../api'
import { ChartTooltip } from '../components/charts'
import { Card, Change, ChartCard, DataTable, PageHeader, QueryState, Stat, StatStrip, StatusBadge, type Column } from '../components/ui'
import { date, num, pct } from '../format'
import { useChartColors } from '../theme'

const CATEGORIES: Array<{ key: EventCategory; label: string }> = [
  { key: 'rbi_policy', label: 'RBI' },
  { key: 'fomc', label: 'Fed (FOMC)' },
  { key: 'us_cpi', label: 'US CPI' },
  { key: 'union_budget', label: 'Budget' },
  { key: 'election', label: 'Elections' },
  { key: 'expiry', label: 'Expiry' },
  { key: 'special_session', label: 'Special sessions' },
  { key: 'market_shock', label: 'Big-move days' },
]
const LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]))

const IST_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

/** An instant (any offset, e.g. "2026-12-09T19:00:00Z") as IST clock time; flags a later IST date
 *  than the event's own date (a Fed decision on a US date lands after midnight in India). */
function istTime(iso: string | null, eventDate?: string): string {
  if (!iso) return '—'
  const parts = IST_PARTS.formatToParts(new Date(iso))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const ymd = `${get('year')}-${get('month')}-${get('day')}`
  return `${get('hour')}:${get('minute')} IST${eventDate && ymd !== eventDate ? ' (next day)' : ''}`
}

export function EventsPage() {
  const events = useQuery({ queryKey: ['events'], queryFn: api.events })
  const impact = useQuery({ queryKey: ['event-impact'], queryFn: api.eventImpact })
  const [category, setCategory] = useState<EventCategory | 'all'>('rbi_policy')
  const c = useChartColors()

  const all = useMemo(() => events.data ?? [], [events.data])
  // Upcoming = not yet traded: no session after it in the data.
  const upcoming = (cat: EventCategory) => all.find((e) => e.category === cat && e.reaction_session == null)
  const rows = useMemo(() => all.filter((e) => category === 'all' || e.category === category).reverse(), [all, category])

  const imp = (impact.data ?? []).filter((r) => r.category !== 'market_shock')
  const baseline = imp.find((r) => r.category === 'all_days')
  const bars = imp.filter((r) => r.category !== 'all_days')
    .map((r) => ({ ...r, short: LABEL[r.category] ?? r.label }))
    .sort((a, b) => (b.median_abs_move_pct ?? 0) - (a.median_abs_move_pct ?? 0))

  const impactCols: Column<EventImpact>[] = [
    { label: 'Event type', value: (r) => r.label, align: 'left' },
    { label: 'Events', value: (r) => num(r.events) },
    { label: 'Median |move|', value: (r) => pct(r.median_abs_move_pct, 2) },
    { label: '90th pct |move|', value: (r) => pct(r.p90_abs_move_pct, 2) },
    { label: '× normal day', value: (r) => num(r.move_vs_normal, 2) },
    { label: 'Up days', value: (r) => pct(r.share_up_pct, 0) },
    { label: 'Median VIX change', value: (r) => pct(r.median_vix_change_pct, 1, true) },
  ]

  const eventCols: Column<MarketEvent>[] = [
    { label: 'Date', value: (e) => date(e.event_date), align: 'left' },
    { label: 'Time', value: (e) => istTime(e.event_time_ist, e.event_date), align: 'left' },
    { label: 'Event', value: (e) => e.name, align: 'left' },
    { label: 'Source check', align: 'left', value: (e) => e.verified
        ? <StatusBadge kind="good" label={e.category === 'market_shock' ? 'Cause known' : 'Verified'} />
        : <StatusBadge kind="warning" label={e.category === 'market_shock' ? 'Cause unknown' : 'Unverified'} /> },
    { label: 'Reacting session', value: (e) => e.reaction_session ? date(e.reaction_session) : 'Upcoming' },
    { label: 'Nifty move', value: (e) => e.nifty_move_pct == null ? '—'
        : <Change value={e.nifty_move_pct} text={pct(e.nifty_move_pct, 2, true)} /> },
    { label: 'Priced 1-day move', value: (e) => pct(e.expected_move_pct, 2) },
    { label: 'Surprise', value: (e) => num(e.surprise, 2) },
    { label: 'VIX change', value: (e) => pct(e.vix_change_pct, 1, true) },
  ]

  return (
    <>
      <PageHeader title="Events"
                  sub="Scheduled events and big-move days since 2015, with Nifty's move on the first session that could react." />
      <QueryState error={events.error ?? impact.error} isLoading={events.isLoading || impact.isLoading}>
        <StatStrip>
          {(['rbi_policy', 'fomc', 'us_cpi', 'expiry'] as const).map((cat) => {
            const e = upcoming(cat)
            return (
              <Stat key={cat} label={`Next ${LABEL[cat]}`} value={e ? date(e.event_date) : '—'}
                    sub={e ? `${e.name}${e.event_time_ist ? ` · ${istTime(e.event_time_ist, e.event_date)}` : ''}` : 'None scheduled in the data'} />
            )
          })}
        </StatStrip>

        <ChartCard title="How much Nifty moves on event days" subtitle="Median absolute close-to-close move on the reacting session, %"
                   note={baseline ? `Line: an ordinary session (median ${pct(baseline.median_abs_move_pct, 2)}). Elections move the market most; on US CPI days Nifty moves less than usual.` : undefined}
                   table={{ columns: impactCols, rows: impact.data ?? [] }}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={bars} layout="vertical" margin={{ top: 24, right: 24, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={c.grid} horizontal={false} />
              <XAxis type="number" stroke={c.axis} tickLine={false} tick={{ fill: c.muted, fontSize: 11 }}
                     tickFormatter={(v: number) => pct(v, 1)} />
              <YAxis type="category" dataKey="short" width={120} axisLine={false} tickLine={false}
                     tick={{ fill: c.textSecondary, fontSize: 12 }} />
              {baseline?.median_abs_move_pct != null && (
                <ReferenceLine x={baseline.median_abs_move_pct} stroke={c.muted} strokeDasharray="4 3"
                               label={{ value: 'Normal day', position: 'top', fill: c.muted, fontSize: 11 }} />
              )}
              <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} isAnimationActive={false}
                       content={(p) => <ChartTooltip {...p} format={(v) => pct(v, 2)} />} />
              <Bar dataKey="median_abs_move_pct" name="Median |move|" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {bars.map((b) => <Cell key={b.category} fill={c.series[0]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <Card title="Event list" className="flush"
              subtitle="Surprise = Nifty's move ÷ the one-day move options priced the session before (about 0.6 on an ordinary day). US events reach India after the close, so the next session reacts."
              actions={
                <div className="seg" role="group" aria-label="Event type">
                  {CATEGORIES.map((x) => (
                    <button key={x.key} aria-pressed={category === x.key} onClick={() => setCategory(x.key)}>{x.label}</button>
                  ))}
                  <button aria-pressed={category === 'all'} onClick={() => setCategory('all')}>All</button>
                </div>
              }>
          <DataTable columns={eventCols} rows={rows} maxHeight={560} bare />
        </Card>
      </QueryState>
    </>
  )
}
