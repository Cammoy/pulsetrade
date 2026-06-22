// SQLite trade ledger: append-only history + analytics. node:sqlite is built
// into Node ≥22.5; on older Node the ledger is disabled and these tests skip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-db-'))
const { initTradeDb, recordTrade, queryTrades, tradeStats, tradeDbReady, backfillTrades } = await import('../src/db.js')

const mk = (o: { id: string; ts: number; side: 'buy' | 'sell'; token?: string; usd?: number; pnlUsd?: number }) =>
  ({ id: o.id, botId: 'b1', ts: o.ts, side: o.side, network: 'base', token: o.token ?? 'cbBTC', qty: 1, priceUsd: 100, usd: o.usd ?? 100, feeUsd: 0.1, reason: 'x', pnlUsd: o.pnlUsd, mode: 'paper' as const })

test('initTradeDb opens the ledger when node:sqlite is available', () => {
  const ok = initTradeDb(dir)
  assert.equal(ok, tradeDbReady(), 'init result matches ready state')
})

test('recordTrade + queryTrades: append-only (id idempotent), newest-first, filterable', () => {
  if (!tradeDbReady()) return // Node <22.5 — ledger disabled, skip
  recordTrade(mk({ id: 'a', ts: 100, side: 'buy', token: 'cbBTC' }) as never)
  recordTrade(mk({ id: 'b', ts: 200, side: 'sell', token: 'cbBTC', pnlUsd: 5 }) as never)
  recordTrade(mk({ id: 'c', ts: 300, side: 'buy', token: 'AERO' }) as never)
  recordTrade(mk({ id: 'a', ts: 100, side: 'buy', token: 'cbBTC' }) as never) // duplicate id → ignored

  const all = queryTrades()
  assert.equal(all.length, 3, 'duplicate id not re-inserted')
  assert.equal(all[0].id, 'c', 'newest first (ts desc)')
  assert.equal(queryTrades({ token: 'cbBTC' }).length, 2, 'filter by token')
  assert.equal(queryTrades({ side: 'sell' }).length, 1, 'filter by side')
  assert.equal(queryTrades({ since: 250 }).length, 1, 'filter by since')
  assert.equal(queryTrades({ limit: 1 }).length, 1, 'paging limit')
})

test('tradeStats: aggregates realized P&L / wins / volume over the full ledger', () => {
  if (!tradeDbReady()) return
  const s = tradeStats()
  assert.equal(s.enabled, true)
  assert.equal(s.count, 3)
  assert.equal(s.wins, 1, 'one profitable sell')
  assert.equal(s.losses, 0)
  assert.ok(Math.abs(s.realizedUsd - 5) < 1e-9, 'summed pnl')
  assert.ok(s.volumeUsd > 0)
  assert.ok(s.byToken.some((t) => t.token === 'cbBTC'), 'per-token breakdown')
  // token filter scopes the stats
  assert.equal(tradeStats({ token: 'AERO' }).count, 1)
})

test('backfillTrades seeds the ledger idempotently', () => {
  if (!tradeDbReady()) return
  const before = tradeStats().count
  const n = backfillTrades([mk({ id: 'a', ts: 100, side: 'buy' }), mk({ id: 'z', ts: 400, side: 'buy' })] as never)
  assert.equal(n, 2, 'returns the number processed')
  assert.equal(tradeStats().count, before + 1, 'only the new id (z) was added; a was already present')
})
