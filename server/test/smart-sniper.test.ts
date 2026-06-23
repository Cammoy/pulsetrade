// Smart-sniper: take the original stake back at +deRiskAtPct, then ride the rest as
// house money with a trail-from-peak exit (no fixed timer → holds 24h+ while trending).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { principalRecoveryFraction } from '../src/safety-math.js'
import { strategyById } from '../src/strategies.js'
import { RISK } from '../src/risk.js'

const NOW = 1_750_000_000_000
const ctx = (over: any) => ({
  price: 1, closes: [1], params: RISK.aggressive, state: {},
  position: { qty: 0, avgCostUsd: 0, costUsd: 0 }, budgetUsd: 100, cashUsd: 100, now: NOW, ...over,
})
const smart = { takeProfitPct: 100, stopLossPct: 35, maxHoldMin: 1440, deRiskAtPct: 100, runnerTrailPct: 30 }
const held = (price: number, avg = 1) => ({ qty: 100, avgCostUsd: avg, costUsd: avg * 100 })

test('principalRecoveryFraction recovers cost basis at a 2x (after a fee buffer)', () => {
  const { fraction, recoverable } = principalRecoveryFraction(1, 2) // +100%
  assert.ok(recoverable)
  // net proceeds of selling `fraction` must clear the FULL cost basis after the fee buffer
  const net = fraction * 2 * (1 - 0.015)
  assert.ok(net >= 1 - 1e-9, `selling ${fraction} recovers ${net} of 1.0 cost basis`)
  assert.ok(fraction > 0.5 && fraction < 0.52) // ~0.5076, leaving ~49% riding
})

test('principalRecoveryFraction is not recoverable when too close to cost (after fees)', () => {
  assert.equal(principalRecoveryFraction(1, 1.01).recoverable, false) // +1% can't clear fees from a partial
  assert.equal(principalRecoveryFraction(1, 0.9).recoverable, false) // underwater
  assert.deepEqual(principalRecoveryFraction(0, 2), { fraction: 1, recoverable: false }) // guard
})

test('smart sniper buys the full budget on entry', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe: smart }
  const a = s.decide(ctx({ state }))
  assert.ok(a && a.type === 'buy' && a.usd === 100)
})

test('smart sniper TAKES THE STAKE BACK at +deRiskAtPct with a partial sell, and keeps riding', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe: smart, entryAt: NOW }
  const a = s.decide(ctx({ state, price: 2, position: held(2), cashUsd: 0 })) // +100%
  assert.ok(a && a.type === 'sell', 'sells')
  assert.equal(a!.exit, false, 'NOT a full exit — the runner keeps riding')
  assert.ok(a!.fraction! > 0.5 && a!.fraction! < 0.52, 'sells ~the principal-recovery slice')
  assert.match(a!.reason, /stake back/i)
  assert.equal(state.derisked, true)
  assert.ok(!state.sniped, 'bot is NOT retired — it holds the house-money runner')
})

test('smart sniper holds below the de-risk threshold (no premature exit)', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe: smart, entryAt: NOW }
  assert.equal(s.decide(ctx({ state, price: 1.5, position: held(1.5), cashUsd: 0 })), null) // +50% < +100% target
})

test('smart sniper stop-loss bounds the downside BEFORE de-risking', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe: smart, entryAt: NOW }
  const a = s.decide(ctx({ state, price: 0.6, position: held(0.6), cashUsd: 0 })) // -40% <= -35
  assert.ok(a && a.type === 'sell' && a.exit && /Stop-loss/.test(a.reason))
})

test('the runner rides while trending, then a trail-from-peak closes it (24h+ capable, no timer)', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe: smart, entryAt: NOW, derisked: true, peak: 2 }
  const pos = held(3) // avg 1, deep in profit
  // still making new highs, even 2 DAYS later → keep holding (no fixed max-hold for a runner)
  assert.equal(s.decide(ctx({ state, now: NOW + 48 * 60 * 60_000, price: 3.5, position: pos, cashUsd: 0 })), null)
  assert.equal(state.peak, 3.5)
  // now it gives back >30% from the 3.5 peak → close the runner
  const a = s.decide(ctx({ state, price: 2.4, position: pos, cashUsd: 0 })) // ~-31% off peak
  assert.ok(a && a.type === 'sell' && a.exit && /Runner trailing stop/.test(a.reason))
  assert.equal(state.sniped, true)
})

test('pre-de-risk max-hold backstop releases capital that never reached the target', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe: smart, entryAt: NOW }
  const a = s.decide(ctx({ state, now: NOW + 1441 * 60_000, price: 1.2, position: held(1.2), cashUsd: 0 }))
  assert.ok(a && a.type === 'sell' && /Max hold/.test(a.reason))
})
