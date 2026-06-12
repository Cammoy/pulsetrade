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

import { state, save, uid, monthKey, emptyMonth, type Bot, type Trade, type SniperConfig, type State, type Tournament } from './store.js'
import { networkById, tokenOf, allPriceIds } from './networks.js'
import { getSpotPrices, getCandles, spot, poolPrice, refreshPoolPrice } from './prices.js'
import { strategyById, type Ctx } from './strategies.js'
import { RISK } from './risk.js'
import { liveReady, executeSwap } from './live.js'
import { screenAddress } from './screen-fetch.js'
import { discoverSafePools } from './sniper.js'
import { walletTokenSignal, trackingReady as smartMoneyReady } from './smartmoney.js'
import { getAiSignal } from './ai-trader.js'
import { parseUnits } from 'viem'

const TICK_MS = 20_000
const SLIPPAGE = 0.0015

type Broadcast = (msg: object) => void
let broadcast: Broadcast = () => {}

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

function month(ts: number) {
  return (state.monthly[monthKey(ts)] ??= emptyMonth())
}

/** Current USD price for a bot: DEX pool for sniped tokens, else CoinGecko. */
function priceForBot(bot: Bot): number | undefined {
  if (bot.pool) {
    const net = networkById(bot.network)
    return net ? poolPrice(net.gt, bot.pool.poolAddress) : undefined
  }
  const token = tokenOf(bot.network, bot.token)
  return token ? spot(token.cg) : undefined
}

function execBuy(bot: Bot, price: number, usd: number, reason: string) {
  const net = networkById(bot.network)!
  const fee = net.avgGasUsd + usd * SLIPPAGE
  const qty = (usd - fee) / price
  const p = bot.position
  // Cost basis = total dollars in (fees included) / units held.
  p.avgCostUsd = p.qty + qty > 0 ? (p.avgCostUsd * p.qty + usd) / (p.qty + qty) : price
  p.qty += qty
  p.costUsd += usd
  if (!p.openedAt) p.openedAt = Date.now()
  bot.cashUsd -= usd
  bot.stats.feesUsd += fee
  const ts = Date.now()
  const m = month(ts)
  m.volumeUsd += usd
  m.feesUsd += fee
  const trade: Trade = {
    id: uid(), botId: bot.id, ts, side: 'buy', network: bot.network,
    token: bot.token, qty, priceUsd: price, usd, feeUsd: fee, reason,
    mode: state.settings.mode,
  }
  state.trades.push(trade)
  log(bot, `BUY $${usd.toFixed(2)} ${bot.token} @ $${price.toLocaleString()} — ${reason}`, 'buy')
  broadcast({ type: 'trade', trade })
}

function execSell(bot: Bot, price: number, fraction: number, reason: string, exit: boolean, sweepAll = false) {
  const net = networkById(bot.network)!
  const p = bot.position
  const sellQty = p.qty * Math.min(1, fraction)
  if (sellQty <= 0) return
  const gross = sellQty * price
  const fee = net.avgGasUsd + gross * SLIPPAGE
  const proceeds = gross - fee
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
  }

  bot.stats.realizedUsd += pnl
  bot.stats.feesUsd += fee
  // Every sell closes a round trip against cost basis — count it.
  if (pnl >= 0) bot.stats.wins++
  else bot.stats.losses++
  if (exit || p.qty === 0) bot.state.lastExitAt = Date.now()

  const ts = Date.now()
  const m = month(ts)
  m.volumeUsd += gross
  m.feesUsd += fee
  m.realizedUsd += pnl
  if (pnl >= 0) m.wins++
  else m.losses++
  m.byRisk[bot.risk] = (m.byRisk[bot.risk] ?? 0) + pnl
  if (swept) m.nativeTakenUsd += swept.usd

  const trade: Trade = {
    id: uid(), botId: bot.id, ts, side: 'sell', network: bot.network,
    token: bot.token, qty: sellQty, priceUsd: price, usd: gross, feeUsd: fee,
    reason, pnlUsd: +pnl.toFixed(6), sweptNative: swept, mode: state.settings.mode,
  }
  state.trades.push(trade)
  log(bot, `SELL ${sellQty.toPrecision(6)} ${bot.token} @ $${price.toLocaleString()} → P&L $${pnl.toFixed(2)}${swept ? ` (swept ${swept.qty.toPrecision(4)} ${swept.symbol})` : ''} — ${reason}`, 'sell')
  broadcast({ type: 'trade', trade })
}

/** Fire the live on-chain swap mirroring a paper decision (best-effort). */
async function mirrorLive(bot: Bot, side: 'buy' | 'sell', usd: number, qty: number, price: number) {
  if (state.settings.mode !== 'live' || !liveReady()) return
  const net = networkById(bot.network)!
  if (!net.evm) {
    log(bot, 'LIVE EXECUTION SKIPPED: live trading is EVM-only — this network trades in paper', 'warn')
    return
  }
  // Sniper bots carry their token address/decimals on bot.pool; others resolve
  // from the curated list.
  const tokenAddress = bot.pool?.tokenAddress ?? tokenOf(bot.network, bot.token)?.address
  const decimals = bot.pool?.decimals ?? tokenOf(bot.network, bot.token)?.decimals
  if (!tokenAddress || decimals === undefined) {
    log(bot, 'LIVE EXECUTION SKIPPED: token address unknown', 'warn')
    return
  }
  try {
    const nativePrice = spot(net.native.cg)
    if (side === 'buy' && !nativePrice) throw new Error('no native price for sizing')
    const sellAmount =
      side === 'buy'
        ? parseUnits((usd / nativePrice!).toFixed(18), 18) // native in
        : parseUnits(qty.toFixed(decimals), decimals)
    const hash = await executeSwap({
      chainId: net.chainId,
      tokenAddress,
      side,
      sellAmountBaseUnits: sellAmount,
      // Sells land in the bot's sweep target (USDT or native).
      buyTokenAddress: side === 'sell' && bot.sweepTo === 'usdt' ? net.usdt.address : undefined,
    })
    log(bot, `On-chain ${side} confirmed: ${hash.slice(0, 18)}…`, 'info')
  } catch (e: any) {
    log(bot, `LIVE EXECUTION FAILED (${side}): ${e.message ?? e}`, 'warn')
  }
}

async function tickBot(bot: Bot) {
  if (bot.status === 'stopped' || bot.status === 'paused') return
  const scheduled = !inSchedule(bot)
  const newStatus = scheduled ? 'scheduled' : 'running'
  if (bot.status !== newStatus) {
    bot.status = newStatus
    log(bot, scheduled ? 'Outside trading window — sleeping' : 'Trading window open — resuming')
  }
  if (scheduled) return

  const strat = strategyById(bot.strategy)
  const params = RISK[bot.risk]
  if (!strat || !params) return

  const price = priceForBot(bot)
  if (!price) return

  // Sniper bots are priced from their pool and need no candle history; all
  // other strategies need 30d of hourly closes for their indicators.
  let closes: number[]
  if (bot.sniper) {
    bot.state.snipe = bot.sniper // seed config for the strategy each tick
    closes = [price]
  } else {
    const token = tokenOf(bot.network, bot.token)
    if (!token) return
    const candles = await getCandles(token.cg, 30)
    if (candles.length < 30) return
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
  bot.lastTickAt = Date.now()
  if (a?.type === 'buy' && a.usd > 1 && bot.cashUsd >= a.usd * 0.999) {
    execBuy(bot, price, Math.min(a.usd, bot.cashUsd), a.reason)
    void mirrorLive(bot, 'buy', a.usd, 0, price)
  } else if (a?.type === 'sell' && bot.position.qty > 0) {
    const qty = bot.position.qty * Math.min(1, a.fraction)
    execSell(bot, price, a.fraction, a.reason, a.exit ?? false)
    void mirrorLive(bot, 'sell', qty * price, qty, price)
  }

  // A sniper that has fired and exited is finished — retire it cleanly.
  if (bot.sniper && bot.state.sniped && bot.position.qty === 0) {
    bot.status = 'stopped'
    log(bot, 'Snipe complete — position closed, bot retired', 'info')
  }

  // Equity sample roughly once a minute.
  const last = bot.equityHistory[bot.equityHistory.length - 1]
  if (!last || Date.now() - last.t > 60_000) {
    const unreal = bot.position.qty * (price - bot.position.avgCostUsd)
    bot.equityHistory.push({ t: Date.now(), v: +(bot.stats.realizedUsd + unreal).toFixed(2) })
    if (bot.equityHistory.length > 240) bot.equityHistory.splice(0, bot.equityHistory.length - 240)
  }
}

export function serializeBot(bot: Bot) {
  const price = priceForBot(bot) ?? 0
  const unrealizedUsd = bot.position.qty > 0 && price > 0 ? bot.position.qty * (price - bot.position.avgCostUsd) : 0
  return {
    ...bot,
    priceUsd: price,
    unrealizedUsd: +unrealizedUsd.toFixed(4),
    totalPnlUsd: +(bot.stats.realizedUsd + unrealizedUsd).toFixed(4),
    positionValueUsd: +(bot.position.qty * price).toFixed(2),
  }
}

let ticking = false
async function tick() {
  if (ticking) return // never overlap ticks
  ticking = true
  try {
    await getSpotPrices(allPriceIds())
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
          walletTokenSignal(b.network, b.copy!.walletAddress, b.token)
            .then((sig) => {
              if (sig) b.state.copySignal = { side: sig.side, txHash: sig.txHash }
            })
            .catch(() => {}),
        ),
    )
    await Promise.all(state.bots.map((b) => tickBot(b).catch((e) => console.error(`[engine] bot ${b.name}:`, e))))
    await autoScan().catch((e) => console.error('[engine] auto-sniper scan failed', e))
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
      autoSniper: state.autoSniper ? { ...state.autoSniper, tried: undefined, stats: autoSniperStats() } : null,
      tournaments: state.tournaments.map(serializeTournament),
      smartMoney: { tracking: smartMoneyReady() },
    })
  } catch (e) {
    console.error('[engine] tick failed', e)
  } finally {
    ticking = false
  }
}

export function startEngine(b: Broadcast) {
  broadcast = b
  void tick()
  setInterval(tick, TICK_MS)
  console.log(`[engine] running — ${state.bots.length} bot(s) loaded, tick every ${TICK_MS / 1000}s`)
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
  sweepTo?: Bot['sweepTo']
}): Bot | { error: string } {
  const net = networkById(input.network)
  const token = net && tokenOf(input.network, input.token)
  if (!net || !token) return { error: 'unknown network/token' }
  if (!strategyById(input.strategy)) return { error: 'unknown strategy' }
  if (!RISK[input.risk]) return { error: 'unknown risk tier' }
  if (input.sweepTo !== undefined && input.sweepTo !== 'native' && input.sweepTo !== 'usdt')
    return { error: "sweepTo must be 'native' or 'usdt'" }
  const budget = Number(input.budgetUsd)
  if (!Number.isFinite(budget) || budget < 10) return { error: 'budget must be at least $10' }
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
    sweepTo: input.sweepTo === 'usdt' ? 'usdt' : undefined,
    position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null },
    state: {},
    stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 },
    equityHistory: [],
    log: [],
    createdAt: Date.now(),
    lastTickAt: 0,
  }
  log(bot, `Bot launched — $${budget} budget, ${RISK[input.risk].label} risk, ${state.settings.mode} mode`)
  state.bots.push(bot)
  save()
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
}): Promise<(Bot & { riskReport: unknown }) | { error: string; riskReport?: unknown }> {
  const net = networkById(input.network)
  if (!net) return { error: 'unknown network' }
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.tokenAddress)) return { error: 'invalid token address' }
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.poolAddress)) return { error: 'invalid pool address' }
  const budget = Number(input.budgetUsd)
  if (!Number.isFinite(budget) || budget < 10) return { error: 'budget must be at least $10' }
  const s = input.sniper
  if (!(s.takeProfitPct > 0) || !(s.stopLossPct > 0) || !(s.maxHoldMin > 0))
    return { error: 'sniper needs positive take-profit, stop-loss and max-hold' }

  // MANDATORY pre-trade safety screen — blocks honeypots / non-sellable / rugs.
  const report = await screenAddress(input.network, input.tokenAddress, input.tokenSymbol)
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
    pool: { poolAddress: input.poolAddress, tokenAddress: input.tokenAddress, decimals: input.decimals ?? 18 },
    sniper: s,
    auto: input.auto || undefined,
    sweepTo: input.sweepTo === 'usdt' ? 'usdt' : undefined,
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
  save()
  return bot as Bot & { riskReport: unknown }
}

// ── Auto-Sniper ──────────────────────────────────────────────────────────────
// Give it a budget; it scans the safe-only feed, snipes vetted tokens up to
// maxConcurrent at perSnipeUsd each, and recycles returned cash into new
// snipes. Profits accumulate in native via the normal sweep.

const AUTO_SCAN_MS = 90_000

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

  let active = state.bots.filter((b) => b.auto && b.status !== 'stopped').length
  if (active >= a.maxConcurrent || a.poolUsd < a.perSnipeUsd) return

  const { pools } = await discoverSafePools(a.network, a.mode, now, { minLiquidityUsd: a.minLiquidityUsd })
  for (const p of pools) {
    if (active >= a.maxConcurrent || a.poolUsd < a.perSnipeUsd) break
    const key = p.tokenAddress.toLowerCase()
    if (a.tried.includes(key)) continue
    a.tried.push(key)
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
    })
    if (!('error' in out)) {
      a.poolUsd -= a.perSnipeUsd
      active++
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
}): { error: string } | State['autoSniper'] {
  if (state.autoSniper?.enabled) return { error: 'Auto-Sniper is already running — stop it first' }
  if (!networkById(input.network)) return { error: 'unknown network' }
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
    mode: input.mode === 'trending' ? 'trending' : 'new',
    totalBudgetUsd: total,
    poolUsd: total,
    perSnipeUsd: per,
    maxConcurrent,
    config: c,
    sweepTo: input.sweepTo === 'usdt' ? 'usdt' : undefined,
    minLiquidityUsd: Math.max(0, Number(input.minLiquidityUsd) || 10_000),
    tried: state.autoSniper?.tried ?? [],
    startedAt: Date.now(),
    lastScanAt: 0,
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
      if (b.auto && b.status !== 'stopped') controlBot(b.id, 'stop')
    }
  }
  save()
  return a
}

/** Aggregate live stats for the autopilot's bots (active + retired). */
export function autoSniperStats() {
  const bots = state.bots.filter((b) => b.auto)
  return {
    active: bots.filter((b) => b.status !== 'stopped').length,
    completed: bots.filter((b) => b.status === 'stopped').length,
    realizedUsd: +bots.reduce((s, b) => s + b.stats.realizedUsd, 0).toFixed(2),
    nativeTakenUsd: +bots.reduce((s, b) => s + b.stats.nativeTakenUsd, 0).toFixed(2),
    wins: bots.reduce((s, b) => s + b.stats.wins, 0),
    losses: bots.reduce((s, b) => s + b.stats.losses, 0),
  }
}

// ── Copy-trade & AI bots ─────────────────────────────────────────────────────

export function createCopyBot(input: {
  network: string
  token: string
  risk: Bot['risk']
  budgetUsd: number
  walletAddress: string
  walletLabel: string
  sweepTo?: Bot['sweepTo']
}): Bot | { error: string } {
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.walletAddress ?? '')) return { error: 'invalid wallet address' }
  if (!networkById(input.network)?.evm) return { error: 'copy trading needs an EVM network (wallet tracking is Etherscan-based)' }
  const out = createBot({
    network: input.network, token: input.token, strategy: 'copytrade', risk: input.risk, budgetUsd: input.budgetUsd,
    name: `🐋 Copy ${input.walletLabel} · ${input.token}`,
    copy: { walletAddress: input.walletAddress, walletLabel: input.walletLabel },
    sweepTo: input.sweepTo,
  })
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
      // Freeze every contestant: liquidate to native and stop.
      for (const b of state.bots.filter((x) => x.tournamentId === t.id && x.status !== 'stopped')) {
        controlBot(b.id, 'stop')
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
    for (const b of state.bots.filter((x) => x.tournamentId === t.id && x.status !== 'stopped')) controlBot(b.id, 'stop')
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

export function controlBot(id: string, action: 'pause' | 'resume' | 'stop'): Bot | { error: string } {
  const bot = state.bots.find((b) => b.id === id)
  if (!bot) return { error: 'not found' }
  if (action === 'pause') {
    bot.status = 'paused'
    log(bot, 'Paused by user')
  } else if (action === 'resume') {
    bot.status = 'running'
    log(bot, 'Resumed by user')
  } else {
    // Stop = liquidate everything to the chain's native coin. No bags.
    const price = priceForBot(bot)
    if (bot.position.qty > 0 && price) {
      const qty = bot.position.qty
      execSell(bot, price, 1, 'Manual stop — full position swept to native', true, true)
      void mirrorLive(bot, 'sell', qty * price, qty, price)
    } else if (bot.position.qty > 0) {
      log(bot, 'Stop requested but no live price — position NOT liquidated; resume and retry', 'warn')
      return bot
    }
    bot.status = 'stopped'
    log(bot, 'Stopped — all holdings in native currency')
  }
  save()
  return bot
}

export function deleteBot(id: string): boolean {
  const i = state.bots.findIndex((b) => b.id === id)
  if (i === -1) return false
  state.bots.splice(i, 1)
  state.trades = state.trades.filter((t) => t.botId !== id)
  save() // monthly ledger intentionally keeps the deleted bot's history
  return true
}

export function trimTrades() {
  if (state.trades.length > 2000) state.trades.splice(0, state.trades.length - 2000)
}

/** Internal hooks for the test suite only. */
export const __test = { execBuy, execSell, tickBot }
