// Limit (conditional) orders: validation, trigger evaluation, fill simulation, and the
// create→trigger→fill / expire / cancel lifecycle. Fetch (CoinGecko spot) mocked.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-limit-'))

const { buildLimitOrder, evaluateLimit, simulateFill, createLimitOrder, cancelLimitOrder, checkLimitOrders, getLimitOrdersPayload } = await import('../src/limit-orders.js')
const { state } = await import('../src/store.js')
const { setBroadcast } = await import('../src/broadcast.js')
const { __test: prices } = await import('../src/prices.js')
type LimitOrder = import('../src/limit-orders.js').LimitOrder

const R = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200 })
const frames: any[] = []
setBroadcast((m) => frames.push(m))

let price = 100
const setPrice = (p: number) => {
  price = p
  prices.expireSpot() // defeat the 20s spot cache
}
globalThis.fetch = (async (url: any) => (String(url).includes('simple/price') ? R({ solana: { usd: price } }) : R({}))) as typeof fetch

// ── pure: buildLimitOrder ──────────────────────────────────────────────────────

test('buildLimitOrder: a BUY waits for a dip (trigger below current)', () => {
  assert.ok('order' in buildLimitOrder({ cg: 'solana', symbol: 'sol', side: 'buy', amountUsd: 500, triggerPrice: 90 }, 100, 1, 'o'))
  const bad = buildLimitOrder({ cg: 'solana', symbol: 'sol', side: 'buy', amountUsd: 500, triggerPrice: 110 }, 100, 1, 'o')
  assert.ok('error' in bad && /below/.test((bad as { error: string }).error))
})

test('buildLimitOrder: a SELL waits for a rise (trigger above current)', () => {
  assert.ok('order' in buildLimitOrder({ cg: 'solana', symbol: 'sol', side: 'sell', amountUsd: 500, triggerPrice: 120 }, 100, 1, 'o'))
  assert.ok('error' in buildLimitOrder({ cg: 'solana', symbol: 'sol', side: 'sell', amountUsd: 500, triggerPrice: 80 }, 100, 1, 'o'))
})

test('buildLimitOrder: rejects bad coin / amount / trigger / price', () => {
  assert.ok('error' in buildLimitOrder({ cg: '', symbol: '', side: 'buy', amountUsd: 1, triggerPrice: 1 }, 100, 1, 'o'))
  assert.ok('error' in buildLimitOrder({ cg: 'solana', symbol: 'sol', side: 'buy', amountUsd: 0, triggerPrice: 90 }, 100, 1, 'o'))
  assert.ok('error' in buildLimitOrder({ cg: 'solana', symbol: 'sol', side: 'buy', amountUsd: 500, triggerPrice: 0 }, 100, 1, 'o'))
  assert.ok('error' in buildLimitOrder({ cg: 'solana', symbol: 'sol', side: 'buy', amountUsd: 500, triggerPrice: 90 }, 0, 1, 'o'))
})

// ── pure: evaluate + simulate ───────────────────────────────────────────────────

const mk = (over: Partial<LimitOrder>): LimitOrder => ({ id: 'o', cg: 'solana', symbol: 'SOL', name: 'Solana', side: 'buy', amountUsd: 500, triggerPrice: 90, refPrice: 100, status: 'open', createdAt: 0, expiresAt: 1e15, mode: 'paper', ...over })

test('evaluateLimit: buy fills at/below trigger, sell at/above', () => {
  assert.equal(evaluateLimit(mk({ side: 'buy', triggerPrice: 90 }), 91), false)
  assert.equal(evaluateLimit(mk({ side: 'buy', triggerPrice: 90 }), 90), true)
  assert.equal(evaluateLimit(mk({ side: 'sell', triggerPrice: 120 }), 119), false)
  assert.equal(evaluateLimit(mk({ side: 'sell', triggerPrice: 120 }), 120), true)
})

test('simulateFill: BUY pays trigger-or-better, nets coin after fee', () => {
  const f = simulateFill(mk({ side: 'buy', amountUsd: 900, triggerPrice: 90 }), 90)
  assert.equal(f.fillPrice, 90)
  // 900/90 = 10 coin, ×(1−0.003) ≈ 9.97
  assert.ok(Math.abs(f.filledQty - 9.97) < 0.001)
  // a gap below the trigger fills at the better (lower) price
  assert.equal(simulateFill(mk({ side: 'buy', triggerPrice: 90 }), 80).fillPrice, 80)
})

test('simulateFill: SELL receives trigger-or-better, proceeds after fee', () => {
  const f = simulateFill(mk({ side: 'sell', amountUsd: 1000, triggerPrice: 120 }), 120)
  assert.equal(f.fillPrice, 120)
  assert.equal(f.proceedsUsd, 997) // 1000 × (1−0.003)
  assert.equal(simulateFill(mk({ side: 'sell', triggerPrice: 120 }), 130).fillPrice, 130) // gap up fills higher
})

// ── stateful lifecycle ──────────────────────────────────────────────────────────

beforeEach(() => {
  state.limitOrders = []
  frames.length = 0
  setPrice(100)
})

test('createLimitOrder validates against the live price + broadcasts', async () => {
  const ok = await createLimitOrder({ cg: 'solana', symbol: 'sol', name: 'Solana', side: 'buy', amountUsd: 500, triggerPrice: 90 })
  assert.ok('order' in ok, JSON.stringify(ok))
  assert.equal(state.limitOrders!.length, 1)
  assert.ok(frames.some((f) => f.type === 'limit-orders'))
  // invalid (buy target above current) is rejected, not stored
  assert.ok('error' in (await createLimitOrder({ cg: 'solana', symbol: 'sol', side: 'buy', amountUsd: 500, triggerPrice: 130 })))
  assert.equal(state.limitOrders!.length, 1)
})

test('checkLimitOrders fills a BUY on the dip and broadcasts the fill', async () => {
  await createLimitOrder({ cg: 'solana', symbol: 'sol', name: 'Solana', side: 'buy', amountUsd: 500, triggerPrice: 90 })
  frames.length = 0

  setPrice(95) // not yet
  assert.equal(await checkLimitOrders(Date.now()), false)
  assert.equal(state.limitOrders![0].status, 'open')

  setPrice(88) // dips through 90
  const fired = await checkLimitOrders(Date.now())
  assert.equal(fired, true)
  const o = state.limitOrders![0]
  assert.equal(o.status, 'filled')
  assert.equal(o.fillPrice, 88) // gapped below trigger → better price
  assert.ok((o.filledQty ?? 0) > 0)
  assert.ok(frames.some((f) => f.type === 'limit-fill'))

  // one-shot: a filled order isn't re-evaluated
  frames.length = 0
  assert.equal(await checkLimitOrders(Date.now()), false)
})

test('checkLimitOrders expires an order past its TTL', async () => {
  await createLimitOrder({ cg: 'solana', symbol: 'sol', name: 'Solana', side: 'sell', amountUsd: 500, triggerPrice: 120, ttlMs: 1 })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(await checkLimitOrders(Date.now()), true)
  assert.equal(state.limitOrders![0].status, 'expired')
})

test('cancelLimitOrder cancels an open order, then dismisses a settled one', async () => {
  const o = await createLimitOrder({ cg: 'solana', symbol: 'sol', name: 'Solana', side: 'buy', amountUsd: 500, triggerPrice: 90 })
  const id = (o as { order: LimitOrder }).order.id
  assert.equal(cancelLimitOrder(id), true)
  assert.equal(state.limitOrders![0].status, 'cancelled')
  assert.equal(cancelLimitOrder(id), true) // now dismisses it
  assert.equal(getLimitOrdersPayload().orders.length, 0)
  assert.equal(cancelLimitOrder('nope'), false)
})

test('checkLimitOrders: an order cancelled DURING the price fetch is not filled (race)', async () => {
  const o = await createLimitOrder({ cg: 'solana', symbol: 'sol', name: 'Solana', side: 'buy', amountUsd: 500, triggerPrice: 90 })
  const id = (o as { order: LimitOrder }).order.id
  frames.length = 0
  setPrice(80) // would dip through the trigger and fill
  // A concurrent DELETE /api/limit-orders/:id lands during the getSpotPrices await — the fetch mock
  // cancels the order mid-flight, the exact window the fill loop must re-validate before filling.
  const prev = globalThis.fetch
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('simple/price')) cancelLimitOrder(id)
    return R(String(url).includes('simple/price') ? { solana: { usd: 80 } } : {})
  }) as typeof fetch
  const fired = await checkLimitOrders(Date.now())
  globalThis.fetch = prev
  assert.equal(fired, false, 'a just-cancelled order must not fill')
  assert.equal(state.limitOrders![0].status, 'cancelled')
  assert.ok(!frames.some((f) => f.type === 'limit-fill'), 'no fill broadcast')
})
