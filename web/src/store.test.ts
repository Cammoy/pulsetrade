import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useStore, normalizeState, handleWsMessage } from './store'
import type { Bot } from './types'

describe('normalizeState defaults a partial payload', () => {
  test('an empty payload yields fully-defaulted, non-null collections', () => {
    const s = normalizeState({})
    expect(s).toEqual({ bots: [], trades: [], monthly: { paper: {}, live: {} }, autoSniper: null, tournaments: [], follows: [], swaps: [], mode: 'paper' })
  })
  test('provided values are preserved', () => {
    const s = normalizeState({ mode: 'live', bots: [{ id: 'b1' } as Bot] })
    expect(s.mode).toBe('live')
    expect(s.bots).toHaveLength(1)
  })
  test('backfills bot.mode to paper for an older payload, preserving explicit modes', () => {
    const s = normalizeState({ bots: [{ id: 'b1' } as Bot, { id: 'b2', mode: 'live' } as Bot] })
    expect(s.bots[0].mode).toBe('paper') // legacy bot → paper workspace
    expect(s.bots[1].mode).toBe('live') // explicit mode preserved
  })
})

describe('handleWsMessage', () => {
  beforeEach(() => useStore.setState({ bots: [], trades: [], prices: {}, tournaments: [], lastTradeId: null, monthly: { paper: {}, live: {} } }))

  test('a partial snapshot defaults missing collections (no crash on bots.length)', () => {
    handleWsMessage(JSON.stringify({ type: 'snapshot' })) // no bots/prices/tournaments/...
    const s = useStore.getState()
    expect(s.bots).toEqual([])
    expect(s.prices).toEqual({})
    expect(s.tournaments).toEqual([])
  })

  test('a snapshot syncs the active workspace mode from the server (no boot-cache desync)', () => {
    useStore.setState({ mode: 'live' })
    handleWsMessage(JSON.stringify({ type: 'snapshot', mode: 'paper' }))
    expect(useStore.getState().mode).toBe('paper')
  })

  test('a snapshot WITHOUT a mode field leaves the current mode untouched (older server)', () => {
    useStore.setState({ mode: 'live' })
    handleWsMessage(JSON.stringify({ type: 'snapshot' }))
    expect(useStore.getState().mode).toBe('live')
  })

  test('a snapshot carries the live breaker state (HALTED badge stays in sync, no reload)', () => {
    handleWsMessage(JSON.stringify({ type: 'snapshot', breaker: { tripped: true, reason: 'loss cap', trippedAt: 1, realizedUsd: -5, spentUsd: 0 } }))
    expect(useStore.getState().breaker?.tripped).toBe(true)
    handleWsMessage(JSON.stringify({ type: 'snapshot', breaker: { tripped: false, reason: '', trippedAt: null, realizedUsd: 0, spentUsd: 0 } }))
    expect(useStore.getState().breaker?.tripped).toBe(false) // re-arm reflected instantly
  })

  test('a trade is prepended and updates lastTradeId', () => {
    handleWsMessage(JSON.stringify({ type: 'trade', trade: { id: 't1' } }))
    expect(useStore.getState().trades.map((t) => t.id)).toEqual(['t1'])
    expect(useStore.getState().lastTradeId).toBe('t1')
  })

  test('a duplicate trade id is dropped (idempotent under StrictMode / reconnect)', () => {
    handleWsMessage(JSON.stringify({ type: 'trade', trade: { id: 't1' } }))
    handleWsMessage(JSON.stringify({ type: 'trade', trade: { id: 't1' } }))
    expect(useStore.getState().trades).toHaveLength(1)
  })

  test('the trade buffer is capped at 500, newest first', () => {
    useStore.setState({ trades: Array.from({ length: 500 }, (_, i) => ({ id: `old${i}` }) as never) })
    handleWsMessage(JSON.stringify({ type: 'trade', trade: { id: 'newest' } }))
    const t = useStore.getState().trades
    expect(t).toHaveLength(500)
    expect(t[0].id).toBe('newest')
  })

  test('a malformed frame is ignored — no throw, state untouched', () => {
    useStore.setState({ trades: [{ id: 'keep' } as never] })
    expect(() => handleWsMessage('{ not json')).not.toThrow()
    expect(useStore.getState().trades).toHaveLength(1)
  })

  test('a trade frame carries the per-mode monthly ledger and applies it INSTANTLY (no 20s wait)', () => {
    handleWsMessage(JSON.stringify({ type: 'trade', trade: { id: 't9' }, monthly: { paper: { '2026-06': { realizedUsd: -5 } }, live: {} } }))
    expect(useStore.getState().monthly.paper['2026-06'].realizedUsd).toBe(-5)
    expect(useStore.getState().lastTradeId).toBe('t9')
  })

  test('a DUPLICATE trade still lands a fresher monthly ledger (reconnect/replay)', () => {
    useStore.setState({ trades: [{ id: 't1' } as never] })
    handleWsMessage(JSON.stringify({ type: 'trade', trade: { id: 't1' }, monthly: { paper: { '2026-06': { realizedUsd: 7 } }, live: {} } }))
    expect(useStore.getState().trades).toHaveLength(1) // not double-added
    expect(useStore.getState().monthly.paper['2026-06'].realizedUsd).toBe(7) // but the ledger updated
  })
})

describe('navigation actions — Portfolio sub-tab selection', () => {
  test('setPortfolioTab switches the active Portfolio tab directly', () => {
    useStore.setState({ portfolioTab: 'holdings' })
    useStore.getState().setPortfolioTab('staking')
    expect(useStore.getState().portfolioTab).toBe('staking')
    useStore.getState().setPortfolioTab('withdraw')
    expect(useStore.getState().portfolioTab).toBe('withdraw')
  })
})

describe('live breaker TRIP operator alert', () => {
  const errToasts = () => useStore.getState().toasts.filter((t) => t.type === 'error')
  const snap = (breaker: unknown) => JSON.stringify({ type: 'snapshot', breaker })
  const tripped = (reason = 'loss cap') => ({ tripped: true, reason, trippedAt: 1, realizedUsd: -5, spentUsd: 0 })
  const armed = { tripped: false, reason: '', trippedAt: null, realizedUsd: 0, spentUsd: 0 }

  beforeEach(() => useStore.setState({ breaker: null, toasts: [] }))

  test('first snapshot already-tripped does NOT toast (no spam on reload)', () => {
    handleWsMessage(snap(tripped())) // prevBreaker is null on the boot frame
    expect(useStore.getState().breaker?.tripped).toBe(true)
    expect(errToasts()).toHaveLength(0)
  })

  test('the false→true edge fires exactly one operator alert', () => {
    handleWsMessage(snap(armed)) // establish a non-null, armed baseline
    handleWsMessage(snap(tripped())) // …now it trips
    expect(errToasts()).toHaveLength(1)
    expect(errToasts()[0].msg).toContain('Live trading halted')
  })

  test('staying tripped across later snapshots does not re-toast', () => {
    handleWsMessage(snap(armed))
    handleWsMessage(snap(tripped()))
    handleWsMessage(snap(tripped('loss cap'))) // still tripped → no new edge
    expect(errToasts()).toHaveLength(1)
  })
})

describe('mutations degrade safely (never crash the app on a bad engine response)', () => {
  beforeEach(() => useStore.setState({ mode: 'paper', bots: [], trades: [], selectedBotId: null }))

  test('setMode returns {error} on a network failure and leaves mode unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const out = await useStore.getState().setMode('live')
    expect(out.error).toBeTruthy()
    expect(useStore.getState().mode).toBe('paper')
  })

  test('setMode degrades a non-JSON HTTP error to {error}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>500</html>', { status: 500 })))
    const out = await useStore.getState().setMode('live')
    expect(out.error).toBeTruthy()
    expect(useStore.getState().mode).toBe('paper')
  })

  test('setMode commits the mode on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ mode: 'live' }), { status: 200 })))
    const out = await useStore.getState().setMode('live')
    expect(out.error).toBeUndefined()
    expect(useStore.getState().mode).toBe('live')
  })

  test('remove() optimistically drops the bot then ROLLS BACK on a failed delete', async () => {
    useStore.setState({ bots: [{ id: 'b1' } as Bot], trades: [] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await useStore.getState().remove('b1')
    expect(useStore.getState().bots.map((b) => b.id)).toContain('b1') // restored after the failure
  })

  test('editBot PATCHes the bot and patches the updated params in on success', async () => {
    useStore.setState({ bots: [{ id: 'b1', sniper: { takeProfitPct: 50 } } as unknown as Bot] })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'b1', sniper: { takeProfitPct: 20 } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const out = await useStore.getState().editBot('b1', { takeProfitPct: 20 })
    expect(out.error).toBeUndefined()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/bots/b1')
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH') // not POST
  })

  test('editBot returns {error} (and does not throw) when the engine rejects the edit', async () => {
    useStore.setState({ bots: [{ id: 'b1' } as Bot] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'budget must be at least $10' }), { status: 400 })))
    const out = await useStore.getState().editBot('b1', { budgetUsd: 5 })
    expect(out.error).toBeTruthy()
  })
})
