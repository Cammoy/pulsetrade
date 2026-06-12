// Market data via CoinGecko public API — batched, cached, 429-tolerant.

const CG = 'https://api.coingecko.com/api/v3'

const spotCache = new Map<string, number>()
let spotFetchedAt = 0
let backoffUntil = 0

/** How long CoinGecko has us in the penalty box (0 = clear to fetch). */
export const backoffRemainingMs = () => Math.max(0, backoffUntil - Date.now())

const candleCache = new Map<string, { at: number; closes: { t: number; c: number }[] }>()

async function cgFetch(url: string): Promise<any | null> {
  if (Date.now() < backoffUntil) return null
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (res.status === 429) {
      backoffUntil = Date.now() + 90_000
      console.warn('[prices] rate limited, backing off 90s')
      return null
    }
    if (!res.ok) return null
    return await res.json()
  } catch {
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
      for (const [id, v] of Object.entries<any>(data)) {
        if (v?.usd) spotCache.set(id, v.usd)
      }
      spotFetchedAt = Date.now()
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

// ── GeckoTerminal pool pricing (for sniped tokens not on CoinGecko) ──────────

const GT = 'https://api.geckoterminal.com/api/v2'
const poolCache = new Map<string, number>() // key: `${gtSlug}:${poolAddress}` → USD price

export const poolPrice = (gtSlug: string, poolAddress: string) =>
  poolCache.get(`${gtSlug}:${poolAddress.toLowerCase()}`)

/** Fetch and cache the base-token USD price for a single pool. */
export async function refreshPoolPrice(gtSlug: string, poolAddress: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${GT}/networks/${gtSlug}/pools/${poolAddress}`, { headers: { accept: 'application/json' } })
    if (!res.ok) return poolPrice(gtSlug, poolAddress)
    const data = await res.json()
    const p = Number(data?.data?.attributes?.base_token_price_usd)
    if (Number.isFinite(p) && p > 0) {
      poolCache.set(`${gtSlug}:${poolAddress.toLowerCase()}`, p)
      return p
    }
  } catch {
    /* keep last known price */
  }
  return poolPrice(gtSlug, poolAddress)
}
