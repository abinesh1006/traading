import { useSyncExternalStore } from 'react'

/**
 * Recording mode: hides trade ideas (strategies, strikes, P&L) on every screen so the app can be
 * screen-recorded for a channel without showing buy/sell suggestions, and adds a disclaimer line.
 * Remembered per browser; works for the session even when storage is blocked.
 */
const KEY = 'niftyquant.recording'
const listeners = new Set<() => void>()
let current = (() => {
  // ?rec=1 / ?rec=0 in any link switches it (handy as a bookmark for recording sessions).
  const q = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('rec')
  if (q === '1' || q === '0') {
    try {
      localStorage.setItem(KEY, q)
    } catch {
      // storage blocked: applies to this visit
    }
    return q === '1'
  }
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
})()

export const isRecording = () => current

export function setRecording(on: boolean) {
  current = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // storage unavailable: the mode still applies until reload
  }
  for (const l of listeners) l()
}

export function useRecording(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    () => current,
  )
}

export const DISCLAIMER = 'Educational analysis · not investment advice · not SEBI-registered'
