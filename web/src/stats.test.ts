import { describe, test, expect } from 'vitest'
import { aggregateStats, botsForMode } from './stats'
import type { Bot } from './types'

describe('botsForMode (workspace scoping)', () => {
  const bots = [{ id: 'a', mode: 'paper' }, { id: 'b', mode: 'live' }, { id: 'c' }] as Array<{ id: string; mode?: 'paper' | 'live' }>
  test('scopes to the active workspace; a mode-less (legacy) bot counts as paper', () => {
    expect(botsForMode(bots, 'paper').map((b) => b.id)).toEqual(['a', 'c'])
    expect(botsForMode(bots, 'live').map((b) => b.id)).toEqual(['b'])
  })
})

// Minimal Bot stub — only the fields aggregateStats reads.
const bot = (o: {
  status?: Bot['status']
  risk?: Bot['risk']
  totalPnlUsd?: number
  realized?: number
  native?: number
  wins?: number
  losses?: number
}): Bot =>
  ({
    status: o.status ?? 'running',
    risk: o.risk ?? 'balanced',
    totalPnlUsd: o.totalPnlUsd ?? 0,
    stats: { realizedUsd: o.realized ?? 0, feesUsd: 0, wins: o.wins ?? 0, losses: o.losses ?? 0, nativeTakenQty: 0, nativeTakenUsd: o.native ?? 0 },
  }) as Bot

describe('aggregateStats (Overview)', () => {
  test('empty fleet → zeroed stats, null win rate, empty tiers', () => {
    const s = aggregateStats([])
    expect(s).toMatchObject({ totalPnl: 0, realized: 0, native: 0, wins: 0, losses: 0, winRate: null, activeCount: 0, total: 0 })
    expect(s.byRisk.map((x) => x.r)).toEqual(['conservative', 'balanced', 'aggressive'])
    expect(s.byRisk.every((x) => x.n === 0 && x.pnl === 0)).toBe(true)
  })

  test('sums total/realized/profit-taken, win rate, active count and per-tolerance P&L', () => {
    const bots = [
      bot({ status: 'running', risk: 'aggressive', totalPnlUsd: 10, realized: 8, native: 5, wins: 3, losses: 1 }),
      bot({ status: 'scheduled', risk: 'balanced', totalPnlUsd: -4, realized: -4, native: 0, wins: 1, losses: 3 }),
      bot({ status: 'stopped', risk: 'aggressive', totalPnlUsd: 2, realized: 2, native: 1, wins: 0, losses: 0 }),
    ]
    const s = aggregateStats(bots)
    expect(s.totalPnl).toBe(8) // 10 - 4 + 2
    expect(s.realized).toBe(6) // 8 - 4 + 2
    expect(s.native).toBe(6) // 5 + 0 + 1
    expect(s.wins).toBe(4)
    expect(s.losses).toBe(4)
    expect(s.winRate).toBe(50) // 4 / 8
    expect(s.activeCount).toBe(2) // running + scheduled; stopped excluded
    expect(s.total).toBe(3)
    const aggr = s.byRisk.find((x) => x.r === 'aggressive')!
    expect(aggr.pnl).toBe(12) // 10 + 2 — both aggressive (incl. the stopped one)
    expect(aggr.n).toBe(2)
    const bal = s.byRisk.find((x) => x.r === 'balanced')!
    expect(bal.pnl).toBe(-4)
    expect(bal.n).toBe(1)
  })

  test('win rate stays null until a trade closes (no 0/0)', () => {
    expect(aggregateStats([bot({ wins: 0, losses: 0 })]).winRate).toBeNull()
    expect(aggregateStats([bot({ wins: 0, losses: 2 })]).winRate).toBe(0)
    expect(aggregateStats([bot({ wins: 2, losses: 0 })]).winRate).toBe(100)
  })
})
