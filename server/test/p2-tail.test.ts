// P2 tail: candle-free protective SL/TP (P2-5), DCA downtrend filter (P2-8), and the
// auto/follow budget reclaim on delete (P2-14). Pure/isolated — no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-p2tail-'))

const { state, dayKey } = await import('../src/store.js')
const { deleteBot, reconcilePendingBuys, __test } = await import('../src/engine.js')
const { strategyById } = await import('../src/strategies.js')
const { RISK } = await import('../src/risk.js')
const { slTpFallback } = __test

// ── P2-5: candle-free protective exit ─────────────────────────────────────────
test('P2-5: slTpFallback exits on a stop/target with NO candles, holds otherwise', () => {
  const p = RISK.balanced
  const held = { position: { qty: 1, avgCostUsd: 100, costUsd: 100 } } as any
  const stop = slTpFallback(held, 100 * (1 - p.stopLossPct / 100) - 1, p)
  assert.ok(stop && stop.type === 'sell' && stop.exit && /stop-loss/i.test(stop.reason), 'stop-loss fires below the tier stop')
  const tp = slTpFallback(held, 100 * (1 + p.takeProfitPct / 100) + 1, p)
  assert.ok(tp && tp.type === 'sell' && /take-profit/i.test(tp.reason), 'take-profit fires above the tier target')
  assert.equal(slTpFallback(held, 100, p), null, 'within the band → hold')
  assert.equal(slTpFallback({ position: { qty: 0, avgCostUsd: 0 } } as any, 50, p), null, 'no position → null')
})

// ── P2-8: DCA downtrend filter ────────────────────────────────────────────────
const sma = (xs: number[], n: number) => xs.slice(-n).reduce((s, x) => s + x, 0) / n

test('P2-8: DCA does NOT average down into a confirmed 50h downtrend', () => {
  const dca = strategyById('dca')!
  const closes: number[] = []
  for (let i = 0; i < 60; i++) closes.push(120 - i) // steep decline 120 → 61
  const price = closes[closes.length - 1]
  assert.ok(price < sma(closes, 24), 'precondition: below the 24h average (a "dip")')
  assert.ok((price - sma(closes, 50)) / sma(closes, 50) < -0.08, 'precondition: >8% below the 50h average (downtrend)')
  const ctx: any = { price, closes, params: RISK.balanced, state: {}, position: { qty: 0, avgCostUsd: 0, costUsd: 0 }, budgetUsd: 1000, cashUsd: 1000, now: 1e12 }
  assert.equal(dca.decide(ctx), null, 'no slice bought into a dying token (martingale guard)')
})

test('P2-8: DCA still buys a shallow dip that is NOT a confirmed downtrend', () => {
  const dca = strategyById('dca')!
  const closes: number[] = []
  for (let i = 0; i < 60; i++) closes.push(100 + Math.sin(i / 5) * 1.5) // flat ~100
  const price = 98 // below both averages but only ~2% under the 50h mean
  const ctx: any = { price, closes, params: RISK.balanced, state: {}, position: { qty: 0, avgCostUsd: 0, costUsd: 0 }, budgetUsd: 1000, cashUsd: 1000, now: 1e12 }
  const a = dca.decide(ctx)
  assert.ok(a && a.type === 'buy', 'a shallow dip still gets a DCA slice')
})

// ── P2-14: delete returns a running spawn's cash to its pool ──────────────────
test('P2-14: deleting a running auto-snipe returns its cash to the auto-sniper pool', () => {
  state.bots.length = 0
  state.autoSniper = { poolUsd: 200 } as any
  state.bots.push({ id: 'b1', auto: true, cashUsd: 80, mode: 'paper', position: { qty: 0, avgCostUsd: 0 }, state: {}, network: 'base', token: 'X' } as any)
  assert.equal(deleteBot('b1'), true)
  assert.equal(state.autoSniper!.poolUsd, 280, 'cash reclaimed, not leaked')
  assert.equal(state.bots.length, 0)
})

test('P2-14: deleting a running follow-mirror returns its cash to the follow pool', () => {
  state.bots.length = 0
  state.follows = [{ id: 'f1', poolUsd: 100 } as any]
  state.bots.push({ id: 'b2', followId: 'f1', cashUsd: 40, mode: 'paper', position: { qty: 0, avgCostUsd: 0 }, state: {}, network: 'base', token: 'Y' } as any)
  assert.equal(deleteBot('b2'), true)
  assert.equal(state.follows[0].poolUsd, 140, 'cash reclaimed to the follow pool')
})

// ── P1-7: in-flight live-buy journal recovered on boot ───────────────────────
test('P1-7: boot books a journaled in-flight buy conservatively and flags the bot', () => {
  state.bots.length = 0
  state.liveSpend = { day: '', usd: 0 }
  state.breaker = { tripped: false, reason: '', trippedAt: null, realizedUsd: 0, spentUsd: 0 }
  state.bots.push({ id: 'pb1', mode: 'live', position: { qty: 0, avgCostUsd: 0 }, state: {}, network: 'base', token: 'X' } as any)
  // A buy was journaled before the swap; we "crashed" before it was booked/cleared.
  state.pendingBuys = [{ botId: 'pb1', network: 'base', token: 'X', usd: 60, ts: 1 }]
  const n = reconcilePendingBuys()
  assert.equal(n, 1)
  assert.equal(state.pendingBuys.length, 0, 'journal cleared')
  assert.equal(state.liveSpend.day, dayKey())
  assert.ok(Math.abs(state.liveSpend.usd - 60) < 1e-9, 'intended spend booked to the daily cap (conservative)')
  assert.ok(Math.abs(state.breaker.spentUsd - 60) < 1e-9, 'and to the lifetime spend')
  assert.equal(state.bots[0].state.realHeldUntrusted, true, 'position flagged for chain reconcile')
})

test('P1-7: no journal → reconcile is a no-op', () => {
  state.pendingBuys = []
  state.liveSpend = { day: '', usd: 0 }
  assert.equal(reconcilePendingBuys(), 0)
  assert.equal(state.liveSpend.usd, 0)
})

test('P2-14: a reclaim is not double-counted when the scan already returned the cash', () => {
  state.bots.length = 0
  state.autoSniper = { poolUsd: 200 } as any
  // Bot already reclaimed by the autoScan "money comes home" pass.
  state.bots.push({ id: 'b3', auto: true, cashUsd: 80, mode: 'paper', position: { qty: 0, avgCostUsd: 0 }, state: { reclaimedByAuto: true }, network: 'base', token: 'Z' } as any)
  deleteBot('b3')
  assert.equal(state.autoSniper!.poolUsd, 200, 'no second reclaim for an already-reclaimed bot')
})
