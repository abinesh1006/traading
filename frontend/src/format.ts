const intl = (digits: number) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const cache = new Map<number, Intl.NumberFormat>()
function nf(digits: number) {
  let f = cache.get(digits)
  if (!f) {
    f = intl(digits)
    cache.set(digits, f)
  }
  return f
}

export const DASH = '—'

export function num(v: number | null | undefined, digits = 0): string {
  return v == null || !Number.isFinite(v) ? DASH : nf(digits).format(v)
}

export function pct(v: number | null | undefined, digits = 2, signed = false): string {
  if (v == null || !Number.isFinite(v)) return DASH
  const s = nf(digits).format(v)
  return `${signed && v > 0 ? '+' : ''}${s}%`
}

/** Compact Indian units: 1.2 L (lakh), 3.4 Cr (crore). */
export function compact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH
  const a = Math.abs(v)
  if (a >= 1e7) return `${nf(2).format(v / 1e7)} Cr`
  if (a >= 1e5) return `${nf(2).format(v / 1e5)} L`
  if (a >= 1e3) return `${nf(1).format(v / 1e3)} K`
  return nf(0).format(v)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-11-06" -> "06 Nov 2026" (dates are calendar dates; no timezone shifts). */
export function date(iso: string | null | undefined): string {
  if (!iso) return DASH
  const [y, m, d] = iso.split('-')
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`
}

/** Axis tick: "Nov 26" style, compact. */
export function monthTick(iso: string): string {
  const [y, m] = iso.split('-')
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}

/** Axis tick: "06 Nov", for short ranges where month labels would repeat. */
export function dayTick(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d} ${MONTHS[Number(m) - 1]}`
}

/** Axis tick: "2026", for multi-year ranges. */
export function yearTick(iso: string): string {
  return iso.slice(0, 4)
}

const MONTH_STEPS = [1, 2, 3, 6, 12, 24]

/**
 * Explicit ticks for a daily date axis, placed on calendar boundaries so no label repeats.
 * Up to ~4 months: every n-th trading day, "06 Nov". Longer: the first trading day of every
 * 1/2/3/6 months ("Jan 26"), or of every 1/2 years ("2026"), whichever fits in maxTicks.
 */
export function timeAxis(dates: string[], maxTicks = 7): { ticks: string[]; format: (iso: string) => string } {
  if (dates.length === 0) return { ticks: [], format: monthTick }
  const days = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86_400_000
  if (days <= 120) {
    const step = Math.max(1, Math.ceil(dates.length / maxTicks))
    return { ticks: dates.filter((_, i) => i % step === 0), format: dayTick }
  }
  const firsts: string[] = []
  let prev = ''
  for (const d of dates) {
    const ym = d.slice(0, 7)
    if (ym !== prev) firsts.push(d)
    prev = ym
  }
  if (Number(firsts[0].slice(8, 10)) > 7) firsts.shift() // range starts mid-month: no tick for the stub
  const step = MONTH_STEPS.find((s) => Math.ceil(firsts.length / s) <= maxTicks) ?? 24
  const ticks = firsts.filter((d) => {
    const [y, m] = d.split('-').map(Number)
    return (y * 12 + m - 1) % step === 0 // Jan/Jul for 6 months, Jan of even years for 24
  })
  return { ticks, format: step >= 12 ? yearTick : monthTick }
}

export function signClass(v: number | null | undefined): string {
  if (v == null || v === 0) return ''
  return v > 0 ? 'up' : 'down'
}
