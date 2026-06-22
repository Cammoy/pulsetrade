import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AutoSniperStrip from './AutoSniperStrip'
import { useStore } from '../store'
import type { AutoSniperState } from '../types'

function makeAuto(over: Partial<AutoSniperState> = {}): AutoSniperState {
  return {
    enabled: true, network: 'base', mode: 'new', totalBudgetUsd: 300, poolUsd: 250, perSnipeUsd: 50,
    maxConcurrent: 6, minLiquidityUsd: 10_000, startedAt: 1_700_000_000_000, entryIntervalMs: 2 * 60 * 60_000,
    lastEntryAt: 0, targetSnipes: 6, openedCount: 1, workspace: 'paper',
    config: { takeProfitPct: 100, stopLossPct: 35, maxHoldMin: 1440, deRiskAtPct: 100, runnerTrailPct: 30 },
    stats: { active: 1, completed: 0, realizedUsd: 0, nativeTakenUsd: 0, wins: 0, losses: 0 },
    ...over,
  } as unknown as AutoSniperState
}

// The whole point: a backgrounded campaign must be VISIBLE on every screen, and one
// tap reopens it. Nothing should show when no campaign is running.
describe('AutoSniperStrip — always-visible running indicator', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2024-06-01T00:00:00Z')) })
  afterEach(() => vi.useRealTimers())

  test('renders nothing when no campaign is running', () => {
    useStore.setState({ autoSniper: null, openSniperAuto: vi.fn() })
    const { container } = render(<AutoSniperStrip />)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing when an auto-sniper exists but is stopped', () => {
    useStore.setState({ autoSniper: makeAuto({ enabled: false }), openSniperAuto: vi.fn() })
    const { container } = render(<AutoSniperStrip />)
    expect(container).toBeEmptyDOMElement()
  })

  test('shows "Auto-Sniper running" with campaign progress, and opens the Auto tab on tap', async () => {
    const openSniperAuto = vi.fn()
    useStore.setState({ autoSniper: makeAuto({ openedCount: 2, targetSnipes: 6 }), openSniperAuto })
    render(<AutoSniperStrip />)
    expect(screen.getByText('🤖 Auto-Sniper running')).toBeInTheDocument()
    expect(screen.getByText(/snipe 2 of 6/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))
    expect(openSniperAuto).toHaveBeenCalledOnce()
  })
})
