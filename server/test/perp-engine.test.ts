// Perp engine lifecycle: open at the live mark, mark/track each tick, close on tp/liq + manual,
// edit stops, dismiss. Hyperliquid + CoinGecko fetch mocked.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-perpeng-'))

const { createPerp, closePerpById, editPerpStops, dismissPerp, trackPerps, getPerpsPayload, perpPriceIds } = await import('../src/perp-engine.js')
const { state } = await import('../src/store.js')
const { setBroadcast } = await import('../src/broadcast.js')
const { __resetPerpMarkets } = await import('../src/perps-data.js')

const R = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200 })
const frames: any[] = []
setBroadcast((m) => frames.push(m))

let btc = 60000
const hlSnapshot = () => R([{ universe: [{ name: 'BTC' }] }, [{ markPx: String(btc), funding: '0.00001' }]])
globalThis.fetch = (async (url: any) => {
  const u = String(url)
  if (u.includes('hyperliquid')) return hlSnapshot()
  if (u.includes('simple/price')) return R({ bitcoin: { usd: btc } })
  return R({})
}) as typeof fetch

const setMark = (p: number) => {
  btc = p
  __resetPerpMarkets() // force the next refresh to read the new mark (30s cache otherwise)
}

beforeEach(() => {
  state.perps = []
  frames.length = 0
  setMark(60000)
})

test('createPerp opens a paper position at the live mark + broadcasts', async () => {
  const out = await createPerp({ symbol: 'btc', cgId: 'bitcoin', side: 'long', leverage: 10, marginUsd: 100, stopLoss: 57000, takeProfit: 66000 })
  assert.ok('position' in out, JSON.stringify(out))
  const p = (out as any).position
  assert.equal(p.entryPrice, 60000)
  assert.equal(p.mode, 'paper')
  assert.equal(state.perps!.length, 1)
  assert.ok(frames.some((f) => f.type === 'perp' && f.position?.id), 'broadcast the new position')
  assert.deepEqual(perpPriceIds(), ['bitcoin'])
  // the payload serializes a live mark + unrealized PnL
  const pay = getPerpsPayload()
  assert.equal(pay.open.length, 1)
  assert.equal(typeof pay.open[0].unrealizedPnlUsd, 'number')
  assert.equal(pay.liveEnabled, false) // live executor gated
})

test('createPerp with mode:live is rejected (executor gated)', async () => {
  const out = await createPerp({ symbol: 'btc', cgId: 'bitcoin', side: 'long', leverage: 5, marginUsd: 50, mode: 'live' })
  assert.ok('error' in out && /not enabled yet/.test((out as any).error))
  assert.equal(state.perps!.length, 0)
})

test('trackPerps marks open positions, accrues funding, and closes on take-profit', async () => {
  const t0 = Date.now()
  await createPerp({ symbol: 'btc', cgId: 'bitcoin', side: 'long', leverage: 10, marginUsd: 100, takeProfit: 66000, stopLoss: 54000 })
  frames.length = 0

  setMark(63000) // in range → still open, funding accrues over ~1h elapsed
  await trackPerps(t0 + 3_600_000)
  assert.equal(state.perps![0].status, 'open')
  assert.ok(state.perps![0].fundingPaidUsd !== 0, 'funding accrued for the long')

  setMark(66000) // hits TP
  await trackPerps(t0 + 3_600_000 + 1_000)
  const p = state.perps![0]
  assert.equal(p.status, 'closed')
  assert.equal(p.closeReason, 'tp')
  assert.ok((p.realizedPnlUsd ?? 0) > 0)
  assert.ok(frames.some((f) => f.type === 'perp-update'), 'broadcast the close')
})

test('trackPerps liquidates a position when the mark hits the liq price', async () => {
  const out = await createPerp({ symbol: 'btc', cgId: 'bitcoin', side: 'long', leverage: 20, marginUsd: 100 })
  const liq = (out as any).position.liqPrice
  setMark(liq - 1) // gap below liquidation
  await trackPerps(Date.now())
  const p = state.perps![0]
  assert.equal(p.status, 'closed')
  assert.equal(p.closeReason, 'liquidated')
  assert.ok((p.realizedPnlUsd ?? 0) < 0, 'a liquidation is a loss')
})

test('closePerpById closes at the current mark; editPerpStops validates; dismiss removes a closed one', async () => {
  await createPerp({ symbol: 'btc', cgId: 'bitcoin', side: 'long', leverage: 5, marginUsd: 200 })
  const id = state.perps![0].id

  // edit stops — a wrong-side stop is rejected, a valid one sticks
  assert.ok('error' in editPerpStops(id, { stopLoss: 70000 })) // above entry for a long
  assert.ok('position' in editPerpStops(id, { stopLoss: 57000, takeProfit: 66000 }))
  assert.equal(state.perps![0].stopLoss, 57000)

  setMark(61000)
  const closed = await closePerpById(id)
  assert.ok('position' in closed)
  assert.equal(state.perps![0].status, 'closed')
  assert.equal(state.perps![0].closeReason, 'manual')

  assert.equal(dismissPerp(id), true)
  assert.equal(state.perps!.length, 0)
  assert.equal(dismissPerp('nope'), false)
})
