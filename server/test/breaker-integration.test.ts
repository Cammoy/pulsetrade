// H1: the circuit-breaker + daily-cap + lifetime-ceiling logic is only useful if
// it fires INSIDE settle() on the live money path — the pure helpers are tested
// elsewhere (daily-cap.test.ts). These integration tests drive settle() in live
// mode through the __test.live executor seam (no network) and assert the breaker
// trips, pauses every bot, blocks new exposure, and that the spend accumulators +
// daily-cap SKIP behaviour are exactly right.
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-breaker-'))
process.env.ZEROX_API_KEY = 'test-key'
process.env.BOT_WALLET_KEY = '0x' + '1'.repeat(64)

const PRICES: Record<string, number> = { ethereum: 2000, chainlink: 10, tether: 1 }

const { state, dayKey } = await import('../src/store.js')
const { createBot, controlBot, resetBreaker, breakerState, __test } = await import('../src/engine.js')
const { getSpotPrices } = await import('../src/prices.js')
const { settle, live, execBuy, checkFleetDrawdown } = __test

const realLive = { ...live }

before(async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { usd: v }]))), { status: 200 })) as typeof fetch
  await getSpotPrices(Object.keys(PRICES))
})

beforeEach(() => {
  state.bots.length = 0
  state.trades.length = 0
  state.settings.mode = 'live'
  state.liveSpend = { day: '', usd: 0 }
  state.breaker = { tripped: false, reason: '', trippedAt: null, realizedUsd: 0, spentUsd: 0 }
  delete process.env.MAX_CUMULATIVE_LOSS_USD
  delete process.env.MAX_LIVE_USD_TOTAL
  delete process.env.MAX_LIVE_USD_PER_DAY
  delete process.env.MAX_FLEET_DRAWDOWN_PCT
  Object.assign(live, realLive)
  // Deep native balance so the gas-reserve guard never blocks these cap tests.
  live.nativeBalanceWei = (async () => 10n ** 30n) as typeof live.nativeBalanceWei
})
afterEach(() => Object.assign(live, realLive))

function freshBot() {
  const b = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000 })
  assert.ok(!('error' in b))
  return b as Exclude<ReturnType<typeof createBot>, { error: string }>
}

test('a live loss past MAX_CUMULATIVE_LOSS_USD trips the breaker and pauses LIVE bots — but NOT paper bots', async () => {
  process.env.MAX_CUMULATIVE_LOSS_USD = '30'
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 10n ** 30n) as typeof live.tokenBalanceBaseUnits // constant → unmeasurable delta → books paper qty
  const a = freshBot()
  const b = freshBot() // a second LIVE bot that must be paused on trip
  // A PAPER bot is a separate workspace with zero real risk — a LIVE breaker trip must
  // NOT collateral-pause it.
  state.settings.mode = 'paper'
  const paper = freshBot()
  state.settings.mode = 'live'
  execBuy(a, 10, 500, 'seed') // ~49.7 LINK @ ~$10 cost basis
  a.realHeld = (50n * 10n ** 18n).toString()
  // Liquidate the whole stack at $5 → ~ -$250 realized, far past the $30 loss cap.
  await settle(a, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 5)
  assert.equal(breakerState().tripped, true, 'breaker tripped on the cumulative loss')
  assert.equal(a.status, 'paused', 'the live trading bot is paused')
  assert.equal(b.status, 'paused', 'EVERY live bot is paused on a trip')
  assert.equal(paper.status, 'running', 'a PAPER bot is NOT paused by a live breaker trip')
})

test('a buy breaching MAX_LIVE_USD_TOTAL trips the breaker with NO fill', async () => {
  let swapCalled = false
  live.executeSwap = (async () => {
    swapCalled = true
    return '0xhash'
  }) as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 0n) as typeof live.tokenBalanceBaseUnits
  const bot = freshBot() // created before the cap exists (the creation guard only blocks NEW over-cap bots)
  process.env.MAX_LIVE_USD_TOTAL = '150' // operator lowers the lifetime ceiling after the bot is live
  state.breaker.spentUsd = 140
  await settle(bot, { type: 'buy', usd: 20, reason: 'x' }, 10) // 140 + 20 = 160 > 150
  assert.equal(breakerState().tripped, true, 'ceiling breach trips the breaker')
  assert.equal(swapCalled, false, 'no swap is attempted')
  assert.equal(bot.position.qty, 0, 'no phantom fill')
  assert.equal(state.trades.length, 0, 'no trade recorded')
})

test('a tripped breaker blocks any new buy', async () => {
  let swapCalled = false
  live.executeSwap = (async () => {
    swapCalled = true
    return '0xhash'
  }) as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 0n) as typeof live.tokenBalanceBaseUnits
  const bot = freshBot()
  state.breaker.tripped = true // breaker trips (e.g. from another live bot's loss) AFTER this bot exists
  state.breaker.reason = 'test'
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(swapCalled, false, 'a tripped breaker short-circuits before the chain')
  assert.equal(bot.position.qty, 0, 'no fill while halted')
})

test('a confirmed live buy increments the daily + lifetime spend accumulators by exactly the spend', async () => {
  let reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 0n : 1000n)) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(state.liveSpend.day, dayKey(), 'spend bucketed under today')
  assert.ok(Math.abs(state.liveSpend.usd - 100) < 1e-9, 'daily spend += the exact buy usd')
  assert.ok(Math.abs(state.breaker.spentUsd - 100) < 1e-9, 'lifetime spend += the exact buy usd')
  assert.ok(bot.position.qty > 0, 'the fill committed after on-chain confirm')
})

test('the daily cap SKIPS the buy — the bot stays running and the breaker does not trip', async () => {
  process.env.MAX_LIVE_USD_PER_DAY = '50'
  state.liveSpend = { day: dayKey(), usd: 0 }
  let swapCalled = false
  live.executeSwap = (async () => {
    swapCalled = true
    return '0xhash'
  }) as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 0n) as typeof live.tokenBalanceBaseUnits
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10) // 100 > the $50 daily cap
  assert.equal(swapCalled, false, 'a capped buy never reaches the chain')
  assert.equal(bot.status, 'running', 'the daily cap SKIPS — it must NOT pause the bot (resumes next day)')
  assert.equal(bot.position.qty, 0, 'no fill')
  assert.equal(breakerState().tripped, false, 'the daily cap does not trip the breaker')
})

test('resetBreaker clears the trip + accumulators but does NOT auto-resume paused bots', async () => {
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 0n) as typeof live.tokenBalanceBaseUnits
  const bot = freshBot()
  process.env.MAX_LIVE_USD_TOTAL = '150' // ceiling lowered after the bot is live
  state.breaker.spentUsd = 140
  await settle(bot, { type: 'buy', usd: 20, reason: 'x' }, 10) // trips on the ceiling
  assert.equal(bot.status, 'paused')
  assert.equal(breakerState().tripped, true)

  const r = resetBreaker()
  assert.equal(r.tripped, false, 'breaker cleared')
  assert.equal(r.realizedUsd, 0, 'realized accumulator zeroed')
  assert.equal(r.spentUsd, 0, 'spend accumulator zeroed')
  assert.equal(bot.status, 'paused', 're-arm does NOT auto-resume bots — the operator resumes intentionally')
})

test('INC-1: a paper market bot in live mode never touches the live breaker / caps', async () => {
  process.env.MAX_CUMULATIVE_LOSS_USD = '30'
  process.env.MAX_LIVE_USD_TOTAL = '150'
  let swapCalled = false
  live.executeSwap = (async () => {
    swapCalled = true
    return '0xhash'
  }) as typeof live.executeSwap
  const m = createBot({ network: 'market', token: 'PEPE', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000, cg: 'pepe' })
  assert.ok(!('error' in m))
  const bot = m as Exclude<typeof m, { error: string }>
  // A buy then a heavily-losing sell — all PAPER despite live mode.
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  await settle(bot, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 2)
  assert.equal(swapCalled, false, 'a market bot never reaches the chain')
  assert.equal(state.breaker.spentUsd, 0, 'no live spend accrued from a simulated bot')
  assert.equal(state.breaker.realizedUsd, 0, 'no live realized P&L accrued from a simulated bot')
  assert.equal(state.liveSpend.usd, 0, 'the daily cap is untouched')
  assert.equal(breakerState().tripped, false, 'a simulated loss does NOT trip the live breaker / pause real bots')
})

test('#3 the opt-in fleet drawdown cap trips when live equity falls past the % from its high-water mark', () => {
  process.env.MAX_FLEET_DRAWDOWN_PCT = '20'
  resetBreaker() // zero the high-water mark
  const a = freshBot() // live arbitrum bot, flat, cash = $1000 ⇒ equity = $1000
  checkFleetDrawdown() // establish the peak at full equity
  assert.equal(breakerState().tripped, false, 'no drawdown yet')
  a.cashUsd = 750 // simulate a 25% fleet loss (flat ⇒ equity = cash)
  checkFleetDrawdown()
  assert.equal(breakerState().tripped, true, '25% drawdown ≥ the 20% cap trips')
  assert.equal(a.status, 'paused', 'all live bots are paused on the drawdown trip')
})

test('#3 the fleet drawdown cap is OFF by default (no env) — never trips, even on a crash', () => {
  resetBreaker()
  const a = freshBot()
  checkFleetDrawdown()
  a.cashUsd = 100 // a 90% crash
  checkFleetDrawdown()
  assert.equal(breakerState().tripped, false, 'a disabled cap ignores any drawdown')
})

test('#1 a live STOP liquidation accrues its realized loss into the breaker and can trip the loss cap', async () => {
  // The accrual used to live ONLY in settle()'s strategy-sell path, so a loss realized
  // via controlBot('stop') — manual Stop, tournament end, auto-sniper/follow teardown —
  // was invisible to the cumulative-loss ceiling. It must now funnel through the breaker.
  process.env.MAX_CUMULATIVE_LOSS_USD = '30'
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 10n ** 30n) as typeof live.tokenBalanceBaseUnits // constant → unmeasurable delta → modeled proceeds on the paper qty
  const a = freshBot()
  execBuy(a, 20, 500, 'seed') // ~24.8 LINK @ ~$20 cost basis
  a.realHeld = (25n * 10n ** 18n).toString()
  const before = state.breaker.realizedUsd
  await controlBot(a.id, 'stop') // live full-exit at spot $10 → ≈ −$250 realized
  assert.ok(state.breaker.realizedUsd < before - 100, `the stop loss accrued into the breaker (Δ ${state.breaker.realizedUsd - before})`)
  assert.equal(breakerState().tripped, true, 'the forced-stop loss tripped the cumulative-loss cap')
  assert.equal(a.status, 'stopped', 'the bot is stopped after a successful liquidation')
})

test('MONEY-1: concurrent same-tick live buys cannot overshoot the lifetime ceiling (check-then-act race)', async () => {
  // A slow swap keeps BOTH buys in flight at the await simultaneously — the exact
  // window where a check-then-act gate would let them both pass.
  live.executeSwap = (async () => {
    await new Promise((r) => setTimeout(r, 10))
    return '0xhash'
  }) as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 0n) as typeof live.tokenBalanceBaseUnits
  const b1 = freshBot()
  const b2 = freshBot()
  process.env.MAX_LIVE_USD_TOTAL = '150' // ceiling set after both bots exist (each $1000 budget)
  // Each wants $100 → combined $200 > the $150 ceiling. At most one may commit.
  await Promise.all([
    settle(b1, { type: 'buy', usd: 100, reason: 'x' }, 10),
    settle(b2, { type: 'buy', usd: 100, reason: 'x' }, 10),
  ])
  assert.ok(state.breaker.spentUsd <= 150, `lifetime spend must NEVER exceed the $150 ceiling, got $${state.breaker.spentUsd}`)
  assert.ok(Math.abs(state.breaker.spentUsd - 100) < 1e-9, `exactly one buy committed (the other reserved-out), got $${state.breaker.spentUsd}`)
  assert.equal(breakerState().tripped, true, 'the second buy tripped the breaker on the ceiling')
})

test('a live bot whose budget exceeds the lifetime ceiling is REJECTED at creation (not shipped dead-on-arrival)', () => {
  process.env.MAX_LIVE_USD_TOTAL = '150'
  const over = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 200 })
  assert.ok('error' in over && /lifetime live-spend ceiling/i.test(over.error), `over-ceiling live bot is rejected: ${JSON.stringify(over)}`)
  // A paper bot of the same size is fine — the live ceiling only governs REAL spend.
  state.settings.mode = 'paper'
  const paper = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 200 })
  assert.ok(!('error' in paper), 'a paper bot ignores the live ceiling')
})

test('a new live bot is REJECTED while the circuit breaker is already tripped', () => {
  state.breaker.tripped = true
  state.breaker.reason = 'loss cap'
  const r = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 50 })
  assert.ok('error' in r && /halted|re-arm/i.test(r.error), `creating a live bot while halted is rejected: ${JSON.stringify(r)}`)
})
