// P1-3: a live BUY must keep enough native in the wallet to pay the gas to SELL
// out later — otherwise a bot can spend its native down and strand a position it
// can no longer afford to exit. The buy is refused (bot paused) rather than left
// as a fill we couldn't unwind. Driven through settle() with injected executors.
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-gas-'))
process.env.ZEROX_API_KEY = 'test-key'
process.env.BOT_WALLET_KEY = '0x' + '1'.repeat(64)

const PRICES: Record<string, number> = { ethereum: 2000, chainlink: 10, tether: 1 }

const { state } = await import('../src/store.js')
const { createBot, __test } = await import('../src/engine.js')
const { getSpotPrices } = await import('../src/prices.js')
const { settle, live } = __test
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
  delete process.env.GAS_RESERVE_MULT
  Object.assign(live, realLive)
})
afterEach(() => Object.assign(live, realLive))

function freshBot() {
  const b = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000 })
  assert.ok(!('error' in b))
  return b as Exclude<ReturnType<typeof createBot>, { error: string }>
}

test('a live buy is REFUSED (paused, no fill) when no native gas reserve would remain', async () => {
  let swapCalled = false
  live.executeSwap = (async () => {
    swapCalled = true
    return '0xhash'
  }) as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 0n) as typeof live.tokenBalanceBaseUnits
  // $100 at $2000/ETH = 0.05 ETH. Wallet holds EXACTLY 0.05 ETH → nothing left for
  // gas → the buy must be refused (any positive reserve exceeds the remainder).
  live.nativeBalanceWei = (async () => 50_000_000_000_000_000n) as typeof live.nativeBalanceWei
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(swapCalled, false, 'no swap attempted without a gas reserve')
  assert.equal(bot.position.qty, 0, 'no fill')
  assert.equal(bot.status, 'paused', 'paused so the operator funds more native')
})

test('the same buy SUCCEEDS once the wallet holds the buy amount plus a reserve', async () => {
  let reads = 0
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 0n : 1000n)) as typeof live.tokenBalanceBaseUnits
  live.nativeBalanceWei = (async () => 10n ** 18n) as typeof live.nativeBalanceWei // 1 ETH — ample
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.ok(bot.position.qty > 0, 'fill committed')
  assert.equal(bot.status, 'running')
})

test('GAS_RESERVE_MULT widens the reserve (a larger buffer is demanded)', async () => {
  process.env.GAS_RESERVE_MULT = '100000' // absurd reserve to force a refusal
  let swapCalled = false
  live.executeSwap = (async () => {
    swapCalled = true
    return '0xhash'
  }) as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 0n) as typeof live.tokenBalanceBaseUnits
  live.nativeBalanceWei = (async () => 10n ** 18n) as typeof live.nativeBalanceWei // 1 ETH — ample for gas normally
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(swapCalled, false, 'an inflated reserve refuses even a well-funded buy')
  assert.equal(bot.status, 'paused')
})
