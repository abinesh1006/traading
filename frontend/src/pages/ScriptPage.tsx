import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { dayLabel } from '../briefData'
import { writeScript, type Lang } from '../script'
import { useSessionModel, type View } from '../useSessionModel'
import '../session.css'

const LANG_KEY = 'niftyquant.script.lang'
const SIZE_KEY = 'niftyquant.script.size'
const load = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // storage blocked: the choice lasts for this visit only
  }
}

/**
 * Voiceover script, full screen and large, made to be read from a phone while the PC screen records.
 * /script?d=2026-11-09&v=pre|post
 */
export function ScriptPage() {
  const [params, setParams] = useSearchParams()
  const m = useSessionModel(params.get('d'), params.get('v'))
  const [lang, setLangState] = useState<Lang>(() => {
    const asked = params.get('lang')
    return asked === 'ta' || asked === 'en' ? asked : load(LANG_KEY) === 'ta' ? 'ta' : 'en'
  })
  const [size, setSizeState] = useState(() => Math.min(48, Math.max(20, Number(load(SIZE_KEY)) || 30)))
  const [copied, setCopied] = useState(false)
  const setLang = (l: Lang) => { setLangState(l); save(LANG_KEY, l) }
  const setSize = (s: number) => { const v = Math.min(48, Math.max(20, s)); setSizeState(v); save(SIZE_KEY, String(v)) }
  const { d, prev, sigma, lv, type, view } = m
  const go = (p: { d?: string; v?: View }) => setParams({ d: p.d ?? d ?? '', v: p.v ?? view })

  const sc = d && prev && sigma && lv && type
    ? writeScript({ kind: view, d, prev, sigma, lv, type, odds: m.odds, evs: m.evs, rv: m.rv, fiiChange: m.fiiChange }, lang)
    : null
  const copy = async () => {
    if (!sc) return
    try {
      await navigator.clipboard.writeText(sc.lines.join('\n\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="scr">
      <header className="scr-bar">
        <a className="scr-back" href={d ? `/session?d=${d}&v=${view}` : '/session'}>← Pre / post market</a>
        {d && (
          <select value={d} onChange={(e) => go({ d: e.target.value })} aria-label="Session">
            {m.sessions.slice(0, 60).map((s) => <option key={s} value={s}>{dayLabel(s)} {s.slice(0, 4)}{s === m.upcoming ? ' · next' : ''}</option>)}
          </select>
        )}
        <div className="seg" role="group" aria-label="Script">
          <button aria-pressed={view === 'pre'} onClick={() => go({ v: 'pre' })}>Pre-market</button>
          <button aria-pressed={view === 'post'} onClick={() => go({ v: 'post' })} disabled={!m.actual}>Post-market</button>
        </div>
        <div className="seg" role="group" aria-label="Language">
          <button aria-pressed={lang === 'en'} onClick={() => setLang('en')}>English</button>
          <button aria-pressed={lang === 'ta'} onClick={() => setLang('ta')} lang="ta">தமிழ்</button>
        </div>
        <div className="seg" role="group" aria-label="Text size">
          <button onClick={() => setSize(size - 2)} aria-label="Smaller text">A−</button>
          <button onClick={() => setSize(size + 2)} aria-label="Larger text">A+</button>
        </div>
        <button className="btn" onClick={copy} disabled={!sc}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </header>
      {m.loading ? (
        <div className="scr-meta">Loading…</div>
      ) : !sc ? (
        <div className="scr-meta">No script for this session yet: the {view === 'post' ? 'review needs the session to have traded' : 'plan needs the previous close and option chain'}.</div>
      ) : (
        <>
          <div className="scr-meta">
            {view === 'pre' ? 'Pre-market levels' : 'Post-market recap'} · {d && dayLabel(d)} · {sc.words} words · about {sc.seconds} s
            {m.rv?.a.provisional && view === 'post' ? ' · provisional (live feed)' : ''}
          </div>
          <article className="scr-text" style={{ fontSize: size }} lang={lang}>
            {sc.lines.map((l, i) => <p key={i} className={i === 0 ? 'hook' : undefined}>{l}</p>)}
          </article>
        </>
      )}
    </div>
  )
}
