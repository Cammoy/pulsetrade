import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SignalTicket, { type TicketInit } from './SignalTicket'

const init: TicketInit = {
  symbol: 'BTC', cgId: 'bitcoin', direction: 'LONG',
  entryLow: 99, entryHigh: 101, stopLoss: 95, tp1: 110, tp2: 120, tp3: 140, leverage: 5,
  refPrice: 100, confidence: 70, sentimentScore: 0.4, rationale: 'demo',
}

describe('SignalTicket', () => {
  test('renders the live summary for a valid plan', () => {
    render(<SignalTicket init={init} account={1000} riskPct={1} onClose={() => {}} />)
    expect(screen.getByText('Set up a trade')).toBeInTheDocument()
    expect(screen.getByText('Reward:Risk')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument() // R:R
    expect(document.body).toHaveTextContent(/Position/)
    // Track button enabled for a valid plan
    const track = screen.getByRole('button', { name: /^📍 Track$/ })
    expect(track).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /Open \(paper\)/ })).not.toBeDisabled()
  })

  test('an invalid stop blocks tracking and shows why', () => {
    render(<SignalTicket init={init} account={1000} riskPct={1} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Stop-loss'), { target: { value: '110' } }) // above entry for a LONG
    expect(document.body).toHaveTextContent(/Stop-loss must be below the entry/)
    expect(screen.getByRole('button', { name: /^📍 Track$/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Open \(paper\)/ })).toBeDisabled()
  })

  test('flipping to SHORT re-validates the geometry', () => {
    render(<SignalTicket init={init} account={1000} riskPct={1} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /SHORT/ }))
    // the original LONG levels (stop below, targets above) are invalid for a SHORT
    expect(document.body).toHaveTextContent(/Stop-loss must be above the entry/)
  })

  test('new mode (no coin preset) shows the coin picker, not the editor', () => {
    const blank: TicketInit = { symbol: '', cgId: '', direction: 'LONG', entryLow: 0, entryHigh: 0, stopLoss: 0, tp1: 0, tp2: 0, tp3: 0, leverage: 5 }
    render(<SignalTicket init={blank} account={1000} riskPct={1} onClose={() => {}} />)
    expect(screen.getByText('Choose a coin')).toBeInTheDocument()
    expect(screen.getByLabelText('Search coin')).toBeInTheDocument()
    expect(screen.queryByText('Reward:Risk')).not.toBeInTheDocument() // editor hidden until a coin is chosen
  })

  test('Track posts the plan to /api/signals/track and closes on success', async () => {
    const onClose = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ trade: { id: 'x' } }), { status: 200 })))
    render(<SignalTicket init={init} account={1000} riskPct={1} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /^📍 Track$/ }))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('/api/signals/track')
    expect(opts.method).toBe('POST')
  })

  test('Open (paper) posts to /api/perps with side + leverage + margin and closes', async () => {
    const onClose = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ position: { id: 'p1' } }), { status: 200 })))
    render(<SignalTicket init={init} account={1000} riskPct={1} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Open \(paper\)/ }))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const perpCall = calls.find((c) => c[0] === '/api/perps')
    expect(perpCall).toBeTruthy()
    const body = JSON.parse(perpCall![1].body)
    expect(body.side).toBe('long')
    expect(body.leverage).toBe(5)
    expect(body.marginUsd).toBeGreaterThan(0)
  })
})
