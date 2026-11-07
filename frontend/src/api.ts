// Types mirror the Spring Boot API (snake_case JSON). Nulls mean "not available".

export interface DailyMarket {
  trade_date: string
  spot_open: number | null
  spot_high: number | null
  spot_low: number | null
  spot_close: number | null
  spot_return_pct: number | null
  nifty_pe: number | null
  vix_close: number | null
  fut_close: number | null
  fut_expiry: string | null
  fut_oi_units: number | null
  fut_volume_contracts: number | null
  basis_pct: number | null
  lot_size: number | null
  opt_volume_contracts: number | null
  ce_oi_units: number | null
  pe_oi_units: number | null
  pcr_oi: number | null
  near_expiry: string | null
  days_to_expiry: number | null
  near_ce_oi_units: number | null
  near_pe_oi_units: number | null
  near_pcr_oi: number | null
  max_ce_oi_strike: number | null
  max_pe_oi_strike: number | null
  atm_strike: number | null
  atm_straddle: number | null
  atm_straddle_pct: number | null
}

export type ClientType = 'FII' | 'DII' | 'Client' | 'Pro'

export interface ParticipantPosition {
  trade_date: string
  client_type: ClientType
  fut_index_long: number | null
  fut_index_short: number | null
  fut_index_net: number | null
  fut_index_long_pct: number | null
  opt_index_call_net: number | null
  opt_index_put_net: number | null
}

export interface ChainRow {
  strike: number
  ce_close: number | null
  ce_last: number | null
  ce_settle: number | null
  ce_oi_units: number | null
  ce_oi_change_units: number | null
  ce_volume_contracts: number | null
  ce_turnover_inr: number | null
  ce_iv_pct: number | null
  ce_delta: number | null
  ce_gamma: number | null
  ce_theta: number | null
  ce_vega: number | null
  pe_close: number | null
  pe_last: number | null
  pe_settle: number | null
  pe_oi_units: number | null
  pe_oi_change_units: number | null
  pe_volume_contracts: number | null
  pe_turnover_inr: number | null
  pe_iv_pct: number | null
  pe_delta: number | null
  pe_gamma: number | null
  pe_theta: number | null
  pe_vega: number | null
}

export interface OptionChain {
  trade_date: string
  expiry: string
  expiries: string[]
  spot_close: number | null
  vix_close: number | null
  forward: number | null
  lot_size: number | null
  rows: ChainRow[]
}

/** Daily volatility summary; all volatilities in % a year. */
export interface IvDaily {
  trade_date: string
  near_expiry: string | null
  near_atm_iv: number | null
  near_forward: number | null
  next_expiry: string | null
  next_atm_iv: number | null
  iv_30d: number | null
  skew_expiry: string | null
  skew_atm_iv: number | null
  iv_25d_put: number | null
  iv_25d_call: number | null
  rr_25d: number | null
  bf_25d: number | null
  vix_close: number | null
  rv_20d: number | null
}

export interface DatasetStatus {
  dataset: string
  first_date: string | null
  last_date: string | null
  totals: Record<string, number>
  years: Array<Record<string, number>>
}

export interface DataStatus {
  datasets: DatasetStatus[]
  last_fetch: string | null
  open_items: Array<{ dataset: string; trade_date: string; status: string; message: string | null }>
  quality: { report: string; checks: Record<string, number> } | null
}

export interface PostgresDataset {
  dataset: string
  days: number
  rows: number
  first_day: string
  last_day: string
  last_loaded_at: string
}

export interface PostgresStatus {
  database: string
  datasets: PostgresDataset[]
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function getJson<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v) query.set(k, v)
  }
  const url = query.size ? `${path}?${query}` : path
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch {
    throw new ApiError(0, 'Cannot reach the backend. Is Spring Boot running on port 8080?')
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      // keep the status text
    }
    throw new ApiError(res.status, detail)
  }
  return (await res.json()) as T
}

export const api = {
  daily: () => getJson<DailyMarket[]>('/api/market/daily'),
  participants: () => getJson<ParticipantPosition[]>('/api/market/participants'),
  iv: () => getJson<IvDaily[]>('/api/market/iv'),
  chain: (date: string, expiry?: string) => getJson<OptionChain>('/api/market/chain', { date, expiry }),
  dataStatus: () => getJson<DataStatus>('/api/data/status'),
  postgres: () => getJson<PostgresStatus>('/api/data/postgres'),
}
