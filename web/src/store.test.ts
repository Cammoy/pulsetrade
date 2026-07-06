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

describe('signal channel WS frames', () => {
  const emptyStats = { closed: 0, wins: 0, losses: 0, winRatePct: null, avgR: null, totalR: 0, tp1HitRatePct: null, bestR: null, worstR: null, active: 0 }
  beforeEach(() =>
    useStore.setState({
      signals: { active: [], history: [{ id: 'h1' } as never], tracked: [], radar: [], stats: emptyStats, enabled: true, needsAi: false, generatedAt: null },
      toasts: [],
    }),
  )

  test('a `signals` frame replaces the whole channel slice (radar included)', () => {
    const payload = { active: [{ id: 's1' }], history: [{ id: 'h2' }], radar: [{ symbol: 'SOL', bias: 'LONG' }], stats: { ...emptyStats, closed: 1 }, enabled: true, needsAi: false, generatedAt: 123 }
    handleWsMessage(JSON.stringify({ type: 'signals', payload }))
    const sig = useStore.getState().signals
    expect(sig.active.map((s) => s.id)).toEqual(['s1'])
    expect(sig.history.map((s) => s.id)).toEqual(['h2'])
    expect(sig.radar.map((r) => r.symbol)).toEqual(['SOL'])
    expect(sig.stats.closed).toBe(1)
    expect(sig.generatedAt).toBe(123)
  })

  test('a `signals` frame missing radar defaults it to [] (no crash for consumers)', () => {
    handleWsMessage(JSON.stringify({ type: 'signals', payload: { active: [], history: [], stats: emptyStats, enabled: true, needsAi: false, generatedAt: 1 } }))
    expect(useStore.getState().signals.radar).toEqual([])
  })

  test('a snapshot merges the live slice (active + radar + stats) and PRESERVES history', () => {
    handleWsMessage(JSON.stringify({ type: 'snapshot', signals: { active: [{ id: 'a1' }], radar: [{ symbol: 'BTC', bias: 'SHORT' }], stats: { ...emptyStats, active: 1 }, enabled: true, needsAi: false, generatedAt: 9 } }))
    const sig = useStore.getState().signals
    expect(sig.active.map((s) => s.id)).toEqual(['a1'])
    expect(sig.radar.map((r) => r.symbol)).toEqual(['BTC'])
    expect(sig.history.map((s) => s.id)).toEqual(['h1']) // history untouched by the snapshot
    expect(sig.generatedAt).toBe(9)
  })

  test('a snapshot without a signals field leaves the channel untouched', () => {
    handleWsMessage(JSON.stringify({ type: 'snapshot' }))
    expect(useStore.getState().signals.history.map((s) => s.id)).toEqual(['h1'])
  })

  test('a new `signal` frame toasts the operator', () => {
    handleWsMessage(JSON.stringify({ type: 'signal', signal: { id: 'n1', asset: 'BTC/USDT', direction: 'LONG', confidence: 72, riskReward: 2.1 } }))
    expect(useStore.getState().toasts.some((t) => /New signal/.test(t.msg) && /BTC\/USDT/.test(t.msg))).toBe(true)
  })

  test('a closing `signal-update` toasts the outcome; an open update is silent', () => {
    handleWsMessage(JSON.stringify({ type: 'signal-update', signal: { id: 'u1', asset: 'ETH/USDT', direction: 'LONG', status: 'tp1' } })) // still open
    expect(useStore.getState().toasts).toHaveLength(0)
    handleWsMessage(JSON.stringify({ type: 'signal-update', signal: { id: 'u1', asset: 'ETH/USDT', direction: 'LONG', status: 'tp3', closedAt: 5, realizedR: 1.8 } }))
    expect(useStore.getState().toasts.some((t) => /ETH\/USDT/.test(t.msg) && /1\.8R/.test(t.msg))).toBe(true)
  })

  test('a `tracked` frame toasts that the trade is being tracked', () => {
    handleWsMessage(JSON.stringify({ type: 'tracked', trade: { id: 't1', asset: 'BTC/USDT', direction: 'LONG', entryMid: 100, stopLoss: 95 } }))
    expect(useStore.getState().toasts.some((t) => /Tracking/.test(t.msg) && /BTC\/USDT/.test(t.msg))).toBe(true)
  })

  test('a closing `tracked-update` toasts your trade outcome', () => {
    handleWsMessage(JSON.stringify({ type: 'tracked-update', trade: { id: 't1', asset: 'BTC/USDT', direction: 'SHORT', status: 'stopped', closedAt: 9, realizedR: -1 } }))
    expect(useStore.getState().toasts.some((t) => /Your trade/.test(t.msg) && /-1R/.test(t.msg))).toBe(true)
  })

  test('a `signals` frame missing tracked defaults it to []', () => {
    handleWsMessage(JSON.stringify({ type: 'signals', payload: { active: [], history: [], radar: [], stats: emptyStats, enabled: true, needsAi: false, generatedAt: 1 } }))
    expect(useStore.getState().signals.tracked).toEqual([])
  })
})

describe('price alert WS frames', () => {
  beforeEach(() => useStore.setState({ alerts: [], toasts: [] }))

  test('an `alerts` frame replaces the alert list', () => {
    handleWsMessage(JSON.stringify({ type: 'alerts', alerts: [{ id: 'a1', symbol: 'BTC' }, { id: 'a2', symbol: 'ETH' }] }))
    expect(useStore.getState().alerts.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  test('a snapshot carries the alert list', () => {
    handleWsMessage(JSON.stringify({ type: 'snapshot', alerts: [{ id: 'a3', symbol: 'SOL' }] }))
    expect(useStore.getState().alerts.map((a) => a.id)).toEqual(['a3'])
  })

  test('a snapshot without alerts leaves them untouched', () => {
    useStore.setState({ alerts: [{ id: 'keep' } as never] })
    handleWsMessage(JSON.stringify({ type: 'snapshot' }))
    expect(useStore.getState().alerts.map((a) => a.id)).toEqual(['keep'])
  })

  test('an `alert-trigger` frame toasts the operator', () => {
    handleWsMessage(JSON.stringify({ type: 'alert-trigger', alert: { id: 'a1', symbol: 'BTC', kind: 'above', value: 65000, triggeredPrice: 65012 } }))
    expect(useStore.getState().toasts.some((t) => /BTC/.test(t.msg) && /crossed above/.test(t.msg))).toBe(true)
  })
})

describe('perps WS frames', () => {
  const emptyStats = { open: 0, closed: 0, wins: 0, losses: 0, winRatePct: null, realizedPnlUsd: 0, openMarginUsd: 0 }
  beforeEach(() => useStore.setState({ perps: { open: [], closed: [], stats: emptyStats, maxLeverage: 50, liveEnabled: false }, toasts: [] }))

  test('a `perps` frame replaces the whole perps payload', () => {
    handleWsMessage(JSON.stringify({ type: 'perps', payload: { open: [{ id: 'p1', symbol: 'BTC' }], closed: [{ id: 'p0' }], stats: { ...emptyStats, open: 1 }, maxLeverage: 50, liveEnabled: false } }))
    const p = useStore.getState().perps
    expect(p.open.map((x) => x.id)).toEqual(['p1'])
    expect(p.closed.map((x) => x.id)).toEqual(['p0'])
    expect(p.stats.open).toBe(1)
  })

  test('a snapshot merges open + stats and PRESERVES closed history', () => {
    useStore.setState({ perps: { open: [], closed: [{ id: 'old' } as never], stats: emptyStats, maxLeverage: 50, liveEnabled: false } })
    handleWsMessage(JSON.stringify({ type: 'snapshot', perps: { open: [{ id: 'p2', symbol: 'ETH' }], stats: { ...emptyStats, open: 1 }, liveEnabled: false } }))
    const p = useStore.getState().perps
    expect(p.open.map((x) => x.id)).toEqual(['p2'])
    expect(p.closed.map((x) => x.id)).toEqual(['old']) // untouched
  })

  test('a `perp` frame toasts the opened position', () => {
    handleWsMessage(JSON.stringify({ type: 'perp', position: { id: 'p1', symbol: 'BTC', side: 'long', leverage: 10, entryPrice: 60000 } }))
    expect(useStore.getState().toasts.some((t) => /Opened BTC LONG 10×/.test(t.msg))).toBe(true)
  })

  test('a closing `perp-update` toasts the outcome (liquidation marked)', () => {
    handleWsMessage(JSON.stringify({ type: 'perp-update', position: { id: 'p1', symbol: 'BTC', side: 'long', status: 'closed', closeReason: 'liquidated', realizedPnlUsd: -100 } }))
    expect(useStore.getState().toasts.some((t) => /BTC LONG liquidated/.test(t.msg) && /-\$100/.test(t.msg))).toBe(true)
  })
})

describe('limit-order WS frames', () => {
  beforeEach(() => useStore.setState({ limitOrders: [], toasts: [] }))

  test('a `limit-orders` frame replaces the order list', () => {
    handleWsMessage(JSON.stringify({ type: 'limit-orders', orders: [{ id: 'o1', symbol: 'SOL' }, { id: 'o2', symbol: 'BTC' }] }))
    expect(useStore.getState().limitOrders.map((o) => o.id)).toEqual(['o1', 'o2'])
  })

  test('a snapshot carries the order list', () => {
    handleWsMessage(JSON.stringify({ type: 'snapshot', limitOrders: [{ id: 'o3', symbol: 'ETH' }] }))
    expect(useStore.getState().limitOrders.map((o) => o.id)).toEqual(['o3'])
  })

  test('a `limit-fill` (filled) toasts the fill; expired toasts too', () => {
    handleWsMessage(JSON.stringify({ type: 'limit-fill', order: { id: 'o1', symbol: 'SOL', side: 'buy', status: 'filled', fillPrice: 140 } }))
    expect(useStore.getState().toasts.some((t) => /Limit BUY filled/.test(t.msg) && /SOL/.test(t.msg))).toBe(true)
    handleWsMessage(JSON.stringify({ type: 'limit-fill', order: { id: 'o2', symbol: 'BTC', side: 'sell', status: 'expired' } }))
    expect(useStore.getState().toasts.some((t) => /expired/.test(t.msg))).toBe(true)
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
