// Live-execution reconciliation: the paper ledger may only advance when the
// on-chain swap actually confirms. These tests drive `settle()` with injected
// fake executors (via the __test.live seam) so no real network round-trip runs.
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-live-'))
// Presence is all liveReady() checks; the real executors are overridden below.
process.env.ZEROX_API_KEY = 'test-key'
process.env.BOT_WALLET_KEY = '0x' + '1'.repeat(64)

const PRICES: Record<string, number> = { ethereum: 2000, chainlink: 10, tether: 1 }

const { state } = await import('../src/store.js')
const { createBot, controlBot, __test } = await import('../src/engine.js')
const { getSpotPrices, __test: pricesTest } = await import('../src/prices.js')
const { networkById } = await import('../src/networks.js')
const { settle, live, runExclusive, execBuy, reconcileRealHeld, curHeld, tickBot } = __test

const realLive = { ...live }

before(async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { usd: v }]))), { status: 200 })) as typeof fetch
  await getSpotPrices(Object.keys(PRICES))
})

beforeEach(() => {
  state.bots.length = 0
  state.trades.length = 0
  state.settings.mode = 'paper'
  Object.assign(live, realLive) // restore real (unused — overridden per test)
  // Default a deep native balance so the gas-reserve guard never blocks a buy
  // here; the dedicated gas-reserve test overrides this.
  live.nativeBalanceWei = (async () => 10n ** 30n) as typeof live.nativeBalanceWei
})
afterEach(() => Object.assign(live, realLive))

function freshBot() {
  const bot = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000 })
  assert.ok(!('error' in bot))
  return bot as Exclude<ReturnType<typeof createBot>, { error: string }>
}

test('paper mode never touches the on-chain executor', async () => {
  let called = false
  live.executeSwap = (async () => {
    called = true
    return '0xhash'
  }) as typeof live.executeSwap
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(called, false, 'executeSwap not called in paper mode')
  assert.ok(bot.position.qty > 0, 'paper position opened')
})

test('live buy commits the paper fill only after the swap confirms, and credits realHeld from the REAL delta', async () => {
  state.settings.mode = 'live'
  let sellAmount: bigint | undefined
  live.executeSwap = (async (o: { sellAmountBaseUnits: bigint }) => {
    sellAmount = o.sellAmountBaseUnits
    return '0xhash'
  }) as typeof live.executeSwap
  // before-read 0, after-read 1000 base units actually received on-chain.
  let reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 0n : 1000n)) as typeof live.tokenBalanceBaseUnits
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.ok(bot.position.qty > 0, 'paper buy committed after confirm')
  assert.equal(bot.status, 'running')
  assert.equal(state.trades.length, 1)
  // realHeld is the REAL measured delta (1000), not the paper qty estimate.
  assert.equal(bot.realHeld, '1000', 'realHeld credited from the measured on-chain delta')
  // native-in sizing: $100 / $2000 ETH = 0.05 ETH (18 decimals; allow sub-wei
  // float noise from toFixed(18))
  const diff = (sellAmount ?? 0n) - 50_000_000_000_000_000n
  assert.ok(diff > -1000n && diff < 1000n, `~0.05 ETH sized, got ${sellAmount}`)
})

test('P0-1: a live buy books the REAL on-chain qty + avg cost, not the quote estimate', async () => {
  state.settings.mode = 'live'
  // $100 buy quoted at $10 → a naive estimate would book ~10 LINK. But the (thin)
  // pool only delivers 4 LINK on-chain (slippage). The ledger must reflect the REAL
  // 4 received at a real $25 entry — not the rosy quote.
  let reads = 0
  const received = 4n * 10n ** 18n // 4 LINK (18 dp)
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 0n : received)) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'in' }, 10)
  assert.ok(Math.abs(bot.position.qty - 4) < 1e-9, `position = real 4 LINK, got ${bot.position.qty}`)
  assert.ok(Math.abs(bot.position.avgCostUsd - 25) < 1e-6, `avgCost = $25 real entry ($100/4), got ${bot.position.avgCostUsd}`)
  assert.equal(bot.realHeld, received.toString(), 'realHeld = the measured on-chain delta')
  const t = state.trades[state.trades.length - 1]
  assert.ok(Math.abs(t.qty - 4) < 1e-9 && Math.abs(t.priceUsd - 25) < 1e-6, 'trade records the real fill (qty 4 @ $25)')
})

test('P1-9: a sniper with a STALE pool price force-exits at the last-known price', async () => {
  state.settings.mode = 'paper'
  state.bots.length = 0
  state.trades.length = 0
  const gt = networkById('base')!.gt
  const POOL = '0x' + '7'.repeat(40)
  // Seed a cached pool price fetched 200s ago — past the 90s freshness ceiling → "stale".
  pricesTest.setPool(gt, POOL, 5, Date.now() - 200_000)
  const bot: any = {
    id: 'snipe1', name: 'snipe', network: 'base', token: 'RUG', strategy: 'sniper', risk: 'aggressive',
    budgetUsd: 100, cashUsd: 0, status: 'running',
    schedule: { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
    pool: { poolAddress: POOL, tokenAddress: '0x' + '8'.repeat(40), decimals: 18 },
    sniper: { takeProfitPct: 50, stopLossPct: 25, maxHoldMin: 30 },
    mode: 'paper',
    position: { qty: 10, avgCostUsd: 6, costUsd: 60, openedAt: Date.now() },
    state: {}, stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 },
    equityHistory: [], log: [], createdAt: Date.now(), lastTickAt: 0,
  }
  state.bots.push(bot)
  await tickBot(bot)
  assert.equal(bot.position.qty, 0, 'force-exited the position despite no fresh price')
  assert.ok(state.trades.some((t) => t.botId === 'snipe1' && t.side === 'sell'), 'a protective sell was booked at the last-known price')
})

test('P1-2: a live buy books the REAL native outflow (input + gas) to the spend caps, not the intended USD', async () => {
  state.settings.mode = 'live'
  state.liveSpend = { day: '', usd: 0 }
  state.breaker = { tripped: false, reason: '', trippedAt: null, realizedUsd: 0, spentUsd: 0 }
  let tok = 0
  live.tokenBalanceBaseUnits = (async () => (tok++ === 0 ? 0n : 4n * 10n ** 18n)) as typeof live.tokenBalanceBaseUnits
  // native reads: #0 = reserve check (1 ETH), #1 = post-swap after-read (1 ETH − 0.0505 ETH).
  // 0.05 ETH is the $100 input; the extra 0.0005 ETH is gas — REAL outflow the cap must capture.
  let nat = 0
  live.nativeBalanceWei = (async () => (nat++ === 0 ? 10n ** 18n : 10n ** 18n - 505n * 10n ** 14n)) as typeof live.nativeBalanceWei
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'in' }, 10)
  // 0.0505 ETH × $2000 = $101 measured outflow — MORE than the intended $100, proving it's measured.
  assert.ok(Math.abs(state.liveSpend.usd - 101) < 1e-6, `daily cap = measured native outflow $101, got ${state.liveSpend.usd}`)
  assert.ok(Math.abs(state.breaker.spentUsd - 101) < 1e-6, `lifetime spend = measured outflow, got ${state.breaker.spentUsd}`)
})

test('P1-2: an unmeasurable native read (constant balance) falls back to the intended USD — never mis-books', async () => {
  state.settings.mode = 'live'
  state.liveSpend = { day: '', usd: 0 }
  state.breaker = { tripped: false, reason: '', trippedAt: null, realizedUsd: 0, spentUsd: 0 }
  let tok = 0
  live.tokenBalanceBaseUnits = (async () => (tok++ === 0 ? 0n : 4n * 10n ** 18n)) as typeof live.tokenBalanceBaseUnits
  live.nativeBalanceWei = (async () => 10n ** 30n) as typeof live.nativeBalanceWei // constant → before===after → unmeasurable
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'in' }, 10)
  assert.ok(Math.abs(state.liveSpend.usd - 100) < 1e-6, `falls back to intended $100, got ${state.liveSpend.usd}`)
})

test('live buy failure pauses the bot and commits NO paper fill', async () => {
  state.settings.mode = 'live'
  live.tokenBalanceBaseUnits = (async () => 0n) as typeof live.tokenBalanceBaseUnits // before-read succeeds
  live.executeSwap = (async () => {
    throw new Error('0x: no liquidity')
  }) as typeof live.executeSwap
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(bot.position.qty, 0, 'no phantom position')
  assert.equal(bot.cashUsd, 1000, 'cash untouched')
  assert.equal(state.trades.length, 0, 'no trade recorded')
  assert.equal(bot.realHeld ?? '0', '0', 'no realHeld credit on a failed buy')
  assert.equal(bot.status, 'paused', 'bot halted for review')
})

test('live sell failure keeps the paper position intact', async () => {
  state.settings.mode = 'live'
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 10n ** 30n) as typeof live.tokenBalanceBaseUnits
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'in' }, 10) // open a position live
  const qtyBefore = bot.position.qty
  assert.ok(qtyBefore > 0)
  live.executeSwap = (async () => {
    throw new Error('swap reverted')
  }) as typeof live.executeSwap
  await settle(bot, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 11)
  assert.equal(bot.position.qty, qtyBefore, 'position retained after failed sell')
  assert.equal(bot.status, 'paused')
})

test('live sell is clamped to the real on-chain balance', async () => {
  state.settings.mode = 'live'
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 10n ** 30n) as typeof live.tokenBalanceBaseUnits
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 500, reason: 'in' }, 10)
  const paperQty = bot.position.qty
  let sold: bigint | undefined
  // Wallet really holds only a tiny fraction of the paper position.
  live.tokenBalanceBaseUnits = (async () => 7n) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async (o: { sellAmountBaseUnits: bigint }) => {
    sold = o.sellAmountBaseUnits
    return '0xhash'
  }) as typeof live.executeSwap
  await settle(bot, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 12)
  assert.equal(sold, 7n, 'clamped to the wallet balance, not the paper qty')
  assert.ok(paperQty > 0)
})

test('MP-1: live realized P&L is derived from the MEASURED native received, not the quote price', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  execBuy(bot, 100, 1000, 'seed') // ~9.94 LINK @ ~$100.6 avg, cost basis $1000, cash $0
  bot.realHeld = (10n * 10n ** 18n).toString()
  // Token side: before 10, after ~0.06 → ~9.94 sold (full exit).
  let tok = 0
  live.tokenBalanceBaseUnits = (async () => (tok++ === 0 ? 10n * 10n ** 18n : 6n * 10n ** 16n)) as typeof live.tokenBalanceBaseUnits
  // Native sweep: 1 ETH → 1.45 ETH = 0.45 ETH received = $900 @ $2000. That's a THIN
  // exit far below the ~$994 quote gross — realized P&L must reflect $900, not the quote.
  let nat = 0
  live.nativeBalanceWei = (async () => (nat++ === 0 ? 10n ** 18n : 145n * 10n ** 16n)) as typeof live.nativeBalanceWei
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  await settle(bot, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 100)
  // measured proceeds $900 − cost basis $1000 ≈ −$100, NOT the quote-based ≈ −$12.
  assert.ok(bot.stats.realizedUsd < -50 && bot.stats.realizedUsd > -150, `realized tracks the measured $900 proceeds (~−$100), got ${bot.stats.realizedUsd}`)
  const t = state.trades[state.trades.length - 1]
  assert.ok(Math.abs(t.usd - 994) < 6, `gross notional = sellQty × price (~$994), got ${t.usd}`)
  assert.ok(t.feeUsd > 80, `feeUsd is the IMPLIED real cost (gross − measured proceeds ≈ $94), got ${t.feeUsd}`)
})

test('SPEND-CAP: a CONFIRMED buy whose post-swap read fails STILL books the spend (cap can never under-count a real spend)', async () => {
  state.settings.mode = 'live'
  const spentBefore = state.breaker.spentUsd
  let reads = 0
  // before-read OK (0); the swap CONFIRMS; the post-swap balance read then throws (RPC blip).
  live.tokenBalanceBaseUnits = (async () => {
    if (reads++ === 0) return 0n
    throw new Error('RPC timeout on post-swap read')
  }) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(bot.status, 'running', 'a CONFIRMED swap must NOT pause just because measurement failed')
  assert.ok(bot.position.qty > 0, 'paper fill committed at the estimate (the swap confirmed)')
  assert.equal(bot.state.realHeldUntrusted, true, 'unmeasurable confirmed fill flagged for reconcile')
  assert.ok(Math.abs(state.breaker.spentUsd - spentBefore - 100) < 1e-6, 'the confirmed $100 is booked to the live-spend cap, not silently dropped')
})

test('SPEND-DURABILITY: a confirmed live buy FLUSHES the spend accounting to disk (cap survives a crash before settle returns)', async () => {
  state.settings.mode = 'live'
  const spentBefore = state.breaker.spentUsd
  let reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 0n : 1000n)) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  await settle(freshBot(), { type: 'buy', usd: 100, reason: 'x' }, 10)
  // The ON-DISK state.json must already reflect the +$100 spend (flushed the instant it
  // was booked), not just the in-memory state — so a SIGKILL after this can't under-count
  // the live-spend cap on restart.
  const persisted = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR!, 'state.json'), 'utf8'))
  assert.ok(Math.abs(persisted.breaker.spentUsd - spentBefore - 100) < 1e-6, `persisted breaker.spentUsd reflects the confirmed $100, got ${persisted.breaker.spentUsd}`)
  assert.ok(Math.abs(persisted.liveSpend.usd - state.liveSpend.usd) < 1e-6, 'persisted liveSpend matches the in-memory daily spend')
})

test('BREAKER: a live native-sweep sell during a STALE price still books MEASURED proceeds (real exit impact reaches the breaker)', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  execBuy(bot, 100, 1000, 'seed') // ~9.94 LINK, cost basis $1000
  bot.realHeld = (10n * 10n ** 18n).toString()
  let tok = 0
  live.tokenBalanceBaseUnits = (async () => (tok++ === 0 ? 10n * 10n ** 18n : 6n * 10n ** 16n)) as typeof live.tokenBalanceBaseUnits
  // THIN exit: only 0.45 ETH = $900 received, far below the ~$994 quote gross.
  let nat = 0
  live.nativeBalanceWei = (async () => (nat++ === 0 ? 10n ** 18n : 145n * 10n ** 16n)) as typeof live.nativeBalanceWei
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  pricesTest.expireSpot() // simulate a CoinGecko 429 backoff → spotStale() === true
  await settle(bot, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 100)
  pricesTest.freshenSpot() // restore BEFORE asserting so a failure can't leave the feed stale for later tests
  // Before the fix a stale feed discarded the measured proceeds → impact-blind modeled ≈ −$12.
  // Now the real $900 received is valued at the last-known native price → ≈ −$100 reaches the breaker.
  assert.ok(bot.stats.realizedUsd < -50 && bot.stats.realizedUsd > -150, `breaker-fed realized tracks the measured $900 even when stale, got ${bot.stats.realizedUsd}`)
})

test('MP-2: a full STOP liquidates the REAL wallet holdings, not just the paper book qty (no stranding)', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  seedPosition(bot) // ~49.9 LINK on the book
  bot.realHeld = (60n * 10n ** 18n).toString() // wallet actually holds MORE than the book (untrusted-low buy / rebase)
  let reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 60n * 10n ** 18n : 0n)) as typeof live.tokenBalanceBaseUnits
  let sold: bigint | undefined
  live.executeSwap = (async (o: { sellAmountBaseUnits: bigint }) => {
    sold = o.sellAmountBaseUnits
    return '0xhash'
  }) as typeof live.executeSwap
  await controlBot(bot.id, 'stop')
  assert.equal(sold, 60n * 10n ** 18n, 'a full exit sells the real wallet balance (60), not the ~49.9 paper qty')
})

test('MP-2 regression: an UNTRUSTED full exit on a SHARED wallet never drains a co-tenant bot', async () => {
  state.settings.mode = 'live'
  const a = freshBot()
  const b = freshBot()
  seedPosition(a) // ~49.9 LINK each (paper)
  seedPosition(b)
  // reconcileRealHeld flags BOTH untrusted — a shared balance can't be split per-bot.
  a.realHeld = (50n * 10n ** 18n).toString()
  a.state.realHeldUntrusted = true
  b.realHeld = (50n * 10n ** 18n).toString()
  b.state.realHeldUntrusted = true
  let sold: bigint | undefined
  live.tokenBalanceBaseUnits = (async () => 100n * 10n ** 18n) as typeof live.tokenBalanceBaseUnits // shared wallet = 100 LINK (A + B)
  live.executeSwap = (async (o: { sellAmountBaseUnits: bigint }) => {
    sold = o.sellAmountBaseUnits
    return '0xhash'
  }) as typeof live.executeSwap
  await settle(a, { type: 'sell', fraction: 1, reason: 'stop-loss', exit: true }, 10) // A's full exit
  assert.ok((sold ?? 0n) <= 50n * 10n ** 18n, `A sells only its OWN ~49.9 LINK, never the 100-LINK shared wallet — got ${sold}`)
})

test('EXIT-2: a clamped live exit latches a force-exit and clears it once the residual is flat', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  seedPosition(bot) // ~49.9 LINK on the book
  bot.realHeld = (5n * 10n ** 18n).toString() // wallet only has 5 — a thin partial fill
  let reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 5n * 10n ** 18n : 0n)) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  await settle(bot, { type: 'sell', fraction: 1, reason: 'stop-loss', exit: true }, 10)
  assert.ok(bot.position.qty > 0, 'a residual survives the clamped exit')
  assert.equal(bot.state.forceExit, true, 'force-exit latched to retry the remainder')

  // Next tick: the rest of the wallet is now sellable → the forced exit clears.
  bot.realHeld = (45n * 10n ** 18n).toString()
  reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 45n * 10n ** 18n : 0n)) as typeof live.tokenBalanceBaseUnits
  await settle(bot, { type: 'sell', fraction: 1, reason: 'Force-exit unsold residual', exit: true }, 10)
  assert.equal(bot.position.qty, 0, 'residual fully closed')
  assert.equal(bot.state.forceExit, undefined, 'force-exit flag cleared when flat')
})

test('UT-2: a live PARTIAL-fraction sell (grid rung) books only the measured half — no force-exit', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  let reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 0n : 10n ** 19n)) as typeof live.tokenBalanceBaseUnits // buy: 0 → 10 tokens
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  await settle(bot, { type: 'buy', usd: 100, reason: 'in' }, 10)
  const qtyAfterBuy = bot.position.qty
  assert.ok(qtyAfterBuy > 9, '~10 tokens booked from the measured fill')
  // Sell HALF: measured delta = 5 tokens.
  reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 10n ** 19n : 5n * 10n ** 18n)) as typeof live.tokenBalanceBaseUnits
  await settle(bot, { type: 'sell', fraction: 0.5, reason: 'rung', exit: false }, 10)
  assert.ok(Math.abs(bot.position.qty - qtyAfterBuy / 2) < 0.2, 'exactly the residual half remains on the book')
  assert.equal(bot.realHeld, (5n * 10n ** 18n).toString(), 'realHeld debited by the measured 5 sold')
  assert.equal(bot.state.forceExit, undefined, 'a partial NON-exit sell never latches a force-exit')
})

test('UT-3: a live manual STOP books realized P&L + native swept from the MEASURED proceeds', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  seedPosition(bot) // ~49.7 LINK @ ~$10 avg, cost basis $500
  bot.realHeld = (50n * 10n ** 18n).toString()
  let tok = 0
  live.tokenBalanceBaseUnits = (async () => (tok++ === 0 ? 50n * 10n ** 18n : 0n)) as typeof live.tokenBalanceBaseUnits
  let nat = 0
  // Sweep native: receive 0.3 ETH = $600 (> $500 cost → ~$100 realized profit).
  live.nativeBalanceWei = (async () => (nat++ === 0 ? 10n ** 18n : 13n * 10n ** 17n)) as typeof live.nativeBalanceWei
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  await controlBot(bot.id, 'stop')
  assert.ok(Math.abs(bot.stats.realizedUsd - 100) < 15, `realized ≈ measured $600 − $500 cost ≈ $100, got ${bot.stats.realizedUsd}`)
  assert.ok(Math.abs(bot.stats.nativeTakenUsd - 600) < 15, `full measured proceeds swept to native (~$600), got ${bot.stats.nativeTakenUsd}`)
})

test('UT-4: a confirmed-but-UNMEASURABLE live sell books the requested fraction and flags untrusted', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  seedPosition(bot)
  const qtyBefore = bot.position.qty
  bot.realHeld = (50n * 10n ** 18n).toString()
  live.tokenBalanceBaseUnits = (async () => 50n * 10n ** 18n) as typeof live.tokenBalanceBaseUnits // constant → before==after → unmeasurable
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  await settle(bot, { type: 'sell', fraction: 0.5, reason: 'rung', exit: false }, 10)
  assert.equal(bot.state.realHeldUntrusted, true, 'an unmeasurable confirmed fill flags the position for reconcile')
  assert.ok(Math.abs(bot.position.qty - qtyBefore * 0.5) < 0.2, 'books the requested half — no measured delta to override it')
})

test('live sell with zero on-chain balance fails closed (paused, position kept)', async () => {
  state.settings.mode = 'live'
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 10n ** 30n) as typeof live.tokenBalanceBaseUnits
  const bot = freshBot()
  await settle(bot, { type: 'buy', usd: 100, reason: 'in' }, 10)
  const qty = bot.position.qty
  live.tokenBalanceBaseUnits = (async () => 0n) as typeof live.tokenBalanceBaseUnits
  let swapCalled = false
  live.executeSwap = (async () => {
    swapCalled = true
    return '0xhash'
  }) as typeof live.executeSwap
  await settle(bot, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 11)
  assert.equal(swapCalled, false, 'no swap attempted with zero balance')
  assert.equal(bot.position.qty, qty, 'position retained')
  assert.equal(bot.status, 'paused')
})

const tick = () => new Promise((r) => setTimeout(r, 0))

test('runExclusive serializes same-lane work FIFO; different lanes run concurrently', async () => {
  const order: number[] = []
  // Enqueue a slow job then a fast one on the SAME lane — FIFO must hold
  // regardless of duration (the slow one finishes first).
  const slow = runExclusive('L', async () => {
    await tick()
    await tick()
    order.push(1)
  })
  const fast = runExclusive('L', async () => {
    order.push(2)
  })
  await Promise.all([slow, fast])
  assert.deepEqual(order, [1, 2], 'same lane is strictly in order')

  // Different lanes are independent: the fast one on lane B finishes first.
  const order2: number[] = []
  const a = runExclusive('A', async () => {
    await tick()
    await tick()
    order2.push(1)
  })
  const b = runExclusive('B', async () => {
    order2.push(2)
  })
  await Promise.all([a, b])
  assert.deepEqual(order2, [2, 1], 'separate lanes run concurrently')
})

test('a failed swap does not poison its lane — the next job still runs', async () => {
  await assert.rejects(runExclusive('P', async () => { throw new Error('boom') }))
  let ran = false
  await runExclusive('P', async () => { ran = true })
  assert.equal(ran, true, 'lane recovered after a rejection')
})

test('concurrent live sells on one chain cannot oversell the wallet balance', async () => {
  state.settings.mode = 'live'
  // Open two bots with real positions (big balance so the buys clamp fine).
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  live.tokenBalanceBaseUnits = (async () => 10n ** 40n) as typeof live.tokenBalanceBaseUnits
  const b1 = freshBot()
  const b2 = freshBot()
  await settle(b1, { type: 'buy', usd: 500, reason: 'in' }, 10)
  await settle(b2, { type: 'buy', usd: 500, reason: 'in' }, 10)

  // The wallet really holds only 100 base units total, shared by both bots.
  let walletBal = 100n
  let totalSold = 0n
  live.tokenBalanceBaseUnits = (async () => walletBal) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async (o: { sellAmountBaseUnits: bigint }) => {
    await tick() // simulate async settlement between balance-read and debit
    walletBal -= o.sellAmountBaseUnits // the chain debits what was sold
    totalSold += o.sellAmountBaseUnits
    return '0xhash'
  }) as typeof live.executeSwap

  // Fire both sells concurrently; the lane must serialize them so the second
  // reads the post-first balance and can't double-spend.
  await Promise.all([
    settle(b1, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 12),
    settle(b2, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 12),
  ])
  assert.ok(totalSold <= 100n, `never sold more than the wallet held (sold ${totalSold})`)
})

test('market-scope bots paper-trade even in live mode (no executor call)', async () => {
  state.settings.mode = 'live'
  let called = false
  live.executeSwap = (async () => {
    called = true
    return '0xhash'
  }) as typeof live.executeSwap
  const bot = createBot({ network: 'market', token: 'PEPE', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000, cg: 'pepe' })
  assert.ok(!('error' in bot))
  await settle(bot as Exclude<typeof bot, { error: string }>, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(called, false, 'no on-chain execution for market scope')
  assert.ok((bot as Exclude<typeof bot, { error: string }>).position.qty > 0, 'paper fill committed')
})

// ── Per-bot sub-ledger (realHeld) ────────────────────────────────────────────

/** Seed a paper position so a live sell has a paper qty to mirror. */
function seedPosition(bot: ReturnType<typeof freshBot>) {
  execBuy(bot, 10, 500, 'seed') // ~49.9 LINK paper, no live side
}

test('per-bot clamp: a bot can never sell more than ITS attributed holdings, even on a shared wallet', async () => {
  state.settings.mode = 'live'
  const a = freshBot()
  const b = freshBot()
  seedPosition(a)
  a.realHeld = '60' // A acquired 60 base units on-chain
  b.realHeld = '140'
  let sellAmount: bigint | undefined
  // Wallet aggregate holds 200 (A's 60 + B's 140); both reads return 200/then post.
  live.tokenBalanceBaseUnits = (async () => 200n) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async (o: { sellAmountBaseUnits: bigint }) => {
    sellAmount = o.sellAmountBaseUnits
    return '0xhash'
  }) as typeof live.executeSwap
  await settle(a, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 12)
  assert.equal(sellAmount, 60n, 'clamped to A’s own realHeld (60), not the shared wallet (200)')
  assert.equal(b.realHeld, '140', 'B’s attributed holdings untouched')
})

test('in-lane mutation keeps realHeld summing to the wallet under concurrent same-token sells', async () => {
  state.settings.mode = 'live'
  const a = freshBot()
  const b = freshBot()
  seedPosition(a)
  seedPosition(b)
  a.realHeld = '100'
  b.realHeld = '100'
  let walletBal = 200n
  live.tokenBalanceBaseUnits = (async () => walletBal) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async (o: { sellAmountBaseUnits: bigint }) => {
    await tick()
    walletBal -= o.sellAmountBaseUnits
    return '0xhash'
  }) as typeof live.executeSwap
  await Promise.all([
    settle(a, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 12),
    settle(b, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 12),
  ])
  // Each debited only its own measured delta; the sum still equals the wallet.
  assert.equal(curHeld(a) + curHeld(b), walletBal, 'sum(realHeld) == wallet aggregate after')
  assert.equal(walletBal, 0n, 'both fully sold, wallet drained to 0 (no oversell)')
})

test('stale-LOW realHeld degrades to the wallet-have clamp (never strands real tokens)', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  seedPosition(bot) // paper position open...
  bot.realHeld = '0' // ...but realHeld lost (crash before flush / paper window)
  let sellAmount: bigint | undefined
  let paused = false
  live.tokenBalanceBaseUnits = (async () => 500n) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async (o: { sellAmountBaseUnits: bigint }) => {
    sellAmount = o.sellAmountBaseUnits
    return '0xhash'
  }) as typeof live.executeSwap
  await settle(bot, { type: 'sell', fraction: 1, reason: 'out', exit: true }, 12)
  paused = bot.status === 'paused'
  assert.equal(paused, false, 'not blocked — stale-low realHeld must not strand the position')
  assert.ok((sellAmount ?? 0n) > 0n, 'sell fired, clamped to wallet-have (500), not to a phantom 0')
})

test('sign-gate: a buy that does NOT increase the balance credits 0 (external transfer guard)', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  let reads = 0
  // before=1000, after=900 — a withdrawal straddled the swap.
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 1000n : 900n)) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  await settle(bot, { type: 'buy', usd: 100, reason: 'x' }, 10)
  assert.equal(curHeld(bot), 0n, 'wrong-sign delta credits 0, not a corrupt/negative number')
  assert.ok(bot.position.qty > 0, 'the paper fill still commits (swap confirmed)')
})

test('reconcileRealHeld: single-holder is re-seeded from chain; multi-holder is flagged untrusted', async () => {
  state.settings.mode = 'live'
  const solo = freshBot()
  solo.realHeld = '0' // crash-lost credit
  live.tokenBalanceBaseUnits = (async () => 777n) as typeof live.tokenBalanceBaseUnits
  await reconcileRealHeld()
  assert.equal(solo.realHeld, '777', 'single holder re-seeded to the real aggregate')
  assert.equal(solo.state.realHeldUntrusted, false)

  // Two bots on the same token can't be split — degrade to the wallet-have clamp.
  state.bots.length = 0
  const a = freshBot()
  const b = freshBot()
  a.realHeld = '10'
  b.realHeld = '20'
  await reconcileRealHeld()
  assert.equal(a.realHeld, '10', 'multi-holder realHeld left as-is (no deterministic split)')
  assert.equal(b.realHeld, '20')
  assert.equal(a.state.realHeldUntrusted, true)
  assert.equal(b.state.realHeldUntrusted, true)
})

test('controlBot stop debits realHeld in-lane and persists durably', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  seedPosition(bot)
  bot.realHeld = '100'
  let reads = 0
  live.tokenBalanceBaseUnits = (async () => (reads++ === 0 ? 100n : 0n)) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async () => '0xhash') as typeof live.executeSwap
  await controlBot(bot.id, 'stop') // now awaits the on-chain sell (mirror-first)
  assert.equal(bot.status, 'stopped')
  assert.equal(bot.realHeld, '0', 'realHeld debited by the measured liquidation delta')
})

test('P0-3: a manual stop whose on-chain sell FAILS keeps paper state intact (pauses, not stopped)', async () => {
  state.settings.mode = 'live'
  const bot = freshBot()
  seedPosition(bot) // a real position to liquidate
  bot.realHeld = '100'
  const qtyBefore = bot.position.qty
  const cashBefore = bot.cashUsd
  const realizedBefore = bot.stats.realizedUsd
  live.tokenBalanceBaseUnits = (async () => 100n) as typeof live.tokenBalanceBaseUnits
  live.executeSwap = (async () => {
    throw new Error('swap reverted (no liquidity / honeypot)')
  }) as typeof live.executeSwap
  await controlBot(bot.id, 'stop')
  // The on-chain sell failed → the bot must NOT book a phantom liquidation.
  assert.equal(bot.status, 'paused', 'paused for retry, NOT marked stopped')
  assert.equal(bot.position.qty, qtyBefore, 'position untouched')
  assert.equal(bot.cashUsd, cashBefore, 'cash untouched (no phantom proceeds)')
  assert.equal(bot.stats.realizedUsd, realizedBefore, 'no phantom realized P&L')
})

test('curHeld never throws on a malformed persisted value (hot-path safety)', () => {
  const bot = freshBot()
  bot.realHeld = 'not-a-number'
  assert.equal(curHeld(bot), 0n)
  bot.realHeld = '12.5'
  assert.equal(curHeld(bot), 0n)
  bot.realHeld = '1000'
  assert.equal(curHeld(bot), 1000n)
})
