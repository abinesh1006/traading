import { useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { ChainPage } from './pages/ChainPage'
import { DataHealthPage } from './pages/DataHealthPage'
import { MarketPage } from './pages/MarketPage'
import { ParticipantsPage } from './pages/ParticipantsPage'
import { applyTheme, loadTheme, type ThemeChoice } from './theme'

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_LABEL: Record<ThemeChoice, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' }

export default function App() {
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme)
  const cycle = () => {
    const next = NEXT[theme]
    applyTheme(next)
    setTheme(next)
  }
  return (
    <>
      <header className="app-header">
        <div className="brand"><img src="/favicon.svg" alt="" />Nifty Quant</div>
        <nav className="nav">
          <NavLink to="/market">Market</NavLink>
          <NavLink to="/chain">Option chain</NavLink>
          <NavLink to="/positioning">Positioning</NavLink>
          <NavLink to="/data">Data health</NavLink>
        </nav>
        <div className="header-spacer" />
        <button className="btn" onClick={cycle} aria-label="Change theme">{THEME_LABEL[theme]}</button>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/market" replace />} />
          <Route path="/market" element={<MarketPage />} />
          <Route path="/chain" element={<ChainPage />} />
          <Route path="/positioning" element={<ParticipantsPage />} />
          <Route path="/data" element={<DataHealthPage />} />
          <Route path="*" element={<Navigate to="/market" replace />} />
        </Routes>
      </main>
    </>
  )
}
