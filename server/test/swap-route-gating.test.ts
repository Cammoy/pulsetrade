// Cross-chain swap ROUTE gating — the "no false positives" wall. A bridge execute
// must refuse unless the SOURCE chain can sign AND the DESTINATION chain has a wallet
// to receive into. Drives the REAL Express app over loopback; every check returns 400
// BEFORE any executor runs, so no chain / LI.FI is ever touched.
import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Express } from 'express'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-swapgate-'))
const SIGNER_KEYS = ['ZEROX_API_KEY', 'BOT_WALLET_KEY', 'SOLANA_WALLET_KEY', 'TURNKEY_API_PUBLIC_KEY', 'TURNKEY_API_PRIVATE_KEY', 'TURNKEY_ORGANIZATION_ID', 'TURNKEY_EVM_ADDRESS', 'TURNKEY_SOLANA_ADDRESS']
for (const k of SIGNER_KEYS) delete process.env[k]

const { createApp } = await import('../src/app.js')

// A valid throwaway EVM private key (NOT funded) — arms liveReady() for the EVM source.
const EVM_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const TOKEN = 'secret-token-abcdefghijklmnop'
let srv: Server, base = ''

const post = (body: unknown) =>
  fetch(base + '/api/swap/execute', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })

before(async () => {
  srv = createServer(createApp(TOKEN))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})
after(() => srv.close())
afterEach(() => { for (const k of SIGNER_KEYS) delete process.env[k] })

const armEvm = () => { process.env.ZEROX_API_KEY = 'zx'; process.env.BOT_WALLET_KEY = EVM_KEY }

test('EVM→Solana bridge is REFUSED when the EVM source has no signer (fail-closed source)', async () => {
  // nothing armed
  const r = await post({ network: 'base', toNetwork: 'solana', sellToken: 'native', buyToken: 'native', sellAmount: '1000000' })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /source/i, 'rejected on the unsigned source, not the executor')
})

test('EVM→Solana bridge is REFUSED when the source signs but there is NO Solana wallet to receive (the false-positive guard)', async () => {
  armEvm() // EVM source can sign…
  // …but SOLANA_WALLET_KEY is unset → no destination wallet → must refuse, never bridge into the void
  const r = await post({ network: 'base', toNetwork: 'solana', sellToken: 'native', buyToken: 'native', sellAmount: '1000000' })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /receive|wallet/i, 'refused: no Solana wallet to receive the bridged funds')
})

test('Solana→EVM bridge is REFUSED when the Solana source has no signer (fail-closed source)', async () => {
  armEvm() // EVM dest wallet exists, but the SOLANA SOURCE cannot sign
  const r = await post({ network: 'solana', toNetwork: 'base', sellToken: 'native', buyToken: 'native', sellAmount: '1000000' })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /solana source|source/i, 'refused: the Solana source has no signer')
})

test('an unknown destination network is rejected', async () => {
  armEvm()
  const r = await post({ network: 'base', toNetwork: 'not-a-chain', sellToken: 'native', buyToken: 'native', sellAmount: '1000000' })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /unknown destination/i)
})

test('a cross-chain execute still requires the auth token (mutating route)', async () => {
  armEvm()
  const r = await fetch(base + '/api/swap/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: 'base', toNetwork: 'solana', sellToken: 'native', buyToken: 'native', sellAmount: '1000000' }) })
  assert.equal(r.status, 401)
})
