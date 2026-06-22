// The meanrev trend-regime gate: skip "oversold" entries inside a confirmed
// downtrend (don't catch a falling knife), but still enter on a shallow dip.
// Each test asserts the PRECONDITION (so it's self-validating) then the decide()
// behavior, proving it's the GATE — not the RSI — that blocks/allows.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { strategyById, simulate } = await import('../src/strategies.js').then(async (s) => ({
  strategyById: s.strategyById,
  simulate: (await import('../src/backtest.js')).simulate,
}))
const { sma, rsi } = await import('../src/indicators.js')
const { RISK } = await import('../src/risk.js')

const meanrev = strategyById('meanrev')!
const params = RISK.balanced // rsiBuy 30
const pctFrom = (price: number, avg: number) => ((price - avg) / avg) * 100

function ctxFor(closes: number[]) {
  return {
    price: closes[closes.length - 1],
    closes,
    params,
    state: {} as Record<string, unknown>,
    position: { qty: 0, avgCostUsd: 0, costUsd: 0 },
    budgetUsd: 1000,
    cashUsd: 1000,
    now: closes.length * 3_600_000,
  }
}

test('gate BLOCKS an oversold entry in a confirmed downtrend (price far below 50h avg)', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 * 0.98 ** i) // steady ~2%/h decline
  const price = closes[closes.length - 1]
  // Precondition: deeply below the long average AND oversold — so WITHOUT the
  // gate this would be a buy.
  assert.ok(pctFrom(price, sma(closes, 50)) < -8, 'precondition: price > 8% below 50h SMA')
  assert.ok(rsi(closes, 14) < params.rsiBuy, 'precondition: RSI is oversold')
  assert.equal(meanrev.decide(ctxFor(closes)), null, 'gate blocks the falling-knife entry')
})

test('gate ALLOWS an oversold entry on a shallow pullback (price near the 50h avg)', () => {
  // 50 flat, then a gentle 14-step dip — oversold RSI but price still near avg.
  const closes = [...Array(50).fill(100), ...Array.from({ length: 14 }, (_, i) => 100 - 0.4 * (i + 1))]
  const price = closes[closes.length - 1]
  assert.ok(pctFrom(price, sma(closes, 50)) > -8, 'precondition: shallow dip, within 8% of 50h SMA')
  assert.ok(rsi(closes, 14) < params.rsiBuy, 'precondition: RSI is oversold')
  const a = meanrev.decide(ctxFor(closes))
  assert.equal(a?.type, 'buy', 'gate allows a normal mean-reversion entry')
})

test('gate does not break ranging-market profitability (still trades, not catastrophic)', () => {
  // Deterministic ranging series: oscillation around a flat mean.
  const closes = Array.from({ length: 400 }, (_, i) => ({ t: i * 3_600_000, c: 100 + 6 * Math.sin(i / 9) }))
  const r = simulate(closes, { strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000, gasUsd: 0.02 })
  assert.ok(r.trades > 0, 'still trades in a ranging market')
  // Under the realistic ~1%/side cost model, mean-reversion's high turnover bleeds a few
  // percent to fees in a tight range (the honest result — not a profit engine here). The
  // gate's job is only that it doesn't BLOW UP: a bounded loss, never a −20%+ catastrophe. [P0-9]
  assert.ok(r.returnPct > -8, `not catastrophic in range (got ${r.returnPct}%)`)
})
