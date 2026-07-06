import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useStore } from '../store'
import type { PerpPosition } from '../types'

vi.mock('./CandleChart', () => ({ default: ({ candles }: { candles: unknown[] }) => <div data-testid="candle-chart">{candles.length} candles</div> }))

import Trade from './Trade'

const OHLC = { days: 7, candles: [{ t: 1_700_000_000_000, o: 100, h: 110, l: 95, c: 105 }, { t: 1_700_086_400_000, o: 105, h: 120, l: 104, c: 118 }] }

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/ohlc/')) return new Response(JSON.stringify(OHLC), { status: 200 })
    if (url.includes('/api/coin/')) return new Response(JSON.stringify({ priceUsd: 60000 }), { status: 200 })
    if (url.includes('/api/coins/search')) return new Response(JSON.stringify({ coins: [{ id: 'solana', symbol: 'SOL', name: 'Solana', thumb: null, rank: 5 }] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
}

const emptyPerpStats = { open: 0, closed: 0, wins: 0, losses: 0, winRatePct: null, realizedPnlUsd: 0, openMarginUsd: 0 }
const spies = () => ({
  openPerp: vi.fn().mockResolvedValue({}),
  closePerp: vi.fn().mockResolvedValue({}),
  dismissPerp: vi.fn().mockResolvedValue(undefined),
  addLimitOrder: vi.fn().mockResolvedValue({}),
  cancelLimitOrder: vi.fn().mockResolvedValue(undefined),
  addAlert: vi.fn().mockResolvedValue({}),
  deleteAlert: vi.fn().mockResolvedValue(undefined),
  toggleAlert: vi.fn().mockResolvedValue(undefined),
  rearmAlert: vi.fn().mockResolvedValue({}),
  openSwap: vi.fn(),
})
const perpPos = (over: Partial<PerpPosition>): PerpPosition => ({
  id: 'p', symbol: 'BTC', cgId: 'bitcoin', side: 'long', leverage: 10, marginUsd: 100, notionalUsd: 1000, entryPrice: 60000, sizeCoin: 0.0167, liqPrice: 54300,
  status: 'open', openedAt: Date.now(), fundingPaidUsd: 0, feesUsd: 0.5, source: 'manual', mode: 'paper', markPrice: 61000, unrealizedPnlUsd: 16, roePct: 16, ...over,
})

describe('Trade channel', () => {
  beforeEach(() => {
    localStorage.removeItem('pulsetrade.trade.coin') // default to BTC
    mockFetch()
    useStore.setState({
      perps: { open: [], closed: [], stats: emptyPerpStats, maxLeverage: 50, liveEnabled: false },
      limitOrders: [],
      alerts: [],
      ...spies(),
    })
  })

  test('defaults to BTC, charts it, and shows the ticket tabs', async () => {
    render(<Trade />)
    expect(screen.getByText('BTC/USD')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('candle-chart')).toHaveTextContent('2 candles'))
    for (const t of ['perp', 'limit', 'alert']) expect(screen.getByRole('tab', { name: new RegExp(`^${t}$`, 'i') })).toBeInTheDocument()
  })

  test('the Perp tab opens a position via the store action', async () => {
    render(<Trade />)
    await screen.findByTestId('candle-chart')
    fireEvent.click(screen.getByRole('button', { name: /Open long \(paper\)/ }))
    await waitFor(() => {
      const openPerp = useStore.getState().openPerp as ReturnType<typeof vi.fn>
      expect(openPerp).toHaveBeenCalled()
      const arg = openPerp.mock.calls[0][0]
      expect(arg).toMatchObject({ symbol: 'BTC', cgId: 'bitcoin', side: 'long', leverage: 5, marginUsd: 100 })
    })
  })

  test('the Limit tab places a buy-the-dip order', async () => {
    render(<Trade />)
    await screen.findByTestId('candle-chart')
    fireEvent.click(screen.getByRole('tab', { name: /^limit$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Place limit order/ }))
    await waitFor(() => {
      const add = useStore.getState().addLimitOrder as ReturnType<typeof vi.fn>
      expect(add).toHaveBeenCalled()
      expect(add.mock.calls[0][0]).toMatchObject({ cg: 'bitcoin', side: 'buy', amountUsd: 500 })
    })
  })

  test('the Alert tab adds a price alert', async () => {
    render(<Trade />)
    await screen.findByTestId('candle-chart')
    fireEvent.click(screen.getByRole('tab', { name: /^alert$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Add alert/ }))
    await waitFor(() => {
      const add = useStore.getState().addAlert as ReturnType<typeof vi.fn>
      expect(add).toHaveBeenCalled()
      expect(add.mock.calls[0][0]).toMatchObject({ cg: 'bitcoin', kind: 'above' })
    })
  })

  test('"your activity" shows only this coin\'s positions and closes them', async () => {
    const pos = (over: Partial<PerpPosition>): PerpPosition => ({
      id: 'p', symbol: 'BTC', cgId: 'bitcoin', side: 'long', leverage: 10, marginUsd: 100, notionalUsd: 1000, entryPrice: 60000, sizeCoin: 0.0167, liqPrice: 54300,
      status: 'open', openedAt: Date.now(), fundingPaidUsd: 0, feesUsd: 0.5, source: 'manual', mode: 'paper', markPrice: 61000, unrealizedPnlUsd: 16, roePct: 16, ...over,
    })
    useStore.setState({ perps: { open: [pos({ id: 'btc1', cgId: 'bitcoin' }), pos({ id: 'eth1', cgId: 'ethereum', symbol: 'ETH' })], closed: [], stats: emptyPerpStats, maxLeverage: 50, liveEnabled: false } })
    render(<Trade />)
    await screen.findByTestId('candle-chart')
    expect(screen.getByText(/BTC — your activity/)).toBeInTheDocument()
    // only the BTC position shows (ETH filtered out)
    const closeBtns = screen.getAllByRole('button', { name: 'Close' })
    expect(closeBtns).toHaveLength(1)
    fireEvent.click(closeBtns[0])
    expect((useStore.getState().closePerp as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('btc1')
  })

  test('the "All" scope reveals other coins\' positions (cross-coin management)', async () => {
    useStore.setState({ perps: { open: [perpPos({ id: 'btc1', cgId: 'bitcoin' }), perpPos({ id: 'eth1', cgId: 'ethereum', symbol: 'ETH' })], closed: [], stats: emptyPerpStats, maxLeverage: 50, liveEnabled: false } })
    render(<Trade />)
    await screen.findByTestId('candle-chart')
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1) // this coin only
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2) // both coins
  })

  test('a closed position can be dismissed from activity', async () => {
    useStore.setState({ perps: { open: [], closed: [perpPos({ id: 'c1', cgId: 'bitcoin', status: 'closed', closeReason: 'tp', realizedPnlUsd: 42 })], stats: emptyPerpStats, maxLeverage: 50, liveEnabled: false } })
    render(<Trade />)
    await screen.findByTestId('candle-chart')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect((useStore.getState().dismissPerp as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('c1')
  })

  test('alerts can be paused and re-armed from activity', async () => {
    const al = (over: Record<string, unknown>) => ({ id: 'a', cg: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', kind: 'above', value: 70000, armedPrice: 65000, enabled: true, status: 'armed', createdAt: Date.now(), ...over }) as never
    useStore.setState({ alerts: [al({ id: 'armed1' }), al({ id: 'trig1', status: 'triggered', triggeredPrice: 70010 })] })
    render(<Trade />)
    await screen.findByTestId('candle-chart')
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect((useStore.getState().toggleAlert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('armed1', false)
    fireEvent.click(screen.getByRole('button', { name: 'Re-arm' }))
    expect((useStore.getState().rearmAlert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('trig1')
  })

  test('adopts a tradeFocus coin handed off from another channel, then clears it', async () => {
    useStore.setState({ tradeFocus: { symbol: 'SOL', name: 'Solana', cg: 'solana' } })
    render(<Trade />)
    expect(await screen.findByText('SOL/USD')).toBeInTheDocument() // switched to the focused coin
    await waitFor(() => expect(useStore.getState().tradeFocus).toBeNull()) // one-shot focus consumed
  })

  test('the Calc tab computes USD profit correctly and labels the amount as USD', async () => {
    render(<Trade />)
    await screen.findByTestId('candle-chart')
    fireEvent.click(screen.getByRole('tab', { name: /^calc$/i }))
    // Regression: the field read "Amount in BTC" with a "$" prefix but the math treats it as USD.
    const amount = await screen.findByLabelText('Amount (USD)')
    expect(screen.queryByLabelText(/Amount in/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Entry'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Exit'), { target: { value: '150' } })
    fireEvent.change(amount, { target: { value: '1000' } })
    // $1000 at entry 100 = 10 coins; exit 150 → +$500 (+50%)
    expect(document.body).toHaveTextContent(/\+\$500/)
    expect(document.body).toHaveTextContent(/\+50\.00%/)
  })

  test('the Limit tab disables submit on non-positive input', async () => {
    render(<Trade />)
    await screen.findByTestId('candle-chart')
    fireEvent.click(screen.getByRole('tab', { name: /^limit$/i }))
    const btn = await screen.findByRole('button', { name: /Place limit order/ })
    expect(btn).toBeEnabled() // seeded amount (500) + trigger from the live price
    fireEvent.change(screen.getByLabelText(/Spend \(USD\)/), { target: { value: '0' } })
    expect(btn).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Spend \(USD\)/), { target: { value: '-5' } })
    expect(btn).toBeDisabled()
  })

  test('the perp ticket blocks a stop-loss on the wrong side before calling the store', async () => {
    render(<Trade />)
    await screen.findByTestId('candle-chart')
    // price seeds to 60000; a long with a stop ABOVE the price is invalid
    fireEvent.change(screen.getByLabelText('Stop-loss'), { target: { value: '70000' } })
    fireEvent.click(screen.getByRole('button', { name: /Open long \(paper\)/ }))
    expect(document.body).toHaveTextContent(/Stop-loss must be below the price/i)
    expect((useStore.getState().openPerp as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })
})
