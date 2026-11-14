import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api, type LiveView } from './api'
import { compact } from './format'
import {
  baseRates, closes, context, dayPlans, dayStats, dayType, levels, moveOdds, nextWeekday, review, scenarioOdds,
  scorePlan, sessionEvents, sigmaOf, TRIGGER, type Actual, type DayPlan, type Row,
} from './sessionPlan'
import { useLive } from './useLive'

export type View = 'pre' | 'post'
export interface Outcome { plan: DayPlan; triggered: boolean; entry: number | null; pnl: number | null }

export const istDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso))
export const istTime = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))

/** The session the next plan is for: today until its EOD lands, then the next open (live clock), else the next weekday. */
export function upcomingSession(live: LiveView | undefined, last: string | undefined): string | undefined {
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

/**
 * Everything the Pre / post market page and the voiceover script show for one session, from data
 * through the previous close (the plan) and the session's own close or live quote (the review).
 */
export function useSessionModel(asked: string | null, wanted: string | null) {
  const dq = useQuery({ queryKey: ['daily'], queryFn: api.daily })
  const pq = useQuery({ queryKey: ['participants'], queryFn: api.participants })
  const eq = useQuery({ queryKey: ['events'], queryFn: api.events })
  const live = useLive()

  const rows = useMemo(() => closes(dq.data ?? []), [dq.data])
  const events = useMemo(() => eq.data ?? [], [eq.data])
  const stats = useMemo(() => dayStats(dq.data ?? [], events), [dq.data, events])
  const upcoming = upcomingSession(live.data, rows.at(-1)?.trade_date)
  const sessions = useMemo(() => {
    const xs = rows.slice(-250).map((r) => r.trade_date).reverse()
    return upcoming ? [upcoming, ...xs] : xs
  }, [rows, upcoming])
  const d: string | undefined = asked && sessions.includes(asked) ? asked : sessions[0]
  const iD = rows.findIndex((r) => r.trade_date === d)
  const b = iD >= 0 ? iD - 1 : rows.length - 1
  const prev: Row | undefined = rows[b]
  const { chain, error: chainError, loading: chainLoading } = usePlanChain(prev?.trade_date)

  // What actually happened: the NSE close, or the live feed while today's close is not loaded yet.
  const eod = iD >= 0 ? rows[iD] : undefined
  const actual: Actual | null = eod && eod.spot_open != null && eod.spot_high != null && eod.spot_low != null
    ? { open: eod.spot_open, high: eod.spot_high, low: eod.spot_low, close: eod.spot_close, vix: eod.vix_close, provisional: false }
    : d ? liveActual(live.data, d) : null
  const view: View = wanted === 'post' && actual ? 'post' : wanted === 'pre' ? 'pre' : eod ? 'post' : 'pre'
  const expiryDay = !!chain && chain.expiry === d
  const chainD = useQuery({
    queryKey: ['chain', d, chain?.expiry], queryFn: () => api.chain(d!, chain!.expiry),
    enabled: !!eod && !!chain && !expiryDay && chain.expiry > (d ?? ''),
  })

  const participants = pq.data ?? []
  const sigma = prev ? sigmaOf(prev) : null
  const type = prev && d ? dayType(rows, b, d, events) : null
  const lv = prev && chain && sigma ? levels(prev, chain, sigma, compact) : null
  const plans = prev && chain && sigma && lv ? dayPlans(prev, chain, sigma, lv) : []
  const odds = type && d ? scenarioOdds(stats, type.expiry, d) : null
  const moves = type && d ? moveOdds(stats, type.expiry, d) : []
  const ctx = prev && b >= 5 ? context(rows, b, participants) : null
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
  // FII net index-futures change on the session itself (for the review).
  const fii = participants.filter((p) => p.client_type === 'FII' && p.fut_index_net != null)
  const fiiD = d ? fii.find((p) => p.trade_date === d) : undefined
  const fiiB = prev ? fii.find((p) => p.trade_date === prev.trade_date) : undefined
  const fiiChange = fiiD && fiiB ? fiiD.fut_index_net! - fiiB.fut_index_net! : null
  const bars = (live.data?.bars ?? []).filter((x) => d && istDate(x.time) === d)
  const sessionOpen = live.data?.market.state === 'open' && live.data.market.session_date === d

  return {
    sessions, upcoming, d, idx: d ? sessions.indexOf(d) : -1, prev, chain, actual, view, expiryDay, sigma, type, lv, plans,
    odds, moves, ctx, rates, evs, rv, outcomes, fiiChange, bars, sessionOpen,
    error: dq.error ?? chainError, loading: dq.isLoading || eq.isLoading || chainLoading,
  }
}

export type SessionModel = ReturnType<typeof useSessionModel>
