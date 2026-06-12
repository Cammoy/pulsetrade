import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strategyById, type Ctx } from '../src/strategies.js'
import { emaSeries } from '../src/indicators.js'
import { RISK } from '../src/risk.js'

const NOW = 1_750_000_000_000

function ctx(over: Partial<Ctx>): Ctx {
  return {
    price: 100,
    closes: Array(40).fill(100),
    params: RISK.balanced,
    state: {},
    position: { qty: 0, avgCostUsd: 0, costUsd: 0 },
    budgetUsd: 1000,
    cashUsd: 1000,
    now: NOW,
    ...over,
  }
}

// ── Grid ─────────────────────────────────────────────────────────────────────

test('grid: anchors on first tick, buys one rung on a level-down cross', () => {
  const grid = strategyById('grid')!
  const state: Record<string, any> = {}
  assert.equal(grid.decide(ctx({ state, price: 100 })), null, 'anchor tick takes no action')
  assert.equal(state.anchor, 100)

  // balanced spacing 2.5% → 98 is one level down
  const a = grid.decide(ctx({ state, price: 98 }))
  assert.ok(a && a.type === 'buy', 'buys the rung')
  assert.ok(Math.abs(a.usd - 1000 / RISK.balanced.gridLevels) < 1e-9, 'one slice = budget / levels')
})

test('grid: sells a rung when price crosses back up', () => {
  const grid = strategyById('grid')!
  const state: Record<string, any> = { anchor: 100, lastLevel: -1 }
  const slice = 1000 / RISK.balanced.gridLevels
  const a = grid.decide(
    ctx({ state, price: 100.5, position: { qty: 1.6, avgCostUsd: slice / 1.6, costUsd: slice }, cashUsd: 1000 - slice }),
  )
  assert.ok(a && a.type === 'sell', 'sells on level-up cross')
  assert.equal(a.fraction, 1, 'one rung held → sell it all')
})

test('grid: hard stop fires far below the bottom rung and re-anchors', () => {
  const grid = strategyById('grid')!
  const state: Record<string, any> = { anchor: 100, lastLevel: -3 }
  const a = grid.decide(ctx({ state, price: 70, position: { qty: 5, avgCostUsd: 95, costUsd: 475 } }))
  assert.ok(a && a.type === 'sell' && a.fraction === 1 && a.exit, 'full exit')
  assert.match(a.reason, /hard stop/i)
  assert.equal(state.anchor, 70, 're-anchored at current price')
})

test('grid: does not buy below the bottom rung', () => {
  const grid = strategyById('grid')!
  const levels = RISK.balanced.gridLevels
  const state: Record<string, any> = { anchor: 100, lastLevel: -levels }
  // one more level down, still above the hard-stop band, holding nothing
  const price = 100 * Math.pow(1.025, -(levels + 1)) * 1.001
  const a = grid.decide(ctx({ state, price }))
  assert.equal(a, null, 'ladder exhausted → no buy')
})

// ── RSI Mean Reversion ───────────────────────────────────────────────────────

const falling = Array.from({ length: 40 }, (_, i) => 200 - i * 2) // RSI ~0
const rising = Array.from({ length: 40 }, (_, i) => 100 + i * 2) // RSI ~100

test('meanrev: buys oversold with the risk-tier position size', () => {
  const mr = strategyById('meanrev')!
  const a = mr.decide(ctx({ closes: falling, price: falling.at(-1)! }))
  assert.ok(a && a.type === 'buy')
  assert.equal(a.usd, (1000 * RISK.balanced.positionPct) / 100)
})

test('meanrev: respects cooldown after an exit', () => {
  const mr = strategyById('meanrev')!
  const state = { lastExitAt: NOW - (RISK.balanced.cooldownMin - 1) * 60_000 }
  assert.equal(mr.decide(ctx({ state, closes: falling, price: falling.at(-1)! })), null, 'cooling down')
  const cooled = { lastExitAt: NOW - (RISK.balanced.cooldownMin + 1) * 60_000 }
  assert.ok(mr.decide(ctx({ state: cooled, closes: falling, price: falling.at(-1)! })), 'trades again after cooldown')
})

test('meanrev: take-profit and stop-loss exits', () => {
  const mr = strategyById('meanrev')!
  const pos = { qty: 2, avgCostUsd: 100, costUsd: 200 }
  const tp = mr.decide(ctx({ position: pos, price: 100 * (1 + RISK.balanced.takeProfitPct / 100 + 0.001) }))
  assert.ok(tp && tp.type === 'sell' && tp.exit && /take-profit/i.test(tp.reason))
  const sl = mr.decide(ctx({ position: pos, price: 100 * (1 - RISK.balanced.stopLossPct / 100 - 0.001) }))
  assert.ok(sl && sl.type === 'sell' && sl.exit && /stop-loss/i.test(sl.reason))
})

test('meanrev: exits overbought only when in profit', () => {
  const mr = strategyById('meanrev')!
  const price = rising.at(-1)!
  const inProfit = mr.decide(ctx({ closes: rising, price, position: { qty: 1, avgCostUsd: price * 0.99, costUsd: price } }))
  assert.ok(inProfit && inProfit.type === 'sell' && /overbought/i.test(inProfit.reason))
  const atLoss = mr.decide(ctx({ closes: rising, price, position: { qty: 1, avgCostUsd: price * 1.02, costUsd: price } }))
  assert.equal(atLoss, null, 'no panic-sell of a losing position on RSI alone')
})

// ── EMA Momentum ─────────────────────────────────────────────────────────────

function findCross(closes: number[], dir: 'up' | 'down'): number {
  const f = emaSeries(closes, 9)
  const s = emaSeries(closes, 21)
  for (let i = 22; i < closes.length; i++) {
    const above = f[i] > s[i]
    const was = f[i - 1] > s[i - 1]
    if (dir === 'up' && above && !was) return i
    if (dir === 'down' && !above && was) return i
  }
  return -1
}

test('momentum: buys exactly on the EMA cross-up, sells on cross-down', () => {
  const mom = strategyById('momentum')!
  const series = [...Array(30).fill(100), ...Array.from({ length: 15 }, (_, i) => 100 + (i + 1) * 1.5)]
  const i = findCross(series, 'up')
  assert.ok(i > 0, 'series contains a cross-up')
  const closes = series.slice(0, i + 1)
  const buy = mom.decide(ctx({ closes, price: closes.at(-1)! }))
  assert.ok(buy && buy.type === 'buy', 'buys on the cross')
  assert.equal(mom.decide(ctx({ closes: series.slice(0, i), price: series[i - 1] })), null, 'no buy before the cross')

  const downSeries = [...series, ...Array.from({ length: 25 }, (_, k) => series.at(-1)! - (k + 1) * 2)]
  const j = findCross(downSeries, 'down')
  assert.ok(j > i, 'series contains a later cross-down')
  const sell = mom.decide(
    ctx({ closes: downSeries.slice(0, j + 1), price: downSeries[j], position: { qty: 1, avgCostUsd: downSeries[j], costUsd: 100 } }),
  )
  assert.ok(sell && sell.type === 'sell' && sell.exit, 'sells on the cross-down')
})

// ── Smart DCA ────────────────────────────────────────────────────────────────

test('dca: buys a slice below the 24h average, then waits out the interval', () => {
  const dca = strategyById('dca')!
  const state: Record<string, any> = {}
  const a = dca.decide(ctx({ state, closes: Array(40).fill(100), price: 95 }))
  assert.ok(a && a.type === 'buy', 'dip + interval due → buy')
  assert.ok(Math.abs(a.usd - 1000 / RISK.balanced.dcaSlices) < 1e-9, 'slice = budget / slices')
  assert.equal(state.lastBuyAt, NOW)
  assert.equal(dca.decide(ctx({ state, closes: Array(40).fill(100), price: 94 })), null, 'interval not elapsed')
})

test('dca: never buys above the 24h average', () => {
  const dca = strategyById('dca')!
  assert.equal(dca.decide(ctx({ closes: Array(40).fill(100), price: 101 })), null)
})

test('dca: takes profit on avg cost and stops on capitulation', () => {
  const dca = strategyById('dca')!
  const pos = { qty: 5, avgCostUsd: 100, costUsd: 500 }
  const tp = dca.decide(ctx({ position: pos, price: 100 * (1 + RISK.balanced.takeProfitPct / 100 + 0.001) }))
  assert.ok(tp && tp.type === 'sell' && tp.exit && /take profit/i.test(tp.reason))
  const stop = dca.decide(ctx({ position: pos, price: 100 * (1 - (RISK.balanced.stopLossPct * 2.5) / 100) * 0.999 }))
  assert.ok(stop && stop.type === 'sell' && stop.exit && /capitulation/i.test(stop.reason))
})

// ── Risk tiers actually change behaviour ─────────────────────────────────────

test('risk tiers scale entries: aggressive buys more than conservative', () => {
  const mr = strategyById('meanrev')!
  const a = mr.decide(ctx({ closes: falling, price: falling.at(-1)!, params: RISK.aggressive }))
  const c = mr.decide(ctx({ closes: falling, price: falling.at(-1)!, params: RISK.conservative }))
  assert.ok(a && c && a.type === 'buy' && c.type === 'buy')
  assert.ok(a.usd > c.usd, `aggressive ${a.usd} > conservative ${c.usd}`)
})
