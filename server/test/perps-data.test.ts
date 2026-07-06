// Hyperliquid mark/funding fetch + CoinGecko fallback, with fetch mocked.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-perpsdata-'))

const { refreshPerpMarkets, perpMark, perpFunding, isPerpListed, markPriceFor, fundingFor, __resetPerpMarkets } = await import('../src/perps-data.js')
const { getSpotPrices, __test: prices } = await import('../src/prices.js')

const R = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200 })
// A FRESH Response per call — a Response body can only be read once.
const hlOk = () =>
  R([
    { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
    [{ markPx: '61000.5', funding: '0.0000125' }, { markPx: '3000.0', funding: '-0.00002' }],
  ])

beforeEach(() => __resetPerpMarkets())

test('refreshPerpMarkets parses the Hyperliquid snapshot into mark + funding', async () => {
  globalThis.fetch = (async (url: any) => (String(url).includes('hyperliquid') ? hlOk() : R({}))) as typeof fetch
  await refreshPerpMarkets()
  assert.equal(perpMark('BTC'), 61000.5)
  assert.equal(perpMark('eth'), 3000) // case-insensitive
  assert.equal(perpFunding('BTC'), 0.0000125)
  assert.equal(perpFunding('ETH'), -0.00002)
  assert.equal(isPerpListed('BTC'), true)
  assert.equal(isPerpListed('DOGE'), false)
})

test('markPriceFor uses the HL perp mark when listed', async () => {
  globalThis.fetch = (async (url: any) => (String(url).includes('hyperliquid') ? hlOk() : R({}))) as typeof fetch
  await refreshPerpMarkets()
  assert.equal(markPriceFor('BTC', 'bitcoin'), 61000.5)
  assert.equal(fundingFor('BTC'), 0.0000125)
})

test('markPriceFor falls back to the CoinGecko spot price for an unlisted coin (funding 0)', async () => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('hyperliquid')) return hlOk()
    if (u.includes('simple/price')) return R({ dogecoin: { usd: 0.42 } })
    return R({})
  }) as typeof fetch
  await refreshPerpMarkets()
  prices.expireSpot()
  await getSpotPrices(['dogecoin']) // seed the spot cache
  assert.equal(isPerpListed('DOGE'), false)
  assert.equal(markPriceFor('DOGE', 'dogecoin'), 0.42) // spot fallback
  assert.equal(fundingFor('DOGE'), 0) // no funding on a spot-priced fallback
})

test('a failed Hyperliquid fetch leaves the cache empty (no throw), so callers fall back', async () => {
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
  await refreshPerpMarkets()
  assert.equal(perpMark('BTC'), undefined)
  assert.equal(isPerpListed('BTC'), false)
})
