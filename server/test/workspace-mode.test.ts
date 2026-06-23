// Per-bot WORKSPACE mode: each bot runs in its OWN mode (set at creation), NOT the
// global view toggle. The headline safety property: a PAPER bot can never be flipped
// to live-trade by switching the active workspace to Live. The monthly ledger is also
// segregated by the bot's own mode so the Live view never mixes in paper history.
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-ws-'))
// Presence is all liveReady() checks; the real executor is overridden via the seam.
process.env.ZEROX_API_KEY = 'test-key'
process.env.BOT_WALLET_KEY = '0x' + '1'.repeat(64)

const PRICES: Record<string, number> = { ethereum: 2000, chainlink: 10, tether: 1 }

const { state, monthKey } = await import('../src/store.js')
const { createBot, requestWithdrawal, profitVault, __test } = await import('../src/engine.js')
const { getSpotPrices } = await import('../src/prices.js')
const { settle, execBuy, execSell, live } = __test
const realLive = { ...live }
const EVM_ADDR = '0x' + 'a'.repeat(40)

before(async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { usd: v }]))), { status: 200 })) as typeof fetch
  await getSpotPrices(Object.keys(PRICES)) // seed spot() so a live buy can be sized
})

beforeEach(() => {
  state.bots.length = 0
  state.trades.length = 0
  state.monthly = { paper: {}, live: {} }
  state.settings.mode = 'paper'
  Object.assign(live, realLive)
  // Deep native balance so the live gas-reserve guard never blocks a test buy.
  live.nativeBalanceWei = (async () => 10n ** 30n) as typeof live.nativeBalanceWei
})

function freshBot() {
  const b = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000 })
  assert.ok(!('error' in b), 'bot created')
  return b as Exclude<ReturnType<typeof createBot>, { error: string }>
}

test('createBot stamps the bot with the ACTIVE workspace mode', () => {
  state.settings.mode = 'paper'
  assert.equal(freshBot().mode, 'paper')
  state.settings.mode = 'live'
  assert.equal(freshBot().mode, 'live')
})

test('SAFETY: a PAPER bot never live-trades, even when the active workspace is flipped to LIVE', async () => {
  state.settings.mode = 'paper'
  const bot = freshBot()
  assert.equal(bot.mode, 'paper')
  // User switches the VIEW to the live workspace. The paper bot must keep simulating.
  state.settings.mode = 'live'
  let swapCalled = false
  live.executeSwap = (async () => {
    swapCalled = true
    return '0xhash'
  }) as typeof live.executeSwap
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(swapCalled, false, 'paper bot must NOT hit the on-chain executor')
  assert.ok(bot.position.qty > 0, 'a paper fill still happened')
  assert.equal(bot.realHeld ?? '0', '0', 'no real on-chain holdings booked for a paper bot')
  assert.equal(state.trades[state.trades.length - 1].mode, 'paper', 'the trade is recorded as paper')
})

test('a LIVE bot (created in the live workspace) DOES execute on-chain', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  assert.equal(bot.mode, 'live')
  let swapCalled = false
  live.executeSwap = (async () => {
    swapCalled = true
    return '0xhash'
  }) as typeof live.executeSwap
  let reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 0n : 1000n)) as typeof live.tokenBalanceBaseUnits
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(swapCalled, true, 'a live bot hits the on-chain executor')
  assert.equal(bot.realHeld, '1000', 'realHeld credited from the measured on-chain delta')
})

test('a LIVE bot still trades even while the user is VIEWING the paper workspace', async () => {
  state.settings.mode = 'live'
  const bot = freshBot() // mode === 'live'
  state.settings.mode = 'paper' // user flips the view back to paper
  let swapCalled = false
  live.executeSwap = (async () => {
    swapCalled = true
    return '0xhash'
  }) as typeof live.executeSwap
  let reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 0n : 1000n)) as typeof live.tokenBalanceBaseUnits
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(swapCalled, true, 'a live bot executes on-chain regardless of the active view')
})

test('the monthly ledger is segregated by the BOT mode, not the active view', () => {
  // Paper bot → a winning round trip lands in monthly.paper.
  state.settings.mode = 'paper'
  const paperBot = freshBot()
  execBuy(paperBot, 10, 500, 'in')
  execSell(paperBot, 12, 1, 'out', true)
  // Live bot → a losing round trip lands in monthly.live. (execBuy/execSell are the
  // paper-commit primitives; they attribute to bot.mode without on-chain mirroring.)
  state.settings.mode = 'live'
  const liveBot = freshBot()
  execBuy(liveBot, 10, 500, 'in')
  execSell(liveBot, 8, 1, 'out', true)

  const mk = monthKey(Date.now())
  assert.ok(state.monthly.paper[mk]?.realizedUsd > 0, 'paper bot P&L in the PAPER ledger')
  assert.equal(state.monthly.paper[mk].wins, 1)
  assert.ok(state.monthly.live[mk]?.realizedUsd < 0, 'live bot P&L in the LIVE ledger')
  assert.equal(state.monthly.live[mk].losses, 1)
  // No cross-contamination.
  assert.equal(state.monthly.paper[mk].losses, 0, 'paper ledger has no live losses')
  assert.equal(state.monthly.live[mk].wins, 0, 'live ledger has no paper wins')
})

test('SAFETY: a paper bot\'s swept profit is banked to the PAPER vault and can NEVER be withdrawn as real funds in the live workspace', async () => {
  // Paper bot banks profit → lands ONLY in the paper vault.
  state.settings.mode = 'paper'
  const paperBot = freshBot()
  execBuy(paperBot, 10, 500, 'in')
  execSell(paperBot, 13, 1, 'out', true) // a winning sell sweeps profit to ETH on arbitrum
  assert.ok((state.vault['arbitrum:native:paper'] ?? 0) > 0, 'paper profit banked to the PAPER vault')
  assert.equal(state.vault['arbitrum:native:live'], undefined, 'nothing banked to the live vault')
  // Paper workspace can simulate withdrawing it.
  assert.ok(profitVault().some((r) => r.network === 'arbitrum'), 'paper workspace shows the banked profit')

  // Switch to the LIVE workspace: the paper profit is INVISIBLE and UN-withdrawable —
  // it can never be paid out as real on-chain funds. (This is the confirmed-bug regression.)
  state.settings.mode = 'live'
  assert.equal(profitVault().length, 0, 'live workspace shows NO banked profit (paper profit is hidden)')
  const out = await requestWithdrawal({ network: 'arbitrum', asset: 'native', amountQty: 0.0001, toAddress: EVM_ADDR })
  assert.ok('error' in out, 'a live withdrawal cannot touch paper-earned profit')
})
