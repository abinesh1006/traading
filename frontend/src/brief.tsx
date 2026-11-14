/**
 * Market Brief: one presentation screen (1920×1080, scaled to the window) that summarises the day,
 * week or month: verdict first, then what happened, history, expected move, options, positioning
 * and the strategy idea. Built for screen recording: big type, at most a handful of numbers per
 * card, count-up numbers and a staggered reveal. Keys: D / W / M period, ← → cycle, F full screen,
 * Esc close.
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { historyCheck, ranges, suggest, trendView, volView, daysBetween, type Plan } from './analysis'
import { api } from './api'
import {
  dayLabel, eventShort, history, maxPain, mood, narrative, payoff, periodEvents, positioning, slice, upcomingEvents,
  type Mood, type Period, type PosRow,
} from './briefData'
import { num, pct } from './format'
import { closes, dayStats, nextWeekday, scenarioOdds, SCENARIO_NAME, SCENARIOS, sigmaOf, TRIGGER } from './sessionPlan'
import { useChartColors } from './theme'
import { useLive } from './useLive'
import { DISCLAIMER, useRecording } from './useRecording'
import { upcomingSession } from './useSessionModel'
import { useStrategyChain } from './useStrategyChain'
import './brief.css'

const W = 1920, H = 1080
const PERIODS: Array<{ p: Period; label: string }> = [{ p: 'D', label: 'Day' }, { p: 'W', label: 'Week' }, { p: 'M', label: 'Month' }]
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Number that counts up to its value when it mounts. */
function CountUp(props: { value: number | null | undefined; digits?: number; signed?: boolean; suffix?: string }) {
  const { value, digits = 0, signed = false, suffix = '' } = props
  const [shown, setShown] = useState<number | null>(value == null || reduced() ? value ?? null : value * (Math.abs(value) > 1000 ? 0.97 : 0))
  useEffect(() => {
    if (value == null || reduced()) return
    const from = value * (Math.abs(value) > 1000 ? 0.97 : 0)
    const t0 = performance.now(), dur = 900
    let raf = 0
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      setShown(from + (value - from) * (1 - Math.pow(1 - k, 3)))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  if (shown == null) return <>—</>
  const s = num(Math.abs(shown), digits)
  return <>{signed ? (shown > 0 ? '+' : shown < 0 ? '−' : '') : shown < 0 ? '−' : ''}{s}{suffix}</>
}

const delay = (i: number): CSSProperties => ({ animationDelay: `${120 + i * 90}ms` })
const toneOf = (v: number | null | undefined) => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down')

function Card(props: { title: string; i: number; className?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={`bf-card ${props.className ?? ''}`} style={delay(props.i)}>
      <div className="bf-card-head"><span>{props.title}</span>{props.aside}</div>
      {props.children}
    </section>
  )
}

/** Fit the fixed 1920×1080 stage into the window. */
function useStageScale() {
  const [s, setS] = useState(() => Math.min(window.innerWidth / W, window.innerHeight / H))
  useEffect(() => {
    const on = () => setS(Math.min(window.innerWidth / W, window.innerHeight / H))
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return s
}

export function Brief(props: { onClose: () => void }) {
  // ?p=W or ?p=M opens straight on that period (handy as a bookmark for recording).
  const [period, setPeriod] = useState<Period>(() => {
    const p = new URLSearchParams(window.location.search).get('p')?.toUpperCase()
    return p === 'W' || p === 'M' ? p : 'D'
  })
  const root = useRef<HTMLDivElement>(null)
  const scale = useStageScale()
  const daily = useQuery({ queryKey: ['daily'], queryFn: api.daily })
  const ivq = useQuery({ queryKey: ['iv'], queryFn: api.iv })
  const pq = useQuery({ queryKey: ['participants'], queryFn: api.participants })
  const evq = useQuery({ queryKey: ['events'], queryFn: api.events })
  const live = useLive()
  const all = daily.data ?? []
  const chain = useStrategyChain(all[all.length - 1]?.trade_date)
  const rec = useRecording()
  const nextSession = upcomingSession(live.data, all[all.length - 1]?.trade_date)

  const { onClose } = props
  useEffect(() => {
    const order: Period[] = ['D', 'W', 'M']
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'escape') onClose()
      else if (k === 'd' || k === 'w' || k === 'm') setPeriod(k.toUpperCase() as Period)
      else if (k === 'arrowright' || k === 'arrowleft') {
        setPeriod((p) => order[(order.indexOf(p) + (k === 'arrowright' ? 1 : 2)) % 3])
      } else if (k === 'f') {
        if (document.fullscreenElement) document.exitFullscreen()
        else root.current?.requestFullscreen?.()
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const left = (window.innerWidth - W * scale) / 2, top = (window.innerHeight - H * scale) / 2

  return (
    <div className="bf-overlay" ref={root} role="dialog" aria-modal="true" aria-label="Market brief">
      <div className="bf-stage" style={{ transform: `scale(${scale})`, left, top }}>
        {all.length < 200 ? (
          <div className="bf-loading"><div className="spinner" />Loading the brief…</div>
        ) : (
          <BriefCanvas key={period} period={period} setPeriod={setPeriod} onClose={onClose}
                       daily={all} iv={ivq.data ?? []} participants={pq.data ?? []} events={evq.data ?? []}
                       chain={chain} marketLabel={live.data?.market.label} marketState={live.data?.market.state}
                       rec={rec} nextSession={nextSession} />
        )}
      </div>
    </div>
  )
}

function BriefCanvas(props: {
  period: Period; setPeriod: (p: Period) => void; onClose: () => void
  daily: Parameters<typeof slice>[0]; iv: Parameters<typeof volView>[0]
  participants: Parameters<typeof positioning>[0]; events: Parameters<typeof periodEvents>[0]
  chain?: Parameters<typeof suggest>[2]; marketLabel?: string; marketState?: string
  rec: boolean; nextSession?: string
}) {
  const { daily, iv, participants, events, chain } = props
  const s = slice(daily, props.period)!
  const last = s.last
  const trend = trendView(daily, participants)
  const h = history(daily)
  const md = mood(daily, participants, trend, h)
  const pos = positioning(participants, s)
  const story = narrative(daily, s, pos, events)
  const vv = volView(iv, daily)
  const hist = trend ? historyCheck(daily, trend.verdict) : null
  const dte = chain ? daysBetween(chain.trade_date, chain.expiry) : last.days_to_expiry
  const rg = vv.iv != null ? ranges(last.spot_close, vv.iv, dte, last.atm_straddle) : null
  const plan = trend && chain && dte != null ? suggest(trend, vv, chain, dte) : null
  const special = events.find((e) => e.category === 'special_session' && e.event_date === last.trade_date)
  const next = upcomingEvents(events, last.trade_date, 3)
  const ivLast = iv[iv.length - 1]

  return (
    <div className="bf-canvas">
      {/* ---------- Header ---------- */}
      <header className="bf-head" style={delay(0)}>
        <div className="bf-quote">
          <div className="bf-kicker">NIFTY 50 · {props.period === 'D' ? 'Daily' : props.period === 'W' ? 'Weekly' : 'Monthly'} brief</div>
          <div className="bf-price"><CountUp value={last.spot_close} digits={2} /></div>
          <div className={`bf-chg ${toneOf(s.ret)}`}>
            {s.ret != null && (s.ret >= 0 ? '▲' : '▼')} <CountUp value={s.pts} digits={2} signed /> pts&nbsp;&nbsp;(<CountUp value={s.ret} digits={2} signed suffix="%" />)
            <span className="bf-chg-label">{props.period === 'D' ? 'on the day' : props.period === 'W' ? 'this week' : 'this month'}</span>
          </div>
        </div>
        <div className="bf-title">
          <div className="bf-title-main">{s.title}</div>
          <div className="bf-title-sub">
            {props.period === 'D' && special ? `${special.name.replace(/\s*\(.*\)$/, '')} · ` : ''}{s.rows.length} session{s.rows.length === 1 ? '' : 's'}
            {props.period !== 'D' && special ? ` · incl. ${special.name.replace(/\s*\(.*\)$/, '')}` : ''}
            {props.marketLabel && <span className={`bf-mkt st-${props.marketState}`}><span className="dot" />{props.marketLabel}</span>}
          </div>
        </div>
        <div className="bf-controls">
          <div className="bf-seg" role="group" aria-label="Period">
            {PERIODS.map((x) => (
              <button key={x.p} aria-pressed={props.period === x.p} onClick={() => props.setPeriod(x.p)}>{x.label}</button>
            ))}
          </div>
          <button className="bf-close" onClick={props.onClose} aria-label="Close brief">✕</button>
        </div>
      </header>

      {/* ---------- Row 1: mood · what happened · history ---------- */}
      <div className="bf-row bf-row1">
        <Card title="Market mood" i={1} className="bf-mood"
              aside={trend && (
                <span className={`bf-chip ${trend.verdict === 'Bullish' ? 'good' : trend.verdict === 'Bearish' ? 'critical' : 'warning'}`}
                      title={`${trend.signals.filter((x) => x.vote > 0).length} of ${trend.max} price rules bullish`}>
                  Trend {trend.verdict}
                </span>
              )}>
          {md ? <MoodGauge m={md} /> : <div className="muted">Not enough data</div>}
        </Card>
        <Card title="What happened" i={2} className="bf-story">
          <ol className="bf-sentences">
            {story.map((t, i) => <li key={i} style={delay(3 + i)} className={i === 0 ? 'lead' : undefined}>{t}</li>)}
          </ol>
        </Card>
        <Card title="History" i={3} className="bf-history">
          {h && (
            <>
              <div className="bf-returns">
                {h.returns.map((r) => (
                  <div key={r.label}><span>{r.label}</span><b className={toneOf(r.ret)}>{pct(r.ret, 1, true)}</b></div>
                ))}
                <div><span>From high</span><b className={toneOf(h.fromHigh)}>{pct(h.fromHigh, 1)}</b></div>
              </div>
              <div className="bf-52">
                <div className="bf-52-track"><div className="bf-52-dot" style={{ left: `${h.pos52}%` }} /></div>
                <div className="bf-52-labels"><span>52-week low {num(h.low52)}</span><span>high {num(h.high52)}</span></div>
              </div>
              <div className="bf-facts">
                <div><span>Streak</span><b className={toneOf(h.streak)}>{Math.abs(h.streak)} {h.streak > 0 ? 'up' : 'down'} day{Math.abs(h.streak) === 1 ? '' : 's'}</b></div>
                <div><span>Next event</span><b title={next[0]?.name}>{next[0] ? eventShort(next[0]) : '—'}</b></div>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* ---------- Row 2: expected move · options · positioning · strategy ---------- */}
      <div className="bf-row bf-row2">
        <Card title="Expected move" i={4}>
          {rg ? (
            <div className="bf-moves">
              <div><span>Next session</span><b>±<CountUp value={rg.sigmaDay} /></b><small>{num(rg.spot - rg.sigmaDay)} – {num(rg.spot + rg.sigmaDay)}</small></div>
              {rg.sigmaExpiry != null && <div><span>To expiry · {rg.dte}d</span><b>±<CountUp value={rg.sigmaExpiry} /></b><small>{num(rg.spot - rg.sigmaExpiry)} – {num(rg.spot + rg.sigmaExpiry)}</small></div>}
              {hist && (
                <div className={`bf-edge ${hist.edge ? 'yes' : 'no'}`}>
                  Direction: {hist.edge ? 'a statistical tilt' : 'no reliable edge'} · up {num(hist.upPct, 0)}% after this setup vs {num(hist.baseUpPct, 0)}% on all days
                </div>
              )}
            </div>
          ) : <div className="muted">No volatility data</div>}
        </Card>
        <Card title="Options" i={5}>
          <div className="bf-kv">
            <div><span>Put-call ratio</span><b>{num(last.near_pcr_oi, 2)}</b></div>
            <div><span>Max pain</span><b>{chain ? num(maxPain(chain)) : '—'}</b></div>
            <div><span>Support (put OI)</span><b className="up">{num(last.max_pe_oi_strike)}</b></div>
            <div><span>Resistance (call OI)</span><b className="down">{num(last.max_ce_oi_strike)}</b></div>
            <div><span>ATM IV · VIX</span><b>{pct(ivLast?.iv_30d, 1)} · {num(last.vix_close, 2)}</b></div>
          </div>
        </Card>
        <Card title={`Who's positioned · ${props.period === 'D' ? 'day' : props.period === 'W' ? 'week' : 'month'} change`} i={6}>
          <Positioning rows={pos} />
        </Card>
        {props.rec ? (
          <Card title="Next session · 4 possibilities" i={7} className="bf-strategy">
            <NextOdds daily={daily} events={events} next={props.nextSession} />
          </Card>
        ) : (
          <Card title="Strategy idea" i={7} className="bf-strategy">
            {plan ? <StrategyCard plan={plan} spot={last.spot_close} /> : <div className="muted">Loading option chain…</div>}
          </Card>
        )}
      </div>

      <footer className="bf-foot" style={delay(8)}>
        <span>Data as of {dayLabel(last.trade_date)} {last.trade_date.slice(0, 4)} close · NSE end-of-day · {props.rec ? DISCLAIMER : 'rules-based, not investment advice'}</span>
        <span className="bf-keys"><kbd>D</kbd><kbd>W</kbd><kbd>M</kbd> period · <kbd>F</kbd> full screen · <kbd>Esc</kbd> close</span>
        <span className="bf-brand"><img src="/favicon.svg" alt="" />Nifty Quant</span>
      </footer>
    </div>
  )
}

/** Recording-mode stand-in for the strategy card: the next session's four outcomes and how often each happened. */
function NextOdds(props: { daily: Parameters<typeof slice>[0]; events: Parameters<typeof periodEvents>[0]; next?: string }) {
  const rows = closes(props.daily)
  const prev = rows[rows.length - 1]
  const sigma = prev ? sigmaOf(prev) : null
  const next = props.next ?? (prev ? nextWeekday(prev.trade_date) : undefined)
  const expiry = !!prev && !!next && prev.near_expiry === next
  const odds = next ? scenarioOdds(dayStats(props.daily, props.events), expiry, next) : null
  if (!prev || !sigma || !next || !odds) return <div className="muted">Not enough history</div>
  const up = prev.spot_close + TRIGGER * sigma, down = prev.spot_close - TRIGGER * sigma
  return (
    <div className="bf-next">
      <div className="bf-next-head">
        <b>{dayLabel(next)}</b>
        {expiry && <span className="bf-chip warning">Expiry</span>}
        <span>Band {num(down)} – {num(up)}</span>
      </div>
      <div className="bf-odds">
        {SCENARIOS.map((k) => (
          <div key={k} className="bf-odd">
            <span>{SCENARIO_NAME[k]}</span>
            <div className="bf-odd-bar"><i className={k === 'breakout' ? 'up' : k === 'breakdown' ? 'down' : ''} style={{ width: `${odds.share[k]}%` }} /></div>
            <b>{num(odds.share[k])}%</b>
          </div>
        ))}
      </div>
      <div className="bf-odd-note">Share of {num(odds.n)} past {expiry ? 'expiry days' : 'sessions'} since {odds.since.slice(0, 4)} · triggers ±0.5σ ({num(TRIGGER * sigma)} pts)</div>
    </div>
  )
}

function MoodGauge({ m }: { m: Mood }) {
  const c = useChartColors()
  const R = 150, cx = 180, cy = 172
  const pt = (v: number, r = R) => {
    const a = Math.PI * (1 - v / 100)
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const
  }
  const arc = (a: number, b: number) => {
    const [x0, y0] = pt(a), [x1, y1] = pt(b)
    return `M${x0},${y0} A${R},${R} 0 0 1 ${x1},${y1}`
  }
  const zones = [
    { a: 0, b: 25, color: c.critical }, { a: 25, b: 45, color: `color-mix(in srgb, ${c.critical} 55%, ${c.warning})` },
    { a: 45, b: 55, color: c.warning }, { a: 55, b: 75, color: `color-mix(in srgb, ${c.good} 60%, ${c.warning})` }, { a: 75, b: 100, color: c.good },
  ]
  const [nx, ny] = pt(m.score, R - 44)
  return (
    <div className="bf-gauge">
      <svg viewBox="0 0 360 190" aria-label={`Market mood ${Math.round(m.score)} of 100, ${m.zone}`} role="img">
        {zones.map((z) => <path key={z.a} d={arc(z.a + 0.8, z.b - 0.8)} style={{ stroke: z.color }} strokeWidth={22} fill="none" strokeLinecap="round" />)}
        <line x1={cx} y1={cy} x2={nx} y2={ny} className="bf-needle" strokeWidth={6} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={11} className="bf-needle-hub" />
      </svg>
      <div className={`bf-gauge-read ${m.tone}`}>
        <b><CountUp value={m.score} /><small>/100</small></b>
        <span>{m.zone}</span>
      </div>
      <div className="bf-parts">
        {m.parts.map((p) => (
          <div key={p.label} title={p.detail}>
            <span>{p.label}</span>
            <i><em style={{ width: `${p.value}%` }} /></i>
          </div>
        ))}
      </div>
    </div>
  )
}

function Positioning({ rows }: { rows: PosRow[] }) {
  return (
    <div className="bf-pos">
      {rows.map((r) => (
        <div key={r.key} className="bf-pos-row">
          <div className="bf-pos-top">
            <span className="who">{r.who}</span>
            <b className={r.longPct != null && r.longPct >= 50 ? 'up' : 'down'}>{pct(r.longPct, 0)} long</b>
            <small className={toneOf(r.netChange)}>{r.netChange == null ? '—' : `${r.netChange > 0 ? '+' : ''}${num(r.netChange)}`}</small>
          </div>
          <i><em className={r.longPct != null && r.longPct >= 50 ? 'l' : 's'} style={{ width: `${r.longPct ?? 0}%` }} /><u /></i>
        </div>
      ))}
      <div className="bf-pos-note">Long share of index futures · change in net contracts</div>
    </div>
  )
}

function StrategyCard({ plan, spot }: { plan: Plan | { stand: string; why: string[] }; spot: number }) {
  if ('stand' in plan) {
    return <div className="bf-stand"><b>{plan.stand}</b><p>{plan.why[plan.why.length - 1]}</p></div>
  }
  const lot = plan.lot ?? 0
  return (
    <div className="bf-plan">
      <div className="bf-plan-name">{plan.name}</div>
      <div className="bf-plan-legs">
        {plan.legs.map((l) => <span key={`${l.action}${l.type}${l.strike}`} className={l.action === 'Buy' ? 'buy' : 'sell'}>{l.action} {num(l.strike)} {l.type} @ {num(l.price, 1)}</span>)}
        <span className="exp">exp {dayLabel(plan.expiry)} · payoff at expiry, spot {num(spot)}</span>
      </div>
      <div className="bf-payoff-wrap">
        <Payoff plan={plan} spot={spot} />
      </div>
      <div className="bf-plan-kpis">
        <div><span>Max profit</span><b className="up">₹{num((plan.maxProfit ?? 0) * lot)}</b></div>
        <div><span>Max loss</span><b className="down">₹{num((plan.maxLoss ?? 0) * lot)}</b></div>
        <div><span>Breakeven</span><b>{plan.breakevens.map((b) => num(b)).join(' / ')}</b></div>
      </div>
    </div>
  )
}

function Payoff({ plan, spot }: { plan: Plan; spot: number }) {
  const pts = payoff(plan, spot)
  const Wd = 420, Ht = 130, pad = 6
  const xs = pts.map((p) => p.s), ys = pts.map((p) => p.pnl)
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const y0 = Math.min(...ys, 0), y1 = Math.max(...ys, 0)
  const X = (v: number) => pad + ((v - x0) / (x1 - x0)) * (Wd - 2 * pad)
  const Y = (v: number) => pad + ((y1 - v) / (y1 - y0 || 1)) * (Ht - 2 * pad)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.s).toFixed(1)},${Y(p.pnl).toFixed(1)}`).join('')
  const area = `${line}L${X(x1)},${Y(0)}L${X(x0)},${Y(0)}Z`
  const zy = Y(0)
  return (
    <svg className="bf-payoff" viewBox={`0 0 ${Wd} ${Ht}`} preserveAspectRatio="none" role="img" aria-label="Profit and loss at expiry">
      <defs>
        <clipPath id="bf-above"><rect x="0" y="0" width={Wd} height={zy} /></clipPath>
        <clipPath id="bf-below"><rect x="0" y={zy} width={Wd} height={Ht - zy} /></clipPath>
      </defs>
      <path d={area} clipPath="url(#bf-above)" className="bf-pay-up" />
      <path d={area} clipPath="url(#bf-below)" className="bf-pay-down" />
      <line x1={pad} x2={Wd - pad} y1={zy} y2={zy} className="bf-pay-zero" />
      <path d={line} className="bf-pay-line" fill="none" vectorEffect="non-scaling-stroke" />
      <line x1={X(spot)} x2={X(spot)} y1={pad} y2={Ht - pad} className="bf-pay-spot" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
