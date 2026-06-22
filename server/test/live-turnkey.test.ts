// Turnkey signer GATING — verifies a Turnkey wallet arms live trading without a
// raw private key in .env. Pure env-read checks (no network / no Turnkey SDK
// loaded; the SDK is only dynamically imported when an actual signature is made).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const tk = await import('../src/live-turnkey.js')
const { liveReady, botWalletAddress } = await import('../src/live.js')
const { solanaLiveReady, solanaWalletAddress } = await import('../src/live-solana.js')

const KEYS = [
  'ZEROX_API_KEY', 'BOT_WALLET_KEY', 'SOLANA_WALLET_KEY',
  'TURNKEY_API_PUBLIC_KEY', 'TURNKEY_API_PRIVATE_KEY', 'TURNKEY_ORGANIZATION_ID',
  'TURNKEY_EVM_ADDRESS', 'TURNKEY_SOLANA_ADDRESS',
]
beforeEach(() => { for (const k of KEYS) delete process.env[k] })

const setTurnkeyCreds = () => {
  process.env.TURNKEY_API_PUBLIC_KEY = 'pub'
  process.env.TURNKEY_API_PRIVATE_KEY = 'priv'
  process.env.TURNKEY_ORGANIZATION_ID = 'org-123'
}

test('readiness gating: configured needs all three creds; EVM/Solana need an address', () => {
  assert.equal(tk.turnkeyConfigured(), false)
  setTurnkeyCreds()
  assert.equal(tk.turnkeyConfigured(), true)
  assert.equal(tk.turnkeyEvmReady(), false, 'no EVM address yet')
  assert.equal(tk.turnkeySolReady(), false, 'no Solana address yet')
  process.env.TURNKEY_EVM_ADDRESS = '0x1111111111111111111111111111111111111111'
  process.env.TURNKEY_SOLANA_ADDRESS = 'So11111111111111111111111111111111111111112'
  assert.equal(tk.turnkeyEvmReady(), true)
  assert.equal(tk.turnkeySolReady(), true)
  assert.equal(tk.turnkeyEvmAddress(), '0x1111111111111111111111111111111111111111')
})

test('liveReady: a Turnkey EVM wallet arms live trading with NO raw BOT_WALLET_KEY', () => {
  process.env.ZEROX_API_KEY = 'zx'
  assert.equal(liveReady(), false, 'no signer yet')
  setTurnkeyCreds()
  process.env.TURNKEY_EVM_ADDRESS = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  assert.equal(liveReady(), true, 'Turnkey EVM signer arms live')
  assert.equal(botWalletAddress(), '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'address from Turnkey — no key derivation')
})

test('solanaLiveReady: a Turnkey Solana wallet arms live trading with NO raw key', () => {
  assert.equal(solanaLiveReady(), false)
  setTurnkeyCreds()
  process.env.TURNKEY_SOLANA_ADDRESS = 'So11111111111111111111111111111111111111112'
  assert.equal(solanaLiveReady(), true)
  assert.equal(solanaWalletAddress(), 'So11111111111111111111111111111111111111112', 'address from Turnkey')
})

test('raw-key path still works when Turnkey is not configured (backward compatible)', () => {
  process.env.ZEROX_API_KEY = 'zx'
  // a valid throwaway test private key (NOT a real funded key)
  process.env.BOT_WALLET_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  assert.equal(liveReady(), true, 'raw EVM key still arms live')
  assert.match(botWalletAddress() ?? '', /^0x[a-fA-F0-9]{40}$/, 'address derived from the raw key')
})

test('readiness validates FORMAT — a malformed address/key never reports ready (fail-closed, not misleading UI)', () => {
  process.env.ZEROX_API_KEY = 'zx'
  setTurnkeyCreds()
  process.env.TURNKEY_EVM_ADDRESS = '0xnothex' // not a 40-hex address
  process.env.TURNKEY_SOLANA_ADDRESS = 'not-base58-!!!' // invalid base58
  assert.equal(tk.turnkeyEvmReady(), false, 'malformed Turnkey EVM address → not ready')
  assert.equal(tk.turnkeySolReady(), false, 'malformed Turnkey Solana address → not ready')
  assert.equal(liveReady(), false, 'EVM not armed by a bad Turnkey address + no raw key')
  assert.equal(solanaLiveReady(), false, 'Solana not armed by a bad Turnkey address + no raw key')

  // a malformed RAW key is rejected too (drop Turnkey so only the raw keys are judged)
  delete process.env.TURNKEY_API_PUBLIC_KEY
  process.env.BOT_WALLET_KEY = '0x1234' // not a 32-byte hex private key
  process.env.SOLANA_WALLET_KEY = 'z'.repeat(80) // does not decode to a 64-byte secret key
  assert.equal(liveReady(), false, 'malformed raw EVM key → not ready')
  assert.equal(solanaLiveReady(), false, 'malformed raw Solana key → not ready')
})
