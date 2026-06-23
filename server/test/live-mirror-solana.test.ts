// UT-1: the Solana branch of mirrorLive (sell clamp, SOL gas reserve, full-exit) is
// a hand-duplicated copy of the EVM branch with its own money-critical logic. The
// EVM equivalents are well-tested; this guards the Solana branch against divergence.
// Driven through settle() with the Solana executors injected via the __test.live seam.
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-sol-'))
process.env.SOLANA_WALLET_KEY = bs58.encode(Keypair.generate().secretKey) // valid key (presence only — executors are overridden below)

const PRICES: Record<string, number> = { solana: 150, 'jupiter-exchange-solana': 1, tether: 1 }

const { state } = await import('../src/store.js')
const { createBot, __test } = await import('../src/engine.js')
const { getSpotPrices } = await import('../src/prices.js')
const { SOL_MINT } = await import('../src/live-solana.js')
const { settle, live, execBuy } = __test

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
  Object.assign(live, realLive)
  live.solanaLiveReady = (() => true) as typeof live.solanaLiveReady
})
afterEach(() => Object.assign(live, realLive))

function solBot() {
  const b = createBot({ network: 'solana', token: 'JUP', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000 })
  assert.ok(!('error' in b))
  return b as Exclude<ReturnType<typeof createBot>, { error: string }>
}

test('UT-1: a Solana full-exit sell clamps to THIS bot’s attributed holdings, not the shared wallet', async () => {
  const a = solBot()
  execBuy(a, 1, 500, 'seed') // ~499 JUP on the book
  a.realHeld = (60n * 10n ** 6n).toString() // 60 JUP (6 dp) attributed to this bot
  let sold: bigint | undefined
  live.splTokenBalanceBaseUnits = (async () => 200n * 10n ** 6n) as typeof live.splTokenBalanceBaseUnits // wallet aggregate 200 JUP
  live.executeSolanaSwap = (async (o: { amountBaseUnits: bigint }) => {
    sold = o.amountBaseUnits
    return 'sig'
  }) as typeof live.executeSolanaSwap
  await settle(a, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 1)
  assert.equal(sold, 60n * 10n ** 6n, 'clamped to A’s 60 JUP, never the 200 shared-wallet aggregate')
})

test('P1-2: a Solana live buy books the REAL SOL outflow (input + fees) to the spend caps, not the intended USD', async () => {
  const bot = solBot()
  // SOL reads: #0 = reserve check (5 SOL), #1 = post-swap after-read (4.32 SOL) → 0.68 SOL out.
  // 0.68 SOL × $150 = $102 measured outflow — MORE than the intended $100 (fees), proving it's measured.
  let solReads = 0
  let jupReads = 0
  live.splTokenBalanceBaseUnits = (async (mint: string) =>
    mint === SOL_MINT
      ? (solReads++ === 0 ? 5_000_000_000n : 4_320_000_000n)
      : (jupReads++ === 0 ? 0n : 50_000_000n)) as typeof live.splTokenBalanceBaseUnits
  live.executeSolanaSwap = (async () => 'sig') as typeof live.executeSolanaSwap
  await settle(bot, { type: 'buy', usd: 100, reason: 'in' }, 1)
  assert.ok(bot.position.qty > 0, 'fill committed')
  assert.ok(Math.abs(state.liveSpend.usd - 102) < 1e-6, `daily cap = measured SOL outflow $102, got ${state.liveSpend.usd}`)
  assert.ok(Math.abs(state.breaker.spentUsd - 102) < 1e-6, `lifetime spend = measured outflow, got ${state.breaker.spentUsd}`)
})

test('UT-1: a Solana buy is REFUSED when the SOL balance leaves no gas reserve', async () => {
  const bot = solBot()
  let swapCalled = false
  live.executeSolanaSwap = (async () => {
    swapCalled = true
    return 'sig'
  }) as typeof live.executeSolanaSwap
  // $100 at $150/SOL ≈ 0.6667 SOL. Wallet holds EXACTLY that → no lamports left for gas.
  live.splTokenBalanceBaseUnits = (async () => 666_666_666n) as typeof live.splTokenBalanceBaseUnits
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 1)
  assert.equal(swapCalled, false, 'no Jupiter swap without a SOL gas reserve')
  assert.equal(bot.position.qty, 0, 'no fill')
  assert.equal(bot.status, 'paused', 'paused so the operator funds more SOL')
})

test('UT-1: a funded Solana buy fills and credits realHeld from the measured SPL delta', async () => {
  const bot = solBot()
  let reads = 0
  // gas-reserve read (ample SOL), then token before (0) / after (100 JUP).
  live.splTokenBalanceBaseUnits = (async (mint: string) => {
    if (mint === 'So11111111111111111111111111111111111111112') return 10n ** 12n // 1000 SOL — ample
    return reads++ === 0 ? 0n : 100n * 10n ** 6n // JUP: before 0, after 100
  }) as typeof live.splTokenBalanceBaseUnits
  live.executeSolanaSwap = (async () => 'sig') as typeof live.executeSolanaSwap
  await settle(bot, { type: 'buy', usd: 100, reason: 'in' }, 1)
  assert.ok(bot.position.qty > 0, 'fill committed')
  assert.equal(bot.realHeld, (100n * 10n ** 6n).toString(), 'realHeld = the measured 100 JUP received')
})

test('UT-1/MP-1: a Solana sell books realized P&L from the MEASURED SOL received, not the quote', async () => {
  const bot = solBot()
  execBuy(bot, 1, 500, 'seed') // ~497 JUP @ ~$1, cost basis $500
  bot.realHeld = (500n * 10n ** 6n).toString()
  let sol = 0
  let jup = 0
  live.splTokenBalanceBaseUnits = (async (mint: string) =>
    mint === 'So11111111111111111111111111111111111111112'
      ? (sol++ === 0 ? 1_000_000_000n : 4_000_000_000n) // SOL sweep: 1 → 4 SOL = +3 SOL = $450 @ $150
      : (jup++ === 0 ? 500n * 10n ** 6n : 0n)) as typeof live.splTokenBalanceBaseUnits // JUP: before 500, after 0
  live.executeSolanaSwap = (async () => 'sig') as typeof live.executeSolanaSwap
  await settle(bot, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 1)
  // measured $450 SOL proceeds − $500 cost ≈ −$50, NOT the quote-based ≈ −$7.
  assert.ok(bot.stats.realizedUsd < -20 && bot.stats.realizedUsd > -120, `realized tracks the measured $450 SOL proceeds (~−$50), got ${bot.stats.realizedUsd}`)
})
