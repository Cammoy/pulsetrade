// Perps domain math: liquidation, PnL, funding, open validation, the tp/stop/liq close logic,
// stats, and the executor gating. Pure — fully deterministic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-perps-'))

const { openPerp, liquidationPrice, grossPnl, positionPnl, fundingDelta, isLiquidated, nextPerpState, closePerp, summarizePerps, paperExecutor, liveExecutor, MAX_LEVERAGE, MAINTENANCE_MARGIN_RATE } = await import('../src/perps.js')
type PerpPosition = import('../src/perps.js').PerpPosition

const baseInput = { symbol: 'btc', cgId: 'bitcoin', side: 'long' as const, leverage: 10, marginUsd: 100 }

// ── openPerp ──────────────────────────────────────────────────────────────────

test('openPerp: a valid LONG sizes notional/size/liq and books the open fee', () => {
  const res = openPerp({ ...baseInput, stopLoss: 95, takeProfit: 130 }, 100, 1_000, 'p1')
  assert.ok('position' in res, JSON.stringify(res))
  const p = (res as { position: PerpPosition }).position
  assert.equal(p.symbol, 'BTC')
  assert.equal(p.side, 'long')
  assert.equal(p.notionalUsd, 1000) // 100 × 10
  assert.equal(p.sizeCoin, 10) // 1000 / 100
  assert.equal(p.entryPrice, 100)
  // isolated liq ≈ entry × (1 − 1/lev + mmr) = 100 × (1 − 0.1 + 0.005) = 90.5
  assert.ok(Math.abs(p.liqPrice - 90.5) < 1e-6)
  assert.ok(p.feesUsd > 0) // taker fee on 1000 notional
  assert.equal(p.mode, 'paper')
  assert.equal(p.status, 'open')
})

test('openPerp: rejects bad leverage, margin, and wrong-side stops/targets', () => {
  assert.ok('error' in openPerp({ ...baseInput, leverage: 0 }, 100, 0, 'x'))
  assert.ok('error' in openPerp({ ...baseInput, leverage: MAX_LEVERAGE + 1 }, 100, 100, 'x'))
  assert.ok('error' in openPerp({ ...baseInput, marginUsd: 0 }, 100, 100, 'x'))
  assert.ok('error' in openPerp({ ...baseInput }, 0, 100, 'x')) // no mark
  assert.ok('error' in openPerp({ ...baseInput, stopLoss: 110 }, 100, 100, 'x')) // SL above entry for a long
  assert.ok('error' in openPerp({ ...baseInput, takeProfit: 90 }, 100, 100, 'x')) // TP below entry for a long
})

test('openPerp: rejects a non-finite (Infinity / NaN) margin', () => {
  // Number("Infinity") passes a naive `> 0` check and would yield an Infinity-size, NaN-PnL position.
  assert.ok('error' in openPerp({ ...baseInput, marginUsd: Infinity }, 100, 100, 'x'))
  assert.ok('error' in openPerp({ ...baseInput, marginUsd: NaN }, 100, 100, 'x'))
})

test('openPerp: SHORT mirrors the liquidation + stop/target geometry', () => {
  const res = openPerp({ ...baseInput, side: 'short', stopLoss: 105, takeProfit: 80 }, 100, 0, 's1')
  assert.ok('position' in res, JSON.stringify(res))
  const p = (res as { position: PerpPosition }).position
  assert.ok(p.liqPrice > 100, 'short liquidates above entry')
  assert.ok(Math.abs(p.liqPrice - 109.5) < 1e-6) // 100 × (1 + 0.1 − 0.005)
  assert.ok('error' in openPerp({ ...baseInput, side: 'short', stopLoss: 95 }, 100, 0, 'x')) // SL below entry for a short
})

// ── liquidation / pnl / funding ─────────────────────────────────────────────────

test('liquidationPrice: higher leverage liquidates closer to entry', () => {
  const lo = liquidationPrice('long', 100, 2)
  const hi = liquidationPrice('long', 100, 20)
  assert.ok(hi > lo, 'a 20× long liquidates nearer entry than a 2× long')
  assert.ok(liquidationPrice('short', 100, 10) > 100)
})

test('grossPnl + positionPnl: direction-correct, net of funding + fees', () => {
  const p = (openPerp({ ...baseInput }, 100, 0, 'p') as { position: PerpPosition }).position
  assert.equal(grossPnl(p, 110), 100) // +10 × 10 coins
  assert.equal(grossPnl(p, 90), -100)
  p.fundingPaidUsd = 5
  // net = gross(110)=100 − funding 5 − openFee
  assert.ok(Math.abs(positionPnl(p, 110) - (100 - 5 - p.feesUsd)) < 1e-6)
})

test('fundingDelta: longs pay positive funding, shorts receive; scales with time + notional', () => {
  const oneHourLong = fundingDelta('long', 1000, 0.0001, 3_600_000) // 1000 × 0.0001 × 1h
  assert.ok(Math.abs(oneHourLong - 0.1) < 1e-6)
  assert.equal(fundingDelta('short', 1000, 0.0001, 3_600_000), -oneHourLong)
  assert.equal(fundingDelta('long', 1000, 0.0001, 0), 0)
})

test('isLiquidated: long at/below liq, short at/above liq', () => {
  assert.equal(isLiquidated({ side: 'long', liqPrice: 90 }, 90), true)
  assert.equal(isLiquidated({ side: 'long', liqPrice: 90 }, 91), false)
  assert.equal(isLiquidated({ side: 'short', liqPrice: 110 }, 110), true)
})

// ── nextPerpState close logic ─────────────────────────────────────────────────

const longPos = (over: Partial<PerpPosition> = {}): PerpPosition =>
  ({ ...(openPerp({ ...baseInput, stopLoss: 95, takeProfit: 130 }, 100, 0, 'L') as { position: PerpPosition }).position, ...over })

test('nextPerpState: take-profit closes with a positive realized PnL', () => {
  const c = nextPerpState(longPos(), 130, 50)
  assert.equal(c.status, 'closed')
  assert.equal(c.closeReason, 'tp')
  assert.equal(c.closePrice, 130)
  assert.ok((c.realizedPnlUsd ?? 0) > 0)
})

test('nextPerpState: stop closes at the stop; liquidation takes priority over the stop', () => {
  const stopped = nextPerpState(longPos(), 95, 60)
  assert.equal(stopped.closeReason, 'stop')
  // a gap straight to the liq price closes as liquidated, not stop
  const liq = nextPerpState(longPos(), 90, 60)
  assert.equal(liq.closeReason, 'liquidated')
})

test('nextPerpState: open position with price in range is returned unchanged + idempotent once closed', () => {
  const p = longPos()
  assert.equal(nextPerpState(p, 105, 10), p) // still open → same ref
  const closed = nextPerpState(p, 130, 10)
  assert.equal(nextPerpState(closed, 80, 20), closed) // already closed → unchanged
})

test('closePerp: manual close books the closing fee + realized PnL', () => {
  const c = closePerp(longPos(), 120, 99, 'manual')
  assert.equal(c.closeReason, 'manual')
  assert.ok((c.realizedPnlUsd ?? 0) > 0)
  assert.ok(c.feesUsd > longPos().feesUsd, 'a second (closing) fee was booked')
})

test('closePerp: a liquidation can never realize a loss beyond the posted margin', () => {
  // Even with a large funding overhang, an isolated liquidation loss is floored at −margin
  // (the rest is a venue-absorbed bankruptcy) — paper equity/ROE can't go below −100%.
  const p = longPos({ fundingPaidUsd: 500 })
  const c = closePerp(p, p.liqPrice, 100, 'liquidated')
  assert.equal(c.closeReason, 'liquidated')
  assert.equal(c.realizedPnlUsd, -p.marginUsd) // clamped exactly to −margin
})

test('nextPerpState: a flat position bled dry by funding liquidates on EQUITY, not price', () => {
  // Mark never leaves entry (price-based liq never fires), but accrued funding has drained the
  // margin to the maintenance floor → the position must liquidate at the current mark. [funding-liq]
  const p = longPos({ fundingPaidUsd: 100 }) // ≈ the full $100 margin paid in funding
  const c = nextPerpState(p, 100, 500)
  assert.equal(c.status, 'closed')
  assert.equal(c.closeReason, 'liquidated')
  assert.equal(c.closePrice, 100) // closed at the mark, not liqPrice
  assert.ok((c.realizedPnlUsd ?? 0) >= -p.marginUsd)
})

test('nextPerpState: modest funding does NOT trigger a spurious equity liquidation', () => {
  const p = longPos({ fundingPaidUsd: 5 }) // equity ≈ 94.5 ≫ maintenance
  assert.equal(nextPerpState(p, 100, 10), p) // still open → same ref
})

// ── stats + executor gating ────────────────────────────────────────────────────

test('summarizePerps: aggregates open/closed, win rate, realized PnL', () => {
  const mk = (over: Partial<PerpPosition>) => longPos(over)
  const list = [mk({ id: 'a', status: 'open' }), mk({ id: 'b', status: 'closed', realizedPnlUsd: 50 }), mk({ id: 'c', status: 'closed', realizedPnlUsd: -20 })]
  const s = summarizePerps(list)
  assert.equal(s.open, 1)
  assert.equal(s.closed, 2)
  assert.equal(s.wins, 1)
  assert.equal(s.losses, 1)
  assert.equal(s.winRatePct, 50)
  assert.equal(s.realizedPnlUsd, 30)
})

test('executor gating: paper fills at the mark; live fails closed', async () => {
  assert.equal(paperExecutor.ready, true)
  assert.deepEqual(await paperExecutor.fill('BTC', 'long', 1000, 100), { price: 100 })
  assert.equal(liveExecutor.ready, false)
  await assert.rejects(() => liveExecutor.fill('BTC', 'long', 1000, 100), /not enabled yet/)
})

test('MAINTENANCE_MARGIN_RATE is a sane small fraction', () => {
  assert.ok(MAINTENANCE_MARGIN_RATE > 0 && MAINTENANCE_MARGIN_RATE < 0.05)
})
