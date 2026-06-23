// Market overview: global stats (CoinGecko /global), the Fear & Greed index
// (alternative.me), and the top coins with 7d sparklines — each scored by a
// PURE technical-signal function (RSI + EMA trend + momentum) so "is it time
// to buy or sell" is derived from real indicators, not vibes. Cached 3 min.

import { rsi, emaSeries, sma } from './indicators.js'
import { backoffRemainingMs, cgHeaders } from './prices.js'

export interface TechnicalSignal {
  action: 'buy' | 'sell' | 'hold'
  score: number // −100 … +100
  reasons: string[]
}

/** Pure technical read over a closes series (oldest → newest). */
export function technicalSignal(closes: number[]): TechnicalSignal {
  if (closes.length < 30) return { action: 'hold', score: 0, reasons: ['not enough history'] }
  const last = closes[closes.length - 1]
  const lo = Math.min(...closes)
  const hi = Math.max(...closes)
  // A flat tape (e.g. a stablecoin, ~<0.5% range over the window) has no real
  // signal — and degenerate RSI/EMA reads would otherwise lie about it.
  if (hi === 0 || (hi - lo) / hi < 0.005) return { action: 'hold', score: 0, reasons: ['flat — no meaningful movement'] }

  let score = 0
  const reasons: string[] = []

  const r = rsi(closes, 14)
  if (!Number.isNaN(r)) {
    if (r < 30) { score += 35; reasons.push(`RSI ${r.toFixed(0)} — oversold`) }
    else if (r > 70) { score -= 35; reasons.push(`RSI ${r.toFixed(0)} — overbought`) }
    else reasons.push(`RSI ${r.toFixed(0)} — neutral`)
  }

  const f = emaSeries(closes, 9)
  const s = emaSeries(closes, 21)
  const n = closes.length - 1
  if (!Number.isNaN(f[n]) && !Number.isNaN(s[n]) && s[n] !== 0) {
    const gap = (f[n] - s[n]) / Math.abs(s[n])
    if (gap > 0.001) { score += 25; reasons.push('EMA 9 above EMA 21 — uptrend') }
    else if (gap < -0.001) { score -= 25; reasons.push('EMA 9 below EMA 21 — downtrend') }
    else reasons.push('EMAs flat — no trend')
  }

  const avg24 = sma(closes, 24)
  if (!Number.isNaN(avg24) && avg24 !== 0) {
    const gap = (last - avg24) / avg24
    if (gap > 0.001) { score += 15; reasons.push('price above 24h average') }
    else if (gap < -0.001) { score -= 15; reasons.push('price below 24h average') }
  }

  const i24 = closes.length - 25
  if (i24 >= 0) {
    const chg = ((last - closes[i24]) / closes[i24]) * 100
    if (chg > 2) { score += 10; reasons.push(`+${chg.toFixed(1)}% momentum (24h)`) }
    else if (chg < -2) { score -= 10; reasons.push(`${chg.toFixed(1)}% momentum (24h)`) }
  }

  score = Math.max(-100, Math.min(100, score))
  return { action: score >= 30 ? 'buy' : score <= -30 ? 'sell' : 'hold', score, reasons }
}

export interface MarketStatus {
  label: 'risk-on' | 'neutral' | 'risk-off'
  composite: number // 0 … 100
  blurb: string
}

/** Pure aggregate: breadth of the top coins + the Fear & Greed value. */
export function marketStatus(coins: { change24h: number | null }[], fearGreed: number | null): MarketStatus {
  const priced = coins.filter((c) => c.change24h !== null)
  const breadth = priced.length ? (priced.filter((c) => (c.change24h as number) > 0).length / priced.length) * 100 : 50
  const fg = fearGreed ?? 50
  const composite = Math.round(0.55 * breadth + 0.45 * fg)
  const up = priced.filter((c) => (c.change24h as number) > 0).length
  const label: MarketStatus['label'] = composite >= 60 ? 'risk-on' : composite <= 40 ? 'risk-off' : 'neutral'
  const blurb =
    label === 'risk-on'
      ? `Broad strength: ${up}/${priced.length} top coins up over 24h and sentiment is greedy. Momentum strategies tend to do best; mind overheating.`
      : label === 'risk-off'
        ? `Broad weakness: only ${up}/${priced.length} top coins up over 24h and sentiment is fearful. Mean-reversion and DCA do their buying here; size carefully.`
        : `Mixed tape: ${up}/${priced.length} top coins up over 24h. Range strategies (grid, mean-reversion) usually suit choppy conditions.`
  return { label, composite, blurb }
}

// ── Fetching + cache ─────────────────────────────────────────────────────────

export interface MarketCoin {
  id: string
  symbol: string
  name: string
  image: string | null
  priceUsd: number | null
  change1h: number | null
  change24h: number | null
  change7d: number | null
  marketCapUsd: number | null
  marketCapRank: number | null
  volume24hUsd: number | null
  athChangePct: number | null // % below all-time-high (negative)
  volToMcap: number | null // 24h volume ÷ market cap — turnover / "in play"
  rsi: number | null // RSI(14) over the 7d sparkline — drives the oversold lane
  stable: boolean // stablecoin / wrapped native — excluded from movement lanes
  sparkline7d: number[] // downsampled for the UI
  signal: TechnicalSignal
}

/** Ordered coin-id lists per lane (selection + ranking lives server-side so it's
 *  pure + testable; the client just renders `lanes[key].map(id => byId[id])`). */
export type MarketLanes = Record<string, string[]>

export interface MarketOverview {
  at: number
  backoffMs: number // CoinGecko penalty-box remaining; >0 ⇒ prices may be delayed
  global: {
    marketCapUsd: number | null
    marketCapChange24hPct: number | null
    volume24hUsd: number | null
    btcDominancePct: number | null
    ethDominancePct: number | null
    activeCryptocurrencies: number | null
  }
  fearGreed: { value: number; classification: string } | null
  status: MarketStatus
  coins: MarketCoin[] // the full wide pull, by descending market cap
  trending: MarketCoin[] // CoinGecko /search/trending, hydrated from `coins` where possible
  lanes: MarketLanes
}

// Stablecoins & wrapped natives: real coins, but they make the movement lanes
// (gainers/losers/oversold/in-play) meaningless — a stablecoin "oversold" at
// $0.998 or a wrapped native with structurally high turnover is just noise.
const STABLE_LIKE = new Set([
  'usdt', 'usdc', 'usdc.e', 'usdbc', 'dai', 'fdusd', 'tusd', 'usde', 'usds', 'pyusd', 'usd1', 'usdt0', 'busd', 'mim', 'frax',
  'gusd', 'lusd', 'usdd', 'usdp', 'eurc', 'eurt', 'crvusd', 'usdx', 'susds',
  'weth', 'wbnb', 'wpol', 'wmatic', 'wbtc', 'cbbtc', 'btcb', 'steth', 'wsteth', 'cbeth', 'reth', 'weeth', 'wbeth', 'meth', 'weeth',
])
export const isStableLike = (symbol: string) => STABLE_LIKE.has(symbol.toLowerCase())

/** A finite symbol set can't list every stablecoin (RUSD, USDX, …), so also flag
 *  anything dollar/fiat-named that's trading AT its peg. The real guard against
 *  false-excluding a normal coin is the NARROW price band ($0.97–$1.03): a coin
 *  has to be sitting essentially on $1 AND carry a fiat symbol to count, which a
 *  genuine mover never does. (A wide band like ±10% was the bug — tightened here.) */
export function looksStable(symbol: string, name: string, price: number | null): boolean {
  if (isStableLike(symbol)) return true
  if (price === null || price <= 0.97 || price >= 1.03) return false
  return /usd|dai|eur|gbp/i.test(symbol) || /\b(dollar|stablecoin|pegged)\b/i.test(name)
}

const MIN_MCAP = 50_000_000 // movement lanes need a real-cap floor or they're all illiquid noise
const MIN_VOL_24H = 1_000_000 // …and a real 24h tape — below this a coin is DEAD/illiquid and
//                               must never be recommended (you couldn't trade it without huge impact)
// The Trending lane surfaces newer/smaller coins (a softer floor than the movement
// lanes) but still REQUIRES a real 24h tape so a dead, zero-volume coin can never be
// recommended (and the Trade button never appears for one). Coins with unknown
// volume are dropped, not shown — fail closed. [R5: dead-coin gate]
const MIN_VOL_24H_TRENDING = 250_000
const TOPCAP_N = 30
const LANE_N = 25

/**
 * Pure lane classification over the wide market pull. Selection + ranking live
 * here (not the client) so the heuristics are testable. Returns ordered coin-id
 * lists. A "movement" coin = priced, real-cap, not a stablecoin/wrapped native.
 */
export function assignLanes(coins: MarketCoin[]): MarketLanes {
  // A "movement" coin must be liquid AND actively traded — real cap floor + a real
  // 24h tape — so the gainers/losers/in-play/oversold lanes can't recommend a dead
  // coin that merely pumped on thin volume.
  const movement = coins.filter((c) => !c.stable && (c.marketCapUsd ?? 0) >= MIN_MCAP && (c.volume24hUsd ?? 0) >= MIN_VOL_24H)

  const topcap = coins.slice(0, TOPCAP_N).map((c) => c.id)

  const gainers = movement
    .filter((c) => (c.change24h ?? 0) > 0)
    .sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0))
    .slice(0, LANE_N)
    .map((c) => c.id)

  const losers = movement
    .filter((c) => (c.change24h ?? 0) < 0)
    .sort((a, b) => (a.change24h ?? 0) - (b.change24h ?? 0))
    .slice(0, LANE_N)
    .map((c) => c.id)

  // "In play" = abnormal turnover (24h volume relative to size). Stables are
  // structurally high-turnover so they're already excluded by `movement`.
  const inplay = movement
    .filter((c) => (c.volToMcap ?? 0) > 0.25)
    .sort((a, b) => (b.volToMcap ?? 0) - (a.volToMcap ?? 0))
    .slice(0, LANE_N)
    .map((c) => c.id)

  // "Dips" = beaten-down (down ≥3% on the week) AND leaning oversold (RSI<45),
  // still liquid — ranked most-oversold first. Tied to the real RSI so a momentum
  // buy ("RSI 68 — neutral") never shows here, and the weekly-drop floor keeps out
  // flat coins that merely have a soft RSI. Can legitimately be sparse/empty in a
  // strong uptrend — which is itself an honest signal (don't bottom-fish a rip).
  const oversold = movement
    .filter((c) => c.rsi !== null && c.rsi < 45 && (c.change7d ?? 0) <= -3 && (c.volToMcap ?? 0) > 0.02)
    .sort((a, b) => (a.rsi ?? 100) - (b.rsi ?? 100))
    .slice(0, LANE_N)
    .map((c) => c.id)

  return { topcap, gainers, losers, inplay, oversold }
}

let cache: MarketOverview | null = null
const TTL = 180_000

async function getJson(url: string): Promise<any | null> {
  try {
    // Attach the CoinGecko key (if set) to CG calls so the Market tab shares the
    // higher rate limit and isn't throttled to the public tier.
    const res = await fetch(url, { headers: url.includes('coingecko.com') ? cgHeaders() : { accept: 'application/json' } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

const num = (v: unknown): number | null => (Number.isFinite(Number(v)) ? Number(v) : null)

/** Keep every Nth point so sparklines stay light over the wire. */
export function downsample(points: number[], target = 48): number[] {
  if (points.length <= target) return points
  const step = points.length / target
  const out: number[] = []
  for (let i = 0; i < target; i++) out.push(points[Math.min(points.length - 1, Math.floor(i * step))])
  out[out.length - 1] = points[points.length - 1]
  return out
}

/** Map one CoinGecko /coins/markets row → MarketCoin (spark downsampled light). */
function mapMarketRow(m: any): MarketCoin {
  const spark: number[] = Array.isArray(m?.sparkline_in_7d?.price) ? m.sparkline_in_7d.price.filter((x: any) => Number.isFinite(x)) : []
  const symbol = String(m.symbol ?? '').toUpperCase()
  const name = String(m.name ?? m.id)
  const priceUsd = num(m.current_price)
  const marketCapUsd = num(m.market_cap)
  const volume24hUsd = num(m.total_volume)
  const r = spark.length >= 15 ? rsi(spark, 14) : NaN
  return {
    id: String(m.id),
    symbol,
    name,
    image: typeof m.image === 'string' ? m.image : null,
    priceUsd,
    change1h: num(m.price_change_percentage_1h_in_currency),
    change24h: num(m.price_change_percentage_24h_in_currency ?? m.price_change_percentage_24h),
    change7d: num(m.price_change_percentage_7d_in_currency),
    marketCapUsd,
    marketCapRank: num(m.market_cap_rank),
    volume24hUsd,
    athChangePct: num(m.ath_change_percentage),
    volToMcap: marketCapUsd && volume24hUsd ? volume24hUsd / marketCapUsd : null,
    rsi: Number.isFinite(r) ? Math.round(r) : null,
    stable: looksStable(symbol, name, priceUsd),
    sparkline7d: downsample(spark, 32),
    signal: technicalSignal(spark),
  }
}

/** The distinct CoinGecko ids in the /search/trending payload (deduped, in order). */
function trendingIds(trendingRaw: any): string[] {
  const items: any[] = Array.isArray(trendingRaw?.coins) ? trendingRaw.coins : []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const c of items) {
    const id = c?.item?.id
    if (id && !seen.has(String(id))) { seen.add(String(id)); ids.push(String(id)) }
  }
  return ids
}

/** Build the Trending lane from FULL market rows only (the wide pull + an enrichment
 *  pull keyed by trending id), keeping a coin ONLY if it clears the trending 24h-volume
 *  floor. A trending coin we can't confirm is liquid (no market row, or sub-floor /
 *  unknown volume) is DROPPED, never shown with "limited data" — so the lane can never
 *  recommend a dead, zero-volume coin like the one in the report. [R5] */
function buildTrending(trendingRaw: any, byId: Map<string, MarketCoin>): MarketCoin[] {
  const out: MarketCoin[] = []
  for (const id of trendingIds(trendingRaw)) {
    const full = byId.get(id)
    if (full && (full.volume24hUsd ?? 0) >= MIN_VOL_24H_TRENDING) out.push(full)
  }
  return out
}

export async function marketOverview(): Promise<MarketOverview> {
  if (cache && Date.now() - cache.at < TTL) return cache

  const [global, fng, markets, trendingRaw] = await Promise.all([
    getJson('https://api.coingecko.com/api/v3/global'),
    getJson('https://api.alternative.me/fng/?limit=1'),
    getJson(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=1h,24h,7d',
    ),
    getJson('https://api.coingecko.com/api/v3/search/trending'),
  ])

  const coins: MarketCoin[] = Array.isArray(markets) ? markets.map(mapMarketRow) : []
  const byId = new Map(coins.map((c) => [c.id, c]))

  // Trending coins outside the top-250 pull carry no volume/market-cap in the
  // /search/trending payload — so we can't tell a hot new coin from a dead one.
  // Enrich them with a real market row (one extra call for just those ids), then
  // buildTrending applies the volume floor. Coins this still can't price are dropped.
  const missing = trendingIds(trendingRaw).filter((id) => !byId.has(id))
  if (missing.length) {
    try {
      const enrich = await getJson(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(missing.join(','))}&sparkline=true&price_change_percentage=1h,24h,7d`,
      )
      if (Array.isArray(enrich)) for (const row of enrich.map(mapMarketRow)) if (!byId.has(row.id)) byId.set(row.id, row)
    } catch {
      /* enrichment failed — those trending coins simply drop (fail closed) */
    }
  }
  const trending = buildTrending(trendingRaw, byId)

  const fgRaw = fng?.data?.[0]
  const fearGreed = fgRaw && Number.isFinite(Number(fgRaw.value)) ? { value: Number(fgRaw.value), classification: String(fgRaw.value_classification ?? '') } : null

  const overview: MarketOverview = {
    at: Date.now(),
    backoffMs: backoffRemainingMs(),
    global: {
      marketCapUsd: num(global?.data?.total_market_cap?.usd),
      marketCapChange24hPct: num(global?.data?.market_cap_change_percentage_24h_usd),
      volume24hUsd: num(global?.data?.total_volume?.usd),
      btcDominancePct: num(global?.data?.market_cap_percentage?.btc),
      ethDominancePct: num(global?.data?.market_cap_percentage?.eth),
      activeCryptocurrencies: num(global?.data?.active_cryptocurrencies),
    },
    fearGreed,
    status: marketStatus(coins, fearGreed?.value ?? null),
    coins,
    trending,
    lanes: assignLanes(coins),
  }
  // Don't cache a totally failed scrape — let the next request retry.
  if (coins.length > 0 || overview.global.marketCapUsd !== null) cache = overview
  return overview
}
