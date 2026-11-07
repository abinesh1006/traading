import { useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'niftyquant.theme'

export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // storage unavailable: theme still applies for this session
  }
  window.dispatchEvent(new Event('themechange'))
}

export interface ChartColors {
  series: [string, string, string, string]
  text: string
  textSecondary: string
  muted: string
  grid: string
  axis: string
  surface: string
}

function read(): ChartColors {
  const s = getComputedStyle(document.documentElement)
  const v = (name: string) => s.getPropertyValue(name).trim()
  return {
    series: [v('--series-1'), v('--series-2'), v('--series-3'), v('--series-4')],
    text: v('--text-primary'),
    textSecondary: v('--text-secondary'),
    muted: v('--text-muted'),
    grid: v('--grid'),
    axis: v('--axis'),
    surface: v('--surface-1'),
  }
}

/** SVG attributes can't use CSS variables, so charts read resolved token values and re-render on theme change. */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState(read)
  useEffect(() => {
    const update = () => setColors(read())
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', update)
    window.addEventListener('themechange', update)
    return () => {
      mq.removeEventListener('change', update)
      window.removeEventListener('themechange', update)
    }
  }, [])
  return colors
}
