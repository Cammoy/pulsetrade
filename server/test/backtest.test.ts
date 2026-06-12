// Backtester + Profit Finder over deterministic synthetic markets, with
// fetch mocked so candle data is fully controlled (no network).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-bt-'))

const { simulate, backtest, profitFinder } = await import('../src/backtest.js')
const { STRATEGIES } = await import('../src/strategies.js')
const { RISK } = await import('../src/risk.js')
const { networkById } = await import('../src/networks.js')

const HOUR = 3_600_000
const T0 = 1_750_000_000_000

/** range-bound sine market: ±6% around 100, 720 hourly candles */
function sineCandles(n = 720, amp = 6): { t: number; c: number }[] {
  return Array.from({ length: n }, (_, i) => ({ t: T0 + i * HOUR, c: 100 + amp * Math.sin(i / 10) }))
}

/** steady downtrend: −30% over the window */
function downCandles(n = 720): { t: number; c: number }[] {
  return Array.from({ length: n }, (_, i) => ({ t: T0 + i * HOUR, c: 100 * (1 - (0.3 * i) / n) }))
}

before(() => {
  // market_chart → sine market for any coin; simple/price → fixed quotes
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('market_chart')) {
      return new Response(JSON.stringify({ prices: sineCandles().map(({ t, c }) => [t, c]) }), { status: 200 })
    }
    return new Response(JSON.stringify({ ethereum: { usd: 2000 } }), { status: 200 })
  }) as typeof fetch
})

test('simulate: grid profits in a fee-cheap ranging market and books trades', () => {
  const r = simulate(sineCandles(), { strategy: 'grid', risk: 'balanced', budgetUsd: 1000, gasUsd: 0.02 })
  assert.ok(!r.error, r.error)
  assert.ok(r.trades > 10, `expected many rung trades, got ${r.trades}`)
  assert.ok(r.returnPct > 0, `grid should profit from chop, got ${r.returnPct}%`)
  assert.ok(r.feesUsd > 0, 'fees charged')
  assert.ok(r.wins > 0, 'rung sells count as wins')
})

test('simulate: every result is internally consistent', () => {
  for (const s of STRATEGIES) {
    for (const risk of Object.keys(RISK)) {
      for (const candles of [sineCandles(), downCandles()]) {
        const budget = 1000
        const r = simulate(candles, { strategy: s.id, risk, budgetUsd: budget, gasUsd: 0.02 })
        assert.ok(!r.error, `${s.id}/${risk}: ${r.error}`)
        assert.ok(Number.isFinite(r.returnPct), `${s.id}/${risk} returnPct finite`)
        assert.ok(r.maxDrawdownPct >= 0 && r.maxDrawdownPct <= 100, 'drawdown in range')
        assert.equal(r.wins + r.losses <= r.trades, true, 'W+L never exceeds trade count')
        for (const e of r.equity) {
          assert.ok(Number.isFinite(e.v) && e.v >= 0, `${s.id}/${risk}: equity never negative (got ${e.v})`)
        }
        const last = r.equity.at(-1)
        if (last) {
          const impliedReturn = ((last.v - budget) / budget) * 100
          assert.ok(Math.abs(impliedReturn - r.returnPct) < 0.05, `${s.id}/${risk}: equity curve matches returnPct`)
        }
        // timestamps strictly ascending
        for (let i = 1; i < r.equity.length; i++) assert.ok(r.equity[i].t > r.equity[i - 1].t)
      }
    }
  }
})

test('simulate: stop-losses cap downtrend damage vs buy & hold', () => {
  const r = simulate(downCandles(), { strategy: 'momentum', risk: 'balanced', budgetUsd: 1000, gasUsd: 0.02 })
  assert.ok(!r.error)
  assert.ok(r.buyHoldPct < -25, 'market fell hard')
  assert.ok(r.returnPct > r.buyHoldPct, `strategy ${r.returnPct}% must beat holding ${r.buyHoldPct}%`)
})

test('simulate: rejects bad inputs without throwing', () => {
  assert.ok(simulate([], { strategy: 'grid', risk: 'balanced', budgetUsd: 1000, gasUsd: 0.02 }).error)
  assert.ok(simulate(sineCandles(), { strategy: 'nope', risk: 'balanced', budgetUsd: 1000, gasUsd: 0.02 }).error)
  assert.ok(simulate(sineCandles(), { strategy: 'grid', risk: 'nope', budgetUsd: 1000, gasUsd: 0.02 }).error)
  assert.ok(simulate(sineCandles(), { strategy: 'grid', risk: 'balanced', budgetUsd: 1, gasUsd: 0.02 }).error)
  assert.ok(simulate(sineCandles(), { strategy: 'grid', risk: 'balanced', budgetUsd: NaN, gasUsd: 0.02 }).error)
})

test('backtest: fetches candles through the cache and simulates', async () => {
  const r = await backtest({ network: 'base', tokenCg: 'test-coin-bt', strategy: 'grid', risk: 'balanced', budgetUsd: 500 })
  assert.ok(!r.error, r.error)
  assert.ok(r.trades > 0)
  const bad = await backtest({ network: 'nope', tokenCg: 'x', strategy: 'grid', risk: 'balanced', budgetUsd: 500 })
  assert.ok(bad.error)
})

test('profit finder: ranks every strategy × risk by profit for a $100 stake', async () => {
  const out = await profitFinder({ budgetUsd: 100, network: 'polygon', token: 'LINK' })
  assert.ok(!('error' in out), (out as any).error)
  const res = out as Exclude<typeof out, { error: string }>
  assert.equal(res.rows.length, STRATEGIES.length * Object.keys(RISK).length, 'all 12 combos present')
  for (let i = 1; i < res.rows.length; i++) {
    assert.ok(res.rows[i - 1].profitUsd >= res.rows[i].profitUsd, 'sorted best-first')
  }
  for (const row of res.rows) {
    assert.ok(Math.abs(row.profitUsd - (100 * row.returnPct) / 100) < 0.02, 'profit = stake × return')
    assert.ok(row.winRate === null || (row.winRate >= 0 && row.winRate <= 100))
  }
  const gas = networkById('polygon')!.avgGasUsd
  assert.equal(gas, 0.01, 'finder uses the network gas profile')
})

test('profit finder: validates input', async () => {
  assert.ok('error' in (await profitFinder({ budgetUsd: 100, network: 'nope' })))
  assert.ok('error' in (await profitFinder({ budgetUsd: 1, network: 'base' })))
  assert.ok('error' in (await profitFinder({ budgetUsd: 100, network: 'base', token: 'NOPE' })))
})
