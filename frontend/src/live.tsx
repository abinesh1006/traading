/**
 * Live view from GET /api/live: the market clock (open / pre-open / closed and why), the Fyers feed
 * state, Nifty / VIX / near-month future quotes, and today's 1-minute Nifty bars.
 *
 * Quotes say where they come from: source "live" is the WebSocket feed (pulsing dot); "close" is the
 * last end-of-day close and is labelled with its date, so it is never mistaken for a live price.
 * The API reads an in-memory feed, so polling every few seconds costs nothing at Fyers.
 */
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { IntradayBar, LiveFeed, LiveQuote, LiveView } from './api'
import { ChartTooltip } from './components/charts'
import { Change, ChartCard, DashRow, type Column } from './components/ui'
import { date, num, pct, signClass } from './format'
import { useChartColors } from './theme'
import { useLive } from './useLive'

const IST = 'Asia/Kolkata'
const istDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(d)
const istTime = (d: Date, seconds = false) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23' }).format(d)

/** "Opens 09:15" today, "Opens tomorrow 09:15", or "Opens Mon 09 Nov, 09:15". */
function opensText(nextOpen: string, now: string): string {
  const n = new Date(nextOpen), t = new Date(now)
  const days = Math.round((Date.parse(istDate(n)) - Date.parse(istDate(t))) / 86_400_000)
  if (days <= 0) return `Opens ${istTime(n)}`
  if (days === 1) return `Opens tomorrow ${istTime(n)}`
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'short', day: '2-digit', month: 'short' }).format(n)
  return `Opens ${day}, ${istTime(n)}`
}

const shortLabel = (q: LiveQuote) =>
  q.key === 'nifty' ? 'NIFTY 50' : q.key === 'vix' ? 'INDIA VIX' : q.label.replace(/^Nifty\s+/i, '').replace(/future/i, 'fut').toUpperCase()

/** Top-bar quotes. Falls back to nothing (the sidebar still shows the end-of-day date) if /api/live fails. */
export function LiveTicker() {
  const q = useLive()
  const v = q.data
  if (!v) return null
  const live = v.quotes.some((x) => x.source === 'live')
  const closeDate = v.quotes.find((x) => x.source === 'close')?.as_of
  return (
    <div className="ticker" aria-label={live ? 'Live prices' : 'Last close'}>
      {live
        ? <span className="tick live-tag"><span className="pulse" aria-hidden="true" />LIVE</span>
        : <span className="tick close-tag">Close · {date(closeDate).slice(0, 6)}</span>}
      {v.quotes.map((x) => (
        <div className="tick" key={x.key} title={`${x.label} · ${x.source === 'live' ? `live ${x.as_of ? istTime(new Date(x.as_of), true) : ''}` : `close ${date(x.as_of)}`}`}>
          <span className="tick-label">{shortLabel(x)}</span>
          <span className="tick-value">{num(x.ltp, 2)}</span>
          <span className={`tick-chg ${signClass(x.change_pct)}`}>{pct(x.change_pct, 2, true)}</span>
        </div>
      ))}
    </div>
  )
}

/** The Fyers login runs on the PC's API; a 127.0.0.1 login link only works from that PC. */
function loginReachable(url: string | null): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    const local = (h: string) => h === '127.0.0.1' || h === 'localhost'
    return !local(host) || local(window.location.hostname)
  } catch {
    return false
  }
}

function FeedStatus({ feed }: { feed: LiveFeed }) {
  const canLogin = loginReachable(feed.login_url)
  const connect = (label: string) => canLogin
    ? <a className="btn btn-accent" href={feed.login_url!} target="_blank" rel="noopener noreferrer">{label}</a>
    : null
  switch (feed.state) {
    case 'live':
      return (
        <span className="feed feed-live">
          <span className="pulse" aria-hidden="true" />Live feed
          {feed.last_tick_at && <span className="muted"> · last tick {istTime(new Date(feed.last_tick_at), true)}</span>}
        </span>
      )
    case 'connecting':
      return <span className="feed"><span className="spinner sm" aria-hidden="true" />Connecting to Fyers…</span>
    case 'login_required':
      return canLogin
        ? <span className="feed"><span className="muted" title={feed.message ?? undefined}>Live prices need a daily Fyers login</span>{connect('Connect Fyers')}</span>
        : <span className="feed muted" title={feed.message ?? undefined}>Live prices: Fyers login runs on the PC</span>
    case 'error':
    case 'disconnected':
    case 'stopped':
      return <span className="feed"><span className="feed-err">{feed.message ?? `Feed ${feed.state}`}</span>{connect('Reconnect')}</span>
    case 'not_configured':
    default:
      return <span className="feed muted" title={feed.message ?? undefined}>Live feed not set up</span>
  }
}

/** Market status strip shown above every page. Hidden if /api/live is unavailable. */
export function MarketStrip() {
  const q = useLive()
  const v: LiveView | undefined = q.data
  if (!v) return null
  const m = v.market
  const special = m.session_name && !/normal/i.test(m.session_name) && m.session_date === m.now.slice(0, 10)
  return (
    <div className={`mstrip st-${m.state}`} role="status" aria-live="polite">
      <span className="mstate"><span className={`mdot${m.state === 'open' ? ' pulse' : ''}`} aria-hidden="true" />{m.label}</span>
      <span className="mreason">{m.reason}{special ? ` · ${m.session_name}` : ''}</span>
      {m.state !== 'open' && m.next_open && <span className="mnext">{opensText(m.next_open, m.now)}</span>}
      {m.calendar_note && <span className="mnote">{m.calendar_note}</span>}
      <span className="mspacer" />
      <FeedStatus feed={v.feed} />
    </div>
  )
}

/** Today's 1-minute Nifty line, once the feed has bars. */
export function IntradayRow() {
  const q = useLive()
  const c = useChartColors()
  const bars = q.data?.bars ?? []
  if (bars.length < 2) return null
  const nifty = q.data!.quotes.find((x) => x.key === 'nifty')
  const data = bars.map((b) => ({ ...b, t: istTime(new Date(b.time)) }))
  const lo = Math.min(...bars.map((b) => b.low)), hi = Math.max(...bars.map((b) => b.high))
  const cols: Column<IntradayBar & { t: string }>[] = [
    { label: 'Time', value: (b) => b.t, align: 'left' },
    { label: 'Open', value: (b) => num(b.open, 2) },
    { label: 'High', value: (b) => num(b.high, 2) },
    { label: 'Low', value: (b) => num(b.low, 2) },
    { label: 'Close', value: (b) => num(b.close, 2) },
  ]
  return (
    <DashRow title="Today · live">
      <ChartCard w={24} title="Nifty 50 · today, 1-minute" subtitle="1-minute closes from the live feed, IST."
                 note={`Day range ${num(lo, 2)} – ${num(hi, 2)}.`}
                 value={num(nifty?.ltp, 2)}
                 change={nifty ? <Change value={nifty.change} text={`${nifty.change != null && nifty.change > 0 ? '+' : ''}${num(nifty.change, 2)} (${pct(nifty.change_pct, 2, true)})`} /> : undefined}
                 table={{ columns: cols, rows: [...data].reverse() }}>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="intraday-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c.series[0]} stopOpacity={0.3} />
                <stop offset="100%" stopColor={c.series[0]} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={c.grid} strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="t" axisLine={false} tickLine={false} minTickGap={48} tick={{ fill: c.muted, fontSize: 11.5 }} />
            <YAxis domain={['auto', 'auto']} width={56} axisLine={false} tickLine={false} tick={{ fill: c.muted, fontSize: 11.5 }}
                   tickFormatter={(v: number) => num(v)} />
            <Tooltip cursor={{ stroke: c.muted, strokeDasharray: '3 3' }} isAnimationActive={false}
                     content={(p) => <ChartTooltip {...p} format={(v) => num(v, 2)} labelFormat={(s) => `${s} IST`} />} />
            <Area type="monotone" dataKey="close" stroke="none" fill="url(#intraday-fill)" baseValue="dataMin"
                  isAnimationActive={false} activeDot={false} tooltipType="none" />
            <Line type="monotone" dataKey="close" name="Nifty 50" stroke={c.series[0]} strokeWidth={2} dot={false}
                  activeDot={{ r: 5, stroke: c.surface, strokeWidth: 3, fill: c.series[0] }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>
    </DashRow>
  )
}
