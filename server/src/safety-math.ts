import type { Bot } from './store.js'

// ── Pure safety math ─────────────────────────────────────────────────────────
// Behaviour-free helpers for the live-money guardrails: the daily-spend cap, the
// account circuit breaker, the live-create pre-flight, and the copy-bot signal
// gates. Extracted from engine.ts so the rules that protect real funds can be
// unit-tested in isolation (no engine state, no I/O). The STATEFUL wrappers that
// bind these to live engine state stay in engine.ts; engine.ts re-exports these
// names so existing importers keep resolving.

export interface DailyCap { allowed: boolean; spentToday: number; remaining: number; reason?: string }

/** Pure: would spending `addUsd` more today breach the cap? `capUsd<=0` = no cap. */
export function checkDailyCap(spend: { day: string; usd: number }, addUsd: number, capUsd: number, today: string): DailyCap {
  const spentToday = spend.day === today ? spend.usd : 0
  if (capUsd <= 0) return { allowed: true, spentToday, remaining: Infinity }
  const remaining = Math.max(0, capUsd - spentToday)
  if (spentToday + addUsd > capUsd)
    return { allowed: false, spentToday, remaining, reason: `daily live-spend cap of $${capUsd} reached ($${spentToday.toFixed(0)} spent today, $${remaining.toFixed(0)} left)` }
  return { allowed: true, spentToday, remaining: remaining - addUsd }
}

/** Pure: fold a confirmed live spend into today's running total (resets on day roll). */
export function recordDailySpend(spend: { day: string; usd: number }, addUsd: number, today: string): { day: string; usd: number } {
  const base = spend.day === today ? spend.usd : 0
  return { day: today, usd: base + addUsd }
}

/** Pure: should the breaker trip given accumulated realized P&L + spend? */
export function evaluateBreaker(b: { realizedUsd: number; spentUsd: number }, lossCapUsd: number, totalCapUsd: number): { tripped: boolean; reason: string } {
  if (lossCapUsd > 0 && b.realizedUsd <= -lossCapUsd)
    return { tripped: true, reason: `cumulative live loss $${(-b.realizedUsd).toFixed(0)} hit the $${lossCapUsd} limit` }
  if (totalCapUsd > 0 && b.spentUsd >= totalCapUsd)
    return { tripped: true, reason: `lifetime live spend $${b.spentUsd.toFixed(0)} hit the $${totalCapUsd} ceiling` }
  return { tripped: false, reason: '' }
}

/** Pure: is a NEW real-live bot creatable, or would it be dead on arrival? A live bot whose
 *  budget exceeds the remaining lifetime live-spend ceiling can never enter — its first buy
 *  trips the breaker and pauses the whole live fleet (exactly the "$200 bot, $150 ceiling"
 *  trap). Also blocks creating live bots while the breaker is already tripped. Returns an
 *  error string to reject with, or null when fine. (paper/market/holdings bots: always null.) */
export function evaluateLiveCreate(
  budget: number,
  realLive: boolean,
  breaker: { tripped: boolean; reason: string; spentUsd: number },
  totalCapUsd: number,
): string | null {
  if (!realLive) return null
  if (breaker.tripped)
    return `Live trading is paused by the safety breaker. Reset it from the ⛔ HALTED button at the top of the screen, then create your live bot.`
  if (totalCapUsd > 0) {
    const remaining = Math.max(0, totalCapUsd - breaker.spentUsd)
    if (budget > remaining)
      return `This live bot's $${budget.toFixed(0)} budget exceeds the remaining $${remaining.toFixed(0)} lifetime live-spend ceiling (MAX_LIVE_USD_TOTAL $${totalCapUsd}). Lower the budget to $${remaining.toFixed(0)} or less, or raise the ceiling — otherwise the bot can't trade and would trip the circuit breaker.`
  }
  return null
}

/** Pure: a single live SNIPE may not stake more than `pct`% of the account's lifetime
 *  live-spend ceiling, so one rugged minutes-old token can't take out the whole account
 *  (the #1 risk-of-ruin path). Off when pct<=0 or lifetimeCapUsd<=0 (no ceiling set, so
 *  there's no equity base to size against — opt-in, matching the other live caps). [P0-6a] */
export function snipeSizeError(budgetUsd: number, lifetimeCapUsd: number, pct: number): string | null {
  if (pct <= 0 || lifetimeCapUsd <= 0) return null
  const max = (lifetimeCapUsd * pct) / 100
  if (budgetUsd > max)
    return `This snipe's $${budgetUsd.toFixed(0)} stake exceeds the per-snipe limit of $${max.toFixed(0)} (${pct}% of the $${lifetimeCapUsd} lifetime live ceiling, MAX_SNIPE_EQUITY_PCT). A single fresh token can rug to zero — keep each snipe small. Lower the budget or raise the limit.`
  return null
}

/** Pure: a live buy may not push TOTAL exposure to one token — summed across every live
 *  bot sharing the wallet — above `pct`% of the lifetime ceiling. A concentration cap so
 *  N auto-spawned bots can't pile the whole account into a single token. `currentTokenUsd`
 *  is the existing exposure to that token (this bot + co-tenants). Off when pct<=0 or
 *  lifetimeCapUsd<=0. [P1-5] */
export function tokenExposureError(addUsd: number, currentTokenUsd: number, lifetimeCapUsd: number, pct: number, token: string): string | null {
  if (pct <= 0 || lifetimeCapUsd <= 0) return null
  const max = (lifetimeCapUsd * pct) / 100
  if (currentTokenUsd + addUsd > max)
    return `This buy would put $${(currentTokenUsd + addUsd).toFixed(0)} into ${token}, over the per-token concentration cap of $${max.toFixed(0)} (${pct}% of the $${lifetimeCapUsd} lifetime ceiling, MAX_TOKEN_EXPOSURE_PCT). Spread across more tokens or raise the cap.`
  return null
}

/**
 * A copy bot only mirrors wallet actions that happened AFTER it started following.
 * Never seed an entry from a stale pre-creation signal — `walletTokenSignal` returns
 * the wallet's LATEST event, which on a bot's first ticks is often an old buy that
 * may be hours stale and already played out (chasing the top). [SM-1]
 */
export function freshCopySignal(
  sig: { side: 'buy' | 'sell'; txHash: string; ts: number } | null,
  botCreatedAt: number,
): { side: 'buy' | 'sell'; txHash: string } | null {
  if (!sig || !sig.txHash || sig.ts < botCreatedAt) return null
  return { side: sig.side, txHash: sig.txHash }
}

type CopyEvent = { side: 'buy' | 'sell'; txHash: string; ts: number }

/** Pick the signal a copy bot acts on this refresh. A SELL exit takes PRIORITY over the
 *  latest action so a holding mirror still exits even after a NEWER same-token transfer
 *  (re-buy / inbound) — BUT only when the wallet sold AFTER this bot's CURRENT entry.
 *  Without the openedAt gate, a stale pre-re-buy sell would be resurfaced after a
 *  (non-retiring) manual copy bot re-enters and dump the freshly re-bought position while
 *  the wallet still holds. openedAt is set on buy and reset to null on full exit, so when
 *  qty>0 it is the current entry time. [copy-exit] */
/** Pure: the fraction of a WINNING position to sell so the net proceeds recover the
 *  position's FULL cost basis — i.e. "take the original investment back" off the table,
 *  leaving the remainder as risk-free house money. At price = avgCost×(1+gain), selling
 *  `f` returns f×price×(1−feeRate) per unit; to clear avgCost per unit, f = avgCost /
 *  (price×(1−feeRate)). The feeRate buffer (slippage + gas) makes sure we actually clear
 *  cost basis after costs. `recoverable` is false when the position isn't far enough above
 *  cost (after fees) to recover from a partial — the caller should hold or full-exit, not
 *  de-risk. Fraction is clamped to (0,1]. */
export function principalRecoveryFraction(
  avgCostUsd: number,
  priceUsd: number,
  feeRate = 0.015,
): { fraction: number; recoverable: boolean } {
  if (!(priceUsd > 0) || !(avgCostUsd > 0)) return { fraction: 1, recoverable: false }
  const net = priceUsd * (1 - Math.max(0, Math.min(0.5, feeRate)))
  if (net <= avgCostUsd) return { fraction: 1, recoverable: false } // not enough margin after fees
  const f = avgCostUsd / net
  return { fraction: Math.min(1, Math.max(0, f)), recoverable: f < 1 }
}

/** Pure: how many base units to actually sell on a LIVE exit. Clamps the paper `want`
 *  to the wallet's on-chain `have`, and (when TRUSTED) to THIS bot's attributed share
 *  `mine`. UNTRUSTED — `mine` unmeasurable / a multi-holder wallet — degrades to
 *  want-vs-have so a full exit can never drain a co-tenant bot holding the same token.
 *  Returns 0n when nothing is sellable. `exceedsAttributed` flags the
 *  "sell > attributed holdings" warn case for the caller to log. This is the
 *  byte-identical clamp shared by the EVM and Solana live-mirror branches, factored out
 *  so the two can never drift — the math protects real funds. [MP-2] */
export function clampLiveSell(
  want: bigint,
  have: bigint,
  mine: bigint,
  untrusted: boolean,
  fullExit: boolean,
): { sell: bigint; exceedsAttributed: boolean } {
  const trust = mine > 0n && !untrusted
  if (fullExit) {
    // FULL exit. TRUSTED: liquidate this bot's attributed `mine` (capped to the wallet)
    // so float-truncation / rebase surplus isn't stranded. UNTRUSTED: fall back to the
    // paper `want`, NEVER the whole shared wallet.
    const sell = trust ? (mine < have ? mine : have) : want < have ? want : have
    return { sell, exceedsAttributed: false }
  }
  let cap = want < have ? want : have
  if (trust && mine < cap) cap = mine
  return { sell: cap, exceedsAttributed: trust && mine < want }
}

export function copyRefreshSignal(bot: Bot, latest: CopyEvent | null, latestSell: CopyEvent | null): CopyEvent | null {
  if (
    bot.position.qty > 0 &&
    latestSell &&
    latestSell.ts > (bot.position.openedAt ?? bot.createdAt) &&
    latestSell.txHash !== bot.state.lastCopiedTx
  )
    return latestSell
  return latest
}
