import { describe, test, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useWatchlist } from './useWatchlist'

// The watchlist reconciles a localStorage cache with the server. The critical guarantee is
// LOSSLESS: a mount union must never drop either side's saves, and toggle/remove must persist.
const coin = (id: string) => ({ id, symbol: id.toUpperCase(), name: `${id} coin` })

describe('useWatchlist', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  test('toggle adds then removes; has() + localStorage track it; server is notified', async () => {
    const puts: { watchlist: { id: string }[] }[] = []
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/prefs/watchlist')) { puts.push(JSON.parse(String(init?.body))); return new Response('{}') }
      if (u.endsWith('/api/prefs')) return new Response(JSON.stringify({ watchlist: [] }))
      return new Response('{}')
    }) as typeof fetch

    const { result } = renderHook(() => useWatchlist())
    await act(async () => { result.current.toggle(coin('btc')) })
    expect(result.current.has('btc')).toBe(true)
    expect(JSON.parse(localStorage.getItem('pulse.watchlist.v1') ?? '[]')).toHaveLength(1)
    expect(puts.at(-1)?.watchlist[0].id).toBe('btc')

    await act(async () => { result.current.toggle(coin('btc')) })
    expect(result.current.has('btc')).toBe(false)
  })

  test('on mount, local + server are UNIONED losslessly — neither side dropped', async () => {
    localStorage.setItem('pulse.watchlist.v1', JSON.stringify([coin('local-only')]))
    globalThis.fetch = vi.fn(async (url: unknown) =>
      String(url).endsWith('/api/prefs')
        ? new Response(JSON.stringify({ watchlist: [coin('server-only')] }))
        : new Response('{}')) as typeof fetch

    const { result } = renderHook(() => useWatchlist())
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    const ids = result.current.items.map((c) => c.id)
    expect(ids).toContain('local-only')
    expect(ids).toContain('server-only')
  })
})
