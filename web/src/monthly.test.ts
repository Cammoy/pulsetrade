import { describe, test, expect } from 'vitest'
import { reconcileMonthly } from './monthly'
import type { MonthlyPnl } from './types'

const m = (over: Partial<MonthlyPnl>): MonthlyPnl => ({ realizedUsd: 0, feesUsd: 0, nativeTakenUsd: 0, volumeUsd: 0, wins: 0, losses: 0, byRisk: {}, ...over })

describe('reconcileMonthly', () => {
  test('per-tolerance columns ALWAYS sum to the realized headline (no 1¢ drift)', () => {
    // Real divergence case: realizedUsd rounds to -210.50 on its own, but the columns
    // round to -24.50 and -185.99 (= -210.49). The reconciled headline must match the
    // columns the user can see and add up — NOT the independently-rounded total.
    const row = reconcileMonthly(m({ realizedUsd: -210.496, byRisk: { balanced: -24.502, aggressive: -185.994 } }))
    expect(row.cols.balanced).toBe(-24.5)
    expect(row.cols.aggressive).toBe(-185.99)
    expect(row.cols.conservative).toBeUndefined() // tier with no trades → renders as —
    expect(row.realized).toBe(-210.49) // reconciles to the visible columns, NOT -210.50
    // The columns the user sees add up to the headline they see.
    expect((row.cols.balanced ?? 0) + (row.cols.aggressive ?? 0)).toBeCloseTo(row.realized, 10)
  })

  test('win rate is an integer percent, or null when nothing has closed', () => {
    expect(reconcileMonthly(m({ wins: 6, losses: 34 })).winRate).toBe(15) // 6/40
    expect(reconcileMonthly(m({ wins: 0, losses: 0 })).winRate).toBeNull()
    expect(reconcileMonthly(m({ wins: 1, losses: 1 })).winRate).toBe(50)
  })

  test('a single-tier month reconciles exactly', () => {
    const row = reconcileMonthly(m({ realizedUsd: -5.001, byRisk: { aggressive: -5.001 } }))
    expect(row.cols.aggressive).toBe(-5)
    expect(row.realized).toBe(-5)
  })

  test('a corrupt (NaN) byRisk bucket degrades to 0 — never poisons the headline to NaN', () => {
    const row = reconcileMonthly(m({ realizedUsd: -5, byRisk: { aggressive: -5, balanced: NaN as unknown as number } }))
    expect(Number.isFinite(row.realized)).toBe(true)
    expect(row.realized).toBe(-5) // aggressive -5 + corrupt(→0)
    expect(row.cols.balanced).toBe(0) // shows $0.00, not "NaN"
    expect(row.cols.aggressive).toBe(-5)
  })
})
