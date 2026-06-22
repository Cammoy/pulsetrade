import type { MonthlyPnl } from './types'
import { RISKS, type Risk } from './stats'

// Coerce non-finite inputs to 0 so a single corrupt byRisk bucket (NaN/undefined from
// a malformed persisted/socket payload) can never poison the realized headline into
// "NaN" — matches the engine's NaN-hardening of the ledger. [defensive]
const round2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0)

export interface MonthlyRow {
  /** per-tolerance realized P&L rounded to cents (undefined when that tier had no trades) */
  cols: Record<Risk, number | undefined>
  /** realized headline = sum of the rounded buckets, so the visible columns ALWAYS add up */
  realized: number
  /** integer win %, or null when nothing has closed */
  winRate: number | null
}

/**
 * Reconcile a persisted monthly row for display. The engine accumulates realizedUsd
 * and each byRisk bucket from the SAME per-trade pnl, so `realizedUsd === Σ byRisk`
 * to full float precision — but rounding the total and each column INDEPENDENTLY to
 * cents can leave them visually 1¢ apart (e.g. -24.50 + -185.99 shown against a
 * -210.50 total). We instead round each bucket first and derive the realized headline
 * as the sum of those rounded buckets, guaranteeing the columns reconcile to the total.
 */
export function reconcileMonthly(m: MonthlyPnl): MonthlyRow {
  const cols = Object.fromEntries(RISKS.map((r) => [r, m.byRisk[r] !== undefined ? round2(m.byRisk[r]) : undefined])) as Record<Risk, number | undefined>
  // Sum EVERY bucket (not just the 3 shown) so the headline is honest even if an
  // unexpected risk key ever appears; in practice byRisk only holds the 3 tiers.
  const realized = round2(Object.values(m.byRisk).reduce((s, v) => s + round2(v), 0))
  const winRate = m.wins + m.losses > 0 ? Math.round((m.wins / (m.wins + m.losses)) * 100) : null
  return { cols, realized, winRate }
}
