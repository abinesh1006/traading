/**
 * Rules-based market read, computed in the browser from the latest end-of-day data each time the
 * dashboard loads or refreshes. Nothing here is a trained model: it is a transparent checklist, and
 * its own history is reported next to it so the reader can see how much (or how little) it has meant.
 *
 * Earlier research on this data (OLS on next-day direction, 2015-2026) found no daily input that beat
 * "always up" out of sample. So direction is shown with its base rate and a significance test, and
 * the forecast that *is* reliable, the size of the likely move, comes from implied volatility.
 */
import type { ChainRow, DailyMarket, IvDaily, OptionChain, ParticipantPosition } from './api'

export type Vote = 1 | 0 | -1
export interface Signal { label: string; detail: string; vote: Vote }
export type Verdict = 'Bullish' | 'Bearish' | 'Neutral'

export interface TrendView {
  verdict: Verdict
  strength: 'Strong' | 'Moderate' | 'Weak'
  score: number
  max: number
  signals: Signal[]
  sentiment: Signal[]
  sma20: number | null
  sma50: number | null
  sma200: number | null
}

const fmt = (v: number, d = 0) => v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })
const sign = (v: number): Vote => (v > 0 ? 1 : v < 0 ? -1 : 0)

/** Rolling simple moving averages over a close series; null until the window is full. */
function smaSeries(c: number[], n: number): Array<number | null> {
  const out: Array<number | null> = new Array(c.length).fill(null)
  let s = 0
  for (let i = 0; i < c.length; i++) {
    s += c[i]
    if (i >= n) s -= c[i - n]
    if (i >= n - 1) out[i] = s / n
  }
  return out
}

interface Series { dates: string[]; close: number[]; s20: Array<number | null>; s50: Array<number | null>; s200: Array<number | null> }

function series(daily: DailyMarket[]): Series {
  const rows = daily.filter((r) => r.spot_close != null)
  const close = rows.map((r) => r.spot_close as number)
  return { dates: rows.map((r) => r.trade_date), close, s20: smaSeries(close, 20), s50: smaSeries(close, 50), s200: smaSeries(close, 200) }
}

/** The six price signals at index i. Each votes +1 (bullish), -1 (bearish) or 0. */
function priceSignals(s: Series, i: number): Signal[] | null {
  const c = s.close[i], a = s.s20[i], b = s.s50[i], d = s.s200[i], a5 = s.s20[i - 5]
  if (a == null || b == null || d == null || a5 == null || i < 20) return null
  const mom = (c / s.close[i - 20] - 1) * 100
  const gap = (x: number) => `${(c / x - 1) * 100 > 0 ? '+' : ''}${fmt((c / x - 1) * 100, 1)}% (${fmt(x)})`
  return [
    { label: 'Above 20-DMA', detail: gap(a), vote: sign(c - a) },
    { label: 'Above 50-DMA', detail: gap(b), vote: sign(c - b) },
    { label: 'Above 200-DMA', detail: gap(d), vote: sign(c - d) },
    { label: '20-DMA rising', detail: `${a > a5 ? '+' : '−'}${fmt(Math.abs(a - a5), 0)} pts in 5d`, vote: sign(a - a5) },
    { label: '50-DMA > 200-DMA', detail: b > d ? 'Golden cross' : 'Death cross', vote: sign(b - d) },
    { label: '20-day momentum', detail: `${mom > 0 ? '+' : ''}${fmt(mom, 1)}%`, vote: mom > 1 ? 1 : mom < -1 ? -1 : 0 },
  ]
}

function verdictOf(score: number): Verdict {
  return score >= 3 ? 'Bullish' : score <= -3 ? 'Bearish' : 'Neutral'
}

export function trendView(daily: DailyMarket[], participants: ParticipantPosition[]): TrendView | null {
  const s = series(daily)
  const i = s.close.length - 1
  const signals = priceSignals(s, i)
  if (!signals) return null
  const score = signals.reduce((t, x) => t + x.vote, 0)
  const abs = Math.abs(score)

  // Supporting reads: shown, not counted in the verdict.
  const sentiment: Signal[] = []
  const last = daily[daily.length - 1]
  if (last.near_pcr_oi != null) {
    const p = last.near_pcr_oi
    sentiment.push({ label: 'PCR, near expiry', detail: `${fmt(p, 2)} (>1.2 firm)`, vote: p > 1.2 ? 1 : p < 0.8 ? -1 : 0 })
  }
  const fii = participants.filter((r) => r.client_type === 'FII' && r.fut_index_net != null)
  if (fii.length > 6) {
    const now = fii[fii.length - 1].fut_index_net!, then = fii[fii.length - 6].fut_index_net!
    sentiment.push({ label: 'FII futures, 5d change', detail: `${now - then > 0 ? '+' : ''}${fmt(now - then)}`, vote: sign(now - then) })
  }
  const vix = daily.map((r) => r.vix_close)
  const v0 = vix[vix.length - 1], v5 = vix[vix.length - 6]
  if (v0 != null && v5 != null) {
    const ch = (v0 / v5 - 1) * 100
    sentiment.push({ label: 'India VIX, 5d change', detail: `${ch > 0 ? '+' : ''}${fmt(ch, 1)}%`, vote: ch < -5 ? 1 : ch > 5 ? -1 : 0 })
  }

  return {
    verdict: verdictOf(score), strength: abs >= 5 ? 'Strong' : abs >= 3 ? 'Moderate' : 'Weak',
    score, max: signals.length, signals, sentiment,
    sma20: s.s20[i], sma50: s.s50[i], sma200: s.s200[i],
  }
}

/* ------------------------------------------------------------------ */
/* What happened historically after the same verdict                   */
/* ------------------------------------------------------------------ */

export interface HistoryCheck {
  verdict: Verdict
  n: number
  upPct: number
  baseUpPct: number
  baseN: number
  avg5d: number
  base5d: number
  z: number
  edge: boolean
  since: string
}

export function historyCheck(daily: DailyMarket[], verdict: Verdict): HistoryCheck | null {
  const s = series(daily)
  let n = 0, up = 0, f5 = 0, bn = 0, bup = 0, b5 = 0
  let since = ''
  for (let i = 200; i < s.close.length - 5; i++) {
    const sig = priceSignals(s, i)
    if (!sig) continue
    if (!since) since = s.dates[i]
    const nextUp = s.close[i + 1] > s.close[i] ? 1 : 0
    const r5 = (s.close[i + 5] / s.close[i] - 1) * 100
    bn++; bup += nextUp; b5 += r5
    if (verdictOf(sig.reduce((t, x) => t + x.vote, 0)) === verdict) { n++; up += nextUp; f5 += r5 }
  }
  if (!n || !bn) return null
  const p = up / n, pb = bup / bn
  const se = Math.sqrt((pb * (1 - pb)) / n)
  const z = se ? (p - pb) / se : 0
  return { verdict, n, upPct: p * 100, baseUpPct: pb * 100, baseN: bn, avg5d: f5 / n, base5d: b5 / bn, z, edge: Math.abs(z) >= 2, since }
}

/* ------------------------------------------------------------------ */
/* Volatility regime and expected ranges                               */
/* ------------------------------------------------------------------ */

export interface VolView {
  iv: number | null          // ATM IV 30d, % a year (VIX if IV is missing)
  ivSource: 'ATM IV 30d' | 'India VIX'
  ivPctile: number | null    // 1-year percentile of that IV
  rv: number | null
  ivMinusRv: number | null
  regime: 'High' | 'Normal' | 'Low'
  premium: 'Rich' | 'Fair' | 'Cheap'
  sellPremium: boolean
}

export function volView(iv: IvDaily[], daily: DailyMarket[]): VolView {
  const last = iv[iv.length - 1]
  const useIv = last?.iv_30d != null
  const hist = useIv ? iv.slice(-252).map((r) => r.iv_30d) : daily.slice(-252).map((r) => r.vix_close)
  const cur = useIv ? last.iv_30d : daily[daily.length - 1]?.vix_close ?? null
  const xs = hist.filter((x): x is number => x != null)
  const pctile = cur == null || !xs.length ? null : (xs.filter((x) => x <= cur).length / xs.length) * 100
  const rv = last?.rv_20d ?? null
  const gap = cur != null && rv != null ? cur - rv : null
  const regime = pctile == null ? 'Normal' : pctile >= 60 ? 'High' : pctile <= 30 ? 'Low' : 'Normal'
  const premium = gap == null ? 'Fair' : gap > 1.5 ? 'Rich' : gap < -1.5 ? 'Cheap' : 'Fair'
  return {
    iv: cur, ivSource: useIv ? 'ATM IV 30d' : 'India VIX', ivPctile: pctile, rv, ivMinusRv: gap, regime, premium,
    sellPremium: regime === 'High' || (regime === 'Normal' && premium !== 'Cheap'),
  }
}

export interface Ranges { spot: number; sigmaHour: number; sigmaDay: number; sigmaExpiry: number | null; straddle: number | null; dte: number | null }

/** One-sigma moves from annualised IV: an hour is ~1/6.25 of a 6h15m session; days to expiry are calendar days. */
export function ranges(spot: number, ivPct: number, dte: number | null, straddle: number | null): Ranges {
  const s = ivPct / 100
  return {
    spot,
    sigmaHour: spot * s * Math.sqrt(1 / (252 * 6.25)),
    sigmaDay: spot * s * Math.sqrt(1 / 252),
    sigmaExpiry: dte == null ? null : spot * s * Math.sqrt(Math.max(dte, 0.5) / 365),
    straddle, dte,
  }
}

/* ------------------------------------------------------------------ */
/* Strategy suggestion                                                 */
/* ------------------------------------------------------------------ */

export interface Leg { action: 'Buy' | 'Sell'; type: 'CE' | 'PE'; strike: number; price: number; delta: number | null }
export interface Plan {
  name: string
  stance: string
  why: string[]
  legs: Leg[]
  credit: number            // + credit received, - debit paid (index points)
  maxProfit: number | null  // points; null = unlimited
  maxLoss: number | null
  breakevens: number[]
  popPct: number | null     // rough chance of keeping the credit, from short-strike deltas
  lot: number | null
  expiry: string
  dte: number
}

type Side = 'CE' | 'PE'
const price = (r: ChainRow, t: Side) => (t === 'CE' ? r.ce_close : r.pe_close)
const delta = (r: ChainRow, t: Side) => (t === 'CE' ? r.ce_delta : r.pe_delta)
const vol = (r: ChainRow, t: Side) => (t === 'CE' ? r.ce_volume_contracts : r.pe_volume_contracts)

function liquid(chain: OptionChain, t: Side): ChainRow[] {
  return chain.rows.filter((r) => (price(r, t) ?? 0) > 0.5 && (vol(r, t) ?? 0) > 0)
}

/** The liquid strike whose |delta| is closest to target. */
function byDelta(chain: OptionChain, t: Side, target: number): ChainRow | undefined {
  return liquid(chain, t).filter((r) => delta(r, t) != null)
    .sort((a, b) => Math.abs(Math.abs(delta(a, t)!) - target) - Math.abs(Math.abs(delta(b, t)!) - target))[0]
}

/** The liquid strike nearest to `strike` (wings are placed a fixed distance from the short leg). */
function near(chain: OptionChain, t: Side, strike: number): ChainRow | undefined {
  return liquid(chain, t).sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike))[0]
}

const leg = (action: Leg['action'], type: Side, r: ChainRow): Leg => ({ action, type, strike: r.strike, price: price(r, type)!, delta: delta(r, type) })

const WING = 200 // points between short and long strikes of a spread

export function suggest(trend: TrendView, vv: VolView, chain: OptionChain, dte: number): Plan | { stand: string; why: string[] } {
  const why: string[] = [
    `Trend: ${trend.verdict.toLowerCase()} (${trend.score > 0 ? '+' : ''}${trend.score} of ±${trend.max} price signals).`,
    `Volatility: ${vv.regime.toLowerCase()} (${vv.ivSource} at the ${vv.ivPctile == null ? '—' : fmt(vv.ivPctile)}th 1-year percentile), premium ${vv.premium.toLowerCase()} vs realised.`,
  ]
  const base = { lot: chain.lot_size, expiry: chain.expiry, dte }
  const credit = (legs: Leg[]) => legs.reduce((t, l) => t + (l.action === 'Sell' ? l.price : -l.price), 0)

  if (trend.verdict === 'Neutral' && !vv.sellPremium) {
    return { stand: 'Stand aside', why: [...why, 'No clear direction and options are cheap, so selling premium pays little and buying needs a move the trend does not support. Wait for a trend or for volatility to rise.'] }
  }

  if (trend.verdict === 'Neutral') {
    const sp = byDelta(chain, 'PE', 0.2), sc = byDelta(chain, 'CE', 0.2)
    const lp = sp && near(chain, 'PE', sp.strike - WING), lc = sc && near(chain, 'CE', sc.strike + WING)
    if (!sp || !sc || !lp || !lc) return { stand: 'Stand aside', why: [...why, 'The chain has too few liquid strikes for an iron condor.'] }
    const legs = [leg('Buy', 'PE', lp), leg('Sell', 'PE', sp), leg('Sell', 'CE', sc), leg('Buy', 'CE', lc)]
    const cr = credit(legs)
    const width = Math.max(sp.strike - lp.strike, lc.strike - sc.strike)
    return {
      ...base, name: 'Iron condor', stance: 'Range-bound, sell rich premium',
      why: [...why, 'Sideways trend with premium worth selling: collect it on both sides, with defined risk beyond the wings.'],
      legs, credit: cr, maxProfit: cr, maxLoss: width - cr, breakevens: [sp.strike - cr, sc.strike + cr],
      popPct: (1 - Math.abs(sp.pe_delta ?? 0) - Math.abs(sc.ce_delta ?? 0)) * 100,
    }
  }

  const bull = trend.verdict === 'Bullish'
  if (vv.sellPremium) {
    // Credit spread on the side the trend points away from.
    const t: Side = bull ? 'PE' : 'CE'
    const short = byDelta(chain, t, 0.3)
    const long = short && near(chain, t, bull ? short.strike - WING : short.strike + WING)
    if (!short || !long) return { stand: 'Stand aside', why: [...why, 'The chain has too few liquid strikes for a credit spread.'] }
    const legs = bull ? [leg('Buy', t, long), leg('Sell', t, short)] : [leg('Sell', t, short), leg('Buy', t, long)]
    const cr = credit(legs)
    const width = Math.abs(short.strike - long.strike)
    return {
      ...base, name: bull ? 'Bull put spread' : 'Bear call spread', stance: bull ? 'Bullish, sell premium' : 'Bearish, sell premium',
      why: [...why, `${bull ? 'Up' : 'Down'}trend with premium worth selling: sell the ~0.30-delta ${t === 'PE' ? 'put' : 'call'} against the trend and buy protection ${WING} points further out.`],
      legs, credit: cr, maxProfit: cr, maxLoss: width - cr,
      breakevens: [bull ? short.strike - cr : short.strike + cr],
      popPct: (1 - Math.abs(delta(short, t) ?? 0)) * 100,
    }
  }

  // Debit spread in the direction of the trend: cheap options, so buy them.
  const t: Side = bull ? 'CE' : 'PE'
  const long = byDelta(chain, t, 0.5)
  const short = byDelta(chain, t, 0.25)
  if (!long || !short || long.strike === short.strike) return { stand: 'Stand aside', why: [...why, 'The chain has too few liquid strikes for a debit spread.'] }
  const legs = [leg('Buy', t, long), leg('Sell', t, short)]
  const debit = -credit(legs)
  const width = Math.abs(short.strike - long.strike)
  return {
    ...base, name: bull ? 'Bull call spread' : 'Bear put spread', stance: bull ? 'Bullish, buy cheap premium' : 'Bearish, buy cheap premium',
    why: [...why, `${bull ? 'Up' : 'Down'}trend with cheap options: buy the at-the-money ${t === 'CE' ? 'call' : 'put'} and sell the ~0.25-delta one to cut the cost.`],
    legs, credit: -debit, maxProfit: width - debit, maxLoss: debit,
    breakevens: [bull ? long.strike + debit : long.strike - debit], popPct: null,
  }
}

/** Calendar days between two ISO dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
}
