import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/** Polls every 3 s while the market is open or in pre-open, every 60 s otherwise. */
export function useLive() {
  return useQuery({
    queryKey: ['live'],
    queryFn: api.live,
    retry: 0,
    staleTime: 0,
    refetchInterval: (q) => {
      const s = q.state.data?.market.state
      return s === 'open' || s === 'pre_open' ? 3_000 : 60_000
    },
  })
}
