// Pure signal-domain math: candidate scanning, risk construction + every gate, the
// confidence blend, leverage scaling, the outcome model and the forward-test stats.
// No I/O — fully deterministic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-signals-'))

const {
  scanCandidates,
  buildSignal,
  buildUserTrade,
  blendConfidence,
  leverageFor,
  nextSignalState,
  summarizeSignals,
  toRadarEntry,
  DEFAULT_CONFIG,
  DISCLAIMER,
} = await import('../src/signals.js')
type TradeSignal = import('../src/signals.js').TradeSignal
type ScanRow = import('../src/signals.js').ScanRow
type Candidate = import('../src/signals.js').Candidate
type TechnicalSignal = import('../src/market.js').TechnicalSignal

const sig = (action: TechnicalSignal['action'], score: number): TechnicalSignal => ({ action, score, reasons: [`score ${score}`] })

const row = (o: Partial<ScanRow>): ScanRow => ({
  id: o.id ?? 'coin',
  symbol: o.symbol ?? 'COIN',
  name: o.name ?? 'Coin',
  priceUsd: o.priceUsd ?? 100,
  change1h: o.change1h ?? 0,
  change24h: o.change24h ?? 0,
  change7d: o.change7d ?? 0,
  marketCapUsd: o.marketCapUsd ?? 1e9,
  volume24hUsd: o.volume24hUsd ?? 50_000_000,
  volToMcap: o.volToMcap ?? 0.05,
  rsi: o.rsi ?? 50,
  stable: o.stable ?? false,
  signal: o.signal ?? sig('hold', 0),
})

// ── scanCandidates ──────────────────────────────────────────────────────────

test('scanCandidates: flags in-play directional coins, ranks them, drops stables/illiquid/ranging', () => {
  const rows = [
    row({ id: 'long', symbol: 'LONG', change24h: 9, signal: sig('buy', 45) }), // strong up mover → LONG
    row({ id: 'short', symbol: 'SHORT', change24h: -8, signal: sig('sell', -40) }), // strong down mover → SHORT
    row({ id: 'range', symbol: 'RANGE', change24h: 9, signal: sig('hold', 10) }), // in play but no directional edge → dropped
    row({ id: 'quiet', symbol: 'QUIET', change24h: 1, change1h: 0.2, volToMcap: 0.02, rsi: 50, signal: sig('buy', 40) }), // edge but not "in play" → dropped
    row({ id: 'stable', symbol: 'USDC', change24h: 12, stable: true, signal: sig('buy', 50) }), // stablecoin → dropped
    row({ id: 'micro', symbol: 'MICRO', change24h: 30, marketCapUsd: 1e6, signal: sig('buy', 60) }), // sub-floor cap → dropped
    row({ id: 'dead', symbol: 'DEAD', change24h: 30, volume24hUsd: 100_000, signal: sig('buy', 60) }), // dead tape → dropped
  ]
  const out = scanCandidates(rows)
  const ids = out.map((c) => c.cgId)
  assert.ok(ids.includes('long') && ids.includes('short'), 'directional in-play coins kept')
  assert.ok(!ids.includes('range'), 'ranging (no directional edge) dropped')
  assert.ok(!ids.includes('quiet'), 'not-in-play coin dropped')
  assert.ok(!ids.includes('stable') && !ids.includes('micro') && !ids.includes('dead'), 'stable/micro/dead dropped')
  assert.equal(out.find((c) => c.cgId === 'long')!.direction, 'LONG')
  assert.equal(out.find((c) => c.cgId === 'short')!.direction, 'SHORT')
  assert.ok(out.every((c) => c.triggers.length > 0), 'every candidate carries a reason')
})

test('scanCandidates: honours the limit, highest scan score first', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row({ id: `c${i}`, symbol: `C${i}`, change24h: 7 + i, volToMcap: 0.2, signal: sig('buy', 30 + i) }))
  const out = scanCandidates(rows, 3)
  assert.equal(out.length, 3)
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].scanScore >= out[i].scanScore, 'sorted by scan score desc')
})

test('toRadarEntry: projects a candidate onto a radar row, carrying bias + reason', () => {
  const c = scanCandidates([row({ id: 'sol', symbol: 'SOL', change24h: 9, signal: sig('buy', 45) })])[0]
  const watching = toRadarEntry(c, 'watching', 'R:R 1.20 below 1.5')
  assert.equal(watching.symbol, 'SOL')
  assert.equal(watching.bias, 'LONG')
  assert.equal(watching.status, 'watching')
  assert.equal(watching.reason, 'R:R 1.20 below 1.5')
  assert.ok(watching.triggers.length > 0)
  const posted = toRadarEntry(c, 'signal', 'Posted — cleared all filters')
  assert.equal(posted.status, 'signal')
})

// ── buildSignal ─────────────────────────────────────────────────────────────

// A volatile series sitting near a recent swing low: good R:R for a LONG.
const volatile = Array.from({ length: 200 }, (_, i) => 100 + 3 * Math.sin(i / 3))
// A steadily extended uptrend: swing low is far below price → wide stop → poor R:R.
const extended = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.01, i))

const candidate = (o: Partial<Candidate> = {}): Candidate => ({
  cgId: 'coin',
  symbol: 'COIN',
  name: 'Coin',
  price: 100,
  change1h: 1,
  change24h: 8,
  change7d: 10,
  rsi: 55,
  volToMcap: 0.2,
  volume24hUsd: 5e7,
  marketCapUsd: 1e9,
  signal: sig('buy', 45),
  direction: 'LONG',
  scanScore: 80,
  triggers: ['+8% 24h move'],
  ...o,
})

test('buildSignal: happy-path LONG produces a well-formed, ordered signal', () => {
  const res = buildSignal({ candidate: candidate(), direction: 'LONG', closes: volatile, sentimentScore: 0.5, aiConfidence: 0.85, rationale: 'Bullish cross with positive flows', now: 1_000, id: 'sig1' })
  assert.ok('signal' in res, `expected a signal, got ${JSON.stringify(res)}`)
  const s = (res as { signal: TradeSignal }).signal
  assert.equal(s.direction, 'LONG')
  assert.equal(s.asset, 'COIN/USDT')
  assert.ok(s.entryLow < s.entryHigh && s.entryHigh <= s.refPrice * 1.0001, 'LONG entry zone sits at/below price')
  assert.ok(s.stopLoss < s.entryMid, 'stop below entry for a LONG')
  assert.ok(s.entryMid < s.tp1 && s.tp1 < s.tp2 && s.tp2 < s.tp3, 'TPs ascend above entry')
  assert.ok(s.riskReward >= DEFAULT_CONFIG.minRr, `R:R ${s.riskReward} clears the gate`)
  assert.ok(s.confidence >= DEFAULT_CONFIG.minConfidence && s.confidence <= 100)
  assert.ok(s.leverageMin >= 2 && s.leverageMax <= DEFAULT_CONFIG.maxLeverage && s.leverageMin <= s.leverageMax)
  assert.equal(s.disclaimer, DISCLAIMER)
  assert.equal(s.status, 'active')
  assert.equal(s.expiresAt, 1_000 + DEFAULT_CONFIG.ttlMs)
  assert.equal(s.sentimentScore, 0.5)
})

test('buildSignal: SHORT mirrors the geometry', () => {
  // Same price level + amplitude as `volatile` (so % volatility matches), inverted phase
  // so it ends near a recent swing HIGH — tight stop above, downside room for a SHORT.
  const closes = Array.from({ length: 200 }, (_, i) => 100 - 3 * Math.sin(i / 3))
  const res = buildSignal({ candidate: candidate({ direction: 'SHORT', signal: sig('sell', -45), change24h: -8 }), direction: 'SHORT', closes, sentimentScore: -0.5, aiConfidence: 0.85, rationale: 'Bearish', now: 0, id: 's' })
  assert.ok('signal' in res, JSON.stringify(res))
  const s = (res as { signal: TradeSignal }).signal
  assert.ok(s.entryLow <= s.refPrice * 1.0001 && s.entryHigh > s.entryLow, 'SHORT entry zone sits at/above price')
  assert.ok(s.stopLoss > s.entryMid, 'stop above entry for a SHORT')
  assert.ok(s.tp1 < s.entryMid && s.tp3 < s.tp2 && s.tp2 < s.tp1, 'TPs descend below entry')
})

test('buildSignal: R:R gate rejects an extended chase', () => {
  const res = buildSignal({ candidate: candidate(), direction: 'LONG', closes: extended, sentimentScore: 0.3, aiConfidence: 0.9, rationale: 'x', now: 0, id: 'x' })
  assert.ok('rejected' in res && /R:R/.test((res as { rejected: string }).rejected), JSON.stringify(res))
})

test('buildSignal: sentiment filter discards a LONG into strongly negative news', () => {
  const res = buildSignal({ candidate: candidate(), direction: 'LONG', closes: volatile, sentimentScore: -0.6, aiConfidence: 0.9, rationale: 'x', now: 0, id: 'x' })
  assert.ok('rejected' in res && /sentiment/.test((res as { rejected: string }).rejected), JSON.stringify(res))
})

test('buildSignal: confidence gate rejects below the floor', () => {
  const res = buildSignal({ candidate: candidate(), direction: 'LONG', closes: volatile, sentimentScore: 0.5, aiConfidence: 0.85, rationale: 'x', now: 0, id: 'x', config: { minConfidence: 99 } })
  assert.ok('rejected' in res && /confidence/.test((res as { rejected: string }).rejected), JSON.stringify(res))
})

test('buildSignal: rejects on insufficient history', () => {
  const res = buildSignal({ candidate: candidate(), direction: 'LONG', closes: [1, 2, 3], sentimentScore: 0, aiConfidence: 1, rationale: 'x', now: 0, id: 'x' })
  assert.ok('rejected' in res && /history/.test((res as { rejected: string }).rejected))
})

// ── buildUserTrade (operator-configured plans) ───────────────────────────────

const userBase = {
  id: 'u1', now: 1_000, symbol: 'btc', cgId: 'bitcoin', direction: 'LONG' as const,
  entryLow: 99, entryHigh: 100, stopLoss: 95, tp1: 104, tp2: 108, tp3: 115, leverageMin: 3, leverageMax: 8,
}

test('buildUserTrade: a valid LONG plan is normalized + R:R computed, marked source=user', () => {
  const res = buildUserTrade(userBase)
  assert.ok('trade' in res, JSON.stringify(res))
  const t = (res as { trade: TradeSignal }).trade
  assert.equal(t.source, 'user')
  assert.equal(t.symbol, 'BTC')
  assert.equal(t.entryMid, 99.5)
  assert.equal(t.direction, 'LONG')
  assert.ok(t.stopLoss < t.entryMid && t.tp1 < t.tp2 && t.tp2 < t.tp3)
  assert.ok(Math.abs(t.riskReward - (104 - 99.5) / (99.5 - 95)) < 0.02)
  assert.equal(t.leverageMin, 3)
  assert.equal(t.leverageMax, 8)
  assert.equal(t.status, 'active')
})

test('buildUserTrade: tp2/tp3 default to tp1 for a single-target plan', () => {
  const res = buildUserTrade({ ...userBase, tp2: undefined, tp3: undefined })
  assert.ok('trade' in res)
  const t = (res as { trade: TradeSignal }).trade
  assert.equal(t.tp2, t.tp1)
  assert.equal(t.tp3, t.tp1)
})

test('buildUserTrade: rejects a stop on the wrong side of entry', () => {
  const res = buildUserTrade({ ...userBase, stopLoss: 110 }) // above entry for a LONG
  assert.ok('error' in res && /Stop-loss must be below/.test((res as { error: string }).error))
})

test('buildUserTrade: rejects take-profits below entry / out of order for a LONG', () => {
  assert.ok('error' in buildUserTrade({ ...userBase, tp1: 98 })) // below entry
  assert.ok('error' in buildUserTrade({ ...userBase, tp1: 110, tp2: 105 })) // tp2 < tp1
})

test('buildUserTrade: SHORT validates the mirrored geometry', () => {
  const res = buildUserTrade({ ...userBase, direction: 'SHORT', entryLow: 100, entryHigh: 101, stopLoss: 106, tp1: 96, tp2: 92, tp3: 85 })
  assert.ok('trade' in res, JSON.stringify(res))
  const t = (res as { trade: TradeSignal }).trade
  assert.ok(t.stopLoss > t.entryMid && t.tp1 < t.entryMid && t.tp3 < t.tp2 && t.tp2 < t.tp1)
  // a SHORT stop below entry is rejected
  assert.ok('error' in buildUserTrade({ ...userBase, direction: 'SHORT', stopLoss: 90 }))
})

test('buildUserTrade: leverage is clamped to [1, 125]', () => {
  const res = buildUserTrade({ ...userBase, leverageMin: 0, leverageMax: 500 })
  assert.ok('trade' in res)
  const t = (res as { trade: TradeSignal }).trade
  assert.equal(t.leverageMax, 125)
  assert.ok(t.leverageMin >= 1 && t.leverageMin <= t.leverageMax)
})

test('buildUserTrade: a tracked plan is advanced by nextSignalState like any signal', () => {
  const t = (buildUserTrade(userBase) as { trade: TradeSignal }).trade
  const stopped = nextSignalState(t, 94, 2_000)
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.realizedR, -1)
})

// ── leverage + confidence ───────────────────────────────────────────────────

test('leverageFor: inverse to volatility, clamped to [2, cap]', () => {
  const calm = leverageFor(0.3, 10) // low vol → high cap
  const wild = leverageFor(5, 10) // high vol → floored
  assert.ok(calm.max > wild.max, 'calmer asset earns more leverage')
  assert.ok(wild.max >= 2 && calm.max <= 10, 'clamped to bounds')
  assert.ok(calm.min <= calm.max && calm.min >= 2)
})

test('blendConfidence: aligned signals score higher than conflicting ones', () => {
  const aligned = blendConfidence({ technicalScore: 60, direction: 'LONG', change24h: 8, emaTrendUp: true, sentimentScore: 0.7, aiConfidence: 0.9 })
  const conflicting = blendConfidence({ technicalScore: -60, direction: 'LONG', change24h: -8, emaTrendUp: false, sentimentScore: -0.7, aiConfidence: 0.2 })
  assert.ok(aligned > conflicting)
  assert.ok(aligned >= 0 && aligned <= 100 && conflicting >= 0)
})

// ── outcome tracking ────────────────────────────────────────────────────────

const longSig = (o: Partial<TradeSignal> = {}): TradeSignal => ({
  id: 'o', asset: 'COIN/USDT', symbol: 'COIN', cgId: 'coin', direction: 'LONG',
  entryLow: 99, entryHigh: 100, entryMid: 100, leverageMin: 3, leverageMax: 5,
  tp1: 103, tp2: 106, tp3: 110, stopLoss: 95, confidence: 70, riskReward: 2,
  sentimentScore: 0.3, rationale: 'x', refPrice: 100,
  technicals: { rsi: 55, emaFast: 100, emaSlow: 99, sma: 100, trend: 'up', change24hPct: 5, volatilityPct: 1.5 },
  status: 'active', createdAt: 0, expiresAt: 1_000_000, disclaimer: DISCLAIMER, ...o,
})

test('nextSignalState: LONG climbs through TP1, stays active', () => {
  const s = nextSignalState(longSig(), 104, 10)
  assert.equal(s.status, 'tp1')
  assert.equal(s.hitTp1At, 10)
  assert.equal(s.closedAt, undefined)
})

test('nextSignalState: LONG runs all targets → closed tp3 with positive R', () => {
  const s = nextSignalState(longSig(), 111, 20)
  assert.equal(s.status, 'tp3')
  assert.equal(s.closedAt, 20)
  assert.ok((s.realizedR ?? 0) > 0, 'runner home is a win')
})

test('nextSignalState: LONG stopped with no targets → −1R', () => {
  const s = nextSignalState(longSig(), 94, 30)
  assert.equal(s.status, 'stopped')
  assert.equal(s.realizedR, -1)
})

test('nextSignalState: TP1 then stop → between −1R and the TP1 third', () => {
  const afterTp1 = nextSignalState(longSig(), 103, 5)
  const stopped = nextSignalState(afterTp1, 95, 9)
  assert.equal(stopped.status, 'stopped')
  assert.ok((stopped.realizedR ?? 0) > -1 && (stopped.realizedR ?? 0) < 1, `partial loss, got ${stopped.realizedR}`)
})

test('nextSignalState: expiry marks-to-market the open residual', () => {
  const s = nextSignalState(longSig({ expiresAt: 100 }), 101.5, 200)
  assert.equal(s.status, 'expired')
  assert.ok((s.realizedR ?? 0) > 0 && (s.realizedR ?? 0) < 1, 'small positive MTM')
})

test('nextSignalState: idempotent once closed', () => {
  const closed = nextSignalState(longSig(), 94, 30)
  const again = nextSignalState(closed, 130, 40)
  assert.equal(again, closed, 'a closed signal is returned unchanged')
})

// ── stats ───────────────────────────────────────────────────────────────────

test('summarizeSignals: aggregates wins/losses, avgR, hit-rate; empty → nulls', () => {
  const empty = summarizeSignals([], 3)
  assert.equal(empty.closed, 0)
  assert.equal(empty.winRatePct, null)
  assert.equal(empty.active, 3)

  const closed = [
    longSig({ realizedR: 2.5, hitTp1At: 1 }),
    longSig({ realizedR: -1 }),
    longSig({ realizedR: 1.2, hitTp1At: 1 }),
    longSig({ realizedR: -1 }),
  ]
  const st = summarizeSignals(closed, 2)
  assert.equal(st.closed, 4)
  assert.equal(st.wins, 2)
  assert.equal(st.losses, 2)
  assert.equal(st.winRatePct, 50)
  assert.equal(st.tp1HitRatePct, 50)
  assert.equal(st.totalR, 1.7)
  assert.equal(st.avgR, 0.43)
  assert.equal(st.bestR, 2.5)
  assert.equal(st.worstR, -1)
  assert.equal(st.active, 2)
})
