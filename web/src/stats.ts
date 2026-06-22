import type { Bot } from './types'

export const RISKS = ['conservative', 'balanced', 'aggressive'] as const
export type Risk = (typeof RISKS)[number]

/** Bots belonging to a workspace. A mode-less (legacy) bot counts as paper so it's
 *  never dropped from the view — the single source of truth for scoping the dashboard. */
export const botsForMode = <T extends { mode?: 'paper' | 'live' }>(bots: T[], mode: 'paper' | 'live'): T[] =>
  bots.filter((b) => (b.mode ?? 'paper') === mode)

export interface AggStats {
  /** realized + unrealized across all bots */
  totalPnl: number
  /** realized P&L only */
  realized: number
  /** profit swept to native / USDT ("profit taken") */
  native: number
  wins: number
  losses: number
  /** win % over CLOSED trades, or null when nothing has closed yet */
  winRate: number | null
  activeCount: number
  total: number
  byRisk: { r: Risk; pnl: number; n: number }[]
}

/**
 * Derive the Overview stats from the live bots array. PURE so the arithmetic can be
 * unit-tested independently of React. These are the LIVE portfolio totals (current
 * bots only) — distinct from the persisted Monthly P&L ledger, which also includes
 * deleted bots. Everything here updates instantly because `bots` is refreshed on the
 * WebSocket snapshot.
 */
export function aggregateStats(bots: Bot[]): AggStats {
  const active = bots.filter((b) => b.status === 'running' || b.status === 'scheduled')
  const totalPnl = bots.reduce((s, b) => s + b.totalPnlUsd, 0)
  const realized = bots.reduce((s, b) => s + b.stats.realizedUsd, 0)
  const native = bots.reduce((s, b) => s + b.stats.nativeTakenUsd, 0)
  const wins = bots.reduce((s, b) => s + b.stats.wins, 0)
  const losses = bots.reduce((s, b) => s + b.stats.losses, 0)
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : null
  const byRisk = RISKS.map((r) => {
    const inTier = bots.filter((b) => b.risk === r)
    return { r, pnl: inTier.reduce((s, b) => s + b.totalPnlUsd, 0), n: inTier.length }
  })
  return { totalPnl, realized, native, wins, losses, winRate, activeCount: active.length, total: bots.length, byRisk }
}
