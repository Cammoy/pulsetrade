// Daily live-spend cap — pure logic that bounds how much the bots spend on live
// buys per day (Turnkey is stateless per-signature, so the cumulative cap lives
// in the engine).
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { checkDailyCap, recordDailySpend, evaluateBreaker } = await import('../src/engine.js')

const T = '2026-06-15'

test('no cap (capUsd<=0) always allows', () => {
  const r = checkDailyCap({ day: T, usd: 9999 }, 1000, 0, T)
  assert.equal(r.allowed, true)
  assert.equal(r.remaining, Infinity)
})

test('allows under the cap, reports remaining', () => {
  const r = checkDailyCap({ day: T, usd: 30 }, 15, 100, T)
  assert.equal(r.allowed, true)
  assert.equal(r.spentToday, 30)
  assert.equal(r.remaining, 55) // 100 - 30 - 15
})

test('blocks a buy that would exceed the cap', () => {
  const r = checkDailyCap({ day: T, usd: 90 }, 20, 100, T)
  assert.equal(r.allowed, false)
  assert.equal(r.remaining, 10) // 100 - 90 (what is left, not counting the blocked buy)
  assert.match(r.reason ?? '', /daily live-spend cap/i)
})

test('a new day resets the counter (yesterday spend ignored)', () => {
  const r = checkDailyCap({ day: '2026-06-14', usd: 100 }, 40, 100, T)
  assert.equal(r.allowed, true, 'prior-day spend does not count today')
  assert.equal(r.spentToday, 0)
})

test('recordDailySpend accumulates within a day and resets across days', () => {
  let s = { day: T, usd: 0 }
  s = recordDailySpend(s, 20, T)
  s = recordDailySpend(s, 15, T)
  assert.deepEqual(s, { day: T, usd: 35 })
  // next day → resets to just the new spend
  s = recordDailySpend(s, 10, '2026-06-16')
  assert.deepEqual(s, { day: '2026-06-16', usd: 10 })
})

test('exact-cap boundary is allowed (<=, not <)', () => {
  const r = checkDailyCap({ day: T, usd: 80 }, 20, 100, T)
  assert.equal(r.allowed, true, 'spending exactly up to the cap is fine')
  assert.equal(r.remaining, 0)
})

// ── circuit breaker ──────────────────────────────────────────────────────────
test('breaker: does not trip when within limits (or when limits are off)', () => {
  assert.equal(evaluateBreaker({ realizedUsd: -200, spentUsd: 9999 }, 0, 0).tripped, false, 'both caps off → never trips')
  assert.equal(evaluateBreaker({ realizedUsd: -20, spentUsd: 80 }, 30, 150).tripped, false, 'within both caps')
})

test('breaker: trips on cumulative loss limit', () => {
  const r = evaluateBreaker({ realizedUsd: -31, spentUsd: 0 }, 30, 0)
  assert.equal(r.tripped, true)
  assert.match(r.reason, /cumulative live loss/i)
  // exactly -cap also trips (<=)
  assert.equal(evaluateBreaker({ realizedUsd: -30, spentUsd: 0 }, 30, 0).tripped, true)
  assert.equal(evaluateBreaker({ realizedUsd: -29.99, spentUsd: 0 }, 30, 0).tripped, false)
})

test('breaker: trips on lifetime-spend ceiling', () => {
  const r = evaluateBreaker({ realizedUsd: 50, spentUsd: 150 }, 0, 150)
  assert.equal(r.tripped, true)
  assert.match(r.reason, /lifetime live spend/i)
  assert.equal(evaluateBreaker({ realizedUsd: 0, spentUsd: 149 }, 0, 150).tripped, false)
})
