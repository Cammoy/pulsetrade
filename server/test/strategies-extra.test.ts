// Copy-trade and AI strategies, driven by engine-seeded signals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strategyById, STRATEGIES, ALL_STRATEGIES, type Ctx } from '../src/strategies.js'
import { RISK } from '../src/risk.js'

const NOW = 1_750_000_000_000
const ctx = (over: Partial<Ctx>): Ctx => ({
  price: 100, closes: Array(40).fill(100), params: RISK.balanced, state: {},
  position: { qty: 0, avgCostUsd: 0, costUsd: 0 }, budgetUsd: 1000, cashUsd: 1000, now: NOW, ...over,
})

// ── Copy trade ───────────────────────────────────────────────────────────────

test('copytrade: buys when smart money buys, once per tx', () => {
  const s = strategyById('copytrade')!
  const state: any = { copySignal: { side: 'buy', txHash: '0xa' } }
  const a = s.decide(ctx({ state }))
  assert.ok(a && a.type === 'buy', 'mirrors the buy')
  assert.equal(a.usd, (1000 * RISK.balanced.positionPct) / 100)
  // same tx again → no action
  assert.equal(s.decide(ctx({ state, position: { qty: 1, avgCostUsd: 100, costUsd: 100 }, cashUsd: 0 })), null)
})

test('copytrade: sells the position when smart money sells', () => {
  const s = strategyById('copytrade')!
  const state: any = { copySignal: { side: 'sell', txHash: '0xb' } }
  const a = s.decide(ctx({ state, position: { qty: 2, avgCostUsd: 100, costUsd: 200 } }))
  assert.ok(a && a.type === 'sell' && a.exit && a.fraction === 1)
})

test('copytrade: no signal → no action; respects stop-loss guard', () => {
  const s = strategyById('copytrade')!
  assert.equal(s.decide(ctx({})), null)
  const stop = s.decide(ctx({ position: { qty: 1, avgCostUsd: 100, costUsd: 100 }, price: 100 * (1 - RISK.balanced.stopLossPct / 100 - 0.01) }))
  assert.ok(stop && stop.type === 'sell' && /stop-loss/i.test(stop.reason))
})

// ── AI ───────────────────────────────────────────────────────────────────────

test('ai: buys on a confident BUY, sized by confidence', () => {
  const s = strategyById('ai')!
  const state: any = { aiSignal: { action: 'buy', confidence: 0.8, reason: 'uptrend' } }
  const a = s.decide(ctx({ state }))
  assert.ok(a && a.type === 'buy')
  assert.ok(Math.abs(a.usd - (1000 * RISK.balanced.positionPct * 0.8) / 100) < 1e-9, 'size scales with confidence')
})

test('ai: ignores low-confidence buys', () => {
  const s = strategyById('ai')!
  assert.equal(s.decide(ctx({ state: { aiSignal: { action: 'buy', confidence: 0.4, reason: 'weak' } } })), null)
})

test('ai: sells the position on a SELL signal', () => {
  const s = strategyById('ai')!
  const a = s.decide(ctx({ state: { aiSignal: { action: 'sell', confidence: 0.9, reason: 'topping' } }, position: { qty: 1, avgCostUsd: 100, costUsd: 100 } }))
  assert.ok(a && a.type === 'sell' && a.exit)
})

test('ai: HOLD does nothing', () => {
  const s = strategyById('ai')!
  assert.equal(s.decide(ctx({ state: { aiSignal: { action: 'hold', confidence: 0.9, reason: 'wait' } } })), null)
})

test('copytrade and ai are excluded from the backtestable strategy list', () => {
  assert.ok(!STRATEGIES.some((s) => s.id === 'copytrade' || s.id === 'ai'))
  assert.ok(ALL_STRATEGIES.some((s) => s.id === 'copytrade') && ALL_STRATEGIES.some((s) => s.id === 'ai'))
})
