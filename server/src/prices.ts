// Market data via CoinGecko — batched, cached, 429-tolerant. A free CoinGecko key
// (COINGECKO_API_KEY) raises the rate limit ~3-15× and largely eliminates the 429
// backoff that leaves prices/holdings briefly unpriced; set COINGECKO_PRO=true for a
// paid key. Without a key it uses the heavily-throttled public tier.
import { markProvider } from './health.js'
import { ttlCache } from './ttl-cache.js'
const CG_KEY = process.env.COINGECKO_API_KEY || ''
const CG_PRO = CG_KEY !== '' && process.env.COINGECKO_PRO === 'true'
const CG = CG_PRO ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3'
/** Request headers, incl. the CoinGecko key when configured (demo vs pro header). */
export const cgHeaders = (): Record<string, string> => {
  const h: Record<string, string> = { accept: 'application/json' }
  if (CG_KEY) h[CG_PRO ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = CG_KEY
  return h
}
const FETCH_TIMEOUT_MS = 8_000 // never let a hung price fetch wedge the engine
const SPOT_STALE_MS = 120_000 // a spot price older than this is NOT safe to trade on
const POOL_STALE_MS = 90_000 // sniper pool prices move fast — tighter ceiling

const spotCache = new Map<string, number>()
let spotFetchedAt = 0
// Per-id last-seen timestamp: CoinGecko silently omits dropped/renamed ids from the
// batch, so a single global timestamp would keep a delisted coin's last price "fresh"
// forever (held up by the majors in the same batch).
const spotIdAt = new Map<string, number>()
let backoffUntil = 0

/** How long CoinGecko has us in the penalty box (0 = clear to fetch). */
export const backoffRemainingMs = () => Math.max(0, backoffUntil - Date.now())

/** True when the spot cache is too old to trade on (never fetched, or stale past
 *  the ceiling — e.g. during a long 429 backoff or outage). Callers must NOT size
 *  trades or run stop-loss/take-profit off a stale price. */
export const spotStale = (): boolean => spotFetchedAt === 0 || Date.now() - spotFetchedAt > SPOT_STALE_MS

/** Test seam (NOT production): force the global spot feed stale / fresh so the live
 *  sell's measured-proceeds-at-last-price path and the buy-side stale guard can be
 *  exercised deterministically without waiting out a real 429 backoff. */
export const __test = {
  expireSpot() { spotFetchedAt = 0 },
  freshenSpot() { spotFetchedAt = Date.now() },
  /** Seed a pool price with a chosen fetch time (default now) so tests can simulate a
   *  fresh OR stale cached pool price. (poolCache/poolFetchedAt are defined below; these
   *  methods only run at test time, after module init.) */
  setPool(gtSlug: string, poolAddress: string, price: number, fetchedAt: number = Date.now()) {
    const key = `${gtSlug}:${poolAddress.toLowerCase()}`
    poolCache.set(key, price)
    poolFetchedAt.set(key, fetchedAt)
  },
}

/** The spot price for ONE id, but only if THAT id was itself refreshed within the
 *  staleness ceiling. Returns undefined when the id's own price is stale or never seen.
 *  Use this (not the global spotStale()) to drive SL/TP for a specific coin, so a coin
 *  CoinGecko has dropped can't keep serving a frozen price held "fresh" by the majors. */
export const spotFresh = (id: string): number | undefined =>
  Date.now() - (spotIdAt.get(id) ?? 0) > SPOT_STALE_MS ? undefined : spotCache.get(id)

const candleCache = new Map<string, { at: number; closes: { t: number; c: number }[] }>()

/** Shared CoinGecko GET: respects the global 429 backoff (returns null while backing off
 *  or on any failure) so every caller cooperates instead of 429-storming the free tier. */
async function cgFetch(url: string): Promise<any | null> {
  if (Date.now() < backoffUntil) return null
  try {
    const res = await fetch(url, { headers: cgHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (res.status === 429) {
      backoffUntil = Date.now() + 90_000
      console.warn('[prices] rate limited, backing off 90s')
      markProvider('coingecko', false, 'rate limited (429)')
      return null
    }
    if (!res.ok) { markProvider('coingecko', false, `HTTP ${res.status}`); return null }
    const json = await res.json()
    markProvider('coingecko', true) // last successful price fetch → /health freshness
    return json
  } catch (e) {
    markProvider('coingecko', false, e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Batched spot prices in USD. Serves cache if fresh (<20s) or fetch fails. */
export async function getSpotPrices(ids: string[]): Promise<Map<string, number>> {
  const fresh = Date.now() - spotFetchedAt < 20_000
  const missing = ids.filter((id) => !spotCache.has(id))
  if (!fresh || missing.length) {
    const data = await cgFetch(`${CG}/simple/price?ids=${ids.join(',')}&vs_currencies=usd`)
    if (data) {
      const now = Date.now()
      for (const [id, v] of Object.entries<any>(data)) {
        if (v?.usd) { spotCache.set(id, v.usd); spotIdAt.set(id, now) } // stamp only ids actually returned
      }
      spotFetchedAt = now
    }
  }
  return spotCache
}

export const spot = (id: string) => spotCache.get(id)

/** Hourly closes for the last `days` days (cached 5 min). */
export async function getCandles(id: string, days = 30): Promise<{ t: number; c: number }[]> {
  const key = `${id}:${days}`
  const hit = candleCache.get(key)
  if (hit && Date.now() - hit.at < 300_000) return hit.closes
  const data = await cgFetch(`${CG}/coins/${id}/market_chart?vs_currency=usd&days=${days}`)
  if (data?.prices?.length) {
    const closes = data.prices.map(([t, c]: [number, number]) => ({ t, c }))
    candleCache.set(key, { at: Date.now(), closes })
    return closes
  }
  return hit?.closes ?? []
}

// ── Historical pricing (for cost-basis realized-PnL reconstruction) ──────────
// A ~1y daily price series per coin, cached 6h (closed candles barely move). Reuses getCandles
// (CoinGecko market_chart + its 429 backoff + stale-on-fail), so cost-basis valuation shares the
// same rate-limit budget. Used to price a wallet's historical transfers at the time they happened.
const histSeries = ttlCache<{ t: number; c: number }[]>(6 * 3_600_000)

export async function historicalSeries(cgId: string): Promise<{ t: number; c: number }[]> {
  const fresh = histSeries.fresh(cgId)
  if (fresh) return fresh
  const series = await getCandles(cgId, 365)
  return series.length ? histSeries.set(cgId, series) : (histSeries.stale(cgId) ?? [])
}

/** USD price at (or nearest to) a timestamp from an ascending daily series. Returns null when
 *  the series is empty or the timestamp predates our ~1y window (an unknowable entry price). */
export function priceAt(series: { t: number; c: number }[], tsMs: number): number | null {
  if (!series.length) return null
  if (tsMs < series[0].t - 2 * 86_400_000) return null // older than our history — don't guess
  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (series[mid].t < tsMs) lo = mid + 1
    else hi = mid
  }
  const a = series[lo]
  const b = series[lo - 1]
  if (!b) return a.c
  return Math.abs(a.t - tsMs) <= Math.abs(b.t - tsMs) ? a.c : b.c
}

// ── GeckoTerminal pool pricing (for sniped tokens not on CoinGecko) ──────────

const GT = 'https://api.geckoterminal.com/api/v2'
const poolCache = new Map<string, number>() // key: `${gtSlug}:${poolAddress}` → USD price
const poolFetchedAt = new Map<string, number>() // key → last successful fetch ts

export const poolPrice = (gtSlug: string, poolAddress: string) =>
  poolCache.get(`${gtSlug}:${poolAddress.toLowerCase()}`)

/** The pool price ONLY if it's fresh enough to trade on, else undefined so the
 *  caller skips the tick rather than running SL/TP / sizing off a frozen price. */
export const poolPriceFresh = (gtSlug: string, poolAddress: string): number | undefined => {
  const key = `${gtSlug}:${poolAddress.toLowerCase()}`
  return Date.now() - (poolFetchedAt.get(key) ?? 0) > POOL_STALE_MS ? undefined : poolCache.get(key)
}

/** Fetch and cache the base-token USD price for a single pool. */
export async function refreshPoolPrice(gtSlug: string, poolAddress: string): Promise<number | undefined> {
  const key = `${gtSlug}:${poolAddress.toLowerCase()}`
  try {
    const res = await fetch(`${GT}/networks/${gtSlug}/pools/${poolAddress}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return poolPrice(gtSlug, poolAddress)
    const data = await res.json()
    const p = Number(data?.data?.attributes?.base_token_price_usd)
    if (Number.isFinite(p) && p > 0) {
      poolCache.set(key, p)
      poolFetchedAt.set(key, Date.now())
      return p
    }
  } catch {
    /* keep last known price */
  }
  return poolPrice(gtSlug, poolAddress)
}

/** Current USD liquidity (reserve) of a DEX pool from GeckoTerminal, or null if it
 *  can't be read. Used to gate a snipe against too-thin pools / outsized buys. [P2-9] */
export async function poolLiquidityUsd(gtSlug: string, poolAddress: string): Promise<number | null> {
  try {
    const res = await fetch(`${GT}/networks/${gtSlug}/pools/${poolAddress}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const data = await res.json()
    const r = Number(data?.data?.attributes?.reserve_in_usd)
    return Number.isFinite(r) && r >= 0 ? r : null
  } catch {
    return null
  }
}

// Current total DEX liquidity of a TOKEN (summed across its pools) — used to drop dead /
// rug-pulled tokens from the smart-money signals. Cached 30 min (liquidity shifts slowly).
// A definitive answer (incl. 404 "no pool" → null) is cached; a transient network error is
// NOT cached, so it retries. null = "unknown" (the caller KEEPS the token, never drops on it).
const tokenLiqCache = new Map<string, { at: number; usd: number | null }>()
const TOKEN_LIQ_TTL = 1_800_000
export async function tokenLiquidityUsd(gtSlug: string, address: string): Promise<number | null> {
  const key = `${gtSlug}:${address.toLowerCase()}`
  const hit = tokenLiqCache.get(key)
  if (hit && Date.now() - hit.at < TOKEN_LIQ_TTL) return hit.usd
  try {
    const res = await fetch(`${GT}/networks/${gtSlug}/tokens/${address}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      tokenLiqCache.set(key, { at: Date.now(), usd: null }) // 404 = GT doesn't index it → unknown (kept; staleness still applies)
      return null
    }
    const data = await res.json()
    const r = Number(data?.data?.attributes?.total_reserve_in_usd)
    const usd = Number.isFinite(r) && r >= 0 ? r : null
    tokenLiqCache.set(key, { at: Date.now(), usd })
    return usd
  } catch {
    return null // transient — not cached, retried next time
  }
}
