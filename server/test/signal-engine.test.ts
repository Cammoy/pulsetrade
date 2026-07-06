// Signal-engine pipeline, end to end with every network dependency mocked: scanner →
// Gemini validation → risk gate → publish, plus the tick-by-tick outcome tracker.
// Thresholds are relaxed via env so this exercises the WIRING (signals.test.ts pins the
// exact gate math). Routes each mocked Gemini call by its request body.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-sigeng-'))
process.env.GEMINI_API_KEY = 'test-key'
process.env.SIGNALS_MIN_RR = '1'
process.env.SIGNALS_MIN_CONFIDENCE = '0'

const { runSignalScan, trackSignalOutcomes, getSignalsPayload, createTracked, updateTracked, closeTracked, __resetScanClock } = await import('../src/signal-engine.js')
const { state } = await import('../src/store.js')
const { setBroadcast } = await import('../src/broadcast.js')
const { DISCLAIMER } = await import('../src/signals.js')
type TradeSignal = import('../src/signals.js').TradeSignal

const R = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status })
const geminiText = (obj: unknown) => R({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] })

// A "gentle" uptrend (rising but not blown-off → RSI not overbought) so technicalSignal
// reads BUY with a directional score — the same shape market.test proves scores a buy.
const sparkline = Array.from({ length: 60 }, (_, i) => 100 + i * 0.6 + Math.sin(i / 2) * 4)
// A volatile series near a swing low → clean LONG geometry for the risk math.
const candles = Array.from({ length: 200 }, (_, i) => 100 + 3 * Math.sin(i / 3))

const frames: any[] = []
setBroadcast((m) => frames.push(m))

function wireFetch(over: { validation?: object; price?: number } = {}) {
  const validation = over.validation ?? { proceed: true, direction: 'LONG', marketState: 'trending', binaryEventRisk: false, confidence: 0.85, rationale: 'Bullish 1h structure with positive ETF flows' }
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    const body = String(init?.body ?? '')
    if (u.includes('/global')) return R({ data: { total_market_cap: { usd: 3e12 }, market_cap_change_percentage_24h_usd: 1, total_volume: { usd: 9e10 }, market_cap_percentage: { btc: 50 } } })
    if (u.includes('alternative.me')) return R({ data: [{ value: '60', value_classification: 'Greed' }] })
    if (u.includes('search/trending')) return R({ coins: [] })
    if (u.includes('coins/markets')) return R([{ id: 'testcoin', symbol: 'test', name: 'Test Coin', image: 't.png', market_cap_rank: 20, current_price: 100, price_change_percentage_1h_in_currency: 1.5, price_change_percentage_24h_in_currency: 8, price_change_percentage_7d_in_currency: 12, market_cap: 5e10, total_volume: 3e9, ath_change_percentage: -20, sparkline_in_7d: { price: sparkline } }])
    if (u.includes('/market_chart')) return R({ prices: candles.map((c, i) => [i * 3_600_000, c]) })
    if (u.includes('simple/price')) return R({ testcoin: { usd: over.price ?? 100 }, seedcoin: { usd: over.price ?? 100 } })
    if (u.includes('generativelanguage')) {
      if (body.includes('google_search')) return R({ candidates: [{ content: { parts: [{ text: '• Positive ETF inflows' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://n/1', title: 'ETF inflows' } }] } }] })
      if (body.includes('"proceed"')) return geminiText(validation)
      return geminiText({ score: 0.6, label: 'bullish', summary: 'Constructive news.' })
    }
    return R({})
  }) as typeof fetch
}

test('runSignalScan: a validated candidate is published to the channel + broadcast', async () => {
  state.signals = { active: [], history: [] }
  frames.length = 0
  __resetScanClock()
  wireFetch()

  await runSignalScan(Date.now())

  assert.equal(state.signals.active.length, 1, 'one signal published')
  const s = state.signals.active[0]
  assert.equal(s.symbol, 'TEST')
  assert.equal(s.direction, 'LONG')
  assert.equal(s.asset, 'TEST/USDT')
  assert.equal(s.disclaimer, DISCLAIMER)
  assert.ok(s.rationale.length > 0, 'carries the AI rationale')
  assert.ok(s.tp1 < s.tp2 && s.tp2 < s.tp3)
  assert.ok(frames.some((f) => f.type === 'signal' && f.signal?.id === s.id), 'broadcast a per-signal frame')
  assert.ok(frames.some((f) => f.type === 'signals' && f.payload), 'broadcast the channel payload')

  const payload = getSignalsPayload()
  assert.equal(payload.enabled, true)
  assert.equal(payload.needsAi, false)
  assert.equal(payload.active.length, 1)
  // The radar carries the scanned candidate, tagged as a posted signal.
  assert.ok(payload.radar.length >= 1, 'radar is populated after a scan')
  assert.ok(payload.radar.some((r) => r.symbol === 'TEST' && r.status === 'signal'), 'the published coin shows on the radar as a signal')
})

test('runSignalScan: a rejected candidate still appears on the radar as "watching" with a reason', async () => {
  state.signals = { active: [], history: [] }
  __resetScanClock()
  wireFetch({ validation: { proceed: false, direction: 'NONE', marketState: 'ranging', binaryEventRisk: false, confidence: 0.2, rationale: 'choppy' } })

  await runSignalScan(Date.now())
  const payload = getSignalsPayload()
  assert.equal(payload.active.length, 0)
  const row = payload.radar.find((r) => r.symbol === 'TEST')
  assert.ok(row, 'rejected candidate is still on the radar')
  assert.equal(row!.status, 'watching')
  assert.match(row!.reason, /ranging|not trending/i)
})

test('runSignalScan: AI rejection (not trending) publishes nothing', async () => {
  state.signals = { active: [], history: [] }
  __resetScanClock()
  wireFetch({ validation: { proceed: false, direction: 'NONE', marketState: 'ranging', binaryEventRisk: false, confidence: 0.2, rationale: 'choppy' } })

  await runSignalScan(Date.now())
  assert.equal(state.signals.active.length, 0, 'ranging market → no signal')
})

test('trackSignalOutcomes: a runner that prints TP3 is closed to history with positive R', async () => {
  const seed: TradeSignal = {
    id: 'seed', asset: 'SEED/USDT', symbol: 'SEED', cgId: 'seedcoin', direction: 'LONG',
    entryLow: 99, entryHigh: 100, entryMid: 100, leverageMin: 3, leverageMax: 5,
    tp1: 103, tp2: 106, tp3: 110, stopLoss: 95, confidence: 70, riskReward: 2,
    sentimentScore: 0.3, rationale: 'x', refPrice: 100,
    technicals: { rsi: 55, emaFast: 100, emaSlow: 99, sma: 100, trend: 'up', change24hPct: 5, volatilityPct: 1.5 },
    status: 'active', createdAt: 0, expiresAt: Date.now() + 1e9, disclaimer: DISCLAIMER,
  }
  state.signals = { active: [seed], history: [] }
  frames.length = 0
  wireFetch({ price: 120 }) // above TP3

  const changed = await trackSignalOutcomes(Date.now())
  assert.equal(changed, true)
  assert.equal(state.signals.active.length, 0, 'closed signal leaves the active list')
  assert.equal(state.signals.history.length, 1)
  const done = state.signals.history[0]
  assert.equal(done.status, 'tp3')
  assert.ok((done.realizedR ?? 0) > 0)
  assert.ok(frames.some((f) => f.type === 'signal-update' && f.signal?.id === 'seed'), 'broadcast the close')
})

test('createTracked: a valid operator plan is stored, broadcast, and validated', () => {
  state.signals = { active: [], history: [], tracked: [] }
  frames.length = 0
  const out = createTracked({ symbol: 'eth', cgId: 'ethereum', direction: 'LONG', entryLow: 1990, entryHigh: 2000, stopLoss: 1900, tp1: 2100, tp2: 2200, tp3: 2400, leverageMin: 2, leverageMax: 5 })
  assert.ok('trade' in out, JSON.stringify(out))
  assert.equal(state.signals.tracked.length, 1)
  assert.equal(state.signals.tracked[0].source, 'user')
  assert.ok(frames.some((f) => f.type === 'tracked' && f.trade?.id), 'broadcast a tracked frame')

  // a bad plan is rejected, nothing stored
  const bad = createTracked({ symbol: 'eth', cgId: 'ethereum', direction: 'LONG', entryLow: 2000, entryHigh: 2000, stopLoss: 2100, tp1: 2200 })
  assert.ok('error' in bad)
  assert.equal(state.signals.tracked.length, 1)
})

test('tracked trades are advanced (and notified) by trackSignalOutcomes; close removes them', async () => {
  state.signals = { active: [], history: [], tracked: [] }
  const created = createTracked({ symbol: 'sol', cgId: 'seedcoin', direction: 'LONG', entryLow: 99, entryHigh: 100, stopLoss: 95, tp1: 103, tp2: 106, tp3: 110, leverageMin: 3, leverageMax: 6 })
  assert.ok('trade' in created)
  const id = (created as { trade: { id: string } }).trade.id
  frames.length = 0
  wireFetch({ price: 120 }) // above TP3

  await trackSignalOutcomes(Date.now())
  const t = state.signals.tracked.find((x) => x.id === id)!
  assert.equal(t.status, 'tp3', 'tracked plan advanced to its final target')
  assert.ok((t.realizedR ?? 0) > 0)
  assert.ok(frames.some((f) => f.type === 'tracked-update' && f.trade?.id === id), 'broadcast the tracked close')

  assert.equal(closeTracked(id), true)
  assert.equal(state.signals.tracked.length, 0, 'closing removes the tracked trade')
  assert.equal(closeTracked('nope'), false)
})

test('updateTracked: re-configuring levels rebuilds the plan and resets outcome tracking', () => {
  state.signals = { active: [], history: [], tracked: [] }
  const created = createTracked({ symbol: 'sol', cgId: 'solana', direction: 'LONG', entryLow: 99, entryHigh: 100, stopLoss: 95, tp1: 103, tp2: 106, tp3: 110 })
  const id = (created as { trade: { id: string } }).trade.id
  // simulate a prior TP1 touch, then move the stop up
  state.signals.tracked[0].hitTp1At = 123
  const out = updateTracked(id, { stopLoss: 97 })
  assert.ok('trade' in out, JSON.stringify(out))
  assert.equal(state.signals.tracked[0].stopLoss, 97)
  assert.equal(state.signals.tracked[0].hitTp1At, undefined, 'outcome tracking reset on re-config')
  // an invalid edit is rejected and leaves the plan unchanged
  assert.ok('error' in updateTracked(id, { stopLoss: 200 }))
  assert.equal(state.signals.tracked[0].stopLoss, 97)
})

test('updateTracked: editing an aging trade refreshes its expiry (does not truncate/expire it)', () => {
  state.signals = { active: [], history: [], tracked: [] }
  const created = createTracked({ symbol: 'sol', cgId: 'solana', direction: 'LONG', entryLow: 99, entryHigh: 100, stopLoss: 95, tp1: 103, tp2: 106, tp3: 110 })
  const id = (created as { trade: { id: string } }).trade.id
  const t0 = state.signals.tracked[0]
  const ttl = t0.expiresAt - t0.createdAt // the originally-chosen lifetime (14d default)
  // Age it to ~13 days old — its expiry (anchored to the OLD createdAt) is now ~1 day away.
  t0.createdAt = Date.now() - 13 * 24 * 3_600_000
  t0.expiresAt = t0.createdAt + ttl
  const out = updateTracked(id, { stopLoss: 97 })
  assert.ok('trade' in out, JSON.stringify(out))
  const t1 = state.signals.tracked[0]
  assert.equal(t1.createdAt, t0.createdAt, 'original creation time preserved for history')
  // A fresh full lifetime from NOW — not anchored to the old createdAt (which would leave ~1 day).
  assert.ok(t1.expiresAt - Date.now() > ttl - 60_000, `expiry refreshed (${t1.expiresAt - Date.now()}ms left)`)
})

test('createTracked: rejects a missing symbol / cgId / bad direction cleanly (no throw → no 500)', () => {
  state.signals = { active: [], history: [], tracked: [] }
  // missing symbol previously threw a TypeError at `symbol.toUpperCase()` → surfaced as a 500
  assert.ok('error' in createTracked({ cgId: 'solana', direction: 'LONG', entryLow: 99, entryHigh: 100, stopLoss: 95, tp1: 103 } as any))
  // a garbage direction must not silently build a SHORT
  assert.ok('error' in createTracked({ symbol: 'sol', cgId: 'solana', direction: 'sideways', entryLow: 99, entryHigh: 100, stopLoss: 95, tp1: 103 } as any))
  // missing / malformed cgId (the price source of truth)
  assert.ok('error' in createTracked({ symbol: 'sol', direction: 'LONG', entryLow: 99, entryHigh: 100, stopLoss: 95, tp1: 103 } as any))
  assert.equal(state.signals.tracked.length, 0, 'nothing stored on a rejected request')
})
