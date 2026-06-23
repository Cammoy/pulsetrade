// True realized P&L via on-chain cost-basis reconstruction (average-cost, historical pricing).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-rpnl-'))

const { realizedFromLots, computeRealizedPnl } = await import('../src/smartmoney.js')
const { priceAt } = await import('../src/prices.js')

const NOW = 1_750_000_000_000
const D = 86_400_000

// ── priceAt (pure) ───────────────────────────────────────────────────────────
test('priceAt: nearest daily close; null when empty or older than the window', () => {
  assert.equal(priceAt([], NOW), null)
  const s = [{ t: NOW - 30 * D, c: 1 }, { t: NOW - 15 * D, c: 2 }, { t: NOW, c: 3 }]
  assert.equal(priceAt(s, NOW - 30 * D), 1)
  assert.equal(priceAt(s, NOW), 3)
  assert.equal(priceAt(s, NOW - 16 * D), 2) // nearest to the 15d-ago point
  assert.equal(priceAt(s, NOW - 60 * D), null) // predates our history → don't guess
})

// ── realizedFromLots (pure) ──────────────────────────────────────────────────
test('realizedFromLots: average-cost realized P&L on matched lots', () => {
  const r = realizedFromLots([{ side: 'buy', qty: 10, px: 1, ts: 1 }, { side: 'sell', qty: 10, px: 3, ts: 2 }])
  assert.equal(r.realizedUsd, 20) // 10 × (3 − 1)
  assert.equal(r.matchedSells, 1)
  assert.equal(r.wins, 1)
})

test('realizedFromLots: losses counted; partial sells use the running average cost', () => {
  const loss = realizedFromLots([{ side: 'buy', qty: 10, px: 5, ts: 1 }, { side: 'sell', qty: 10, px: 2, ts: 2 }])
  assert.equal(loss.realizedUsd, -30)
  assert.equal(loss.losses, 1)
  // buy 10@1 then 10@3 (avg 2), sell 10@4 → 10 × (4 − 2) = 20
  const partial = realizedFromLots([{ side: 'buy', qty: 10, px: 1, ts: 1 }, { side: 'buy', qty: 10, px: 3, ts: 2 }, { side: 'sell', qty: 10, px: 4, ts: 3 }])
  assert.equal(partial.realizedUsd, 20)
})

test('realizedFromLots: an orphan sell (no observed prior buy) is excluded', () => {
  const r = realizedFromLots([{ side: 'sell', qty: 5, px: 100, ts: 1 }, { side: 'buy', qty: 5, px: 1, ts: 2 }, { side: 'sell', qty: 5, px: 2, ts: 3 }])
  assert.equal(r.realizedUsd, 5) // first sell has no basis → skipped; then 5 × (2 − 1)
  assert.equal(r.matchedSells, 1)
})

// ── computeRealizedPnl (historical fetch mocked) ─────────────────────────────
const evt = (token: string, side: 'buy' | 'sell', qty: number, ts: number, curated = true) =>
  ({ wallet: '0x', label: 'W', network: 'base', token, tokenAddress: '0x', side, qty, usd: null, ts, txHash: `0x${token}${side}${ts}`, curated })

test('computeRealizedPnl: reconstructs P&L by re-pricing transfers at historical prices', async () => {
  globalThis.fetch = (async (url: any) =>
    String(url).includes('market_chart')
      ? new Response(JSON.stringify({ prices: [[NOW - 30 * D, 1], [NOW - 15 * D, 2], [NOW, 3]] }), { status: 200 })
      : new Response('{}', { status: 200 })) as typeof fetch
  const out = await computeRealizedPnl([evt('AERO', 'buy', 10, NOW - 30 * D), evt('AERO', 'sell', 10, NOW)])
  assert.equal(out.pricedTokens, 1)
  assert.equal(out.roundTrips, 1)
  assert.ok(Math.abs(out.realizedUsd - 20) < 0.01, `realized ${out.realizedUsd}`) // bought @ $1, sold @ $3
  assert.equal(out.wins, 1)
})

test('computeRealizedPnl: an unlisted token is reported unpriced, never counted as profit', async () => {
  const out = await computeRealizedPnl([evt('NOTACOIN', 'buy', 1, NOW, false), evt('NOTACOIN', 'sell', 1, NOW, false)])
  assert.equal(out.pricedTokens, 0)
  assert.equal(out.unpricedTokens, 1)
  assert.equal(out.realizedUsd, 0)
})

test('computeRealizedPnl: a token never sold contributes nothing (no closed position)', async () => {
  const out = await computeRealizedPnl([evt('AERO', 'buy', 10, NOW)])
  assert.equal(out.roundTrips, 0)
  assert.equal(out.realizedUsd, 0)
})
