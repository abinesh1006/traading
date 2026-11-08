import { useQuery } from '@tanstack/react-query'
import { daysBetween } from './analysis'
import { api, type OptionChain } from './api'

/**
 * The option chain the strategy suggestion uses: the nearest expiry on the latest session, or the
 * next one when the nearest is under 2 days away (shared by the dashboard and the Brief).
 */
export function useStrategyChain(latest: string | undefined): OptionChain | undefined {
  const c1 = useQuery({ queryKey: ['chain', latest, undefined], queryFn: () => api.chain(latest!), enabled: !!latest })
  const nearDte = c1.data ? daysBetween(c1.data.trade_date, c1.data.expiry) : null
  const nextExp = c1.data && nearDte != null && nearDte < 2
    ? c1.data.expiries.find((e) => daysBetween(c1.data!.trade_date, e) >= 2) : undefined
  const c2 = useQuery({ queryKey: ['chain', latest, nextExp], queryFn: () => api.chain(latest!, nextExp), enabled: !!nextExp })
  return nextExp ? c2.data : c1.data
}
