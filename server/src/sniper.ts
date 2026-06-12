// Sniper discovery: surfaces freshly created and trending liquidity pools on
// the supported networks via the free GeckoTerminal API. Each candidate is
// returned with the base-token contract address so it can be risk-screened
// BEFORE the user is allowed to snipe it.

import { networkById, type Network } from './networks.js'

export interface PoolCandidate {
  network: string
  poolAddress: string
  tokenAddress: string
  tokenSymbol: string
  tokenName: string
  priceUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  priceChange1hPct: number | null
  fdvUsd: number | null
  createdAt: number | null
  ageMinutes: number | null
  dex: string | null
}

const GT = 'https://api.geckoterminal.com/api/v2'
const cache = new Map<string, { at: number; pools: PoolCandidate[] }>()
const TTL = 45_000

async function gtGet(path: string): Promise<any | null> {
  try {
    const res = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

const n = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

function mapPools(net: Network, json: any, now: number): PoolCandidate[] {
  const included: any[] = json?.included ?? []
  const tokenById = new Map<string, any>()
  for (const inc of included) if (inc.type === 'token') tokenById.set(inc.id, inc.attributes)

  const out: PoolCandidate[] = []
  for (const p of json?.data ?? []) {
    const a = p.attributes ?? {}
    const baseId = p.relationships?.base_token?.data?.id
    const tok = baseId ? tokenById.get(baseId) : null
    // base token id looks like "base_0xabc..." — strip the network prefix
    const tokenAddress = tok?.address ?? (baseId ? baseId.split('_').slice(1).join('_') : '')
    if (!tokenAddress) continue
    const createdAt = a.pool_created_at ? Date.parse(a.pool_created_at) : null
    out.push({
      network: net.id,
      poolAddress: a.address ?? '',
      tokenAddress,
      tokenSymbol: tok?.symbol ?? a.name?.split(' / ')?.[0] ?? '?',
      tokenName: tok?.name ?? a.name ?? 'Unknown',
      priceUsd: n(a.base_token_price_usd),
      liquidityUsd: n(a.reserve_in_usd),
      volume24hUsd: n(a.volume_usd?.h24),
      priceChange1hPct: n(a.price_change_percentage?.h1),
      fdvUsd: n(a.fdv_usd),
      createdAt,
      ageMinutes: createdAt ? Math.max(0, Math.round((now - createdAt) / 60_000)) : null,
      dex: p.relationships?.dex?.data?.id ?? null,
    })
  }
  return out
}

/**
 * Discover snipeable pools. mode 'new' = freshly launched, 'trending' = hot.
 * Results cached 45s per (network, mode). now is injectable for tests.
 */
export async function discoverPools(
  network: string,
  mode: 'new' | 'trending' = 'new',
  now = Date.now(),
): Promise<{ pools: PoolCandidate[]; error?: string }> {
  const net = networkById(network)
  if (!net) return { pools: [], error: 'unknown network' }
  const key = `${network}:${mode}`
  const hit = cache.get(key)
  if (hit && now - hit.at < TTL) return { pools: hit.pools }

  const path =
    mode === 'new'
      ? `/networks/${net.gt}/new_pools?include=base_token,dex&page=1`
      : `/networks/${net.gt}/trending_pools?include=base_token,dex&page=1`
  const json = await gtGet(path)
  if (!json) return { pools: hit?.pools ?? [], error: 'discovery feed unavailable right now — try again shortly' }

  // Newest first for 'new'; keep API order (by trend) for 'trending'.
  let pools = mapPools(net, json, now)
  if (mode === 'new') pools.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  pools = pools.slice(0, 30)
  cache.set(key, { at: now, pools })
  return { pools }
}
