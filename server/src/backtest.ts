// Backtests run the SAME strategy.decide() the live engine uses, over real
// 30-day hourly history, with fees + slippage and the same cost-basis
// accounting (buy fees included), so wizard numbers are honest.

import { getCandles } from './prices.js'
import { strategyById, STRATEGIES, type Ctx } from './strategies.js'
import { RISK } from './risk.js'
import { networkById, type Network } from './networks.js'

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
}): Promise<FinderResult | { error: string }> {
  const net = networkById(opts.network)
  if (!net) return { error: 'unknown network' }
  const budget = Number(opts.budgetUsd)
  if (!Number.isFinite(budget) || budget < 10) return { error: 'budget must be at least $10' }
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
        })
      }
    }
  }
  rows.sort((a, b) => b.profitUsd - a.profitUsd)
  return { budgetUsd: budget, days: 30, rows, skipped }
}
