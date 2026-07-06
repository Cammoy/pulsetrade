// OHLC candles: parse + cache (CoinGecko mocked) and the /api/ohlc/:cg route (loopback, with
// days clamped + coin-id validation).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-ohlc-'))

const { getOhlc } = await import('../src/prices.js')
const { createApp } = await import('../src/app.js')

const R = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200 })
const OHLC = [
  [1_700_000_000_000, 100, 110, 95, 105],
  [1_700_003_600_000, 105, 120, 104, 118],
  [1_700_007_200_000, 118, 119, 90, 92],
]

// Intercept CoinGecko calls only; delegate the test's own loopback requests to the real server.
const realFetch = globalThis.fetch.bind(globalThis)
let cgHandler: (url: string) => Response = () => R(OHLC)
globalThis.fetch = ((url: any, init: any) => {
  const u = String(url)
  if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(url, init)
  return Promise.resolve(cgHandler(u))
}) as typeof fetch

test('getOhlc parses CoinGecko rows into {t,o,h,l,c} and caches them', async () => {
  let calls = 0
  cgHandler = (u) => {
    if (u.includes('/ohlc')) calls++
    return R(OHLC)
  }
  const a = await getOhlc('bitcoin', 7)
  assert.equal(a.length, 3)
  assert.deepEqual(a[0], { t: 1_700_000_000_000, o: 100, h: 110, l: 95, c: 105 })
  assert.equal(a[2].c, 92)
  const b = await getOhlc('bitcoin', 7) // cached within 5 min
  assert.equal(b.length, 3)
  assert.equal(calls, 1, 'second call served from cache')
})

test('getOhlc tolerates a malformed/empty payload (returns [])', async () => {
  cgHandler = () => R({ error: 'nope' })
  assert.deepEqual(await getOhlc('no-such-coin-xyz', 7), [])
})

let srv: Server, base: string
before(async () => {
  cgHandler = () => R(OHLC)
  const app = createApp(undefined)
  await new Promise<void>((resolve) => {
    srv = createServer(app)
    srv.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
      resolve()
    })
  })
})
after(() => srv?.close())

test('GET /api/ohlc/:cg returns candles + the clamped days; rejects a bad id', async () => {
  cgHandler = () => R(OHLC)
  const ok = await fetch(`${base}/api/ohlc/ethereum?days=14`).then((r) => r.json())
  assert.equal(ok.days, 14)
  assert.ok(Array.isArray(ok.candles) && ok.candles.length === 3)
  // an unsupported days value clamps to the 7-day default
  const clamped = await fetch(`${base}/api/ohlc/litecoin?days=999`).then((r) => r.json())
  assert.equal(clamped.days, 7)
  // a malformed coin id is rejected
  const bad = await fetch(`${base}/api/ohlc/Bad%20Id!`)
  assert.equal(bad.status, 400)
})
