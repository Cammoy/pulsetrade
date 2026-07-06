// Hyperliquid order-signing primitives. The END-TO-END correctness is proven against real
// testnet by `npm run verify:hyperliquid` (the exchange recovers our signer); these tests
// lock the deterministic pieces so a regression can't slip in without network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { actionHash, signL1Action, formatPrice, formatSize, buildOrderAction } from '../src/hyperliquid-sign.js'

const KEY = ('0x' + '11'.repeat(32)) as `0x${string}` // fixed throwaway key for determinism

test('formatSize rounds to szDecimals and trims trailing zeros', () => {
  assert.equal(formatSize(1.23456, 3), '1.235')
  assert.equal(formatSize(1.5, 4), '1.5')
  assert.equal(formatSize(2, 4), '2')
  assert.equal(formatSize(0, 4), '0')
})

test('formatPrice: integers pass through; decimals capped by sig-figs and (6 − szDecimals)', () => {
  assert.equal(formatPrice(1, 4), '1') // integer always allowed
  assert.equal(formatPrice(3500, 4), '3500')
  assert.equal(formatPrice(123.456, 2), '123.46') // ≤5 sig figs, ≤4 decimals → 123.46
  assert.equal(formatPrice(3500.123, 4), '3500.1') // 5 sig figs → 3500.1, ≤2 decimals
  assert.throws(() => formatPrice(0, 4)) // non-positive rejected
})

test('formatPrice: a sub-cent price that would round to "0" throws instead of emitting p:"0"', () => {
  // maxDecimals = 6 − szDecimals. At szDecimals 5 → 1 decimal, so 0.00001234 would trim to "0".
  // Posting p:"0" to the venue is invalid — fail fast with a clear message.
  assert.throws(() => formatPrice(0.00001234, 5), /rounds to 0/)
})

test('actionHash is deterministic and sensitive to action, nonce, and vault', () => {
  const action = buildOrderAction({ assetIndex: 4, isBuy: true, px: '100', sz: '0.1', tif: 'Ioc' })
  const h1 = actionHash(action, 1000)
  assert.equal(h1, actionHash(action, 1000), 'same inputs → same hash')
  assert.notEqual(h1, actionHash(action, 1001), 'nonce changes the hash')
  assert.notEqual(h1, actionHash(buildOrderAction({ assetIndex: 4, isBuy: false, px: '100', sz: '0.1', tif: 'Ioc' }), 1000), 'action changes the hash')
  assert.notEqual(h1, actionHash(action, 1000, '0x' + 'ab'.repeat(20)), 'vault changes the hash')
  assert.match(h1, /^0x[0-9a-f]{64}$/, 'is a 32-byte hex hash')
})

test('signL1Action produces a signature that recovers to the signer (EIP-712 contract locked)', async () => {
  const action = buildOrderAction({ assetIndex: 4, isBuy: true, px: '2500', sz: '0.01', tif: 'Ioc' })
  const nonce = 1_700_000_000_000
  const sig = await signL1Action({ privateKey: KEY, action, nonce, isMainnet: false })
  const connectionId = actionHash(action, nonce)
  const combined = (sig.r + sig.s.slice(2) + sig.v.toString(16).padStart(2, '0')) as `0x${string}`
  const recovered = await recoverTypedDataAddress({
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source: 'b', connectionId },
    signature: combined,
  })
  assert.equal(recovered.toLowerCase(), privateKeyToAccount(KEY).address.toLowerCase())
})

test("testnet vs mainnet use different phantom-agent sources → different signatures", async () => {
  const action = buildOrderAction({ assetIndex: 4, isBuy: true, px: '2500', sz: '0.01', tif: 'Ioc' })
  const nonce = 42
  const t = await signL1Action({ privateKey: KEY, action, nonce, isMainnet: false })
  const m = await signL1Action({ privateKey: KEY, action, nonce, isMainnet: true })
  assert.notEqual(t.r + t.s, m.r + m.s, "source 'b' (testnet) ≠ 'a' (mainnet)")
})
