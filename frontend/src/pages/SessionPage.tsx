import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { api, type IntradayBar, type LiveView, type MarketEvent, type OptionChain } from '../api'
import { dayLabel, eventShort, payoff } from '../briefData'
import { ChartTooltip } from '../components/charts'
import { Change, DashRow, DataTable, Legend, PageHeader, Panel, QueryState, Stat, StatusBadge, type Column, type Tone } from '../components/ui'
import { compact, num, pct, signClass } from '../format'
import {
  baseRates, classify, closes, context, dayPlans, dayStats, dayType, levels, moveOdds, nextWeekday, review, scorePlan,
  reviewText, scenarioOdds, SCENARIO_NAME, SCENARIOS, sessionEvents, sigmaOf, TRIGGER,
  type Actual, type BaseRate, type Context, type DayPlan, type DayType, type Levels, type MoveOdd, type Odds, type Review,
  type Row, type ScenarioKey,
} from '../sessionPlan'
import { useChartColors } from '../theme'
import { useLive } from '../useLive'
import '../session.css'

const signed = (v: number, d = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), d)}`
const fullDay = (iso: string) => `${dayLabel(iso)} ${iso.slice(0, 4)}`
const istDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso))
const istTime = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
const evTime = (e: MarketEvent) => (e.event_time_ist ? ` ${istTime(e.event_time_ist)} IST` : '')

type View = 'pre' | 'post'
interface Outcome { plan: DayPlan; triggered: boolean; entry: number | null; pnl: number | null }

/** The session the next plan is for: today until its EOD lands, then the next open (live clock), else the next weekday. */
function upcomingSession(live: LiveView | undefined, last: string | undefined): string | undefined {
  if (!last) return undefined
  const m = live?.market
  if (m?.session_date && m.session_date > last) return m.session_date
  const nx = m?.next_open?.slice(0, 10)
  if (nx && nx > last) return nx
  return m ? undefined : nextWeekday(last)
}

/** Today's numbers from the live feed, for a provisional review before NSE publishes the close. */
function liveActual(live: LiveView | undefined, d: string): Actual | null {
  const q = live?.quotes.find((x) => x.key === 'nifty'), v = live?.quotes.find((x) => x.key === 'vix')
  if (!q || q.source !== 'live' || !q.as_of || istDate(q.as_of) !== d || q.open == null || q.high == null || q.low == null || q.ltp == null) return null
  return { open: q.open, high: q.high, low: q.low, close: q.ltp, vix: v?.ltp ?? null, provisional: true }
}

/** The chain the plan trades: the first expiry after the previous close (a series expiring that day is no use next morning). */
function usePlanChain(b: string | undefined) {
  const c1 = useQuery({ queryKey: ['chain', b, undefined], queryFn: () => api.chain(b!), enabled: !!b })
  const next = c1.data && c1.data.expiry <= c1.data.trade_date ? c1.data.expiries.find((e) => e > c1.data!.trade_date) : undefined
  const c2 = useQuery({ queryKey: ['chain', b, next], queryFn: () => api.chain(b!, next), enabled: !!next })
  return { chain: next ? c2.data : c1.data, error: c1.error ?? c2.error, loading: c1.isLoading || (!!next && c2.isLoading) }
}

export function SessionPage() {
  const dq = useQuery({ queryKey: ['daily'], queryFn: api.daily })
  const pq = useQuery({ queryKey: ['participants'], queryFn: api.participants })
  const eq = useQuery({ queryKey: ['events'], queryFn: api.events })
  const live = useLive()
  const [params, setParams] = useSearchParams()

  const rows = useMemo(() => closes(dq.data ?? []), [dq.data])
  const events = useMemo(() => eq.data ?? [], [eq.data])
  const stats = useMemo(() => dayStats(dq.data ?? [], events), [dq.data, events])
  const upcoming = upcomingSession(live.data, rows.at(-1)?.trade_date)
  const sessions = useMemo(() => {
    const xs = rows.slice(-250).map((r) => r.trade_date).reverse()
    return upcoming ? [upcoming, ...xs] : xs
  }, [rows, upcoming])
  const asked = params.get('d')
  const d = asked && sessions.includes(asked) ? asked : sessions[0]
  const iD = rows.findIndex((r) => r.trade_date === d)
  const b = iD >= 0 ? iD - 1 : rows.length - 1
  const prev: Row | undefined = rows[b]
  const { chain, error: chainError, loading: chainLoading } = usePlanChain(prev?.trade_date)

  // What actually happened: the NSE close, or the live feed while today's close is not loaded yet.
  const eod = iD >= 0 ? rows[iD] : undefined
  const actual: Actual | null = eod && eod.spot_open != null && eod.spot_high != null && eod.spot_low != null
    ? { open: eod.spot_open, high: eod.spot_high, low: eod.spot_low, close: eod.spot_close, vix: eod.vix_close, provisional: false }
    : d ? liveActual(live.data, d) : null
  const wanted = params.get('v')
  const view: View = wanted === 'post' && actual ? 'post' : wanted === 'pre' ? 'pre' : eod ? 'post' : 'pre'
  const expiryDay = !!chain && chain.expiry === d
  const chainD = useQuery({
    queryKey: ['chain', d, chain?.expiry], queryFn: () => api.chain(d!, chain!.expiry),
    enabled: !!eod && !!chain && !expiryDay && chain.expiry > (d ?? ''),
  })

  const go = (s: string) => setParams({ d: s })
  const setView = (v: View) => setParams({ d: d!, v })
  const idx = d ? sessions.indexOf(d) : -1

  const sigma = prev ? sigmaOf(prev) : null
  const type = prev && d ? dayType(rows, b, d, events) : null
  const lv = prev && chain && sigma ? levels(prev, chain, sigma, compact) : null
  const plans = prev && chain && sigma && lv ? dayPlans(prev, chain, sigma, lv) : []
  const odds = type && d ? scenarioOdds(stats, type.expiry, d) : null
  const moves = type && d ? moveOdds(stats, type.expiry, d) : []
  const ctx = prev && b >= 5 ? context(rows, b, pq.data ?? []) : null
  const rates = type && ctx && d ? baseRates(stats, { expiry: type.expiry, afterSpecial: !!type.afterSpecial, verdict: ctx.trend?.verdict, r5: ctx.r5, rsi: ctx.rsi }, d) : []
  const evs = d ? sessionEvents(events, d) : { during: [], after: [] }
  const rv = prev && actual && sigma && lv ? review(prev, actual, sigma, lv) : null
  // Each plan enters when its rule fires: the condor at the open, a spread at its trigger.
  const outcomes: Outcome[] = rv && prev && lv && chain ? plans.map((p) => {
    const at = p.key === 'condor' ? rv.a.open : p.key === 'bull' ? lv.up : lv.down
    const s = scorePlan(p, chain, at - prev.spot_close, rv.a.close, expiryDay, chainD.data)
    return {
      plan: p, entry: s?.entry ?? null, pnl: s?.pnl ?? null,
      triggered: p.key === 'condor' ? Math.abs(rv.gapZ) <= TRIGGER : p.key === 'bull' ? rv.brokeUp : rv.brokeDown,
    }
  }) : []
  const bars = (live.data?.bars ?? []).filter((x) => d && istDate(x.time) === d)
  const sessionOpen = live.data?.market.state === 'open' && live.data.market.session_date === d

  const header = (
    <PageHeader
      title="Pre / post market"
      sub={d && prev ? <>
        {view === 'pre' ? 'Plan' : 'Review'} for <strong>{fullDay(d)}</strong> · built from the {dayLabel(prev.trade_date)} close
        {type?.afterSpecial ? ` (${type.afterSpecial.name.replace(/\s*\(.*\)$/, '')})` : ''}{type?.thinPrev ? ', a thin session' : ''}
      </> : 'Session plan before the open, and how it played out after the close'}
      actions={sessions.length > 0 && d ? (
        <>
          <div className="sp-pick" role="group" aria-label="Session">
            <span className="lbl">Session</span>
            <button className="sp-step" onClick={() => go(sessions[idx + 1])} disabled={idx >= sessions.length - 1} aria-label="Previous session">‹</button>
            <select value={d} onChange={(e) => go(e.target.value)} aria-label="Pick a session">
              {sessions.map((s) => <option key={s} value={s}>{fullDay(s)}{s === upcoming ? ' · next' : ''}</option>)}
            </select>
            <button className="sp-step" onClick={() => go(sessions[idx - 1])} disabled={idx <= 0} aria-label="Next session">›</button>
          </div>
          <div className="seg" role="group" aria-label="View">
            <button aria-pressed={view === 'pre'} onClick={() => setView('pre')}>Pre-market</button>
            <button aria-pressed={view === 'post'} onClick={() => setView('post')} disabled={!actual}
                    title={actual ? undefined : 'Available once the session has traded'}>Post-market</button>
          </div>
        </>
      ) : undefined}
    />
  )

  return (
    <>
      {header}
      <QueryState error={dq.error ?? chainError} isLoading={dq.isLoading || eq.isLoading || chainLoading}>
        {!prev || !d || !type || !sigma || !lv || !chain ? (
          <div className="state-box"><div className="state-title">Not enough data for this session</div><div className="state-detail">The plan needs the previous session's close, India VIX and option chain.</div></div>
        ) : (
          <>
            {view === 'post' && rv && <ReviewRow rv={rv} lv={lv} outcomes={outcomes} sigma={sigma} expiryDay={expiryDay}
                                                  next={idx > 0 ? sessions[idx - 1] : undefined} onNext={go} />}
            {view === 'pre' && <SetupRow d={d} prev={prev} type={type} sigma={sigma} lv={lv} ctx={ctx} evs={evs} />}
            {bars.length >= 2 && <IntradayPlan bars={bars} prev={prev} sigma={sigma} lv={lv} plans={plans} live={sessionOpen} />}
            <ScenarioRow d={d} odds={odds} lv={lv} plans={plans} type={type} sigma={sigma} evs={evs}
                         hit={view === 'post' ? rv?.scenario : undefined}
                         now={view === 'pre' && rv?.a.provisional ? rv.scenario : undefined} />
            <PlansRow plans={plans} prev={prev} outcomes={view === 'post' ? outcomes : []} expiryDay={expiryDay} close={view === 'post' ? rv?.a.close : undefined} />
            <LevelsRow prev={prev} chain={chain} sigma={sigma} lv={lv} actual={view === 'post' ? actual : null} />
            <OddsRow moves={moves} sigma={sigma} prev={prev} rates={rates} type={type} odds={odds} open={view === 'pre'} />
            {ctx && <ContextRow ctx={ctx} prev={prev} open={view === 'pre'} />}
          </>
        )}
      </QueryState>
    </>
  )
}

/* ================================================================== */
/* Pre-market: the setup                                               */
/* ================================================================== */

function SetupRow(props: { d: string; prev: Row; type: DayType; sigma: number; lv: Levels; ctx: Context | null; evs: { during: MarketEvent[]; after: MarketEvent[] } }) {
  const { d, prev, type, sigma, lv, ctx, evs } = props
  const vix = prev.vix_close
  const vixTone: Tone | undefined = vix == null ? undefined : vix < 15 ? 'good' : vix <= 20 ? 'warning' : 'critical'
  const ev = evs.during[0] ?? evs.after[0]
  const tags = [
    type.expiry ? 'Nifty expiry' : 'Normal session',
    type.shiftedFrom ? `moved from ${type.shiftedFrom}` : null,
    type.special ? type.special.name.replace(/\s*\(.*\)$/, '') : null,
  ].filter(Boolean).join(' · ')
  return (
    <DashRow title="Setup · before the open">
      <Stat w={4} label="Session" value={dayLabel(d)} sub={tags} tone={type.expiry ? 'warning' : undefined}
            info={<><p>Expiry days and normal days each get their own history below.</p>{type.shiftedFrom && <p>The expiry usually falls on a {type.shiftedFrom}; this week it moved, normally because of an exchange holiday.</p>}</>} />
      <Stat w={4} label="Previous close" value={num(prev.spot_close, 2)} valueClass={signClass(prev.spot_return_pct)}
            sub={<><Change value={prev.spot_return_pct} text={pct(prev.spot_return_pct, 2, true)} /> · {dayLabel(prev.trade_date)}{type.thinPrev ? ' · thin volume' : ''}</>}
            info="Every level and range on this page is measured from this close." />
      <Stat w={4} label="Expected move · 1σ" value={<>±{num(sigma)} <small className="unit">pts</small></>}
            sub={`${num(prev.spot_close - sigma)} – ${num(prev.spot_close + sigma)}${type.expiry && prev.atm_straddle != null ? ` · straddle ${num(prev.atm_straddle)}` : ''}`}
            info={<><p>One session's standard deviation from India VIX: VIX ÷ √252 × the previous close.</p><p>On an expiry day the at-the-money straddle prices the same thing directly; the two should be close.</p></>} />
      <Stat w={4} label={`Triggers · ±${TRIGGER}σ`} value={`${num(lv.down)} – ${num(lv.up)}`} valueClass="sm"
            sub="Close outside = trend; inside = range"
            info="Half a standard deviation either side of the previous close. Where the session closes against these decides which of the four scenarios played out." />
      <Stat w={4} label="India VIX" value={num(vix, 2)} tone={vixTone}
            sub={ctx ? `${ctx.vixPct == null ? '—' : `${num(ctx.vixPct)}th pct (1y)`} · ${ctx.vixChg5 == null ? '' : `${signed(ctx.vixChg5, 1)}% in 5d`}` : undefined}
            info="Higher VIX means wider ranges in both directions; every range on this page scales with it." />
      <Stat w={4} label="Event risk" value={ev ? eventShort(ev).split(' · ')[0] : 'None'} valueClass="sm"
            tone={ev ? 'warning' : 'good'}
            sub={ev ? `${dayLabel(ev.event_date)}${evTime(ev)} · ${evs.during.includes(ev) ? 'during the session' : 'after the close'}` : 'No RBI, Fed, US CPI or budget scheduled'}
            info="Scheduled macro events during the session, or between its close and the next weekday's open (overnight risk for positions carried)." />
    </DashRow>
  )
}

/* ================================================================== */
/* The four possibilities                                              */
/* ================================================================== */

/** A tiny drawing of each scenario's path against the two trigger lines. */
function Glyph({ k }: { k: ScenarioKey }) {
  const path = {
    quiet: 'M2,16 C10,12 14,20 22,15 S34,12 40,17 S54,19 62,15',
    fakeout: 'M2,16 C10,14 16,12 22,8 S30,2 34,6 S42,15 48,16 S58,14 62,15',
    breakout: 'M2,18 C10,19 16,15 24,11 S36,6 44,5 S56,4 62,3',
    breakdown: 'M2,14 C10,13 16,17 24,21 S36,26 44,27 S56,28 62,29',
  }[k]
  const tone = k === 'breakout' ? 'up' : k === 'breakdown' ? 'down' : 'neutral'
  return (
    <svg className={`sc-glyph ${tone}`} viewBox="0 0 64 32" aria-hidden="true">
      <line x1="0" x2="64" y1="9" y2="9" className="trig" />
      <line x1="0" x2="64" y1="23" y2="23" className="trig" />
      <path d={path} className="path" />
    </svg>
  )
}

function ScenarioRow(props: {
  d: string; odds: Odds | null; lv: Levels; plans: DayPlan[]; type: DayType; sigma: number
  evs: { during: MarketEvent[]; after: MarketEvent[] }; hit?: ScenarioKey; now?: ScenarioKey
}) {
  const { odds, lv, plans, type, hit, now } = props
  const plan = (k: DayPlan['key']) => plans.find((p) => p.key === k)
  const condor = plan('condor'), bull = plan('bull'), bear = plan('bear')
  const strikes = (p?: DayPlan) => (p ? p.legs.map((l) => num(l.strike)).join(' / ') : '—')
  const what: Record<ScenarioKey, string> = {
    quiet: `Stays inside ${num(lv.down)} – ${num(lv.up)} all session.`,
    fakeout: `Breaks ${num(lv.up)} or ${num(lv.down)}, then closes back inside.`,
    breakout: `Holds above ${num(lv.up)} into the close.`,
    breakdown: `Holds below ${num(lv.down)} into the close.`,
  }
  const todo: Record<ScenarioKey, ReactNode> = {
    quiet: condor ? <>Iron condor {strikes(condor)} keeps the full credit.</> : 'Sell premium with defined risk.',
    fakeout: <>The condor survives. A breakout entry gets stopped out, so keep stops tight and don't re-enter the same side.</>,
    breakout: bull ? <>Bull call spread {strikes(bull)} → {num(bull.target)}. Condor: close the call side.</> : 'Buy a call spread.',
    breakdown: bear ? <>Bear put spread {strikes(bear)} → {num(bear.target)}. Condor: close the put side.</> : 'Buy a put spread.',
  }
  const top = odds ? SCENARIOS.reduce((a, k) => (odds.share[k] > odds.share[a] ? k : a), SCENARIOS[0]) : null
  const kind = type.expiry ? 'expiry days' : 'non-expiry sessions'
  return (
    <DashRow title={hit ? 'Possibilities · which one happened' : 'Possibilities · how the session can go'}>
      {SCENARIOS.map((k) => {
        const cls = hit ? (hit === k ? 'hit' : 'dim') : now === k ? 'now' : top === k ? 'featured' : ''
        return (
          <Panel key={k} w={6} className={`sc-card ${cls}`} title={SCENARIO_NAME[k]}
                 right={hit === k ? <StatusBadge kind="good" label="Happened" /> : now === k ? <StatusBadge kind="warning" label="So far" /> : top === k && !hit ? <span className="sc-tag">Most common</span> : undefined}
                 info={<><p>Share of past {kind} since {odds ? odds.since.slice(0, 4) : '—'} that ended this way, each measured in σ of its own previous close, so calm and volatile years compare fairly.</p><p>History, not a forecast: earlier tests found no reliable daily direction signal.</p></>}>
            <div className="sc-body">
              <div className="sc-top">
                <div>
                  <div className="sc-pct">{odds ? `${num(odds.share[k])}%` : '—'}</div>
                  <div className="sc-n">{odds ? `of ${num(odds.n)} ${kind} · last 2y ${num(odds.recent[k])}%` : 'not enough history'}</div>
                </div>
                <Glyph k={k} />
              </div>
              <div className="sc-bar"><span className={k === 'breakout' ? 'up' : k === 'breakdown' ? 'down' : ''} style={{ width: `${odds?.share[k] ?? 0}%` }} /></div>
              <div className="sc-what">{what[k]}</div>
              <div className="sc-do"><span>Plan</span>{todo[k]}</div>
            </div>
          </Panel>
        )
      })}
      <GamePlan d={props.d} odds={odds} lv={lv} condor={condor} bull={bull} bear={bear} type={type} sigma={props.sigma} evs={props.evs} />
    </DashRow>
  )
}

function GamePlan(props: {
  d: string; odds: Odds | null; lv: Levels; condor?: DayPlan; bull?: DayPlan; bear?: DayPlan; type: DayType; sigma: number
  evs: { during: MarketEvent[]; after: MarketEvent[] }
}) {
  const { odds, lv, condor, bull, bear, type, sigma, evs } = props
  const close = props.d >= '2026-08-03' ? '15:40' : '15:30'
  const after = evs.after[0]
  const steps: Array<{ t: string; h: string; body: ReactNode }> = [
    { t: '09:00', h: 'Pre-open', body: <>An open beyond {num(lv.up)} or {num(lv.down)} ({odds ? `${num(odds.gapUp)}% / ${num(odds.gapDown)}%` : '—'} of past days) means skip the condor and wait until 10:00; trade the direction only if the gap holds.</> },
    { t: '09:15', h: 'Wait', body: <>No trades for 30 minutes. Let the opening range form and note its high and low.</> },
    { t: '09:45', h: 'Decide', body: <>Inside the triggers: iron condor {condor ? condor.legs.map((l) => num(l.strike)).join('/') : ''}. A 15-minute close above {num(lv.up)}: {bull ? 'bull call spread' : 'call spread'}; below {num(lv.down)}: {bear ? 'bear put spread' : 'put spread'}.</> },
    { t: '12:00', h: 'Manage', body: <>Book 50–60% of the condor credit when it is there. Close the threatened side within {num(Math.round((sigma * 0.2) / 5) * 5)} pts of a short strike.</> },
    {
      t: type.expiry ? '15:00' : '15:15', h: type.expiry ? 'Expiry' : 'Square off',
      body: type.expiry
        ? <>Exit directional spreads. Short strikes near spot settle at the {close} close; don't hold a near-the-money short into it.</>
        : <>Close intraday trades by {close}. Carry only defined-risk positions{after ? <>: {eventShort(after).split(' · ')[0]} lands {dayLabel(after.event_date)}{evTime(after)}</> : ''}.</>,
    },
  ]
  return (
    <Panel w={24} title={`Game plan · ${dayLabel(props.d)}`} info="The same rules every day; only the levels change. A checklist, not a backtested system: fills, slippage and charges are not modelled.">
      <ol className="gp">
        {steps.map((s) => (
          <li key={s.t}>
            <div className="gp-t">{s.t}<span>{s.h}</span></div>
            <div className="gp-b">{s.body}</div>
          </li>
        ))}
      </ol>
    </Panel>
  )
}

/* ================================================================== */
/* Strategies                                                          */
/* ================================================================== */

function PayoffMini(props: { plan: DayPlan; spot: number; close?: number }) {
  const c = useChartColors()
  const id = useId().replace(/:/g, '')
  const data = payoff(props.plan, props.spot).map((p) => ({ s: Math.round(p.s), pnl: Math.round(p.pnl) }))
  const max = Math.max(...data.map((x) => x.pnl)), min = Math.min(...data.map((x) => x.pnl))
  const off = max <= 0 ? 0 : min >= 0 ? 1 : max / (max - min)
  return (
    <div className="pay-mini">
      <ResponsiveContainer width="100%" height={128}>
        <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
              <stop offset={0} stopColor={c.up} stopOpacity={0.34} /><stop offset={off} stopColor={c.up} stopOpacity={0.06} />
              <stop offset={off} stopColor={c.down} stopOpacity={0.06} /><stop offset={1} stopColor={c.down} stopOpacity={0.34} />
            </linearGradient>
            <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
              <stop offset={off} stopColor={c.up} /><stop offset={off} stopColor={c.down} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={c.grid} strokeDasharray="3 5" vertical={false} />
          <XAxis dataKey="s" type="number" domain={['dataMin', 'dataMax']} axisLine={false} tickLine={false} tickCount={4}
                 tick={{ fill: c.muted, fontSize: 11 }} tickFormatter={(v: number) => num(v)} />
          <YAxis width={52} axisLine={false} tickLine={false} tick={{ fill: c.muted, fontSize: 11 }} tickCount={3}
                 tickFormatter={(v: number) => `${v < 0 ? '−' : ''}₹${compact(Math.abs(v))}`} />
          <ReferenceLine y={0} stroke={c.axis} />
          <ReferenceLine x={props.spot} stroke={c.accent} strokeDasharray="3 3" />
          {props.close != null && <ReferenceLine x={props.close} stroke={c.text} strokeWidth={1.5} />}
          <Tooltip cursor={{ stroke: c.muted, strokeDasharray: '3 3' }} isAnimationActive={false}
                   content={(p) => <ChartTooltip {...p} format={(v) => `₹${num(v)} / lot`} labelFormat={(s) => `Nifty ${num(Number(s))} at expiry`} />} />
          <Area dataKey="pnl" name="P&L" type="linear" stroke={`url(#${id}s)`} strokeWidth={2} fill={`url(#${id}f)`} baseValue={0}
                isAnimationActive={false} activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2, fill: c.text }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function PlansRow(props: { plans: DayPlan[]; prev: Row; outcomes: Outcome[]; expiryDay: boolean; close?: number }) {
  if (!props.plans.length) return null
  return (
    <DashRow title="Strategies · one defined-risk trade per possibility">
      {props.plans.map((p) => {
        const o = props.outcomes.find((x) => x.plan.key === p.key)
        const rupees = (pts: number) => `₹${num(pts * p.lot)}`
        const credit = p.credit >= 0
        return (
          <Panel key={p.key} w={8} title={p.name} className={p.key === 'condor' ? 'featured' : undefined}
                 right={<span className="sc-tag">{p.covers.map((k) => SCENARIO_NAME[k]).join(' · ')}</span>}
                 info={<><p>Strikes from the previous close's chain, expiry {fullDay(p.expiry)}. Prices are that close's; check live quotes before acting.</p><p>Rules-based research output, not investment advice; not backtested on intraday fills.</p></>}>
            <div className="mv">
              <table className="legs">
                <thead><tr><th>Action</th><th>Strike</th><th>Type</th><th>Premium</th><th>Δ</th></tr></thead>
                <tbody>
                  {p.legs.map((l) => (
                    <tr key={`${l.action}${l.type}${l.strike}`}>
                      <td><span className={`pill ${l.action === 'Buy' ? 'up' : 'down'}`}>{l.action}</span></td>
                      <td>{num(l.strike)}</td><td>{l.type}</td><td>{num(l.price, 2)}</td><td>{num(l.delta, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="plan-kpis">
                <div><span>{credit ? 'Credit' : 'Debit'}</span><b>{num(Math.abs(p.credit), 1)}</b><small>{rupees(Math.abs(p.credit))} / lot</small></div>
                <div><span>Max profit</span><b className="up">{rupees(p.maxProfit)}</b><small>{num(p.maxProfit, 1)} pts</small></div>
                <div><span>Max loss</span><b className="down">{rupees(p.maxLoss)}</b><small>{num(p.maxLoss, 1)} pts</small></div>
                <div><span>Breakeven</span><b>{p.breakevens.map((x) => num(x)).join(' / ')}</b><small>lot {num(p.lot)}</small></div>
              </div>
              <PayoffMini plan={p} spot={props.prev.spot_close} close={props.close} />
              {o ? (
                <div className={`sp-out ${!o.triggered ? 'skip' : o.pnl == null ? '' : o.pnl >= 0 ? 'win' : 'loss'}`}>
                  {!o.triggered
                    ? <>Not taken: {p.key === 'condor' ? 'the open was beyond a trigger.' : 'the trigger never traded.'}</>
                    : o.pnl == null
                      ? <>Taken. The close's option prices are not loaded yet.</>
                      : <>Taken at ~{num(Math.abs(o.entry ?? 0), 1)} {(o.entry ?? 0) >= 0 ? 'credit' : 'debit'} · {props.expiryDay ? 'settled' : 'marked'} at the close: <b>{signed(o.pnl, 1)} pts</b> ({o.pnl >= 0 ? '+' : '−'}₹{num(Math.abs(o.pnl * p.lot))} / lot)*</>}
                </div>
              ) : (
                <ul className="why">{p.rules.map((r) => <li key={r}>{r}</li>)}</ul>
              )}
            </div>
          </Panel>
        )
      })}
    </DashRow>
  )
}

/* ================================================================== */
/* Levels                                                              */
/* ================================================================== */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/**
 * Open-interest butterfly on a vertical price axis: puts to the left, calls to the right, the ±1σ
 * range shaded, triggers dashed. After the session, the day's high–low range is drawn on the spine.
 */
function LevelMap(props: { chain: OptionChain; prev: Row; sigma: number; lv: Levels; actual: Actual | null }) {
  const c = useChartColors()
  const [ref, W] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const { chain, prev, sigma, lv, actual } = props
  const lot = chain.lot_size || 1
  const spot = prev.spot_close
  let lo = spot - 3 * sigma, hi = spot + 3 * sigma
  for (const k of [...lv.callWalls, ...lv.putWalls]) { lo = Math.min(lo, k - sigma * 0.3); hi = Math.max(hi, k + sigma * 0.3) }
  if (actual) { lo = Math.min(lo, actual.low - sigma * 0.2); hi = Math.max(hi, actual.high + sigma * 0.2) }
  let strikes = chain.rows.filter((r) => r.strike >= lo && r.strike <= hi)
  if (strikes.length > 44) strikes = strikes.filter((r) => r.strike % 100 === 0)
  const H = Math.max(360, Math.min(620, strikes.length * 15 + 28))
  const padT = 12, padB = 12, AX = 56, GUT = W < 520 ? 92 : 128
  const y = (p: number) => padT + ((hi - p) / (hi - lo)) * (H - padT - padB)
  const cx = (AX + W - GUT) / 2, half = Math.max(10, (W - GUT - AX) / 2 - 8)
  const oi = strikes.map((r) => ({ k: r.strike, ce: (r.ce_oi_units ?? 0) / lot, pe: (r.pe_oi_units ?? 0) / lot, dce: (r.ce_oi_change_units ?? 0) / lot, dpe: (r.pe_oi_change_units ?? 0) / lot }))
  const maxOi = Math.max(1, ...oi.map((r) => Math.max(r.ce, r.pe)))
  const step = strikes.length > 1 ? Math.abs(y(strikes[0].strike) - y(strikes[1].strike)) : 12
  const barH = Math.max(3, Math.min(11, step - 3))
  const len = (v: number) => (v / maxOi) * half
  const labelEvery = step >= 13 ? 1 : 2

  // Right-gutter labels, nudged apart so none overlap.
  const marks = [
    { p: spot + sigma, text: `+1σ ${num(spot + sigma)}`, color: c.muted },
    { p: lv.up, text: `Trigger ${num(lv.up)}`, color: c.textSecondary },
    { p: spot, text: `Close ${num(spot)}`, color: c.accent },
    { p: lv.down, text: `Trigger ${num(lv.down)}`, color: c.textSecondary },
    { p: spot - sigma, text: `−1σ ${num(spot - sigma)}`, color: c.muted },
    ...(lv.maxPain != null ? [{ p: lv.maxPain, text: `Max pain ${num(lv.maxPain)}`, color: c.muted }] : []),
  ].map((m) => ({ ...m, y: y(m.p) })).sort((a, z) => a.y - z.y)
  const placed: number[] = []
  for (const m of marks) placed.push(Math.max(m.y + 4, (placed.at(-1) ?? -Infinity) + 13))

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    if (!oi.length) return
    const r = e.currentTarget.getBoundingClientRect()
    const p = hi - ((e.clientY - r.top - padT) / (H - padT - padB)) * (hi - lo)
    const near = oi.reduce((a, z) => (Math.abs(z.k - p) < Math.abs(a.k - p) ? z : a), oi[0])
    setHover(near?.k ?? null)
  }
  const h = hover != null ? oi.find((r) => r.k === hover) : undefined
  return (
    <div className="lmap" ref={ref}>
      {W > 0 && (
        <svg width={W} height={H} role="img" aria-label="Open interest by strike with today's levels" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <rect x={AX} y={y(spot + sigma)} width={W - GUT - AX} height={y(spot - sigma) - y(spot + sigma)} fill={c.accent} opacity={0.08} rx={6} />
          {h && <rect x={AX} y={y(h.k) - step / 2} width={W - GUT - AX} height={step} fill={c.text} opacity={0.06} />}
          {oi.map((r, i) => (
            <g key={r.k}>
              {r.pe > 0 && <rect x={cx - 1 - len(r.pe)} y={y(r.k) - barH / 2} width={len(r.pe)} height={barH} rx={Math.min(3, barH / 2)} fill={c.series[1]} opacity={hover == null || hover === r.k ? 0.9 : 0.45} />}
              {r.ce > 0 && <rect x={cx + 1} y={y(r.k) - barH / 2} width={len(r.ce)} height={barH} rx={Math.min(3, barH / 2)} fill={c.series[0]} opacity={hover == null || hover === r.k ? 0.9 : 0.45} />}
              {(i % labelEvery === 0 || r.k === hover) && (
                <text x={AX - 8} y={y(r.k) + 4} textAnchor="end" fontSize={11} fill={r.k === hover ? c.text : lv.callWalls.includes(r.k) || lv.putWalls.includes(r.k) ? c.textSecondary : c.muted}
                      fontWeight={lv.callWalls.includes(r.k) || lv.putWalls.includes(r.k) ? 650 : 400}>{num(r.k)}</text>
              )}
            </g>
          ))}
          <line x1={cx} x2={cx} y1={padT} y2={H - padB} stroke={c.grid} />
          {[lv.up, lv.down].map((p) => <line key={p} x1={AX} x2={W - GUT} y1={y(p)} y2={y(p)} stroke={c.textSecondary} strokeDasharray="5 4" strokeWidth={1.2} />)}
          {lv.maxPain != null && <line x1={AX} x2={W - GUT} y1={y(lv.maxPain)} y2={y(lv.maxPain)} stroke={c.muted} strokeDasharray="1 3" strokeWidth={1.5} />}
          <line x1={AX} x2={W - GUT} y1={y(spot)} y2={y(spot)} stroke={c.accent} strokeWidth={1.6} />
          {actual && (
            <g>
              <rect x={cx - 4} y={y(actual.high)} width={8} height={Math.max(2, y(actual.low) - y(actual.high))} rx={4} fill={c.text} opacity={0.88} />
              <line x1={cx - 10} x2={cx - 4} y1={y(actual.open)} y2={y(actual.open)} stroke={c.text} strokeWidth={2} />
              <circle cx={cx} cy={y(actual.close)} r={5.5} fill={c.accent} stroke={c.surface} strokeWidth={2.5} />
            </g>
          )}
          {marks.map((m, i) => (
            <g key={m.text}>
              <line x1={W - GUT + 2} x2={W - GUT + 8} y1={m.y} y2={placed[i] - 4} stroke={m.color} />
              <text x={W - GUT + 12} y={placed[i]} fontSize={11.5} fill={m.color} fontWeight={m.p === spot ? 650 : 500}>{m.text}</text>
            </g>
          ))}
        </svg>
      )}
      {h && (
        <div className="tt lmap-tt" style={{ top: Math.min(H - 96, Math.max(0, y(h.k) - 46)), left: Math.min(W - 200, cx + 16) }}>
          <div className="tt-head">Strike {num(h.k)} · {signed(h.k - spot)} pts from close</div>
          <div className="tt-row"><span className="swatch-rect" style={{ background: c.series[0] }} /><span className="tt-value">{compact(h.ce)}</span><span className="tt-name">calls ({signed(h.dce)} on the day)</span></div>
          <div className="tt-row"><span className="swatch-rect" style={{ background: c.series[1] }} /><span className="tt-value">{compact(h.pe)}</span><span className="tt-name">puts ({signed(h.dpe)} on the day)</span></div>
        </div>
      )}
    </div>
  )
}

function LevelsRow(props: { prev: Row; chain: OptionChain; sigma: number; lv: Levels; actual: Actual | null }) {
  const c = useChartColors()
  const { prev, lv } = props
  const kindLabel = { res: 'Resistance', sup: 'Support', pivot: 'Pivot', trig: 'Trigger', band: 'Range', spot: 'Close' } as const
  const legend = [
    { label: 'Call OI (resistance)', color: c.series[0], shape: 'rect' as const },
    { label: 'Put OI (support)', color: c.series[1], shape: 'rect' as const },
    { label: 'Previous close', color: c.accent },
    { label: 'Triggers ±0.5σ', color: c.textSecondary },
    ...(props.actual ? [{ label: 'Day range, close ●', color: c.text }] : []),
  ]
  return (
    <DashRow title="Levels · where the option writers are">
      <Panel w={14} title={`Open interest map · expiry ${fullDay(props.chain.expiry)}`}
             info={<><p>Open interest in contracts at each strike on the previous close: call writers defend the strikes above (resistance), put writers the ones below (support).</p><p>The shaded band is ±1σ for the session. Hover a strike for its numbers and the day's change.</p></>}>
        <LevelMap {...props} />
        <Legend items={legend} />
      </Panel>
      <Panel w={10} title="Key levels" flush info="Option walls and fresh writing from the previous close's chain, the previous session's high, low and pivot, and the σ-based triggers. Same-price levels are merged.">
        <div className="table-wrap" style={{ maxHeight: 680 }}>
          <table className="lvl">
            <thead><tr><th>Level</th><th style={{ textAlign: 'left' }}>What</th><th>From close</th></tr></thead>
            <tbody>
              {lv.list.map((l) => {
                const hitByDay = props.actual && l.kind !== 'spot' && l.price <= props.actual.high && l.price >= props.actual.low
                return (
                  <tr key={`${l.price}${l.label}`} className={`k-${l.kind}`}>
                    <td className="lvl-p">{num(l.price)}</td>
                    <td style={{ textAlign: 'left' }}>
                      <span className={`lvl-kind k-${l.kind}`}>{kindLabel[l.kind]}</span>{l.label}
                      {l.note && <small>{l.note}</small>}
                      {hitByDay && <small className="lvl-hit">traded through today</small>}
                    </td>
                    <td className={signClass(l.price - prev.spot_close)}>{l.kind === 'spot' ? '—' : signed(l.price - prev.spot_close)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </DashRow>
  )
}

/* ================================================================== */
/* Odds and base rates                                                 */
/* ================================================================== */

function OddsRow(props: { moves: MoveOdd[]; sigma: number; prev: Row; rates: BaseRate[]; type: DayType; odds: Odds | null; open: boolean }) {
  const { sigma, prev } = props
  const kind = props.type.expiry ? 'expiry days' : 'non-expiry sessions'
  const moveCols: Column<MoveOdd>[] = [
    { label: 'Move', value: (m) => <b>±{m.k}σ</b>, align: 'left' },
    { label: 'Points', value: (m) => `±${num(m.k * sigma)}` },
    { label: 'Band', value: (m) => `${num(prev.spot_close - m.k * sigma)} – ${num(prev.spot_close + m.k * sigma)}` },
    { label: 'Closes beyond', value: (m) => `${num(m.closeBeyond)}%` },
    { label: 'Touches up', value: (m) => `${num(m.touchUp)}%` },
    { label: 'Touches down', value: (m) => `${num(m.touchDown)}%` },
    { label: 'Either', value: (m) => <b>{num(m.touchEither)}%</b> },
  ]
  const rateCols: Column<BaseRate>[] = [
    { label: 'Condition', value: (r) => (r.base ? <b>{r.label}</b> : r.label), align: 'left' },
    { label: 'Sessions', value: (r) => num(r.n) },
    { label: 'Closed up', value: (r) => `${num(r.upPct, 1)}%` },
    { label: 'Avg day', value: (r) => <span className={signClass(r.avg)}>{pct(r.avg, 2, true)}</span> },
    { label: 'z', value: (r) => (r.z == null ? '—' : num(r.z, 1)) },
    {
      label: 'Read', value: (r) => r.base ? <span className="muted">base rate</span>
        : r.z == null ? <span className="muted">too few</span>
          : r.edge ? <span className={`pill ${r.upPct > (props.rates[0]?.upPct ?? 50) ? 'up' : 'down'}`}>tilt {r.upPct > (props.rates[0]?.upPct ?? 50) ? 'up' : 'down'}</span>
            : <span className="pill neutral">coin flip</span>,
    },
  ]
  return (
    <DashRow title="Odds · what history says about a day like this" defaultOpen={props.open}>
      <Panel w={12} title={`Move odds · ${kind}`} flush
             info={`How far past ${kind} moved from the previous close, in σ of that close (n = ${num(props.odds?.n ?? 0)}). "Touches" uses the day's high or low; "closes beyond" the close. Points are today's σ.`}>
        <DataTable columns={moveCols} rows={props.moves} />
        <div className="sp-note">Short strikes at ±1σ held to the close on {props.odds ? `${num(props.odds.holdCondor)}%` : '—'} of {kind}; price touched one intraday on {props.moves[1] ? `${num(props.moves[1].touchEither)}%` : '—'}, which is why the stop rule matters.</div>
      </Panel>
      <Panel w={12} title="Direction · next-session base rates" flush
             info={<><p>How often Nifty closed higher than the previous close under each condition that applies this morning, against all sessions. z tests the difference; |z| ≥ 2 is flagged.</p><p>Several conditions are tested at once, so one |z| ≥ 2 can be luck. Treat a tilt as context, not a signal.</p></>}>
        <DataTable columns={rateCols} rows={props.rates} />
        <div className="sp-note">Direction is the unreliable part of any daily forecast; the size of the move (left) is the dependable part.</div>
      </Panel>
    </DashRow>
  )
}

/* ================================================================== */
/* Context                                                             */
/* ================================================================== */

function ContextRow(props: { ctx: Context; prev: Row; open: boolean }) {
  const { ctx } = props
  const tv = ctx.trend
  const tone = tv?.verdict === 'Bullish' ? 'good' : tv?.verdict === 'Bearish' ? 'critical' : 'warning'
  const vote = (v: number) => (v > 0 ? <span className="up">▲</span> : v < 0 ? <span className="down">▼</span> : <span className="muted">●</span>)
  const posCols: Column<Context['pos'][number]>[] = [
    { label: 'Who', value: (p) => p.who, align: 'left' },
    { label: 'Long share', value: (p) => pct(p.longPct, 1) },
    { label: 'Net futures, 1d', value: (p) => <span className={signClass(p.d1)}>{p.d1 == null ? '—' : signed(p.d1)}</span> },
    { label: 'Net futures, 5d', value: (p) => <span className={signClass(p.d5)}>{p.d5 == null ? '—' : signed(p.d5)}</span> },
  ]
  return (
    <DashRow title="Context · where the market stands" defaultOpen={props.open}>
      <Panel w={12} title="Trend at the previous close" info="The dashboard's six price rules (≥ +3 bullish, ≤ −3 bearish), plus momentum readings. Context for the day, not a direction call.">
        {tv ? (
          <div className="mv">
            <div className="mv-verdict">
              <span className={`mv-word ${tone}`}>{tv.verdict.toUpperCase()}</span>
              <span className="mv-strength">{tv.strength} · score {tv.score > 0 ? '+' : ''}{tv.score} / ±{tv.max}</span>
            </div>
            <ul className="sig-list">
              {tv.signals.map((s) => <li key={s.label}>{vote(s.vote)}<span className="sig-label">{s.label}</span><span className="sig-detail">{s.detail}</span></li>)}
            </ul>
            <div className="ctx-kv">
              <div><span>RSI 14</span><b className={ctx.rsi != null && ctx.rsi >= 70 ? 'down' : ctx.rsi != null && ctx.rsi <= 30 ? 'up' : ''}>{num(ctx.rsi, 1)}</b><small>{ctx.rsi != null && ctx.rsi >= 70 ? 'overbought' : ctx.rsi != null && ctx.rsi <= 30 ? 'oversold' : 'neutral'}</small></div>
              <div><span>5 sessions</span><b className={signClass(ctx.r5)}>{pct(ctx.r5, 2, true)}</b></div>
              <div><span>20 sessions</span><b className={signClass(ctx.r20)}>{pct(ctx.r20, 2, true)}</b></div>
              <div><span>From 52w high</span><b className={signClass(ctx.fromHigh)}>{pct(ctx.fromHigh, 1, true)}</b><small>{num(ctx.high52)}</small></div>
            </div>
          </div>
        ) : <div className="muted">Needs 200 sessions of history.</div>}
      </Panel>
      <Panel w={12} title="Positioning · index futures" flush info="Participant-wise open interest (NSE). Long share = longs ÷ (longs + shorts). Net change in contracts on the previous session and over five sessions.">
        <DataTable columns={posCols} rows={ctx.pos} />
        <div className="sp-note">
          {(() => {
            const f = ctx.pos.find((p) => p.who === 'FII'), r = ctx.pos.find((p) => p.who === 'Retail')
            if (!f || f.d5 == null || f.longPct == null) return null
            return <>FIIs are {num(f.longPct, 0)}% long and {f.d5 >= 0 ? 'added' : 'cut'} {num(Math.abs(f.d5))} net contracts in five sessions{r?.d5 != null ? <>; retail {r.d5 >= 0 ? 'bought' : 'sold'} {num(Math.abs(r.d5))}</> : null}. Big FII short covering fuels rallies; once it slows, so does the fuel.</>
          })()}
        </div>
      </Panel>
    </DashRow>
  )
}

/* ================================================================== */
/* Post-market review                                                  */
/* ================================================================== */

function ReviewRow(props: { rv: Review; lv: Levels; outcomes: Outcome[]; sigma: number; expiryDay: boolean; next?: string; onNext: (d: string) => void }) {
  const { rv, lv } = props
  const text = reviewText(rv, lv, props.outcomes)
  const a = rv.a
  const scTone: Tone = rv.scenario === 'breakout' ? 'good' : rv.scenario === 'breakdown' ? 'critical' : 'warning'
  const cols: Column<Outcome>[] = [
    { label: 'Plan', value: (o) => <b>{o.plan.name}</b>, align: 'left' },
    { label: 'For', value: (o) => o.plan.covers.map((k) => SCENARIO_NAME[k]).join(', '), align: 'left' },
    { label: 'Taken', value: (o) => (o.triggered ? 'Yes' : <span className="muted">No</span>) },
    { label: 'Entry (est.)', value: (o) => (!o.triggered || o.entry == null ? '—' : `${num(Math.abs(o.entry), 1)} ${o.entry >= 0 ? 'cr' : 'dr'}`) },
    { label: 'P&L*', value: (o) => (!o.triggered || o.pnl == null ? '—' : <span className={signClass(o.pnl)}>{signed(o.pnl, 1)} pts</span>) },
    { label: '₹ / lot', value: (o) => (!o.triggered || o.pnl == null ? '—' : <span className={signClass(o.pnl)}>{signed(o.pnl * o.plan.lot)}</span>) },
    {
      label: 'Result', value: (o) => !o.triggered ? <span className="pill neutral">not taken</span>
        : o.pnl == null ? <span className="pill neutral">pending</span>
          : <span className={`pill ${o.pnl >= 0 ? 'up' : 'down'}`}>{o.pnl >= 0 ? 'win' : 'loss'}</span>,
    },
  ]
  return (
    <DashRow title={`Review · how the session went${a.provisional ? ' (live, provisional)' : ''}`}>
      <Stat w={4} label="Open" value={num(a.open, 2)} sub={<><Change value={rv.gap} text={`${signed(rv.gap)} pts`} /> · {signed(rv.gapZ, 2)}σ gap</>} />
      <Stat w={4} label="High" value={num(a.high, 2)} sub={rv.brokeUp ? `Broke the ${num(lv.up)} trigger` : `Stayed under ${num(lv.up)}`} />
      <Stat w={4} label="Low" value={num(a.low, 2)} sub={rv.brokeDown ? `Broke the ${num(lv.down)} trigger` : `Stayed over ${num(lv.down)}`} />
      <Stat w={4} label={a.provisional ? 'Last' : 'Close'} value={num(a.close, 2)} valueClass={signClass(rv.chg)}
            sub={<Change value={rv.chg} text={`${signed(rv.chg)} (${pct(rv.chgPct, 2, true)})`} />} />
      <Stat w={4} label="Range" value={<>{num(rv.range)} <small className="unit">pts</small></>}
            sub={`${num(rv.rangeZ, 2)}× the expected ±${num(props.sigma)}`} tone={rv.rangeZ > 1.5 ? 'critical' : rv.rangeZ > 1 ? 'warning' : 'good'}
            info="High minus low, against the session's 1σ from the previous close's VIX." />
      <Stat w={4} label="Outcome" value={SCENARIO_NAME[rv.scenario]} valueClass="sm" tone={scTone}
            sub={`Closed ${signed(rv.chg / props.sigma, 2)}σ from the previous close`} />
      <Panel w={12} title="What happened" className="featured" info="Written by rules from the session's numbers against the morning plan; no language model.">
        <div className="mv">
          {a.provisional && <div className="edge no">Provisional, from the live feed. The NSE close loads about 20:00 IST and replaces these numbers.</div>}
          <ul className="why rv-text">{text.map((t) => <li key={t}>{t}</li>)}</ul>
          {props.next && <button className="btn sp-next" onClick={() => props.onNext(props.next!)}>Plan for {dayLabel(props.next)} →</button>}
        </div>
      </Panel>
      <Panel w={12} title="Plan scorecard" flush info="Each plan is taken only if its rule fired: the condor when the open was inside both triggers, a spread when its trigger traded.">
        <DataTable columns={cols} rows={props.outcomes} />
        <div className="sp-note">
          * Entry estimated when the rule fires (the condor at the open, a spread at its trigger) from the previous close's chain at the same moneyness{props.expiryDay ? '; settled at the closing price' : '; marked at the close'}. An estimate from end-of-day data, not a fill: slippage and charges are not included.
        </div>
      </Panel>
    </DashRow>
  )
}

/* ================================================================== */
/* Intraday against the plan (live feed bars, today only)               */
/* ================================================================== */

function IntradayPlan(props: { bars: IntradayBar[]; prev: Row; sigma: number; lv: Levels; plans: DayPlan[]; live: boolean }) {
  const c = useChartColors()
  const { prev, sigma, lv } = props
  const data = props.bars.map((b) => ({ t: istTime(b.time), close: b.close, high: b.high, low: b.low }))
  const condor = props.plans.find((p) => p.key === 'condor')
  const shorts = condor ? condor.legs.filter((l) => l.action === 'Sell').map((l) => l.strike) : []
  const lo = Math.min(...data.map((x) => x.low), lv.down) - sigma * 0.15
  const hi = Math.max(...data.map((x) => x.high), lv.up) + sigma * 0.15
  const last = data[data.length - 1]
  const z = (last.close - prev.spot_close) / sigma
  const where = classify(Math.max(...data.map((x) => (x.high - prev.spot_close) / sigma)), Math.min(...data.map((x) => (x.low - prev.spot_close) / sigma)), z)
  return (
    <DashRow title={props.live ? 'Live · price against the plan' : 'Intraday · price against the plan'}>
      <Panel w={24} title="Nifty 50 · 1-minute, with the morning's levels"
             right={<span className="panel-last"><b>{num(last.close, 2)}</b><span className={signClass(last.close - prev.spot_close)}>{signed(last.close - prev.spot_close)} · {props.live ? 'so far' : 'ended'}: {SCENARIO_NAME[where]}</span></span>}
             info="1-minute closes from the live feed (IST). Dashed: the ±0.5σ triggers; solid: the previous close; dotted: the iron condor's short strikes.">
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="t" axisLine={false} tickLine={false} minTickGap={48} tick={{ fill: c.muted, fontSize: 11.5 }} />
            <YAxis domain={[lo, hi]} width={56} axisLine={false} tickLine={false} tick={{ fill: c.muted, fontSize: 11.5 }} tickFormatter={(v: number) => num(v)} allowDataOverflow />
            <ReferenceArea y1={Math.max(lo, prev.spot_close - sigma)} y2={Math.min(hi, prev.spot_close + sigma)} fill={c.accent} fillOpacity={0.06} />
            <ReferenceLine y={prev.spot_close} stroke={c.accent} strokeWidth={1.5} label={{ value: 'Prev close', position: 'insideTopLeft', fill: c.accent, fontSize: 11 }} />
            <ReferenceLine y={lv.up} stroke={c.textSecondary} strokeDasharray="5 4" label={{ value: `Trigger ${num(lv.up)}`, position: 'insideTopRight', fill: c.textSecondary, fontSize: 11 }} />
            <ReferenceLine y={lv.down} stroke={c.textSecondary} strokeDasharray="5 4" label={{ value: `Trigger ${num(lv.down)}`, position: 'insideBottomRight', fill: c.textSecondary, fontSize: 11 }} />
            {shorts.filter((k) => k > lo && k < hi).map((k) => <ReferenceLine key={k} y={k} stroke={c.muted} strokeDasharray="1 3" strokeWidth={1.5} />)}
            <Tooltip cursor={{ stroke: c.muted, strokeDasharray: '3 3' }} isAnimationActive={false}
                     content={(p) => <ChartTooltip {...p} format={(v) => num(v, 2)} labelFormat={(s) => `${s} IST`} />} />
            <Area type="monotone" dataKey="close" stroke="none" fill={c.series[0]} fillOpacity={0.08} baseValue={lo} isAnimationActive={false} activeDot={false} tooltipType="none" />
            <Line type="monotone" dataKey="close" name="Nifty 50" stroke={c.series[0]} strokeWidth={2} dot={false}
                  activeDot={{ r: 5, stroke: c.surface, strokeWidth: 3, fill: c.series[0] }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </Panel>
    </DashRow>
  )
}
