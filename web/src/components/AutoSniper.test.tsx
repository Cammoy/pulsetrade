import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AutoSniperPanel from './AutoSniper'
import { useStore } from '../store'
import type { Meta, AutoSniperState } from '../types'

// The auto-sniper exists to SNIPE — fresh launches, never months/years-old coins.
// Two client-side halves of that guarantee can only regress here (the server tests
// call startAutoSniper directly, bypassing the form): the feed must DEFAULT to the
// "new launches" feed, and every start must carry a maxAgeMinutes freshness window.
describe('AutoSniper form — snipes fresh launches by default', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    useStore.setState({
      meta: { networks: [{ id: 'base', name: 'Base', evm: true }], live: { ready: false } } as unknown as Meta,
      autoSniper: null, // null → the setup WIZARD renders (not the running panel)
      mode: 'paper',
      refresh: vi.fn(),
      confirm: vi.fn(),
      openSniper: vi.fn(),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  test('the Targets step defaults to a 3-day age window and offers NO trending feed (fresh launches only)', async () => {
    render(<AutoSniperPanel />)
    await userEvent.click(screen.getByRole('button', { name: /Next/ })) // Budget → Targets step
    expect(screen.getByDisplayValue('3 days')).toBeTruthy() // Max coin age default
    expect(screen.queryByText(/Trending/i)).not.toBeInTheDocument() // no broken trending option
  })

  test('completing the wizard sends mode:"new" + a maxAgeMinutes window, then CLOSES the modal', async () => {
    const openSniper = vi.fn()
    useStore.setState({ openSniper })
    render(<AutoSniperPanel />)
    // Budget → Targets → Strategy → Review, then launch
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    await userEvent.click(screen.getByRole('button', { name: /Launch campaign/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/auto-sniper')
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body.mode).toBe('new') // fresh-launch feed, never trending-by-default
    expect(body.maxAgeMinutes).toBe(72 * 60) // 3-day default window, in minutes
    expect(body.network).toBe('base')
    await waitFor(() => expect(openSniper).toHaveBeenCalledWith(false)) // launched → modal closes
  })

  test('the Review step shows the campaign size derived from budget ÷ per-snipe', async () => {
    render(<AutoSniperPanel />)
    await userEvent.click(screen.getByRole('button', { name: /Next/ })) // → Targets
    await userEvent.click(screen.getByRole('button', { name: /Next/ })) // → Strategy
    await userEvent.click(screen.getByRole('button', { name: /Next/ })) // → Review
    // defaults: $300 / $50 = 6 snipes
    expect(screen.getByText('Campaign summary')).toBeInTheDocument()
    expect(screen.getByText(/\$300\.00 · 6 ×/)).toBeInTheDocument()
  })
})

// The running panel must always say what the scanner is DOING — a live countdown dial,
// a scanning shimmer, and a phase-accurate headline (hunting / locked-on / blocked).
describe('AutoSniper running panel — live scanning state', () => {
  // Freeze time: the panel's 1s countdown ticker would otherwise fire outside act();
  // a fixed clock also makes the phase math (now vs lastEntryAt) deterministic.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2024-06-01T00:00:00Z')) })
  afterEach(() => vi.useRealTimers())

  function makeAuto(over: Partial<AutoSniperState> = {}): AutoSniperState {
    return {
      enabled: true, network: 'base', mode: 'new', totalBudgetUsd: 300, poolUsd: 250, perSnipeUsd: 50,
      maxConcurrent: 6, minLiquidityUsd: 10_000, startedAt: 1_700_000_000_000, entryIntervalMs: 2 * 60 * 60_000,
      lastEntryAt: 0, triedCount: 42, maxAgeMinutes: 72 * 60, targetSnipes: 6, openedCount: 1, workspace: 'paper',
      config: { takeProfitPct: 100, stopLossPct: 35, maxHoldMin: 1440, deRiskAtPct: 100, runnerTrailPct: 30 },
      stats: { active: 1, completed: 2, realizedUsd: 0, nativeTakenUsd: 0, wins: 1, losses: 1 },
      ...over,
    } as unknown as AutoSniperState
  }
  const setAuto = (a: AutoSniperState) =>
    useStore.setState({ meta: { networks: [{ id: 'base', name: 'Base', evm: true }] } as unknown as Meta, autoSniper: a, mode: 'paper', refresh: vi.fn(), confirm: vi.fn() })

  test('mid-interval shows the countdown dial, scanning shimmer and the vetted count', () => {
    setAuto(makeAuto({ lastEntryAt: Date.now() - 60_000 })) // 1 min into a 2h interval
    const { container } = render(<AutoSniperPanel />)
    expect(screen.getByText('Locked on — next snipe loading')).toBeInTheDocument()
    expect(container.querySelector('svg circle[stroke-dasharray]')).not.toBeNull() // the progress ring
    expect(container.querySelector('.scan-sweep')).not.toBeNull() // the scanning shimmer
    expect(screen.getByText('Coins vetted')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  test('before the first snipe it is actively HUNTING', () => {
    setAuto(makeAuto({ lastEntryAt: 0 }))
    render(<AutoSniperPanel />)
    expect(screen.getByText(/Hunting for the next launch/)).toBeInTheDocument()
  })

  test('all snipe slots working is surfaced honestly', () => {
    setAuto(makeAuto({ maxConcurrent: 3, stats: { active: 3, completed: 0, realizedUsd: 0, nativeTakenUsd: 0, wins: 0, losses: 0 } }))
    render(<AutoSniperPanel />)
    expect(screen.getByText('All 3 snipe slots working')).toBeInTheDocument()
  })

  test('budget-dry (cannot afford the next snipe) is surfaced honestly', () => {
    setAuto(makeAuto({ poolUsd: 10, lastEntryAt: Date.now() - 60_000 })) // < the $50 per-snipe
    render(<AutoSniperPanel />)
    expect(screen.getByText('Budget fully deployed')).toBeInTheDocument()
  })
})
