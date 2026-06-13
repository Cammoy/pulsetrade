// Market overview: global stats (CoinGecko /global), the Fear & Greed index
// (alternative.me), and the top coins with 7d sparklines — each scored by a
// PURE technical-signal function (RSI + EMA trend + momentum) so "is it time
// to buy or sell" is derived from real indicators, not vibes. Cached 3 min.

import { rsi, emaSeries, sma } from './indicators.js'

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
  priceUsd: number | null
  change24h: number | null
  change7d: number | null
  marketCapUsd: number | null
  volume24hUsd: number | null
  sparkline7d: number[] // downsampled for the UI
  signal: TechnicalSignal
}

export interface MarketOverview {
  at: number
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
  coins: MarketCoin[]
}

let cache: MarketOverview | null = null
const TTL = 180_000

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
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

export async function marketOverview(): Promise<MarketOverview> {
  if (cache && Date.now() - cache.at < TTL) return cache

  const [global, fng, markets] = await Promise.all([
    getJson('https://api.coingecko.com/api/v3/global'),
    getJson('https://api.alternative.me/fng/?limit=1'),
    getJson(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=true&price_change_percentage=24h,7d',
    ),
  ])

  const coins: MarketCoin[] = Array.isArray(markets)
    ? markets.map((m: any) => {
        const spark: number[] = Array.isArray(m?.sparkline_in_7d?.price) ? m.sparkline_in_7d.price.filter((x: any) => Number.isFinite(x)) : []
        return {
          id: String(m.id),
          symbol: String(m.symbol ?? '').toUpperCase(),
          name: String(m.name ?? m.id),
          priceUsd: num(m.current_price),
          change24h: num(m.price_change_percentage_24h_in_currency ?? m.price_change_percentage_24h),
          change7d: num(m.price_change_percentage_7d_in_currency),
          marketCapUsd: num(m.market_cap),
          volume24hUsd: num(m.total_volume),
          sparkline7d: downsample(spark),
          signal: technicalSignal(spark),
        }
      })
    : []

  const fgRaw = fng?.data?.[0]
  const fearGreed = fgRaw && Number.isFinite(Number(fgRaw.value)) ? { value: Number(fgRaw.value), classification: String(fgRaw.value_classification ?? '') } : null

  const overview: MarketOverview = {
    at: Date.now(),
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
  }
  // Don't cache a totally failed scrape — let the next request retry.
  if (coins.length > 0 || overview.global.marketCapUsd !== null) cache = overview
  return overview
}
