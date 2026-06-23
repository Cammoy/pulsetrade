import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import CopyTrading from './CopyTrading'
import { useStore } from '../store'
import type { Meta, LeaderboardRow } from '../types'

const META = {
  networks: [{ id: 'base', name: 'Base', color: '#3b82f6', native: { symbol: 'ETH' } }],
  strategies: [],
  risk: { balanced: { stopLossPct: 5, takeProfitPct: 4.5 } },
  live: { ready: false },
  features: { ai: false, walletTracking: true },
  copyTokens: [{ network: 'base', name: 'Base', tokens: ['AERO', 'LINK'] }],
  mode: 'paper',
} as unknown as Meta

const row = (over: Partial<LeaderboardRow>): LeaderboardRow => ({
  address: '0x' + 'a'.repeat(40), label: 'GCR', score: 80, tier: 'proven', basis: 'realized-pnl', realizedFlowUsd: 5000,
  realizedPnlUsd: 4200, roundTrips: 6, recencyDays: 2, trades: 30, netFlowUsd: 1000, lastTs: 1, series: [1, 2, 3], topTokens: [], ...over,
})

const board = (rows: LeaderboardRow[], needsKey = false) => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ rows, needsKey, totalWallets: rows.length, caveat: 'flow is not verified PnL' }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
}

describe('CopyTrading', () => {
  beforeEach(() => useStore.setState({ meta: META, mode: 'paper', follows: [], bots: [] }))
  afterEach(() => vi.restoreAllMocks())

  test('ranks wallets from the leaderboard endpoint and offers a Copy action per row', async () => {
    board([row({ label: 'GCR', score: 88 }), row({ address: '0x' + 'b'.repeat(40), label: 'Tetra', score: 40, tier: 'promising' })])
    render(<CopyTrading />)
    expect(screen.getByText('🔁 Copy Trading')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('GCR')).toBeInTheDocument())
    expect(screen.getByText('Tetra')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBe(2)
    expect(document.body).toHaveTextContent(/realized P&L/i) // cost-basis basis, not net flow

  })

  test('empty workspace shows the no-active-copies state', async () => {
    board([])
    render(<CopyTrading />)
    await waitFor(() => expect(document.body).toHaveTextContent(/No active copies yet/i))
  })

  test('renders a follow card for an active auto-follow', async () => {
    board([])
    useStore.setState({
      follows: [{ id: 'f1', walletAddress: '0x' + 'c'.repeat(40), label: 'Whale', totalBudgetUsd: 300, poolUsd: 200, perTradeUsd: 100, maxConcurrent: 3, risk: 'balanced', enabled: true, startedAt: 1, stats: { active: 1, completed: 0, realizedUsd: 12, sweptUsd: 0, wins: 1, losses: 0 } }] as never,
    })
    render(<CopyTrading />)
    await waitFor(() => expect(screen.getByText('Whale')).toBeInTheDocument())
    expect(document.body).toHaveTextContent(/Auto-following/i)
  })

  test('the Copy button opens a guided setup with a live preview', async () => {
    board([row({ label: 'GCR' })])
    render(<CopyTrading />)
    await waitFor(() => screen.getByText('GCR'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0])
    await waitFor(() => expect(document.body).toHaveTextContent(/Preview/i))
    expect(document.body).toHaveTextContent(/Auto-follow all buys/i)
    // Mirror-by-default: the preview must NOT claim a take-profit the bot won't apply.
    expect(document.body).toHaveTextContent(/ride their full move/i)
  })

  test('clicking a wallet opens the analysis (WalletAccount) view', async () => {
    const profile = {
      wallet: '0x' + 'a'.repeat(40), label: 'GCR', tracking: true, events: [], holdings: [],
      stats: { trades: 0, buys: 0, sells: 0, volumeUsd: 0, netFlowUsd: 0, firstTs: null, lastTs: null, tokens: [], series: [] },
      score: { score: 0, tier: 'thin', basis: 'flow', realizedFlowUsd: 0, realizedPnlUsd: null, roundTrips: 0, recencyDays: null, caveat: '' },
    }
    globalThis.fetch = vi.fn(async (url: unknown) =>
      String(url).includes('/api/smart-money/wallet/')
        ? new Response(JSON.stringify(profile), { headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ rows: [row({ label: 'GCR' })], needsKey: false, totalWallets: 1, caveat: 'x' }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
    render(<CopyTrading />)
    await waitFor(() => screen.getByText('GCR'))
    fireEvent.click(screen.getByTitle('Analyse this wallet'))
    await waitFor(() => expect(screen.queryByText('🏆 Copy-worthiness leaderboard')).not.toBeInTheDocument())
  })

  test('a missing Etherscan key surfaces the setup banner', async () => {
    board([], true)
    render(<CopyTrading />)
    await waitFor(() => expect(document.body).toHaveTextContent(/Wallet tracking needs an Etherscan API key/i))
  })
})
