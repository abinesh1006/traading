import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  daysBetween, historyCheck, ranges, suggest, trendView, volView,
  type HistoryCheck, type Plan, type TrendView, type Verdict, type VolView,
} from '../analysis'
import { api, type ClientType, type DailyMarket, type IvDaily, type OptionChain } from '../api'
import { TimeSeriesChart } from '../components/charts'
import {
  BarGauge, Change, ChartCard, DashRow, Gauge, Legend, PageHeader, Panel, QueryState, Stat, type Column,
} from '../components/ui'
import { date, num, pct, signClass } from '../format'
import { filterRange, RangeFilter, useRange } from '../range'
import { IntradayRow } from '../live'
import { useChartColors, type ChartColors } from '../theme'

const signed = (v: number, digits: number) => `${v > 0 ? '+' : ''}${num(v, digits)}`
const dateCol = <R extends { trade_date: string }>(): Column<R> => ({ label: 'Date', value: (r) => date(r.trade_date), align: 'left' })
const pctRank = (values: Array<number | null>, v: number | null) => {
  const xs = values.filter((x): x is number => x != null)
  return v == null || !xs.length ? null : (xs.filter((x) => x <= v).length / xs.length) * 100
}
const delta = <R,>(rows: R[], pick: (r: R) => number | null) => {
  if (rows.length < 2) return null
  const a = pick(rows[rows.length - 2]), b = pick(rows[rows.length - 1])
  return a == null || b == null ? null : b - a
}
const verdictTone = (v: Verdict) => (v === 'Bullish' ? 'good' : v === 'Bearish' ? 'critical' : 'warning')

export function MarketPage() {
  const q = useQuery({ queryKey: ['daily'], queryFn: api.daily })
  const ivq = useQuery({ queryKey: ['iv'], queryFn: api.iv })
  const pq = useQuery({ queryKey: ['participants'], queryFn: api.participants })
  const { range } = useRange()
  const all = q.data ?? []
  const last = all[all.length - 1]
  const latest = last?.trade_date

  // Chain for the strategy: nearest expiry, or the next one when the nearest is under 2 days away.
  const c1 = useQuery({ queryKey: ['chain', latest, undefined], queryFn: () => api.chain(latest!), enabled: !!latest })
  const nearDte = c1.data ? daysBetween(c1.data.trade_date, c1.data.expiry) : null
  const nextExp = c1.data && nearDte != null && nearDte < 2
    ? c1.data.expiries.find((e) => daysBetween(c1.data!.trade_date, e) >= 2) : undefined
  const c2 = useQuery({ queryKey: ['chain', latest, nextExp], queryFn: () => api.chain(latest!, nextExp), enabled: !!nextExp })
  const chain = nextExp ? c2.data : c1.data

  const computedAt = q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null

  return (
    <>
      <PageHeader
        title="Market overview"
        sub={<>Nifty 50 · NSE end-of-day{last ? <> · data through <strong>{date(last.trade_date)}</strong> close</> : null}{computedAt ? <> · computed {computedAt}</> : null}</>}
        actions={<RangeFilter />}
      />
      <QueryState error={q.error} isLoading={q.isLoading}>
        {last ? (
          <>
            <MarketView daily={all} iv={ivq.data ?? []} participants={pq.data ?? []} chain={chain} />
            <IntradayRow />
            <Overview daily={all} iv={ivq.data ?? []} />
            <PriceRow daily={all} rows={filterRange(all, range)} participants={pq.data ?? []} />
            <VolRow rows={filterRange(all, range)} ivRows={filterRange(ivq.data ?? [], range)} ivError={ivq.error} />
          </>
        ) : (
          <div className="state-box"><div className="state-title">No market data yet</div></div>
        )}
      </QueryState>
    </>
  )
}

/* ================================================================== */
/* Market view: trend, outlook, strategy                               */
/* ================================================================== */

function MarketView(props: { daily: DailyMarket[]; iv: IvDaily[]; participants: Parameters<typeof trendView>[1]; chain?: OptionChain }) {
  const tv = trendView(props.daily, props.participants)
  const vv = volView(props.iv, props.daily)
  const last = props.daily[props.daily.length - 1]
  const hist = tv ? historyCheck(props.daily, tv.verdict) : null
  const dte = props.chain ? daysBetween(props.chain.trade_date, props.chain.expiry) : last.days_to_expiry
  const rg = last.spot_close != null && vv.iv != null ? ranges(last.spot_close, vv.iv, dte, last.atm_straddle) : null
  const plan = tv && props.chain && dte != null ? suggest(tv, vv, props.chain, dte) : null

  return (
    <DashRow title={`Market view · as of ${date(last.trade_date)} close`}>
      <Panel w={6} className="featured" title="Trend" info={<><p>Six price rules on the daily close, each voting bullish, bearish or neutral. Score ≥ +3 is bullish, ≤ −3 bearish, otherwise neutral.</p><p>Sentiment reads are shown for context and are not counted.</p></>}>
        {tv ? <TrendBody tv={tv} /> : <div className="muted">Needs 200 sessions of history.</div>}
      </Panel>
      <Panel w={9} className="featured" title="Outlook · prediction" info={<><p>Ranges: one standard deviation from {vv.ivSource} ({pct(vv.iv, 1)} a year). About 68% of moves stay inside ±1σ, 95% inside ±2σ. These are the reliable part of a forecast.</p><p>Direction: how often Nifty rose the next session after the same trend verdict, 2016 onward, against all sessions. In-sample; an edge needs |z| ≥ 2.</p></>}>
        {rg ? <OutlookBody rg={rg} hist={hist} vv={vv} /> : <div className="muted">Waiting for volatility data…</div>}
      </Panel>
      <Panel w={9} className="featured" title="Strategy · suggestion" info={<><p>Defined-risk Nifty options structure picked from the trend and the volatility regime: credit spreads when premium is rich, debit spreads when it is cheap, an iron condor when sideways.</p><p>Strikes by delta from the last close's chain. A research suggestion, not advice; these rules are not yet backtested.</p></>}>
        {plan ? <PlanBody plan={plan} /> : <div className="muted">Loading option chain…</div>}
      </Panel>
    </DashRow>
  )
}

function voteIcon(v: number) {
  return v > 0 ? <span className="up" aria-label="bullish">▲</span> : v < 0 ? <span className="down" aria-label="bearish">▼</span> : <span className="muted" aria-label="neutral">●</span>
}

function TrendBody({ tv }: { tv: TrendView }) {
  const tone = verdictTone(tv.verdict)
  const posPct = ((tv.score + tv.max) / (2 * tv.max)) * 100
  return (
    <div className="mv">
      <div className="mv-verdict">
        <span className={`mv-word ${tone}`}>{tv.verdict.toUpperCase()}</span>
        <span className="mv-strength">{tv.strength} · score {tv.score > 0 ? '+' : ''}{tv.score} / ±{tv.max}</span>
      </div>
      <div className="meter" role="img" aria-label={`Trend score ${tv.score} of ${tv.max}`}>
        <div className="meter-track" />
        <div className="meter-mid" />
        <div className={`meter-dot ${tone}`} style={{ left: `${posPct}%` }} />
        <div className="meter-scale"><span>Bearish</span><span>Neutral</span><span>Bullish</span></div>
      </div>
      <ul className="sig-list">
        {tv.signals.map((s) => (
          <li key={s.label}>{voteIcon(s.vote)}<span className="sig-label">{s.label}</span><span className="sig-detail">{s.detail}</span></li>
        ))}
      </ul>
      {tv.sentiment.length > 0 && (
        <>
          <div className="mv-sub">Sentiment (not counted)</div>
          <ul className="sig-list">
            {tv.sentiment.map((s) => (
              <li key={s.label}>{voteIcon(s.vote)}<span className="sig-label">{s.label}</span><span className="sig-detail">{s.detail}</span></li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function RangeBlock(props: { label: string; sigma: number; spot: number; note?: ReactNode }) {
  return (
    <div className="rb">
      <div className="rb-label">{props.label}</div>
      <div className="rb-value">±{num(props.sigma, 0)} <small>pts</small></div>
      <div className="rb-band">{num(props.spot - props.sigma)}–{num(props.spot + props.sigma)}</div>
      <div className="rb-note">{props.note ?? `95% band ±${num(1.96 * props.sigma)}`}</div>
    </div>
  )
}

function OutlookBody({ rg, hist, vv }: { rg: ReturnType<typeof ranges>; hist: HistoryCheck | null; vv: VolView }) {
  return (
    <div className="mv">
      <div className="rb-grid">
        <RangeBlock label="Next 1 hour" sigma={rg.sigmaHour} spot={rg.spot} />
        <RangeBlock label="Next session" sigma={rg.sigmaDay} spot={rg.spot} />
        {rg.sigmaExpiry != null && (
          <RangeBlock label={`To expiry · ${rg.dte}d`} sigma={rg.sigmaExpiry} spot={rg.spot}
                      note={rg.straddle != null ? `Straddle ±${num(rg.straddle)}` : undefined} />
        )}
      </div>
      <div className="mv-sub">Direction, next session</div>
      {hist ? (
        <>
          <div className="odds">
            <div className="odds-bar" role="img" aria-label={`Up ${num(hist.upPct, 1)}%`}>
              <span className="u" style={{ width: `${hist.upPct}%` }}>Up {num(hist.upPct, 0)}%</span>
              <span className="d" style={{ width: `${100 - hist.upPct}%` }}>Down {num(100 - hist.upPct, 0)}%</span>
            </div>
            <div className="odds-base" style={{ left: `${hist.baseUpPct}%` }} title={`All sessions: ${num(hist.baseUpPct, 1)}% up`} />
          </div>
          <div className="odds-text">
            After a <b>{hist.verdict.toLowerCase()}</b> reading Nifty closed higher next session <b>{num(hist.upPct, 1)}%</b> of the time
            ({num(hist.n)} sessions since {date(hist.since).slice(3)}), vs <b>{num(hist.baseUpPct, 1)}%</b> on all sessions.
            Average next 5 sessions: <span className={signClass(hist.avg5d)}>{pct(hist.avg5d, 2, true)}</span> vs {pct(hist.base5d, 2, true)}.
          </div>
          <div className={`edge ${hist.edge ? 'yes' : 'no'}`}>
            {hist.edge
              ? <>Statistically distinguishable from the base rate (z = {num(hist.z, 1)}). Still in-sample: treat as a tilt, not a signal.</>
              : <>No reliable edge (z = {num(hist.z, 1)}): direction is close to a coin flip. Trade the range, not the direction.</>}
          </div>
        </>
      ) : <div className="muted">Not enough history.</div>}
      <div className="mv-foot">
        Volatility {vv.regime.toLowerCase()} · {vv.ivSource} {pct(vv.iv, 1)} · {vv.ivPctile == null ? '' : `${num(vv.ivPctile)}th pct (1y)`} · IV − RV {vv.ivMinusRv == null ? '—' : signed(vv.ivMinusRv, 1)} pts
      </div>
    </div>
  )
}

function PlanBody({ plan }: { plan: Plan | { stand: string; why: string[] } }) {
  if ('stand' in plan) {
    return (
      <div className="mv">
        <div className="mv-verdict"><span className="mv-word warning">{plan.stand.toUpperCase()}</span></div>
        <ul className="why">{plan.why.map((w) => <li key={w}>{w}</li>)}</ul>
      </div>
    )
  }
  const lot = plan.lot ?? 0
  const rupees = (pts: number | null) => (pts == null ? 'Unlimited' : `₹${num(pts * lot)}`)
  const isCredit = plan.credit >= 0
  return (
    <div className="mv">
      <div className="mv-verdict">
        <span className="mv-word accent">{plan.name}</span>
        <span className="mv-strength">{plan.stance} · expiry {date(plan.expiry)} ({plan.dte}d)</span>
      </div>
      <table className="legs">
        <thead><tr><th>Action</th><th>Strike</th><th>Type</th><th>Premium</th><th>Δ</th></tr></thead>
        <tbody>
          {plan.legs.map((l) => (
            <tr key={`${l.action}${l.type}${l.strike}`}>
              <td><span className={`pill ${l.action === 'Buy' ? 'up' : 'down'}`}>{l.action}</span></td>
              <td>{num(l.strike)}</td>
              <td>{l.type}</td>
              <td>{num(l.price, 2)}</td>
              <td>{num(l.delta, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="plan-kpis">
        <div><span>{isCredit ? 'Net credit' : 'Net debit'}</span><b>{num(Math.abs(plan.credit), 2)} pts</b><small>{rupees(Math.abs(plan.credit))} / lot</small></div>
        <div><span>Max profit</span><b className="up">{rupees(plan.maxProfit)}</b><small>{num(plan.maxProfit, 1)} pts</small></div>
        <div><span>Max loss</span><b className="down">{rupees(plan.maxLoss)}</b><small>{num(plan.maxLoss, 1)} pts</small></div>
        <div><span>Breakeven</span><b>{plan.breakevens.map((b) => num(b)).join(' / ')}</b><small>{plan.popPct != null ? `~${num(plan.popPct)}% keep credit` : `lot ${num(lot)}`}</small></div>
      </div>
      <ul className="why">{plan.why.map((w) => <li key={w}>{w}</li>)}</ul>
      <div className="mv-foot">Prices are the last close; check live quotes before acting. Research output, not investment advice.</div>
    </div>
  )
}

/* ================================================================== */
/* Overview: stat panels with sparklines                               */
/* ================================================================== */

function Overview(props: { daily: DailyMarket[]; iv: IvDaily[] }) {
  const c = useChartColors()
  const { daily } = props
  const last = daily[daily.length - 1], prev = daily[daily.length - 2]
  const ivLast = props.iv[props.iv.length - 1]
  const chgPts = prev?.spot_close != null && last.spot_close != null ? last.spot_close - prev.spot_close : null
  const vixTone = last.vix_close == null ? undefined : last.vix_close < 15 ? 'good' : last.vix_close <= 20 ? 'warning' : 'critical'
  const { spot_high: h, spot_low: l } = last
  const spark = daily.slice(-60)
  const ivSpark = props.iv.slice(-60)
  const d = (pick: (r: DailyMarket) => number | null, f: (v: number) => string) => {
    const v = delta(daily, pick)
    return v == null ? undefined : <Change value={v} text={`${f(v)} d/d`} />
  }
  return (
    <DashRow title="Overview">
      <Stat w={4} label="Nifty 50" value={num(last.spot_close, 2)} valueClass={signClass(last.spot_return_pct)}
            sub={<><Change value={chgPts} text={`${chgPts == null ? '' : signed(chgPts, 2)} (${pct(last.spot_return_pct, 2, true)})`} /></>}
            spark={spark.map((r) => r.spot_close)} sparkColor={c.series[0]}
            info={`Daily close and change on the day. Day range ${num(l, 2)} – ${num(h, 2)}. Sparklines on this row: the last 60 sessions.`} />
      <Stat w={4} label="India VIX" value={num(last.vix_close, 2)} tone={vixTone}
            sub={d((r) => r.vix_close, (v) => signed(v, 2))} spark={spark.map((r) => r.vix_close)} sparkColor={c.series[0]}
            info="Thresholds: green below 15 (calm), amber 15–20, red above 20 (stressed)." />
      <Stat w={4} label="ATM IV · 30-day" value={pct(ivLast?.iv_30d, 1)}
            sub={ivLast?.iv_30d != null && ivLast.rv_20d != null ? `IV − realised ${signed(ivLast.iv_30d - ivLast.rv_20d, 1)} pts` : undefined}
            spark={ivSpark.map((r) => r.iv_30d)} sparkColor={c.series[0]}
            info="At-the-money implied volatility interpolated to 30 days, % a year." />
      <Stat w={4} label="PCR (OI) · near expiry" value={num(last.near_pcr_oi, 2)}
            sub={d((r) => r.near_pcr_oi, (v) => signed(v, 2))} spark={spark.map((r) => r.near_pcr_oi)} sparkColor={c.series[0]}
            info="Put open interest ÷ call open interest, nearest expiry." />
      <Stat w={4} label="ATM straddle" value={pct(last.atm_straddle_pct, 2)}
            sub={`${num(last.atm_straddle, 0)} pts · ${last.days_to_expiry ?? '—'} days to expiry`}
            spark={spark.map((r) => r.atm_straddle_pct)} sparkColor={c.series[0]}
            info="ATM call + put on the nearest expiry, % of spot: the move priced in by expiry." />
      <Stat w={4} label="Futures basis" value={pct(last.basis_pct, 2, true)} valueClass={signClass(last.basis_pct)}
            sub={`Near month ${num(last.fut_close, 2)}`} spark={spark.map((r) => r.basis_pct)} sparkColor={c.series[0]}
            info="Near-month futures close vs spot close, %." />
    </DashRow>
  )
}

/* ================================================================== */
/* Price, levels, gauges                                               */
/* ================================================================== */

const PARTS: ClientType[] = ['FII', 'DII', 'Client', 'Pro']

function PriceRow(props: { daily: DailyMarket[]; rows: DailyMarket[]; participants: Parameters<typeof trendView>[1] }) {
  const c = useChartColors()
  const { daily, rows } = props
  const last = daily[daily.length - 1]
  const first = rows[0]?.spot_close
  const rangeChg = first && last.spot_close != null ? (last.spot_close / first - 1) * 100 : null
  const vixRank = pctRank(daily.slice(-252).map((r) => r.vix_close), last.vix_close)
  const lastDate = props.participants.length ? props.participants[props.participants.length - 1].trade_date : null
  const latestPos = props.participants.filter((p) => p.trade_date === lastDate)
  const cols: Column<DailyMarket>[] = [
    dateCol(),
    { label: 'Open', value: (r) => num(r.spot_open, 2) },
    { label: 'High', value: (r) => num(r.spot_high, 2) },
    { label: 'Low', value: (r) => num(r.spot_low, 2) },
    { label: 'Close', value: (r) => num(r.spot_close, 2) },
    { label: 'Change', value: (r) => <span className={signClass(r.spot_return_pct)}>{pct(r.spot_return_pct, 2, true)}</span> },
  ]
  return (
    <DashRow title="Price & levels">
      <ChartCard w={12} title="Nifty 50 · daily close" subtitle="Daily close over the selected range."
                 value={num(last.spot_close, 2)} change={<Change value={rangeChg} text={pct(rangeChg, 2, true)} />}
                 table={{ columns: cols, rows: [...rows].reverse() }}>
        <TimeSeriesChart rows={rows} syncId="market" height={300} format={(v) => num(v, 2)} axisFormat={(v) => num(v)}
                         series={[{ key: 'spot', label: 'Nifty 50', color: c.series[0], value: (r) => r.spot_close }]} />
      </ChartCard>
      <Levels last={last} />
      <div className="col w-6">
        <Panel title="India VIX · 1-year percentile" info="Where today's VIX sits in the last 252 sessions. Green: calm (below 40th). Amber: normal. Red: stressed (above 80th).">
          <Gauge value={vixRank} min={0} max={100} text={vixRank == null ? '—' : `${num(vixRank)}%`}
                 bands={bands(c, 40, 80)} note={`VIX ${num(last.vix_close, 2)}`} />
        </Panel>
        <Panel title="Index futures · long share" info="Long ÷ (long + short) index futures by participant, last session. The mark is 50%.">
          <BarGauge min={0} max={100} mark={50}
                    rows={PARTS.map((p, i) => {
                      const r = latestPos.find((x) => x.client_type === p)
                      const v = r?.fut_index_long_pct ?? null
                      return { label: <><span className="swatch-rect" style={{ background: c.series[i] }} />{p}</>, value: v, text: pct(v, 0), color: v == null ? c.muted : v >= 50 ? c.up : c.down }
                    })} />
        </Panel>
      </div>
    </DashRow>
  )
}

function bands(c: ChartColors, a: number, b: number) {
  return [{ to: a, color: c.good }, { to: b, color: c.warning }, { to: 100, color: c.critical }]
}

function Levels(props: { last: DailyMarket }) {
  const { last } = props
  const spot = last.spot_close
  const sup = last.max_pe_oi_strike, res = last.max_ce_oi_strike
  const lo = spot != null && last.atm_straddle != null ? spot - last.atm_straddle : null
  const hi = spot != null && last.atm_straddle != null ? spot + last.atm_straddle : null
  const pts = [sup, res, lo, hi, spot].filter((x): x is number => x != null)
  const min = Math.min(...pts), max = Math.max(...pts)
  const pad = (max - min) * 0.08 || 50
  const at = (x: number) => `${((x - (min - pad)) / (max - min + 2 * pad)) * 100}%`
  const dist = (x: number | null) => (x == null || spot == null ? null : ((x - spot) / spot) * 100)
  return (
    <Panel w={6} title={`Key levels · expiry ${date(last.near_expiry).slice(0, 6)}`}
           info="Resistance: strike with the most call OI. Support: strike with the most put OI (nearest expiry). Range high / low: spot ± the ATM straddle, the move options price in by expiry.">
      {pts.length >= 2 && (
        <div className="level-scale" role="img" aria-label={`Spot ${num(spot)} between support ${num(sup)} and resistance ${num(res)}`}>
          <div className="level-axis" />
          {lo != null && hi != null && <div className="level-band" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />}
          {sup != null && <div className="level-pin support" style={{ left: at(sup) }}><span>{num(sup)}</span></div>}
          {res != null && <div className="level-pin resist" style={{ left: at(res) }}><span>{num(res)}</span></div>}
          {spot != null && <div className="level-pin spot top" style={{ left: at(spot) }}><span>{num(spot)}</span></div>}
        </div>
      )}
      <div className="kv">
        <div className="k"><span className="key-dot" style={{ background: 'var(--down)' }} />Resistance</div>
        <div className="v">{num(res)}<small>{pct(dist(res), 1, true)}</small></div>
        <div className="k"><span className="key-dot" style={{ border: '1px solid var(--accent)' }} />Range high</div>
        <div className="v">{num(hi)}<small>{pct(dist(hi), 1, true)}</small></div>
        <div className="k"><span className="key-dot" style={{ background: 'var(--text-primary)' }} />Spot</div>
        <div className="v">{num(spot, 2)}<small /></div>
        <div className="k"><span className="key-dot" style={{ border: '1px solid var(--accent)' }} />Range low</div>
        <div className="v">{num(lo)}<small>{pct(dist(lo), 1, true)}</small></div>
        <div className="k"><span className="key-dot" style={{ background: 'var(--up)' }} />Support</div>
        <div className="v">{num(sup)}<small>{pct(dist(sup), 1, true)}</small></div>
        <div className="k">ATM · straddle</div>
        <div className="v">{num(last.atm_strike)}<small>{num(last.atm_straddle, 0)} pts</small></div>
      </div>
    </Panel>
  )
}

/* ================================================================== */
/* Volatility & sentiment time series                                  */
/* ================================================================== */

type Metric = {
  title: string; subtitle: string; value: (r: DailyMarket) => number | null
  format: (v: number) => string; deltaFormat: (v: number) => string; referenceY?: { y: number; label?: string }; note?: string
}

const METRICS: Metric[] = [
  { title: 'India VIX', subtitle: 'Expected 30-day volatility, % a year.', value: (r) => r.vix_close, format: (v) => num(v, 2), deltaFormat: (v) => signed(v, 2) },
  { title: 'Put-call ratio (OI)', subtitle: 'Nearest expiry: put OI ÷ call OI.', value: (r) => r.near_pcr_oi, format: (v) => num(v, 2), deltaFormat: (v) => signed(v, 2), referenceY: { y: 1 }, note: 'Above 1: more put than call open interest.' },
  { title: 'ATM straddle %', subtitle: 'Nearest expiry, % of spot.', value: (r) => r.atm_straddle_pct, format: (v) => pct(v, 2), deltaFormat: (v) => `${signed(v, 2)} pts`, note: 'Resets each expiry, so it saw-tooths.' },
  { title: 'Futures basis', subtitle: 'Near month: futures vs spot, %.', value: (r) => r.basis_pct, format: (v) => pct(v, 2), deltaFormat: (v) => `${signed(v, 2)} pts`, referenceY: { y: 0 } },
]

function VolRow(props: { rows: DailyMarket[]; ivRows: IvDaily[]; ivError: unknown }) {
  const c = useChartColors()
  const { rows, ivRows } = props
  const ivLast = ivRows[ivRows.length - 1]
  const volSeries = [
    { key: 'iv', label: 'ATM IV 30d', color: c.series[0], value: (r: IvDaily) => r.iv_30d },
    { key: 'vix', label: 'India VIX', color: c.series[1], value: (r: IvDaily) => r.vix_close },
    { key: 'rv', label: 'Realised 20d', color: c.series[2], value: (r: IvDaily) => r.rv_20d },
  ]
  const fmtVol = (v: number) => pct(v, 1)
  const volCols: Column<IvDaily>[] = [dateCol(), ...volSeries.map((s) => ({ label: s.label, value: (r: IvDaily) => { const v = s.value(r); return v == null ? '—' : fmtVol(v) } }))]
  const skewCols: Column<IvDaily>[] = [
    dateCol(),
    { label: 'Expiry', value: (r) => date(r.skew_expiry) },
    { label: '25Δ put IV', value: (r) => pct(r.iv_25d_put, 1) },
    { label: 'ATM IV', value: (r) => pct(r.skew_atm_iv, 1) },
    { label: '25Δ call IV', value: (r) => pct(r.iv_25d_call, 1) },
    { label: 'Risk reversal', value: (r) => num(r.rr_25d, 2) },
  ]
  const rrD = delta(ivRows, (r) => r.rr_25d)
  return (
    <DashRow title="Volatility & sentiment">
      {!props.ivError && (
        <>
          <ChartCard w={8} title="Implied vs realised volatility" subtitle="% a year." note="IV above realised: options priced rich vs recent moves."
                     value={pct(ivLast?.iv_30d, 1)}
                     legend={<Legend items={volSeries.map((s) => ({ label: s.label, color: s.color }))} />}
                     table={{ columns: volCols, rows: [...ivRows].reverse() }}>
            <TimeSeriesChart rows={ivRows} syncId="market" format={fmtVol} series={volSeries} height={190} />
          </ChartCard>
          <ChartCard w={8} title="Skew · 25Δ risk reversal" subtitle="Put IV − call IV, vol points." note="Above 0: downside protection costs more than upside calls."
                     value={num(ivLast?.rr_25d, 2)} change={rrD == null ? undefined : <Change value={rrD} text={signed(rrD, 2)} />}
                     table={{ columns: skewCols, rows: [...ivRows].reverse() }}>
            <TimeSeriesChart rows={ivRows} syncId="market" format={(v) => num(v, 2)} referenceY={{ y: 0 }} height={210}
                             series={[{ key: 'rr', label: 'Risk reversal', color: c.series[0], value: (r: IvDaily) => r.rr_25d }]} />
          </ChartCard>
        </>
      )}
      {METRICS.map((m) => {
        const lastV = rows.length ? m.value(rows[rows.length - 1]) : null
        const dd = delta(rows, m.value)
        const cols: Column<DailyMarket>[] = [dateCol(), { label: m.title, value: (r) => { const v = m.value(r); return v == null ? '—' : m.format(v) } }]
        return (
          <ChartCard key={m.title} w={8} title={m.title} subtitle={m.subtitle} note={m.note}
                     value={lastV == null ? '—' : m.format(lastV)}
                     change={dd == null ? undefined : <Change value={dd} text={m.deltaFormat(dd)} />}
                     table={{ columns: cols, rows: [...rows].reverse() }}>
            <TimeSeriesChart rows={rows} syncId="market" format={m.format} referenceY={m.referenceY} height={210}
                             series={[{ key: 'v', label: m.title, color: c.series[0], value: m.value }]} />
          </ChartCard>
        )
      })}
    </DashRow>
  )
}
