import { useQuery } from '@tanstack/react-query'
import { api, type DatasetStatus, type PostgresDataset } from '../api'
import { DataTable, QueryState, StatTile, StatusBadge, type Column } from '../components/ui'
import { date, num } from '../format'

const LABELS: Record<string, string> = {
  fo_bhavcopy: 'F&O bhavcopy (Nifty)',
  index_close: 'Index closes (Nifty, VIX, …)',
  participant_oi: 'Participant-wise OI',
  participant_vol: 'Participant-wise volume',
}

const CHECK_LABELS: Record<string, string> = {
  calendar_gaps: 'Trading days with a missing or failed file',
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

  return (
    <>
      <h1 className="page-title">Data health</h1>
      <p className="page-sub">What has been downloaded from NSE, what is still open, and the latest quality checks.</p>
      <QueryState error={q.error} isLoading={q.isLoading}>
        {s && (
          <>
            <div className="tiles">
              <StatTile label="Datasets" value={s.datasets.length} note={`${s.datasets.filter((d) => problems(d.totals) === 0).length} complete`} />
              <StatTile label="Trading days (F&O)" value={num(s.datasets.find((d) => d.dataset === 'fo_bhavcopy')?.totals.ok ?? 0)} />
              <StatTile label="Open items" value={num(s.open_items.length)} note="Missing, failed or pending files" />
              <StatTile label="Quality checks" value={checks.length ? `${checks.length - failing}/${checks.length} pass` : '—'}
                        note={s.quality?.report ?? 'Run: niftyquant quality'} />
              <StatTile label="Last fetch" value={s.last_fetch ? s.last_fetch.slice(0, 10) : '—'} note={s.last_fetch ? `${s.last_fetch.slice(11, 16)} UTC` : undefined} />
            </div>
            <div className="stack">
              <section className="card">
                <div className="card-head"><div className="card-title">Datasets</div></div>
                <DataTable columns={datasetCols} rows={s.datasets} />
              </section>
              <PostgresCard local={s.datasets} />
              <section className="card">
                <div className="card-head"><div><div className="card-title">Quality checks</div>
                  <div className="card-sub">A check passes when no rows fail it.</div></div></div>
                <DataTable
                  columns={[
                    { label: 'Check', value: ([k]: [string, number]) => CHECK_LABELS[k] ?? k, align: 'left' },
                    { label: 'Failing rows', value: ([, n]: [string, number]) => num(n) },
                    { label: 'Result', align: 'left', value: ([, n]: [string, number]) =>
                        n === 0 ? <StatusBadge kind="good" label="Pass" /> : <StatusBadge kind="critical" label="Fail" /> },
                  ]}
                  rows={checks} />
              </section>
              <section className="card">
                <div className="card-head"><div><div className="card-title">Coverage by year</div>
                  <div className="card-sub">Trading days downloaded per dataset</div></div></div>
                <DataTable columns={yearCols} rows={years} />
              </section>
              {s.open_items.length > 0 && (
                <section className="card">
                  <div className="card-head"><div className="card-title">Open items</div></div>
                  <DataTable
                    columns={[
                      { label: 'Date', value: (o: DataStatusItem) => date(o.trade_date), align: 'left' },
                      { label: 'Dataset', value: (o: DataStatusItem) => LABELS[o.dataset] ?? o.dataset, align: 'left' },
                      { label: 'Status', value: (o: DataStatusItem) => o.status, align: 'left' },
                      { label: 'Message', value: (o: DataStatusItem) => o.message ?? '', align: 'left' },
                    ]}
                    rows={[...s.open_items].reverse()} />
                </section>
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
    <section className="card">
      <div className="card-head"><div><div className="card-title">Postgres</div>
        <div className="card-sub">
          {q.data ? `Database ${q.data.database}. ` : ''}Loaded by <code>niftyquant pg-load</code> (part of the daily update).
        </div></div></div>
      <QueryState error={q.error} isLoading={q.isLoading}>
        {q.data && (q.data.datasets.length
          ? <DataTable columns={cols} rows={q.data.datasets} />
          : <div className="message">Connected, nothing loaded yet. Run: niftyquant pg-load</div>)}
      </QueryState>
    </section>
  )
}

type DataStatusItem ={ dataset: string; trade_date: string; status: string; message: string | null }
