// E2E: the new copy-trading + icon HTTP routes over the REAL Express app (createApp) on an
// ephemeral loopback server — the wall between a caller and the engine. Covers reachability,
// response shape, the icon allowlist, and the route-ordering that keeps /:network from shadowing
// /leaderboard + /discover (a regression a unit test would never catch).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Express } from 'express'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-routes-'))
delete process.env.ETHERSCAN_API_KEY // leaderboard → needsKey; discover → no background crawl

const { createApp } = await import('../src/app.js')

const realFetch = globalThis.fetch
let srv: Server
let base = ''

function listen(app: Express): Promise<{ srv: Server; base: string }> {
  return new Promise((resolve) => {
    const s = createServer(app)
    s.listen(0, '127.0.0.1', () => resolve({ srv: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }))
  })
}

before(async () => {
  const a = await listen(createApp(undefined))
  srv = a.srv
  base = a.base
  // Loopback requests hit the real server; only the icon proxy's UPSTREAM fetch is stubbed.
  globalThis.fetch = (async (url: any, opts?: any) => {
    const u = String(url)
    if (u.startsWith('http://127.0.0.1') || u.includes('localhost')) return realFetch(url, opts)
    if (u.includes('coingecko')) return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } })
    return realFetch(url, opts)
  }) as typeof fetch
})
after(() => {
  globalThis.fetch = realFetch
  srv.close()
})

test('GET /api/smart-money/leaderboard is reachable and reports needsKey without a key', async () => {
  const r = await fetch(base + '/api/smart-money/leaderboard')
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.equal(d.needsKey, true)
  assert.ok(Array.isArray(d.rows))
})

test('GET /api/smart-money/discover returns the discovery envelope', async () => {
  const r = await fetch(base + '/api/smart-money/discover')
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.ok(Array.isArray(d.traders))
  assert.equal(typeof d.discovering, 'boolean')
})

test('the /:network feed is NOT shadowed by leaderboard/discover (route ordering)', async () => {
  const r = await fetch(base + '/api/smart-money/base')
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.ok(Array.isArray(d.events), 'returns the feed shape, not the leaderboard/discover shape')
  assert.ok(!('rows' in d) && !('traders' in d))
})

test('GET /api/icon serves an allowlisted image (long cache) and rejects everything else', async () => {
  const ok = await fetch(base + '/api/icon?u=' + encodeURIComponent('https://assets.coingecko.com/coins/images/1/small/bitcoin.png'))
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type') || '', /^image\//)
  assert.match(ok.headers.get('cache-control') || '', /max-age=604800/)
  assert.equal((await fetch(base + '/api/icon?u=' + encodeURIComponent('https://evil.example/x.png'))).status, 400)
  assert.equal((await fetch(base + '/api/icon')).status, 400)
})
