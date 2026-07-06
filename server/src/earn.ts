// "Earn": where to park idle stablecoins for yield. Pulls live APYs from DefiLlama's free,
// no-key yields API (the standard source), then keeps only SAFE, LIQUID, single-asset stable
// pools on the chains this app supports — so it's a clean shortlist, not the thousands of
// (often risky) pools DefiLlama lists. Informational only: nothing here moves funds. Cached so
// the upstream is hit at most every 30 min regardless of how many clients are watching.

const DEFILLAMA_POOLS = 'https://yields.llama.fi/pools'
const TTL_MS = 30 * 60_000
const FETCH_TIMEOUT_MS = 10_000

// DefiLlama chain names mapped to this app's networks (others are dropped from the shortlist).
const SUPPORTED_CHAINS = new Set(['Ethereum', 'Arbitrum', 'Base', 'Optimism', 'Polygon', 'BSC', 'Solana'])
const MIN_TVL_USD = 5_000_000 // liquidity/safety floor — a thin pool isn't a place to park cash
const MAX_APY_PCT = 100 // drop absurd APYs (usually transient incentives / high-risk)

/** A raw DefiLlama pool row (only the fields we read). */
export interface RawPool {
  chain?: string
  project?: string
  symbol?: string
  tvlUsd?: number
  apy?: number
  apyBase?: number | null
  apyReward?: number | null
  stablecoin?: boolean
  ilRisk?: string // 'yes' | 'no'
  exposure?: string // 'single' | 'multi'
  pool?: string // DefiLlama pool id (for the research link)
}

export interface YieldPool {
  project: string
  chain: string
  symbol: string
  apy: number // total APY %
  apyBase: number | null // base (lending) APY %
  apyReward: number | null // incentive APY %
  tvlUsd: number
  poolId: string
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : NaN)
const round2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0)

export interface RankOpts {
  limit?: number
  minTvlUsd?: number
  maxApyPct?: number
}

/**
 * Pure: filter + rank DefiLlama pools into a safe stablecoin shortlist. Keeps only stablecoin,
 * single-asset (no impermanent-loss), supported-chain pools above the TVL floor and below the
 * sane-APY cap, sorted by APY desc, capped to `limit`. Deterministic — no I/O.
 */
export function rankYields(raw: RawPool[], opts: RankOpts = {}): YieldPool[] {
  const limit = opts.limit ?? 20
  const minTvl = opts.minTvlUsd ?? MIN_TVL_USD
  const maxApy = opts.maxApyPct ?? MAX_APY_PCT
  return (Array.isArray(raw) ? raw : [])
    .filter((p) => p.stablecoin === true)
    .filter((p) => p.ilRisk !== 'yes' && p.exposure !== 'multi') // single-asset stable lending only
    .filter((p) => typeof p.chain === 'string' && SUPPORTED_CHAINS.has(p.chain))
    .filter((p) => {
      const apy = num(p.apy)
      return apy > 0 && apy <= maxApy
    })
    .filter((p) => num(p.tvlUsd) >= minTvl)
    .map((p) => ({
      project: String(p.project ?? 'unknown'),
      chain: String(p.chain),
      symbol: String(p.symbol ?? '').toUpperCase(),
      apy: round2(num(p.apy)),
      apyBase: Number.isFinite(num(p.apyBase)) ? round2(num(p.apyBase)) : null,
      apyReward: Number.isFinite(num(p.apyReward)) ? round2(num(p.apyReward)) : null,
      tvlUsd: Math.round(num(p.tvlUsd)),
      poolId: String(p.pool ?? ''),
    }))
    .sort((a, b) => b.apy - a.apy)
    .slice(0, limit)
}

// ── Cache + fetch ───────────────────────────────────────────────────────────
let cache: { at: number; pools: YieldPool[] } | null = null
let inflight: Promise<void> | null = null
let lastError: string | null = null

export interface EarnPayload {
  pools: YieldPool[]
  at: number | null
  error: string | null
}

/** Live shortlist of safe stablecoin yields (cached 30 min; refreshes in the background so a
 *  request never blocks on DefiLlama). Empty list on a cold failure. */
export async function getYields(now: number = Date.now()): Promise<EarnPayload> {
  const fresh = cache && now - cache.at < TTL_MS
  if (!fresh && !inflight) {
    inflight = (async () => {
      try {
        const res = await fetch(DEFILLAMA_POOLS, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!res.ok) {
          lastError = `HTTP ${res.status}`
          return
        }
        const data: { data?: RawPool[] } = await res.json()
        const pools = rankYields(Array.isArray(data?.data) ? data.data : [])
        cache = { at: Date.now(), pools }
        lastError = null
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        console.error('[earn] DefiLlama fetch failed:', lastError)
      } finally {
        inflight = null
      }
    })()
  }
  // Block only on the very first build; thereafter serve cache and refresh behind it.
  if (!cache && inflight) await inflight
  return { pools: cache?.pools ?? [], at: cache?.at ?? null, error: cache ? null : lastError }
}

/** Test seam: clear the cache so a unit test can drive a fresh fetch. */
export const __resetYields = () => {
  cache = null
  inflight = null
  lastError = null
}
