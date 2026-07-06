// Earn yields: the pure filter/rank shortlist + the cached fetch (DefiLlama mocked).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-earn-'))

const { rankYields, getYields, __resetYields } = await import('../src/earn.js')
type RawPool = import('../src/earn.js').RawPool

const pool = (o: Partial<RawPool>): RawPool => ({
  chain: 'Ethereum', project: 'aave-v3', symbol: 'USDC', tvlUsd: 50_000_000, apy: 5, apyBase: 5, apyReward: 0,
  stablecoin: true, ilRisk: 'no', exposure: 'single', pool: 'id-' + (o.symbol ?? 'x'), ...o,
})

// ── rankYields (pure) ──────────────────────────────────────────────────────────

test('rankYields keeps safe stable pools, sorted by APY desc', () => {
  const out = rankYields([
    pool({ symbol: 'USDC', apy: 4 }),
    pool({ symbol: 'USDT', apy: 8 }),
    pool({ symbol: 'DAI', apy: 6 }),
  ])
  assert.deepEqual(out.map((p) => p.symbol), ['USDT', 'DAI', 'USDC'])
  assert.equal(out[0].apy, 8)
  assert.equal(out[0].project, 'aave-v3')
})

test('rankYields drops non-stable, IL-risk, multi-asset, low-TVL, absurd-APY and unsupported chains', () => {
  const out = rankYields([
    pool({ symbol: 'GOOD', apy: 5 }),
    pool({ symbol: 'NOTSTABLE', stablecoin: false, apy: 9 }),
    pool({ symbol: 'ILPOOL', ilRisk: 'yes', apy: 20 }),
    pool({ symbol: 'LP', exposure: 'multi', apy: 15 }),
    pool({ symbol: 'THIN', tvlUsd: 100_000, apy: 30 }),
    pool({ symbol: 'ABSURD', apy: 5000 }),
    pool({ symbol: 'ZERO', apy: 0 }),
    pool({ symbol: 'OFFCHAIN', chain: 'Fantom', apy: 12 }),
  ])
  assert.deepEqual(out.map((p) => p.symbol), ['GOOD'])
})

test('rankYields honours limit + custom thresholds, and coerces bad numbers', () => {
  const many = Array.from({ length: 30 }, (_, i) => pool({ symbol: `S${i}`, apy: i + 1 }))
  assert.equal(rankYields(many, { limit: 5 }).length, 5)
  // a pool with a NaN apy / tvl is dropped, not crashed on
  const out = rankYields([pool({ symbol: 'NAN', apy: NaN }), pool({ symbol: 'OK', apy: 7 })])
  assert.deepEqual(out.map((p) => p.symbol), ['OK'])
  // higher minTvl filters the default 50M pool out
  assert.equal(rankYields([pool({ symbol: 'X', tvlUsd: 6_000_000 })], { minTvlUsd: 10_000_000 }).length, 0)
})

// ── getYields (cached fetch) ─────────────────────────────────────────────────

beforeEach(() => __resetYields())

test('getYields fetches + ranks DefiLlama, then serves cache (no refetch)', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify({ data: [pool({ symbol: 'USDC', apy: 5 }), pool({ symbol: 'USDT', apy: 9 })] }), { status: 200 })
  }) as typeof fetch
  const a = await getYields()
  assert.equal(a.pools[0].symbol, 'USDT')
  assert.equal(a.error, null)
  assert.ok(a.at && a.at > 0)
  const b = await getYields() // within TTL → cached
  assert.equal(b.pools.length, a.pools.length)
  assert.equal(calls, 1, 'served from cache, no second fetch')
})

test('getYields returns an empty list + error on a cold failure (never throws)', async () => {
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
  const out = await getYields()
  assert.deepEqual(out.pools, [])
  assert.ok(out.error)
})
