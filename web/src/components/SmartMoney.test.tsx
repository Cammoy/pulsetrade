import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import SmartMoney from './SmartMoney'
import { useStore } from '../store'
import type { Meta } from '../types'

const META = {
  networks: [{ id: 'base', name: 'Base', color: '#3b82f6', native: { symbol: 'ETH' }, evm: true, tradeable: true, tokens: [{ symbol: 'cbBTC' }] }],
  strategies: [],
  risk: {},
  live: { ready: false },
} as unknown as Meta

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

// Mounts SmartMoney with a catch-all fetch so its children (SmartInsights / ConsensusHoldings)
// resolve to harmless empty states; we only assert the top-level branch behaviour.
function mountWith(feed: { events?: unknown[]; needsKey?: boolean }) {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.includes('/insights')) return json({ needsTracking: true })
    if (u.includes('/consensus-holdings')) return json({ holdings: [], totalWallets: 0 })
    if (u.includes('/api/smart-money/')) return json(feed)
    if (u.includes('/api/wallets')) return json({ wallets: [] })
    return json({})
  }) as typeof fetch
  return render(<SmartMoney />)
}

describe('SmartMoney', () => {
  beforeEach(() => useStore.setState({ meta: META, mode: 'paper', follows: [] }))
  afterEach(() => vi.restoreAllMocks())

  test('renders the whale scope and the feed empty-state once activity loads', async () => {
    mountWith({ events: [], needsKey: false })
    expect(screen.getByText('🐋 Smart Money')).toBeInTheDocument()
    await waitFor(() => expect(document.body).toHaveTextContent(/No recent activity for tracked wallets/))
  })

  test('a missing Etherscan key surfaces the setup banner', async () => {
    mountWith({ events: [], needsKey: true })
    await waitFor(() => expect(document.body).toHaveTextContent(/needs an Etherscan API key/))
  })
})
