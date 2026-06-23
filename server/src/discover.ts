// Discover copy-worthy traders we DON'T already track: pull recent participants in our curated
// tokens (via Etherscan token-transfer history — its multichain free tier is far more generous
// than GeckoTerminal's, which the app already shares for pricing), then verify each by TRUE
// cost-basis realized P&L (the same engine the leaderboard uses). This turns "rank the wallets we
// happen to track" into "find the wallets actually worth copying". Heavy → background + cached 12h.

import { networkById, tokenOf } from './networks.js'
import {
  trackingReady, listWallets, walletEvents, computeWalletStats, computeWalletScore, computeRealizedPnl,
  isSignalToken, tokensForCopyTrade, etherscanChainLimited, markEtherscanChainLimited, type WalletScore,
} from './smartmoney.js'

const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'

export interface DiscoveredTrader {
  address: string
  score: number
  tier: WalletScore['tier']
  realizedPnlUsd: number
  roundTrips: number
  recencyDays: number | null
  trades: number
  viaTokens: { network: string; token: string }[] // the curated tokens we caught them trading
}

const MAX_TOKENS = 8 // curated signal tokens to crawl per run
const TRADERS_PER_TOKEN = 10 // top distinct participants to keep from each token
const MAX_CANDIDATES = 18 // wallets we actually verify (each is ~6 Etherscan reads + historical pricing)
const KEEP = 12 // discovered traders surfaced
const MIN_PNL_USD = 10 // ignore dust round-trips
const DISCOVER_TTL = 12 * 3_600_000 // results change slowly; the crawl is heavy

let cache: { at: number; traders: DiscoveredTrader[] } | null = null
let running = false

/** Recent active addresses for a token via Etherscan token-transfer history. Excludes the token
 *  contract, the zero address, and the single most-frequent counterparty (the DEX pool). Ranked
 *  by activity. Returns [] on any failure (the crawl just gets fewer candidates). */
async function recentTokenTraders(chainId: number, tokenAddr: string): Promise<string[]> {
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&contractaddress=${tokenAddr}&page=1&offset=200&sort=desc&apikey=${process.env.ETHERSCAN_API_KEY}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    if (!res.ok) return []
    const data: any = await res.json()
    if (typeof data?.result === 'string' && /not supported for this chain/i.test(data.result)) markEtherscanChainLimited()
    const rows: any[] = Array.isArray(data?.result) ? data.result : []
    const token = tokenAddr.toLowerCase()
    const freq = new Map<string, number>()
    for (const r of rows)
      for (const side of [r.from, r.to]) {
        const a = String(side || '').toLowerCase()
        if (EVM_ADDR.test(a) && a !== token && a !== ZERO) freq.set(a, (freq.get(a) ?? 0) + 1)
      }
    if (!freq.size) return []
    const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1])
    const pool = ranked[0][0] // the dominant counterparty in a token's transfers is its DEX pool
    return ranked.filter(([a]) => a !== pool).slice(0, TRADERS_PER_TOKEN).map(([a]) => a)
  } catch {
    return []
  }
}

/** Crawl curated tokens → candidate participants → verify by realized P&L. Resilient: any failed
 *  fetch just contributes fewer candidates; never throws. Exported for tests. */
export async function discoverTopTraders(): Promise<DiscoveredTrader[]> {
  // 1. Curated SIGNAL tokens (skip stables/majors) on tradeable EVM networks.
  const targets: { netId: string; chainId: number; symbol: string; address: string }[] = []
  for (const scope of tokensForCopyTrade()) {
    const net = networkById(scope.network)
    if (!net?.chainId) continue
    for (const sym of scope.tokens) {
      if (!isSignalToken(sym)) continue
      const tok = tokenOf(scope.network, sym)
      if (tok?.address) targets.push({ netId: net.id, chainId: net.chainId, symbol: sym, address: tok.address })
    }
  }

  // 2. Collect candidate addresses per token, excluding wallets we already track.
  const tracked = new Set(listWallets().map((w) => w.address.toLowerCase()))
  const freq = new Map<string, number>()
  const via = new Map<string, { network: string; token: string }[]>()
  for (const t of targets.slice(0, MAX_TOKENS)) {
    for (const addr of await recentTokenTraders(t.chainId, t.address)) {
      if (tracked.has(addr)) continue
      freq.set(addr, (freq.get(addr) ?? 0) + 1)
      const list = via.get(addr) ?? []
      list.push({ network: t.netId, token: t.symbol })
      via.set(addr, list)
    }
  }

  // 3. Verify the most-active candidates by TRUE cost-basis realized P&L; keep recent profitable ones.
  const candidates = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CANDIDATES).map(([a]) => a)
  const out: DiscoveredTrader[] = []
  for (const addr of candidates) {
    const events = await walletEvents(addr, { allTokens: true }).catch(() => [])
    if (!events.length) continue
    const stats = computeWalletStats(events)
    const realized = await computeRealizedPnl(events).catch(() => null)
    const score = computeWalletScore(stats, Date.now(), realized && realized.pricedTokens > 0 ? realized : undefined)
    // Only surface VERIFIED edges: scored on real realized P&L, a non-dust profit, at least one
    // closed position, and recently active. Pools / routers / losers don't pass. (Cost-basis
    // UNDERCOUNTS round-trips — orphan sells + unpriced tokens are excluded — so 1+ is the bar.)
    if (score.basis !== 'realized-pnl' || (score.realizedPnlUsd ?? 0) < MIN_PNL_USD || score.roundTrips < 1 || (score.recencyDays ?? 999) > 30) continue
    out.push({
      address: addr,
      score: score.score,
      tier: score.tier,
      realizedPnlUsd: score.realizedPnlUsd ?? 0,
      roundTrips: score.roundTrips,
      recencyDays: score.recencyDays,
      trades: stats.trades,
      viaTokens: (via.get(addr) ?? []).slice(0, 4),
    })
  }
  return out.sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd).slice(0, KEEP)
}

async function runDiscovery(): Promise<void> {
  running = true
  try {
    cache = { at: Date.now(), traders: await discoverTopTraders() }
  } catch {
    cache = { at: Date.now(), traders: cache?.traders ?? [] } // record the attempt so it backs off
  } finally {
    running = false
  }
}

/** Return the cached discovered traders; kick off a background refresh when stale (fire-and-forget,
 *  so the HTTP request returns instantly — the crawl can take a minute). */
export function getDiscovered(now = Date.now()): { traders: DiscoveredTrader[]; discovering: boolean; updatedAt: number | null; coverageLimited: boolean } {
  const fresh = cache && now - cache.at < DISCOVER_TTL
  if (!fresh && !running && trackingReady()) void runDiscovery()
  // coverageLimited ⇒ the crawl's L2 sourcing was blocked by a mainnet-only (free) Etherscan plan,
  // so an empty result means "no chain access", not "no traders found".
  return { traders: cache?.traders ?? [], discovering: running, updatedAt: cache?.at ?? null, coverageLimited: etherscanChainLimited() }
}
