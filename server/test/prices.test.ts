// H2 (MKT-1): the price-staleness safety layer is what stops the engine sizing
// trades or running stop-loss/take-profit off a frozen/absent price. A flipped
// comparison or a dropped 429 backoff here would pass every other test, so drive
// the REAL module with a stubbed fetch and a controllable clock.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const realDateNow = Date.now
const realFetch = globalThis.fetch
let clock = 1_000_000_000_000
let fetchImpl: (url: string) => Promise<Response> = async () => new Response('{}', { status: 200 })

const prices = await import('../src/prices.js')

before(() => {
  Date.now = () => clock
  globalThis.fetch = (async (url: any) => fetchImpl(String(url))) as typeof fetch
})
after(() => {
  Date.now = realDateNow
  globalThis.fetch = realFetch
})

// ── Spot price staleness + 429 backoff ───────────────────────────────────────

test('spotStale() is true before any successful fetch (never traded on an empty cache)', () => {
  assert.equal(prices.spotStale(), true)
})

test('getSpotPrices fills the cache and clears staleness', async () => {
  fetchImpl = async () => new Response(JSON.stringify({ ethereum: { usd: 2000 }, chainlink: { usd: 10 } }), { status: 200 })
  const m = await prices.getSpotPrices(['ethereum', 'chainlink'])
  assert.equal(m.get('ethereum'), 2000)
  assert.equal(prices.spot('chainlink'), 10)
  assert.equal(prices.spotStale(), false, 'fresh right after a successful fetch')
})

test('spotStale() flips back to true once the price ages past the 120s ceiling', () => {
  clock += 121_000
  assert.equal(prices.spotStale(), true)
})

test('a 429 sets a backoff and short-circuits further fetches (no hammering)', async () => {
  fetchImpl = async () => new Response('rate limited', { status: 429 })
  const m = await prices.getSpotPrices(['ethereum', 'chainlink'])
  assert.equal(m.get('ethereum'), 2000, 'serves the last-known cache during backoff')
  assert.ok(prices.backoffRemainingMs() > 0, 'backoff armed')

  // While backed off, cgFetch must NOT touch the network again.
  let called = false
  fetchImpl = async () => {
    called = true
    throw new Error('fetch should not be called during backoff')
  }
  await prices.getSpotPrices(['ethereum', 'chainlink'])
  assert.equal(called, false, 'fetch short-circuited by the backoff window')
})

// ── Pool pricing freshness (sniped tokens) ───────────────────────────────────

test('poolPriceFresh is undefined until a fresh fetch, then serves it, then expires at 90s', async () => {
  const slug = 'eth'
  const pool = '0xPOOL'
  assert.equal(prices.poolPriceFresh(slug, pool), undefined, 'no price before any fetch')

  fetchImpl = async () => new Response(JSON.stringify({ data: { attributes: { base_token_price_usd: '5' } } }), { status: 200 })
  const p = await prices.refreshPoolPrice(slug, pool)
  assert.equal(p, 5)
  assert.equal(prices.poolPriceFresh(slug, pool), 5, 'fresh price is served')

  clock += 91_000 // past POOL_STALE_MS (90s)
  assert.equal(prices.poolPriceFresh(slug, pool), undefined, 'expired — caller must skip the tick')
  assert.equal(prices.poolPrice(slug, pool), 5, 'the raw last-known is still cached (just not fresh)')
})

test('refreshPoolPrice keeps the last-known price on a non-OK response or a non-positive price', async () => {
  const slug = 'eth'
  const pool = '0xPOOL' // already cached at 5 above

  fetchImpl = async () => new Response('err', { status: 503 })
  assert.equal(await prices.refreshPoolPrice(slug, pool), 5, 'non-OK → last known, never undefined')

  fetchImpl = async () => new Response(JSON.stringify({ data: { attributes: { base_token_price_usd: '0' } } }), { status: 200 })
  assert.equal(await prices.refreshPoolPrice(slug, pool), 5, 'a 0/negative price is rejected, last known kept')
  assert.equal(prices.poolPriceFresh(slug, pool), undefined, 'a rejected refresh does not revive freshness')
})

// ── Candle cache ─────────────────────────────────────────────────────────────

test('getCandles caches for 5 minutes and returns [] when there is nothing to serve', async () => {
  fetchImpl = async () => new Response(JSON.stringify({ prices: [[1, 100], [2, 101]] }), { status: 200 })
  const c = await prices.getCandles('ethereum', 7)
  assert.deepEqual(c, [{ t: 1, c: 100 }, { t: 2, c: 101 }])

  // Within the 5-min window the cache is served without touching the network.
  fetchImpl = async () => {
    throw new Error('should be served from cache')
  }
  const c2 = await prices.getCandles('ethereum', 7)
  assert.deepEqual(c2, c, 'served from cache')

  // A brand-new id with a failing fetch and no cache yields an empty series.
  fetchImpl = async () => new Response('err', { status: 500 })
  assert.deepEqual(await prices.getCandles('never-seen-coin', 7), [], 'no cache + failure → empty, never throws')
})

// ── #4: per-id spot freshness (a coin CoinGecko drops must not stay frozen-fresh) ──
test('spotFresh: a coin dropped from the next batch goes per-id STALE while the majors keep the global fresh', async () => {
  clock += 10_000_000 // clear any lingering 429 backoff from earlier tests
  fetchImpl = async () => new Response(JSON.stringify({ ethereum: { usd: 3000 }, 'delist-me': { usd: 7 } }), { status: 200 })
  await prices.getSpotPrices(['ethereum', 'delist-me'])
  assert.equal(prices.spotFresh('delist-me'), 7, 'fresh right after its own batch')
  // Age past the 120s per-id ceiling, then a batch that OMITS delist-me (CoinGecko dropped it).
  clock += 121_000
  fetchImpl = async () => new Response(JSON.stringify({ ethereum: { usd: 3100 } }), { status: 200 })
  await prices.getSpotPrices(['ethereum', 'delist-me'])
  assert.equal(prices.spotStale(), false, 'global staleness is held fresh by ethereum')
  assert.equal(prices.spotFresh('ethereum'), 3100, 'a refreshed major is fresh')
  assert.equal(prices.spotFresh('delist-me'), undefined, 'the dropped coin is per-id STALE — engine SL/TP must not run off a frozen price')
  assert.equal(prices.spot('delist-me'), 7, 'raw cache still holds the last value; spotFresh is the gate')
})
