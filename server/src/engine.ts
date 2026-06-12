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

import { state, save, uid, monthKey, emptyMonth, type Bot, type Trade } from './store.js'
import { networkById, tokenOf, allPriceIds } from './networks.js'
import { getSpotPrices, getCandles, spot } from './prices.js'
import { strategyById, type Ctx } from './strategies.js'
import { RISK } from './risk.js'
import { liveReady, executeSwap } from './live.js'
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
  // chain's native coin so the bot never accumulates token bags.
  const nativePrice = spot(net.native.cg) ?? 0
  let swept: Trade['sweptNative']
  if (sweepAll && nativePrice > 0) {
    swept = { qty: proceeds / nativePrice, symbol: net.native.symbol, usd: proceeds }
  } else if (pnl > 0 && nativePrice > 0) {
    swept = { qty: pnl / nativePrice, symbol: net.native.symbol, usd: pnl }
    bot.cashUsd += costBasis // principal returns to working capital
  } else {
    bot.cashUsd += proceeds // loss (or no native price): net proceeds back to cash
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
  const token = tokenOf(bot.network, bot.token)!
  try {
    const nativePrice = spot(net.native.cg)
    if (side === 'buy' && !nativePrice) throw new Error('no native price for sizing')
    const sellAmount =
      side === 'buy'
        ? parseUnits((usd / nativePrice!).toFixed(18), 18) // native in
        : parseUnits(qty.toFixed(token.decimals), token.decimals)
    const hash = await executeSwap({ chainId: net.chainId, tokenAddress: token.address, side, sellAmountBaseUnits: sellAmount })
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

  const token = tokenOf(bot.network, bot.token)
  const strat = strategyById(bot.strategy)
  const params = RISK[bot.risk]
  if (!token || !strat || !params) return

  const price = spot(token.cg)
  if (!price) return
  const candles = await getCandles(token.cg, 30)
  if (candles.length < 30) return
  const closes = candles.map((c) => c.c)
  closes.push(price)

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

  // Equity sample roughly once a minute.
  const last = bot.equityHistory[bot.equityHistory.length - 1]
  if (!last || Date.now() - last.t > 60_000) {
    const unreal = bot.position.qty * (price - bot.position.avgCostUsd)
    bot.equityHistory.push({ t: Date.now(), v: +(bot.stats.realizedUsd + unreal).toFixed(2) })
    if (bot.equityHistory.length > 240) bot.equityHistory.splice(0, bot.equityHistory.length - 240)
  }
}

export function serializeBot(bot: Bot) {
  const token = tokenOf(bot.network, bot.token)
  const price = token ? spot(token.cg) ?? 0 : 0
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
    await Promise.all(state.bots.map((b) => tickBot(b).catch((e) => console.error(`[engine] bot ${b.name}:`, e))))
    save()
    const prices: Record<string, number> = {}
    for (const id of allPriceIds()) {
      const p = spot(id)
      if (p) prices[id] = p
    }
    broadcast({ type: 'snapshot', ts: Date.now(), bots: state.bots.map(serializeBot), prices, monthly: state.monthly })
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
}): Bot | { error: string } {
  const net = networkById(input.network)
  const token = net && tokenOf(input.network, input.token)
  if (!net || !token) return { error: 'unknown network/token' }
  if (!strategyById(input.strategy)) return { error: 'unknown strategy' }
  if (!RISK[input.risk]) return { error: 'unknown risk tier' }
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
    const token = tokenOf(bot.network, bot.token)
    const price = token ? spot(token.cg) : undefined
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
