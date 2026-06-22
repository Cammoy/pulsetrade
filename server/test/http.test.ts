// H7 (SRV-1): the HTTP surface is the wall between a caller and real money — its
// auth gate, status-code wiring, and boot guards must be tested directly. Drives
// the REAL Express app (createApp) over an ephemeral loopback server, plus pure
// unit tests of the boot guards. No engine, no socket, no real port exposure.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Express } from 'express'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-http-'))
// No live signer configured → /api/mode live must 400, and nothing arms live.
for (const k of ['ZEROX_API_KEY', 'BOT_WALLET_KEY', 'SOLANA_WALLET_KEY', 'TURNKEY_API_PUBLIC_KEY', 'TURNKEY_API_PRIVATE_KEY', 'TURNKEY_ORGANIZATION_ID', 'TURNKEY_EVM_ADDRESS', 'TURNKEY_SOLANA_ADDRESS'])
  delete process.env[k]

const { createApp, tokenOk, shouldDowngradeLiveOnBoot, liveArmedButNoToken, invalidCapEnv } = await import('../src/app.js')

const TOKEN = 'secret-token-abcdefghijklmnop'
let authedSrv: Server, openSrv: Server
let authed = '', open = ''

function listen(app: Express): Promise<{ srv: Server; base: string }> {
  return new Promise((resolve) => {
    const srv = createServer(app)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      resolve({ srv, base: `http://127.0.0.1:${port}` })
    })
  })
}

before(async () => {
  const a = await listen(createApp(TOKEN))
  authedSrv = a.srv
  authed = a.base
  const o = await listen(createApp(undefined))
  openSrv = o.srv
  open = o.base
})
after(() => {
  authedSrv.close()
  openSrv.close()
})

// ── Auth gate ────────────────────────────────────────────────────────────────

test('GET reads are open even on an authed engine (no token required)', async () => {
  for (const p of ['/api/meta', '/api/state']) {
    const r = await fetch(authed + p)
    assert.equal(r.status, 200, `${p} readable without a token`)
  }
})

test('a mutating request without a token is rejected 401', async () => {
  const r = await fetch(authed + '/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'paper' }) })
  assert.equal(r.status, 401)
  assert.deepEqual(await r.json(), { error: 'unauthorized' })
})

test('a mutating request with the WRONG token is rejected 401', async () => {
  const r = await fetch(authed + '/api/mode', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-token' }, body: JSON.stringify({ mode: 'paper' }) })
  assert.equal(r.status, 401)
})

test('a wrong-LENGTH token is rejected 401 (length guard, no timingSafeEqual throw)', async () => {
  const r = await fetch(authed + '/api/mode', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer short' }, body: JSON.stringify({ mode: 'paper' }) })
  assert.equal(r.status, 401)
})

test('the correct token via Authorization: Bearer is accepted', async () => {
  const r = await fetch(authed + '/api/mode', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ mode: 'paper' }) })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { mode: 'paper' })
})

test('the correct token via x-engine-token is also accepted', async () => {
  const r = await fetch(authed + '/api/mode', { method: 'POST', headers: { 'content-type': 'application/json', 'x-engine-token': TOKEN }, body: JSON.stringify({ mode: 'paper' }) })
  assert.equal(r.status, 200)
})

test('with NO engine token configured, mutations pass without auth (local-dev mode)', async () => {
  const r = await fetch(open + '/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'paper' }) })
  assert.equal(r.status, 200)
})

// ── /health probe (P1-14) ────────────────────────────────────────────────────

test('GET /health is an open probe returning the operational snapshot', async () => {
  const r = await fetch(open + '/health')
  // No engine started in this harness → no tick has landed → degraded (503), which is
  // the correct signal for an uptime check (a dead engine must NOT read healthy).
  assert.equal(r.status, 503)
  const h = await r.json()
  assert.equal(h.mode, 'paper')
  assert.equal(typeof h.tickAgeMs, 'number')
  assert.ok(h.bots && typeof h.bots.total === 'number' && typeof h.bots.live === 'number')
  assert.ok(h.live && 'spentTodayUsd' in h.live && 'breaker' in h.live)
  assert.ok(Array.isArray(h.providers))
  assert.ok('tradeDbReady' in h && 'alerting' in h)
})

// ── Status-code wiring ───────────────────────────────────────────────────────

test('POST /api/mode with a bad mode → 400 bad mode', async () => {
  const r = await fetch(authed + '/api/mode', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ mode: 'moon' }) })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'bad mode' })
})

test('POST /api/mode live with no signer configured → 400 (cannot arm live blind)', async () => {
  const r = await fetch(authed + '/api/mode', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ mode: 'live' }) })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /Live mode needs a signer/)
})

test('POST /api/bots/:id/:action with a bad action → 400 bad action', async () => {
  const r = await fetch(authed + '/api/bots/whatever/frobnicate', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'bad action' })
})

test('POST /api/bots/:id/archive reaches the archive handler (404 not-found), NOT the bad-action route', async () => {
  // The specific /archive route must be registered before the generic /:action route,
  // or 'archive' is captured as an action and rejected as "bad action".
  const r = await fetch(authed + '/api/bots/whatever/archive', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) })
  assert.equal(r.status, 404) // unknown bot id → not found (proves the route resolved to archiveBot)
  assert.deepEqual(await r.json(), { error: 'not found' })
})

test('an unknown /api route → JSON 404 (never an HTML page the client cannot parse)', async () => {
  const r = await fetch(authed + '/api/does-not-exist')
  assert.equal(r.status, 404)
  assert.deepEqual(await r.json(), { error: 'not found' })
})

test('a malformed JSON body is reported as a 400 client error (not a 500 server fault)', async () => {
  const r = await fetch(open + '/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not valid json' })
  assert.equal(r.status, 400, "a client's bad body must not page on-call as a 500")
  assert.deepEqual(await r.json(), { error: 'bad request' })
})

// ── P2-2: cross-origin mutation rejected server-side (CSRF defense) ───────────

test('P2-2: a cross-origin mutation is rejected 403 (even with no engine token)', async () => {
  const r = await fetch(open + '/api/mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ mode: 'paper' }),
  })
  assert.equal(r.status, 403)
  assert.deepEqual(await r.json(), { error: 'cross-origin request blocked' })
})

test('P2-2: a same-origin mutation and an origin-less caller still pass', async () => {
  const same = await fetch(open + '/api/mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ mode: 'paper' }),
  })
  assert.equal(same.status, 200, 'same-machine browser origin allowed')
  const curl = await fetch(open + '/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'paper' }) })
  assert.equal(curl.status, 200, 'origin-less (curl/server) allowed — token gates it when set')
})

// ── P2-3: route-param validation (block injection into outbound URLs) ─────────

test('P2-3: route params interpolated into upstream URLs are validated (bad → 400, no upstream call)', async () => {
  const cases = [
    '/api/coin/bad$id',
    '/api/candles/bad$id',
    '/api/smart-money/wallet/0xnotavalidaddress',
    '/api/wallet/zzz',
  ]
  for (const p of cases) {
    const r = await fetch(open + p)
    assert.equal(r.status, 400, `${p} → 400 (rejected before any upstream fetch)`)
  }
})

// ── Pure boot guards ─────────────────────────────────────────────────────────

test('P2-12: invalidCapEnv rejects a malformed safety-cap env, accepts unset/valid', () => {
  assert.equal(invalidCapEnv({}), null, 'all unset → ok (defaults apply)')
  assert.equal(invalidCapEnv({ MAX_LIVE_USD_PER_DAY: '50', MAX_LIVE_USD_TOTAL: '150' }), null, 'valid numbers → ok')
  assert.match(invalidCapEnv({ MAX_LIVE_USD_PER_DAY: 'abc' }) ?? '', /MAX_LIVE_USD_PER_DAY/, 'NaN → rejected (would silently parse to 0 = unlimited)')
  assert.match(invalidCapEnv({ MAX_LIVE_USD_TOTAL: '-5' }) ?? '', /MAX_LIVE_USD_TOTAL/, 'negative → rejected')
})

test('tokenOk: matches the exact token, rejects everything else in constant time', () => {
  assert.equal(tokenOk(TOKEN, TOKEN), true)
  assert.equal(tokenOk('wrong-but-same-length-padxxxxxx'.slice(0, TOKEN.length), TOKEN), false)
  assert.equal(tokenOk('short', TOKEN), false, 'length mismatch → false (no throw)')
  assert.equal(tokenOk(undefined, TOKEN), false, 'missing provided → false')
  assert.equal(tokenOk(TOKEN, undefined), false, 'no engine token → false (auth disabled handled upstream)')
  assert.equal(tokenOk('', ''), false, 'empty/empty → false')
})

test('shouldDowngradeLiveOnBoot: persisted live downgrades unless RESUME_LIVE_ON_BOOT=true', () => {
  assert.equal(shouldDowngradeLiveOnBoot('live', undefined), true)
  assert.equal(shouldDowngradeLiveOnBoot('live', 'false'), true)
  assert.equal(shouldDowngradeLiveOnBoot('live', 'true'), false, 'explicit opt-in keeps live')
  assert.equal(shouldDowngradeLiveOnBoot('paper', undefined), false, 'paper never downgrades')
})

test('liveArmedButNoToken: refuses boot only when live keys are present AND no token', () => {
  assert.equal(liveArmedButNoToken(true, undefined), true, 'armed + no token → refuse boot')
  assert.equal(liveArmedButNoToken(true, ''), true, 'empty token counts as no token')
  assert.equal(liveArmedButNoToken(true, 'tok'), false, 'armed + token → ok')
  assert.equal(liveArmedButNoToken(false, undefined), false, 'paper-only + no token → ok (dev)')
})
