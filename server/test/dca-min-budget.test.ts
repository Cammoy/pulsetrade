// STRAT-2 / STRAT-3: a Smart-DCA bot whose budget makes each slice ≤ $1 would
// tick forever without ever trading (the engine drops sub-$1 buys as dust). It
// must be rejected at creation, and the strategy must not advance its schedule
// clock for an untradeable slice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strategyById, type Ctx } from '../src/strategies.js'
import { RISK } from '../src/risk.js'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-dca-'))
const { createBot } = await import('../src/engine.js')

const dcaCtx = (over: Partial<Ctx>): Ctx => ({
  price: 95, // below the 100 average → DCA wants to buy a dip
  closes: Array(40).fill(100),
  params: RISK.conservative,
  state: {},
  position: { qty: 0, avgCostUsd: 0, costUsd: 0 },
  budgetUsd: 10,
  cashUsd: 10,
  now: 1_750_000_000_000,
  ...over,
})

test('createBot rejects a Smart-DCA bot whose slices would be ≤ $1 dust', () => {
  // conservative = 10 slices → $10 / 10 = exactly $1.00 → dust → rejected
  const out = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'dca', risk: 'conservative', budgetUsd: 10 })
  assert.ok('error' in out, 'a $10 conservative DCA bot is refused')
  assert.match(out.error, /Smart DCA needs a bigger budget/i)
})

test('createBot allows a Smart-DCA bot once each slice clears $1', () => {
  const out = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'dca', risk: 'conservative', budgetUsd: 100 })
  assert.ok(!('error' in out), '$100 / 10 = $10 slices are tradeable')
})

test('STRAT-3: an untradeable (≤$1) slice yields no buy AND does not advance the clock', () => {
  const dca = strategyById('dca')!
  const state: Record<string, any> = {}
  const a = dca.decide(dcaCtx({ state, params: RISK.conservative, budgetUsd: 10, cashUsd: 10 })) // $1 slice
  assert.equal(a, null, 'no dust buy emitted')
  assert.equal(state.lastBuyAt, undefined, 'DCA clock NOT advanced — bot is not silently frozen mid-schedule')
})

test('a healthy DCA slice buys and advances the clock', () => {
  const dca = strategyById('dca')!
  const state: Record<string, any> = {}
  const a = dca.decide(dcaCtx({ state, params: RISK.balanced, budgetUsd: 1000, cashUsd: 1000 })) // $125 slice
  assert.ok(a && a.type === 'buy' && a.usd > 1, 'a tradeable slice is emitted')
  assert.equal(state.lastBuyAt, 1_750_000_000_000, 'clock advances only on a real buy')
})
