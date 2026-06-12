// Sniper discovery: surfaces freshly created and trending liquidity pools on
// the supported networks via the free GeckoTerminal API. Each candidate is
// returned with the base-token contract address so it can be risk-screened
// BEFORE the user is allowed to snipe it.

import { networkById, type Network } from './networks.js'
import { batchGoPlus, screenPrefetched } from './screen-fetch.js'
import type { RiskReport } from './risk-screen.js'

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

// ── Safe-only feed ───────────────────────────────────────────────────────────
// The sniper only ever shows tokens that pass HARD requirements:
//   verified source · sellable (honeypot sim / GoPlus sell flags) · enough
//   distinct holders · no single-wallet dominance · real liquidity · a full
//   risk screen with zero critical flags and a minimum score.

export interface SafeFeedOptions {
  minLiquidityUsd: number
  minHolders: number
  maxTopHolderPct: number
  maxTop10Pct: number
  minScore: number
}

export const SAFE_DEFAULTS: SafeFeedOptions = {
  minLiquidityUsd: 10_000,
  minHolders: 50,
  maxTopHolderPct: 30,
  maxTop10Pct: 70,
  minScore: 60,
}

export interface SafePool extends PoolCandidate {
  report: RiskReport
}

/** Hard pre-filter on the batched GoPlus payload. Pure — unit-tested. */
export function passesHardFilter(gp: Record<string, any> | undefined, o: SafeFeedOptions): boolean {
  if (!gp) return false // no security data ⇒ never show
  if (gp.is_open_source !== '1') return false // must be verified
  if (gp.is_honeypot === '1' || gp.cannot_sell_all === '1') return false // must be sellable
  const holders = Number(gp.holder_count)
  if (!Number.isFinite(holders) || holders < o.minHolders) return false // multiple holders
  if (Array.isArray(gp.holders) && gp.holders.length) {
    // Dominance must be measured over real END-USER wallets (EOAs). Infrastructure
    // — DEX pools, bridges, CEX wallets, lockers, burn addresses — legitimately
    // holds large shares and is NOT a rug signal, so exclude it. GoPlus flags
    // these via is_contract / a known tag / is_locked / the dead address.
    const isInfra = (h: any) =>
      h?.is_contract === 1 || h?.is_contract === '1' ||
      (typeof h?.tag === 'string' && h.tag.trim() !== '') ||
      h?.is_locked === 1 || h?.is_locked === '1' ||
      /^0x0{40}$|dead/i.test(String(h?.address))
    const eoa = gp.holders.filter((h: any) => !isInfra(h))
    const topReal = Math.max(0, ...eoa.map((h: any) => Number(h.percent)).filter(Number.isFinite))
    if (topReal * 100 > o.maxTopHolderPct) return false // no single live whale
    const top10 = eoa.slice(0, 10).reduce((s: number, h: any) => {
      const p = Number(h.percent)
      return s + (Number.isFinite(p) ? p : 0)
    }, 0)
    if (top10 * 100 > o.maxTop10Pct) return false // top-10 live wallets not a cabal
  }
  return true
}

const safeCache = new Map<string, { at: number; result: { pools: SafePool[]; scanned: number } }>()
const SAFE_TTL = 180_000 // 3 min — screened tokens stay valid; eases provider rate limits

/** Discover pools and return ONLY the ones that pass the full safety gate. */
export async function discoverSafePools(
  network: string,
  mode: 'new' | 'trending' = 'new',
  now = Date.now(),
  opts: Partial<SafeFeedOptions> = {},
): Promise<{ pools: SafePool[]; scanned: number; error?: string }> {
  const net = networkById(network)
  if (!net) return { pools: [], scanned: 0, error: 'unknown network' }
  const o = { ...SAFE_DEFAULTS, ...opts }
  const key = `${network}:${mode}:${o.minLiquidityUsd}`
  const hit = safeCache.get(key)
  if (hit && now - hit.at < SAFE_TTL) return hit.result

  const { pools, error } = await discoverPools(network, mode, now)
  if (!pools.length) return { pools: [], scanned: 0, error }

  // Feed-level requirements: real liquidity and a live price. Screen the most
  // liquid candidates first (cap the count to stay within provider rate limits).
  const candidates = pools
    .filter((p) => (p.liquidityUsd ?? 0) >= o.minLiquidityUsd && (p.priceUsd ?? 0) > 0 && /^0x[a-fA-F0-9]{40}$/.test(p.tokenAddress))
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, 12)

  // Screen each candidate individually. GoPlus only returns pre-indexed tokens
  // in a batch call, so a single-address call (which triggers on-demand
  // indexing) is the reliable path. Bounded concurrency keeps us under rate
  // limits while staying fast.
  const safe: SafePool[] = []
  let i = 0
  const worker = async () => {
    while (i < candidates.length) {
      const p = candidates[i++]
      const gpMap = await batchGoPlus(net.chainId, [p.tokenAddress])
      const gp = gpMap.get(p.tokenAddress.toLowerCase())
      if (!passesHardFilter(gp, o)) continue // verified · sellable · distributed
      const report = await screenPrefetched(net.id, p.tokenAddress, p.tokenSymbol, gp!)
      if (report.tradeable && report.score >= o.minScore) safe.push({ ...p, report })
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, candidates.length) }, worker))

  safe.sort((a, b) => b.report.score - a.report.score || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
  const result = { pools: safe, scanned: pools.length }
  // Don't let a transient provider rate-limit (which yields 0 safe) wipe a
  // recent good result — keep serving the last non-empty scan for a while.
  if (safe.length === 0 && hit && hit.result.pools.length > 0 && now - hit.at < SAFE_TTL * 2) {
    return hit.result
  }
  safeCache.set(key, { at: now, result })
  return result
}
