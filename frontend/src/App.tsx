import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactElement } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api } from './api'
import { Brief } from './brief'
import { LiveTicker, MarketStrip } from './live'
import { useLive } from './useLive'
import { date, num, pct, signClass } from './format'
import { ChainPage } from './pages/ChainPage'
import { DataHealthPage } from './pages/DataHealthPage'
import { EventsPage } from './pages/EventsPage'
import { MarketPage } from './pages/MarketPage'
import { ParticipantsPage } from './pages/ParticipantsPage'
import { ResultsPage } from './pages/ResultsPage'
import { applyTheme, loadTheme, type ThemeChoice } from './theme'

const NEXT: Record<ThemeChoice, ThemeChoice> = { dark: 'light', light: 'system', system: 'dark' }
const THEME_LABEL: Record<ThemeChoice, string> = {
  dark: 'Dark theme (click for light)',
  light: 'Light theme (click for system)',
  system: 'Theme follows system (click for dark)',
}

const svg = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
}
const THEME_ICON: Record<ThemeChoice, ReactElement> = {
  system: <svg {...svg}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>,
  light: <svg {...svg}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  dark: <svg {...svg}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>,
}

const ICON: Record<string, ReactElement> = {
  '/market': <svg {...svg}><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>,
  '/chain': <svg {...svg}><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M3 10h18M3 15h18M12 4v16" /></svg>,
  '/positioning': <svg {...svg}><path d="M5 20V10M12 20V4M19 20v-7" /></svg>,
  '/events': <svg {...svg}><rect x="3" y="5" width="18" height="16" rx="1" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  '/results': <svg {...svg}><path d="M4 20h16" /><rect x="5" y="11" width="3" height="6" rx="0.5" /><rect x="10.5" y="7" width="3" height="10" rx="0.5" /><rect x="16" y="13" width="3" height="4" rx="0.5" /><path d="M5 7l4-3 4 2 6-3" /></svg>,
  '/data': <svg {...svg}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>,
}

const NAV = [
  { to: '/market', label: 'Market overview' },
  { to: '/chain', label: 'Option chain' },
  { to: '/positioning', label: 'Positioning' },
  { to: '/events', label: 'Events' },
  { to: '/results', label: 'Results' },
  { to: '/data', label: 'Data health' },
]

/** Sidebar card: how fresh the data is (the dashboard is end-of-day until the intraday feed exists). */
function SideStatus() {
  const q = useQuery({ queryKey: ['daily'], queryFn: api.daily })
  const ev = useQuery({ queryKey: ['events'], queryFn: api.events })
  const [today] = useState(todayIst)
  const last = q.data?.[q.data.length - 1]
  // Today is a trading day if it is a weekday or a listed special session (e.g. Diwali Muhurat).
  const weekday = ![0, 6].includes(new Date(`${today}T00:00:00Z`).getUTCDay())
  const special = (ev.data ?? []).some((e) => e.category === 'special_session' && e.event_date === today)
  const pending = last != null && last.trade_date < today && (weekday || special)
  return (
    <div className="sidenav-foot">
      <b className={q.error ? 'off' : undefined}>{q.error ? 'Backend offline' : 'End-of-day data'}</b>
      {last ? `Data as of ${date(last.trade_date)} close · NSE` : 'Waiting for data…'}
      {pending && <span className="foot-hint">Today's {special ? 'special session' : 'session'} loads after NSE publishes, about 20:00 IST.</span>}
    </div>
  )
}

/** Today's date in India (YYYY-MM-DD), whatever the viewer's clock zone. */
function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
}

/** Live quotes when /api/live answers; otherwise the end-of-day ticker. */
function TopQuotes() {
  const live = useLive()
  return live.data ? <LiveTicker /> : <Ticker />
}

/** Nifty and VIX at the last close, always visible: the two numbers a trader checks first. */
function Ticker() {
  const q = useQuery({ queryKey: ['daily'], queryFn: api.daily })
  const d = q.data ?? []
  const last = d[d.length - 1]
  const prev = d[d.length - 2]
  if (!last) return null
  const vixChg = last.vix_close != null && prev?.vix_close ? (last.vix_close / prev.vix_close - 1) * 100 : null
  return (
    <div className="ticker" aria-label="Last close">
      <div className="tick">
        <span className="tick-label">NIFTY 50</span>
        <span className="tick-value">{num(last.spot_close, 2)}</span>
        <span className={`tick-chg ${signClass(last.spot_return_pct)}`}>{pct(last.spot_return_pct, 2, true)}</span>
      </div>
      <span className="tick-sep" />
      <div className="tick">
        <span className="tick-label">INDIA VIX</span>
        <span className="tick-value">{num(last.vix_close, 2)}</span>
        <span className={`tick-chg ${signClass(vixChg)}`}>{pct(vixChg, 2, true)}</span>
      </div>
      <span className="tick-sep" />
      <div className="tick"><span className="tick-label">EOD {date(last.trade_date)}</span></div>
    </div>
  )
}

export default function App() {
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [briefOpen, setBriefOpen] = useState(false)
  const showBrief = briefOpen || pathname === '/brief'
  const closeBrief = () => {
    setBriefOpen(false)
    if (pathname === '/brief') navigate('/market')
  }
  // "B" opens the Market Brief from anywhere (not while typing in a field).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey || (t && /^(input|select|textarea)$/i.test(t.tagName))) return
      if (e.key.toLowerCase() === 'b') { e.preventDefault(); setBriefOpen(true) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const here = NAV.find((n) => pathname.startsWith(n.to))?.label ?? 'Market overview'
  const cycle = () => {
    const next = NEXT[theme]
    applyTheme(next)
    setTheme(next)
  }
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/market" className="logo" aria-label="Nifty Quant home"><img src="/favicon.svg" alt="" /></NavLink>
        <nav className="crumbs" aria-label="Breadcrumb">
          <span className="lead">Home</span><span className="sep lead">›</span>
          <span className="lead">Dashboards</span><span className="sep lead">›</span>
          <span>Nifty Quant</span><span className="sep">›</span>
          <span className="here">{here}</span>
        </nav>
        <div className="topbar-spacer" />
        <TopQuotes />
        <button className="icon-btn brief-btn" onClick={() => setBriefOpen(true)} title="Market Brief: one-screen summary (B)">
          <svg {...svg}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4M7 12l3-3 2 2 4-4" /></svg>
          Brief
        </button>
        <button className="icon-btn ghost" onClick={cycle} aria-label={THEME_LABEL[theme]} title={THEME_LABEL[theme]}>
          {THEME_ICON[theme]}
        </button>
      </header>
      <div className="shell">
        <nav className="sidenav" aria-label="Dashboards">
          <div className="sidenav-head">Dashboards</div>
          {NAV.map((n) => <NavLink key={n.to} to={n.to}>{ICON[n.to]}<span>{n.label}</span></NavLink>)}
          <SideStatus />
        </nav>
        <main className="page">
          <MarketStrip />
          <Routes>
            <Route path="/" element={<Navigate to="/market" replace />} />
            <Route path="/market" element={<MarketPage />} />
            <Route path="/brief" element={<MarketPage />} />
            <Route path="/chain" element={<ChainPage />} />
            <Route path="/positioning" element={<ParticipantsPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/results" element={<ResultsPage />} />
            <Route path="/data" element={<DataHealthPage />} />
            <Route path="*" element={<Navigate to="/market" replace />} />
          </Routes>
        </main>
      </div>
      {showBrief && <Brief onClose={closeBrief} />}
    </div>
  )
}
