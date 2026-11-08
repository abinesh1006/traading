/**
 * Pre-market plan and post-market review for one Nifty session, computed in the browser from the
 * end-of-day data. The plan for session D uses only data through the session before it (B), so the
 * plan shown for a past session is what this page would have said that morning, and the review can
 * grade it honestly.
 *
 * Sizes come from India VIX: one session's 1σ = VIX / √252 × the previous close. Triggers sit at
 * ±0.5σ from that close. Every session since 2015 is measured in the same σ units, which is what
 * makes the odds comparable between calm and stressed years. Rules, not a model; not backtested
 * on intraday fills.
 */
import { trendView, verdictSeries, type Leg, type TrendView, type Verdict } from './analysis'
import type { ChainRow, DailyMarket, MarketEvent, OptionChain, ParticipantPosition } from './api'

export type Row = DailyMarket & { spot_close: number }
export const TRIGGER = 0.5 // σ from the previous close
const WING = 200           // points between the short and long strike of a spread

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()
export const shiftDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const fmt = (v: number, d = 0) => v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })
const sgn = (v: number, d = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), d)}`

export function closes(daily: DailyMarket[]): Row[] {
  return daily.filter((r): r is Row => r.spot_close != null)
}

/** One session's 1σ move in points, from the VIX and close of the session before it. */
export function sigmaOf(prev: Row): number | null {
  return prev.vix_close == null ? null : prev.spot_close * (prev.vix_close / 100) / Math.sqrt(252)
}

/** Next weekday after iso (holidays are not known here). */
export function nextWeekday(iso: string): string {
  let d = shiftDays(iso, 1)
  while ([0, 6].includes(dow(d))) d = shiftDays(d, 1)
  return d
}

/** Weekday sessions after `from` up to and including `to` (special weekend sessions not counted). */
function sessionsBetween(from: string, to: string): number {
  let n = 0
  for (let d = shiftDays(from, 1); d <= to; d = shiftDays(d, 1)) if (![0, 6].includes(dow(d))) n++
  return n
}

/** Wilder's 14-session RSI. */
function rsiSeries(close: number[], n = 14): Array<number | null> {
  const out: Array<number | null> = new Array(close.length).fill(null)
  let up = 0, dn = 0
  for (let i = 1; i < close.length; i++) {
    const ch = close[i] - close[i - 1]
    const u = Math.max(ch, 0), d = Math.max(-ch, 0)
    if (i <= n) {
      up += u / n; dn += d / n
      if (i === n) out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn)
    } else {
      up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + d) / n
      out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn)
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Every past session, measured in σ of its own previous close          */
/* ------------------------------------------------------------------ */

export interface DayStat {
  date: string
  expiry: boolean          // a Nifty expiry that day
  afterSpecial: boolean    // the session before was a special one (Muhurat, budget weekend)
  verdictPrev: Verdict | undefined
  r5Prev: number | null    // % return over the 5 sessions to the previous close
  rsiPrev: number | null
  sigma: number            // points
  g: number; h: number; l: number; c: number   // open, high, low, close vs the previous close, in σ
  ret: number              // % close to close
}

export function dayStats(daily: DailyMarket[], events: MarketEvent[]): DayStat[] {
  const rows = closes(daily)
  const special = new Set(events.filter((e) => e.category === 'special_session').map((e) => e.event_date))
  const verdicts = verdictSeries(daily)
  const rsi = rsiSeries(rows.map((r) => r.spot_close))
  const out: DayStat[] = []
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], r = rows[i]
    const sigma = sigmaOf(p)
    if (sigma == null || r.spot_open == null || r.spot_high == null || r.spot_low == null) continue
    const z = (x: number) => (x - p.spot_close) / sigma
    out.push({
      date: r.trade_date, expiry: p.near_expiry === r.trade_date, afterSpecial: special.has(p.trade_date),
      verdictPrev: verdicts.get(p.trade_date), r5Prev: i >= 6 ? (p.spot_close / rows[i - 6].spot_close - 1) * 100 : null,
      rsiPrev: rsi[i - 1], sigma, g: z(r.spot_open), h: z(r.spot_high), l: z(r.spot_low), c: z(r.spot_close),
      ret: (r.spot_close / p.spot_close - 1) * 100,
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* The four ways a session can go                                      */
/* ------------------------------------------------------------------ */

export type ScenarioKey = 'quiet' | 'fakeout' | 'breakout' | 'breakdown'
export const SCENARIOS: ScenarioKey[] = ['quiet', 'fakeout', 'breakout', 'breakdown']

/** Where the session ended up relative to the ±0.5σ triggers. The four cases cover every day. */
export function classify(h: number, l: number, c: number, k = TRIGGER): ScenarioKey {
  if (c > k) return 'breakout'
  if (c < -k) return 'breakdown'
  return h <= k && l >= -k ? 'quiet' : 'fakeout'
}

type Shares = Record<ScenarioKey, number>
const shares = (xs: DayStat[]): Shares => {
  const m: Shares = { quiet: 0, fakeout: 0, breakout: 0, breakdown: 0 }
  for (const x of xs) m[classify(x.h, x.l, x.c)]++
  for (const k of SCENARIOS) m[k] = xs.length ? (m[k] / xs.length) * 100 : 0
  return m
}

export interface Odds {
  n: number; since: string; share: Shares
  recentN: number; recent: Shares          // last two years
  gapUp: number; gapDown: number           // opened beyond a trigger, %
  holdCondor: number                       // closed inside ±1σ, %
}

/** Scenario shares on past sessions of the same type (expiry or not), all before `before`. */
export function scenarioOdds(stats: DayStat[], expiry: boolean, before: string): Odds | null {
  const s = stats.filter((x) => x.expiry === expiry && x.date < before)
  if (s.length < 20) return null
  const r = s.filter((x) => x.date >= shiftDays(before, -730))
  const pct = (f: (x: DayStat) => boolean) => (s.filter(f).length / s.length) * 100
  return {
    n: s.length, since: s[0].date, share: shares(s), recentN: r.length, recent: shares(r),
    gapUp: pct((x) => x.g > TRIGGER), gapDown: pct((x) => x.g < -TRIGGER), holdCondor: pct((x) => Math.abs(x.c) <= 1),
  }
}

export interface MoveOdd { k: number; closeBeyond: number; touchUp: number; touchDown: number; touchEither: number }

export function moveOdds(stats: DayStat[], expiry: boolean, before: string): MoveOdd[] {
  const s = stats.filter((x) => x.expiry === expiry && x.date < before)
  const p = (f: (x: DayStat) => boolean) => (s.length ? (s.filter(f).length / s.length) * 100 : 0)
  return [0.5, 1, 1.5, 2].map((k) => ({
    k, closeBeyond: p((x) => Math.abs(x.c) > k), touchUp: p((x) => x.h > k), touchDown: p((x) => x.l < -k),
    touchEither: p((x) => x.h > k || x.l < -k),
  }))
}

/* ------------------------------------------------------------------ */
/* Direction base rates for the conditions that apply this morning      */
/* ------------------------------------------------------------------ */

export interface BaseRate { label: string; n: number; upPct: number; avg: number; z: number | null; edge: boolean; base?: boolean }

export interface Setup {
  expiry: boolean
  afterSpecial: boolean
  verdict: Verdict | undefined
  r5: number | null
  rsi: number | null
}

export function baseRates(stats: DayStat[], setup: Setup, before: string): BaseRate[] {
  const s = stats.filter((x) => x.date < before)
  if (!s.length) return []
  const pb = s.filter((x) => x.c > 0).length / s.length
  const row = (label: string, xs: DayStat[], base = false): BaseRate => {
    const n = xs.length
    const p = n ? xs.filter((x) => x.c > 0).length / n : 0
    const se = Math.sqrt((pb * (1 - pb)) / Math.max(n, 1))
    const z = base || n < 8 ? null : (p - pb) / se
    return { label, n, upPct: p * 100, avg: n ? xs.reduce((t, x) => t + x.ret, 0) / n : 0, z, edge: z != null && Math.abs(z) >= 2, base }
  }
  const out = [row('All sessions', s, true)]
  out.push(setup.expiry ? row('Expiry days', s.filter((x) => x.expiry)) : row('Non-expiry days', s.filter((x) => !x.expiry)))
  if (setup.afterSpecial) out.push(row('Day after a special session', s.filter((x) => x.afterSpecial)))
  if (setup.verdict) out.push(row(`Trend ${setup.verdict.toLowerCase()} at the prior close`, s.filter((x) => x.verdictPrev === setup.verdict)))
  if (setup.r5 != null && Math.abs(setup.r5) >= 4) {
    const up = setup.r5 > 0
    out.push(row(`After a 5-day ${up ? 'rally' : 'fall'} beyond ${up ? '+' : '−'}4%`, s.filter((x) => x.r5Prev != null && (up ? x.r5Prev >= 4 : x.r5Prev <= -4))))
  }
  if (setup.rsi != null && (setup.rsi >= 70 || setup.rsi <= 30)) {
    const hot = setup.rsi >= 70
    out.push(row(`RSI ${hot ? '≥ 70 (overbought)' : '≤ 30 (oversold)'} at the prior close`, s.filter((x) => x.rsiPrev != null && (hot ? x.rsiPrev >= 70 : x.rsiPrev <= 30))))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Session type and events                                             */
/* ------------------------------------------------------------------ */

export interface DayType {
  expiry: boolean
  shiftedFrom: string | null     // "Tuesday" when the expiry moved off its usual weekday
  special: MarketEvent | undefined   // the session itself is special
  afterSpecial: MarketEvent | undefined
  thinPrev: boolean              // the previous session traded under half the usual futures volume
}

export function dayType(rows: Row[], b: number, d: string, events: MarketEvent[]): DayType {
  const prev = rows[b]
  const expiry = prev.near_expiry === d
  const recent = [...new Set(rows.slice(Math.max(0, b - 60), b + 1).map((r) => r.near_expiry).filter((x): x is string => !!x && x <= prev.trade_date))].slice(-6)
  const counts = new Map<number, number>()
  for (const e of recent) counts.set(dow(e), (counts.get(dow(e)) ?? 0) + 1)
  const usual = [...counts.entries()].sort((a, z) => z[1] - a[1])[0]?.[0]
  const vols = rows.slice(Math.max(0, b - 20), b).map((r) => r.fut_volume_contracts).filter((x): x is number => x != null).sort((a, z) => a - z)
  const med = vols.length ? vols[Math.floor(vols.length / 2)] : null
  const special = (iso: string) => events.find((e) => e.category === 'special_session' && e.event_date === iso)
  return {
    expiry,
    shiftedFrom: expiry && usual != null && usual !== dow(d) ? DAYS[usual] : null,
    special: special(d), afterSpecial: special(prev.trade_date),
    thinPrev: med != null && prev.fut_volume_contracts != null && prev.fut_volume_contracts < med * 0.5,
  }
}

const MACRO = new Set(['rbi_policy', 'fomc', 'us_cpi', 'union_budget', 'election'])

/** Scheduled events in the session, and those landing after its close but before the next weekday's open. */
export function sessionEvents(events: MarketEvent[], d: string): { during: MarketEvent[]; after: MarketEvent[] } {
  const next = nextWeekday(d)
  return {
    during: events.filter((e) => MACRO.has(e.category) && e.event_date === d && !e.after_close),
    after: events.filter((e) => MACRO.has(e.category) && ((e.event_date === d && e.after_close) || (e.event_date > d && e.event_date <= next))),
  }
}

/* ------------------------------------------------------------------ */
/* Levels from the previous close's option chain and price             */
/* ------------------------------------------------------------------ */

export type LevelKind = 'res' | 'sup' | 'pivot' | 'trig' | 'band' | 'spot'
export interface Level { price: number; label: string; kind: LevelKind; note?: string }

export interface Levels {
  list: Level[]                  // high to low, same price merged
  up: number; down: number       // triggers
  callWalls: number[]; putWalls: number[]
  maxPain: number | null
}

const contracts = (units: number | null, lot: number) => (units ?? 0) / lot

export function maxPainOf(rows: ChainRow[]): number | null {
  let best: { k: number; pain: number } | null = null
  for (const c of rows) {
    const pain = rows.reduce((t, r) => t + (r.ce_oi_units ?? 0) * Math.max(0, c.strike - r.strike) + (r.pe_oi_units ?? 0) * Math.max(0, r.strike - c.strike), 0)
    if (!best || pain < best.pain) best = { k: c.strike, pain }
  }
  return best?.k ?? null
}

export function levels(prev: Row, chain: OptionChain, sigma: number, compactFn: (v: number) => string): Levels {
  const spot = prev.spot_close, lot = chain.lot_size || 1
  const up = spot + TRIGGER * sigma, down = spot - TRIGGER * sigma
  const above = (k: number) => chain.rows.filter((r) => r.strike > spot && r.strike <= spot + k * sigma)
  const below = (k: number) => chain.rows.filter((r) => r.strike < spot && r.strike >= spot - k * sigma)
  const callWalls = [...above(3.5)].sort((a, z) => (z.ce_oi_units ?? 0) - (a.ce_oi_units ?? 0)).slice(0, 2)
  const putWalls = [...below(3.5)].sort((a, z) => (z.pe_oi_units ?? 0) - (a.pe_oi_units ?? 0)).slice(0, 2)
  const freshCall = [...above(2)].sort((a, z) => (z.ce_oi_change_units ?? 0) - (a.ce_oi_change_units ?? 0))[0]
  const freshPut = [...below(2)].sort((a, z) => (z.pe_oi_change_units ?? 0) - (a.pe_oi_change_units ?? 0))[0]
  const mp = maxPainOf(chain.rows)
  const raw: Level[] = [
    ...callWalls.map((r) => ({ price: r.strike, label: 'Call wall', kind: 'res' as const, note: `${compactFn(contracts(r.ce_oi_units, lot))} call OI` })),
    ...putWalls.map((r) => ({ price: r.strike, label: 'Put wall', kind: 'sup' as const, note: `${compactFn(contracts(r.pe_oi_units, lot))} put OI` })),
    { price: up, label: 'Upper trigger', kind: 'trig', note: `+${TRIGGER}σ` },
    { price: down, label: 'Lower trigger', kind: 'trig', note: `−${TRIGGER}σ` },
    { price: spot + sigma, label: '+1σ', kind: 'band', note: 'top of the expected range' },
    { price: spot - sigma, label: '−1σ', kind: 'band', note: 'bottom of the expected range' },
    { price: spot, label: 'Previous close', kind: 'spot' },
  ]
  if (freshCall && (freshCall.ce_oi_change_units ?? 0) > 0) raw.push({ price: freshCall.strike, label: 'Fresh call writing', kind: 'res', note: `+${compactFn(contracts(freshCall.ce_oi_change_units, lot))} calls` })
  if (freshPut && (freshPut.pe_oi_change_units ?? 0) > 0) raw.push({ price: freshPut.strike, label: 'Fresh put writing', kind: 'sup', note: `+${compactFn(contracts(freshPut.pe_oi_change_units, lot))} puts` })
  if (mp != null) raw.push({ price: mp, label: 'Max pain', kind: 'pivot', note: 'least payout to option buyers' })
  if (prev.spot_high != null && prev.spot_low != null) {
    raw.push({ price: prev.spot_high, label: 'Previous high', kind: 'res' })
    raw.push({ price: prev.spot_low, label: 'Previous low', kind: 'sup' })
    raw.push({ price: (prev.spot_high + prev.spot_low + spot) / 3, label: 'Pivot (H+L+C)/3', kind: 'pivot' })
  }
  // Merge levels at the same price (e.g. a call wall that is also fresh writing).
  const merged = new Map<string, Level>()
  for (const l of raw) {
    const key = l.price.toFixed(1)
    const m = merged.get(key)
    if (m) { m.label = `${m.label} · ${l.label}`; m.note = [m.note, l.note].filter(Boolean).join(' · ') }
    else merged.set(key, { ...l })
  }
  return {
    list: [...merged.values()].sort((a, z) => z.price - a.price), up, down,
    callWalls: callWalls.map((r) => r.strike), putWalls: putWalls.map((r) => r.strike), maxPain: mp,
  }
}

/* ------------------------------------------------------------------ */
/* One defined-risk structure per scenario                             */
/* ------------------------------------------------------------------ */

export interface DayPlan {
  key: 'condor' | 'bull' | 'bear'
  name: string
  covers: ScenarioKey[]
  legs: Leg[]
  credit: number                 // + received, − paid (points)
  maxProfit: number
  maxLoss: number
  breakevens: number[]
  lot: number
  expiry: string
  trigger?: number
  stop?: number
  target?: number
  rules: string[]
}

type Side = 'CE' | 'PE'
const px = (r: ChainRow, t: Side) => (t === 'CE' ? r.ce_close : r.pe_close)
const dl = (r: ChainRow, t: Side) => (t === 'CE' ? r.ce_delta : r.pe_delta)
const liquid = (c: OptionChain, t: Side) => c.rows.filter((r) => (px(r, t) ?? 0) > 0.5 && ((t === 'CE' ? r.ce_oi_units : r.pe_oi_units) ?? 0) > 0)
const nearest = (c: OptionChain, t: Side, k: number) => [...liquid(c, t)].sort((a, z) => Math.abs(a.strike - k) - Math.abs(z.strike - k))[0]
const mk = (action: Leg['action'], type: Side, r: ChainRow): Leg => ({ action, type, strike: r.strike, price: px(r, type)!, delta: dl(r, type) })
const net = (legs: Leg[]) => legs.reduce((t, l) => t + (l.action === 'Sell' ? l.price : -l.price), 0)
const r5 = (v: number) => Math.round(v / 5) * 5

export function dayPlans(prev: Row, chain: OptionChain, sigma: number, lv: Levels): DayPlan[] {
  const spot = prev.spot_close, lot = chain.lot_size ?? 1
  const n = Math.max(1, sessionsBetween(prev.trade_date, chain.expiry))
  const sx = sigma * Math.sqrt(n) // 1σ to expiry
  const base = { lot, expiry: chain.expiry }
  const out: DayPlan[] = []

  const sc = nearest(chain, 'CE', Math.max(spot + sx, lv.up + 50)), sp = nearest(chain, 'PE', Math.min(spot - sx, lv.down - 50))
  const lc = sc && nearest(chain, 'CE', sc.strike + WING), lp = sp && nearest(chain, 'PE', sp.strike - WING)
  if (sc && sp && lc && lp && lc.strike > sc.strike && lp.strike < sp.strike) {
    const legs = [mk('Buy', 'PE', lp), mk('Sell', 'PE', sp), mk('Sell', 'CE', sc), mk('Buy', 'CE', lc)]
    const cr = net(legs)
    out.push({
      ...base, key: 'condor', name: 'Iron condor', covers: ['quiet', 'fakeout'], legs, credit: cr, maxProfit: cr,
      maxLoss: Math.max(sp.strike - lp.strike, lc.strike - sc.strike) - cr, breakevens: [sp.strike - cr, sc.strike + cr],
      rules: [
        'Enter after 09:45 once the opening range is set, only if the open was inside both triggers.',
        `Short strikes sit about 1σ${n > 1 ? ` to expiry (${n} sessions)` : ''} away; the wings cap the loss.`,
        `Close the threatened side if Nifty comes within ${fmt(r5(sigma * 0.2))} pts of a short strike.`,
        'Book 50–60% of the credit early rather than holding to the last minutes.',
      ],
    })
  }

  const bl = liquid(chain, 'CE').filter((r) => r.strike >= lv.up).sort((a, z) => a.strike - z.strike)[0]
  const bs = bl && nearest(chain, 'CE', bl.strike + WING)
  if (bl && bs && bs.strike > bl.strike) {
    const legs = [mk('Buy', 'CE', bl), mk('Sell', 'CE', bs)]
    const debit = -net(legs)
    const target = lv.callWalls.filter((k) => k > lv.up && k <= spot + 2 * sigma).sort((a, z) => a - z)[0] ?? spot + sigma
    const stop = r5(lv.up - 0.3 * sigma)
    out.push({
      ...base, key: 'bull', name: 'Bull call spread', covers: ['breakout'], legs, credit: -debit, maxProfit: bs.strike - bl.strike - debit,
      maxLoss: debit, breakevens: [bl.strike + debit], trigger: lv.up, stop, target,
      rules: [
        `Only on a 15-minute close above ${fmt(lv.up)} (upper trigger).`,
        `Target ${fmt(target)}${lv.callWalls.includes(target) ? ' (call wall)' : ' (+1σ)'}; exit if Nifty falls back below ${fmt(stop)}.`,
        'Debit spreads are cheap on an expiry day; the risk is only the premium paid.',
      ],
    })
  }

  const pl = liquid(chain, 'PE').filter((r) => r.strike <= lv.down).sort((a, z) => z.strike - a.strike)[0]
  const ps = pl && nearest(chain, 'PE', pl.strike - WING)
  if (pl && ps && ps.strike < pl.strike) {
    const legs = [mk('Buy', 'PE', pl), mk('Sell', 'PE', ps)]
    const debit = -net(legs)
    const target = lv.putWalls.filter((k) => k < lv.down && k >= spot - 2 * sigma).sort((a, z) => z - a)[0] ?? spot - sigma
    const stop = r5(lv.down + 0.3 * sigma)
    out.push({
      ...base, key: 'bear', name: 'Bear put spread', covers: ['breakdown'], legs, credit: -debit, maxProfit: pl.strike - ps.strike - debit,
      maxLoss: debit, breakevens: [pl.strike - debit], trigger: lv.down, stop, target,
      rules: [
        `Only on a 15-minute close below ${fmt(lv.down)} (lower trigger).`,
        `Target ${fmt(target)}${lv.putWalls.includes(target) ? ' (put wall)' : ' (−1σ)'}; exit if Nifty climbs back above ${fmt(stop)}.`,
        'Risk is only the premium paid; no overnight carry on a short leg.',
      ],
    })
  }
  return out
}

/**
 * What a strike would cost once spot has moved by `shift`, read off the previous close's chain at the
 * same moneyness (strike − shift). It keeps the previous close's time value, so it slightly overstates
 * both the debit of a later entry and the credit of a later sale.
 */
function shiftedPrice(chain: OptionChain, t: Side, strike: number, shift: number): number | null {
  const k = strike - shift
  const pts = chain.rows.map((r) => [r.strike, px(r, t)] as const)
    .filter((p): p is readonly [number, number] => p[1] != null && p[1] > 0).sort((a, z) => a[0] - z[0])
  if (!pts.length) return null
  const [k0, p0] = pts[0], [k1, p1] = pts[pts.length - 1]
  if (k <= k0) return t === 'CE' ? p0 + (k0 - k) : p0
  if (k >= k1) return t === 'PE' ? p1 + (k - k1) : p1
  const i = pts.findIndex((p) => p[0] >= k)
  const [ka, pa] = pts[i - 1], [kb, pb] = pts[i]
  return pa + ((pb - pa) * (k - ka)) / (kb - ka)
}

export interface Score { entry: number; pnl: number | null }  // entry: + net credit / − net debit, points

/**
 * Entry estimated at the moment the plan's rule fires (spot = previous close + shift), exit at the
 * session close: settled at intrinsic on expiry day, else marked at the close's chain prices.
 */
export function scorePlan(p: DayPlan, chainB: OptionChain, shift: number, close: number, expiryDay: boolean, chainD: OptionChain | undefined): Score | null {
  let entry = 0, pnl = 0, marked = true
  for (const l of p.legs) {
    const e = shiftedPrice(chainB, l.type, l.strike, shift)
    if (e == null) return null
    entry += l.action === 'Sell' ? e : -e
    let v: number | null
    if (expiryDay) v = l.type === 'CE' ? Math.max(0, close - l.strike) : Math.max(0, l.strike - close)
    else {
      const r = chainD?.rows.find((x) => x.strike === l.strike)
      v = r ? px(r, l.type) : null
    }
    if (v == null) marked = false
    else pnl += l.action === 'Buy' ? v - e : e - v
  }
  return { entry, pnl: marked ? pnl : null }
}

/* ------------------------------------------------------------------ */
/* Market context at the previous close                                */
/* ------------------------------------------------------------------ */

export interface PosLine { who: string; longPct: number | null; d1: number | null; d5: number | null }
export interface Context {
  trend: TrendView | null
  rsi: number | null
  r5: number | null; r20: number | null
  high52: number; fromHigh: number
  vixPct: number | null; vixChg5: number | null
  pos: PosLine[]
}

export function context(rows: Row[], b: number, participants: ParticipantPosition[]): Context {
  const upTo = rows.slice(0, b + 1)
  const p = participants.filter((x) => x.trade_date <= rows[b].trade_date)
  const c = upTo.map((r) => r.spot_close)
  const last = c[c.length - 1]
  const yr = upTo.slice(-252)
  const high52 = Math.max(...yr.map((r) => r.spot_high ?? r.spot_close))
  const vix = yr.map((r) => r.vix_close).filter((v): v is number => v != null)
  const v0 = upTo[b].vix_close, v5 = upTo[b - 5]?.vix_close
  const names: Record<string, string> = { FII: 'FII', DII: 'DII', Client: 'Retail', Pro: 'Prop desks' }
  const pos = (['FII', 'Client', 'DII', 'Pro'] as const).map((k) => {
    const xs = p.filter((x) => x.client_type === k && x.fut_index_net != null)
    const n0 = xs.at(-1), n1 = xs.at(-2), n5 = xs.at(-6)
    return {
      who: names[k], longPct: n0?.fut_index_long_pct ?? null,
      d1: n0 && n1 ? n0.fut_index_net! - n1.fut_index_net! : null, d5: n0 && n5 ? n0.fut_index_net! - n5.fut_index_net! : null,
    }
  })
  return {
    trend: trendView(upTo, p), rsi: rsiSeries(c)[c.length - 1],
    r5: c.length > 5 ? (last / c[c.length - 6] - 1) * 100 : null, r20: c.length > 20 ? (last / c[c.length - 21] - 1) * 100 : null,
    high52, fromHigh: (last / high52 - 1) * 100,
    vixPct: v0 == null || !vix.length ? null : (vix.filter((v) => v <= v0).length / vix.length) * 100,
    vixChg5: v0 != null && v5 != null ? (v0 / v5 - 1) * 100 : null, pos,
  }
}

/* ------------------------------------------------------------------ */
/* Post-market review                                                  */
/* ------------------------------------------------------------------ */

export interface Actual { open: number; high: number; low: number; close: number; vix: number | null; provisional: boolean }

export interface Review {
  a: Actual
  gap: number; gapZ: number
  chg: number; chgPct: number
  range: number; rangeZ: number
  scenario: ScenarioKey
  brokeUp: boolean; brokeDown: boolean
  vixChg: number | null
}

export function review(prev: Row, a: Actual, sigma: number, lv: Levels): Review {
  const z = (x: number) => (x - prev.spot_close) / sigma
  return {
    a, gap: a.open - prev.spot_close, gapZ: z(a.open), chg: a.close - prev.spot_close, chgPct: (a.close / prev.spot_close - 1) * 100,
    range: a.high - a.low, rangeZ: (a.high - a.low) / sigma, scenario: classify(z(a.high), z(a.low), z(a.close)),
    brokeUp: a.high > lv.up, brokeDown: a.low < lv.down,
    vixChg: a.vix != null && prev.vix_close != null ? (a.vix / prev.vix_close - 1) * 100 : null,
  }
}

export const SCENARIO_NAME: Record<ScenarioKey, string> = {
  quiet: 'Quiet range', fakeout: 'Fake-out', breakout: 'Breakout up', breakdown: 'Breakdown',
}

/** Rules-written account of the session against the plan. */
export function reviewText(r: Review, lv: Levels, plans: Array<{ plan: DayPlan; pnl: number | null; triggered: boolean }>): string[] {
  const out: string[] = []
  out.push(`Nifty opened ${r.gap >= 0 ? 'up' : 'down'} ${fmt(Math.abs(r.gap))} pts (${sgn(r.gapZ, 2)}σ), traded a ${fmt(r.range)}-point range `
    + `(${fmt(r.rangeZ, 2)}× the expected 1σ) and closed ${sgn(r.chg)} pts (${sgn(r.chgPct, 2)}%) at ${fmt(r.a.close, 2)}.`)
  const band = `${fmt(lv.down)}–${fmt(lv.up)}`
  out.push({
    quiet: `A quiet range day: it never traded outside the trigger band ${band}.`,
    fakeout: `A fake-out: it broke ${r.brokeUp && r.brokeDown ? 'both triggers' : r.brokeUp ? `above ${fmt(lv.up)}` : `below ${fmt(lv.down)}`} but closed back inside ${band}.`,
    breakout: `A breakout: it held above the ${fmt(lv.up)} trigger into the close${r.a.close >= (lv.callWalls[0] ?? Infinity) ? ', through the call wall' : ''}.`,
    breakdown: `A breakdown: it held below the ${fmt(lv.down)} trigger into the close${r.a.close <= (lv.putWalls[0] ?? -Infinity) ? ', through the put wall' : ''}.`,
  }[r.scenario])
  const condor = plans.find((p) => p.plan.key === 'condor')
  if (condor) {
    const [, sp, sc] = condor.plan.legs
    const held = r.a.close > sp.strike && r.a.close < sc.strike
    const result = condor.pnl != null ? ` (${sgn(condor.pnl, 1)} pts)` : ''
    if (!condor.triggered) out.push(`The iron condor was skipped because the open was beyond a trigger; its short strikes would have ${held ? 'held' : 'been breached'}${result}.`)
    else if (held) out.push(`The iron condor's short strikes (${fmt(sp.strike)} / ${fmt(sc.strike)}) held${r.a.high >= sc.strike || r.a.low <= sp.strike ? ', though price touched one intraday' : ''}${result}.`)
    else out.push(`The iron condor was breached: Nifty closed ${r.a.close >= sc.strike ? `above the ${fmt(sc.strike)} short call` : `below the ${fmt(sp.strike)} short put`}${result}.`)
  }
  for (const p of plans.filter((x) => x.plan.key !== 'condor')) {
    out.push(p.triggered
      ? `The ${p.plan.name.toLowerCase()} triggered${p.pnl != null ? ` and finished ${sgn(p.pnl, 1)} pts from an entry at the trigger` : ''}.`
      : `The ${p.plan.name.toLowerCase()} never triggered.`)
  }
  if (r.vixChg != null) out.push(`India VIX ${r.vixChg >= 0 ? 'rose' : 'fell'} ${fmt(Math.abs(r.vixChg), 1)}%${r.a.vix != null ? ` to ${fmt(r.a.vix, 2)}` : ''}.`)
  return out
}
