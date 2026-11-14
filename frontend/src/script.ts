/**
 * Voiceover scripts for short videos, written by rules from the session's numbers (no language
 * model), in English and Tamil. Tamil keeps the market terms traders say in English (breakout,
 * support, VIX, expiry) the way Tamil finance channels speak. About 100 words: 35–50 seconds.
 * No trade ideas: levels, odds and what happened only.
 */
import type { MarketEvent } from './api'
import { SCENARIOS, type DayType, type Levels, type Odds, type Review, type Row, type ScenarioKey } from './sessionPlan'

export type Lang = 'en' | 'ta'
export interface ScriptInput {
  kind: 'pre' | 'post'
  d: string
  prev: Row
  sigma: number
  lv: Levels
  type: DayType
  odds: Odds | null
  evs: { during: MarketEvent[]; after: MarketEvent[] }
  rv: Review | null
  fiiChange: number | null
}
export interface Script { lines: string[]; words: number; seconds: number }

const n = (v: number) => Math.round(v).toLocaleString('en-IN')
const r5 = (v: number) => n(Math.round(v / 5) * 5)
const n2 = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const TA_DAYS = ['ஞாயிறு', 'திங்கள்', 'செவ்வாய்', 'புதன்', 'வியாழன்', 'வெள்ளி', 'சனி']
const TA_MONTHS = ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்']
const dayEn = (iso: string) => `${EN_DAYS[dow(iso)]}, ${Number(iso.slice(8, 10))} ${EN_MONTHS[Number(iso.slice(5, 7)) - 1]}`
const dayTa = (iso: string) => `${TA_DAYS[dow(iso)]}, ${Number(iso.slice(8, 10))} ${TA_MONTHS[Number(iso.slice(5, 7)) - 1]}`

const SC: Record<ScenarioKey, string> = { quiet: 'quiet range', fakeout: 'fake-out', breakout: 'breakout', breakdown: 'breakdown' }
const EV_EN: Record<string, string> = { rbi_policy: 'the RBI policy', fomc: 'the US Fed decision', us_cpi: 'US inflation data', union_budget: 'the Union Budget', election: 'election results' }
const EV_TA: Record<string, string> = { rbi_policy: 'RBI policy', fomc: 'US Fed முடிவு', us_cpi: 'US inflation data', union_budget: 'Union Budget', election: 'தேர்தல் முடிவுகள்' }

/** Spoken time in IST: "7 PM" / "மாலை 7 மணிக்கு". */
function spokenTime(iso: string | null, lang: Lang): string | null {
  if (!iso) return null
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
  const [h, m] = t.split(':').map(Number)
  const h12 = h % 12 === 0 ? 12 : h % 12
  const mm = m ? `:${String(m).padStart(2, '0')}` : ''
  if (lang === 'en') return `${h12}${mm} ${h < 12 ? 'AM' : 'PM'}`
  const part = h < 4 ? 'இரவு' : h < 12 ? 'காலை' : h < 16 ? 'மதியம்' : h < 20 ? 'மாலை' : 'இரவு'
  return `${part} ${h12}${mm} மணிக்கு`
}

function walls(lv: Levels) {
  const R = lv.callWalls.filter((k) => k > lv.up).sort((a, z) => a - z)[0] ?? lv.callWalls[0]
  const S = lv.putWalls.filter((k) => k < lv.down).sort((a, z) => z - a)[0] ?? lv.putWalls[0]
  return { R, S }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const ranked = (o: Odds) => [...SCENARIOS].sort((a, z) => o.share[z] - o.share[a])
const special = (t: DayType) => t.afterSpecial?.name.replace(/\s*\(.*\)$/, '')

function preEn(i: ScriptInput): string[] {
  const { d, prev, sigma, lv, type, odds, evs } = i
  const spot = prev.spot_close
  const { R, S } = walls(lv)
  const L = [
    `${type.expiry ? 'Expiry day, ' : ''}${dayEn(d)}. Four ways Nifty can go today, and the odds.`,
    `Last close: ${n(spot)}${special(type) ? `, in a thin ${special(type)} session` : ''}.`,
    `Expected move: about ${r5(sigma)} points either way, ${r5(spot - sigma)} to ${r5(spot + sigma)}.`,
    `The band to watch: ${r5(lv.down)} to ${r5(lv.up)}. Close above, breakout. Close below, breakdown.`,
  ]
  if (R != null && S != null) L.push(`Option writers defend ${n(R)} above and ${n(S)} below.`)
  if (odds) {
    const o = ranked(odds)
    L.push(`Most common: a ${SC[o[0]]}, about ${n(odds.share[o[0]])} percent. ${cap(SC[o[1]])} ${n(odds.share[o[1]])}, ${SC[o[2]]} ${n(odds.share[o[2]])}, ${SC[o[3]]} ${n(odds.share[o[3]])}.`)
  }
  const during = evs.during[0], after = evs.after[0]
  const at = (e: MarketEvent) => (spokenTime(e.event_time_ist, 'en') ? ` at ${spokenTime(e.event_time_ist, 'en')}` : '')
  if (during) L.push(`Careful: ${EV_EN[during.category] ?? during.name} lands during the session${at(during)}.`)
  else if (after) L.push(`${cap(EV_EN[after.category] ?? after.name)} lands ${EN_DAYS[dow(after.event_date)]}${at(after)}, after the close.`)
  L.push('Check back tonight for which one happened. Not investment advice. Follow for daily levels.')
  return L
}

function preTa(i: ScriptInput): string[] {
  const { d, prev, sigma, lv, type, odds, evs } = i
  const spot = prev.spot_close
  const { R, S } = walls(lv)
  const L = [
    `${type.expiry ? 'இன்று expiry day. ' : ''}${dayTa(d)}: Nifty இன்று நான்கு வழிகளில் போகலாம். ஒவ்வொன்றின் வாய்ப்பையும் பார்ப்போம்.`,
    `Nifty கடைசியாக ${n(spot)}-ல் முடிந்தது${special(type) ? ` — அது volume குறைவான ${special(type)} session` : ''}.`,
    `இன்றைய expected move இரு பக்கமும் சுமார் ${r5(sigma)} புள்ளிகள் — அதாவது ${r5(spot - sigma)} முதல் ${r5(spot + sigma)} வரை.`,
    `கவனிக்க வேண்டிய band ${r5(lv.down)} முதல் ${r5(lv.up)} வரை. ${r5(lv.up)}-க்கு மேல் close ஆனால் breakout. ${r5(lv.down)}-க்கு கீழே close ஆனால் breakdown.`,
  ]
  if (R != null && S != null) L.push(`Option writers மேலே ${n(R)}-ஐயும், கீழே ${n(S)}-ஐயும் பாதுகாக்கிறார்கள்.`)
  if (odds) {
    const o = ranked(odds)
    L.push(`இது போன்ற நாட்களில் அதிகம் நடப்பது ${SC[o[0]]} — சுமார் ${n(odds.share[o[0]])} சதவீதம். அடுத்து ${SC[o[1]]} ${n(odds.share[o[1]])}, ${SC[o[2]]} ${n(odds.share[o[2]])}, ${SC[o[3]]} ${n(odds.share[o[3]])} சதவீதம்.`)
  }
  const during = evs.during[0], after = evs.after[0]
  if (during) L.push(`கவனம்: ${EV_TA[during.category] ?? during.name} இன்று ${spokenTime(during.event_time_ist, 'ta') ?? ''} வருகிறது.`)
  else if (after) L.push(`மேலும், ${EV_TA[after.category] ?? after.name} ${TA_DAYS[dow(after.event_date)]} ${spokenTime(after.event_time_ist, 'ta') ?? ''} வருகிறது — market முடிந்த பிறகு.`)
  L.push('எது நடந்தது என்று இன்று இரவு பார்க்கலாம். இது analysis மட்டுமே, investment advice இல்லை. தினமும் levels-க்கு follow பண்ணுங்க.')
  return L
}

function postEn(i: ScriptInput, rv: Review): string[] {
  const { sigma, lv, type, odds, fiiChange } = i
  const up = r5(lv.up), down = r5(lv.down), close = n(rv.a.close), chg = n(Math.abs(rv.chg))
  const dir = `${rv.chg >= 0 ? 'up' : 'down'} ${chg} points`
  const L = [
    `${type.expiry ? 'Expiry day. ' : ''}Nifty had four possible outcomes today. Only one happened.`,
    `This morning the band to watch was ${down} to ${up}, with an expected move of about ${r5(sigma)} points.`,
    {
      breakout: `Nifty broke above ${up} and held it, closing at ${close}, ${dir}. A clean breakout.`,
      breakdown: `Nifty broke below ${down} and stayed there, closing at ${close}, ${dir}. A clean breakdown.`,
      fakeout: rv.brokeUp && rv.brokeDown
        ? `Nifty broke both sides of the band but closed back inside, at ${close}, ${dir}. A fake-out.`
        : `Nifty ${rv.brokeUp ? `pushed above ${up}` : `dipped below ${down}`} but couldn't hold it, and closed back inside at ${close}, ${dir}. A classic fake-out.`,
      quiet: `Nifty stayed inside the band all day and closed at ${close}, ${dir}. A quiet range day.`,
    }[rv.scenario],
  ]
  if (odds) L.push(`Days like this happen about ${n(odds.share[rv.scenario])} percent of the time.`)
  L.push(`The day's range was ${n(rv.range)} points, ${rv.rangeZ > 1.25 ? 'bigger than the expected move' : rv.rangeZ < 0.75 ? 'quieter than expected' : 'about what was expected'}.`)
  if (rv.vixChg != null && rv.a.vix != null) {
    L.push(Math.abs(rv.vixChg) < 2 ? `India VIX barely moved, at ${n2(rv.a.vix)}.`
      : rv.vixChg > 0 ? `India VIX rose to ${n2(rv.a.vix)}, so expect bigger swings next session.`
        : `India VIX fell to ${n2(rv.a.vix)}, so swings may calm down next session.`)
  }
  if (fiiChange != null && Math.abs(fiiChange) >= 2000) L.push(`FIIs ${fiiChange > 0 ? 'bought' : 'sold'} a net ${n(Math.abs(fiiChange))} index-futures contracts.`)
  L.push("The next session's levels drop at 8:30 in the morning. Follow so you don't miss them. Not investment advice.")
  return L
}

function postTa(i: ScriptInput, rv: Review): string[] {
  const { sigma, lv, type, odds, fiiChange } = i
  const up = r5(lv.up), down = r5(lv.down), close = n(rv.a.close), chg = n(Math.abs(rv.chg))
  const dir = `${chg} புள்ளிகள் ${rv.chg >= 0 ? 'உயர்ந்து' : 'சரிந்து'}`
  const L = [
    `${type.expiry ? 'இன்று expiry day. ' : ''}இன்று Nifty-க்கு நான்கு வாய்ப்புகள் இருந்தன. அதில் ஒன்று மட்டுமே நடந்தது.`,
    `காலையில் கவனிக்க வேண்டிய band ${down} முதல் ${up} வரை; expected move சுமார் ${r5(sigma)} புள்ளிகள்.`,
    {
      breakout: `Nifty ${up}-ஐ உடைத்து மேலேயே நின்றது — ${dir} ${close}-ல் முடிந்தது. இது ஒரு clean breakout.`,
      breakdown: `Nifty ${down}-க்கு கீழே உடைந்து அங்கேயே நின்றது — ${dir} ${close}-ல் முடிந்தது. இது ஒரு clean breakdown.`,
      fakeout: rv.brokeUp && rv.brokeDown
        ? `Nifty band-ன் இரண்டு பக்கமும் உடைத்தது, ஆனால் மீண்டும் உள்ளே வந்து ${dir} ${close}-ல் முடிந்தது. இது ஒரு fake-out.`
        : `Nifty ${rv.brokeUp ? `${up}-க்கு மேல் போனது` : `${down}-க்கு கீழே போனது`}, ஆனால் தாக்குப்பிடிக்கவில்லை — மீண்டும் band-க்குள் வந்து ${dir} ${close}-ல் முடிந்தது. இது ஒரு fake-out.`,
      quiet: `Nifty நாள் முழுவதும் band-க்குள்ளேயே இருந்து, ${dir} ${close}-ல் முடிந்தது. இது ஒரு quiet range day.`,
    }[rv.scenario],
  ]
  if (odds) L.push(`இப்படிப்பட்ட நாட்கள் சுமார் ${n(odds.share[rv.scenario])} சதவீதம் நடக்கும்.`)
  L.push(`இன்றைய range ${n(rv.range)} புள்ளிகள் — ${rv.rangeZ > 1.25 ? 'எதிர்பார்த்ததை விட அதிகம்' : rv.rangeZ < 0.75 ? 'எதிர்பார்த்ததை விட குறைவு' : 'எதிர்பார்த்த அளவுதான்'}.`)
  if (rv.vixChg != null && rv.a.vix != null) {
    L.push(Math.abs(rv.vixChg) < 2 ? `India VIX ${n2(rv.a.vix)}-ல் பெரிய மாற்றம் இல்லை.`
      : rv.vixChg > 0 ? `India VIX ${n2(rv.a.vix)}-க்கு உயர்ந்தது — அடுத்த session-ல் பெரிய swings எதிர்பார்க்கலாம்.`
        : `India VIX ${n2(rv.a.vix)}-க்கு குறைந்தது — அடுத்த session-ல் swings கொஞ்சம் அமைதியாகலாம்.`)
  }
  if (fiiChange != null && Math.abs(fiiChange) >= 2000) L.push(`FII-கள் net-ஆக ${n(Math.abs(fiiChange))} index futures contracts ${fiiChange > 0 ? 'வாங்கினார்கள்' : 'விற்றார்கள்'}.`)
  L.push('அடுத்த session-க்கான levels காலை 8:30-க்கு வரும். Miss பண்ணாம இருக்க follow பண்ணுங்க. இது investment advice இல்லை.')
  return L
}

export function writeScript(i: ScriptInput, lang: Lang): Script | null {
  let lines: string[]
  if (i.kind === 'pre') lines = lang === 'en' ? preEn(i) : preTa(i)
  else if (i.rv) lines = lang === 'en' ? postEn(i, i.rv) : postTa(i, i.rv)
  else return null
  const words = lines.join(' ').split(/\s+/).filter(Boolean).length
  // Rough speaking pace for a clear voiceover: ~150 words a minute in English, slower in Tamil.
  return { lines, words, seconds: Math.round(words / (lang === 'en' ? 2.5 : 1.9)) }
}
