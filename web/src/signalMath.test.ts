import { describe, test, expect } from 'vitest'
import { computeTrade, seedLevels, type TradePlan } from './signalMath'

const longPlan: TradePlan = { direction: 'LONG', entryLow: 99, entryHigh: 101, stopLoss: 95, tp1: 110, tp2: 120, tp3: 140, leverage: 5 }

describe('computeTrade', () => {
  test('a valid LONG plan: entry mid, stop %, R:R, sizing and per-TP outcomes', () => {
    const c = computeTrade(longPlan, 1000, 1)
    expect(c.valid).toBe(true)
    expect(c.entryMid).toBe(100)
    expect(c.stopPct).toBe(5) // (100-95)/100
    expect(c.riskReward).toBe(2) // (110-100)/(100-95)
    // risk-based size: $10 risk ÷ 5% stop = $200 notional; margin = 200/5
    expect(c.dollarRisk).toBe(10)
    expect(c.positionUsd).toBe(200)
    expect(c.marginUsd).toBe(40)
    // isolated liquidation estimate for a 5× long ≈ entry × (1 − 1/5)
    expect(c.liqPrice).toBe(80)
    // TP1 is +10% on $200 notional → +$20, and 2R
    expect(c.tps[0]).toMatchObject({ r: 2, profitUsd: 20 })
    expect(c.tps[2].r).toBe(8) // TP3 +40% / 5% stop
  })

  test('SHORT mirrors: stop above, targets below, liquidation above entry', () => {
    const c = computeTrade({ direction: 'SHORT', entryLow: 100, entryHigh: 100, stopLoss: 105, tp1: 90, tp2: 85, tp3: 80, leverage: 4 }, 2000, 2)
    expect(c.valid).toBe(true)
    expect(c.stopPct).toBe(5)
    expect(c.riskReward).toBe(2)
    expect(c.liqPrice).toBe(125) // 100 × (1 + 1/4)
    expect(c.dollarRisk).toBe(40) // 2% of 2000
  })

  test('rejects a stop on the wrong side of entry', () => {
    expect(computeTrade({ ...longPlan, stopLoss: 110 }, 1000, 1)).toMatchObject({ valid: false, error: expect.stringMatching(/below the entry/) })
  })

  test('rejects out-of-order / wrong-side take-profits', () => {
    expect(computeTrade({ ...longPlan, tp1: 90 }, 1000, 1).valid).toBe(false) // below entry
    expect(computeTrade({ ...longPlan, tp1: 120, tp2: 110 }, 1000, 1).valid).toBe(false) // tp2 < tp1
  })

  test('rejects missing / non-numeric inputs without throwing', () => {
    expect(computeTrade({ ...longPlan, entryLow: NaN, entryHigh: NaN }, 1000, 1).valid).toBe(false)
    expect(computeTrade({ ...longPlan, tp3: NaN }, 1000, 1).valid).toBe(false)
  })

  test('zero account/risk still validates the plan (sizing is just 0)', () => {
    const c = computeTrade(longPlan, 0, 1)
    expect(c.valid).toBe(true)
    expect(c.positionUsd).toBe(0)
    expect(c.riskReward).toBe(2)
  })
})

describe('seedLevels', () => {
  test('LONG defaults: entry at/below price, stop under, ordered targets, valid + >1.5 R:R', () => {
    const s = seedLevels('LONG', 100)
    expect(s.entryHigh).toBe(100)
    expect(s.entryLow).toBeLessThan(100)
    expect(s.stopLoss).toBeLessThan(s.entryLow)
    expect(s.tp1).toBeLessThan(s.tp2)
    expect(s.tp2).toBeLessThan(s.tp3)
    const c = computeTrade({ ...s, direction: 'LONG', leverage: 5 }, 1000, 1)
    expect(c.valid).toBe(true)
    expect(c.riskReward).toBeGreaterThanOrEqual(1.5)
  })

  test('SHORT defaults mirror and validate', () => {
    const s = seedLevels('SHORT', 100)
    expect(s.entryLow).toBe(100)
    expect(s.stopLoss).toBeGreaterThan(s.entryHigh)
    expect(s.tp1).toBeGreaterThan(s.tp2)
    const c = computeTrade({ ...s, direction: 'SHORT', leverage: 5 }, 1000, 1)
    expect(c.valid).toBe(true)
  })
})
