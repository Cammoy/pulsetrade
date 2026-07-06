import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useStore } from '../store'
import type { Bot, Meta } from '../types'

// lightweight-charts needs a real canvas — stub the chart so BotDetail renders in jsdom.
vi.mock('./PriceChart', () => ({ default: () => <div data-testid="price-chart" /> }))

import BotDetail from './BotDetail'

const RISK = {
  balanced: { label: 'Balanced', blurb: '', positionPct: 22, stopLossPct: 5, takeProfitPct: 4.5, gridLevels: 6, gridSpacingPct: 2.5, rsiBuy: 30, rsiSell: 70, dcaIntervalMin: 120, dcaSlices: 8, cooldownMin: 30 },
}
const META = {
  networks: [{ id: 'base', name: 'Base', color: '#3b82f6', native: { symbol: 'ETH' }, tokens: [{ symbol: 'cbBTC', cg: 'coinbase-wrapped-btc' }] }],
  strategies: [{ id: 'adaptive', name: 'All-Weather' }],
  risk: RISK,
} as unknown as Meta

const stratBot = (over: Partial<Bot> = {}): Bot =>
  ({
    id: 'b1', name: 'cbBTC All-Weather', token: 'cbBTC', network: 'base', mode: 'paper',
    strategy: 'adaptive', risk: 'balanced', status: 'running', budgetUsd: 200, cashUsd: 200,
    totalPnlUsd: 0, unrealizedUsd: 0, positionValueUsd: 0, priceUsd: 1, createdAt: 1_700_000_000_000,
    position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null },
    stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 },
    schedule: { enabled: false, days: [], startHour: 0, endHour: 0 },
    state: {}, equityHistory: [], log: [], lastTickAt: 0,
    ...over,
  }) as Bot

describe('BotDetail — StrategyEditor (per-bot TP/SL overrides)', () => {
  const editBot = vi.fn().mockResolvedValue({})
  beforeEach(() => {
    editBot.mockReset().mockResolvedValue({})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 }))) // /api/candles
    useStore.setState({ meta: META, bots: [stratBot()], trades: [], selectedBotId: 'b1', selectBot: vi.fn(), editBot, control: vi.fn() })
  })

  test('seeds TP/SL from the risk tier and only sends the CHANGED field on save', async () => {
    render(<BotDetail />)
    const tp = screen.getByLabelText(/Take-profit/) as HTMLInputElement
    expect(tp.value).toBe('4.5') // seeded from the Balanced tier
    // Save is disabled until something changes.
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeDisabled()
    fireEvent.change(tp, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(editBot).toHaveBeenCalledWith('b1', { takeProfitPct: 3 })) // ONLY the changed field
  })

  test('shows a "custom" badge once an override is set', () => {
    useStore.setState({ bots: [stratBot({ overrides: { takeProfitPct: 3 } })] })
    render(<BotDetail />)
    expect(screen.getByText(/custom/i)).toBeInTheDocument()
    expect((screen.getByLabelText(/Take-profit/) as HTMLInputElement).value).toBe('3') // override wins over tier
  })
})
