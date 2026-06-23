// The FULL auto-sniper flow end-to-end through the REAL engine — proof it actually
// works, not just that the scanner opens a bot. Drives the live tick loop (tickBot)
// with injected pool prices: scan → BUY the budget → take the stake back at +100% →
// ride the runner → exit on the trailing stop → retire → the scanner RECLAIMS the cash.
// All providers (discovery, GoPlus, honeypot, pool price, native spot) are mocked.
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-autolife-'))

const { state } = await import('../src/store.js')
const { autoScan, startAutoSniper, __test } = await import('../src/engine.js')
const { refreshPoolPrice, getSpotPrices } = await import('../src/prices.js')
const { tickBot } = __test

const NOW = 1_750_000_000_000
const TWO_H = 2 * 60 * 60_000
const addr = (c: string) => '0x' + c.repeat(40)
const TOKEN = addr('a')
const POOL = addr('1')

const cleanGp = {
  is_open_source: '1', is_honeypot: '0', cannot_sell_all: '0', transfer_pausable: '0',
  is_blacklisted: '0', is_mintable: '0', selfdestruct: '0', hidden_owner: '0',
  owner_change_balance: '0', is_in_dex: '1', buy_tax: '0', sell_tax: '0', holder_count: '900',
  lp_holder_count: '2', lp_holders: [{ percent: '1', is_locked: 1, address: '0xlock' }],
  holders: [{ percent: '0.04', address: '0xaaa' }],
}

const feed = {
  data: [
    {
      attributes: {
        address: POOL, name: 'AAA / WETH', base_token_price_usd: '1', reserve_in_usd: '90000',
        volume_usd: { h24: '50000' }, price_change_percentage: { h1: '1' }, fdv_usd: '5000000',
        pool_created_at: new Date(NOW - 20 * 60_000).toISOString(),
      },
      relationships: { base_token: { data: { id: `base_${TOKEN}` } }, dex: { data: { id: 'aerodrome' } } },
    },
  ],
  included: [{ id: `base_${TOKEN}`, type: 'token', attributes: { address: TOKEN, symbol: 'AAA', name: 'AAA' } }],
}

let poolUsdPrice = 1 // mutated between ticks to drive the snipe's price path

before(async () => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('/new_pools') || u.includes('/trending_pools')) return new Response(JSON.stringify(feed), { status: 200 })
    if (u.includes('/pools/')) return new Response(JSON.stringify({ data: { attributes: { base_token_price_usd: String(poolUsdPrice) } } }), { status: 200 })
    if (u.includes('gopluslabs')) return new Response(JSON.stringify({ code: 1, result: { [TOKEN]: cleanGp } }), { status: 200 })
    if (u.includes('honeypot.is'))
      return new Response(JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } }), { status: 200 })
    if (u.includes('coingecko')) return new Response(JSON.stringify({ ethereum: { usd: 2000 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  await getSpotPrices(['ethereum']) // populate the native spot so the profit-sweep has a price
})

beforeEach(() => {
  state.bots = []
  state.autoSniper = null
  state.settings.mode = 'paper'
  poolUsdPrice = 1
})

const smartCfg = { takeProfitPct: 100, stopLossPct: 35, maxHoldMin: 1440, deRiskAtPct: 100, runnerTrailPct: 30 }

// Set the pool price, then run one real engine tick for the bot.
async function tickAt(bot: (typeof state.bots)[number], price: number) {
  poolUsdPrice = price
  await refreshPoolPrice('base', bot.pool!.poolAddress)
  await tickBot(bot)
}

test('a single-snipe campaign runs the WHOLE lifecycle through the engine and reclaims', async () => {
  // budget == per-snipe → a 1-snipe campaign (auto-stops after deploying it)
  startAutoSniper({ network: 'base', totalBudgetUsd: 100, perSnipeUsd: 100, config: smartCfg, entryIntervalMs: TWO_H })
  await autoScan(NOW + 100_000)
  assert.equal(state.bots.length, 1, 'scanner opened exactly one snipe')
  const bot = state.bots[0]
  assert.equal(bot.auto, true)
  assert.equal(bot.strategy, 'sniper')
  assert.equal(bot.position.qty, 0, 'created flat — the buy happens on the first tick')

  // 1) first tick at $1 → BUYS the full budget
  await tickAt(bot, 1)
  assert.ok(bot.position.qty > 0, 'sniper actually bought its position')
  assert.ok(bot.cashUsd < 5, `spent ~the whole budget (cash=${bot.cashUsd})`)
  const qtyAfterBuy = bot.position.qty

  // 2) +150% (well past the +100% de-risk) → TAKE THE STAKE BACK, keep riding
  await tickAt(bot, 2.5)
  assert.equal(bot.state.derisked, true, 'marked de-risked')
  assert.ok(bot.position.qty > 0 && bot.position.qty < qtyAfterBuy, 'sold PART, still riding the runner')
  assert.ok(bot.stats.nativeTakenUsd > 0, 'profit was swept to native')
  assert.ok(bot.cashUsd + bot.stats.nativeTakenUsd > 90, `the original stake (~$100) is back in safety (cash ${bot.cashUsd.toFixed(2)} + vault ${bot.stats.nativeTakenUsd.toFixed(2)})`)
  assert.equal(bot.status, 'running', 'NOT retired — the house-money runner rides on')

  // 3) ride to a new high $4 — no exit (trailing from the new peak)
  await tickAt(bot, 4)
  assert.ok(bot.position.qty > 0, 'still riding at a new high')

  // 4) drop ~37% off the $4 peak → runner trailing stop → FULL exit → RETIRE
  await tickAt(bot, 2.5)
  assert.equal(bot.position.qty, 0, 'runner closed out')
  assert.equal(bot.state.sniped, true, 'the one-shot has fully fired')
  assert.equal(bot.status, 'stopped', 'snipe retired after the runner exit')
  assert.ok(bot.stats.nativeTakenUsd > 50, 'banked a real profit overall')

  // 5) the scanner RECLAIMS the retired snipe's cash back into the campaign pool
  const a = state.autoSniper!
  assert.equal(a.enabled, false, 'the 1-snipe campaign already auto-stopped (budget deployed)')
  const poolBefore = a.poolUsd
  await autoScan(NOW + 100_000 + 3 * TWO_H)
  assert.equal(bot.state.reclaimedByAuto, true, 'the finished snipe was reclaimed')
  assert.ok(a.poolUsd > poolBefore, `returned principal is back in the pool (${poolBefore} → ${a.poolUsd})`)
})

test('a snipe that DUMPS before profit stops out at a loss and retires (no false "stake back")', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 100, perSnipeUsd: 100, config: smartCfg, entryIntervalMs: TWO_H })
  await autoScan(NOW + 100_000)
  const bot = state.bots[0]
  await tickAt(bot, 1) // buy
  assert.ok(bot.position.qty > 0)
  // −40% (past the −35% catastrophic stop) → full exit at a loss, retire
  await tickAt(bot, 0.6)
  assert.equal(bot.position.qty, 0, 'stopped out')
  assert.equal(bot.state.sniped, true)
  assert.equal(bot.status, 'stopped', 'retired')
  assert.equal(bot.state.derisked ?? false, false, 'never de-risked — it never reached profit')
  assert.ok(bot.stats.realizedUsd < 0, 'booked the loss honestly')
})
