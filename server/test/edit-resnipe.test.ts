// Editing an existing sniper's parameters + RE-SNIPING a retired one. A sniper is
// one-shot (state.sniped), so resuming a flat/retired sniper must RE-ARM it (clear
// the flag) — otherwise it just re-trips "snipe complete" forever. editBot adjusts
// TP/SL/max-hold/trailing/budget and the change governs the next decide().
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-edit-'))

const { state } = await import('../src/store.js')
const { createSniper, controlBot, editBot } = await import('../src/engine.js')
const { ALL_STRATEGIES } = await import('../src/strategies.js')

const sniperStrat = ALL_STRATEGIES.find((s) => s.id === 'sniper')!
const POOL = '0x2222222222222222222222222222222222222222'
let seq = 0
const nextToken = () => '0x' + String(++seq).padStart(40, 'a')

const cleanGp = {
  is_honeypot: '0', cannot_sell_all: '0', transfer_pausable: '0', is_blacklisted: '0',
  is_mintable: '0', selfdestruct: '0', hidden_owner: '0', owner_change_balance: '0',
  is_open_source: '1', is_in_dex: '1', buy_tax: '0', sell_tax: '0', holder_count: '5000',
  lp_holder_count: '2', lp_holders: [{ percent: '1', is_locked: 1, address: '0xlock' }], holders: [{ percent: '0.05' }],
}

before(() => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('gopluslabs')) {
      const addr = (u.match(/contract_addresses=(0x[a-f0-9]+)/i)?.[1] ?? '').toLowerCase()
      return new Response(JSON.stringify({ code: 1, result: addr ? { [addr]: cleanGp } : {} }), { status: 200 })
    }
    if (u.includes('honeypot.is')) return new Response(JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 1, sellTax: 1 } }), { status: 200 })
    if (u.includes('geckoterminal')) return new Response(JSON.stringify({ data: { attributes: { reserve_in_usd: '90000', base_token_price_usd: '1.5' } } }), { status: 200 })
    if (u.includes('coingecko')) return new Response(JSON.stringify({ ethereum: { usd: 2000 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

beforeEach(() => {
  state.bots = []
})

async function freshSniper(over: Partial<{ takeProfitPct: number; stopLossPct: number; maxHoldMin: number }> = {}) {
  const out: any = await createSniper({
    network: 'base', poolAddress: POOL, tokenAddress: nextToken(), tokenSymbol: 'SAFE',
    budgetUsd: 200, decimals: 18, sniper: { takeProfitPct: 50, stopLossPct: 25, maxHoldMin: 120, ...over },
  })
  assert.ok(!('error' in out), out.error)
  return state.bots.find((b) => b.id === out.id)!
}

/** Build the decide() ctx the engine would (seeding state.snipe from bot.sniper, as tickBot does). */
const ctxFor = (bot: any, price: number) => {
  bot.state.snipe = bot.sniper // engine seeds this each tick
  return { price, closes: [], params: {} as any, state: bot.state, position: bot.position, budgetUsd: bot.budgetUsd, cashUsd: bot.cashUsd, now: Date.now() }
}

test('editBot updates the sniper exit thresholds and the change governs the next decide()', async () => {
  const bot = await freshSniper({ takeProfitPct: 50 })
  // Simulate an open position up +30%.
  bot.position = { qty: 10, avgCostUsd: 100, costUsd: 1000, openedAt: Date.now() }
  bot.state.entryAt = Date.now()
  // TP 50% → +30% does NOT exit.
  assert.equal(sniperStrat.decide(ctxFor(bot, 130)), null, 'no exit at +30% with TP 50%')
  // Tighten TP to 20% → +30% now exits.
  const ed = editBot(bot.id, { takeProfitPct: 20 })
  assert.ok(!('error' in ed))
  assert.equal((ed as any).sniper.takeProfitPct, 20)
  const a = sniperStrat.decide(ctxFor(bot, 130))
  assert.ok(a && a.type === 'sell' && a.exit, 'exits at +30% once TP is lowered to 20%')
})

test('editBot validates ranges and rejects without partially applying', async () => {
  const bot = await freshSniper()
  assert.ok('error' in editBot(bot.id, { takeProfitPct: 0 }))
  assert.ok('error' in editBot(bot.id, { stopLossPct: 150 }))
  assert.ok('error' in editBot(bot.id, { maxHoldMin: -5 }))
  assert.ok('error' in editBot(bot.id, { trailingPct: 200 }))
  assert.ok('error' in editBot(bot.id, { budgetUsd: 5 }))
  assert.ok('error' in editBot('no-such-bot', { takeProfitPct: 30 }))
  // Original values untouched after the rejections.
  assert.equal(bot.sniper!.takeProfitPct, 50)
  assert.equal(bot.sniper!.stopLossPct, 25)
})

test('editBot clears the trailing stop when set to empty/0', async () => {
  const bot = await freshSniper()
  editBot(bot.id, { trailingPct: 15 })
  assert.equal(bot.sniper!.trailingPct, 15)
  editBot(bot.id, { trailingPct: null })
  assert.equal(bot.sniper!.trailingPct, undefined, 'null clears the optional trailing stop')
})

test('editBot budget: top-up injects working cash; reduce pulls only FREE cash', async () => {
  const bot = await freshSniper()
  assert.equal(bot.cashUsd, 200)
  editBot(bot.id, { budgetUsd: 300 }) // +100 capital injection
  assert.equal(bot.budgetUsd, 300)
  assert.equal(bot.cashUsd, 300)
  // Deploy 250 into a position; only 50 is free.
  bot.cashUsd = 50
  bot.position = { qty: 5, avgCostUsd: 50, costUsd: 250, openedAt: Date.now() }
  assert.ok('error' in editBot(bot.id, { budgetUsd: 200 }), 'cannot reduce below deployed capital ($50 free)')
  const ok = editBot(bot.id, { budgetUsd: 260 }) // -40, within the $50 free
  assert.ok(!('error' in ok))
  assert.equal(bot.cashUsd, 10)
})

test('resume RE-ARMS a retired (flat) sniper so it snipes again — not an instant re-retire', async () => {
  const bot = await freshSniper()
  // Simulate a completed, losing snipe: fired, exited, flat, retired, some cash left.
  bot.state.sniped = true
  bot.state.entryAt = Date.now() - 60_000
  bot.state.peak = 0.002
  bot.position = { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null }
  bot.cashUsd = 140
  bot.status = 'stopped'
  // Before re-arm: the strategy is one-shot → returns null (the re-retire loop).
  assert.equal(sniperStrat.decide(ctxFor(bot, 0.0000017)), null, 'one-shot before re-arm')

  await controlBot(bot.id, 'resume')
  assert.equal(bot.status, 'running')
  assert.equal(bot.state.sniped, false, 'sniped flag cleared on resume')
  assert.equal(bot.state.entryAt, undefined, 'entry reset')
  assert.equal(bot.state.peak, undefined, 'peak reset')
  // After re-arm: a fresh full-position entry is taken on the next tick.
  const a = sniperStrat.decide(ctxFor(bot, 0.0000017))
  assert.ok(a && a.type === 'buy', 're-arms and snipes again')
  assert.equal((a as any).usd, 140, 'enters with the remaining working cash')
})

test('resume does NOT re-arm a sniper that still HOLDS a position (keeps managing the open trade)', async () => {
  const bot = await freshSniper()
  bot.state.sniped = false
  bot.position = { qty: 10, avgCostUsd: 100, costUsd: 1000, openedAt: Date.now() }
  bot.status = 'paused'
  await controlBot(bot.id, 'resume')
  assert.equal(bot.status, 'running')
  assert.equal(bot.position.qty, 10, 'open position untouched')
  // Still managing: at +60% with TP 50% it exits, not re-enters.
  const a = sniperStrat.decide(ctxFor(bot, 160))
  assert.ok(a && a.type === 'sell', 'continues managing the open position')
})
