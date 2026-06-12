// Backtests run the SAME strategy.decide() the live engine uses, over real
// 30-day hourly history, with fees + slippage and the same cost-basis
// accounting (buy fees included), so wizard numbers are honest.

import { getCandles, backoffRemainingMs } from './prices.js'
import { strategyById, STRATEGIES, type Ctx } from './strategies.js'
import { RISK } from './risk.js'
import { networkById, NETWORKS } from './networks.js'
import { discoverSafePools } from './sniper.js'

export interface BacktestResult {
  days: number
  trades: number
  wins: number
  losses: number
  returnPct: number
  buyHoldPct: number
  maxDrawdownPct: number
  feesUsd: number
  equity: { t: number; v: number }[]
  error?: string
}

const SLIPPAGE = 0.0015
const WARMUP = 25 // candles consumed before trading starts (indicator warm-up)

function fail(days: number, error: string): BacktestResult {
  return {
    days, trades: 0, wins: 0, losses: 0, returnPct: 0, buyHoldPct: 0,
    maxDrawdownPct: 0, feesUsd: 0, equity: [], error,
  }
}

/** Pure simulation over a candle series — no network access. */
export function simulate(
  candles: { t: number; c: number }[],
  opts: { strategy: string; risk: string; budgetUsd: number; gasUsd: number; days?: number },
): BacktestResult {
  const days = opts.days ?? 30
  const strat = strategyById(opts.strategy)
  const params = RISK[opts.risk]
  if (!strat || !params) return fail(days, 'bad parameters')
  if (!Number.isFinite(opts.budgetUsd) || opts.budgetUsd < 10) return fail(days, 'budget must be at least $10')
  if (candles.length < 50) return fail(days, 'not enough market history available right now (rate limited?) — try again shortly')

  const gasUsd = opts.gasUsd
  let cash = opts.budgetUsd
  let qty = 0
  let avgCost = 0
  let costUsd = 0
  let fees = 0
  let wins = 0
  let losses = 0
  let trades = 0
  let peak = opts.budgetUsd
  let maxDD = 0
  const state: Record<string, any> = {}
  const equity: { t: number; v: number }[] = []
  const closesAll = candles.map((c) => c.c)

  for (let i = WARMUP; i < candles.length; i++) {
    const price = candles[i].c
    const ctx: Ctx = {
      price,
      closes: closesAll.slice(0, i + 1),
      params,
      state,
      position: { qty, avgCostUsd: avgCost, costUsd },
      budgetUsd: opts.budgetUsd,
      cashUsd: cash,
      now: candles[i].t,
    }
    const a = strat.decide(ctx)
    if (a?.type === 'buy' && a.usd > 1 && cash >= a.usd) {
      const fee = gasUsd + a.usd * SLIPPAGE
      const got = (a.usd - fee) / price
      // Cost basis includes the buy fee — identical to the live engine.
      avgCost = qty + got > 0 ? (avgCost * qty + a.usd) / (qty + got) : price
      qty += got
      costUsd += a.usd
      cash -= a.usd
      fees += fee
      trades++
    } else if (a?.type === 'sell' && qty > 0) {
      const sellQty = qty * Math.min(1, a.fraction)
      const gross = sellQty * price
      const fee = gasUsd + gross * SLIPPAGE
      const pnl = gross - fee - sellQty * avgCost
      cash += gross - fee
      costUsd = Math.max(0, costUsd - sellQty * avgCost)
      qty -= sellQty
      if (qty < 1e-12) { qty = 0; costUsd = 0 }
      fees += fee
      trades++
      if (pnl >= 0) wins++
      else losses++
      if (a.exit || qty === 0) state.lastExitAt = candles[i].t
    }
    const v = cash + qty * price
    peak = Math.max(peak, v)
    maxDD = Math.max(maxDD, ((peak - v) / peak) * 100)
    if (i % 4 === 0 || i === candles.length - 1) equity.push({ t: candles[i].t, v: +v.toFixed(2) })
  }

  const final = cash + qty * candles[candles.length - 1].c
  const first = candles[WARMUP].c
  const last = candles[candles.length - 1].c
  return {
    days,
    trades,
    wins,
    losses,
    returnPct: +(((final - opts.budgetUsd) / opts.budgetUsd) * 100).toFixed(2),
    buyHoldPct: +(((last - first) / first) * 100).toFixed(2),
    maxDrawdownPct: +maxDD.toFixed(2),
    feesUsd: +fees.toFixed(2),
    equity,
  }
}

export async function backtest(opts: {
  network: string
  tokenCg: string
  strategy: string
  risk: string
  budgetUsd: number
  days?: number
}): Promise<BacktestResult> {
  const net = networkById(opts.network)
  if (!net) return fail(opts.days ?? 30, 'unknown network')
  const candles = await getCandles(opts.tokenCg, opts.days ?? 30)
  return simulate(candles, { ...opts, gasUsd: net.avgGasUsd })
}

// ── Profit Finder ────────────────────────────────────────────────────────────

export interface FinderRow {
  network: string
  token: string
  tokenName: string
  strategy: string
  strategyName: string
  risk: string
  returnPct: number
  profitUsd: number
  winRate: number | null
  maxDrawdownPct: number
  trades: number
  feesUsd: number
  change24hPct?: number | null
  /** How to act on this row: a curated bot, a paper market bot, or a screened snipe. */
  launch?:
    | { kind: 'bot'; network: string; token: string }
    | { kind: 'market'; cg: string; token: string; tokenName: string }
    | { kind: 'snipe'; network: string; token: string; poolAddress: string; tokenAddress: string }
    | null
}

export interface FinderResult {
  budgetUsd: number
  days: number
  rows: FinderRow[] // sorted by profit, best first
  skipped: string[] // tokens with no market data right now
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * "Here is $X — where would it have made the most?" Backtests every
 * strategy × risk tier for the chosen coin(s) over the same real history
 * and ranks the outcomes by profit.
 */
export async function profitFinder(opts: {
  budgetUsd: number
  network: string
  token?: string // symbol; omitted = every coin on the network
  scope?: 'curated' | 'top100' | 'trending'
}): Promise<FinderResult | { error: string }> {
  const net = networkById(opts.network)
  if (!net) return { error: 'unknown network' }
  const budget = Number(opts.budgetUsd)
  if (!Number.isFinite(budget) || budget < 10) return { error: 'budget must be at least $10' }
  if (opts.scope === 'top100') return top100Finder(budget)
  if (opts.scope === 'trending') return trendingFinder(budget, net.id)
  const tokens = opts.token ? net.tokens.filter((t) => t.symbol === opts.token) : net.tokens
  if (!tokens.length) return { error: 'unknown token' }

  const rows: FinderRow[] = []
  const skipped: string[] = []
  let fetched = 0
  for (const tok of tokens) {
    if (fetched > 0) await wait(1100) // stay under CoinGecko free-tier rate limits
    const candles = await getCandles(tok.cg, 30)
    fetched++
    if (candles.length < 50) {
      skipped.push(tok.symbol)
      continue
    }
    for (const s of STRATEGIES) {
      for (const risk of Object.keys(RISK)) {
        const r = simulate(candles, { strategy: s.id, risk, budgetUsd: budget, gasUsd: net.avgGasUsd })
        if (r.error) continue
        rows.push({
          network: net.id,
          token: tok.symbol,
          tokenName: tok.name,
          strategy: s.id,
          strategyName: s.name,
          risk,
          returnPct: r.returnPct,
          profitUsd: +((budget * r.returnPct) / 100).toFixed(2),
          winRate: r.wins + r.losses > 0 ? +((r.wins / (r.wins + r.losses)) * 100).toFixed(0) : null,
          maxDrawdownPct: r.maxDrawdownPct,
          trades: r.trades,
          feesUsd: r.feesUsd,
          launch: { kind: 'bot', network: net.id, token: tok.symbol },
        })
      }
    }
  }
  rows.sort((a, b) => b.profitUsd - a.profitUsd)
  return { budgetUsd: budget, days: 30, rows, skipped }
}

// ── Scope: top-100 momentum ──────────────────────────────────────────────────
// Pulls the CoinGecko top-100 by market cap, ranks by 24h momentum (the coins
// "trending and likely to profit from"), and backtests the strongest movers.

const STABLE_OR_WRAPPED = new Set([
  'usdt', 'usdc', 'dai', 'usds', 'usde', 'usd1', 'fdusd', 'tusd', 'pyusd', 'usdt0',
  'wbtc', 'weth', 'wsteth', 'steth', 'weeth', 'cbbtc', 'reth', 'meth', 'rseth', 'cbeth', 'lbtc', 'wbeth', 'jitosol', 'bnsol', 'wbnb',
])

let marketsCache: { at: number; rows: any[] } | null = null

async function topMarkets(): Promise<any[]> {
  if (marketsCache && Date.now() - marketsCache.at < 300_000) return marketsCache.rows
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h',
      { headers: { accept: 'application/json' } },
    )
    if (!res.ok) return marketsCache?.rows ?? []
    const rows = await res.json()
    if (Array.isArray(rows) && rows.length) marketsCache = { at: Date.now(), rows }
    return marketsCache?.rows ?? []
  } catch {
    return marketsCache?.rows ?? []
  }
}

/** Map a CoinGecko id to a curated (network, symbol) so the row is launchable. */
function curatedHome(cg: string): { network: string; token: string } | null {
  for (const n of NETWORKS) {
    const t = n.tokens.find((x) => x.cg === cg)
    if (t) return { network: n.id, token: t.symbol }
  }
  return null
}

async function top100Finder(budget: number): Promise<FinderResult | { error: string }> {
  const markets = await topMarkets()
  if (!markets.length) return { error: 'market data unavailable right now — try again in a minute' }
  const movers = markets
    .filter((m) => m?.id && !STABLE_OR_WRAPPED.has(String(m.symbol).toLowerCase()))
    .sort((a, b) => (b.price_change_percentage_24h ?? -999) - (a.price_change_percentage_24h ?? -999))
    .slice(0, 6)

  const rows: FinderRow[] = []
  const skipped: string[] = []
  let fetched = 0
  for (const m of movers) {
    if (fetched > 0) await wait(6000) // free-tier pacing — the engine shares this budget
    let candles = await getCandles(m.id, 30)
    if (candles.length < 50) {
      // A short result means CoinGecko has us in its penalty box, not that the
      // coin lacks history — wait the backoff out once, then retry.
      await wait(backoffRemainingMs() + 2000)
      candles = await getCandles(m.id, 30)
    }
    fetched++
    const symbol = String(m.symbol).toUpperCase()
    if (candles.length < 50) {
      skipped.push(symbol)
      continue
    }
    const home = curatedHome(m.id)
    for (const s of STRATEGIES) {
      for (const risk of Object.keys(RISK)) {
        const r = simulate(candles, { strategy: s.id, risk, budgetUsd: budget, gasUsd: home ? networkById(home.network)!.avgGasUsd : 0.02 })
        if (r.error) continue
        rows.push({
          network: home?.network ?? 'market',
          token: symbol,
          tokenName: m.name ?? symbol,
          strategy: s.id,
          strategyName: s.name,
          risk,
          returnPct: r.returnPct,
          profitUsd: +((budget * r.returnPct) / 100).toFixed(2),
          winRate: r.wins + r.losses > 0 ? +((r.wins / (r.wins + r.losses)) * 100).toFixed(0) : null,
          maxDrawdownPct: r.maxDrawdownPct,
          trades: r.trades,
          feesUsd: r.feesUsd,
          change24hPct: m.price_change_percentage_24h != null ? +Number(m.price_change_percentage_24h).toFixed(2) : null,
          // Curated coins launch on their home network (live-capable); the rest
          // launch as paper "market" bots priced straight from CoinGecko.
          launch: home ? { kind: 'bot', ...home } : { kind: 'market', cg: m.id, token: symbol, tokenName: m.name ?? symbol },
        })
      }
    }
  }
  if (!rows.length && skipped.length)
    return { error: 'market data provider is rate-limiting — try again in a minute' }
  rows.sort((a, b) => b.profitUsd - a.profitUsd)
  return { budgetUsd: budget, days: 30, rows, skipped }
}

// ── Scope: trending-safe pools ───────────────────────────────────────────────
// Trending pools on the chosen network that already passed the FULL safety
// gate (verified · sellable · distributed holders), backtested on their real
// GeckoTerminal hourly candles. Launching one arms a screened snipe.

async function gtHourlyCloses(gt: string, poolAddress: string): Promise<{ t: number; c: number }[]> {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${gt}/pools/${poolAddress}/ohlcv/hour?limit=1000&currency=usd`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return []
    const data: any = await res.json()
    const list: any[] = data?.data?.attributes?.ohlcv_list ?? []
    return list
      .map((row) => ({ t: Number(row[0]) * 1000, c: Number(row[4]) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.c) && x.c > 0)
      .sort((a, b) => a.t - b.t)
  } catch {
    return []
  }
}

async function trendingFinder(budget: number, network: string): Promise<FinderResult | { error: string }> {
  const net = networkById(network)!
  const { pools, error } = await discoverSafePools(network, 'trending')
  if (!pools.length) return { error: error ?? 'no trending tokens pass the safety gate right now — try again in a few minutes' }

  const rows: FinderRow[] = []
  const skipped: string[] = []
  for (const p of pools.slice(0, 5)) {
    const candles = await gtHourlyCloses(net.gt, p.poolAddress)
    if (candles.length < 50) {
      skipped.push(p.tokenSymbol)
      continue
    }
    const days = Math.max(1, Math.round((candles[candles.length - 1].t - candles[0].t) / 86_400_000))
    for (const s of STRATEGIES) {
      for (const risk of Object.keys(RISK)) {
        const r = simulate(candles, { strategy: s.id, risk, budgetUsd: budget, gasUsd: net.avgGasUsd, days })
        if (r.error) continue
        rows.push({
          network: net.id,
          token: p.tokenSymbol,
          tokenName: p.tokenName,
          strategy: s.id,
          strategyName: s.name,
          risk,
          returnPct: r.returnPct,
          profitUsd: +((budget * r.returnPct) / 100).toFixed(2),
          winRate: r.wins + r.losses > 0 ? +((r.wins / (r.wins + r.losses)) * 100).toFixed(0) : null,
          maxDrawdownPct: r.maxDrawdownPct,
          trades: r.trades,
          feesUsd: r.feesUsd,
          change24hPct: p.priceChange1hPct ?? null,
          launch: { kind: 'snipe', network: net.id, token: p.tokenSymbol, poolAddress: p.poolAddress, tokenAddress: p.tokenAddress },
        })
      }
    }
  }
  rows.sort((a, b) => b.profitUsd - a.profitUsd)
  return { budgetUsd: budget, days: 30, rows, skipped }
}
