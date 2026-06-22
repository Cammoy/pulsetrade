// Comprehensive per-network token lists for the Swap picker, sourced from the free
// CoinGecko token-list endpoints (no API key). One consistent shape across every
// swap network — EVM addresses on the EVM chains, base58 mints on Solana. Cached an
// hour; fail-soft (a provider hiccup just yields the last list, or the curated set).

// network.id → CoinGecko asset-platform slug used by tokens.coingecko.com/<slug>/all.json
const CG_PLATFORM: Record<string, string> = {
  base: 'base',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  polygon: 'polygon-pos',
  bnb: 'binance-smart-chain',
  solana: 'solana',
}

export interface ListedToken {
  address: string
  symbol: string
  name: string
  decimals: number
  logoURI?: string
}

const MAX = 4000 // bound the payload — long-tail tokens are still reachable via paste-address
const TTL = 60 * 60_000 // 1h — token metadata is effectively static
const cache = new Map<string, { at: number; tokens: ListedToken[] }>()

/** Full token list for a swap network (cached). Empty for unsupported networks. */
export async function tokenList(networkId: string, now = Date.now()): Promise<ListedToken[]> {
  const platform = CG_PLATFORM[networkId]
  if (!platform) return []
  const hit = cache.get(networkId)
  if (hit && now - hit.at < TTL) return hit.tokens
  try {
    const res = await fetch(`https://tokens.coingecko.com/${platform}/all.json`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return hit?.tokens ?? []
    const json = (await res.json()) as { tokens?: unknown[] }
    const seen = new Set<string>()
    const out: ListedToken[] = []
    for (const raw of json?.tokens ?? []) {
      const t = raw as { address?: unknown; symbol?: unknown; name?: unknown; decimals?: unknown; logoURI?: unknown }
      const address = typeof t.address === 'string' ? t.address : ''
      const symbol = typeof t.symbol === 'string' ? t.symbol : ''
      const decimals = Number(t.decimals)
      // Decimals feed BigInt base-unit math (10n ** BigInt(decimals)) — require a real
      // integer in range (Number.isInteger also rejects NaN/Infinity/fractions like 18.5).
      if (!address || !symbol || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue
      const key = address.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        address,
        symbol,
        name: typeof t.name === 'string' ? t.name : symbol,
        decimals,
        logoURI: typeof t.logoURI === 'string' ? t.logoURI : undefined,
      })
      if (out.length >= MAX) break
    }
    if (out.length === 0) return hit?.tokens ?? []
    cache.set(networkId, { at: now, tokens: out })
    return out
  } catch {
    return hit?.tokens ?? []
  }
}
