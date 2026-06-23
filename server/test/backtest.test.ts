// Backtester + Profit Finder over deterministic synthetic markets, with
// fetch mocked so candle data is fully controlled (no network).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-bt-'))

const { simulate, backtest, profitFinder, computeEdge } = await import('../src/backtest.js')
const { STRATEGIES } = await import('../src/strategies.js')
const { RISK } = await import('../src/risk.js')
const { networkById, NETWORKS } = await import('../src/networks.js')
const { SLIPPAGE_PER_SIDE, LP_FEE_PER_SIDE, SLIPPAGE_IMPACT_PER_SIDE } = await import('../src/costs.js')

// ── P0-9: realistic cost model ────────────────────────────────────────────────
test('cost model: per-side cost = LP fee + slippage/impact, in the realistic ~1–1.5%/side band', () => {
  assert.ok(Math.abs(SLIPPAGE_PER_SIDE - (LP_FEE_PER_SIDE + SLIPPAGE_IMPACT_PER_SIDE)) < 1e-12, 'total = LP fee + slippage/impact')
  assert.ok(SLIPPAGE_PER_SIDE >= 0.009 && SLIPPAGE_PER_SIDE <= 0.015, `~1–1.5%/side (was 0.15%, then 0.6%), got ${(SLIPPAGE_PER_SIDE * 100).toFixed(2)}%`)
  assert.ok(LP_FEE_PER_SIDE >= 0.002, 'an explicit LP-fee component is charged')
})

test('cost model: the first sell pays a one-time approve-gas leg on top of the swap gas', () => {
  // Isolate the gas component by differencing two runs whose trade path is IDENTICAL: a
  // huge budget makes a $1 gas negligible vs cash, so gas never tips a decision (asserted
  // via equal trade counts). Then feesUsd(gas) − feesUsd(0) is pure gas = one charge per
  // buy + one per sell + ONE extra for the first-sell ERC-20 approval.
  const c = sineCandles()
  const G = 1
  const r0 = simulate(c, { strategy: 'meanrev', risk: 'balanced', budgetUsd: 1_000_000, gasUsd: 0 })
  const rG = simulate(c, { strategy: 'meanrev', risk: 'balanced', budgetUsd: 1_000_000, gasUsd: G })
  assert.equal(rG.trades, r0.trades, 'gas negligible vs budget → identical trade path')
  assert.ok(rG.wins + rG.losses > 0, 'the scenario produced at least one sell')
  // gas portion ≈ (every buy + every sell + ONE first-sell approval) × gas. Gas feeds back
  // into qty → gross → slippage by a hair, so assert the gas portion lands closer to the
  // WITH-approval count (trades+1) than the without (trades) — i.e. the approve leg is charged.
  const gasPortion = rG.feesUsd - r0.feesUsd
  const withApprove = (rG.trades + 1) * G
  const without = rG.trades * G
  assert.ok(
    Math.abs(gasPortion - withApprove) < Math.abs(gasPortion - without),
    `fees include the one-time first-sell approval: gas portion ${gasPortion.toFixed(2)} is closer to (trades+1)×g=${withApprove} than trades×g=${without}`,
  )
})

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

/** Deterministic small-state PRNG so noisy markets are reproducible per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Realistic noisy-ranging market: a gentle sine carrier plus seeded chop
 * (additive around the ~100 baseline, so ≈ proportional there). THIS is what
 * grid trading is actually tuned for — the smooth sineCandles()/downCandles()
 * curves above are frictionless artifacts that systematically mis-rank grid
 * spacing (see the regime-flip guard below). The default amp/noise sit in a
 * regime that beats the rejected widening in all 10 seeds; the generator is
 * parameterised so future tuning can probe other chop levels.
 * Same seed ⇒ identical series, so assertions stay deterministic.
 */
function noisyRangingCandles(seed: number, { n = 720, amp = 1, noise = 4 } = {}): { t: number; c: number }[] {
  const rand = mulberry32(seed)
  return Array.from({ length: n }, (_, i) => ({
    t: T0 + i * HOUR,
    c: 100 + amp * Math.sin(i / 8) + (rand() - 0.5) * noise,
  }))
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

test('simulate: realistic per-side fees turn a low-amplitude grid NET-NEGATIVE (fee churn)', () => {
  // The honest lesson of the corrected cost model: a tight/low-amplitude grid
  // re-crosses the same levels paying ~1.2% round-trip every cycle, so on this
  // synthetic sine it now LOSES money — exactly the trap of judging grid on a
  // smooth curve with a too-cheap fee model. It still books many rung trades.
  const r = simulate(sineCandles(), { strategy: 'grid', risk: 'balanced', budgetUsd: 1000, gasUsd: 0.02 })
  assert.ok(!r.error, r.error)
  assert.ok(r.trades > 10, `expected many rung trades, got ${r.trades}`)
  assert.ok(r.feesUsd > 0, 'fees charged')
  assert.ok(r.returnPct < 0, `realistic fees make this grid net-negative, got ${r.returnPct}%`)
})

// ── Grid spacing must be validated on noisy markets, not smooth curves ─────────
// The conservative grid tier (4 levels / 1.5% spacing) was once challenged by a
// proposal to widen it to 6 / 2.5. On the smooth sineCandles() curve the wide
// params look better — but a frictionless sinusoid is an artifact: tight spacing
// re-crosses the same price levels with ~zero net travel between crossings, so it
// pays round-trip fees without ever capturing range. Add realistic chop and the
// ranking inverts, because grid trading earns its keep harvesting high-frequency
// wiggles that wide spacing steps right over. These two tests pin BOTH regimes so
// no future grid-knob change can be justified by smooth-curve numbers alone.
const TIGHT_GRID = { gridLevels: 4, gridSpacingPct: 1.5 } // == live conservative tier
const WIDE_GRID = { gridLevels: 6, gridSpacingPct: 2.5 } //  the rejected widening
// Every distinct on-chain gas profile, cheapest → priciest (icp 0.001 … bnb 0.1).
// Pulled from NETWORKS so new chains are covered automatically.
const GAS_PROFILES = [...new Set(NETWORKS.map((n) => n.avgGasUsd))].sort((a, b) => a - b)

// Grid pulls only gridLevels/gridSpacingPct from the risk tier, so paramsOverride
// lets us compare exact grid geometries independent of the live tier values —
// the guard keeps working even if someone edits the conservative tier itself.
const gridReturn = (candles: { t: number; c: number }[], grid: typeof TIGHT_GRID, gasUsd: number): number =>
  simulate(candles, { strategy: 'grid', risk: 'conservative', budgetUsd: 1000, gasUsd, paramsOverride: grid }).returnPct

test('grid tuning: the smooth sine curve is misleading — it favours WIDE spacing', () => {
  for (const gasUsd of GAS_PROFILES) {
    const tight = gridReturn(sineCandles(), TIGHT_GRID, gasUsd)
    const wide = gridReturn(sineCandles(), WIDE_GRID, gasUsd)
    // On the frictionless sinusoid tight spacing looks catastrophic (pure fee
    // churn, no captured range) while wide spacing looks fine. Tuning here picks
    // the wrong knobs — exactly the trap this suite exists to flag.
    assert.ok(tight < 0, `smooth/gas ${gasUsd}: tight should look unprofitable, got ${tight}%`)
    assert.ok(wide > tight, `smooth/gas ${gasUsd}: wide ${wide}% must out-rank tight ${tight}% on smooth sine`)
  }
})

test('grid tuning: realistic costs ERASE the tight-grid edge on chop (high turnover no longer pays)', () => {
  // At toy fees a TIGHT grid out-harvests a wide one on chop (more rungs filled). At the
  // honest ~1%/side cost model that edge is GONE: the extra trades cost more than the extra
  // range they capture, so tight no longer beats wide on average. This is the whole point of
  // the realistic model — it stops the Profit Finder ranking high-churn configs as winners. [P0-9]
  let tightTotal = 0
  let wideTotal = 0
  let n = 0
  for (const gasUsd of GAS_PROFILES) {
    for (let seed = 1; seed <= 10; seed++) {
      tightTotal += gridReturn(noisyRangingCandles(seed), TIGHT_GRID, gasUsd)
      wideTotal += gridReturn(noisyRangingCandles(seed), WIDE_GRID, gasUsd)
      n++
    }
  }
  const meanGap = (tightTotal - wideTotal) / n
  assert.ok(meanGap <= 0, `under realistic costs tight no longer beats wide on chop (mean gap ${meanGap.toFixed(2)}pp, was positive at toy fees)`)
})

test('simulate: every result is internally consistent', () => {
  for (const s of STRATEGIES) {
    for (const risk of Object.keys(RISK)) {
      for (const candles of [sineCandles(), downCandles(), noisyRangingCandles(7)]) {
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

// ── Walk-forward (out-of-sample) returns ─────────────────────────────────────
// The Profit Finder ranks on oosReturnPct so it can't headline a coin purely on a
// stale early pump that won't repeat.

test('walk-forward: a dead-flat FINAL third yields ~0 out-of-sample, no matter the early pump', () => {
  const n = 240
  // Ramp 100→160 over the first half (a big in-sample gain), then perfectly flat.
  const candles = Array.from({ length: n }, (_, i) => ({ t: T0 + i * HOUR, c: i < n / 2 ? 100 + (60 * i) / (n / 2) : 160 }))
  const r = simulate(candles, { strategy: 'adaptive', risk: 'balanced', budgetUsd: 1000, gasUsd: 0.02 })
  assert.ok(!r.error)
  assert.ok(Number.isFinite(r.oosReturnPct))
  // Price is constant through the out-of-sample window → equity can't grow there →
  // the OOS return is ~0 even though the full-window return banked the early ramp.
  assert.ok(Math.abs(r.oosReturnPct) < 2, `flat final third → ~0 OOS, got ${r.oosReturnPct}`)
})

test('walk-forward: a flat market is ~0 out-of-sample (no phantom gains)', () => {
  const candles = Array.from({ length: 200 }, (_, i) => ({ t: T0 + i * HOUR, c: 100 }))
  const r = simulate(candles, { strategy: 'adaptive', risk: 'balanced', budgetUsd: 1000, gasUsd: 0.02 })
  assert.ok(Math.abs(r.oosReturnPct) < 1, `flat market → ~0 OOS, got ${r.oosReturnPct}`)
})

test('profit finder: rows expose the in-sample reference and the result carries a caveat', async () => {
  const out = await profitFinder({ budgetUsd: 100, network: 'polygon', token: 'LINK' })
  assert.ok(!('error' in out))
  const res = out as Exclude<typeof out, { error: string }>
  assert.ok(res.caveat && /out-of-sample/i.test(res.caveat), 'curated scope carries the walk-forward note')
  for (const row of res.rows) assert.equal(typeof row.inSampleReturnPct, 'number', 'each row exposes the in-sample reference')
})

// ── #1 honest edge measurement: the label must be conservative and luck-aware ──
test('computeEdge: a consistent post-fee winner with positive OOS reads "significant"', () => {
  const rets = [0.05, 0.02, 0.04, 0.03, 0.06, 0.01, 0.05, 0.03, 0.04, 0.02, 0.05, 0.03] // 12 wins, varied
  const e = computeEdge(rets, [], 20)
  assert.equal(e.trades, 12)
  assert.ok(e.expectancyPct > 0)
  assert.ok(e.tStat >= 2, `t-stat ${e.tStat}`)
  assert.ok(e.pValue <= 0.05, `p ${e.pValue}`)
  assert.equal(e.verdict, 'significant')
})

test('computeEdge: a positive in-sample result that FAILS walk-forward (OOS ≤ 0) reads "no-edge"', () => {
  const rets = [0.08, -0.05, 0.06, -0.04, 0.07, -0.06, 0.05, -0.03, 0.04, -0.05]
  assert.equal(computeEdge(rets, [], -5).verdict, 'no-edge', 'a negative out-of-sample return is honestly labelled no-edge')
})

test('computeEdge: too few trades is "inconclusive" no matter how rosy the return', () => {
  assert.equal(computeEdge([0.1, 0.2, 0.05], [], 50).verdict, 'inconclusive')
  assert.equal(computeEdge([], [], 50).verdict, 'inconclusive', 'zero trades is inconclusive, never an edge')
})

test('computeEdge is deterministic (seeded bootstrap) — same input, same p-value', () => {
  const rets = [0.03, -0.02, 0.04, 0.01, -0.03, 0.05, 0.02, -0.01, 0.03, 0.02]
  assert.equal(computeEdge(rets, [], 8).pValue, computeEdge(rets, [], 8).pValue)
})

test('simulate attaches an edge verdict to every result', () => {
  const candles = Array.from({ length: 120 }, (_, i) => ({ t: i * 3.6e6, c: 100 + Math.sin(i / 5) * 8 }))
  const r = simulate(candles, { strategy: 'grid', risk: 'balanced', budgetUsd: 1000, gasUsd: 0.02 })
  assert.ok(r.edge && typeof r.edge.verdict === 'string')
  assert.ok(['no-edge', 'inconclusive', 'weak', 'significant'].includes(r.edge.verdict))
})
