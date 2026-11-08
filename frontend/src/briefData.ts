/**
 * Calculations behind the Market Brief (one presentation screen per Day / Week / Month).
 * Everything is derived from the end-of-day data the dashboard already loads; the narrative is
 * written by rules from those numbers, not by a language model.
 */
import type { Plan, TrendView } from './analysis'
import type { DailyMarket, MarketEvent, OptionChain, ParticipantPosition } from './api'

export type Period = 'D' | 'W' | 'M'
type Row = DailyMarket & { spot_close: number }

const fmt = (v: number, d = 0) => v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })
const sgn = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), d)}`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()
export const dayLabel = (iso: string) => `${DAYS[dow(iso)]} ${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`
const shiftDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const mondayOf = (iso: string) => shiftDays(iso, -((dow(iso) + 6) % 7))

/* ------------------------------------------------------------------ */
/* Period window                                                       */
/* ------------------------------------------------------------------ */

export interface Slice {
  period: Period
  title: string          // "Sat 08 Nov 2026", "Week of 02–08 Nov 2026", "November 2026"
  start: string          // first calendar day of the period
  rows: Row[]            // sessions in the period
  base: Row | undefined  // last session before the period
  last: Row
  ret: number | null     // % change vs base
  pts: number | null
}

function closes(daily: DailyMarket[]): Row[] {
  return daily.filter((r): r is Row => r.spot_close != null)
}

function periodKey(iso: string, p: Period): string {
  return p === 'D' ? iso : p === 'W' ? mondayOf(iso) : iso.slice(0, 7)
}

export function slice(daily: DailyMarket[], period: Period): Slice | null {
  const rows = closes(daily)
  const last = rows[rows.length - 1]
  if (!last) return null
  const key = periodKey(last.trade_date, period)
  const start = period === 'D' ? last.trade_date : period === 'W' ? key : `${key}-01`
  const firstIdx = rows.findIndex((r) => r.trade_date >= start)
  const inPeriod = rows.slice(firstIdx)
  const base = rows[firstIdx - 1]
  const y = last.trade_date.slice(0, 4)
  const title = period === 'D'
    ? `${dayLabel(last.trade_date)} ${y}`
    : period === 'W'
      ? `Week of ${start.slice(8, 10)}${start.slice(5, 7) === last.trade_date.slice(5, 7) ? '' : ` ${MONTHS[Number(start.slice(5, 7)) - 1]}`}–${last.trade_date.slice(8, 10)} ${MONTHS[Number(last.trade_date.slice(5, 7)) - 1]} ${y}`
      : `${MONTHS_LONG[Number(key.slice(5, 7)) - 1]} ${y}`
  const ret = base ? (last.spot_close / base.spot_close - 1) * 100 : null
  return { period, title, start, rows: inPeriod, base, last, ret, pts: base ? last.spot_close - base.spot_close : null }
}

/** Period returns for every day, week or month in history (close-to-close, oldest first). */
function periodReturns(daily: DailyMarket[], p: Period): Array<{ key: string; end: string; ret: number }> {
  const rows = closes(daily)
  const out: Array<{ key: string; end: string; ret: number }> = []
  let prevClose: number | null = null
  for (let i = 0; i < rows.length; i++) {
    const k = periodKey(rows[i].trade_date, p)
    const lastOfGroup = i === rows.length - 1 || periodKey(rows[i + 1].trade_date, p) !== k
    if (!lastOfGroup) continue
    if (prevClose != null) out.push({ key: k, end: rows[i].trade_date, ret: (rows[i].spot_close / prevClose - 1) * 100 })
    prevClose = rows[i].spot_close
  }
  return out
}

/** "its best week since Aug 2025" / "its worst month on record (since 2015)", or null if unremarkable. */
export function recordText(daily: DailyMarket[], p: Period): string | null {
  const hist = periodReturns(daily, p)
  const cur = hist[hist.length - 1]
  if (!cur || hist.length < 10) return null
  const up = cur.ret >= 0
  const unit = p === 'D' ? (up ? 'biggest one-day gain' : 'biggest one-day fall') : `${up ? 'best' : 'worst'} ${p === 'W' ? 'week' : 'month'}`
  for (let i = hist.length - 2; i >= 0; i--) {
    if (up ? hist[i].ret >= cur.ret : hist[i].ret <= cur.ret) {
      const ago = hist.length - 1 - i
      if (ago < (p === 'D' ? 20 : p === 'W' ? 8 : 6)) return null // not notable
      const e = hist[i].end
      return `its ${unit} since ${p === 'M' ? `${MONTHS[Number(e.slice(5, 7)) - 1]} ${e.slice(0, 4)}` : `${e.slice(8, 10)} ${MONTHS[Number(e.slice(5, 7)) - 1]} ${e.slice(0, 4)}`}`
    }
  }
  return `its ${unit} on record (since ${hist[0].end.slice(0, 4)})`
}

/* ------------------------------------------------------------------ */
/* History strip                                                       */
/* ------------------------------------------------------------------ */

export interface History {
  returns: Array<{ label: string; ret: number | null }>
  low52: number; high52: number; pos52: number; fromHigh: number
  streak: number   // + up days in a row, − down days
}

export function history(daily: DailyMarket[]): History | null {
  const rows = closes(daily)
  const last = rows[rows.length - 1]
  if (!last) return null
  const closeOnOrBefore = (iso: string) => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].trade_date <= iso) return rows[i].spot_close
    return null
  }
  const ret = (base: number | null) => (base ? (last.spot_close / base - 1) * 100 : null)
  const d = last.trade_date
  const prevYearEnd = closeOnOrBefore(`${Number(d.slice(0, 4)) - 1}-12-31`)
  const returns = [
    { label: '1D', ret: ret(rows[rows.length - 2]?.spot_close ?? null) },
    { label: '1W', ret: ret(closeOnOrBefore(shiftDays(d, -7))) },
    { label: '1M', ret: ret(closeOnOrBefore(shiftDays(d, -30))) },
    { label: '3M', ret: ret(closeOnOrBefore(shiftDays(d, -91))) },
    { label: '6M', ret: ret(closeOnOrBefore(shiftDays(d, -182))) },
    { label: 'YTD', ret: ret(prevYearEnd) },
    { label: '1Y', ret: ret(closeOnOrBefore(shiftDays(d, -365))) },
  ]
  const yr = rows.slice(-252)
  const high52 = Math.max(...yr.map((r) => r.spot_high ?? r.spot_close))
  const low52 = Math.min(...yr.map((r) => r.spot_low ?? r.spot_close))
  let streak = 0
  for (let i = rows.length - 1; i > 0; i--) {
    const up = rows[i].spot_close > rows[i - 1].spot_close
    if (streak === 0) streak = up ? 1 : -1
    else if ((streak > 0) === up) streak += up ? 1 : -1
    else break
  }
  return {
    returns, low52, high52,
    pos52: high52 > low52 ? ((last.spot_close - low52) / (high52 - low52)) * 100 : 50,
    fromHigh: (last.spot_close / high52 - 1) * 100, streak,
  }
}

/* ------------------------------------------------------------------ */
/* Market mood: a transparent composite, 0 (extreme fear) to 100        */
/* ------------------------------------------------------------------ */

export interface Mood { score: number; zone: string; tone: 'good' | 'warning' | 'critical'; parts: Array<{ label: string; value: number; detail: string }> }

const clamp = (v: number) => Math.max(0, Math.min(100, v))
const pctRank = (xs: Array<number | null>, v: number | null) => {
  const a = xs.filter((x): x is number => x != null)
  return v == null || !a.length ? null : (a.filter((x) => x <= v).length / a.length) * 100
}

export function mood(daily: DailyMarket[], participants: ParticipantPosition[], trend: TrendView | null, h: History | null): Mood | null {
  const last = daily[daily.length - 1]
  if (!last) return null
  const parts: Mood['parts'] = []
  if (trend) parts.push({ label: 'Trend', value: ((trend.score + trend.max) / (2 * trend.max)) * 100, detail: `${trend.score > 0 ? '+' : ''}${trend.score} of ±${trend.max} price rules` })
  const vixP = pctRank(daily.slice(-252).map((r) => r.vix_close), last.vix_close)
  if (vixP != null) parts.push({ label: 'Calm (VIX)', value: 100 - vixP, detail: `VIX ${fmt(last.vix_close ?? 0, 2)}, ${fmt(vixP)}th pct` })
  if (last.near_pcr_oi != null) parts.push({ label: 'Put-call ratio', value: clamp(((last.near_pcr_oi - 0.7) / 0.6) * 100), detail: `PCR ${fmt(last.near_pcr_oi, 2)}` })
  const fii = participants.filter((p) => p.client_type === 'FII' && p.fut_index_long_pct != null).slice(-252)
  const fiiP = fii.length ? pctRank(fii.map((p) => p.fut_index_long_pct), fii[fii.length - 1].fut_index_long_pct) : null
  if (fiiP != null) parts.push({ label: 'FII long share', value: fiiP, detail: `${fmt(fii[fii.length - 1].fut_index_long_pct!, 1)}% long, ${fmt(fiiP)}th pct` })
  if (h) parts.push({ label: '52-week position', value: h.pos52, detail: `${fmt(h.fromHigh, 1)}% from the high` })
  if (!parts.length) return null
  const score = parts.reduce((t, p) => t + p.value, 0) / parts.length
  const zone = score < 25 ? 'Extreme fear' : score < 45 ? 'Fear' : score < 55 ? 'Neutral' : score < 75 ? 'Greed' : 'Extreme greed'
  return { score, zone, tone: score < 45 ? 'critical' : score < 55 ? 'warning' : 'good', parts }
}

/* ------------------------------------------------------------------ */
/* Positioning change over the period                                  */
/* ------------------------------------------------------------------ */

export interface PosRow { who: string; key: ParticipantPosition['client_type']; longPct: number | null; net: number | null; netChange: number | null }

export function positioning(participants: ParticipantPosition[], s: Slice): PosRow[] {
  const at = (date: string | undefined, who: string) =>
    date == null ? undefined : participants.filter((p) => p.client_type === who && p.trade_date <= date).at(-1)
  const names: Record<string, string> = { FII: 'FII', DII: 'DII', Client: 'Retail', Pro: 'Prop desks' }
  return (['FII', 'DII', 'Client', 'Pro'] as const).map((k) => {
    const now = at(s.last.trade_date, k), then = at(s.base?.trade_date, k)
    return {
      who: names[k], key: k, longPct: now?.fut_index_long_pct ?? null, net: now?.fut_index_net ?? null,
      netChange: now?.fut_index_net != null && then?.fut_index_net != null ? now.fut_index_net - then.fut_index_net : null,
    }
  })
}

/* ------------------------------------------------------------------ */
/* Events in the period                                                */
/* ------------------------------------------------------------------ */

const EVENT_KINDS = new Set(['rbi_policy', 'fomc', 'us_cpi', 'union_budget', 'election', 'special_session'])

const SHORT: Record<string, string> = {
  rbi_policy: 'RBI policy', fomc: 'Fed (FOMC)', us_cpi: 'US CPI', union_budget: 'Union Budget',
  election: 'Election results', special_session: 'Special session',
}
/** Short event name for tight spots: "US CPI · Tue 10 Nov". */
export const eventShort = (e: MarketEvent) => `${SHORT[e.category] ?? e.name} · ${dayLabel(e.event_date)}`

/** "Diwali Muhurat session" from an event name like "Diwali Muhurat (14:20-15:30)". */
const sessionName = (name: string) => {
  const n = name.replace(/\s*\(.*\)$/, '')
  return /session|trading$/i.test(n) ? n : `${n} session`
}

export function periodEvents(events: MarketEvent[], s: Slice): MarketEvent[] {
  return events.filter((e) => EVENT_KINDS.has(e.category) && e.event_date >= s.start && e.event_date <= s.last.trade_date)
}

export function upcomingEvents(events: MarketEvent[], after: string, n = 3): MarketEvent[] {
  return events.filter((e) => EVENT_KINDS.has(e.category) && e.event_date > after).slice(0, n)
}

/* ------------------------------------------------------------------ */
/* What happened: rules-written sentences                              */
/* ------------------------------------------------------------------ */

export function narrative(daily: DailyMarket[], s: Slice, pos: PosRow[], events: MarketEvent[]): string[] {
  const out: string[] = []
  const last = s.last
  const word = s.period === 'D' ? '' : s.period === 'W' ? ' this week' : ` in ${MONTHS_LONG[Number(last.trade_date.slice(5, 7)) - 1]}`
  if (s.ret != null && s.pts != null) {
    const special = events.find((e) => e.category === 'special_session' && e.event_date === last.trade_date)
    const rec = recordText(daily, s.period)
    out.push(`Nifty ${s.ret >= 0 ? 'rose' : 'fell'} ${fmt(Math.abs(s.ret), 2)}% (${sgn(s.pts, 0)} pts)${word} to ${fmt(last.spot_close, 2)}`
      + `${s.period === 'D' && special ? ` in the ${sessionName(special.name)}` : ''}${rec ? `, ${rec}` : ''}.`)
  }
  if (s.period !== 'D' && s.rows.length > 1) {
    const withPrev = s.rows.map((r, i) => {
      const prev = i === 0 ? s.base : s.rows[i - 1]
      return { r, ret: prev ? (r.spot_close / prev.spot_close - 1) * 100 : null }
    }).filter((x): x is { r: Row; ret: number } => x.ret != null)
    if (withPrev.length > 1) {
      const best = withPrev.reduce((a, b) => (b.ret > a.ret ? b : a)), worst = withPrev.reduce((a, b) => (b.ret < a.ret ? b : a))
      out.push(`Best day ${dayLabel(best.r.trade_date)} (${sgn(best.ret)}%), weakest ${dayLabel(worst.r.trade_date)} (${sgn(worst.ret)}%), across ${s.rows.length} sessions.`)
    }
  } else if (s.period === 'D' && s.base) {
    const prev = closes(daily).at(-3)
    if (prev && s.base) {
      const pr = (s.base.spot_close / prev.spot_close - 1) * 100
      if (Math.abs(pr) >= 0.8) out.push(`That follows a ${sgn(pr)}% move on ${dayLabel(s.base.trade_date)}.`)
    }
  }
  const vixNow = last.vix_close, vixBase = s.base?.vix_close
  if (vixNow != null && vixBase != null) {
    const ch = (vixNow / vixBase - 1) * 100
    const vixRows = s.rows.map((r) => r.vix_close).filter((v): v is number => v != null)
    const range = s.period !== 'D' && vixRows.length > 1 ? ` (range ${fmt(Math.min(...vixRows), 1)}–${fmt(Math.max(...vixRows), 1)})` : ''
    let hi = ''
    if (s.period === 'D' && ch > 0) {
      const all = closes(daily)
      let n = 0
      for (let i = all.length - 2; i >= 0 && (all[i].vix_close ?? 0) < vixNow; i--) n++
      if (n >= 10) hi = `, its highest close in ${n} sessions`
    }
    out.push(`India VIX ${ch >= 0 ? 'rose' : 'fell'} ${fmt(Math.abs(ch), 1)}% to ${fmt(vixNow, 2)}${range}${hi}.`)
  }
  const fii = pos.find((p) => p.key === 'FII'), cli = pos.find((p) => p.key === 'Client')
  if (fii?.netChange != null && fii.net != null) {
    const dir = fii.netChange >= 0 ? (fii.net < 0 ? 'cut net shorts by' : 'added net longs of') : (fii.net < 0 ? 'added net shorts of' : 'cut net longs by')
    out.push(`FIIs ${dir} ${fmt(Math.abs(fii.netChange))} index-futures contracts (now net ${fii.net >= 0 ? 'long' : 'short'} ${fmt(Math.abs(fii.net))})`
      + `${cli?.netChange != null ? `; retail ${cli.netChange >= 0 ? 'bought' : 'sold'} ${fmt(Math.abs(cli.netChange))}` : ''}.`)
  }
  const ev = periodEvents(events, s).filter((e) => e.category !== 'special_session')
  if (ev.length) out.push(`Events: ${ev.map((e) => `${e.name} (${dayLabel(e.event_date)})`).join('; ')}.`)
  if (last.max_pe_oi_strike != null && last.max_ce_oi_strike != null) {
    out.push(`Option writers are heaviest at ${fmt(last.max_pe_oi_strike)} (puts, support) and ${fmt(last.max_ce_oi_strike)} (calls, resistance); PCR ${fmt(last.near_pcr_oi ?? 0, 2)}.`)
  }
  // Four sentences fit the card at presentation size; the options detail has its own card.
  return out.slice(0, 4)
}

/* ------------------------------------------------------------------ */
/* Options snapshot and strategy payoff                                */
/* ------------------------------------------------------------------ */

export function maxPain(chain: OptionChain): number | null {
  const lot = chain.lot_size || 1
  const rows = chain.rows.map((r) => ({ k: r.strike, ce: (r.ce_oi_units ?? 0) / lot, pe: (r.pe_oi_units ?? 0) / lot }))
  let best: { k: number; pain: number } | null = null
  for (const c of rows) {
    const pain = rows.reduce((t, r) => t + r.ce * Math.max(0, c.k - r.k) + r.pe * Math.max(0, r.k - c.k), 0)
    if (!best || pain < best.pain) best = { k: c.k, pain }
  }
  return best?.k ?? null
}

/** Profit / loss per lot at expiry across a price range around the strikes. */
export function payoff(plan: Pick<Plan, 'legs' | 'lot'>, spot: number): Array<{ s: number; pnl: number }> {
  const ks = plan.legs.map((l) => l.strike)
  const lo = Math.min(spot, ...ks) * 0.975, hi = Math.max(spot, ...ks) * 1.025
  const lot = plan.lot ?? 1
  return Array.from({ length: 121 }, (_, i) => {
    const s = lo + ((hi - lo) * i) / 120
    const pnl = plan.legs.reduce((t, l) => {
      const intrinsic = l.type === 'CE' ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s)
      return t + (l.action === 'Buy' ? intrinsic - l.price : l.price - intrinsic)
    }, 0)
    return { s, pnl: pnl * lot }
  })
}
