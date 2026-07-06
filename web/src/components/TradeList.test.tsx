import { describe, test, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import TradeList from './TradeList'
import { useStore } from '../store'
import type { Trade } from '../types'

const trade = (over: Partial<Trade> = {}): Trade => ({
  id: 't1', botId: 'b1', ts: Date.now(), side: 'buy', network: 'base', token: 'ETH',
  qty: 0.5, priceUsd: 2000, usd: 1000, feeUsd: 1.5, reason: 'entry', mode: 'paper', ...over,
})

describe('TradeList CSV export', () => {
  beforeEach(() => useStore.setState({ trades: [], bots: [], mode: 'paper', showTrades: true, lastTradeId: null }))

  test('offers a CSV download scoped to the active workspace when there are trades', () => {
    useStore.setState({ trades: [trade({ id: 't1', mode: 'paper' })], mode: 'paper' })
    render(<TradeList />)
    const link = screen.getByRole('link', { name: /CSV/ })
    expect(link).toHaveAttribute('href', '/api/export/trades.csv?mode=paper')
    expect(link).toHaveAttribute('download')
  })

  test('the link follows the active workspace (live)', () => {
    useStore.setState({ trades: [trade({ id: 'l1', mode: 'live' })], mode: 'live' })
    render(<TradeList />)
    expect(screen.getByRole('link', { name: /CSV/ })).toHaveAttribute('href', '/api/export/trades.csv?mode=live')
  })

  test('no export link when the active workspace has no trades', () => {
    useStore.setState({ trades: [trade({ mode: 'live' })], mode: 'paper' }) // a live trade, but viewing paper
    render(<TradeList />)
    expect(screen.queryByRole('link', { name: /CSV/ })).not.toBeInTheDocument()
  })
})
