// Real perp mark prices + funding rates from Hyperliquid's public `info` API — free, no key,
// no signup, and the ecosystem-standard source. We poll `metaAndAssetCtxs` (mark price +
// hourly funding per listed perp), cache it, and expose simple lookups. For a coin Hyperliquid
// doesn't list, callers fall back to the CoinGecko spot price (funding 0). Used by the paper
// perps engine so positions are marked + funded against real markets without moving any funds.

import { spotFresh } from './prices.js'

const HL_INFO = 'https://api.hyperliquid.xyz/info'
const TTL_MS = 30_000 // mark moves fast but a perp position ticks every ~20s; 30s cache is plenty
const FETCH_TIMEOUT_MS = 8_000

interface PerpMarket {
  mark: number
  funding: number // hourly funding rate (e.g. 0.0000125 = 0.00125%/h)
}

let cache: { at: number; markets: Map<string, PerpMarket> } | null = null
let inflight: Promise<void> | null = null
let lastError: string | null = null

/** Refresh the Hyperliquid mark/funding snapshot (cached `TTL_MS`, single-flight). Never throws. */
export async function refreshPerpMarkets(now: number = Date.now()): Promise<void> {
  if (cache && now - cache.at < TTL_MS) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch(HL_INFO, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        lastError = `HTTP ${res.status}`
        return
      }
      // Response: [ { universe: [{ name, ... }] }, [ { markPx, funding, ... } ] ] — aligned by index.
      const data: [{ universe?: { name?: string }[] }, { markPx?: string; funding?: string }[]] = await res.json()
      const universe = Array.isArray(data?.[0]?.universe) ? data[0].universe! : []
      const ctxs = Array.isArray(data?.[1]) ? data[1] : []
      const markets = new Map<string, PerpMarket>()
      for (let i = 0; i < universe.length; i++) {
        const name = String(universe[i]?.name ?? '').toUpperCase()
        const mark = Number(ctxs[i]?.markPx)
        const funding = Number(ctxs[i]?.funding)
        if (name && Number.isFinite(mark) && mark > 0) markets.set(name, { mark, funding: Number.isFinite(funding) ? funding : 0 })
      }
      if (markets.size) {
        cache = { at: Date.now(), markets }
        lastError = null
      } else {
        lastError = 'empty market snapshot'
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error('[perps-data] Hyperliquid fetch failed:', lastError)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** True when Hyperliquid lists a perp for this symbol (and we have a fresh-enough snapshot). */
export const isPerpListed = (symbol: string): boolean => !!cache?.markets.get(symbol.toUpperCase())

/** Hyperliquid mark price for a symbol, or undefined when not listed / not yet fetched. */
export const perpMark = (symbol: string): number | undefined => cache?.markets.get(symbol.toUpperCase())?.mark

/** Hyperliquid hourly funding rate for a symbol (0 when unknown). */
export const perpFunding = (symbol: string): number => cache?.markets.get(symbol.toUpperCase())?.funding ?? 0

/**
 * The mark price to value a position at: the Hyperliquid perp mark if listed, otherwise the
 * CoinGecko spot price (which the engine keeps fresh via its per-tick batch). undefined when
 * neither is available this tick — the caller should skip rather than mark on a stale price.
 */
export const markPriceFor = (symbol: string, cgId: string): number | undefined => perpMark(symbol) ?? spotFresh(cgId)

/** Funding rate to apply, only when the symbol is a real Hyperliquid perp (else 0 — a
 *  spot-priced fallback coin has no funding). */
export const fundingFor = (symbol: string): number => (isPerpListed(symbol) ? perpFunding(symbol) : 0)

export const perpsDataHealth = (): { ready: boolean; markets: number; error: string | null; at: number | null } => ({
  ready: !!cache,
  markets: cache?.markets.size ?? 0,
  error: lastError,
  at: cache?.at ?? null,
})

/** Test seam: clear the cache so a unit test can drive a fresh fetch. */
export const __resetPerpMarkets = () => {
  cache = null
  inflight = null
  lastError = null
}
