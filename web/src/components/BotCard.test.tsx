import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BotCard from './BotCard'
import { useStore } from '../store'
import type { Bot, Meta } from '../types'

const META = {
  networks: [{ id: 'base', name: 'Base', color: '#3b82f6', native: { symbol: 'ETH' } }],
  strategies: [{ id: 'adaptive', name: 'All-Weather' }],
  risk: {},
} as unknown as Meta

function makeBot(over: Partial<Bot> = {}): Bot {
  return {
    id: 'b1', name: 'cbBTC All-Weather', token: 'cbBTC', network: 'base', mode: 'paper',
    strategy: 'adaptive', risk: 'balanced', status: 'running', budgetUsd: 200, cashUsd: 200,
    totalPnlUsd: 0, unrealizedUsd: 0, positionValueUsd: 0, priceUsd: 1, createdAt: 1_700_000_000_000,
    position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null },
    stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 },
    schedule: { enabled: false, days: [], startHour: 0, endHour: 0 },
    state: {}, equityHistory: [], log: [], lastTickAt: 0,
    ...over,
  } as Bot
}

// Three lifecycle UX guarantees: (1) a paused bot is impossible to miss, (2) a
// stop-&-sweep shows it's working, (3) the bot's controls are blocked until it lands.
describe('BotCard — paused is obvious + stop blocks the UI', () => {
  const selectBot = vi.fn()
  beforeEach(() => {
    selectBot.mockReset()
    useStore.setState({ meta: META, control: vi.fn(), archive: vi.fn(), remove: vi.fn(), confirm: vi.fn(), selectBot, pendingByBot: {} })
  })

  test('a paused bot is unmistakable — "Paused" status + a Resume affordance, no stop overlay', () => {
    render(<BotCard bot={makeBot({ status: 'paused' })} />)
    expect(screen.getByText('Paused')).toBeInTheDocument()
    expect(screen.getByLabelText('Resume')).toBeInTheDocument()
    expect(screen.queryByText(/Stopping & sweeping/)).not.toBeInTheDocument()
  })

  test('a running bot has no paused ring and navigates on click', async () => {
    const { container } = render(<BotCard bot={makeBot()} />)
    expect(container.querySelector('.ring-amber-400\\/40')).toBeNull()
    await userEvent.click(container.firstElementChild as Element)
    expect(selectBot).toHaveBeenCalledWith('b1')
  })

  test('a stop in flight shows a blocking overlay and the card no longer opens', async () => {
    useStore.setState({ pendingByBot: { b1: 'stop' } })
    const { container } = render(<BotCard bot={makeBot()} />)
    expect(screen.getByText(/Stopping & sweeping/)).toBeInTheDocument()
    await userEvent.click(container.firstElementChild as Element)
    expect(selectBot).not.toHaveBeenCalled() // UI blocked until the sweep lands
  })

  test('a pause in flight disables the bot control (no double-click)', () => {
    useStore.setState({ pendingByBot: { b1: 'pause' } })
    render(<BotCard bot={makeBot()} />)
    expect(screen.getByLabelText('Pause')).toBeDisabled()
  })

  test('renders an equity sparkline only when there are ≥2 history points', () => {
    // Baseline (no history) → some SVGs (chevron, play/pause icon) but no sparkline.
    const { container: empty } = render(<BotCard bot={makeBot({ equityHistory: [] })} />)
    const emptyCount = empty.querySelectorAll('svg').length
    // ≥2 points → exactly one extra SVG (the Sparkline).
    const { container: filled } = render(<BotCard bot={makeBot({ equityHistory: [{ t: 1, v: 100 }, { t: 2, v: 110 }, { t: 3, v: 130 }] })} />)
    expect(filled.querySelectorAll('svg').length).toBe(emptyCount + 1)
  })

  test('the card is keyboard-operable — focusable and opens on Enter', async () => {
    render(<BotCard bot={makeBot()} />)
    const card = screen.getByRole('button', { name: /Open cbBTC details/ })
    expect(card).toHaveAttribute('tabindex', '0')
    card.focus()
    await userEvent.keyboard('{Enter}')
    expect(selectBot).toHaveBeenCalledWith('b1')
  })
})
