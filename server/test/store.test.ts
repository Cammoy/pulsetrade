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
  // Malformed-but-parseable persistence: a good vault entry must survive while a
  // negative / non-finite one is dropped (so `available >= amount` can't NaN-compare
  // false-open), and a non-array withdrawals must collapse to [].
  vault: { 'base:native': 0.5, 'arbitrum:native': -3, 'polygon:usdt': 'NaN' },
  withdrawals: 'nope',
}
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(legacy))

const { state, save, flushNow, monthKey, setWatchlist } = await import('../src/store.js')

test('legacy state loads and the monthly ledger is rebuilt from trades', () => {
  assert.equal(state.bots.length, 1)
  assert.equal(state.bots[0].mode, 'paper', 'a pre-mode bot backfills to the paper workspace')
  assert.equal(state.trades.length, 3)
  const may = state.monthly.paper[monthKey(Date.UTC(2026, 4, 10, 12))]
  assert.ok(may, 'May ledger exists')
  assert.ok(Math.abs(may.realizedUsd - 9.79) < 1e-9, 'May realized from the sell')
  assert.ok(Math.abs(may.volumeUsd - 110) < 1e-9, 'May volume = buy + sell notionals')
  assert.ok(Math.abs(may.feesUsd - 0.21) < 1e-9)
  assert.ok(Math.abs(may.nativeTakenUsd - 9.79) < 1e-9)
  assert.equal(may.wins, 1)
  assert.ok(Math.abs((may.byRisk.aggressive ?? 0) - 9.79) < 1e-9, 'risk attribution via bot lookup')
  const jun = state.monthly.paper[monthKey(Date.UTC(2026, 5, 1, 12))]
  assert.ok(jun && Math.abs(jun.realizedUsd - -1.2) < 1e-9, 'June loss recorded')
  assert.equal(jun.losses, 1)
})

test('vault/withdrawals coerce: good entry survives, bad ones drop, non-array → []', () => {
  // Legacy 2-part keys migrate to `:paper` (all pre-split profit is paper-only).
  assert.ok(Math.abs((state.vault['base:native:paper'] ?? 0) - 0.5) < 1e-12, 'valid banked qty kept + migrated to paper')
  assert.equal(state.vault['base:native'], undefined, 'pre-migration 2-part key removed')
  assert.equal(state.vault['arbitrum:native:paper'], undefined, 'negative qty dropped')
  assert.equal(state.vault['polygon:usdt:paper'], undefined, 'non-finite qty dropped')
  assert.ok(Array.isArray(state.withdrawals) && state.withdrawals.length === 0, 'non-array withdrawals → []')
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

test('prefs.watchlist defaults to [] for a legacy state without prefs', () => {
  assert.deepEqual(state.prefs.watchlist, [], 'old state.json gets a normalized empty watchlist')
})

test('setWatchlist sanitizes, de-dupes, caps, persists, and survives reload', async () => {
  const out = setWatchlist([
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, // dupe id → dropped
    { id: 'ethereum', symbol: 'eth' }, // missing name → defaults to symbol
    { symbol: 'no-id' }, // no id → dropped
    'garbage', // not an object → dropped
  ])
  assert.deepEqual(out.map((c) => c.id), ['bitcoin', 'ethereum'], 'deduped + invalid dropped')
  assert.equal(out[1].name, 'eth', 'missing name falls back to symbol')
  flushNow()
  const fresh = await import('../src/store.js?wl=1' as string)
  assert.deepEqual(fresh.state.prefs.watchlist.map((c: any) => c.id), ['bitcoin', 'ethereum'], 'persisted across reload')
})

test('corrupt state file falls back to empty state, not a crash', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-corrupt-'))
  fs.writeFileSync(path.join(dir2, 'state.json'), '{not json')
  process.env.DATA_DIR = dir2
  const fresh = await import('../src/store.js?corrupt=1' as string)
  assert.deepEqual(fresh.state.bots, [])
  assert.deepEqual(fresh.state.monthly, { paper: {}, live: {} })
  process.env.DATA_DIR = dir
})

// ── PER-1: settings normalization fails CLOSED to paper ──────────────────────
// A malformed settings block must never leave mode undefined (every consumer
// reads settings.mode) and `settings:null` must not crash boot.
async function loadWith(settings: unknown, tag: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pulsetrade-set-${tag}-`))
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ bots: [], settings }))
  process.env.DATA_DIR = d
  const fresh = await import(`../src/store.js?set=${tag}` as string)
  process.env.DATA_DIR = dir
  return fresh.state as typeof state
}

test('PER-1: settings:null fails closed to paper without crashing boot', async () => {
  const s = await loadWith(null, 'null')
  assert.equal(s.settings.mode, 'paper')
})

test('PER-1: an empty settings object yields mode "paper", never undefined', async () => {
  const s = await loadWith({}, 'empty')
  assert.equal(s.settings.mode, 'paper')
})

test('PER-1: an unknown mode fails closed to paper', async () => {
  const s = await loadWith({ mode: 'moon' }, 'bogus')
  assert.equal(s.settings.mode, 'paper')
})

test('PER-1: a valid persisted live setting is preserved (not over-normalized)', async () => {
  const s = await loadWith({ mode: 'live' }, 'live')
  assert.equal(s.settings.mode, 'live')
})

// ── AUDIT #2/#16/#18: load() must tolerate partial/garbled money-safety state ──
async function loadRaw(raw: object, tag: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pulsetrade-aud-${tag}-`))
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(raw))
  process.env.DATA_DIR = d
  const fresh = await import(`../src/store.js?aud=${tag}` as string)
  process.env.DATA_DIR = dir
  return fresh.state as typeof state
}

test('#2 load: a partial/legacy breaker is merged with defaults — the loss & spend caps can never NaN-poison', async () => {
  const s = await loadRaw({ bots: [], breaker: { tripped: false, reason: '' } }, 'breaker')
  assert.equal(s.breaker.realizedUsd, 0, 'missing realizedUsd → 0, not undefined (→ NaN cap)')
  assert.equal(s.breaker.spentUsd, 0, 'missing spentUsd → 0, not undefined')
  // a non-numeric (NaN persists to null) value also coerces to a finite 0
  const s2 = await loadRaw({ bots: [], breaker: { tripped: false, reason: '', realizedUsd: null, spentUsd: null } }, 'breaker-null')
  assert.ok(Number.isFinite(s2.breaker.realizedUsd) && Number.isFinite(s2.breaker.spentUsd))
})

test('#16 load: a non-numeric liveSpend.usd coerces to 0 so the daily cap can never be NaN-bypassed', async () => {
  const s = await loadRaw({ bots: [], liveSpend: { day: 'x', usd: null } }, 'livespend')
  assert.equal(s.liveSpend.usd, 0)
})

test('#18 load: malformed top-level collections coerce to safe defaults (no crash on /api/state)', async () => {
  const s = await loadRaw({ bots: [], tournaments: null, follows: {}, monthly: [] }, 'collections')
  assert.ok(Array.isArray(s.tournaments) && Array.isArray(s.follows))
  assert.ok(s.monthly && !Array.isArray(s.monthly) && typeof s.monthly === 'object')
})
