import { describe, test, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SignalChannel from './SignalChannel'
import { useStore } from '../store'
import type { RadarEntry, SignalsPayload, TradeSignal } from '../types'

const emptyStats = { closed: 0, wins: 0, losses: 0, winRatePct: null, avgR: null, totalR: 0, tp1HitRatePct: null, bestR: null, worstR: null, active: 0 }

const signal = (over: Partial<TradeSignal> = {}): TradeSignal => ({
  id: 's1', asset: 'BTC/USDT', symbol: 'BTC', cgId: 'bitcoin', direction: 'LONG',
  entryLow: 99, entryHigh: 100, entryMid: 99.5, leverageMin: 3, leverageMax: 5,
  tp1: 103, tp2: 106, tp3: 110, stopLoss: 95, confidence: 72, riskReward: 2.1,
  sentimentScore: 0.5, rationale: 'Bullish EMA cross with positive ETF inflows', refPrice: 100,
  technicals: { rsi: 55, emaFast: 100, emaSlow: 99, sma: 100, trend: 'up', change24hPct: 6, volatilityPct: 1.8 },
  status: 'active', createdAt: Date.now(), expiresAt: Date.now() + 1e9, disclaimer: 'x',
  ...over,
})

const radarEntry = (over: Partial<RadarEntry> = {}): RadarEntry => ({
  symbol: 'SOL', cgId: 'solana', name: 'Solana', bias: 'LONG', price: 150, change24hPct: 7.2, rsi: 61, triggers: ['+7.2% 24h move'], status: 'watching', reason: 'R:R 1.20 below 1.5', ...over,
})

const setSignals = (over: Partial<SignalsPayload>) =>
  useStore.setState({ signals: { active: [], history: [], tracked: [], radar: [], stats: emptyStats, enabled: true, needsAi: false, generatedAt: null, ...over } })

describe('SignalChannel', () => {
  beforeEach(() => setSignals({}))

  test('renders the hero, disclaimer and track-record bar', () => {
    render(<SignalChannel />)
    expect(screen.getByText('📡 Signal Channel')).toBeInTheDocument()
    expect(screen.getByText('Win rate')).toBeInTheDocument()
    expect(document.body).toHaveTextContent(/probabilities, not guarantees/i)
    expect(document.body).toHaveTextContent(/Position sizing/i)
  })

  test('prompts for a Gemini key when the channel needs AI', () => {
    setSignals({ needsAi: true, enabled: false })
    render(<SignalChannel />)
    expect(document.body).toHaveTextContent(/AI signals need Gemini/i)
    expect(document.body).toHaveTextContent(/GEMINI_API_KEY/)
  })

  test('when the AI provider is rate-limited it says so honestly (not a green "live")', () => {
    setSignals({ aiThrottled: true, radar: [radarEntry({ reason: 'AI paused — provider rate-limited' })] })
    render(<SignalChannel />)
    expect(screen.getByText(/AI rate-limited/)).toBeInTheDocument() // status chip, not "live"
    expect(document.body).toHaveTextContent(/AI validation is paused/i) // explanatory banner
    expect(document.body).not.toHaveTextContent(/AI signals need Gemini/i) // key IS present
    // radar + own tracked setups still work — the entry point remains
    expect(screen.getByRole('button', { name: /Set up a trade/ })).toBeInTheDocument()
  })

  test('without a Gemini key you can STILL set up & track trades (tracking needs no AI)', () => {
    setSignals({ needsAi: true, enabled: false, tracked: [signal({ id: 'tr1', source: 'user' })] })
    render(<SignalChannel />)
    // the AI gate is shown for signals…
    expect(document.body).toHaveTextContent(/AI signals need Gemini/i)
    // …but the entry point and My setups remain available
    expect(screen.getByRole('button', { name: /Set up a trade/ })).toBeInTheDocument()
    expect(screen.getByText('My setups')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Edit levels/ })).toBeInTheDocument()
  })

  test('shows the scanning empty state when enabled with no active signals', () => {
    render(<SignalChannel />)
    expect(document.body).toHaveTextContent(/Scanning the market/i)
  })

  test('renders a standardized signal card with direction, levels and rationale', () => {
    setSignals({ active: [signal()] })
    render(<SignalChannel />)
    expect(screen.getByText('BTC/USDT')).toBeInTheDocument()
    expect(screen.getAllByText('LONG').length).toBeGreaterThan(0)
    expect(document.body).toHaveTextContent(/Entry zone/)
    expect(document.body).toHaveTextContent(/Stop loss/)
    expect(document.body).toHaveTextContent(/Isolated 3–5×/)
    expect(document.body).toHaveTextContent(/Bullish EMA cross/)
    expect(screen.getByText('72%')).toBeInTheDocument() // confidence
  })

  test('renders the radar with long & short watch rows and their reasons', () => {
    setSignals({ radar: [radarEntry({ symbol: 'SOL', bias: 'LONG', reason: 'R:R 1.20 below 1.5' }), radarEntry({ symbol: 'DOGE', cgId: 'dogecoin', bias: 'SHORT', change24hPct: -8, reason: 'Market ranging, not trending' })] })
    render(<SignalChannel />)
    expect(screen.getByText('On the radar')).toBeInTheDocument()
    expect(screen.getByText('📈 Long setups')).toBeInTheDocument()
    expect(screen.getByText('📉 Short setups')).toBeInTheDocument()
    expect(screen.getByText('SOL')).toBeInTheDocument()
    expect(screen.getByText('DOGE')).toBeInTheDocument()
    expect(document.body).toHaveTextContent(/R:R 1.20 below 1.5/)
    expect(document.body).toHaveTextContent(/Market ranging/)
    expect(screen.getAllByText('Watching').length).toBeGreaterThan(0)
    // each column carries an accessible info affordance + its explanation
    expect(screen.getByRole('button', { name: /What are long setups/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /What are short setups/i })).toBeInTheDocument()
    expect(document.body).toHaveTextContent(/Potential LONG \(buy\) ideas/)
    expect(document.body).toHaveTextContent(/Potential SHORT \(sell\) ideas/)
  })

  test('a radar entry that became a signal shows the ✓ Signal chip', () => {
    setSignals({ radar: [radarEntry({ status: 'signal', reason: 'Posted — cleared all filters' })] })
    render(<SignalChannel />)
    expect(screen.getByText('✓ Signal')).toBeInTheDocument()
  })

  test('clicking "Set up & track" on a signal opens the trade ticket', () => {
    setSignals({ active: [signal()] })
    render(<SignalChannel />)
    fireEvent.click(screen.getByRole('button', { name: /Set up & track this trade/ }))
    expect(screen.getByText('Set up a trade')).toBeInTheDocument() // ticket modal header
    expect(screen.getByText('Reward:Risk')).toBeInTheDocument()
  })

  test('the always-visible "Set up a trade" button opens the ticket with a coin picker', () => {
    render(<SignalChannel />) // no active signals — entry point must still be reachable
    fireEvent.click(screen.getByRole('button', { name: /Set up a trade/ }))
    expect(screen.getByText('Set up a trade')).toBeInTheDocument() // modal header
    expect(screen.getByText('Choose a coin')).toBeInTheDocument() // coin picker shown (no coin preset)
  })

  test('clicking a radar candidate opens the ticket prefilled for that coin', () => {
    setSignals({ radar: [radarEntry({ symbol: 'SOL', cgId: 'solana', bias: 'LONG', price: 150 })] })
    render(<SignalChannel />)
    fireEvent.click(screen.getByTitle('Set up a LONG trade on SOL'))
    expect(screen.getByText('SOL/USDT')).toBeInTheDocument() // coin preset → editor (no picker)
    expect(screen.getByText('Reward:Risk')).toBeInTheDocument()
    expect(screen.queryByText('Choose a coin')).not.toBeInTheDocument()
  })

  test('renders the "My setups" section for tracked trades with edit/stop controls', () => {
    setSignals({ tracked: [signal({ id: 'tr1', source: 'user', rationale: 'Operator-configured trade' })] })
    render(<SignalChannel />)
    expect(screen.getByText('My setups')).toBeInTheDocument()
    expect(screen.getByText('yours')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Edit levels/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Stop tracking/ })).toBeInTheDocument()
  })

  test('a closed signal in history shows its realized R outcome', () => {
    setSignals({ history: [signal({ id: 'h1', status: 'tp3', closedAt: Date.now(), realizedR: 1.8 })], stats: { ...emptyStats, closed: 1, wins: 1, winRatePct: 100, avgR: 1.8, totalR: 1.8 } })
    render(<SignalChannel />)
    expect(screen.getByText('📜 Closed signals')).toBeInTheDocument()
    expect(screen.getByText('100%')).toBeInTheDocument() // win rate tile
  })
})
