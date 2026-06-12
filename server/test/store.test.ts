// Persistence: atomic save/flush, reload fidelity, and the one-time monthly
// ledger rebuild for states saved before the ledger existed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-store-'))
process.env.DATA_DIR = dir

// Pre-seed a legacy state file WITHOUT a monthly ledger to exercise migration.
const legacy = {
  bots: [
    {
      id: 'b1', name: 'x', network: 'base', token: 'LINK', strategy: 'grid', risk: 'aggressive',
      budgetUsd: 100, cashUsd: 100, status: 'running',
      schedule: { enabled: false, days: [], startHour: 0, endHour: 24 },
      position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null },
      state: {}, stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 },
      equityHistory: [], log: [], createdAt: 0, lastTickAt: 0,
    },
  ],
  trades: [
    { id: 't1', botId: 'b1', ts: Date.UTC(2026, 4, 10, 12), side: 'buy', network: 'base', token: 'LINK', qty: 5, priceUsd: 10, usd: 50, feeUsd: 0.1, reason: 'x', mode: 'paper' },
    { id: 't2', botId: 'b1', ts: Date.UTC(2026, 4, 11, 12), side: 'sell', network: 'base', token: 'LINK', qty: 5, priceUsd: 12, usd: 60, feeUsd: 0.11, reason: 'x', pnlUsd: 9.79, sweptNative: { qty: 0.004, symbol: 'ETH', usd: 9.79 }, mode: 'paper' },
    { id: 't3', botId: 'b1', ts: Date.UTC(2026, 5, 1, 12), side: 'sell', network: 'base', token: 'LINK', qty: 1, priceUsd: 9, usd: 9, feeUsd: 0.05, reason: 'x', pnlUsd: -1.2, mode: 'paper' },
  ],
  settings: { mode: 'paper' },
}
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(legacy))

const { state, save, flushNow, monthKey } = await import('../src/store.js')

test('legacy state loads and the monthly ledger is rebuilt from trades', () => {
  assert.equal(state.bots.length, 1)
  assert.equal(state.trades.length, 3)
  const may = state.monthly[monthKey(Date.UTC(2026, 4, 10, 12))]
  assert.ok(may, 'May ledger exists')
  assert.ok(Math.abs(may.realizedUsd - 9.79) < 1e-9, 'May realized from the sell')
  assert.ok(Math.abs(may.volumeUsd - 110) < 1e-9, 'May volume = buy + sell notionals')
  assert.ok(Math.abs(may.feesUsd - 0.21) < 1e-9)
  assert.ok(Math.abs(may.nativeTakenUsd - 9.79) < 1e-9)
  assert.equal(may.wins, 1)
  assert.ok(Math.abs((may.byRisk.aggressive ?? 0) - 9.79) < 1e-9, 'risk attribution via bot lookup')
  const jun = state.monthly[monthKey(Date.UTC(2026, 5, 1, 12))]
  assert.ok(jun && Math.abs(jun.realizedUsd - -1.2) < 1e-9, 'June loss recorded')
  assert.equal(jun.losses, 1)
})

test('monthKey is local-time YYYY-MM', () => {
  const d = new Date(2026, 0, 15)
  assert.equal(monthKey(d.getTime()), '2026-01')
  assert.equal(monthKey(new Date(2026, 11, 31).getTime()), '2026-12')
})

test('flushNow writes atomically and a fresh module instance reloads it', async () => {
  state.settings.mode = 'paper'
  state.bots[0].cashUsd = 77.77
  save() // debounced
  flushNow() // forced
  assert.ok(!fs.existsSync(path.join(dir, 'state.json.tmp')), 'no tmp file left behind')
  // query string forces a separate module instance → exercises load()
  const fresh = await import('../src/store.js?reload=1' as string)
  assert.equal(fresh.state.bots[0].cashUsd, 77.77)
  assert.deepEqual(fresh.state.monthly, state.monthly, 'rebuilt ledger persisted')
})

test('corrupt state file falls back to empty state, not a crash', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-corrupt-'))
  fs.writeFileSync(path.join(dir2, 'state.json'), '{not json')
  process.env.DATA_DIR = dir2
  const fresh = await import('../src/store.js?corrupt=1' as string)
  assert.deepEqual(fresh.state.bots, [])
  assert.deepEqual(fresh.state.monthly, {})
  process.env.DATA_DIR = dir
})
