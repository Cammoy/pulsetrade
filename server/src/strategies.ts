// Four well-studied strategies. Each is a pure decide() over price history +
// per-bot scratch state, so the exact same code path powers the live engine
// AND the backtester — what you backtest is literally what runs.

import { ema, emaSeries, rsi, sma } from './indicators.js'
import type { RiskParams } from './risk.js'

export interface Ctx {
  price: number
  closes: number[] // hourly closes, oldest→newest, spot appended last
  params: RiskParams
  state: Record<string, any>
  position: { qty: number; avgCostUsd: number; costUsd: number }
  budgetUsd: number
  cashUsd: number
  now: number
}

export type Action =
  | { type: 'buy'; usd: number; reason: string }
  | { type: 'sell'; fraction: number; reason: string; exit?: boolean }

export interface Strategy {
  id: string
  name: string
  tagline: string
  description: string
  decide(ctx: Ctx): Action | null
}

const pctFrom = (price: number, avg: number) => ((price - avg) / avg) * 100

function coolingDown(ctx: Ctx): boolean {
  const last = ctx.state.lastExitAt ?? 0
  return ctx.now - last < ctx.params.cooldownMin * 60_000
}

/** Common stop-loss / take-profit exit guard. */
function slTp(ctx: Ctx): Action | null {
  if (ctx.position.qty <= 0) return null
  const chg = pctFrom(ctx.price, ctx.position.avgCostUsd)
  if (chg <= -ctx.params.stopLossPct)
    return { type: 'sell', fraction: 1, reason: `Stop-loss hit (${chg.toFixed(2)}%)`, exit: true }
  if (chg >= ctx.params.takeProfitPct)
    return { type: 'sell', fraction: 1, reason: `Take-profit hit (+${chg.toFixed(2)}%)`, exit: true }
  return null
}

const grid: Strategy = {
  id: 'grid',
  name: 'Grid',
  tagline: 'Profits from sideways chop',
  description:
    'Lays a ladder of buy levels below an anchor price and sells one rung higher as price oscillates. The classic market-maker strategy for ranging markets; each rung crossing books a small profit.',
  decide(ctx) {
    const s = ctx.state
    const spacing = ctx.params.gridSpacingPct / 100
    if (!s.anchor) {
      s.anchor = ctx.price
      s.lastLevel = 0
    }
    const level = Math.floor(Math.log(ctx.price / s.anchor) / Math.log(1 + spacing))
    // Hard stop: fell well below the bottom rung → cut and re-anchor.
    if (ctx.position.qty > 0 && level < -(ctx.params.gridLevels + 2)) {
      s.anchor = ctx.price
      s.lastLevel = 0
      return { type: 'sell', fraction: 1, reason: 'Grid floor breached — hard stop & re-anchor', exit: true }
    }
    if (level === s.lastLevel) return null
    const sliceUsd = ctx.budgetUsd / ctx.params.gridLevels
    if (level < s.lastLevel) {
      s.lastLevel = level
      if (level >= -ctx.params.gridLevels && ctx.cashUsd >= sliceUsd * 0.99)
        return { type: 'buy', usd: Math.min(sliceUsd, ctx.cashUsd), reason: `Price crossed grid level ${level} — buy the rung` }
    } else {
      s.lastLevel = level
      if (ctx.position.qty > 0) {
        const rungsHeld = Math.max(1, Math.round(ctx.position.costUsd / sliceUsd))
        return { type: 'sell', fraction: 1 / rungsHeld, reason: `Price crossed grid level ${level} — sell the rung` }
      }
      // Price ran above the anchor with nothing held → follow it up.
      if (level > 1) {
        s.anchor = ctx.price
        s.lastLevel = 0
      }
    }
    return null
  },
}

const meanrev: Strategy = {
  id: 'meanrev',
  name: 'RSI Mean Reversion',
  tagline: 'Buys fear, sells greed',
  description:
    'Buys when the 14-period RSI signals the coin is oversold and exits on overbought readings or the risk-tier take-profit/stop-loss. One of the most studied profitable edges in ranging crypto markets.',
  decide(ctx) {
    const guard = slTp(ctx)
    if (guard) return guard
    const r = rsi(ctx.closes, 14)
    if (Number.isNaN(r)) return null
    if (ctx.position.qty > 0) {
      const chg = pctFrom(ctx.price, ctx.position.avgCostUsd)
      if (r > ctx.params.rsiSell && chg > 0.5)
        return { type: 'sell', fraction: 1, reason: `RSI ${r.toFixed(1)} overbought — lock in +${chg.toFixed(2)}%`, exit: true }
      return null
    }
    if (coolingDown(ctx)) return null
    if (r < ctx.params.rsiBuy) {
      const usd = Math.min((ctx.budgetUsd * ctx.params.positionPct) / 100, ctx.cashUsd)
      if (usd > 1) return { type: 'buy', usd, reason: `RSI ${r.toFixed(1)} < ${ctx.params.rsiBuy} — oversold entry` }
    }
    return null
  },
}

const momentum: Strategy = {
  id: 'momentum',
  name: 'EMA Momentum',
  tagline: 'Rides confirmed trends',
  description:
    'Enters when the fast EMA (9) crosses above the slow EMA (21) — a confirmed uptrend — and exits on the reverse cross or the risk-tier stop. Trend-following is the oldest documented systematic edge.',
  decide(ctx) {
    const guard = slTp(ctx)
    if (guard) return guard
    const { closes } = ctx
    if (closes.length < 23) return null
    const f = emaSeries(closes, 9)
    const s = emaSeries(closes, 21)
    const n = closes.length - 1
    const above = f[n] > s[n]
    const wasAbove = f[n - 1] > s[n - 1]
    if (ctx.position.qty > 0) {
      if (!above && wasAbove)
        return { type: 'sell', fraction: 1, reason: 'EMA 9 crossed below EMA 21 — trend over', exit: true }
      return null
    }
    if (coolingDown(ctx)) return null
    if (above && !wasAbove) {
      const usd = Math.min((ctx.budgetUsd * ctx.params.positionPct) / 100, ctx.cashUsd)
      if (usd > 1) return { type: 'buy', usd, reason: 'EMA 9 crossed above EMA 21 — momentum entry' }
    }
    return null
  },
}

const dca: Strategy = {
  id: 'dca',
  name: 'Smart DCA',
  tagline: 'Accumulate dips, exit in profit',
  description:
    'Buys fixed slices on a schedule, but only when price is below its 24h average (buying dips, never tops). Sells the whole stack when average cost shows the risk-tier profit target.',
  decide(ctx) {
    const s = ctx.state
    if (ctx.position.qty > 0) {
      const chg = pctFrom(ctx.price, ctx.position.avgCostUsd)
      if (chg >= ctx.params.takeProfitPct)
        return { type: 'sell', fraction: 1, reason: `Stack up +${chg.toFixed(2)}% on avg cost — take profit`, exit: true }
      if (chg <= -ctx.params.stopLossPct * 2.5)
        return { type: 'sell', fraction: 1, reason: `Deep drawdown ${chg.toFixed(2)}% — capitulation stop`, exit: true }
    }
    const due = !s.lastBuyAt || ctx.now - s.lastBuyAt >= ctx.params.dcaIntervalMin * 60_000
    if (!due) return null
    const avg24 = sma(ctx.closes, 24)
    if (Number.isNaN(avg24) || ctx.price >= avg24) return null
    const sliceUsd = ctx.budgetUsd / ctx.params.dcaSlices
    if (ctx.cashUsd < Math.min(sliceUsd, 1)) return null
    s.lastBuyAt = ctx.now
    return {
      type: 'buy',
      usd: Math.min(sliceUsd, ctx.cashUsd),
      reason: `DCA slice — price ${(100 - (ctx.price / avg24) * 100).toFixed(2)}% below 24h average`,
    }
  },
}

export const STRATEGIES: Strategy[] = [grid, meanrev, momentum, dca]
export const strategyById = (id: string) => STRATEGIES.find((s) => s.id === id)
