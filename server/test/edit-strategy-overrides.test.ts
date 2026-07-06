// Per-bot exit overrides for NON-sniper strategy/AI bots: editBot writes
// `bot.overrides.{takeProfitPct,stopLossPct}`, which REPLACE the risk-tier values in the
// decide() path. Snipers keep their own `sniper` config; copies keep their `copy` config.
// The injection must spread into a FRESH params object — RISK[tier] is a shared singleton,
// so a per-bot override must never leak to other bots.
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-ovr-'))

const { state } = await import('../src/store.js')
const { createBot, editBot, __test } = await import('../src/engine.js')
const { getSpotPrices } = await import('../src/prices.js')
const { RISK } = await import('../src/risk.js')

before(async () => {
  // One mock for everything: LINK = $10 for spot pricing, and NOT a candle payload
  // (no `.prices` array) so getCandles comes back empty → tickBot runs the candle-free
  // slTpFallback, which is PURE take-profit / stop-loss against the live price. That
  // isolates the override → params → exit path with no indicator noise.
  globalThis.fetch = (async () => new Response(JSON.stringify({ chainlink: { usd: 10 } }), { status: 200 })) as typeof fetch
  await getSpotPrices(['chainlink'])
})

beforeEach(() => {
  state.bots = []
})

const stratBot = () => {
  const out = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000 })
  assert.ok(!('error' in out))
  return state.bots.find((b) => b.id === (out as { id: string }).id)!
}

test('editBot writes overrides on a strategy bot WITHOUT mutating the shared risk tier', () => {
  const tierTpBefore = RISK.balanced.takeProfitPct
  const bot = stratBot()
  const ed = editBot(bot.id, { takeProfitPct: 1, stopLossPct: 2 })
  assert.ok(!('error' in ed))
  assert.deepEqual(bot.overrides, { takeProfitPct: 1, stopLossPct: 2 })
  assert.equal(RISK.balanced.takeProfitPct, tierTpBefore, 'the shared tier is untouched (no singleton mutation)')
})

test('the override governs the next decide() — a held position exits at the override TP, not the tier TP', async () => {
  const bot = stratBot()
  // Held position up +2.04% (avg cost 9.80, LINK spot $10).
  bot.position = { qty: 10, avgCostUsd: 9.8, costUsd: 98, openedAt: Date.now() }
  bot.cashUsd = 902

  // Tier TP is 4.5% → +2.04% does NOT take profit; SL is −5% → no stop. Position held.
  await __test.tickBot(bot)
  assert.equal(bot.position.qty, 10, 'no exit at +2% with the 4.5% tier take-profit')

  // Lower the take-profit to 1% via an override → +2.04% now clears it → exit.
  assert.ok(!('error' in editBot(bot.id, { takeProfitPct: 1 })))
  await __test.tickBot(bot)
  assert.equal(bot.position.qty, 0, 'exits at +2% once the override take-profit is 1%')
})

test('a per-bot override never leaks to another bot on the same tier', async () => {
  const a = stratBot()
  const b = stratBot()
  editBot(a.id, { takeProfitPct: 1 }) // tighten only bot A
  for (const bot of [a, b]) bot.position = { qty: 10, avgCostUsd: 9.8, costUsd: 98, openedAt: Date.now() }
  a.cashUsd = b.cashUsd = 902
  await __test.tickBot(a)
  await __test.tickBot(b)
  assert.equal(a.position.qty, 0, 'A exits — its override TP (1%) is below the +2% gain')
  assert.equal(b.position.qty, 10, 'B still holds — it tracks the untouched 4.5% tier')
})

test('editBot validates override ranges and rejects atomically (no partial apply)', () => {
  const bot = stratBot()
  assert.ok('error' in editBot(bot.id, { takeProfitPct: 0 }))
  assert.ok('error' in editBot(bot.id, { takeProfitPct: 2000 }))
  assert.ok('error' in editBot(bot.id, { stopLossPct: 150 }))
  assert.equal(bot.overrides, undefined, 'nothing applied after the rejections')
  // A valid edit then a rejected one in the SAME call leaves the prior good value intact.
  assert.ok(!('error' in editBot(bot.id, { takeProfitPct: 3 })))
  assert.ok('error' in editBot(bot.id, { takeProfitPct: 5, stopLossPct: 999 }))
  assert.deepEqual(bot.overrides, { takeProfitPct: 3 }, 'the bad stop-loss did not clobber the good take-profit')
})

test('max-hold / trailing remain sniper-only on a strategy bot', () => {
  const bot = stratBot()
  assert.ok('error' in editBot(bot.id, { maxHoldMin: 60 }))
  assert.ok('error' in editBot(bot.id, { trailingPct: 10 }))
})

test('copy bots reject the strategy-override path (they set exits in the copy config)', () => {
  const bot = stratBot()
  bot.copy = { walletAddress: '0x' + 'a'.repeat(40), walletLabel: 'Whale' }
  const ed = editBot(bot.id, { takeProfitPct: 5 })
  assert.ok('error' in ed && /copy/i.test((ed as { error: string }).error))
  assert.equal(bot.overrides, undefined)
})

test('budget top-up still works on a strategy bot alongside overrides', () => {
  const bot = stratBot()
  editBot(bot.id, { takeProfitPct: 3, budgetUsd: 1500 })
  assert.equal(bot.budgetUsd, 1500)
  assert.equal(bot.overrides?.takeProfitPct, 3)
})
