import { useQuery } from '@tanstack/react-query'
import { api, type DatasetStatus, type PostgresDataset } from '../api'
import { Card, DataTable, EmptyState, PageHeader, QueryState, Stat, StatStrip, StatusBadge, type Column } from '../components/ui'
import { date, num } from '../format'

const LABELS: Record<string, string> = {
  fo_bhavcopy: 'F&O bhavcopy (Nifty)',
  index_close: 'Index closes (Nifty, VIX, …)',
  participant_oi: 'Participant-wise OI',
  participant_vol: 'Participant-wise volume',
  cm_bhavcopy: 'Stock closes (all NSE equities)',
  fo_stock: 'Stock F&O (heavyweights)',
  option_greeks: 'Option IV & Greeks',
}

const CHECK_LABELS: Record<string, string> = {
  calendar_gaps: 'Trading days with a missing or failed file',
  breadth_missing_days: 'Trading days without market breadth',
  duplicate_contracts: 'Duplicate contracts',
  ohlc_inconsistent: 'OHLC inconsistent (e.g. close above high)',
  negative_values: 'Negative prices, volume or OI',
  expiry_before_trade_date: 'Expiry before trade date',
  lot_size_missing: 'Lot size missing',
  near_future_basis_gt_3pct: 'Near future more than 3% from spot',
  no_spot_for_trade_date: 'F&O day without a Nifty close',
  underlying_vs_index_gt_0_1pct: 'Bhavcopy underlying vs index close > 0.1%',
  spot_daily_move_gt_8pct: 'Nifty daily move > 8% (verify, may be real)',
  participant_oi_long_ne_short: 'Participant OI: total long ≠ total short',
  greeks_missing_days: 'F&O day without IV/Greeks',
  iv_atm_missing: 'Day without ATM implied volatility',
  iv_30d_vs_vix_gap: '30-day ATM IV far from India VIX (verify, may be real)',
  iv_smile_implausible: 'IV smile wings below ATM (stale prices?)',
}

/** Whole days between an ISO date and today (UTC). */
function ageDays(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso.slice(0, 10))
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000)
}

function Freshness(props: { iso: string | null }) {
  const a = ageDays(props.iso)
  if (a == null) return <span className="fresh"><span className="fresh-dot" />—</span>
  // Weekends/holidays make 1-3 days normal; beyond that data is stale.
  const kind = a <= 3 ? 'good' : a <= 7 ? 'warning' : 'critical'
  return (
    <span className={`fresh ${kind}`}>
      <span className="fresh-dot" aria-hidden="true" />
      {a <= 0 ? 'Today' : a === 1 ? '1 day ago' : `${a} days ago`}
    </span>
  )
}

const problems = (t: Record<string, number>) => (t.missing ?? 0) + (t.error ?? 0)

export function DataHealthPage() {
  const q = useQuery({ queryKey: ['data-status'], queryFn: api.dataStatus, refetchInterval: 60_000 })
  const s = q.data
  const checks = Object.entries(s?.quality?.checks ?? {})
  const failing = checks.filter(([, n]) => n > 0).length

  const datasetCols: Column<DatasetStatus>[] = [
    { label: 'Dataset', value: (d) => LABELS[d.dataset] ?? d.dataset, align: 'left' },
    { label: 'From', value: (d) => date(d.first_date) },
    { label: 'To', value: (d) => date(d.last_date) },
    { label: 'Freshness', value: (d) => <Freshness iso={d.last_date} />, align: 'left' },
    { label: 'Days OK', value: (d) => num(d.totals.ok ?? 0) },
    { label: 'Holidays', value: (d) => num(d.totals.holiday ?? 0) },
    { label: 'Missing', value: (d) => num(d.totals.missing ?? 0) },
    { label: 'Errors', value: (d) => num(d.totals.error ?? 0) },
    { label: 'Pending', value: (d) => num(d.totals.pending ?? 0) },
    {
      label: 'Status', align: 'left',
      value: (d) => problems(d.totals) === 0
        ? <StatusBadge kind="good" label="Complete" />
        : <StatusBadge kind="warning" label={`${problems(d.totals)} gap${problems(d.totals) > 1 ? 's' : ''}`} />,
    },
  ]

  // Year x dataset coverage: days OK, with a badge where something is missing.
  const years = [...new Set((s?.datasets ?? []).flatMap((d) => d.years.map((y) => y.year)))].sort((a, b) => b - a)
  const yearCols: Column<number>[] = [
    { label: 'Year', value: (y) => String(y), align: 'left' },
    ...(s?.datasets ?? []).map((d) => ({
      label: LABELS[d.dataset] ?? d.dataset,
      value: (y: number) => {
        const row = d.years.find((r) => r.year === y)
        if (!row) return '—'
        const bad = problems(row)
        return bad ? <span>{num(row.ok ?? 0)} <StatusBadge kind="warning" label={`${bad} gap${bad > 1 ? 's' : ''}`} /></span> : num(row.ok ?? 0)
      },
    })),
  ]

  const complete = (s?.datasets ?? []).filter((d) => problems(d.totals) === 0).length
  return (
    <>
      <PageHeader title="Data health"
                  sub="What has been downloaded from NSE, what is still open, and the latest quality checks." />
      <QueryState error={q.error} isLoading={q.isLoading}>
        {s && (
          <>
            <StatStrip>
              <Stat label="Datasets" value={`${complete} / ${s.datasets.length}`}
                    tone={complete === s.datasets.length ? 'good' : undefined} sub="Complete, no gaps" />
              <Stat label="Trading days (F&O)" value={num(s.datasets.find((d) => d.dataset === 'fo_bhavcopy')?.totals.ok ?? 0)}
                    sub={`Since ${date(s.datasets.find((d) => d.dataset === 'fo_bhavcopy')?.first_date ?? null)}`} />
              <Stat label="Open items" value={num(s.open_items.length)} tone={s.open_items.length ? 'critical' : 'good'}
                    sub="Missing, failed or pending files" />
              <Stat label="Quality checks" value={checks.length ? `${checks.length - failing} / ${checks.length}` : '—'}
                    tone={checks.length ? (failing ? 'critical' : 'good') : undefined}
                    sub={checks.length ? (failing ? `${failing} failing` : 'All passing') : 'Run: niftyquant quality'} />
              <Stat label="Last fetch" value={s.last_fetch ? date(s.last_fetch.slice(0, 10)) : '—'}
                    sub={s.last_fetch ? `${s.last_fetch.slice(11, 16)} UTC` : undefined} />
            </StatStrip>
            <div className="stack">
              <Card title="Datasets" subtitle="Coverage and freshness of each NSE download" className="flush">
                <DataTable columns={datasetCols} rows={s.datasets} bare />
              </Card>
              <div className="grid-2">
                <Card title="Quality checks" subtitle={s.quality?.report ? `Report ${s.quality.report} · a check passes when no rows fail it` : 'A check passes when no rows fail it'} className="flush">
                  <DataTable bare maxHeight={520}
                    columns={[
                      { label: 'Check', value: ([k]: [string, number]) => CHECK_LABELS[k] ?? k, align: 'left' },
                      { label: 'Failing rows', value: ([, n]: [string, number]) => num(n) },
                      { label: 'Result', align: 'left', value: ([, n]: [string, number]) =>
                          n === 0 ? <StatusBadge kind="good" label="Pass" /> : <StatusBadge kind="critical" label="Fail" /> },
                    ]}
                    rows={[...checks].sort((a, b) => b[1] - a[1])} />
                </Card>
                <Card title="Coverage by year" subtitle="Trading days downloaded per dataset" className="flush">
                  <DataTable columns={yearCols} rows={years} bare maxHeight={520} />
                </Card>
              </div>
              <PostgresCard local={s.datasets} />
              {s.open_items.length > 0 && (
                <Card title="Open items" subtitle="Files that are missing, failed or still pending" className="flush">
                  <DataTable bare
                    columns={[
                      { label: 'Date', value: (o: DataStatusItem) => date(o.trade_date), align: 'left' },
                      { label: 'Dataset', value: (o: DataStatusItem) => LABELS[o.dataset] ?? o.dataset, align: 'left' },
                      { label: 'Status', align: 'left', value: (o: DataStatusItem) =>
                        <StatusBadge kind={o.status === 'pending' ? 'warning' : 'critical'} label={o.status} /> },
                      { label: 'Message', value: (o: DataStatusItem) => o.message ?? '', align: 'left' },
                    ]}
                    rows={[...s.open_items].reverse()} />
                </Card>
              )}
            </div>
          </>
        )}
      </QueryState>
    </>
  )
}

/** What has been copied into Postgres, compared with the local files. Fails on its own if the DB is down. */
function PostgresCard(props: { local: DatasetStatus[] }) {
  const q = useQuery({ queryKey: ['postgres-status'], queryFn: api.postgres, refetchInterval: 60_000, retry: false })
  const localOk = (ds: string) => props.local.find((d) => d.dataset === ds)?.totals.ok ?? 0
  const cols: Column<PostgresDataset>[] = [
    { label: 'Dataset', value: (d) => LABELS[d.dataset] ?? d.dataset, align: 'left' },
    { label: 'From', value: (d) => date(d.first_day) },
    { label: 'To', value: (d) => date(d.last_day) },
    { label: 'Days', value: (d) => num(d.days) },
    { label: 'Rows', value: (d) => num(d.rows) },
    { label: 'Last loaded', value: (d) => new Date(d.last_loaded_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) },
    {
      label: 'Status', align: 'left',
      value: (d) => {
        const behind = localOk(d.dataset) - d.days
        return behind <= 0
          ? <StatusBadge kind="good" label="In sync" />
          : <StatusBadge kind="warning" label={`${num(behind)} days not loaded`} />
      },
    },
  ]
  return (
    <Card title="Postgres" className="flush"
          subtitle={<>{q.data ? `Database ${q.data.database} · ` : ''}loaded by <code>niftyquant pg-load</code> (part of the daily update)</>}>
      <QueryState error={q.error} isLoading={q.isLoading}>
        {q.data && (q.data.datasets.length
          ? <DataTable columns={cols} rows={q.data.datasets} bare />
          : <EmptyState title="Nothing loaded yet" detail={<>Connected. Run <code>niftyquant pg-load</code>.</>} />)}
      </QueryState>
    </Card>
  )
}

type DataStatusItem = { dataset: string; trade_date: string; status: string; message: string | null }
