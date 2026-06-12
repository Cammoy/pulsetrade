// Backtests run the SAME strategy.decide() the live engine uses, over real
// 30-day hourly history, with fees + slippage, so wizard numbers are honest.

import { getCandles } from './prices.js'
import { strategyById, type Ctx } from './strategies.js'
import { RISK } from './risk.js'
import { networkById } from './networks.js'

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

export async function backtest(opts: {
  network: string
  tokenCg: string
  strategy: string
  risk: string
  budgetUsd: number
  days?: number
}): Promise<BacktestResult> {
  const days = opts.days ?? 30
  const strat = strategyById(opts.strategy)
  const params = RISK[opts.risk]
  const net = networkById(opts.network)
  const fail = (error: string): BacktestResult => ({
    days, trades: 0, wins: 0, losses: 0, returnPct: 0, buyHoldPct: 0,
    maxDrawdownPct: 0, feesUsd: 0, equity: [], error,
  })
  if (!strat || !params || !net) return fail('bad parameters')
  const candles = await getCandles(opts.tokenCg, days)
  if (candles.length < 50) return fail('not enough market history available right now (rate limited?) — try again shortly')

  const gasUsd = net.avgGasUsd
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

  for (let i = 25; i < candles.length; i++) {
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
      avgCost = qty + got > 0 ? (avgCost * qty + price * got) / (qty + got) : price
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
      if (a.exit || qty === 0) {
        if (pnl >= 0) wins++
        else losses++
        state.lastExitAt = candles[i].t
      }
    }
    const v = cash + qty * price
    peak = Math.max(peak, v)
    maxDD = Math.max(maxDD, ((peak - v) / peak) * 100)
    if (i % 4 === 0 || i === candles.length - 1) equity.push({ t: candles[i].t, v: +v.toFixed(2) })
  }

  const final = cash + qty * candles[candles.length - 1].c
  const first = candles[25].c
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
