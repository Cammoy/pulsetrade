// Four well-studied strategies. Each is a pure decide() over price history +
// per-bot scratch state, so the exact same code path powers the live engine
// AND the backtester — what you backtest is literally what runs.

import { ema, emaSeries, rsi, sma, stdevReturnsPct, trailingReturnPct } from './indicators.js'
import { principalRecoveryFraction } from './safety-math.js'
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

/** Volatility-targeted entry size: scale the base position so a typical move risks a
 *  consistent slice of budget — smaller in a high-vol coin, (capped) larger in a calm
 *  one. A real risk-management lever; falls back to the base size when vol is unknown.
 *  Capped 0.2×–1.5× so it always trades and never over-levers a quiet coin. */
function volSizedUsd(ctx: Ctx, targetVolPct: number, baseFraction = ctx.params.positionPct): number {
  const base = (ctx.budgetUsd * baseFraction) / 100
  const vol = stdevReturnsPct(ctx.closes, 24)
  if (!Number.isFinite(vol) || vol <= 0) return Math.min(base, ctx.cashUsd)
  const scale = Math.min(1.5, Math.max(0.2, targetVolPct / vol)) // already capped at 1.5×; floored at 0.2×
  return Math.min(base * scale, ctx.cashUsd)
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
    // Step lastLevel by exactly ONE rung per tick toward `level`, acting on that single
    // rung. The engine acts on one Action per tick, so a fast multi-level move would
    // otherwise jump lastLevel straight to `level` and skip every intermediate rung —
    // under-filling the ladder on a drop and leaving inventory stranded on a spike. A
    // subsequent unchanged-price tick keeps stepping until lastLevel catches up. [grid-rungs]
    if (level < s.lastLevel) {
      const rung = s.lastLevel - 1
      s.lastLevel = rung
      if (rung >= -ctx.params.gridLevels && ctx.cashUsd >= sliceUsd * 0.99)
        return { type: 'buy', usd: Math.min(sliceUsd, ctx.cashUsd), reason: `Price crossed grid level ${rung} — buy the rung` }
    } else {
      const rung = s.lastLevel + 1
      s.lastLevel = rung
      if (ctx.position.qty > 0) {
        const rungsHeld = Math.max(1, Math.round(ctx.position.costUsd / sliceUsd))
        return { type: 'sell', fraction: 1 / rungsHeld, reason: `Price crossed grid level ${rung} — sell the rung` }
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
    // Regime filter: mean reversion bleeds money buying "oversold" dips inside a
    // confirmed downtrend (catching a falling knife). Skip the entry when price
    // is well below its 50h average — backtested to cut downtrend losses sharply
    // (e.g. aggressive −45%→−30%, max drawdown 46→30) with ZERO effect on the
    // ranging markets the strategy is built for.
    const longAvg = sma(ctx.closes, 50)
    if (!Number.isNaN(longAvg) && pctFrom(ctx.price, longAvg) < -8) return null
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
      // Capitulation stop, tightened to 2× (was 2.5×): DCA averages DOWN, so its stop must
      // not sit so far below cost that it rides a dying token most of the way to zero. [P2-8]
      if (chg <= -ctx.params.stopLossPct * 2)
        return { type: 'sell', fraction: 1, reason: `Deep drawdown ${chg.toFixed(2)}% — capitulation stop`, exit: true }
    }
    const due = !s.lastBuyAt || ctx.now - s.lastBuyAt >= ctx.params.dcaIntervalMin * 60_000
    if (!due) return null
    const avg24 = sma(ctx.closes, 24)
    if (Number.isNaN(avg24) || ctx.price >= avg24) return null
    // Downtrend filter: buy DIPS, never average down into a CONFIRMED downtrend. Without a
    // long-MA gate, "below the 24h average" keeps buying all the way to zero (martingale into
    // a dying token). Mirror meanrev/adaptive: skip new slices when well below the 50h mean. [P2-8]
    const avg50 = sma(ctx.closes, 50)
    if (!Number.isNaN(avg50) && pctFrom(ctx.price, avg50) < -8) return null
    const sliceUsd = ctx.budgetUsd / ctx.params.dcaSlices
    const buyUsd = Math.min(sliceUsd, ctx.cashUsd)
    // The engine drops buys of $1 or less as dust. Do NOT advance the DCA clock for
    // a slice we can't actually place, or the bot looks alive (ticking, logging) yet
    // silently never trades. A too-small budget is also rejected at creation.
    if (buyUsd <= 1) return null
    s.lastBuyAt = ctx.now
    return {
      type: 'buy',
      usd: buyUsd,
      reason: `DCA slice — price ${(100 - (ctx.price / avg24) * 100).toFixed(2)}% below 24h average`,
    }
  },
}

// Sniper: buys the full budget on the first tick. Config comes from ctx.state.snipe
// (a SniperConfig the engine seeds from the bot). Two modes:
//  • SMART (deRiskAtPct set): once up that %, sell exactly enough to take the original
//    stake back to safety (cash + the withdrawable vault), then RIDE the rest as
//    risk-free house money — trailing it off its peak with NO fixed timer, so a coin
//    that keeps trending is held 24h+ and a clear reversal closes the runner. A
//    catastrophic stop-loss bounds the downside before de-risking.
//  • LEGACY (deRiskAtPct absent): the original one-shot — full exit on the first of
//    take-profit, stop-loss, trailing stop, or max-hold.
const sniper: Strategy = {
  id: 'sniper',
  name: 'Sniper',
  tagline: 'Instant entry, take the stake back, ride the runner',
  description:
    'Enters a freshly launched token immediately. In smart mode it sells enough to recover your original investment once the position is well in profit, then rides the remainder as risk-free "house money" — trailing it off its peak so a strong trend can run 24h+ and a reversal closes it. A stop-loss bounds the downside. Proceeds are swept to native/USDT.',
  decide(ctx) {
    const cfg = ctx.state.snipe
    if (!cfg) return null

    if (ctx.position.qty <= 0) {
      if (ctx.state.sniped) return null // already fired and fully exited — one-shot per arm
      if (ctx.cashUsd <= 1) return null
      ctx.state.entryAt = ctx.now
      ctx.state.peak = ctx.price
      return { type: 'buy', usd: ctx.cashUsd, reason: 'Sniper entry — full position on launch' }
    }

    ctx.state.peak = Math.max(ctx.state.peak ?? ctx.price, ctx.price)
    const chg = pctFrom(ctx.price, ctx.position.avgCostUsd)
    const fromPeak = pctFrom(ctx.price, ctx.state.peak)
    const heldMin = (ctx.now - (ctx.state.entryAt ?? ctx.now)) / 60_000

    const done = (reason: string): Action => {
      ctx.state.sniped = true
      return { type: 'sell', fraction: 1, reason, exit: true }
    }

    // Catastrophic stop — bounds the downside whether or not we've de-risked yet.
    if (chg <= -cfg.stopLossPct) return done(`Stop-loss ${chg.toFixed(1)}%`)

    // ── SMART mode: take the stake back, then ride the runner ──────────────────
    if (cfg.deRiskAtPct && cfg.deRiskAtPct > 0) {
      if (!ctx.state.derisked) {
        // Up enough → sell exactly the principal-recovery slice (the original investment
        // returns to cash + the withdrawable vault); ride the rest as house money.
        if (chg >= cfg.deRiskAtPct) {
          const { fraction, recoverable } = principalRecoveryFraction(ctx.position.avgCostUsd, ctx.price)
          if (recoverable && fraction < 1) {
            ctx.state.derisked = true
            ctx.state.peak = ctx.price // re-baseline the runner's trailing peak at the de-risk price
            return { type: 'sell', fraction, reason: `Took the stake back (+${chg.toFixed(0)}%) — riding ${((1 - fraction) * 100).toFixed(0)}% as house money`, exit: false }
          }
          return done(`Take-profit +${chg.toFixed(1)}%`) // couldn't recover from a partial — lock it whole
        }
        // Pre-de-risk: a generous max-hold backstop so capital isn't stuck if the target
        // is never reached, plus optional trailing protection once it's green.
        if (cfg.trailingPct && chg > 0 && fromPeak <= -cfg.trailingPct) return done(`Trailing stop ${fromPeak.toFixed(1)}% off peak (locking +${chg.toFixed(1)}%)`)
        if (heldMin >= cfg.maxHoldMin) return done(`Max hold ${(cfg.maxHoldMin / 60).toFixed(0)}h reached (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%)`)
        return null
      }
      // RUNNER (house money): trail from peak, NO fixed timer → rides a strong trend 24h+.
      const trail = cfg.runnerTrailPct ?? cfg.stopLossPct
      if (fromPeak <= -trail) return done(`Runner trailing stop ${fromPeak.toFixed(1)}% off peak — closing the house-money runner (+${chg.toFixed(0)}%)`)
      return null
    }

    // ── LEGACY one-shot (unchanged behaviour) ─────────────────────────────────
    if (chg >= cfg.takeProfitPct) return done(`Take-profit +${chg.toFixed(1)}%`)
    if (cfg.trailingPct && fromPeak <= -cfg.trailingPct && chg > 0) return done(`Trailing stop ${fromPeak.toFixed(1)}% off peak (locking +${chg.toFixed(1)}%)`)
    if (heldMin >= cfg.maxHoldMin) return done(`Max hold ${cfg.maxHoldMin}m reached (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%)`)
    return null
  },
}

// Copy-trade: mirror a tracked "smart money" wallet's flow in this token. The
// engine seeds ctx.state.copySignal = { side, txHash } from the wallet's latest
// on-chain transfer; the bot buys when the wallet buys and sells when it sells,
// acting once per new transaction.
const copytrade: Strategy = {
  id: 'copytrade',
  name: 'Copy Trade',
  tagline: 'Follow smart money',
  description:
    'Mirrors a tracked wallet: when that wallet buys this token, the bot buys; when it sells, the bot exits — so you ride their full move rather than capping it at a tier take-profit. Stop-loss and take-profit are optional safety nets you can add per copy.',
  decide(ctx) {
    const guard = slTp(ctx)
    if (guard) return guard
    const sig = ctx.state.copySignal as { side: 'buy' | 'sell'; txHash: string } | undefined
    if (!sig || !sig.txHash) return null
    if (ctx.state.lastCopiedTx === sig.txHash) return null
    ctx.state.lastCopiedTx = sig.txHash
    if (sig.side === 'buy') {
      if (ctx.position.qty > 0) return null
      // Per-entry size: a fixed override (copy control) if set, else the risk tier's %.
      const sizeUsd = ctx.params.perTradeUsd && ctx.params.perTradeUsd > 0 ? ctx.params.perTradeUsd : (ctx.budgetUsd * ctx.params.positionPct) / 100
      const usd = Math.min(sizeUsd, ctx.cashUsd)
      if (usd > 1) return { type: 'buy', usd, reason: 'Smart money bought — copying entry' }
    } else if (ctx.position.qty > 0) {
      return { type: 'sell', fraction: 1, reason: 'Smart money sold — copying exit', exit: true }
    }
    return null
  },
}

// AI: act on a Gemini-generated signal (seeded into ctx.state.aiSignal by the
// engine). Sizes by confidence × risk tier; exits on opposite signal or stop.
const ai: Strategy = {
  id: 'ai',
  name: 'AI Trader',
  tagline: 'Gemini decides',
  description:
    'Google Gemini analyses recent price action, RSI and moving averages and decides BUY / SELL / HOLD. Position size scales with the model\'s confidence and your risk tier. Requires a Gemini API key (free tier works).',
  decide(ctx) {
    const guard = slTp(ctx)
    if (guard) return guard
    const sig = ctx.state.aiSignal as { action: 'buy' | 'sell' | 'hold'; confidence: number; reason: string } | undefined
    if (!sig) return null
    if (sig.action === 'buy' && ctx.position.qty <= 0 && sig.confidence >= 0.55) {
      if (coolingDown(ctx)) return null
      const usd = Math.min((ctx.budgetUsd * ctx.params.positionPct * sig.confidence) / 100, ctx.cashUsd)
      if (usd > 1) return { type: 'buy', usd, reason: `AI: BUY (${Math.round(sig.confidence * 100)}%) — ${sig.reason}` }
    } else if (sig.action === 'sell' && ctx.position.qty > 0) {
      return { type: 'sell', fraction: 1, reason: `AI: SELL — ${sig.reason}`, exit: true }
    }
    return null
  },
}

// Adaptive "All-Weather": one strategy that reads the market regime each tick and
// switches tactics — ride momentum in uptrends, mean-revert in ranges, and go to CASH
// in confirmed downtrends. Its job is CAPITAL PRESERVATION: in backtests it bounds the
// loss in down/crash regimes (sidestepping the −40%/−80% blowups single strategies take
// in the wrong regime) rather than promising a profit everywhere. It is a cautious
// DEFAULT, not a money-maker — real net returns depend on fees/slippage and aren't
// guaranteed. A fast drawdown-from-peak exit backs up the slower 50h-average regime check.
const adaptive: Strategy = {
  id: 'adaptive',
  name: 'All-Weather',
  tagline: 'Adapts to the regime, defends capital',
  description:
    'A self-switching strategy: it rides confirmed uptrends like a momentum trader, mean-reverts oversold dips in ranging markets, and moves entirely to cash in confirmed downtrends. It is built to LIMIT drawdowns — sidestepping the −40%/−80% blowups single strategies take in the wrong regime — so it is a capital-preserving default, not a guaranteed money-maker; net returns depend on fees and slippage and are not promised. The best cautious one-click start.',
  decide(ctx) {
    const { closes, price, params } = ctx
    if (closes.length < 55) return null // need the 50-period regime average
    const longAvg = sma(closes, 50)
    if (Number.isNaN(longAvg)) return null
    const f = emaSeries(closes, 9)
    const s = emaSeries(closes, 21)
    const n = closes.length - 1
    const bull = f[n] > s[n]
    const wasBull = f[n - 1] > s[n - 1]
    const aboveLong = price > longAvg
    const farBelow = pctFrom(price, longAvg) < -6 // confirmed downtrend

    if (ctx.position.qty > 0) {
      const chg = pctFrom(price, ctx.position.avgCostUsd)
      ctx.state.peak = Math.max(ctx.state.peak ?? ctx.position.avgCostUsd, price)
      const fromPeak = pctFrom(price, ctx.state.peak)
      if (chg <= -params.stopLossPct) return { type: 'sell', fraction: 1, reason: `Stop-loss (${chg.toFixed(2)}%)`, exit: true }
      // FAST crash defense: a sharp give-back from the peak exits IMMEDIATELY, without
      // waiting for price to fall below the 50-HOUR average. After a run-up that average
      // sits far below the peak, so the regime check alone would surrender most of the
      // gains before it ever triggers — this catches a fast dump while it's still small. [P1-10]
      const crashPct = Math.max(params.stopLossPct * 2, 10)
      if (fromPeak <= -crashPct) return { type: 'sell', fraction: 1, reason: `Fast crash exit — ${fromPeak.toFixed(1)}% off peak`, exit: true }
      // Regime defense: a confirmed downtrend or a trend that just broke down → exit to cash.
      if (farBelow || (!bull && wasBull)) return { type: 'sell', fraction: 1, reason: 'Regime turned bearish — moving to cash', exit: true }
      // Momentum trailing: lock in a winner once it gives back from its peak.
      const armed = pctFrom(ctx.state.peak, ctx.position.avgCostUsd) >= params.takeProfitPct
      if (armed && fromPeak <= -(params.stopLossPct * 0.5) && chg > 0)
        return { type: 'sell', fraction: 1, reason: `Trailing stop — locking +${chg.toFixed(2)}%`, exit: true }
      // Range take-profit (when not trending above the long average).
      if (!aboveLong && chg >= params.takeProfitPct) return { type: 'sell', fraction: 1, reason: `Take-profit +${chg.toFixed(2)}%`, exit: true }
      return null
    }

    if (coolingDown(ctx)) return null
    if (farBelow) return null // DOWNTREND → stay in cash. The all-weather key.
    const usd = Math.min((ctx.budgetUsd * params.positionPct) / 100, ctx.cashUsd)
    if (usd <= 1) return null

    // UPTREND → momentum.
    if (bull && aboveLong) {
      if (!wasBull) {
        ctx.state.peak = price
        return { type: 'buy', usd, reason: 'Uptrend confirmed (EMA cross) — momentum entry' }
      }
      const r = rsi(closes, 14)
      if (!Number.isNaN(r) && r < 50) {
        ctx.state.peak = price
        return { type: 'buy', usd, reason: 'Uptrend pullback — adding on the dip' }
      }
      return null
    }

    // RANGE → mean reversion (farBelow downtrends already excluded above).
    const r = rsi(closes, 14)
    if (!Number.isNaN(r) && r < params.rsiBuy) {
      ctx.state.peak = price
      return { type: 'buy', usd, reason: `RSI ${r.toFixed(1)} oversold in range — mean-reversion entry` }
    }
    return null
  },
}

// Momentum Factor: TIME-SERIES momentum — the per-coin form of the cross-sectional
// momentum factor (the backtester runs one coin at a time, so it can't rank the whole
// universe). Buys when trailing return is strongly positive AND price is above its 50h
// average (a trend filter that rejects chop), sizes the entry INVERSELY to volatility
// (risk-targeting), and exits with an ASYMMETRIC ratchet — a trailing stop that lets a
// winner run while cutting losers at the risk-tier stop, plus a momentum-fade exit.
// Momentum is a genuinely researched edge, but it is NOISY and DECAYS — the Edge label
// will usually read weak/unproven, which is the honest truth, not a sales pitch.
const factor: Strategy = {
  id: 'factor',
  name: 'Momentum Factor',
  tagline: 'Buys strength, trails the winners',
  description:
    'Time-series momentum: enters only when the coin’s trailing return is strongly positive and it trades above its 50-hour average, sizes the position inversely to recent volatility, and rides winners with a trailing stop (cutting losers at the risk-tier stop). Momentum is a documented factor but noisy and decaying — treat its Edge label honestly, not as a guarantee.',
  decide(ctx) {
    const { closes, price, params, state } = ctx
    if (closes.length < 55) return null // need the 50h regime average
    const longAvg = sma(closes, 50)
    const trail = trailingReturnPct(closes, 24) // ~1-day momentum on hourly candles
    if (Number.isNaN(longAvg) || Number.isNaN(trail)) return null

    if (ctx.position.qty > 0) {
      const chg = pctFrom(price, ctx.position.avgCostUsd)
      if (chg <= -params.stopLossPct) return { type: 'sell', fraction: 1, reason: `Stop-loss (${chg.toFixed(2)}%)`, exit: true }
      // Asymmetric trailing exit: ratchet a stop under the running peak once in profit,
      // giving winners room (trail = the wider of stop/target) so they aren't cut early.
      state.peak = Math.max(state.peak ?? ctx.position.avgCostUsd, price)
      const trailPct = Math.max(params.stopLossPct, params.takeProfitPct)
      const fromPeak = pctFrom(price, state.peak)
      if (chg > 0 && fromPeak <= -trailPct)
        return { type: 'sell', fraction: 1, reason: `Trailing stop ${fromPeak.toFixed(1)}% off peak — locking +${chg.toFixed(2)}%`, exit: true }
      // Momentum gave out (trailing return negative AND back below the long average).
      if (trail < 0 && price < longAvg) return { type: 'sell', fraction: 1, reason: 'Momentum faded — exit', exit: true }
      return null
    }

    if (coolingDown(ctx)) return null
    const MIN_MOMENTUM = 3 // require ≥3% trailing momentum so fees + chop don't bleed the edge
    if (trail >= MIN_MOMENTUM && price > longAvg) {
      const usd = volSizedUsd(ctx, 4) // target ~4% budget-volatility per entry
      if (usd > 1) {
        state.peak = price
        return { type: 'buy', usd, reason: `Trailing momentum +${trail.toFixed(1)}% & above 50h avg — momentum-factor entry` }
      }
    }
    return null
  },
}

// 'adaptive' leads the list so it's the default in the wizard and one-click.
export const STRATEGIES: Strategy[] = [adaptive, grid, meanrev, momentum, factor, dca]
export const ALL_STRATEGIES: Strategy[] = [...STRATEGIES, sniper, copytrade, ai]
export const strategyById = (id: string) => ALL_STRATEGIES.find((s) => s.id === id)
