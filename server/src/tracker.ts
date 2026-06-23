// Manual holdings tracker: user-entered coin positions with cost-basis P/L, valued
// live from CoinGecko. Independent of the trading bots and the on-chain wallet
// reader — this is "what I hold and what it's worth vs what I paid". Cost basis uses
// the AVERAGE-cost method (all buy lots, fees included); realised P/L comes from sells.

import { state, save, uid, type TrackedAsset, type TrackerLot, type TrackerSell } from './store.js'
import { getSpotPrices, getCandles, cgHeaders } from './prices.js'
import { ttlCache } from './ttl-cache.js'

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

function assetByCg(cg: string): TrackedAsset | undefined {
  return state.tracker.find((a) => a.cg === cg)
}

/** Add a buy lot, creating the asset (by CoinGecko id) on first use. */
export function addLot(input: {
  cg?: string
  symbol?: string
  name?: string
  qty?: number | string
  priceUsd?: number | string
  ts?: number
  feeUsd?: number | string
  note?: string
}): { error: string } | TrackedAsset {
  const cg = String(input.cg ?? '').trim().toLowerCase()
  const symbol = String(input.symbol ?? '').trim().toUpperCase().slice(0, 24)
  const name = String(input.name ?? symbol).trim().slice(0, 80)
  const qty = num(input.qty)
  const priceUsd = num(input.priceUsd)
  const feeUsd = input.feeUsd === undefined || input.feeUsd === '' ? 0 : num(input.feeUsd)
  if (!cg || !/^[a-z0-9-]{1,80}$/.test(cg)) return { error: 'a valid CoinGecko id is required' }
  if (!symbol) return { error: 'a symbol is required' }
  if (!(qty > 0)) return { error: 'quantity must be greater than zero' }
  if (!(priceUsd >= 0)) return { error: 'purchase price must be zero or more' }
  if (!(feeUsd >= 0)) return { error: 'fee must be zero or more' }
  const ts = Number.isFinite(input.ts) && (input.ts as number) > 0 ? (input.ts as number) : Date.now()

  let asset = assetByCg(cg)
  if (!asset) {
    asset = { id: uid(), cg, symbol, name, lots: [], sells: [] }
    state.tracker.push(asset)
  }
  const lot: TrackerLot = { id: uid(), qty, priceUsd, ts, feeUsd: feeUsd || undefined, note: input.note ? String(input.note).slice(0, 200) : undefined }
  asset.lots.push(lot)
  save()
  return asset
}

/** Record a sale (drives realised P/L). Capped to the current holding. */
export function addSell(input: { cg?: string; qty?: number | string; priceUsd?: number | string; ts?: number; feeUsd?: number | string; note?: string }): { error: string } | TrackedAsset {
  const cg = String(input.cg ?? '').trim().toLowerCase()
  const asset = assetByCg(cg)
  if (!asset) return { error: 'no tracked position for that coin' }
  const qty = num(input.qty)
  const priceUsd = num(input.priceUsd)
  const feeUsd = input.feeUsd === undefined || input.feeUsd === '' ? 0 : num(input.feeUsd)
  if (!(qty > 0)) return { error: 'quantity must be greater than zero' }
  if (!(priceUsd >= 0)) return { error: 'sale price must be zero or more' }
  if (!(feeUsd >= 0)) return { error: 'fee must be zero or more' }
  const held = currentQty(asset)
  if (qty > held + 1e-9) return { error: `you only hold ${+held.toFixed(8)} ${asset.symbol}` }
  const ts = Number.isFinite(input.ts) && (input.ts as number) > 0 ? (input.ts as number) : Date.now()
  const sell: TrackerSell = { id: uid(), qty, priceUsd, ts, feeUsd: feeUsd || undefined, note: input.note ? String(input.note).slice(0, 200) : undefined }
  asset.sells.push(sell)
  save()
  return asset
}

/** Patch a lot's fields (qty / price / date / fee / note). */
export function editLot(lotId: string, patch: { qty?: number | string; priceUsd?: number | string; ts?: number; feeUsd?: number | string; note?: string }): { error: string } | TrackedAsset {
  for (const a of state.tracker) {
    const lot = a.lots.find((l) => l.id === lotId)
    if (!lot) continue
    if (patch.qty !== undefined) {
      const q = num(patch.qty)
      if (!(q > 0)) return { error: 'quantity must be greater than zero' }
      lot.qty = q
    }
    if (patch.priceUsd !== undefined) {
      const p = num(patch.priceUsd)
      if (!(p >= 0)) return { error: 'price must be zero or more' }
      lot.priceUsd = p
    }
    if (patch.feeUsd !== undefined) {
      const f = patch.feeUsd === '' ? 0 : num(patch.feeUsd)
      if (!(f >= 0)) return { error: 'fee must be zero or more' }
      lot.feeUsd = f || undefined
    }
    if (Number.isFinite(patch.ts) && (patch.ts as number) > 0) lot.ts = patch.ts as number
    if (patch.note !== undefined) lot.note = patch.note ? String(patch.note).slice(0, 200) : undefined
    save()
    return a
  }
  return { error: 'lot not found' }
}

/** Remove one lot (and the whole asset if it has no lots left). */
export function removeLot(lotId: string): boolean {
  for (const a of state.tracker) {
    const i = a.lots.findIndex((l) => l.id === lotId)
    if (i === -1) continue
    a.lots.splice(i, 1)
    if (a.lots.length === 0) state.tracker = state.tracker.filter((x) => x.id !== a.id)
    save()
    return true
  }
  return false
}

/** Remove one sell record. */
export function removeSell(sellId: string): boolean {
  for (const a of state.tracker) {
    const i = a.sells.findIndex((s) => s.id === sellId)
    if (i === -1) continue
    a.sells.splice(i, 1)
    save()
    return true
  }
  return false
}

/** Remove an entire tracked asset (all lots + sells). */
export function removeAsset(id: string): boolean {
  const before = state.tracker.length
  state.tracker = state.tracker.filter((a) => a.id !== id)
  if (state.tracker.length !== before) save()
  return state.tracker.length !== before
}

// ── Valuation ────────────────────────────────────────────────────────────────

const currentQty = (a: TrackedAsset): number => Math.max(0, sum(a.lots.map((l) => l.qty)) - sum(a.sells.map((s) => s.qty)))
const sum = (xs: number[]): number => xs.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0)

/**
 * Average-cost accounting, processed CHRONOLOGICALLY: a buy raises the running
 * average; a sell realises P/L against the average AT THE TIME OF SALE and reduces
 * the cost basis proportionally (the average is unchanged by a sale). Doing this in
 * time order is what makes realised P/L correct when you buy more AFTER selling —
 * a flat "average of all lots" would retroactively rewrite past sales.
 */
function costBasisOf(a: TrackedAsset): { qty: number; avgCostUsd: number; costBasisUsd: number; realizedPnlUsd: number } {
  const events = [
    ...a.lots.map((l) => ({ buy: true, ts: l.ts, qty: l.qty, price: l.priceUsd, fee: l.feeUsd ?? 0 })),
    ...a.sells.map((s) => ({ buy: false, ts: s.ts, qty: s.qty, price: s.priceUsd, fee: s.feeUsd ?? 0 })),
  ].sort((x, y) => x.ts - y.ts || (x.buy === y.buy ? 0 : x.buy ? -1 : 1)) // same instant ⇒ buys first
  let runQty = 0
  let runCost = 0 // total cost basis of the runQty held (at the running average)
  let realized = 0
  let lastAvg = 0
  for (const e of events) {
    if (!(e.qty > 0)) continue
    if (e.buy) {
      runQty += e.qty
      runCost += e.qty * e.price + e.fee
      if (runQty > 0) lastAvg = runCost / runQty
    } else {
      const avg = runQty > 0 ? runCost / runQty : lastAvg
      const sellQty = Math.min(e.qty, runQty) // can't realise more than held
      realized += sellQty * (e.price - avg) - e.fee
      runQty -= sellQty
      runCost = Math.max(0, runCost - sellQty * avg)
    }
  }
  const qty = Math.max(0, runQty)
  return { qty, avgCostUsd: qty > 0 ? runCost / qty : lastAvg, costBasisUsd: qty > 0 ? runCost : 0, realizedPnlUsd: realized }
}

export interface AssetMetrics {
  id: string
  cg: string
  symbol: string
  name: string
  qty: number
  avgCostUsd: number // average entry incl. fees
  priceUsd: number | null
  costBasisUsd: number // cost of the CURRENT holding
  valueUsd: number
  unrealizedPnlUsd: number
  unrealizedPnlPct: number
  realizedPnlUsd: number
  allocationPct: number
  lots: TrackerLot[]
  sells: TrackerSell[]
  spark: number[] // 7d close series for the row sparkline
}

export interface TrackerValuation {
  assets: AssetMetrics[]
  totals: {
    investedUsd: number // cost basis of current holdings
    valueUsd: number
    unrealizedPnlUsd: number
    unrealizedPnlPct: number
    realizedPnlUsd: number
    assetCount: number
  }
  best: { symbol: string; pct: number } | null
  worst: { symbol: string; pct: number } | null
  at: number
}

/** Value the whole tracker live. Fetches current prices once + a 7d sparkline per
 *  asset (cached 5 min in prices.ts), tolerant of a CoinGecko backoff. */
export async function valueTracker(): Promise<TrackerValuation> {
  const assets = state.tracker
  const ids = [...new Set(assets.map((a) => a.cg))]
  let prices = new Map<string, number>()
  if (ids.length) {
    try {
      prices = await getSpotPrices(ids)
    } catch {
      /* unpriced → null */
    }
  }
  // Sparklines (best-effort; a failed fetch just yields an empty spark).
  const sparks = new Map<string, number[]>()
  await Promise.all(
    ids.map(async (cg) => {
      try {
        const c = await getCandles(cg, 7)
        sparks.set(cg, downsample(c.map((x) => x.c), 32))
      } catch {
        /* no spark */
      }
    }),
  )

  const computed = assets.map((a) => {
    const { qty, avgCostUsd, costBasisUsd, realizedPnlUsd } = costBasisOf(a)
    const priceUsd = prices.get(a.cg) ?? null
    const valueUsd = priceUsd != null ? qty * priceUsd : 0
    const unrealizedPnlUsd = priceUsd != null ? valueUsd - costBasisUsd : 0
    const unrealizedPnlPct = costBasisUsd > 0 ? (unrealizedPnlUsd / costBasisUsd) * 100 : 0
    return {
      id: a.id, cg: a.cg, symbol: a.symbol, name: a.name,
      qty, avgCostUsd, priceUsd, costBasisUsd, valueUsd, unrealizedPnlUsd, unrealizedPnlPct, realizedPnlUsd,
      allocationPct: 0, lots: a.lots, sells: a.sells, spark: sparks.get(a.cg) ?? [],
    } as AssetMetrics
  })

  const valueUsd = sum(computed.map((c) => c.valueUsd))
  for (const c of computed) c.allocationPct = valueUsd > 0 ? (c.valueUsd / valueUsd) * 100 : 0
  computed.sort((a, b) => b.valueUsd - a.valueUsd)

  // Count ONLY priced assets in "invested" so the totals reconcile with the visible
  // rows. An unpriced asset (CoinGecko omitted the id, or a rate-limit backoff) has
  // valueUsd 0; including its cost basis here would book a phantom unrealised loss in
  // the header that the per-row P/L (all 0 for that asset) never shows. [verify-fix]
  const investedUsd = sum(computed.filter((c) => c.priceUsd != null).map((c) => c.costBasisUsd))
  const unrealizedPnlUsd = valueUsd - investedUsd
  const realizedPnlUsd = sum(computed.map((c) => c.realizedPnlUsd))

  // Only rank assets with a KNOWN live price. An unpriced asset has unrealizedPnlPct
  // forced to 0 (see above), so without this it competes at a phantom +0.00% and can be
  // crowned best/worst — a header chip that contradicts the per-row P/L (shown as '—').
  const ranked = computed.filter((c) => c.priceUsd != null && c.qty > 0 && c.costBasisUsd > 0)
  const best = ranked.length ? ranked.reduce((m, c) => (c.unrealizedPnlPct > m.unrealizedPnlPct ? c : m)) : null
  const worst = ranked.length ? ranked.reduce((m, c) => (c.unrealizedPnlPct < m.unrealizedPnlPct ? c : m)) : null

  return {
    assets: computed.map((c) => round(c)),
    totals: {
      investedUsd: +investedUsd.toFixed(2),
      valueUsd: +valueUsd.toFixed(2),
      unrealizedPnlUsd: +unrealizedPnlUsd.toFixed(2),
      unrealizedPnlPct: investedUsd > 0 ? +((unrealizedPnlUsd / investedUsd) * 100).toFixed(2) : 0,
      realizedPnlUsd: +realizedPnlUsd.toFixed(2),
      assetCount: computed.filter((c) => c.qty > 0).length,
    },
    best: best ? { symbol: best.symbol, pct: +best.unrealizedPnlPct.toFixed(2) } : null,
    worst: worst ? { symbol: worst.symbol, pct: +worst.unrealizedPnlPct.toFixed(2) } : null,
    at: Date.now(),
  }
}

function round(c: AssetMetrics): AssetMetrics {
  return {
    ...c,
    qty: +c.qty.toFixed(10),
    avgCostUsd: +c.avgCostUsd.toFixed(8),
    costBasisUsd: +c.costBasisUsd.toFixed(2),
    valueUsd: +c.valueUsd.toFixed(2),
    unrealizedPnlUsd: +c.unrealizedPnlUsd.toFixed(2),
    unrealizedPnlPct: +c.unrealizedPnlPct.toFixed(2),
    realizedPnlUsd: +c.realizedPnlUsd.toFixed(2),
    allocationPct: +c.allocationPct.toFixed(2),
  }
}

// ── Value over time ──────────────────────────────────────────────────────────

/** Portfolio value over time, reconstructed as Σ(current qty × historical price)
 *  per asset on a unified time axis. The standard tracker approximation: "what my
 *  current holdings would have been worth". `days`: 1 / 7 / 30 / 365 (all). */
export async function trackerHistory(days: number): Promise<{ t: number; v: number }[]> {
  const held = state.tracker.map((a) => ({ cg: a.cg, qty: currentQty(a) })).filter((a) => a.qty > 0)
  if (held.length === 0) return []
  const series = await Promise.all(
    held.map(async (h) => {
      try {
        const c = await getCandles(h.cg, days)
        return { qty: h.qty, closes: c }
      } catch {
        return { qty: h.qty, closes: [] as { t: number; c: number }[] }
      }
    }),
  )
  const valid = series.filter((s) => s.closes.length > 0)
  if (valid.length === 0) return []
  // Unified axis = the densest series' timestamps.
  const base = valid.reduce((m, s) => (s.closes.length > m.length ? s.closes : m), valid[0].closes).map((p) => p.t)
  return base.map((t) => ({
    t,
    v: +sum(valid.map((s) => s.qty * priceAt(s.closes, t))).toFixed(2),
  }))
}

/** Last close at or before `t` (binary search); falls back to the first close. */
function priceAt(closes: { t: number; c: number }[], t: number): number {
  let lo = 0
  let hi = closes.length - 1
  let ans = closes[0].c
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (closes[mid].t <= t) {
      ans = closes[mid].c
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

function downsample(xs: number[], target: number): number[] {
  if (xs.length <= target) return xs
  const step = xs.length / target
  const out: number[] = []
  for (let i = 0; i < target; i++) out.push(xs[Math.floor(i * step)])
  out.push(xs[xs.length - 1])
  return out
}

// ── Coin search (for the add-position picker) ────────────────────────────────

const searchCache = ttlCache<CoinHit[]>(600_000)
export interface CoinHit { id: string; symbol: string; name: string; thumb: string | null; rank: number | null }

/** Proxy CoinGecko /search so the add-position UI can resolve a coin → its id. */
export async function searchCoins(query: string): Promise<CoinHit[]> {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  const fresh = searchCache.fresh(q)
  if (fresh) return fresh
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`, { headers: cgHeaders(), signal: AbortSignal.timeout(8000) })
    if (!res.ok) return searchCache.stale(q) ?? []
    const data: any = await res.json()
    const rows: CoinHit[] = (Array.isArray(data?.coins) ? data.coins : []).slice(0, 15).map((c: any) => ({
      id: String(c.id), symbol: String(c.symbol ?? '').toUpperCase(), name: String(c.name ?? c.id), thumb: typeof c.thumb === 'string' ? c.thumb : null, rank: Number.isFinite(c.market_cap_rank) ? c.market_cap_rank : null,
    }))
    return searchCache.set(q, rows)
  } catch {
    return searchCache.stale(q) ?? []
  }
}

// ── Per-coin market data (for the Profit Calculator's market-cap targeting) ───
// A market-cap target is only "absolutely correct" with the live circulating supply:
// implied price = target market cap ÷ circulating supply. So we surface price + market
// cap + circulating supply together for a selected coin.
export interface CoinMarket {
  id: string
  symbol: string
  name: string
  image: string | null
  priceUsd: number
  marketCapUsd: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  fdvUsd: number | null
}
const finiteOrNull = (v: unknown): number | null => (Number.isFinite(Number(v)) ? Number(v) : null)
const marketCache = ttlCache<CoinMarket>(600_000)

export async function coinMarket(id: string): Promise<CoinMarket | null> {
  const cid = id.trim().toLowerCase()
  if (!cid) return null
  // 10-min cache: market cap + supply move slowly, and it spares the rate-limited free tier.
  const fresh = marketCache.fresh(cid)
  if (fresh) return fresh
  // Direct fetch (like searchCoins) — this is a one-shot, user-initiated lookup, so it must
  // NOT be gated by the engine's shared background-polling 429 backoff (which would starve it).
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(cid)}`, { headers: cgHeaders(), signal: AbortSignal.timeout(8000) })
    if (!res.ok) return marketCache.stale(cid) ?? null
    const data: unknown = await res.json()
    const m = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null
    if (m) {
      const out: CoinMarket = {
        id: String(m.id),
        symbol: String(m.symbol ?? '').toUpperCase(),
        name: String(m.name ?? m.id),
        image: typeof m.image === 'string' ? m.image : null,
        priceUsd: finiteOrNull(m.current_price) ?? 0,
        marketCapUsd: finiteOrNull(m.market_cap),
        circulatingSupply: finiteOrNull(m.circulating_supply),
        totalSupply: finiteOrNull(m.total_supply),
        fdvUsd: finiteOrNull(m.fully_diluted_valuation),
      }
      return marketCache.set(cid, out)
    }
  } catch {
    /* fall through to stale */
  }
  return marketCache.stale(cid) ?? null // rate-limited / failure / not found → serve stale if we have it
}
