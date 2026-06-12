import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sma, ema, emaSeries, rsi } from '../src/indicators.js'

test('sma averages the trailing window', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5)
  assert.equal(sma([10, 20, 30], 3), 20)
  assert.ok(Number.isNaN(sma([1, 2], 3)), 'NaN when not enough data')
})

test('ema seeds with SMA then smooths', () => {
  // period 3, k = 0.5: seed sma(1,2,3)=2; ema(4) = 4*0.5 + 2*0.5 = 3
  assert.equal(ema([1, 2, 3, 4], 3), 3)
  const series = emaSeries([1, 2, 3, 4], 3)
  assert.ok(Number.isNaN(series[0]) && Number.isNaN(series[1]), 'warm-up is NaN')
  assert.equal(series[2], 2)
  assert.equal(series[3], 3)
  assert.ok(Number.isNaN(ema([1, 2], 3)))
})

test('rsi extremes and midpoint', () => {
  const up = Array.from({ length: 20 }, (_, i) => i + 1)
  assert.equal(rsi(up, 14), 100, 'all gains → 100')
  const down = Array.from({ length: 20 }, (_, i) => 20 - i)
  assert.equal(rsi(down, 14), 0, 'all losses → 0')
  // period 2 on [1,2,1]: avg gain 0.5, avg loss 0.5 → RS 1 → RSI 50
  assert.equal(rsi([1, 2, 1], 2), 50)
  assert.ok(Number.isNaN(rsi([1, 2, 3], 14)), 'NaN when not enough data')
})

test('rsi stays within [0, 100] on noisy data', () => {
  let x = 100
  const noisy = Array.from({ length: 200 }, (_, i) => (x += Math.sin(i * 1.7) * 3))
  const r = rsi(noisy, 14)
  assert.ok(r >= 0 && r <= 100 && !Number.isNaN(r))
})
