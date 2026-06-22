import { useCallback, useEffect, useRef, useState } from 'react'
import type { SafePool } from './types'

/**
 * Lazily fetch freshly-launched, safety-screened DEX pools for the "New (DEX)"
 * lane. Kept separate from /api/market because it's a different data source
 * (GeckoTerminal + GoPlus screening) on its own rate-limit budget — so we only
 * fire it when the caller signals the lane is in view (`active`).
 */
export function useNewPools(network = 'base', active = false) {
  const [pools, setPools] = useState<SafePool[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Which chain the current `pools` belong to — lets us refetch on a chain
  // switch (the freshly-launched feed is per-chain) without an infinite loop.
  const loadedFor = useRef<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    loadedFor.current = network
    setPools(null) // drop the previous chain's pools so the lane shows its skeleton
    try {
      const r = await fetch(`/api/sniper/pools?network=${network}&mode=new`)
      const d = await r.json()
      if (d?.error && !d.pools?.length) setError(d.error)
      setPools(Array.isArray(d?.pools) ? d.pools : [])
    } catch {
      setError('New-launch feed unreachable')
      setPools([])
    }
    setLoading(false)
  }, [network])

  useEffect(() => {
    if (active && loadedFor.current !== network && !loading) load()
  }, [active, network, loading, load])

  return { pools, loading, error, reload: load }
}
