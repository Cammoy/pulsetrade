import { describe, it, expect } from 'vitest'
import { computeProfit, priceForMultiple, priceFromMarketCap } from './calc'

const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('computeProfit — long spot round-trip', () => {
  it('a clean 2× (no fee): $100 at $1 → $2', () => {
    const r = computeProfit({ entryPrice: 1, exitPrice: 2, amount: 100, amountMode: 'usd' })
    expect(r.valid).toBe(true)
    near(r.quantity, 100)
    near(r.costUsd, 100)
    near(r.exitValueUsd, 200)
    near(r.profitUsd, 100)
    near(r.profitPct, 100)
    near(r.roi, 2)
    near(r.priceChangePct, 100)
    near(r.breakEvenPrice, 1) // no fee → break-even is the entry price
  })

  it('a loss: $100 at $2 → $1 halves the money', () => {
    const r = computeProfit({ entryPrice: 2, exitPrice: 1, amount: 100, amountMode: 'usd' })
    near(r.quantity, 50)
    near(r.exitValueUsd, 50)
    near(r.profitUsd, -50)
    near(r.profitPct, -50)
    near(r.roi, 0.5)
    near(r.priceChangePct, -50)
  })

  it('quantity mode: hold 10 coins bought at $5, sell at $8', () => {
    const r = computeProfit({ entryPrice: 5, exitPrice: 8, amount: 10, amountMode: 'qty' })
    near(r.quantity, 10)
    near(r.costUsd, 50)
    near(r.exitValueUsd, 80)
    near(r.profitUsd, 30)
    near(r.profitPct, 60)
  })

  it('fees apply to BOTH legs and shift the break-even above entry', () => {
    const r = computeProfit({ entryPrice: 1, exitPrice: 2, amount: 100, amountMode: 'usd', feePct: 1 })
    near(r.quantity, 99) // $100 × (1 − 0.01) / $1
    near(r.exitValueUsd, 99 * 2 * 0.99) // 196.02
    near(r.profitUsd, 99 * 2 * 0.99 - 100) // 96.02
    near(r.breakEvenPrice, 100 / (99 * 0.99)) // ≈ 1.0203
    // at the break-even exit price, profit is ~0
    const be = computeProfit({ entryPrice: 1, exitPrice: r.breakEvenPrice, amount: 100, amountMode: 'usd', feePct: 1 })
    near(be.profitUsd, 0, 1e-6)
  })

  it('a tiny sub-cent coin scales exactly (no precision blow-up)', () => {
    const r = computeProfit({ entryPrice: 0.0000004621, exitPrice: 0.0000009242, amount: 50, amountMode: 'usd' })
    near(r.roi, 2, 1e-9)
    near(r.profitUsd, 50, 1e-6)
  })

  it('invalid inputs return valid:false, never NaN', () => {
    for (const bad of [
      { entryPrice: 0, exitPrice: 2, amount: 100, amountMode: 'usd' as const },
      { entryPrice: 1, exitPrice: 2, amount: 0, amountMode: 'usd' as const },
      { entryPrice: NaN, exitPrice: 2, amount: 100, amountMode: 'usd' as const },
    ]) {
      const r = computeProfit(bad)
      expect(r.valid).toBe(false)
      expect(Number.isFinite(r.profitUsd)).toBe(true)
    }
  })

  it('exit price 0 (rug to zero) loses the whole stake, never NaN', () => {
    const r = computeProfit({ entryPrice: 1, exitPrice: 0, amount: 100, amountMode: 'usd' })
    expect(r.valid).toBe(true)
    near(r.profitUsd, -100)
    near(r.exitValueUsd, 0)
  })
})

describe('priceForMultiple', () => {
  it('maps a multiple to the exit price', () => {
    near(priceForMultiple(1.5, 10), 15)
    near(priceForMultiple(0.0000004621, 5), 0.0000023105)
  })
})

describe('priceFromMarketCap — the market-cap → price conversion', () => {
  it('implied price = target market cap ÷ circulating supply', () => {
    // PEPE-like: a $2B cap across 420.69T coins ⇒ a sub-cent price
    near(priceFromMarketCap(2_000_000_000, 420_690_000_000_000), 2e9 / 420.69e12)
    // a $1T cap across 20M coins (BTC-like) ⇒ $50,000
    near(priceFromMarketCap(1_000_000_000_000, 20_000_000), 50_000)
  })

  it('feeds computeProfit so a market-cap target is exact end-to-end', () => {
    // Buy $100 of a coin at $1 (1B supply ⇒ $1B cap). Target a $3B cap ⇒ implied $3 ⇒ 3×.
    const supply = 1_000_000_000
    const exitPrice = priceFromMarketCap(3_000_000_000, supply)
    near(exitPrice, 3)
    const r = computeProfit({ entryPrice: 1, exitPrice, amount: 100, amountMode: 'usd' })
    near(r.profitUsd, 200) // $100 → $300
    near(r.roi, 3)
  })

  it('returns 0 without a usable supply (can NOT target a cap) — never NaN', () => {
    expect(priceFromMarketCap(1_000_000_000, 0)).toBe(0)
    expect(priceFromMarketCap(1_000_000_000, NaN)).toBe(0)
    expect(Number.isFinite(priceFromMarketCap(NaN, 1000))).toBe(true)
  })
})
