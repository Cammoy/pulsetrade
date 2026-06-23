// The All-Weather (adaptive) strategy: regime-switching for CAPITAL PRESERVATION.
// Deterministic synthetic regimes (seeded PRNG) run through the REAL simulate() so what's
// tested is what trades live. The spec: capture upside in up/range/choppy backtests, and —
// the point of the strategy — bound the loss in downtrends/crashes by moving to cash and
// beating the single strategies. It is a cautious default, not a profit-in-any-market promise.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { simulate } = await import('../src/backtest.js')
const { strategyById } = await import('../src/strategies.js')
const { RISK } = await import('../src/risk.js')

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
function gen(n: number, o: { drift?: number; vol?: number; wave?: number; wp?: number; seed: number; start?: number }) {
  const r = rng(o.seed)
  const out: { t: number; c: number }[] = []
  let p = o.start ?? 100
  for (let i = 0; i < n; i++) {
    const cyc = o.wave ? o.wave * Math.sin((2 * Math.PI * i) / (o.wp ?? 48)) : 0
    p = p * (1 + (o.drift ?? 0) + (o.vol ?? 0.01) * gauss(r))
    out.push({ t: i * 3_600_000, c: Math.max(1e-4, p * (1 + cyc)) })
  }
  return out
}
const REG = {
  range: () => gen(700, { vol: 0.006, wave: 0.05, wp: 60, seed: 11 }),
  downtrend: () => gen(700, { drift: -0.0025, vol: 0.012, seed: 22 }),
  uptrend: () => gen(700, { drift: 0.0028, vol: 0.012, seed: 33 }),
  choppy: () => gen(700, { vol: 0.02, seed: 44 }),
  reversal: () => {
    const up = gen(350, { drift: 0.0035, vol: 0.012, seed: 55 })
    const dn = gen(350, { start: up[up.length - 1].c, drift: -0.004, vol: 0.015, seed: 56 })
    return [...up, ...dn.map((c, i) => ({ t: (350 + i) * 3_600_000, c: c.c }))]
  },
}
const run = (reg: keyof typeof REG, strategy: string, risk = 'balanced') =>
  simulate(REG[reg](), { strategy, risk, budgetUsd: 1000, gasUsd: 0.02 })

test('all-weather: captures uptrend upside; bounded (not a profit engine) in range/chop after realistic costs', () => {
  // Under the honest ~1%/side cost model, the high-turnover range/chop behaviour is NOT a
  // money-maker — fees eat the small mean-reversion edge (range ≈ −1%, chop ≈ 0% with
  // ~45 trades). That is the truth the old "profits in any market" claim hid (P1-10): the
  // strategy's job is to ride trends and NOT bleed in chop, not to print in every regime. [P0-9]
  assert.ok(run('uptrend', 'adaptive').returnPct > 5, 'captures uptrend upside')
  assert.ok(run('range', 'adaptive').returnPct > -3, 'range: roughly flat / small loss after costs — bounded, not a bleed')
  assert.ok(run('choppy', 'adaptive').returnPct > -3, 'choppy: roughly flat after costs — bounded, not a bleed')
})

test('all-weather: capital-preserving in a brutal downtrend (cash defense)', () => {
  const a = run('downtrend', 'adaptive')
  // The market itself craters; the strategy must not follow it down.
  assert.ok(a.returnPct > -20, `downtrend loss bounded (got ${a.returnPct}%)`)
  // And it must beat the single strategies that get dragged down.
  assert.ok(a.returnPct > run('downtrend', 'dca').returnPct, 'beats DCA in a downtrend')
  assert.ok(a.returnPct > run('downtrend', 'grid').returnPct, 'beats Grid in a downtrend')
  assert.ok(a.maxDrawdownPct < 25, `drawdown contained (got ${a.maxDrawdownPct}%)`)
})

test('all-weather: stays positive through a bull-then-crash reversal', () => {
  const a = run('reversal', 'adaptive')
  // Rides the run-up, then exits to cash on the regime flip — net positive even
  // though buy-and-hold ends deep red.
  assert.ok(a.returnPct > 0, `positive through the reversal (got ${a.returnPct}%)`)
  assert.ok(a.returnPct > run('reversal', 'dca').returnPct, 'beats DCA through a crash')
  assert.ok(a.returnPct > run('reversal', 'grid').returnPct, 'beats Grid through a crash')
})

test('P1-10: a fast give-back from the peak exits IMMEDIATELY, before the 50h-average regime check', () => {
  // A position up +15% from a $100 entry, peak $130, now $115 (−11.5% off peak). The
  // 50h average sits ~$108 (well below price → NOT a "far below" downtrend), the EMAs
  // are still bullish, and chg is +15% (no stop-loss). The ONLY thing that should fire
  // is the fast crash exit — proving it doesn't wait for price to crater below the SMA.
  const adaptive = strategyById('adaptive')!
  const closes: number[] = []
  for (let i = 0; i < 60; i++) closes.push(100 + i * 0.25) // gentle uptrend → SMA50 < price, EMAs bullish
  const ctx: any = {
    price: 115,
    closes,
    params: RISK.balanced,
    state: { peak: 130 },
    position: { qty: 1, avgCostUsd: 100, costUsd: 100 },
    budgetUsd: 1000,
    cashUsd: 0,
    now: 0,
  }
  const a = adaptive.decide(ctx)
  assert.ok(a && a.type === 'sell' && a.exit, 'exits the position')
  assert.match(a!.reason, /crash exit/i, 'via the fast crash-from-peak exit, not the slow regime check')
})

test('all-weather: best worst-case across all regimes vs every single strategy', () => {
  const regimes = Object.keys(REG) as (keyof typeof REG)[]
  const strategies = ['adaptive', 'grid', 'meanrev', 'momentum', 'dca']
  const worst: Record<string, number> = {}
  for (const s of strategies) worst[s] = Math.min(...regimes.map((r) => run(r, s).returnPct))
  // The whole point of all-weather: the smallest worst-case loss of any strategy.
  const best = Math.max(...strategies.map((s) => worst[s]))
  assert.equal(worst.adaptive, best, `adaptive has the best worst-case (${JSON.stringify(worst)})`)
})
