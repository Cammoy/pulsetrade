// Manual holdings tracker: average-cost basis, unrealised + realised P/L, allocation,
// best/worst, and value-over-time reconstruction. CoinGecko (prices + market_chart)
// is mocked so the math is deterministic.
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-tracker-'))

const PRICES: Record<string, number> = { bitcoin: 100_000, ethereum: 2_000, solana: 150 }

const { state } = await import('../src/store.js')
const { addLot, addSell, editLot, removeLot, removeAsset, valueTracker, trackerHistory } = await import('../src/tracker.js')

before(() => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('simple/price')) return new Response(JSON.stringify(Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { usd: v }]))), { status: 200 })
    if (u.includes('market_chart')) {
      const id = u.match(/coins\/([^/]+)\/market_chart/)?.[1] ?? 'bitcoin'
      const base = PRICES[id] ?? 1
      const prices = Array.from({ length: 24 }, (_, i) => [1_700_000_000_000 + i * 3_600_000, base * (0.9 + i * 0.01)])
      return new Response(JSON.stringify({ prices }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

beforeEach(() => {
  state.tracker.length = 0
})

test('addLot creates the asset and averages cost across lots (fees included)', async () => {
  addLot({ cg: 'bitcoin', symbol: 'btc', name: 'Bitcoin', qty: 1, priceUsd: 50_000 })
  addLot({ cg: 'bitcoin', symbol: 'BTC', qty: 1, priceUsd: 70_000, feeUsd: 0 })
  const v = await valueTracker()
  const btc = v.assets.find((a) => a.cg === 'bitcoin')!
  assert.ok(btc, 'asset created on first lot')
  assert.equal(btc.qty, 2)
  assert.equal(btc.avgCostUsd, 60_000) // (50k + 70k) / 2
  assert.equal(btc.costBasisUsd, 120_000)
  assert.equal(btc.priceUsd, 100_000)
  assert.equal(btc.valueUsd, 200_000)
  assert.equal(btc.unrealizedPnlUsd, 80_000)
  assert.ok(Math.abs(btc.unrealizedPnlPct - 66.67) < 0.01)
})

test('a lot fee raises the average cost', async () => {
  addLot({ cg: 'solana', symbol: 'SOL', name: 'Solana', qty: 10, priceUsd: 100, feeUsd: 50 })
  const v = await valueTracker()
  const sol = v.assets.find((a) => a.cg === 'solana')!
  assert.equal(sol.avgCostUsd, 105) // (10*100 + 50) / 10
})

test('portfolio totals, allocation, and best/worst are correct', async () => {
  addLot({ cg: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', qty: 2, priceUsd: 60_000 }) // cost 120k, value 200k, +66.7%
  addLot({ cg: 'ethereum', symbol: 'ETH', name: 'Ethereum', qty: 10, priceUsd: 1_000 }) // cost 10k, value 20k, +100%
  const v = await valueTracker()
  assert.equal(v.totals.valueUsd, 220_000)
  assert.equal(v.totals.investedUsd, 130_000)
  assert.equal(v.totals.unrealizedPnlUsd, 90_000)
  const btc = v.assets.find((a) => a.cg === 'bitcoin')!
  const eth = v.assets.find((a) => a.cg === 'ethereum')!
  assert.ok(Math.abs(btc.allocationPct - 90.91) < 0.05)
  assert.ok(Math.abs(eth.allocationPct - 9.09) < 0.05)
  assert.equal(v.best!.symbol, 'ETH') // +100% beats +66.7%
  assert.equal(v.worst!.symbol, 'BTC')
})

test('addSell realises P/L against the average cost and is capped to the holding', async () => {
  addLot({ cg: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', qty: 2, priceUsd: 50_000 }) // avg 50k
  const okSell = addSell({ cg: 'bitcoin', qty: 1, priceUsd: 80_000 })
  assert.ok(!('error' in okSell))
  const v = await valueTracker()
  const btc = v.assets.find((a) => a.cg === 'bitcoin')!
  assert.equal(btc.qty, 1) // 2 bought − 1 sold
  assert.equal(btc.realizedPnlUsd, 30_000) // 1 × (80k − 50k)
  // can't sell more than held
  assert.ok('error' in addSell({ cg: 'bitcoin', qty: 5, priceUsd: 80_000 }))
})

test('addSell realises a LOSS and subtracts the sell fee', async () => {
  addLot({ cg: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', qty: 1, priceUsd: 100 })
  assert.ok(!('error' in addSell({ cg: 'bitcoin', qty: 1, priceUsd: 60, feeUsd: 5 })))
  const v = await valueTracker()
  const btc = v.assets.find((a) => a.cg === 'bitcoin')!
  assert.equal(btc.realizedPnlUsd, -45) // 1 × (60 − 100) − 5 fee
})

test('a sell fee can flip a marginal gain into a net realised loss', async () => {
  addLot({ cg: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', qty: 1, priceUsd: 100 })
  assert.ok(!('error' in addSell({ cg: 'bitcoin', qty: 1, priceUsd: 101, feeUsd: 5 })))
  const v = await valueTracker()
  const btc = v.assets.find((a) => a.cg === 'bitcoin')!
  assert.equal(btc.realizedPnlUsd, -4) // 1 × (101 − 100) − 5 fee → a $1 gain, but the $5 fee nets −$4
})

test('realised P/L is chronological — buying more AFTER a sale does not rewrite the sale', async () => {
  const t0 = 1_700_000_000_000
  addLot({ cg: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', qty: 1, priceUsd: 10_000, ts: t0 })
  assert.ok(!('error' in addSell({ cg: 'bitcoin', qty: 1, priceUsd: 20_000, ts: t0 + 1_000 }))) // realise +10k vs the $10k avg
  addLot({ cg: 'bitcoin', symbol: 'BTC', qty: 1, priceUsd: 30_000, ts: t0 + 2_000 }) // later, pricier buy
  const v = await valueTracker()
  const btc = v.assets.find((a) => a.cg === 'bitcoin')!
  assert.equal(btc.realizedPnlUsd, 10_000) // NOT rewritten to 0 by the later $30k lot
  assert.equal(btc.qty, 1)
  assert.equal(btc.avgCostUsd, 30_000) // only the remaining $30k lot
})

test('an unpriced asset does NOT book a phantom loss in the totals (reconciles with rows)', async () => {
  addLot({ cg: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', qty: 1, priceUsd: 50_000 }) // priced: value 100k, +50k
  addLot({ cg: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin', qty: 1000, priceUsd: 0.1 }) // NOT in the price stub → unpriced
  const v = await valueTracker()
  const btc = v.assets.find((a) => a.cg === 'bitcoin')!
  const doge = v.assets.find((a) => a.cg === 'dogecoin')!
  assert.equal(doge.priceUsd, null)
  assert.equal(doge.valueUsd, 0)
  assert.equal(doge.unrealizedPnlUsd, 0) // per-row P/L for an unpriced asset is 0
  // totals count ONLY priced cost basis → no phantom −$100 from the unpriced DOGE lot
  assert.equal(v.totals.investedUsd, 50_000)
  assert.equal(v.totals.unrealizedPnlUsd, btc.unrealizedPnlUsd) // +50k, matches the visible row
  // best/worst must rank ONLY priced assets — the unpriced DOGE (pct forced to 0) must never be
  // crowned best/worst at a phantom +0.00%; with BTC the only priced row, both are BTC.
  assert.equal(v.best?.symbol, 'BTC')
  assert.equal(v.worst?.symbol, 'BTC')
})

test('input validation rejects bad lots', () => {
  assert.ok('error' in addLot({ cg: '', symbol: 'X', qty: 1, priceUsd: 1 }))
  assert.ok('error' in addLot({ cg: 'bitcoin', symbol: '', qty: 1, priceUsd: 1 }))
  assert.ok('error' in addLot({ cg: 'bitcoin', symbol: 'BTC', qty: 0, priceUsd: 1 }))
  assert.ok('error' in addLot({ cg: 'bitcoin', symbol: 'BTC', qty: 1, priceUsd: -5 }))
  assert.equal(state.tracker.length, 0)
})

test('removeLot prunes the asset when its last lot is gone; removeAsset clears it', async () => {
  const a = addLot({ cg: 'solana', symbol: 'SOL', name: 'Solana', qty: 1, priceUsd: 100 })
  assert.ok(!('error' in a))
  const lotId = (a as Exclude<typeof a, { error: string }>).lots[0].id
  assert.ok(removeLot(lotId))
  assert.equal(state.tracker.length, 0, 'asset pruned when no lots remain')

  addLot({ cg: 'ethereum', symbol: 'ETH', name: 'Ethereum', qty: 1, priceUsd: 1_000 })
  const id = state.tracker[0].id
  assert.ok(removeAsset(id))
  assert.equal(state.tracker.length, 0)
})

test('editLot updates fields and re-prices', async () => {
  const a = addLot({ cg: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', qty: 1, priceUsd: 50_000 })
  const lotId = (a as Exclude<typeof a, { error: string }>).lots[0].id
  assert.ok(!('error' in editLot(lotId, { qty: 2, priceUsd: 40_000 })))
  const v = await valueTracker()
  const btc = v.assets.find((a) => a.cg === 'bitcoin')!
  assert.equal(btc.qty, 2)
  assert.equal(btc.avgCostUsd, 40_000)
})

test('trackerHistory reconstructs Σ(qty × historical price) on a unified axis', async () => {
  addLot({ cg: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', qty: 2, priceUsd: 50_000 })
  addLot({ cg: 'ethereum', symbol: 'ETH', name: 'Ethereum', qty: 10, priceUsd: 1_000 })
  const series = await trackerHistory(7)
  assert.ok(series.length > 0, 'has data points')
  // Each point = 2×btc_price + 10×eth_price at that time; all positive and increasing.
  assert.ok(series.every((p) => p.v > 0))
  assert.ok(series[series.length - 1].v > series[0].v, 'rising prices → rising portfolio value')
})
