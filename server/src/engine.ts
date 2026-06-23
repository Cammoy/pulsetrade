// The bot engine: one tick loop drives every bot concurrently. Each bot has
// independent cash, position, strategy state, schedule and P&L — so the same
// coin can be traded under several risk tolerances side by side.
//
// Accounting model (all invariants covered by test/engine.test.ts):
// - avgCostUsd is true cost basis INCLUDING buy fees (avg = dollars in / units held)
// - every sell realizes pnl = net proceeds − sold cost basis, and counts a win/loss
// - profits are swept to the chain's native coin; principal returns to working cash
// - a manual stop sweeps ALL proceeds to native
// - every fill updates the persistent monthly ledger (state.monthly)

import { state, save, flushNow, uid, monthKey, dayKey, emptyMonth, type Bot, type Trade, type SniperConfig, type State, type Tournament, type Follow, type Withdrawal } from './store.js'
import { recordTrade, tradeDbReady } from './db.js'
import { networkById, tokenOf, allPriceIds, type Network } from './networks.js'
import { getSpotPrices, getCandles, spot, spotFresh, poolPriceFresh, poolPrice, refreshPoolPrice, spotStale, poolLiquidityUsd } from './prices.js'
import { strategyById, type Ctx, type Action } from './strategies.js'
import { RISK, type RiskParams } from './risk.js'
import { lamportsForUsd, baseUnitsForQty, SOL_MINT } from './live-solana.js'
import { screenAddress } from './screen-fetch.js'
import { discoverSafePools } from './sniper.js'
import { walletCopySignal, walletRecentBuys, trackingReady as smartMoneyReady, MAINNET_CG_IDS } from './smartmoney.js'
import { getAiSignal } from './ai-trader.js'
import { SLIPPAGE_PER_SIDE as SLIPPAGE, gasReserveMult } from './costs.js'
import { EVM_ADDR } from './validators.js'
import { live } from './live-registry.js'
import { runExclusive, drainLanes } from './lanes.js'
import { providerHealth, alertConfigured, notifyAsync } from './health.js'
import { isWin, isLoss } from './pnl.js'
import { broadcast, setBroadcast, type Broadcast } from './broadcast.js'
import { creditVault, vaultBalance } from './vault.js'
// Re-export the profit-vault / withdrawal API (moved to ./vault.js) so app.ts keeps
// importing profitVault/listWithdrawals/requestWithdrawal off './engine.js'.
export { profitVault, listWithdrawals, requestWithdrawal } from './vault.js'
import {
  checkDailyCap,
  recordDailySpend,
  evaluateBreaker,
  evaluateLiveCreate,
  freshCopySignal,
  copyRefreshSignal,
  clampLiveSell,
  snipeSizeError,
  tokenExposureError,
} from './safety-math.js'
// Re-export the pure safety helpers so existing importers (daily-cap.test.ts,
// copy-signal.test.ts) keep resolving them off './engine.js'. The STATEFUL wrappers
// that bind these to live engine state stay defined below.
export { checkDailyCap, recordDailySpend, evaluateBreaker, evaluateLiveCreate, freshCopySignal, copyRefreshSignal, clampLiveSell, snipeSizeError, tokenExposureError }
export type { DailyCap } from './safety-math.js'
import { parseUnits, getAddress } from 'viem'

const TICK_MS = 20_000

// ── Activity-log number formatting (cosmetic — never touches accounting) ──────
// Sub-cent token prices must not collapse to "$0" (toLocaleString rounds at 3dp),
// and million-unit memecoin quantities must not render in scientific notation.
function fmtPx(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return '0'
  if (p >= 1) return p.toLocaleString('en-US', { maximumFractionDigits: 2 })
  // sub-$1: ~4 significant figures, fixed-notation even for tiny prices (1e-9..1)
  const dp = Math.min(18, Math.max(2, 3 - Math.floor(Math.log10(p))))
  return p.toFixed(dp).replace(/\.?0+$/, '')
}
function fmtAmt(q: number): string {
  if (!Number.isFinite(q)) return '0'
  return q >= 1000 ? q.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(+q.toPrecision(6))
}

// Broadcast (./broadcast.js), the live-executor registry (./live-registry.js), the
// per-lane swap FIFO runExclusive (./lanes.js) and gasReserveMult (./costs.js) are
// shared with vault.ts — imported above, not defined here.

function log(bot: Bot, msg: string, kind: 'info' | 'buy' | 'sell' | 'warn' = 'info') {
  bot.log.push({ ts: Date.now(), msg, kind })
  if (bot.log.length > 60) bot.log.splice(0, bot.log.length - 60)
}

export function inSchedule(bot: Bot, d = new Date()): boolean {
  const s = bot.schedule
  if (!s.enabled) return true
  if (!s.days.includes(d.getDay())) return false
  const h = d.getHours()
  return s.startHour <= s.endHour
    ? h >= s.startHour && h < s.endHour
    : h >= s.startHour || h < s.endHour // overnight window
}

function month(ts: number, mode: 'paper' | 'live') {
  const dict = mode === 'live' ? state.monthly.live : state.monthly.paper
  return (dict[monthKey(ts)] ??= emptyMonth())
}

/** A network with a REAL on-chain executor — the single gate for live-fund execution,
 *  the daily/lifetime live-spend cap, and breaker accrual. EVM chains and Solana only;
 *  market/ICP/holdings stay paper even in live mode. [INC-1] */
const hasLiveExecutor = (net: { evm?: boolean; id: string } | null | undefined): boolean =>
  !!net && (net.evm === true || net.id === 'solana')

/** Any bot that trades LIVE on a real chain. Gates the GLOBAL live-safety machinery
 *  (fleet-drawdown cap, on-chain realHeld reconcile) so it engages whenever a live bot
 *  EXISTS — independent of which workspace is currently being viewed. */
const hasLiveBots = (): boolean =>
  state.bots.some((b) => b.mode === 'live' && hasLiveExecutor(networkById(b.network)))

/** Current USD price for a bot: DEX pool for sniped tokens, else CoinGecko.
 *  Returns undefined when the price is STALE — a frozen price must never drive a
 *  stop-loss/take-profit decision or size a live trade (it would never "see" a
 *  real drop, and could mis-size a swap). The tick skips; the UI shows no price. */
function priceForBot(bot: Bot): number | undefined {
  if (bot.pool) {
    const net = networkById(bot.network)
    return net ? poolPriceFresh(net.gt, bot.pool.poolAddress) : undefined
  }
  // Per-id freshness (not the global spotStale()): CoinGecko silently drops delisted/
  // renamed ids from the batch, and the global staleness is held fresh by the majors —
  // so a dropped coin would otherwise serve a permanently-frozen price that a stop-loss
  // / take-profit could never react to. spotFresh() returns undefined when THIS coin is stale.
  if (bot.cg) return spotFresh(bot.cg) // market bots price straight from CoinGecko
  const token = tokenOf(bot.network, bot.token)
  return token ? spotFresh(token.cg) : undefined
}

function execBuy(bot: Bot, price: number, usd: number, reason: string, realQty?: number) {
  const net = networkById(bot.network)!
  const fee = net.avgGasUsd + usd * SLIPPAGE
  // LIVE: book the ACTUAL tokens received (measured on-chain), so position/avgCost
  // reflect the real fill — on thin pools that's materially fewer units than the
  // quote implied. PAPER: model the fill from the quote price.
  const qty = realQty !== undefined ? realQty : (usd - fee) / price
  if (!(qty > 0)) return // a live buy that received ~nothing — don't book a phantom position
  const effPrice = realQty !== undefined ? usd / qty : price // real entry price on a live fill
  const p = bot.position
  // Cost basis = total dollars in (fees included) / units held.
  p.avgCostUsd = p.qty + qty > 0 ? (p.avgCostUsd * p.qty + usd) / (p.qty + qty) : effPrice
  p.qty += qty
  p.costUsd += usd
  if (!p.openedAt) p.openedAt = Date.now()
  bot.cashUsd -= usd
  bot.stats.feesUsd += fee
  const ts = Date.now()
  const m = month(ts, bot.mode) // the bot's OWN workspace, not the active view
  m.volumeUsd += usd
  m.feesUsd += fee
  const trade: Trade = {
    id: uid(), botId: bot.id, ts, side: 'buy', network: bot.network,
    token: bot.token, qty, priceUsd: effPrice, usd, feeUsd: fee, reason,
    mode: bot.mode,
  }
  state.trades.push(trade)
  recordTrade(trade) // full history → SQLite ledger (no-op if disabled)
  log(bot, `BUY $${usd.toFixed(2)} ${bot.token} @ $${fmtPx(price)} — ${reason}`, 'buy')
  // Carry the freshly-mutated monthly ledger on the trade frame so the Monthly P&L
  // (volume/fees here) updates INSTANTLY, not on the next ~20s snapshot. [realtime]
  broadcast({ type: 'trade', trade, monthly: state.monthly })
}

function execSell(bot: Bot, price: number, fraction: number, reason: string, exit: boolean, sweepAll = false, realQty?: number, realProceedsUsd?: number) {
  const net = networkById(bot.network)!
  const p = bot.position
  // LIVE: book the ACTUAL units sold on-chain (clamped to the book so it can't go
  // negative). PAPER: sell the requested fraction of the position.
  const sellQty = realQty !== undefined ? Math.min(realQty, p.qty) : p.qty * Math.min(1, fraction)
  if (sellQty <= 0) return
  const gross = sellQty * price
  // LIVE: proceeds = the native/USDT actually RECEIVED on-chain (measured in-lane),
  // so realized P&L, sweeps and the loss-breaker track the wallet, not the quote —
  // and `fee` becomes the IMPLIED real cost (slippage + gas). PAPER (realProceedsUsd
  // undefined): the modeled fee/proceeds, unchanged. [MP-1]
  const modeledFee = net.avgGasUsd + gross * SLIPPAGE
  // LIVE measured proceeds correspond to the FULL on-chain sale (realQty units). When a
  // trusted full-exit liquidates MORE units than the paper book held (per-fill float
  // truncation or a positive rebase), sellQty is clamped to the book — scale the measured
  // proceeds down to the booked fraction so the surplus units' value isn't credited as
  // pure profit on this trade. (realQty===sellQty → factor 1, unchanged.) [reconcile]
  const proceeds =
    realProceedsUsd !== undefined
      ? realQty !== undefined && realQty > sellQty
        ? realProceedsUsd * (sellQty / realQty)
        : realProceedsUsd
      : gross - modeledFee
  // Live (measured): fee is the IMPLIED real cost (gross − measured proceeds). Paper:
  // keep the EXACT modeled fee — re-deriving it from gross−proceeds drifts by a
  // sub-nanodollar float error, so the paper path stays byte-identical to before. [MP-1]
  const fee = realProceedsUsd !== undefined ? Math.max(0, gross - proceeds) : modeledFee
  const costBasis = sellQty * p.avgCostUsd
  const pnl = proceeds - costBasis

  p.qty -= sellQty
  p.costUsd = Math.max(0, p.costUsd - costBasis)
  if (p.qty < 1e-12) { p.qty = 0; p.costUsd = 0; p.openedAt = null }

  // Profit sweep: profits (or, on manual stop, ALL proceeds) convert to the
  // bot's sweep target — the chain's native coin by default, or USDT when the
  // bot was configured to auto-sell to a stable. Either way: no token bags.
  const toUsdt = bot.sweepTo === 'usdt'
  const sweepSymbol = toUsdt ? net.usdt.symbol : net.native.symbol
  const sweepPrice = toUsdt ? spot(net.usdt.cg) ?? 1 : spot(net.native.cg) ?? 0
  let swept: Trade['sweptNative']
  if (sweepAll && sweepPrice > 0) {
    swept = { qty: proceeds / sweepPrice, symbol: sweepSymbol, usd: proceeds }
  } else if (pnl > 0 && sweepPrice > 0) {
    swept = { qty: pnl / sweepPrice, symbol: sweepSymbol, usd: pnl }
    bot.cashUsd += costBasis // principal returns to working capital
  } else {
    bot.cashUsd += proceeds // loss (or no sweep price): net proceeds back to cash
  }
  if (swept) {
    bot.stats.nativeTakenQty += swept.qty
    bot.stats.nativeTakenUsd += swept.usd
    // Bank the swept profit in the withdrawal vault, keyed by chain + asset + the
    // bot's WORKSPACE — a paper bot's simulated sweep can never become live-withdrawable.
    creditVault(bot.network, toUsdt ? 'usdt' : 'native', swept.qty, bot.mode)
  }

  bot.stats.realizedUsd += pnl
  bot.stats.feesUsd += fee
  // Strict win/loss via the shared definition (./pnl.js) so the live win-rate matches the
  // backtest/Profit-Finder exactly. A break-even or dust round trip is NEITHER. [P2-15]
  if (isWin(pnl)) bot.stats.wins++
  else if (isLoss(pnl)) bot.stats.losses++
  if (exit || p.qty === 0) bot.state.lastExitAt = Date.now()

  const ts = Date.now()
  const m = month(ts, bot.mode) // the bot's OWN workspace, not the active view
  m.volumeUsd += gross
  m.feesUsd += fee
  m.realizedUsd += pnl
  if (isWin(pnl)) m.wins++
  else if (isLoss(pnl)) m.losses++
  m.byRisk[bot.risk] = (m.byRisk[bot.risk] ?? 0) + pnl
  if (swept) m.nativeTakenUsd += swept.usd

  const trade: Trade = {
    id: uid(), botId: bot.id, ts, side: 'sell', network: bot.network,
    token: bot.token, qty: sellQty, priceUsd: price, usd: gross, feeUsd: fee,
    reason, pnlUsd: +pnl.toFixed(6), sweptNative: swept, mode: bot.mode,
  }
  state.trades.push(trade)
  recordTrade(trade) // full history → SQLite ledger (no-op if disabled)
  log(bot, `SELL ${fmtAmt(sellQty)} ${bot.token} @ $${fmtPx(price)} → P&L $${pnl.toFixed(2)}${swept ? ` (swept ${fmtAmt(swept.qty)} ${swept.symbol})` : ''} — ${reason}`, 'sell')
  // Carry the freshly-mutated monthly ledger on the trade frame so the Monthly P&L
  // (realized/wins/sweeps) updates INSTANTLY, not on the next ~20s snapshot. [realtime]
  broadcast({ type: 'trade', trade, monthly: state.monthly })
}

/** The real measured base-unit delta of a confirmed swap (after−before of the
 *  bot's token, read inside the lane). Absent on paper-only success branches. */
type LiveDelta = { tokenAddress: string; decimals: number; baseUnits: bigint; proceedsUsd?: number; nativeSpentUsd?: number }

/** Result of a live mirror attempt. `ok: true` means the paper fill may be
 *  committed — either the on-chain swap confirmed (with `delta` present), or this
 *  network is intentionally paper-only (market/ICP/sub-chain without keys, no
 *  `delta`). `ok: false` means a real swap was attempted and FAILED (or would
 *  desync), so the caller must NOT commit the paper fill. realHeld is mutated
 *  IN-LANE by mirrorLive itself (so a concurrent same-token bot's clamp reads a
 *  fresh value); `delta` is returned only for logging/tests. */
type LiveResult = { ok: true; delta?: LiveDelta } | { ok: false; error: string }

/** This bot's real on-chain holdings of its token, in base units. Defensive
 *  parse: a malformed persisted value must never throw in the hot path. */
const curHeld = (b: Bot): bigint => {
  try {
    return b.realHeld ? BigInt(b.realHeld) : 0n
  } catch {
    return 0n
  }
}

/**
 * Sign-gated, IN-LANE realHeld credit/debit from a measured balance delta.
 * Called inside the runExclusive closure (right after the swap's after-read) so
 * a concurrent same-token bot's clamp reads a fresh value. A buy must increase
 * the bot-token balance and a sell must decrease it — a wrong sign means an
 * external transfer straddled the swap, so we attribute 0 and warn rather than
 * corrupt the ledger. The debit is capped at the bot's own holdings so it can
 * never go negative by absorbing another bot's tokens. Returns attributed units.
 */
function applyHoldingDelta(bot: Bot, side: 'buy' | 'sell', before: bigint, after: bigint): bigint {
  const mine = curHeld(bot)
  if (side === 'buy') {
    if (after <= before) {
      log(bot, 'realHeld reconcile: buy did not increase balance — credited 0 (external transfer?)', 'warn')
      return 0n
    }
    const credited = after - before
    bot.realHeld = (mine + credited).toString()
    return credited
  }
  if (before <= after) {
    log(bot, 'realHeld reconcile: sell did not decrease balance — debited 0 (external transfer?)', 'warn')
    return 0n
  }
  const sold = before - after
  const debit = sold > mine ? mine : sold
  if (sold > mine) log(bot, 'sell delta exceeded own attributed holdings — surplus flagged for reconcile', 'warn')
  bot.realHeld = (mine - debit).toString()
  return sold
}

/**
 * Shared post-confirm measurement for a live fill — used by BOTH the EVM and Solana branches
 * of mirrorLive so the two chains' money math can never drift. The swap is ALREADY confirmed
 * on-chain when this runs, so post-state reads MUST NOT throw past here: an unreadable read
 * degrades to an unmeasurable delta (settle commits the quote estimate + flags untrusted),
 * never a lost confirmation. Returns the committed-fill delta. [MP-1, P1-2]
 *
 * Chain differences are injected: the token/sweep/native balance readers (thunks, only awaited
 * when needed) and `nativeDivisor` (1e18 EVM wei · 1e9 Solana lamports).
 */
async function measureFill(o: {
  bot: Bot
  side: 'buy' | 'sell'
  before: bigint
  tokenAddress: string // lowercased — for the returned delta
  decimals: number
  nativePrice: number | undefined
  nativeDivisor: number
  sweepUsdt: boolean
  usdtDecimals: number
  usdtCg: string
  sweepBefore: bigint // sell only
  nativeBefore: bigint | undefined // buy only — pre-swap native balance, the outflow base
  readToken: () => Promise<bigint>
  readSweep: () => Promise<bigint>
  readNative: () => Promise<bigint>
  confirmLog: string
}): Promise<LiveResult> {
  let after = o.before
  try { after = await o.readToken() } catch { /* post-confirm read failed → unmeasurable, never a lost confirmation */ }
  const baseUnits = applyHoldingDelta(o.bot, o.side, o.before, after)
  let proceedsUsd: number | undefined
  let nativeSpentUsd: number | undefined
  if (o.side === 'sell') {
    // Real sweep asset RECEIVED → realized P&L tracks the WALLET, not the quote. USDT ≈ $1;
    // native valued at the last-known price (already reflects exit impact). recv≤0 → modeled. [MP-1]
    let recv = 0n
    try { recv = (await o.readSweep()) - o.sweepBefore } catch { /* unmeasurable → execSell models proceeds */ }
    if (recv > 0n) proceedsUsd = o.sweepUsdt ? (Number(recv) / 10 ** o.usdtDecimals) * (spot(o.usdtCg) ?? 1) : o.nativePrice ? (Number(recv) / o.nativeDivisor) * o.nativePrice : undefined
  } else if (o.nativeBefore !== undefined && o.nativePrice) {
    // Real native outflow (input + gas) → the spend caps track the wallet. Sane-decrease only;
    // otherwise undefined → settle falls back to the intended USD (never mis-books a buy). [P1-2]
    let nativeAfter = o.nativeBefore
    try { nativeAfter = await o.readNative() } catch { /* unmeasurable → modeled */ }
    if (nativeAfter < o.nativeBefore) nativeSpentUsd = (Number(o.nativeBefore - nativeAfter) / o.nativeDivisor) * o.nativePrice
  }
  log(o.bot, o.confirmLog, 'info')
  return { ok: true, delta: { tokenAddress: o.tokenAddress, decimals: o.decimals, baseUnits, proceedsUsd, nativeSpentUsd } }
}

/**
 * Execute the on-chain swap that mirrors a paper decision and report whether the
 * paper fill may be committed. Per-chain executors: EVM via 0x, Solana via
 * Jupiter; ICP/market stay paper (no REST DEX). For sells the order is clamped
 * to the wallet's real on-chain balance so a swap can never over-spend.
 *
 * IMPORTANT: returns `{ ok: false }` only when an attempted on-chain swap fails
 * or can't be sized — so the caller leaves paper state untouched and pauses the
 * bot. Paper-only networks return `{ ok: true }` so they keep simulating.
 */
async function mirrorLive(bot: Bot, side: 'buy' | 'sell', usd: number, qty: number, price: number, fullExit = false): Promise<LiveResult> {
  if (bot.mode !== 'live') return { ok: true } // PAPER bot: nothing to mirror, regardless of the active workspace
  const net = networkById(bot.network)!
  if (net.id === 'market') {
    log(bot, 'Market-scope bots are paper-only — no on-chain execution', 'info')
    return { ok: true }
  }
  if (net.id === 'icp') {
    log(bot, 'LIVE EXECUTION PENDING: ICP DEXes (KongSwap/ICPSwap) are canister-only — live executor not yet integrated; this trade stayed paper', 'warn')
    return { ok: true }
  }
  // In LIVE mode, a bot on a real network whose executor is NOT configured must
  // HALT — never commit a phantom paper fill (which would also burn the daily cap
  // and desync the ledger from the wallet). ICP/market above are intentionally
  // paper-only; these two are a misconfiguration the operator must fix.
  if (net.evm && !live.liveReady()) {
    return { ok: false, error: 'EVM live not configured — set ZEROX_API_KEY (0x routing) + a signer (BOT_WALLET_KEY or Turnkey). Bot paused; fix and resume.' }
  }
  if (net.id === 'solana' && !live.solanaLiveReady()) {
    return { ok: false, error: 'Solana live not configured — set SOLANA_WALLET_KEY or Turnkey Solana. Bot paused; fix and resume.' }
  }

  // Sniper bots carry their token address/decimals on bot.pool; others resolve
  // from the curated list. An EVM/Solana live bot with no address is a misconfig
  // we must NOT paper-commit (it would desync from reality).
  const tokenAddress = bot.pool?.tokenAddress ?? tokenOf(bot.network, bot.token)?.address
  const decimals = bot.pool?.decimals ?? tokenOf(bot.network, bot.token)?.decimals
  if (!tokenAddress || decimals === undefined) {
    log(bot, 'LIVE EXECUTION BLOCKED: token address unknown', 'warn')
    return { ok: false, error: 'token address unknown' }
  }

  try {
    const nativePrice = spot(net.native.cg)
    // Never size a live buy off a missing OR stale native price — a frozen price
    // would send the wrong amount of real ETH/SOL.
    if (side === 'buy' && (!nativePrice || spotStale())) throw new Error('native price unavailable/stale — refusing to size a live buy')

    // Serialize per wallet+chain so concurrent ticks can't race the nonce or
    // both read the same balance before either sell settles.
    const lower = tokenAddress.toLowerCase()
    if (net.evm) {
      return await runExclusive<LiveResult>(`evm:${net.chainId}`, async () => {
        const before = await live.tokenBalanceBaseUnits(net.chainId, tokenAddress)
        let sellAmount: bigint
        let fairBuyBaseUnits: bigint | undefined
        let nativeBefore: bigint | undefined // measured native balance pre-buy → real outflow [P1-2]
        if (side === 'buy') {
          sellAmount = parseUnits((usd / nativePrice!).toFixed(18), 18) // native in
          // Fair token-out at the current token price (no impact) — lets executeSwap
          // abort a thin/bad route whose quoted out is far below fair. [EVM impact guard]
          fairBuyBaseUnits = price > 0 ? parseUnits((usd / price).toFixed(decimals), decimals) : undefined
          // Keep a native gas reserve so the bot can always pay gas to SELL out of
          // what it buys — without it a bot can spend its native down and strand a
          // position with no gas to exit. Refuse (pause) rather than open a fill we
          // couldn't unwind. [P1-3]
          const reserveUsd = gasReserveMult() * net.avgGasUsd
          const reserveNative = parseUnits((reserveUsd / nativePrice!).toFixed(18), 18)
          const nativeBal = await live.nativeBalanceWei(net.chainId)
          if (nativeBal < sellAmount + reserveNative)
            return { ok: false, error: `insufficient native for buy + gas reserve — keep ~$${reserveUsd.toFixed(2)} native for the exit; fund the bot wallet` }
          nativeBefore = nativeBal
        } else {
          // Clamp: min(paper-want, wallet-have, THIS bot's attributed holdings). `have`
          // is the hard over-send guard; `mine` is soft per-bot attribution that degrades
          // to have (never zero) when stale-low/untrusted. Shared pure clamp [MP-2].
          const want = parseUnits(qty.toFixed(decimals), decimals)
          const r = clampLiveSell(want, before, curHeld(bot), bot.state.realHeldUntrusted, fullExit)
          if (r.exceedsAttributed) log(bot, 'sell exceeds attributed on-chain holdings — clamped', 'warn')
          sellAmount = r.sell
          if (sellAmount <= 0n) return { ok: false, error: 'no on-chain balance to sell' }
        }
        // Measure the sweep asset RECEIVED on a sell so realized P&L tracks the
        // WALLET, not the quote price. Native nets its own gas (proceeds − gas);
        // USDT is the stable out. recv<=0 (unmeasurable) → fall back to the model. [MP-1]
        const sweepUsdt = bot.sweepTo === 'usdt'
        const readSweepEvm = () => (sweepUsdt ? live.tokenBalanceBaseUnits(net.chainId, net.usdt.address) : live.nativeBalanceWei(net.chainId))
        const sweepBefore = side === 'sell' ? await readSweepEvm() : 0n
        const hash = await live.executeSwap({
          chainId: net.chainId,
          tokenAddress,
          side,
          sellAmountBaseUnits: sellAmount,
          fairBuyBaseUnits, // buys only — thin-route impact backstop
          // Sells land in the bot's sweep target (USDT or native).
          buyTokenAddress: side === 'sell' && bot.sweepTo === 'usdt' ? net.usdt.address : undefined,
        })
        // Post-confirm measurement + accounting is shared with the Solana branch (measureFill)
        // so the two chains' money math can't drift. EVM native = wei (1e18).
        return measureFill({
          bot, side, before, tokenAddress: lower, decimals, nativePrice, nativeDivisor: 1e18,
          sweepUsdt, usdtDecimals: net.usdt.decimals, usdtCg: net.usdt.cg, sweepBefore, nativeBefore,
          readToken: () => live.tokenBalanceBaseUnits(net.chainId, tokenAddress),
          readSweep: readSweepEvm,
          readNative: () => live.nativeBalanceWei(net.chainId),
          confirmLog: `On-chain ${side} confirmed: ${hash.slice(0, 18)}…`,
        })
      })
    }

    // Solana — same in-lane measure/clamp/attribute as EVM, via the SPL seam.
    return await runExclusive<LiveResult>('solana', async () => {
      const before = await live.splTokenBalanceBaseUnits(tokenAddress)
      // Sweep-asset (SOL/USDT) received on a sell → real proceeds. SOL nets gas. [MP-1]
      const sweepUsdt = bot.sweepTo === 'usdt'
      const sweepMint = sweepUsdt ? net.usdt.address : SOL_MINT
      const sweepBefore = side === 'sell' ? await live.splTokenBalanceBaseUnits(sweepMint) : 0n
      let sig: string
      let solBefore: bigint | undefined // measured SOL balance pre-buy → real outflow [P1-2]
      if (side === 'buy') {
        // Keep a native (SOL) gas reserve — see the EVM branch above. [P1-3]
        const lamports = lamportsForUsd(usd, nativePrice!)
        const reserveUsd = gasReserveMult() * net.avgGasUsd
        const reserveLamports = lamportsForUsd(reserveUsd, nativePrice!)
        const solBal = await live.splTokenBalanceBaseUnits(SOL_MINT)
        if (solBal < lamports + reserveLamports)
          return { ok: false, error: `insufficient SOL for buy + gas reserve — keep ~$${reserveUsd.toFixed(2)} SOL for the exit; fund the bot wallet` }
        solBefore = solBal
        sig = await live.executeSolanaSwap({ inputMint: SOL_MINT, outputMint: tokenAddress, amountBaseUnits: lamports })
      } else {
        // Same shared pure clamp as the EVM branch [MP-2]; only `want`'s base-unit
        // conversion differs (SPL decimals via baseUnitsForQty).
        const want = baseUnitsForQty(qty, decimals)
        const r = clampLiveSell(want, before, curHeld(bot), bot.state.realHeldUntrusted, fullExit)
        if (r.exceedsAttributed) log(bot, 'sell exceeds attributed on-chain holdings — clamped', 'warn')
        const cap = r.sell
        if (cap <= 0n) return { ok: false, error: 'no on-chain balance to sell' }
        sig = await live.executeSolanaSwap({
          inputMint: tokenAddress,
          // Sells land in the bot's sweep target (USDT or SOL).
          outputMint: bot.sweepTo === 'usdt' ? net.usdt.address : SOL_MINT,
          amountBaseUnits: cap,
        })
      }
      // Same shared post-confirm measurement as the EVM branch (measureFill). SOL native = lamports (1e9).
      return measureFill({
        bot, side, before, tokenAddress: lower, decimals, nativePrice, nativeDivisor: 1e9,
        sweepUsdt, usdtDecimals: net.usdt.decimals, usdtCg: net.usdt.cg, sweepBefore, nativeBefore: solBefore,
        readToken: () => live.splTokenBalanceBaseUnits(tokenAddress),
        readSweep: () => live.splTokenBalanceBaseUnits(sweepMint),
        readNative: () => live.splTokenBalanceBaseUnits(SOL_MINT),
        confirmLog: `On-chain ${side} confirmed (Jupiter): ${sig.slice(0, 18)}…`,
      })
    })
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e)
    log(bot, `LIVE EXECUTION FAILED (${side}): ${error}`, 'warn')
    return { ok: false, error }
  }
}

/** Live execution failed — leave paper state untouched and pause the bot so it
 *  stops trading until the operator investigates (no phantom fills, no retries). */
function haltLive(bot: Bot, side: 'buy' | 'sell', error: string) {
  bot.status = 'paused'
  log(bot, `Paused — live ${side} failed (${error}). Paper state left untouched; resume to retry.`, 'warn')
  notifyAsync('bot-halted', `${bot.name} paused — live ${side} failed: ${error}`)
}

/** Remove an in-flight live-buy journal entry by reference. [P1-7] */
function dropPendingBuy(p: NonNullable<State['pendingBuys']>[number]): void {
  const i = state.pendingBuys?.indexOf(p) ?? -1
  if (i >= 0) state.pendingBuys!.splice(i, 1)
}

/** Boot recovery for in-flight live buys (the journal). An entry here means we crashed
 *  between broadcasting a live buy and booking it. We can't know without a chain read whether
 *  it landed, so book the intended spend CONSERVATIVELY (over-counting the daily/lifetime cap
 *  is the safe error — it only restricts FUTURE spend) so a confirmed-but-unflushed buy can't
 *  undercount the cap, and flag the bot's position untrusted so the live-arm reconcile
 *  re-derives it from chain. Bots are separately boot-disarmed, so none auto-re-buys. [P1-7] */
export function reconcilePendingBuys(): number {
  const pend = state.pendingBuys ?? []
  if (!pend.length) return 0
  const today = dayKey()
  for (const p of pend) {
    state.liveSpend = recordDailySpend(state.liveSpend, p.usd, today)
    state.breaker.spentUsd += p.usd
    const bot = state.bots.find((b) => b.id === p.botId)
    if (bot) bot.state.realHeldUntrusted = true
    console.warn(`[engine] reconciled in-flight live buy after restart — bot ${p.botId} ${p.token} $${p.usd}: spend booked conservatively, position flagged for reconcile`)
  }
  const n = pend.length
  state.pendingBuys = []
  tripBreakerIfNeeded()
  flushNow()
  return n
}

// ── Daily live-spend cap ─────────────────────────────────────────────────────
// A safety bound on how much the bot may SPEND on live buys per day. Turnkey
// Policies are stateless per-signature, so a cumulative daily cap is enforced
// here in the engine (and complements Turnkey's per-tx caps). 0 = no cap.
export const maxLiveUsdPerDay = (): number => Math.max(0, Number(process.env.MAX_LIVE_USD_PER_DAY) || 0)

// checkDailyCap / recordDailySpend / DailyCap — pure, in ./safety-math.js (re-exported above).

/** USD spent on live buys so far today (0 once the day rolls over). */
export const spentTodayUsd = (): number => (state.liveSpend.day === dayKey() ? state.liveSpend.usd : 0)

// ── Account circuit breaker ──────────────────────────────────────────────────
// A hard stop that pauses ALL bots when live trading bleeds past a cumulative
// loss or a lifetime-spend ceiling, requiring an explicit manual re-arm (it does
// NOT reset on a day roll like the daily cap). The single most important missing
// guardrail for an unattended live account. Both limits 0 = off.
export const maxCumulativeLossUsd = (): number => Math.max(0, Number(process.env.MAX_CUMULATIVE_LOSS_USD) || 0)
export const maxLiveUsdTotal = (): number => Math.max(0, Number(process.env.MAX_LIVE_USD_TOTAL) || 0)
// Live-fleet trailing-equity drawdown cap (opt-in; 0 = off). Catches UNREALIZED bleed
// the realized-loss breaker misses: trips if the live fleet's mark-to-market value falls
// this % below its high-water mark since the last re-arm. 0 = off (default → no behaviour).
export const maxFleetDrawdownPct = (): number => Math.max(0, Number(process.env.MAX_FLEET_DRAWDOWN_PCT) || 0)
let fleetPeak = 0 // high-water mark of live-fleet equity (resets on resetBreaker)

// ── Exposure caps (sniper sizing + per-token concentration) ───────────────────
// Both opt-in (0 = off) and sized as a % of the lifetime live-spend ceiling
// (MAX_LIVE_USD_TOTAL) — the only well-defined account-size figure the operator sets
// up front — so they're meaningful from the very first bot, unlike a "% of current
// fleet equity" that would block the first bot. [P0-6a, P1-5]
export const maxSnipeEquityPct = (): number => Math.max(0, Number(process.env.MAX_SNIPE_EQUITY_PCT) || 0)
export const maxTokenExposurePct = (): number => Math.max(0, Number(process.env.MAX_TOKEN_EXPOSURE_PCT) || 0)

/** Canonical identity of the token a bot trades: the real contract for snipers
 *  (symbols collide across scam tokens), else network:symbol for curated coins. */
const botTokenKey = (network: string, token: string, tokenAddress?: string): string =>
  `${network}:${(tokenAddress ?? token).toLowerCase()}`

/** USD currently exposed to one token across ALL live on-chain bots sharing the wallet
 *  (open-position value at the current price). The concentration cap (P1-5) is checked
 *  against this + the new buy before any live buy or live-bot create. */
function liveTokenExposureUsd(key: string): number {
  let usd = 0
  for (const b of state.bots) {
    if (b.mode !== 'live') continue
    if (!hasLiveExecutor(networkById(b.network))) continue
    if (botTokenKey(b.network, b.token, b.pool?.tokenAddress) !== key) continue
    const price = priceForBot(b) ?? b.position.avgCostUsd
    usd += b.position.qty * price
  }
  return usd
}

/** Stateful wrapper: would a live buy of `addUsd` into `key` breach the per-token
 *  concentration cap? Returns an error string to skip/reject with, or null. */
const tokenExposureGuard = (key: string, token: string, addUsd: number): string | null =>
  tokenExposureError(addUsd, liveTokenExposureUsd(key), maxLiveUsdTotal(), maxTokenExposurePct(), token)

// evaluateBreaker — pure, in ./safety-math.js (re-exported above).

/** Trip the breaker: pause every active bot, persist. Idempotent. */
function tripBreaker(reason: string): void {
  if (state.breaker.tripped) return
  state.breaker.tripped = true
  state.breaker.reason = reason
  state.breaker.trippedAt = Date.now()
  // Pause ONLY bots that actually trade live on-chain. The breaker is a LIVE-money
  // safety control — it must NOT halt PAPER bots (a separate workspace, zero real
  // risk) or paper-executed market/ICP bots. `breaker.tripped` still blocks every new
  // live buy in settle(), so live exposure is fully frozen regardless of what's paused.
  let paused = 0
  for (const b of state.bots) {
    if (!(b.status === 'running' || b.status === 'scheduled') || b.mode !== 'live') continue
    const net = networkById(b.network)
    if (!hasLiveExecutor(net)) continue
    b.status = 'paused'
    log(b, `⛔ CIRCUIT BREAKER — ${reason}. Live bots paused; reset it from the ⛔ HALTED button to resume.`, 'warn')
    paused++
  }
  console.error(`[engine] ⛔ CIRCUIT BREAKER TRIPPED — ${reason}. ${paused} live bot(s) paused (paper bots unaffected).`)
  notifyAsync('breaker-tripped', `${reason}. ${paused} live bot(s) paused — manual re-arm required.`)
  flushNow()
}

/** Trip the breaker if a cumulative-loss/spend limit is breached. */
function tripBreakerIfNeeded(): void {
  const v = evaluateBreaker(state.breaker, maxCumulativeLossUsd(), maxLiveUsdTotal())
  if (v.tripped) tripBreaker(v.reason)
}

/** The single place live realized P&L reaches the account circuit breaker. Every real
 *  on-chain sell — strategy settle() AND forced/manual stop liquidations — must funnel
 *  its realized delta through here, or a loss realized via a stop escapes the
 *  cumulative-loss ceiling (the most important unattended-account guardrail). */
function accrueLiveRealized(bot: Bot, beforeRealized: number): void {
  state.breaker.realizedUsd += bot.stats.realizedUsd - beforeRealized
  tripBreakerIfNeeded()
}

/** Operator re-arm: clear the breaker and reset its accumulators. */
export function resetBreaker(): State['breaker'] {
  state.breaker = { tripped: false, reason: '', trippedAt: null, realizedUsd: 0, spentUsd: 0 }
  fleetPeak = 0 // re-arm restarts the drawdown high-water mark
  flushNow()
  return state.breaker
}

// evaluateLiveCreate — pure, in ./safety-math.js (re-exported above).

/** A bot born now is real-live (touches funds + the live caps) only in live mode on an
 *  on-chain network — market/ICP/holdings bots stay paper even in the live workspace. */
const bornRealLive = (net: { evm?: boolean; id: string } | undefined): boolean =>
  state.settings.mode === 'live' && hasLiveExecutor(net)

/** Wrapper: evaluate the live-create guard against current engine state. */
const liveCreateError = (budget: number, net: { evm?: boolean; id: string } | undefined): string | null =>
  evaluateLiveCreate(budget, bornRealLive(net), state.breaker, maxLiveUsdTotal())

export const breakerState = (): State['breaker'] => state.breaker

/** Opt-in live-fleet trailing-equity drawdown cap. Trips the breaker if the live fleet's
 *  mark-to-market equity falls MAX_FLEET_DRAWDOWN_PCT below its high-water mark. Equity is
 *  swept-profit-AWARE (cash + open position + banked native) so taking profit to native
 *  never reads as drawdown; only real on-chain bots count. Default off (cap ≤ 0). */
function checkFleetDrawdown(): void {
  const capPct = maxFleetDrawdownPct()
  if (capPct <= 0 || !hasLiveBots() || state.breaker.tripped) return
  let equity = 0
  let liveBots = 0
  for (const b of state.bots) {
    const net = networkById(b.network)
    if (b.mode !== 'live' || !hasLiveExecutor(net)) continue // LIVE on-chain bots only
    // Count ALL live on-chain bots, including STOPPED ones — a stopped bot's banked value
    // is still the fleet's, so excluding it would drop equity and spuriously trip on a
    // mere stop. Status changes must not move equity; only DELETION re-baselines the peak.
    const price = priceForBot(b) ?? b.position.avgCostUsd
    equity += b.cashUsd + b.position.qty * price + b.stats.nativeTakenUsd // cash + open position + banked profit
    liveBots++
  }
  if (liveBots === 0 || equity <= 0) return
  if (equity > fleetPeak) fleetPeak = equity
  const ddPct = ((fleetPeak - equity) / fleetPeak) * 100
  if (ddPct >= capPct) tripBreaker(`live fleet drawdown ${ddPct.toFixed(1)}% hit the ${capPct}% cap`)
}

// ── Profit vault & withdrawals ───────────────────────────────────────────────
// Profit vault + withdrawals (creditVault / vaultBalance / profitVault /
// listWithdrawals / requestWithdrawal) moved to ./vault.js — imported &
// re-exported above. No engine-internal back-deps, so no import cycle.

// USD of live buys that have passed the cap gate this tick but whose swap is still
// in flight (not yet folded into liveSpend / breaker.spentUsd). Counted inside the
// gate so concurrent same-tick buys can't all slip through a check-then-act window
// and overshoot the hard ceiling — tick() fires every bot concurrently and each
// yields at `await mirrorLive`. Transient (not persisted); released in a finally.
let reservedLiveUsd = 0

// freshCopySignal / copyRefreshSignal — pure copy-bot signal gates, in
// ./safety-math.js (re-exported above).

/**
 * Apply a strategy decision. In paper mode this is a synchronous paper fill. In
 * LIVE mode the on-chain swap runs FIRST and the paper fill is committed only on
 * confirmed success — a failed swap pauses the bot and never advances paper
 * state, so the simulated ledger can't drift away from the wallet's reality.
 */
async function settle(bot: Bot, a: Action | null, price: number): Promise<void> {
  const liveMode = bot.mode === 'live' // each bot executes in its OWN workspace
  // A bot only touches REAL funds (and the live caps/breaker) when it's on an
  // on-chain network in live mode. Market/ICP bots stay paper even in live mode, so
  // they must NOT consume the daily cap / lifetime ceiling or accrue into the
  // circuit breaker — a purely simulated loss must never pause real bots. [INC-1]
  const net = networkById(bot.network)
  const realLive = liveMode && hasLiveExecutor(net)
  let realQty: number | undefined // the measured on-chain fill (live only), threaded into the commit
  let realProceedsUsd: number | undefined // measured native/USDT received on a live sell [MP-1]
  if (a?.type === 'buy' && a.usd > 1 && bot.cashUsd >= a.usd * 0.999) {
    const usd = Math.min(a.usd, bot.cashUsd) // size the swap to the same amount the paper fill uses
    if (realLive) {
      // Circuit breaker: if tripped, do not open new exposure (bots are paused on
      // trip, but guard here too in case one slips through a tick).
      if (state.breaker.tripped) {
        log(bot, `Live buy blocked — circuit breaker tripped (${state.breaker.reason}). Reset the breaker to resume.`, 'warn')
        return
      }
      // ── Atomic cap gate ───────────────────────────────────────────────────
      // The checks AND the reservation below are SYNCHRONOUS (no await between),
      // and `reservedLiveUsd` accounts for buys already in flight this tick — so
      // concurrent buys can't all pass the check before any of them increments
      // the accumulator and overshoot the ceiling.
      const today = dayKey()
      const pendingSpent = state.breaker.spentUsd + reservedLiveUsd
      // Lifetime live-spend ceiling — trip the breaker (pause all) rather than skip.
      const totalCap = maxLiveUsdTotal()
      if (totalCap > 0 && pendingSpent + usd > totalCap) {
        tripBreaker(`a $${usd.toFixed(0)} live buy would exceed the $${totalCap} total live-spend safety limit ($${pendingSpent.toFixed(0)} of $${totalCap} already used). Lower the bot's budget or raise MAX_LIVE_USD_TOTAL`)
        return
      }
      // Daily spend cap: skip (don't pause) so the bot resumes once the day rolls.
      const spentToday = state.liveSpend.day === today ? state.liveSpend.usd : 0
      const cap = checkDailyCap({ day: today, usd: spentToday + reservedLiveUsd }, usd, maxLiveUsdPerDay(), today)
      if (!cap.allowed) {
        log(bot, `Live buy skipped — ${cap.reason}`, 'warn')
        return
      }
      // Per-token concentration cap (opt-in): don't let the fleet pile too much of the
      // account into one token. Skip (don't pause) so other tokens keep trading. [P1-5]
      const concErr = tokenExposureGuard(botTokenKey(bot.network, bot.token, bot.pool?.tokenAddress), bot.token, usd)
      if (concErr) {
        log(bot, `Live buy skipped — ${concErr}`, 'warn')
        return
      }
      reservedLiveUsd += usd // reserve BEFORE the first await; released in finally
      // Journal the in-flight buy (durably) BEFORE the swap: if we crash after the on-chain
      // fill confirms but before the spend is booked, boot reconciles this entry rather than
      // silently losing a real spend. Removed in the SAME persist as the booked spend below. [P1-7]
      const pending = { botId: bot.id, network: bot.network, token: bot.token, usd, ts: Date.now() }
      ;(state.pendingBuys ??= []).push(pending)
      flushNow()
      try {
        const r = await mirrorLive(bot, 'buy', usd, 0, price)
        if (!r.ok) { dropPendingBuy(pending); flushNow(); return haltLive(bot, 'buy', r.error) } // no fill → clear the journal
        if (r.delta && r.delta.baseUnits > 0n) {
          realQty = Number(r.delta.baseUnits) / 10 ** r.delta.decimals // ACTUAL tokens received
        } else if (r.delta) {
          // Swap CONFIRMED but the on-chain delta was unmeasurable (0/ambiguous — e.g.
          // an external transfer straddled the balance read). Don't under-book to zero:
          // commit the quote estimate but flag the position untrusted so sells clamp to
          // the real wallet balance rather than a phantom number.
          bot.state.realHeldUntrusted = true
          log(bot, 'Live buy confirmed but on-chain fill unmeasurable — position is an estimate (flagged for reconcile).', 'warn')
          notifyAsync('ledger-untrusted', `${bot.name}: live buy confirmed but on-chain fill unmeasurable — position flagged for reconcile`)
        }
        // Book the REAL native outflow (input + gas) when mirrorLive measured it, else the
        // intended USD. The cap/breaker then track the wallet, not the cached quote. [P1-2]
        const spent = r.delta?.nativeSpentUsd ?? usd
        state.liveSpend = recordDailySpend(state.liveSpend, spent, today) // count the confirmed spend
        state.breaker.spentUsd += spent
        tripBreakerIfNeeded()
        dropPendingBuy(pending) // clear the journal in the SAME persist as the booked spend → boot can't double-count [P1-7]
        // Persist the spend accounting the INSTANT it's booked (atomic write). The
        // live-spend cap is safety-critical and — unlike a position, which boot
        // reconciles from the chain — can't be rebuilt, so it must be durable before
        // anything else runs. Closes the crash window between booking and the
        // end-of-settle flush: a SIGKILL after this can never under-count the cap.
        flushNow()
      } finally {
        reservedLiveUsd -= usd // release the reservation whether or not it committed
      }
    }
    execBuy(bot, price, usd, a.reason, realQty)
    if (realLive) flushNow() // persist the real fill immediately
  } else if (a?.type === 'sell' && bot.position.qty > 0) {
    const qty = bot.position.qty * Math.min(1, a.fraction)
    if (realLive) {
      const r = await mirrorLive(bot, 'sell', qty * price, qty, price, (a.exit ?? false) && a.fraction >= 1)
      if (!r.ok) return haltLive(bot, 'sell', r.error) // on-chain failed → keep the paper position
      if (r.delta && r.delta.baseUnits > 0n) {
        realQty = Number(r.delta.baseUnits) / 10 ** r.delta.decimals // ACTUAL units sold
        realProceedsUsd = r.delta.proceedsUsd // measured proceeds PAIRED with the measured qty [MP-1]
      } else if (r.delta) {
        // Confirmed but the token-delta is unmeasurable (an external transfer straddled the
        // after-read): book the paper fraction at MODELED proceeds. Pairing measured proceeds
        // with an unknown sold-qty (→ paper-fraction cost basis) would mis-state P&L. [reconcile]
        bot.state.realHeldUntrusted = true
      }
    }
    const beforeRealized = bot.stats.realizedUsd
    execSell(bot, price, a.fraction, a.reason, a.exit ?? false, false, realQty, realProceedsUsd)
    if (realLive) {
      accrueLiveRealized(bot, beforeRealized) // single source of breaker accrual
      flushNow()
    }
    // Latch a force-exit if an EXIT only partially filled (live clamp left a residual);
    // clear it once flat. tickBot re-attempts the remainder every tick. [EXIT-2]
    if (a.exit ?? false) {
      if (bot.position.qty > 0) bot.state.forceExit = true
      else delete bot.state.forceExit
    }
  }
}

// A LIVE copy bot's only exit is the whale's on-chain sell, which we detect on a ~60s-cached
// signal + 20s tick — a real lag during a rug. So live copies get a WIDE catastrophic stop-loss by
// default: wide enough not to clip a normal whale swing, tight enough to bound a -100% event. Paper
// copies stay pure mirror. The take-profit always stays off (mirroring the upside is the point).
export const LIVE_COPY_STOP_PCT = 40

/** Per-tick params for a copy bot. Copy trading MIRRORS the wallet: it exits when the wallet sells
 *  — NOT at a tier take-profit, which would cap a whale's run. Take-profit is off unless the user
 *  opts in; stop-loss is off for PAPER (pure mirror) but defaults to a catastrophic backstop for
 *  LIVE money (overridable). perTradeUsd overrides entry size. */
export function copyParams(base: RiskParams, copy: NonNullable<Bot['copy']>, mode: Bot['mode'] = 'paper'): RiskParams {
  return {
    ...base,
    stopLossPct: copy.stopLossPct ?? (mode === 'live' ? LIVE_COPY_STOP_PCT : Infinity),
    takeProfitPct: copy.takeProfitPct ?? Infinity,
    ...(copy.perTradeUsd != null && { perTradeUsd: copy.perTradeUsd }),
  }
}

/** Candle-free protective exit: a catastrophic stop-loss / hard take-profit evaluated on
 *  the live SPOT price + cost basis alone. Runs when candle history is unavailable (a
 *  CoinGecko outage/rate-limit) so a held position's stop-loss is never silently suspended
 *  while the indicator path is gated out. Returns a sell Action, or null. [P2-5] */
function slTpFallback(bot: Bot, price: number, params: RiskParams): Action | null {
  if (bot.position.qty <= 0 || !(bot.position.avgCostUsd > 0)) return null
  const chg = ((price - bot.position.avgCostUsd) / bot.position.avgCostUsd) * 100
  if (chg <= -params.stopLossPct) return { type: 'sell', fraction: 1, reason: `Stop-loss ${chg.toFixed(2)}% — protective exit (candle data unavailable)`, exit: true }
  if (chg >= params.takeProfitPct) return { type: 'sell', fraction: 1, reason: `Take-profit +${chg.toFixed(2)}% — (candle data unavailable)`, exit: true }
  return null
}

async function tickBot(bot: Bot) {
  if (bot.status === 'stopped' || bot.status === 'paused') return
  const scheduled = !inSchedule(bot)
  const newStatus = scheduled ? 'scheduled' : 'running'
  if (bot.status !== newStatus) {
    bot.status = newStatus
    log(bot, scheduled ? 'Outside trading window — sleeping' : 'Trading window open — resuming')
  }
  // Outside the window we never OPEN new exposure — but a held position must keep
  // being MANAGED: stop-loss / take-profit / trailing / max-hold all live inside
  // decide(). Sleeping here while holding would silently suspend the stop-loss
  // across the off-window gap. So sleep only when flat. [EXIT-1]
  if (scheduled && bot.position.qty === 0) return

  const strat = strategyById(bot.strategy)
  let params = RISK[bot.risk]
  if (!strat || !params) return
  // Copy bots MIRROR the wallet — so they use copy-scoped params (no tier take-profit cap; SL/TP
  // are opt-in safety nets only). [copy-mirror]
  if (bot.copy) params = copyParams(params, bot.copy, bot.mode)

  const price = priceForBot(bot)
  if (!price) {
    // A SNIPER holding a position whose pool price has gone STALE may be mid-rug — don't
    // just skip the tick (riding an unpriced position); attempt an immediate protective exit
    // at the last-known pool price. In live mode the on-chain sell executes regardless of our
    // cached price; in paper it books at the last known. [P1-9]
    if (bot.sniper && bot.position.qty > 0) {
      const net = networkById(bot.network)
      const last = net && bot.pool ? poolPrice(net.gt, bot.pool.poolAddress) : undefined
      if (last && last > 0) {
        await settle(bot, { type: 'sell', fraction: 1, reason: 'Pool price stale — protective exit', exit: true }, last)
        bot.lastTickAt = Date.now()
      }
    }
    return
  }

  // Sniper bots are priced from their pool and need no candle history; all
  // other strategies need 30d of hourly closes for their indicators.
  let closes: number[]
  if (bot.sniper) {
    bot.state.snipe = bot.sniper // seed config for the strategy each tick
    closes = [price]
  } else {
    const cg = bot.cg ?? tokenOf(bot.network, bot.token)?.cg
    if (!cg) return
    const candles = await getCandles(cg, 30)
    if (candles.length < 30) {
      // Candle data unavailable (provider outage / rate-limit). Don't open new exposure —
      // indicators can't be computed — but a HELD position must still be protected, so run
      // a candle-free SL/TP against the live spot price rather than silently suspending the
      // stop-loss until data returns. [P2-5]
      const sltp = slTpFallback(bot, price, params)
      if (sltp) { await settle(bot, sltp, price); bot.lastTickAt = Date.now() }
      return
    }
    // Closed-bar ENTRY gate: when flat, only consider a NEW entry once per closed hourly bar
    // — not on every 20s intra-bar print, which re-runs hourly-calibrated indicators against a
    // noisy/stale spot and inflates trade count & cost vs the backtest. Exits/position
    // management still run every tick (the gate is skipped while holding). Snipers are exempt
    // (pool-priced; they need instant entry + fast exits). [P2-6]
    if (bot.position.qty === 0) {
      const barT = candles[candles.length - 1].t
      if (bot.state.lastBarT === barT) return // already evaluated an entry for this bar
      bot.state.lastBarT = barT
    }
    closes = candles.map((c) => c.c)
    closes.push(price)
    // AI bots act on a shared, periodically-refreshed Gemini signal (non-blocking).
    if (bot.ai) {
      const sig = getAiSignal(bot.network, bot.token, closes)
      if (sig) bot.state.aiSignal = sig
    }
  }

  const ctx: Ctx = {
    price, closes, params,
    state: bot.state,
    position: bot.position,
    budgetUsd: bot.budgetUsd,
    cashUsd: bot.cashUsd,
    now: Date.now(),
  }
  const a = strat.decide(ctx)
  // Out-of-window: let exit/sell actions through to protect the position, but never
  // open new exposure. [EXIT-1]
  let action = scheduled && a?.type === 'buy' ? null : a
  // A residual left by a prior clamped live exit must be force-sold every tick
  // (regardless of strategy signal or window) until the position is flat. [EXIT-2]
  if (bot.state.forceExit && bot.position.qty > 0)
    action = { type: 'sell' as const, fraction: 1, reason: 'Force-exit unsold residual', exit: true }
  bot.lastTickAt = Date.now()
  await settle(bot, action, price)

  // A sniper that has fired and exited is finished — retire it cleanly.
  if (bot.sniper && bot.state.sniped && bot.position.qty === 0) {
    bot.status = 'stopped'
    log(bot, 'Snipe complete — position closed, bot retired', 'info')
  }

  // An auto-follow mirror that completed its round trip retires too — the
  // follow pool reclaims its cash and stays free for the wallet's next buy.
  if (bot.followId && bot.state.lastExitAt && bot.position.qty === 0 && bot.stats.wins + bot.stats.losses > 0) {
    bot.status = 'stopped'
    log(bot, 'Mirror round trip complete — bot retired, cash returns to the follow pool', 'info')
  }

  // Equity sample roughly once a minute.
  const last = bot.equityHistory[bot.equityHistory.length - 1]
  if (!last || Date.now() - last.t > 60_000) {
    const unreal = bot.position.qty * (price - bot.position.avgCostUsd)
    bot.equityHistory.push({ t: Date.now(), v: +(bot.stats.realizedUsd + unreal).toFixed(2) })
    if (bot.equityHistory.length > 240) bot.equityHistory.splice(0, bot.equityHistory.length - 240)
  }
}

/**
 * Reconcile per-bot realHeld against the real wallet — on startup and after a
 * paper→live transition. The persisted counter can be stale-low (a crash before
 * flush, or buys made during a paper window) or stale-high (a manual-stop
 * liquidation that bypassed the in-lane debit), so it is re-derived from chain
 * rather than trusted. A single-holder bot is re-seeded to the real aggregate
 * (the whole balance is its own); multi-holder groups can't be split
 * deterministically, so each is flagged untrusted and its sell clamp degrades to
 * the wallet-have guard. No-op in paper mode or without live keys.
 */
export async function reconcileRealHeld(): Promise<void> {
  if (!hasLiveBots()) return
  const groups = new Map<string, { bots: Bot[]; read: () => Promise<bigint> }>()
  for (const bot of state.bots) {
    if (bot.status === 'stopped' || bot.cg || bot.mode !== 'live') continue // only LIVE bots hold real on-chain balances
    const net = networkById(bot.network)
    if (!net) continue
    const tokenAddress = bot.pool?.tokenAddress ?? tokenOf(bot.network, bot.token)?.address
    if (!tokenAddress) continue
    let key: string
    let read: () => Promise<bigint>
    if (net.evm) {
      if (!live.liveReady()) continue
      key = `evm:${net.chainId}:${tokenAddress.toLowerCase()}`
      read = () => live.tokenBalanceBaseUnits(net.chainId, tokenAddress)
    } else if (net.id === 'solana') {
      if (!live.solanaLiveReady()) continue
      key = `solana:${tokenAddress}`
      read = () => live.splTokenBalanceBaseUnits(tokenAddress)
    } else {
      continue
    }
    const g = groups.get(key) ?? { bots: [], read }
    g.bots.push(bot)
    groups.set(key, g)
  }
  let changed = false
  for (const g of groups.values()) {
    try {
      if (g.bots.length === 1) {
        const have = await g.read()
        const b = g.bots[0]
        if (b.state.realHeldUntrusted) changed = true // clearing the flag must persist
        b.state.realHeldUntrusted = false
        const next = have.toString()
        if (b.realHeld !== next) {
          b.realHeld = next
          changed = true
          log(b, `realHeld reconciled from chain: ${next} base units`, 'info')
        }
      } else {
        // Can't split a shared balance deterministically — degrade these bots'
        // clamp to the wallet-have guard (still no over-send).
        for (const b of g.bots) {
          if (!b.state.realHeldUntrusted) changed = true
          b.state.realHeldUntrusted = true
        }
      }
    } catch {
      // RPC unavailable — leave realHeld as persisted; the wallet-have clamp
      // still prevents over-sends until the next reconcile succeeds.
    }
  }
  if (changed) flushNow()
}

export function serializeBot(bot: Bot) {
  const price = priceForBot(bot) ?? 0
  const unrealizedUsd = bot.position.qty > 0 && price > 0 ? bot.position.qty * (price - bot.position.avgCostUsd) : 0
  return {
    ...bot,
    // realHeld is the live wallet's REAL on-chain composition — never broadcast
    // it to every open socket. It stays server-side only.
    realHeld: undefined,
    priceUsd: price,
    unrealizedUsd: +unrealizedUsd.toFixed(4),
    totalPnlUsd: +(bot.stats.realizedUsd + unrealizedUsd).toFixed(4),
    positionValueUsd: +(bot.position.qty * price).toFixed(2),
  }
}

// One shared mutex for the main tick AND the fast sniper poll, so they never overlap and
// can't double-settle the same bot (single-threaded checks: the flag is read/set
// synchronously at entry, before any await). [P1-9 / P1-14]
let engineBusy = false
let draining = false // set by stopEngine() so no new tick or scan starts during shutdown
let lastGlobalTickAt = 0 // completion time of the last SUCCESSFUL tick — the dead-man heartbeat [P1-14]
async function tick() {
  if (engineBusy || draining) return // never overlap ticks; never start a new one while draining
  engineBusy = true
  try {
    // Static universe + any CoinGecko ids carried by market bots + the
    // mainnet majors used to value smart-money wallet holdings.
    const priceIds = new Set(allPriceIds())
    for (const b of state.bots) if (b.cg && b.status !== 'stopped') priceIds.add(b.cg)
    if (smartMoneyReady()) for (const id of MAINNET_CG_IDS) priceIds.add(id)
    await getSpotPrices([...priceIds])
    // Refresh DEX pool prices for any active sniper bots (deduped by pool).
    const pools = new Map<string, { gt: string; addr: string }>()
    for (const b of state.bots) {
      if (b.pool && (b.status === 'running' || b.status === 'scheduled')) {
        const net = networkById(b.network)
        if (net) pools.set(`${net.gt}:${b.pool.poolAddress}`, { gt: net.gt, addr: b.pool.poolAddress })
      }
    }
    await Promise.all([...pools.values()].map((p) => refreshPoolPrice(p.gt, p.addr)))
    // Refresh smart-money signals for copy-trade bots (cached 60s upstream).
    await Promise.all(
      state.bots
        .filter((b) => b.copy && (b.status === 'running' || b.status === 'scheduled'))
        .map((b) =>
          walletCopySignal(b.network, b.copy!.walletAddress, b.token)
            .then(({ latest, latestSell }) => {
              // copyRefreshSignal prioritises a SELL exit (so a holding mirror still exits
              // after a newer inbound transfer) but ONLY for a sell newer than this bot's
              // current entry — never resurfacing a pre-re-buy sell. freshCopySignal then
              // drops any pre-creation signal (SM-1); the originating follow buy is seeded
              // at creation, which intentionally bypasses that filter.
              const seed = freshCopySignal(copyRefreshSignal(b, latest, latestSell), b.createdAt)
              if (seed) b.state.copySignal = seed
            })
            .catch(() => {}),
        ),
    )
    await Promise.all(state.bots.map((b) => tickBot(b).catch((e) => console.error(`[engine] bot ${b.name}:`, e))))
    checkFleetDrawdown() // opt-in live-fleet trailing-equity drawdown cap (no-op unless MAX_FLEET_DRAWDOWN_PCT set)
    await autoScan().catch((e) => console.error('[engine] auto-sniper scan failed', e))
    await followScan().catch((e) => console.error('[engine] follow scan failed', e))
    resolveTournaments()
    save()
    const prices: Record<string, number> = {}
    for (const id of allPriceIds()) {
      const p = spot(id)
      if (p) prices[id] = p
    }
    broadcast({
      type: 'snapshot', ts: Date.now(), bots: state.bots.map(serializeBot), prices,
      monthly: state.monthly,
      // The active workspace + live circuit-breaker state, so the web always reflects the
      // SERVER (meta/init is boot-only and can go stale — e.g. a cached /api/state or a
      // second tab — leaving the mode toggle/wizard showing the wrong workspace). [realtime]
      mode: state.settings.mode,
      breaker: state.breaker,
      autoSniper: state.autoSniper ? serializeAutoSniper(state.autoSniper) : null,
      tournaments: state.tournaments.map(serializeTournament),
      follows: state.follows.map(serializeFollow),
      smartMoney: { tracking: smartMoneyReady() },
    })
    lastGlobalTickAt = Date.now() // a full tick completed — heartbeat for /health + the stall watchdog
  } catch (e) {
    console.error('[engine] tick failed', e)
  } finally {
    engineBusy = false
  }
}

// Fast SNIPER poll: snipers trade the most volatile, rug-prone tokens, where a 20s tick is
// far too slow to catch a collapse. This refreshes ONLY active sniper pools and re-evaluates
// ONLY sniper bots, every few seconds, so SL/TP/trailing react in ~SNIPER_POLL_MS instead of
// the global cadence. Shares engineBusy with tick() so the two never run concurrently. [P1-9]
async function sniperPoll() {
  if (engineBusy || draining) return
  const snipers = state.bots.filter((b) => b.pool && (b.status === 'running' || b.status === 'scheduled'))
  if (!snipers.length) return
  engineBusy = true
  try {
    const pools = new Map<string, { gt: string; addr: string }>()
    for (const b of snipers) {
      const net = networkById(b.network)
      if (net && b.pool) pools.set(`${net.gt}:${b.pool.poolAddress}`, { gt: net.gt, addr: b.pool.poolAddress })
    }
    await Promise.all([...pools.values()].map((p) => refreshPoolPrice(p.gt, p.addr)))
    await Promise.all(snipers.map((b) => tickBot(b).catch((e) => console.error(`[engine] sniper poll ${b.name}:`, e))))
  } catch (e) {
    console.error('[engine] sniper poll failed', e)
  } finally {
    engineBusy = false
  }
}

/**
 * SAFE BOOT: pause every running/scheduled LIVE on-chain bot + stop a live auto-sniper,
 * so an unattended restart NEVER auto-resumes real on-chain trading. A bot's `mode` is
 * independent of the viewed workspace (a live bot keeps trading while you view paper), so
 * this must catch live bots even when `state.settings.mode` is paper — the global-flag
 * downgrade alone does NOT stop them (the per-bot executor gates on bot.mode). Pausing
 * preserves positions; the operator re-arms (Live button) + resumes consciously. Returns
 * the number of bots paused. Call BEFORE startEngine so no live tick can fire first.
 */
export function disarmLiveBotsForBoot(): number {
  let paused = 0
  for (const b of state.bots) {
    if (b.mode === 'live' && (b.status === 'running' || b.status === 'scheduled') && hasLiveExecutor(networkById(b.network))) {
      b.status = 'paused'
      paused++
    }
  }
  let stoppedAuto = false
  if (state.autoSniper?.enabled && state.autoSniper.workspace === 'live') {
    state.autoSniper.enabled = false // a live auto-sniper must not keep opening live snipes on boot
    stoppedAuto = true
  }
  if (paused || stoppedAuto) save()
  return paused
}

const SNIPER_POLL_MS = 3_000 // fast exit checks for the volatile pools snipers trade [P1-9]
let engineTimer: ReturnType<typeof setInterval> | null = null
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let sniperTimer: ReturnType<typeof setInterval> | null = null
let stallAlerted = false

export function startEngine(b: Broadcast) {
  setBroadcast(b)
  // Re-derive realHeld from the real wallet before the first live tick so a
  // crash-stale or paper-window ledger can't misclamp the first sells. No-op in
  // paper mode; never blocks startup on an RPC failure.
  void reconcileRealHeld()
    .catch((e) => console.error('[engine] realHeld reconcile failed', e))
    .finally(() => void tick())
  engineTimer = setInterval(tick, TICK_MS)
  // Dead-man watchdog: if the tick loop hasn't completed in ~3 cycles, the engine is
  // stalled (a wedged lane, a hung await) — stops/exits aren't firing. Alert once, and
  // again when it recovers. Independent timer so it fires even if tick() itself is stuck. [P1-14]
  watchdogTimer = setInterval(() => {
    if (draining || lastGlobalTickAt === 0) return
    const age = Date.now() - lastGlobalTickAt
    if (age > TICK_MS * 3) {
      if (!stallAlerted) {
        stallAlerted = true
        console.error(`[engine] ⚠ tick STALLED — no completed tick in ${Math.round(age / 1000)}s`)
        notifyAsync('tick-stalled', `engine tick has not completed in ${Math.round(age / 1000)}s — stops/exits may not be firing`)
      }
    } else if (stallAlerted) {
      stallAlerted = false
      notifyAsync('tick-recovered', 'engine tick resumed')
    }
  }, TICK_MS)
  watchdogTimer.unref?.()
  // Fast sniper exit poll (decoupled from the 20s global tick); shares engineBusy with tick(). [P1-9]
  sniperTimer = setInterval(() => void sniperPoll(), SNIPER_POLL_MS)
  sniperTimer.unref?.()
  console.log(`[engine] running — ${state.bots.length} bot(s) loaded, tick every ${TICK_MS / 1000}s, sniper poll ${SNIPER_POLL_MS / 1000}s`)
}

/** Graceful drain for shutdown: stop scheduling ticks, then await any in-flight swap/
 *  withdrawal lane so a broadcast on-chain tx finishes (bounded by `timeoutMs`) before the
 *  process exits — never abandon a confirmed-but-unbooked buy. Safe to call more than once. [P1-12] */
export async function stopEngine(timeoutMs = 25_000): Promise<void> {
  draining = true
  if (engineTimer) { clearInterval(engineTimer); engineTimer = null }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  if (sniperTimer) { clearInterval(sniperTimer); sniperTimer = null }
  await Promise.race([drainLanes(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.())])
}

/** Operational snapshot for GET /health — a dead-man check (tick age), live-money state
 *  (mode, spend vs cap, breaker), bot counts, provider heartbeats and ledger status. [P1-14] */
export function engineHealth() {
  const now = Date.now()
  let running = 0, paused = 0, scheduled = 0, stopped = 0, live = 0
  for (const b of state.bots) {
    if (b.status === 'running') running++
    else if (b.status === 'paused') paused++
    else if (b.status === 'scheduled') scheduled++
    else if (b.status === 'stopped') stopped++
    if (b.mode === 'live' && hasLiveExecutor(networkById(b.network))) live++
  }
  const tickAgeMs = lastGlobalTickAt ? now - lastGlobalTickAt : -1
  const stalled = tickAgeMs < 0 || tickAgeMs > TICK_MS * 3
  return {
    status: state.breaker.tripped ? 'breaker-tripped' : stalled ? 'degraded' : 'ok',
    mode: state.settings.mode,
    tickAgeMs,
    lastTickAt: lastGlobalTickAt || null,
    bots: { total: state.bots.length, running, paused, scheduled, stopped, live },
    live: { spentTodayUsd: spentTodayUsd(), maxUsdPerDay: maxLiveUsdPerDay(), breaker: state.breaker },
    providers: providerHealth(now),
    tradeDbReady: tradeDbReady(),
    alerting: alertConfigured(),
  }
}

// ── Bot lifecycle ────────────────────────────────────────────────────────────

export function createBot(input: {
  name?: string
  network: string
  token: string
  strategy: string
  risk: Bot['risk']
  budgetUsd: number
  schedule?: Bot['schedule']
  copy?: Bot['copy']
  ai?: boolean
  tournamentId?: string
  followId?: string
  cg?: string // ⇒ "market" bot: any CoinGecko coin, paper-traded
  sweepTo?: Bot['sweepTo']
}): Bot | { error: string } {
  const isMarket = Boolean(input.cg)
  const net = networkById(isMarket ? 'market' : input.network)
  const token = net && (isMarket ? { symbol: String(input.token || '').toUpperCase() } : tokenOf(input.network, input.token))
  if (!net || !token) return { error: 'unknown network/token' }
  if (!isMarket && net.tradeable === false) return { error: `${net.name} is holdings-only — trading isn't available there (gas makes the bots uneconomical). It still shows in your wallet view.` }
  if (isMarket && (!token.symbol || !/^[a-z0-9-]{2,80}$/.test(String(input.cg))))
    return { error: 'market bots need a token symbol and a valid CoinGecko id' }
  if (!strategyById(input.strategy)) return { error: 'unknown strategy' }
  if (!RISK[input.risk]) return { error: 'unknown risk tier' }
  if (input.sweepTo !== undefined && input.sweepTo !== 'native' && input.sweepTo !== 'usdt')
    return { error: "sweepTo must be 'native' or 'usdt'" }
  const budget = Number(input.budgetUsd)
  if (!Number.isFinite(budget) || budget < 10) return { error: 'budget must be at least $10' }
  const liveErr = liveCreateError(budget, net)
  if (liveErr) return { error: liveErr }
  // Per-token concentration cap (opt-in) for live bots sharing the wallet. [P1-5]
  if (bornRealLive(net)) {
    const concErr = tokenExposureGuard(botTokenKey(net.id, token.symbol, (token as { address?: string }).address), token.symbol, budget)
    if (concErr) return { error: concErr }
  }
  // Smart DCA splits the budget into fixed slices; if each would be $1 or less the
  // engine drops them as dust and the bot ticks forever without ever trading. Reject
  // upfront with a usable minimum instead of shipping a bot that looks broken.
  if (input.strategy === 'dca') {
    const slices = RISK[input.risk]?.dcaSlices ?? 1
    if (budget / slices <= 1) return { error: `Smart DCA needs a bigger budget — each of its ${slices} slices would be $1 or less (dust). Use at least $${slices + 1}.` }
  }
  // Minimum-economic-trade guard: each trade must clear the round-trip cost (gas in + out +
  // the first-sell approval) by a wide margin (≥20×), or fees alone bleed the bot. Paper
  // market bots (no real gas) are exempt. [P2-7]
  if (!isMarket && net.avgGasUsd > 0) {
    const roundTripGas = 2.5 * net.avgGasUsd
    const perTrade =
      input.strategy === 'dca' ? budget / (RISK[input.risk].dcaSlices ?? 1)
      : input.copy?.perTradeUsd != null ? input.copy.perTradeUsd // copy bot with a fixed per-entry size
      : (budget * RISK[input.risk].positionPct) / 100
    if (perTrade < 20 * roundTripGas)
      return { error: `Each trade (~$${perTrade.toFixed(2)}) is too small to beat ~$${roundTripGas.toFixed(2)} round-trip gas on ${net.name} — raise the budget so trades clear ~$${(20 * roundTripGas).toFixed(0)}.` }
  }
  const sched = input.schedule
  if (sched?.enabled) {
    if (!Array.isArray(sched.days) || sched.days.length === 0 || sched.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
      return { error: 'schedule needs at least one valid day (0–6)' }
    if (!Number.isInteger(sched.startHour) || !Number.isInteger(sched.endHour) || sched.startHour < 0 || sched.startHour > 23 || sched.endHour < 0 || sched.endHour > 24 || sched.startHour === sched.endHour)
      return { error: 'schedule hours invalid' }
  }

  const bot: Bot = {
    id: uid(),
    name: input.name?.trim() || `${token.symbol} ${strategyById(input.strategy)!.name} · ${RISK[input.risk].label}`,
    network: net.id,
    token: token.symbol,
    strategy: input.strategy,
    risk: input.risk,
    budgetUsd: budget,
    cashUsd: budget,
    status: 'running',
    schedule: sched ?? { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
    copy: input.copy,
    ai: input.ai || undefined,
    tournamentId: input.tournamentId,
    followId: input.followId,
    cg: input.cg || undefined,
    sweepTo: input.sweepTo === 'usdt' ? 'usdt' : undefined,
    mode: state.settings.mode, // born into the active workspace; runs there for life
    position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null },
    state: {},
    stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 },
    equityHistory: [],
    log: [],
    createdAt: Date.now(),
    lastTickAt: 0,
  }
  log(bot, `Bot launched — $${budget} budget, ${RISK[input.risk].label} risk, ${bot.mode} mode`)
  state.bots.push(bot)
  if (bot.mode === 'live') flushNow() // a just-armed live bot must survive a crash immediately [P2-4]
  else save()
  return bot
}

/**
 * Create a one-shot sniper bot for a freshly discovered pool. The token is
 * risk-screened first and the snipe is REFUSED if the screen marks it
 * non-tradeable (honeypot, non-sellable, rug setup, etc.) — there is no
 * override. Pricing comes from the DEX pool, not CoinGecko.
 */
export async function createSniper(input: {
  network: string
  poolAddress: string
  tokenAddress: string
  tokenSymbol: string
  tokenName?: string
  decimals?: number
  budgetUsd: number
  sniper: SniperConfig
  auto?: boolean
  sweepTo?: Bot['sweepTo']
  mode?: 'paper' | 'live' // pin the workspace (the auto-sniper passes its own); default = active
  liquidityUsd?: number // pool reserve; the auto-sniper passes discovery's value, the manual path fetches it
}): Promise<(Bot & { riskReport: unknown }) | { error: string; riskReport?: unknown }> {
  const net = networkById(input.network)
  if (!net) return { error: 'unknown network' }
  // Holdings-only chains (e.g. Ethereum mainnet) are never tradeable — block the
  // snipe at the creation function, not just the UI/discovery layer. [R1 guard]
  if (net.tradeable === false) return { error: `${net.name} is holdings-only — sniping isn't available there` }
  if (!EVM_ADDR.test(input.tokenAddress)) return { error: 'invalid token address' }
  // Pool identifier: 40-hex for Uniswap v2/v3 (and most DEXes) OR 64-hex for a
  // Uniswap v4 bytes32 pool ID (v4 is a singleton, no per-pool contract). It's
  // only used for GeckoTerminal pricing — live execution routes by token via 0x —
  // so both formats are valid; rejecting v4 IDs was blocking real screened pools.
  if (!/^0x[a-fA-F0-9]{40}$|^0x[a-fA-F0-9]{64}$/.test(input.poolAddress)) return { error: 'invalid pool address' }
  const budget = Number(input.budgetUsd)
  if (!Number.isFinite(budget) || budget < 10) return { error: 'budget must be at least $10' }
  const s = input.sniper
  if (!(s.takeProfitPct > 0) || !(s.stopLossPct > 0) || !(s.maxHoldMin > 0))
    return { error: 'sniper needs positive take-profit, stop-loss and max-hold' }
  // Pin to the caller's workspace when given (the auto-sniper passes its OWN mode so a
  // live auto-sniper keeps sniping live even while the paper workspace is being viewed);
  // default to the active workspace for a manual snipe. realLive gates the live-money
  // create guard + the daily cap exactly as bornRealLive did, just against the pinned mode.
  const mode = input.mode ?? state.settings.mode
  const realLive = mode === 'live' && hasLiveExecutor(net)
  const liveErr = evaluateLiveCreate(budget, realLive, state.breaker, maxLiveUsdTotal())
  if (liveErr) return { error: liveErr, riskReport: undefined }
  // A sniper buys its FULL position in one go, so a budget over the daily cap can never
  // fill (it'd be skipped every day) — reject upfront rather than ship a stuck bot.
  if (realLive) {
    const dailyCap = maxLiveUsdPerDay()
    if (dailyCap > 0 && budget > dailyCap)
      return { error: `This sniper's $${budget.toFixed(0)} budget exceeds the $${dailyCap} daily live-spend cap (MAX_LIVE_USD_PER_DAY) — it buys its full position at once, so it could never fill. Lower the budget or raise the daily cap.` }
    // Per-snipe stake cap + per-token concentration cap (both opt-in). Bound a single
    // fresh-token bet so one rug can't take the account, and stop the fleet over-
    // concentrating into one token. [P0-6a, P1-5]
    const sizeErr = snipeSizeError(budget, maxLiveUsdTotal(), maxSnipeEquityPct())
    if (sizeErr) return { error: sizeErr }
    const concErr = tokenExposureGuard(botTokenKey(net.id, input.tokenSymbol, input.tokenAddress), input.tokenSymbol, budget)
    if (concErr) return { error: concErr }
  }

  // Pool-liquidity floor (every snipe, manual or auto): never enter a pool too thin to
  // exit, and never size the buy as an outsized fraction of the pool (your own buy would
  // move the price). The auto-sniper passes discovery's liquidity; the manual path fetches
  // it. Unknown liquidity → refuse rather than snipe blind. [P2-9]
  const MIN_POOL_LIQ_USD = 2_000
  const MAX_BUDGET_FRACTION_OF_POOL = 0.015 // ≤1.5% of the pool reserve
  const liqUsd = input.liquidityUsd ?? (await poolLiquidityUsd(net.gt, input.poolAddress))
  if (liqUsd == null) return { error: "couldn't verify this pool's liquidity right now — refusing to snipe blind. Try again shortly." }
  if (liqUsd < MIN_POOL_LIQ_USD) return { error: `Pool liquidity $${liqUsd.toFixed(0)} is below the $${MIN_POOL_LIQ_USD} floor — too thin to snipe safely (you may not be able to exit).` }
  if (budget > liqUsd * MAX_BUDGET_FRACTION_OF_POOL)
    return { error: `$${budget.toFixed(0)} is over ${(MAX_BUDGET_FRACTION_OF_POOL * 100).toFixed(1)}% of the $${liqUsd.toFixed(0)} pool — your own buy would move the price too much. Lower the budget to ≤$${(liqUsd * MAX_BUDGET_FRACTION_OF_POOL).toFixed(0)}.` }

  // Real on-chain token decimals when we can read them (live EVM): a wrong default would
  // mis-size a partial take-profit (e.g. dump the whole bag on a non-18-decimal token).
  // Paper / no-signer: keep the caller's value or 18 (cosmetic without real execution). [P2-15]
  let decimals = input.decimals
  if (decimals == null && net.evm && live.liveReady()) {
    try { decimals = (await live.tokenInfo(net.chainId, input.tokenAddress)).decimals } catch { /* fall back below */ }
  }

  // MANDATORY pre-trade safety screen (STRICT — both providers required, proxy/reclaim
  // blocking): blocks honeypots / non-sellable / rugs / unverified fresh tokens. [P0-6c/d]
  const report = await screenAddress(input.network, input.tokenAddress, input.tokenSymbol, true)
  if (!report.tradeable) {
    return {
      error: `Snipe blocked by safety screen (${report.verdict}): ${report.flags.find((f) => f.severity === 'critical')?.label ?? 'unsafe token'}`,
      riskReport: report,
    }
  }

  const bot: Bot = {
    id: uid(),
    name: `${input.auto ? '🤖' : ''}🎯 ${input.tokenSymbol} snipe`,
    network: net.id,
    token: input.tokenSymbol,
    strategy: 'sniper',
    risk: 'aggressive',
    budgetUsd: budget,
    cashUsd: budget,
    status: 'running',
    schedule: { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
    pool: { poolAddress: input.poolAddress, tokenAddress: input.tokenAddress, decimals: decimals ?? 18 },
    sniper: s,
    auto: input.auto || undefined,
    sweepTo: input.sweepTo === 'usdt' ? 'usdt' : undefined,
    mode, // pinned workspace (auto-sniper's own, or the active one for a manual snipe)
    riskReport: report,
    position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null },
    state: {},
    stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 },
    equityHistory: [],
    log: [],
    createdAt: Date.now(),
    lastTickAt: 0,
  }
  log(bot, `Sniper armed on ${input.tokenSymbol} — $${budget}, TP +${s.takeProfitPct}% / SL −${s.stopLossPct}% / max ${s.maxHoldMin}m. Safety score ${report.score}/100.`)
  state.bots.push(bot)
  if (bot.mode === 'live') flushNow() // a just-armed live snipe + its pool decrement must be durable now [P2-4]
  else save()
  return bot as Bot & { riskReport: unknown }
}

// ── Auto-Sniper ──────────────────────────────────────────────────────────────
// Give it a budget; it scans the safe-only feed, snipes vetted tokens up to
// maxConcurrent at perSnipeUsd each, and recycles returned cash into new
// snipes. Profits accumulate in native via the normal sweep.

const AUTO_SCAN_MS = 90_000
// Default cadence for OPENING a new auto-snipe: one best coin every 2 hours. The
// scanner still discovers pools every AUTO_SCAN_MS; this throttles actual entries.
const AUTO_ENTRY_INTERVAL_MS = 2 * 60 * 60_000
// The autopilot's purpose is to SNIPE — so it only ever enters genuinely new
// launches, never a coin created months/years ago. Default eligibility window is
// 3 days; the user can tighten/loosen it per run (clamped 5min … 1yr) but can't
// turn it off. Enforced via discoverSafePools({ maxAgeMinutes }).
const AUTO_MAX_AGE_MIN = 72 * 60
const AUTO_MAX_AGE_CAP_MIN = 365 * 24 * 60

/** Reclaim cash from finished auto-snipes, then (rate-limited) scan + spawn. */
export async function autoScan(now = Date.now()): Promise<void> {
  const a = state.autoSniper
  if (!a) return

  // Always reclaim finished snipes, even when disabled — money comes home.
  for (const b of state.bots) {
    if (b.auto && b.status === 'stopped' && !b.state.reclaimedByAuto) {
      b.state.reclaimedByAuto = true
      a.poolUsd += b.cashUsd
    }
  }

  if (!a.enabled) return
  if (now - a.lastScanAt < AUTO_SCAN_MS) return
  a.lastScanAt = now

  // Entry cadence: open at most ONE new best snipe per entryIntervalMs (default 2h).
  // Defensive defaults so an auto-sniper persisted before this field still paces itself.
  const interval = a.entryIntervalMs && a.entryIntervalMs > 0 ? a.entryIntervalMs : AUTO_ENTRY_INTERVAL_MS
  if (now - (a.lastEntryAt ?? 0) < interval) return

  const active = state.bots.filter((b) => b.auto && b.status !== 'stopped').length
  if (active >= a.maxConcurrent || a.poolUsd < a.perSnipeUsd) return

  // Snipe the single BEST untried pool this cycle (discoverSafePools returns them
  // ranked best-first); fall through to the next-best only if a spawn errors.
  // Freshness gate: only genuinely NEW launches are eligible — never a months/years-old
  // coin. autoScan is THE defensive layer for the persisted value, so re-clamp it exactly
  // like startAutoSniper does — a value absent (legacy auto-sniper), non-finite, or absurdly
  // large (a hand-edited/corrupt state.json) can never widen or disable the window.
  const rawMaxAge = Number(a.maxAgeMinutes)
  const maxAgeMinutes = rawMaxAge > 0 ? Math.min(rawMaxAge, AUTO_MAX_AGE_CAP_MIN) : AUTO_MAX_AGE_MIN
  // The autopilot ALWAYS snipes the fresh-launch feed: 'trending' surfaces ESTABLISHED
  // coins (often months/years old) that the freshness gate then excludes, so a 'trending'
  // auto-sniper finds nothing. Migrate any legacy 'trending' campaign to 'new' in-place.
  if (a.mode !== 'new') a.mode = 'new'
  const { pools } = await discoverSafePools(a.network, a.mode, now, { minLiquidityUsd: a.minLiquidityUsd, maxAgeMinutes })
  for (const p of pools) {
    // Re-read live state before each spawn: a Stop (a.enabled=false) or a fill on another
    // lane can land across the createSniper await, and the pre-loop checks are now stale —
    // without this, snipes keep firing after the user pressed Stop / past the caps. [P2-14]
    if (!a.enabled) break
    if (state.bots.filter((b) => b.auto && b.status !== 'stopped').length >= a.maxConcurrent || a.poolUsd < a.perSnipeUsd) break
    const key = p.tokenAddress.toLowerCase()
    if (a.tried.includes(key)) continue
    a.tried.push(key)
    a.vetted = (a.vetted ?? 0) + 1 // per-campaign vetted count (distinct new candidates considered)
    if (a.tried.length > 500) a.tried.splice(0, a.tried.length - 500)
    const out = await createSniper({
      network: a.network,
      poolAddress: p.poolAddress,
      tokenAddress: p.tokenAddress,
      tokenSymbol: p.tokenSymbol,
      tokenName: p.tokenName,
      budgetUsd: a.perSnipeUsd,
      sniper: a.config,
      auto: true,
      sweepTo: a.sweepTo,
      mode: a.workspace ?? state.settings.mode, // pinned workspace (live keeps sniping live)
      liquidityUsd: p.liquidityUsd ?? undefined, // discovery already read it — skip the re-fetch [P2-9]
    })
    if (!('error' in out)) {
      a.poolUsd -= a.perSnipeUsd
      a.lastEntryAt = now // one best coin per cadence
      a.openedCount = (a.openedCount ?? 0) + 1
      if (out.mode === 'live') flushNow() // a live snipe's pool decrement must be durable now [P2-4]
      // Campaign fully deployed → the SCAN is done. Stop scanning (the budget is all
      // committed); the open runners keep riding to their own exits as normal bots.
      const target = a.targetSnipes && a.targetSnipes > 0 ? a.targetSnipes : Math.max(1, Math.floor(a.totalBudgetUsd / a.perSnipeUsd))
      if (a.openedCount >= target) a.enabled = false
      break
    }
  }
  save()
}

export function startAutoSniper(input: {
  network: string
  mode?: 'new' | 'trending'
  totalBudgetUsd: number
  perSnipeUsd: number
  maxConcurrent?: number
  config: SniperConfig
  minLiquidityUsd?: number
  sweepTo?: Bot['sweepTo']
  entryIntervalMs?: number
  maxAgeMinutes?: number
}): { error: string } | State['autoSniper'] {
  if (state.autoSniper?.enabled) return { error: 'Auto-Sniper is already running — stop it first' }
  const asNet = networkById(input.network)
  if (!asNet) return { error: 'unknown network' }
  // Holdings-only chains can never snipe — reject up front rather than start a
  // scanner that would find nothing forever. [R1 guard]
  if (asNet.tradeable === false) return { error: `${asNet.name} is holdings-only — the auto-sniper can't run there` }
  const total = Number(input.totalBudgetUsd)
  const per = Number(input.perSnipeUsd)
  if (!Number.isFinite(total) || total < 10) return { error: 'budget must be at least $10' }
  if (!Number.isFinite(per) || per < 10 || per > total) return { error: 'per-snipe must be ≥ $10 and ≤ the total budget' }
  const c = input.config
  if (!(c.takeProfitPct > 0) || !(c.stopLossPct > 0) || !(c.maxHoldMin > 0))
    return { error: 'auto-sniper needs positive take-profit, stop-loss and max-hold' }
  const maxConcurrent = Math.max(1, Math.min(10, Math.floor(input.maxConcurrent ?? Math.floor(total / per))))
  state.autoSniper = {
    enabled: true,
    network: input.network,
    mode: 'new', // always the fresh-launch feed — that's what "sniping" means (trending = old coins)
    totalBudgetUsd: total,
    poolUsd: total,
    perSnipeUsd: per,
    maxConcurrent,
    config: c,
    sweepTo: input.sweepTo === 'usdt' ? 'usdt' : undefined,
    // Fresh launches start small — a high floor structurally starves the sniper. Safety
    // is the honeypot/rug/holder SCREEN, not the liquidity floor, so keep this modest.
    minLiquidityUsd: Math.max(0, Number(input.minLiquidityUsd) || 5_000),
    tried: state.autoSniper?.tried ?? [],
    startedAt: Date.now(),
    lastScanAt: 0,
    entryIntervalMs: Number(input.entryIntervalMs) > 0 ? Number(input.entryIntervalMs) : AUTO_ENTRY_INTERVAL_MS,
    lastEntryAt: 0, // first cycle opens immediately, then paces every entryIntervalMs
    // Only snipe coins this new (default 3 days). Clamped to a sane band so a bad
    // value can't disable the gate — sniping established coins defeats the purpose.
    maxAgeMinutes:
      Number(input.maxAgeMinutes) > 0 ? Math.min(Number(input.maxAgeMinutes), AUTO_MAX_AGE_CAP_MIN) : AUTO_MAX_AGE_MIN,
    // Campaign size: deploy the whole budget across this many snipes, then the scan ends.
    targetSnipes: Math.max(1, Math.floor(total / per)),
    openedCount: 0,
    vetted: 0, // per-campaign "coins vetted" counter (tried[] is the lifetime dedup memory)
    workspace: state.settings.mode, // pin the workspace it was started in (live keeps sniping live)
  }
  save()
  return state.autoSniper
}

export function stopAutoSniper(liquidate: boolean): State['autoSniper'] {
  const a = state.autoSniper
  if (!a) return null
  a.enabled = false
  if (liquidate) {
    for (const b of state.bots) {
      if (b.auto && b.status !== 'stopped') void controlBot(b.id, 'stop')
    }
  }
  save()
  return a
}

/** Aggregate live stats for the CURRENT campaign's auto-snipes (active + retired).
 *  Scoped to bots opened at/after the campaign's `startedAt` so the panel matches its own
 *  "snipe X of Y" framing — lifetime performance lives in the bot list + Monthly P&L. P&L
 *  is mark-to-market (realized + unrealized on open runners), matching the single-bot view.
 *  `nativeTakenUsd` is value swept to the native vault (principal+profit on a manual stop),
 *  surfaced to the UI as "Banked to vault" (NOT "profit") so it can't read as a fake gain. */
export function autoSniperStats() {
  const since = state.autoSniper?.startedAt ?? 0
  const bots = state.bots.filter((b) => b.auto && b.createdAt >= since)
  let realized = 0
  let unreal = 0
  let banked = 0
  let wins = 0
  let losses = 0
  let active = 0
  let completed = 0
  for (const b of bots) {
    realized += b.stats.realizedUsd
    banked += b.stats.nativeTakenUsd
    if (b.status === 'stopped') {
      completed++
      // Win/loss is per ROUND-TRIP (one closed snipe) by its NET realized P&L — NOT per sell.
      // A snipe that de-risks (a winning partial) then exits at a net loss is ONE loss, not
      // 1W+1L. This keeps wins + losses === completed and the win% honest with de-risk on.
      if (b.stats.realizedUsd >= 0) wins++
      else losses++
      continue
    }
    active++
    const price = priceForBot(b) ?? 0
    if (b.position.qty > 0 && price > 0) unreal += b.position.qty * (price - b.position.avgCostUsd)
  }
  return {
    active,
    completed,
    realizedUsd: +realized.toFixed(2),
    unrealizedUsd: +unreal.toFixed(2),
    totalPnlUsd: +(realized + unreal).toFixed(2),
    nativeTakenUsd: +banked.toFixed(2),
    wins,
    losses,
  }
}

/**
 * The Auto-Sniper as sent to clients. Drops the bulky `tried` address array (sends
 * only its count — "coins vetted") and folds in the live aggregate stats + the scan
 * cadence so the UI can render an honest scanning/countdown view. Used by /api/state,
 * the WS snapshot, and the start/stop responses so the shape never drifts.
 */
export function serializeAutoSniper(a: NonNullable<State['autoSniper']>) {
  // "Coins vetted" = candidates considered THIS campaign (a.vetted); fall back to the
  // lifetime tried buffer for an auto-sniper persisted before the per-campaign counter.
  return { ...a, tried: undefined, triedCount: a.vetted ?? a.tried.length, scanIntervalMs: AUTO_SCAN_MS, stats: autoSniperStats() }
}

// ── Auto-Follow: mirror EVERY curated-token buy a smart-money wallet makes ──
// Give a wallet a budget; whenever it buys a curated token on any EVM network,
// a copy bot is spawned with perTradeUsd from the pool. The bot mirrors the
// position (sells when the wallet sells, plus the risk tier's stops) and
// retires after the round trip, returning its cash to the pool.

const FOLLOW_SCAN_MS = 90_000

export async function followScan(now = Date.now()): Promise<void> {
  for (const f of state.follows) {
    // Always reclaim retired mirror bots — money comes home even when paused.
    for (const b of state.bots) {
      if (b.followId === f.id && b.status === 'stopped' && !b.state.reclaimedByFollow) {
        b.state.reclaimedByFollow = true
        f.poolUsd += b.cashUsd
      }
    }
    if (!f.enabled || !smartMoneyReady()) continue
    if (now - f.lastScanAt < FOLLOW_SCAN_MS) continue
    f.lastScanAt = now

    let active = state.bots.filter((b) => b.followId === f.id && b.status !== 'stopped').length
    if (active >= f.maxConcurrent || f.poolUsd < f.perTradeUsd) continue

    const buys = await walletRecentBuys(f.walletAddress, f.startedAt).catch(() => [])
    if (!f.enabled) continue // stopped during the fetch — open no new mirrors [P2-14]
    for (const e of buys) {
      if (active >= f.maxConcurrent || f.poolUsd < f.perTradeUsd) break
      if (f.seenTx.includes(e.txHash)) continue
      f.seenTx.push(e.txHash)
      if (f.seenTx.length > 300) f.seenTx.splice(0, f.seenTx.length - 300)
      // one live mirror per (wallet, network, token) at a time
      const dup = state.bots.some((b) => b.followId === f.id && b.status !== 'stopped' && b.network === e.network && b.token === e.token)
      if (dup) continue
      const out = createCopyBot({
        network: e.network,
        token: e.token,
        risk: f.risk,
        budgetUsd: f.perTradeUsd,
        walletAddress: f.walletAddress,
        walletLabel: f.label,
        sweepTo: f.sweepTo,
        followId: f.id,
        seedBuyTx: e.txHash, // enter the very buy that triggered the spawn [follow-entry]
        stopLossPct: f.stopLossPct, // propagate the follow's exit overrides to each mirror
        takeProfitPct: f.takeProfitPct,
      })
      if (!('error' in out)) {
        f.poolUsd -= f.perTradeUsd
        active++
        if (out.mode === 'live') flushNow() // durable live pool decrement [P2-4]
      }
    }
  }
  save()
}

export function startFollow(input: {
  walletAddress: string
  label?: string
  totalBudgetUsd: number
  perTradeUsd: number
  maxConcurrent?: number
  risk?: Follow['risk']
  sweepTo?: Bot['sweepTo']
  stopLossPct?: number
  takeProfitPct?: number
}): Follow | { error: string } {
  if (!EVM_ADDR.test(input.walletAddress ?? '')) return { error: 'invalid wallet address' }
  const a = input.walletAddress.toLowerCase()
  if (state.follows.some((f) => f.walletAddress.toLowerCase() === a && f.enabled))
    return { error: 'already following this wallet — stop the existing follow first' }
  const total = Number(input.totalBudgetUsd)
  const per = Number(input.perTradeUsd)
  if (!Number.isFinite(total) || total < 10) return { error: 'budget must be at least $10' }
  if (!Number.isFinite(per) || per < 10 || per > total) return { error: 'per-trade must be ≥ $10 and ≤ the total budget' }
  const controls = parseCopyControls({ stopLossPct: input.stopLossPct, takeProfitPct: input.takeProfitPct }, per)
  if ('error' in controls) return { error: controls.error }
  const risk = input.risk && RISK[input.risk] ? input.risk : 'balanced'
  const f: Follow = {
    id: uid(),
    walletAddress: input.walletAddress,
    label: input.label?.trim() || `${input.walletAddress.slice(0, 6)}…${input.walletAddress.slice(-4)}`,
    totalBudgetUsd: total,
    poolUsd: total,
    perTradeUsd: per,
    maxConcurrent: Math.max(1, Math.min(10, Math.floor(input.maxConcurrent ?? Math.floor(total / per)))),
    risk,
    sweepTo: input.sweepTo === 'usdt' ? 'usdt' : undefined,
    stopLossPct: controls.copy.stopLossPct,
    takeProfitPct: controls.copy.takeProfitPct,
    enabled: true,
    startedAt: Date.now(),
    lastScanAt: 0,
    seenTx: [],
  }
  state.follows.push(f)
  save()
  return f
}

export function stopFollow(id: string, liquidate: boolean): Follow | { error: string } {
  const f = state.follows.find((x) => x.id === id)
  if (!f) return { error: 'not found' }
  f.enabled = false
  if (liquidate) {
    for (const b of state.bots) {
      if (b.followId === id && b.status !== 'stopped') void controlBot(b.id, 'stop')
    }
  }
  save()
  return f
}

export function deleteFollow(id: string): boolean {
  const f = state.follows.find((x) => x.id === id)
  if (!f) return false
  for (const b of state.bots.filter((x) => x.followId === id)) deleteBot(b.id)
  state.follows = state.follows.filter((x) => x.id !== id)
  save()
  return true
}

export function followStats(f: Follow) {
  const bots = state.bots.filter((b) => b.followId === f.id)
  return {
    active: bots.filter((b) => b.status !== 'stopped').length,
    completed: bots.filter((b) => b.status === 'stopped').length,
    realizedUsd: +bots.reduce((s, b) => s + b.stats.realizedUsd, 0).toFixed(2),
    sweptUsd: +bots.reduce((s, b) => s + b.stats.nativeTakenUsd, 0).toFixed(2),
    wins: bots.reduce((s, b) => s + b.stats.wins, 0),
    losses: bots.reduce((s, b) => s + b.stats.losses, 0),
  }
}

export const serializeFollow = (f: Follow) => ({ ...f, seenTx: undefined, stats: followStats(f) })

// ── Copy-trade & AI bots ─────────────────────────────────────────────────────

/** Validate the optional copy-trade controls, returning only the supplied overrides (so unset
 *  fields fall back to the risk tier). `budgetUsd` bounds the per-entry size. */
function parseCopyControls(
  input: { perTradeUsd?: number; stopLossPct?: number; takeProfitPct?: number },
  budgetUsd: number,
): { copy: { perTradeUsd?: number; stopLossPct?: number; takeProfitPct?: number } } | { error: string } {
  const copy: { perTradeUsd?: number; stopLossPct?: number; takeProfitPct?: number } = {}
  if (input.perTradeUsd != null) {
    const v = Number(input.perTradeUsd)
    if (!Number.isFinite(v) || v <= 0) return { error: 'per-trade size must be a positive number' }
    if (v > budgetUsd) return { error: 'per-trade size cannot exceed the budget' }
    copy.perTradeUsd = +v.toFixed(2)
  }
  if (input.stopLossPct != null) {
    const v = Number(input.stopLossPct)
    if (!Number.isFinite(v) || v <= 0 || v > 90) return { error: 'stop-loss must be between 0 and 90%' }
    copy.stopLossPct = +v.toFixed(2)
  }
  if (input.takeProfitPct != null) {
    const v = Number(input.takeProfitPct)
    if (!Number.isFinite(v) || v <= 0 || v > 1000) return { error: 'take-profit must be between 0 and 1000%' }
    copy.takeProfitPct = +v.toFixed(2)
  }
  return { copy }
}

export function createCopyBot(input: {
  network: string
  token: string
  risk: Bot['risk']
  budgetUsd: number
  walletAddress: string
  walletLabel: string
  sweepTo?: Bot['sweepTo']
  followId?: string
  seedBuyTx?: string // the wallet BUY that triggered an auto-follow spawn — enter it directly
  perTradeUsd?: number // copy control: fixed USD per copied entry (else risk-tier %)
  stopLossPct?: number // copy control: override the risk tier's stop-loss
  takeProfitPct?: number // copy control: override the risk tier's take-profit
}): Bot | { error: string } {
  if (!EVM_ADDR.test(input.walletAddress ?? '')) return { error: 'invalid wallet address' }
  if (!networkById(input.network)?.evm) return { error: 'copy trading needs an EVM network (wallet tracking is Etherscan-based)' }
  const controls = parseCopyControls(input, Number(input.budgetUsd))
  if ('error' in controls) return { error: controls.error }
  const out = createBot({
    network: input.network, token: input.token, strategy: 'copytrade', risk: input.risk, budgetUsd: input.budgetUsd,
    name: `🐋 Copy ${input.walletLabel} · ${input.token}`,
    copy: { walletAddress: input.walletAddress, walletLabel: input.walletLabel, ...controls.copy },
    sweepTo: input.sweepTo,
    followId: input.followId,
  })
  // Auto-follow spawns a mirror the instant it sees the wallet's BUY, so that buy's
  // on-chain ts predates createdAt and the tick's freshCopySignal filter would reject
  // it — the bot would never enter (and, never trading, never retire → leaks the follow
  // pool budget forever). Seed the triggering buy directly so the first tick enters. [follow-entry]
  if (!('error' in out) && input.seedBuyTx) out.state.copySignal = { side: 'buy', txHash: input.seedBuyTx }
  return out
}

export function createAiBot(input: {
  network: string
  token: string
  risk: Bot['risk']
  budgetUsd: number
  sweepTo?: Bot['sweepTo']
}): Bot | { error: string } {
  const out = createBot({
    network: input.network, token: input.token, strategy: 'ai', risk: input.risk, budgetUsd: input.budgetUsd,
    name: `🤖 AI ${input.token} · ${RISK[input.risk]?.label ?? input.risk}`,
    ai: true,
    sweepTo: input.sweepTo,
  })
  return out
}

// ── Tournaments ──────────────────────────────────────────────────────────────

const RETURN_PCT = (b: Bot, price: number) => {
  const unreal = b.position.qty > 0 && price > 0 ? b.position.qty * (price - b.position.avgCostUsd) : 0
  return b.budgetUsd > 0 ? ((b.stats.realizedUsd + unreal) / b.budgetUsd) * 100 : 0
}

export function serializeTournament(t: Tournament) {
  const bots = state.bots.filter((b) => b.tournamentId === t.id)
  const standings = bots
    .map((b) => {
      const price = priceForBot(b) ?? 0
      const unreal = b.position.qty > 0 && price > 0 ? b.position.qty * (price - b.position.avgCostUsd) : 0
      return {
        botId: b.id, name: b.name, strategy: b.strategy, risk: b.risk, status: b.status,
        totalPnlUsd: +(b.stats.realizedUsd + unreal).toFixed(2),
        returnPct: +RETURN_PCT(b, price).toFixed(2),
        wins: b.stats.wins, losses: b.stats.losses,
        trades: state.trades.filter((tr) => tr.botId === b.id).length,
      }
    })
    .sort((a, b) => b.returnPct - a.returnPct)
  return { ...t, standings }
}

/** Auto-end tournaments past their deadline and stamp the winner. */
function resolveTournaments() {
  const now = Date.now()
  for (const t of state.tournaments) {
    if (t.status !== 'running') continue
    if (t.endsAt && now >= t.endsAt) {
      const ranked = serializeTournament(t).standings
      t.winnerBotId = ranked[0]?.botId ?? null
      t.status = 'ended'
      // Freeze every contestant: liquidate to native and stop (mirror-first in live).
      for (const b of state.bots.filter((x) => x.tournamentId === t.id && x.status !== 'stopped')) {
        void controlBot(b.id, 'stop')
      }
    }
  }
}

export function startTournament(input: {
  name?: string
  network: string
  token: string
  budgetUsd: number
  contestants: { strategy: string; risk: Bot['risk'] }[]
  durationHours?: number
  sweepTo?: Bot['sweepTo'] // on (auto-)end, contestants liquidate to this
}): (Tournament & { standings: unknown }) | { error: string } {
  const net = networkById(input.network)
  if (!net || !tokenOf(input.network, input.token)) return { error: 'unknown network/token' }
  // Reject holdings-only chains up front so we never push an orphan tournament record
  // whose contestant createBot()s all fail the tradeable guard. [R1 guard]
  if (net.tradeable === false) return { error: `${net.name} is holdings-only — tournaments aren't available there` }
  const budget = Number(input.budgetUsd)
  if (!Number.isFinite(budget) || budget < 10) return { error: 'budget per contestant must be at least $10' }
  const contestants = (input.contestants ?? []).filter((c) => strategyById(c.strategy) && RISK[c.risk])
  if (contestants.length < 2) return { error: 'a tournament needs at least 2 valid contestants' }
  if (contestants.length > 12) return { error: 'at most 12 contestants' }

  const t: Tournament = {
    id: uid(),
    name: input.name?.trim() || `${input.token} ${contestants.length}-bot tournament`,
    network: net.id,
    token: input.token,
    budgetUsd: budget,
    status: 'running',
    mode: state.settings.mode, // the workspace it runs in (its contestant bots inherit it)
    createdAt: Date.now(),
    endsAt: input.durationHours && input.durationHours > 0 ? Date.now() + input.durationHours * 3_600_000 : null,
    sweepTo: input.sweepTo === 'usdt' ? 'usdt' : 'native',
    winnerBotId: null,
  }
  state.tournaments.push(t)
  for (const c of contestants) {
    createBot({
      network: input.network, token: input.token, strategy: c.strategy, risk: c.risk, budgetUsd: budget,
      name: `🏆 ${input.token} ${strategyById(c.strategy)!.name} · ${RISK[c.risk].label}`,
      tournamentId: t.id,
      sweepTo: t.sweepTo,
    })
  }
  save()
  return serializeTournament(t)
}

export function endTournament(id: string): (Tournament & { standings: unknown }) | { error: string } {
  const t = state.tournaments.find((x) => x.id === id)
  if (!t) return { error: 'not found' }
  if (t.status === 'running') {
    t.winnerBotId = serializeTournament(t).standings[0]?.botId ?? null
    t.status = 'ended'
    for (const b of state.bots.filter((x) => x.tournamentId === t.id && x.status !== 'stopped')) void controlBot(b.id, 'stop')
  }
  save()
  return serializeTournament(t)
}

export function deleteTournament(id: string): boolean {
  const t = state.tournaments.find((x) => x.id === id)
  if (!t) return false
  for (const b of state.bots.filter((x) => x.tournamentId === id)) deleteBot(b.id)
  state.tournaments = state.tournaments.filter((x) => x.id !== id)
  save()
  return true
}

export async function controlBot(id: string, action: 'pause' | 'resume' | 'stop'): Promise<Bot | { error: string }> {
  const bot = state.bots.find((b) => b.id === id)
  if (!bot) return { error: 'not found' }
  if (action === 'pause') {
    bot.status = 'paused'
    log(bot, 'Paused by user')
  } else if (action === 'resume') {
    bot.status = 'running'
    bot.archived = false // resuming brings it back to the active list
    // Re-arm a RETIRED sniper. A sniper is one-shot (state.sniped) — so without
    // clearing the flag a resume just re-trips the "snipe complete" retire on the
    // next tick (the loop the user saw). A flat, already-fired sniper instead
    // re-snipes a fresh full-position entry at the current price with its (possibly
    // just-edited) parameters. A sniper still HOLDING a position is left untouched —
    // resume simply continues managing the open trade. [re-snipe]
    if (bot.sniper && bot.state.sniped && bot.position.qty === 0) {
      bot.state.sniped = false
      delete bot.state.entryAt
      delete bot.state.peak
      bot.state.forceExit = false
      if (bot.cashUsd > 1)
        log(bot, `Re-armed — sniping again with TP +${bot.sniper.takeProfitPct}% / SL −${bot.sniper.stopLossPct}% / max ${bot.sniper.maxHoldMin}m${bot.sniper.trailingPct ? ` / trail ${bot.sniper.trailingPct}%` : ''}`)
      else log(bot, 'Resumed, but working cash is ~$0 — add budget to re-snipe', 'warn')
    } else {
      log(bot, 'Resumed by user')
    }
  } else {
    // Stop = liquidate everything to the bot's sweep target. MIRROR-FIRST in live
    // mode (like settle): the on-chain sell must CONFIRM before we book the paper
    // liquidation — otherwise a failed sell (no liquidity / honeypot / RPC down)
    // would record a phantom sold-and-swept position with fake P&L while the real
    // tokens are stranded. On failure: pause (NO paper mutation) so the operator
    // can retry; do NOT mark the bot stopped.
    const liveMode = bot.mode === 'live' // stop liquidates on-chain only for a LIVE bot
    const price = priceForBot(bot)
    if (bot.position.qty > 0 && price) {
      const qty = bot.position.qty
      let realQty: number | undefined
      let realProceeds: number | undefined // measured native/USDT received [MP-1]
      if (liveMode) {
        const r = await mirrorLive(bot, 'sell', qty * price, qty, price, true) // manual stop = full exit [MP-2]
        if (!r.ok) {
          bot.status = 'paused'
          log(bot, `Stop aborted — on-chain sell failed (${r.error}). Position kept untouched; resume to retry.`, 'warn')
          flushNow()
          return bot
        }
        if (r.delta && r.delta.baseUnits > 0n) {
          realQty = Number(r.delta.baseUnits) / 10 ** r.delta.decimals
          realProceeds = r.delta.proceedsUsd // measured proceeds paired with measured qty
        } else if (r.delta) {
          bot.state.realHeldUntrusted = true // unmeasurable delta → modeled proceeds for the paper fraction [reconcile]
        }
      }
      const beforeRealized = bot.stats.realizedUsd
      execSell(bot, price, 1, 'Manual stop — full position swept to native', true, true, realQty, realProceeds)
      // A live stop realizes real on-chain P&L — fold it into the breaker exactly like
      // settle(), so a forced/auto liquidation (manual Stop, tournament end, auto-sniper
      // / follow teardown) can't slip a loss past the cumulative-loss ceiling.
      const net = networkById(bot.network)
      if (liveMode && hasLiveExecutor(net)) accrueLiveRealized(bot, beforeRealized)
    } else if (bot.position.qty > 0) {
      log(bot, 'Stop requested but no live price — position NOT liquidated; resume and retry', 'warn')
      return bot
    }
    bot.status = 'stopped'
    log(bot, 'Stopped — all holdings in native currency')
  }
  flushNow() // durable: a stop + shutdown within the debounce window must not resurrect the bot
  return bot
}

/**
 * Adjust an existing bot's editable parameters. Currently the sniper's exit
 * thresholds (take-profit / stop-loss / max-hold / trailing) and the budget — a
 * top-up injects working cash; reducing pulls back only FREE cash (never below
 * what's deployed). The sniper strategy re-reads `bot.sniper` every tick, so
 * changes apply live to a running bot AND govern the next entry of a re-armed one.
 * Validates each field; an out-of-range value is rejected WITHOUT partially
 * applying. Pair with controlBot('resume') to re-snipe a retired bot with the new
 * parameters. Returns the updated bot or {error}.
 */
export function editBot(
  id: string,
  patch: { takeProfitPct?: number; stopLossPct?: number; maxHoldMin?: number; trailingPct?: number | null; budgetUsd?: number },
): Bot | { error: string } {
  const bot = state.bots.find((b) => b.id === id)
  if (!bot) return { error: 'not found' }

  // ── Sniper exit thresholds (validated into a copy, applied atomically) ──────
  const touchesSnipe =
    patch.takeProfitPct !== undefined || patch.stopLossPct !== undefined || patch.maxHoldMin !== undefined || patch.trailingPct !== undefined
  if (touchesSnipe) {
    if (!bot.sniper) return { error: 'take-profit / stop-loss / max-hold are sniper-only parameters' }
    const next: SniperConfig = { ...bot.sniper }
    if (patch.takeProfitPct !== undefined) {
      const v = Number(patch.takeProfitPct)
      if (!(v > 0) || v > 1000) return { error: 'take-profit must be between 0 and 1000%' }
      next.takeProfitPct = v
    }
    if (patch.stopLossPct !== undefined) {
      const v = Number(patch.stopLossPct)
      if (!(v > 0) || v > 100) return { error: 'stop-loss must be between 0 and 100%' }
      next.stopLossPct = v
    }
    if (patch.maxHoldMin !== undefined) {
      const v = Number(patch.maxHoldMin)
      if (!(v > 0) || v > 100_000) return { error: 'max-hold must be a positive number of minutes' }
      next.maxHoldMin = v
    }
    if (patch.trailingPct !== undefined) {
      if (patch.trailingPct === null || patch.trailingPct === 0) delete next.trailingPct // clear the optional trailing stop
      else {
        const v = Number(patch.trailingPct)
        if (!(v > 0) || v > 100) return { error: 'trailing stop must be between 0 and 100%' }
        next.trailingPct = v
      }
    }
    bot.sniper = next
  }

  // ── Budget (top-up adds working cash; reduce pulls back only free cash) ─────
  if (patch.budgetUsd !== undefined) {
    const v = Number(patch.budgetUsd)
    if (!Number.isFinite(v) || v < 10) return { error: 'budget must be at least $10' }
    const delta = v - bot.budgetUsd
    if (delta < 0 && bot.cashUsd + delta < 0) return { error: `can't reduce below deployed capital — only $${bot.cashUsd.toFixed(2)} is free` }
    bot.budgetUsd = v
    bot.cashUsd = Math.max(0, bot.cashUsd + delta) // capital injection / withdrawal of free cash
  }

  log(
    bot,
    `Parameters updated${bot.sniper ? ` — TP +${bot.sniper.takeProfitPct}% / SL −${bot.sniper.stopLossPct}% / max ${bot.sniper.maxHoldMin}m${bot.sniper.trailingPct ? ` / trail ${bot.sniper.trailingPct}%` : ''}` : ''} · budget $${bot.budgetUsd}`,
  )
  flushNow()
  return bot
}

/** Manually archive (hide from the active list) or un-archive a bot. Archiving a
 *  RUNNING/scheduled bot also pauses it so an archived bot is never quietly trading;
 *  the position (if any) is kept — un-archive then resume to manage it again. */
export function archiveBot(id: string, archived: boolean): Bot | { error: string } {
  const bot = state.bots.find((b) => b.id === id)
  if (!bot) return { error: 'not found' }
  bot.archived = archived
  if (archived && (bot.status === 'running' || bot.status === 'scheduled')) {
    bot.status = 'paused'
    log(bot, 'Archived (paused) by user')
  } else log(bot, archived ? 'Archived by user' : 'Un-archived by user')
  save()
  return bot
}

export function deleteBot(id: string): boolean {
  const i = state.bots.findIndex((b) => b.id === id)
  if (i === -1) return false
  const bot = state.bots[i]
  // A live bot with residual on-chain holdings leaves orphaned tokens in the
  // shared wallet — surface it loudly rather than silently breaking the
  // realHeld-sums-to-aggregate invariant.
  if (bot.mode === 'live' && curHeld(bot) > 0n)
    console.warn(`[engine] deleting bot ${bot.id} (${bot.name}) with realHeld=${bot.realHeld} — ${curHeld(bot)} base units orphaned in the shared wallet; reconcile/sweep manually`)
  // Return a deleted spawn's working cash to its pool so deleting an active auto-snipe /
  // follow-mirror doesn't permanently leak that budget out of the campaign. The reclaim
  // flags also keep the autoScan/followScan "money comes home" pass from double-counting. [P2-14]
  if (bot.auto && state.autoSniper && !bot.state.reclaimedByAuto) {
    bot.state.reclaimedByAuto = true
    state.autoSniper.poolUsd += bot.cashUsd
  }
  if (bot.followId && !bot.state.reclaimedByFollow) {
    const f = state.follows.find((x) => x.id === bot.followId)
    if (f) { bot.state.reclaimedByFollow = true; f.poolUsd += bot.cashUsd }
  }
  state.bots.splice(i, 1)
  state.trades = state.trades.filter((t) => t.botId !== id)
  fleetPeak = 0 // removing a bot shrinks fleet equity — re-baseline the drawdown high-water so a deletion can't spuriously trip the cap
  flushNow() // monthly ledger intentionally keeps the deleted bot's history
  return true
}

export function trimTrades() {
  if (state.trades.length > 2000) state.trades.splice(0, state.trades.length - 2000)
}

/** Internal hooks for the test suite only. `live` is the injectable executor
 *  seam — tests override its methods to exercise live reconciliation offline. */
export const __test = { execBuy, execSell, tickBot, settle, mirrorLive, live, runExclusive, reconcileRealHeld, curHeld, checkFleetDrawdown, creditVault, vaultBalance, slTpFallback }
