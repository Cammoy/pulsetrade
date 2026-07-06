import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import EarnSection from './EarnSection'

const PAYLOAD = {
  pools: [
    { project: 'aave-v3', chain: 'Base', symbol: 'USDC', apy: 8.2, apyBase: 6.2, apyReward: 2, tvlUsd: 120_000_000, poolId: 'pool-1' },
    { project: 'morpho', chain: 'Ethereum', symbol: 'USDT', apy: 5.5, apyBase: 5.5, apyReward: 0, tvlUsd: 60_000_000, poolId: 'pool-2' },
  ],
  at: Date.now(),
  error: null,
}

describe('EarnSection', () => {
  beforeEach(() => {
    localStorage.setItem('pulsetrade.earn.amount', '10000')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(PAYLOAD), { status: 200 })))
  })

  test('renders the top stablecoin yields with APY + a $/yr projection', async () => {
    render(<EarnSection />)
    expect(screen.getByText('🌱 Earn')).toBeInTheDocument()
    expect(await screen.findByText('USDC')).toBeInTheDocument()
    expect(screen.getByText('USDT')).toBeInTheDocument()
    expect(screen.getByText('8.2%')).toBeInTheDocument()
    // top-rate projection: $10,000 × 8.2% = $820/yr
    expect(document.body).toHaveTextContent(/\$820(\.00)?\/yr/)
  })

  test('changing the amount re-projects earnings', async () => {
    render(<EarnSection />)
    await screen.findByText('USDC')
    fireEvent.change(screen.getByLabelText('Amount to park'), { target: { value: '50000' } })
    // 50,000 × 8.2% = $4,100/yr
    await waitFor(() => expect(document.body).toHaveTextContent(/\$4,100(\.00)?\/yr/))
  })

  test('shows an error state when the feed fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ pools: [], at: null, error: 'HTTP 500' }), { status: 200 })))
    render(<EarnSection />)
    await waitFor(() => expect(document.body).toHaveTextContent(/Couldn't load yields/))
  })
})
