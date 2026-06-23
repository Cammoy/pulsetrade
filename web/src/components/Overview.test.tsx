import { describe, test, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import Overview from './Overview'
import { useStore } from '../store'
import type { Bot, Meta } from '../types'

const META = {
  networks: [{ id: 'base', name: 'Base', color: '#3b82f6', native: { symbol: 'ETH' } }],
  strategies: [],
  risk: {},
  live: { ready: false, botWallet: null, maxUsdPerDay: 50, spentTodayUsd: 10 },
} as unknown as Meta

function makeBot(over: Partial<Bot> = {}): Bot {
  return {
    id: 'b1', name: 'cbBTC bot', token: 'cbBTC', network: 'base', mode: 'paper',
    strategy: 'adaptive', risk: 'balanced', status: 'running', budgetUsd: 200, cashUsd: 100,
    totalPnlUsd: 12.5, unrealizedUsd: 1.2, positionValueUsd: 100, priceUsd: 1, createdAt: 1,
    position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null },
    stats: { realizedUsd: 11.3, feesUsd: 0, wins: 3, losses: 1, nativeTakenQty: 0, nativeTakenUsd: 50 },
    schedule: { enabled: false, days: [], startHour: 0, endHour: 0 },
    state: {}, equityHistory: [{ t: 1, v: 100 }, { t: 2, v: 112 }], log: [], lastTickAt: 0,
    ...over,
  } as Bot
}

describe('Overview dashboard', () => {
  beforeEach(() => {
    useStore.setState({ meta: META, mode: 'paper', breaker: null, autoSniper: null, tournaments: [], follows: [], wsOk: true, bots: [] })
  })

  test('renders the core dashboard cards scoped to the active workspace', () => {
    useStore.setState({ bots: [makeBot(), makeBot({ id: 'b2', name: 'JUP bot', token: 'JUP', totalPnlUsd: -3, positionValueUsd: 40, cashUsd: 60 })] })
    render(<Overview />)
    for (const title of ['Portfolio equity', 'Status', 'Automation', 'Capital allocation', 'Performers'])
      expect(screen.getByText(title)).toBeInTheDocument()
    expect(screen.getByText('PAPER')).toBeInTheDocument()
    expect(document.body).toHaveTextContent(/Engine live/)
    expect(screen.getByText('Idle cash')).toBeInTheDocument() // allocation donut legend
    // both bots are listed as performers (best-first)
    expect(screen.getByText('cbBTC bot')).toBeInTheDocument()
    expect(screen.getByText('JUP bot')).toBeInTheDocument()
  })

  test('shows the HALTED banner when the circuit breaker is tripped', () => {
    useStore.setState({
      bots: [makeBot()],
      breaker: { tripped: true, reason: 'cumulative loss limit', trippedAt: 1, realizedUsd: -50, spentUsd: 100 },
    })
    render(<Overview />)
    expect(document.body).toHaveTextContent(/HALTED/)
    expect(document.body).toHaveTextContent(/cumulative loss limit/)
  })

  test('live mode shows the daily-spend cap bar', () => {
    useStore.setState({ bots: [makeBot({ mode: 'live' })], mode: 'live' })
    render(<Overview />)
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('Daily live spend')).toBeInTheDocument()
  })

  test('empty workspace renders without crashing (no positions / no automation)', () => {
    render(<Overview />)
    expect(screen.getByText('Capital allocation')).toBeInTheDocument()
    expect(document.body).toHaveTextContent(/Nothing automated yet/)
  })
})
