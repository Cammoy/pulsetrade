import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapTransfers, latestActionForToken } from '../src/smartmoney.js'
import { tokenOf } from '../src/networks.js'

const WALLET = '0x1111111111111111111111111111111111111111'
const AERO = tokenOf('base', 'AERO')! // base token with 18 decimals
const px = (cg: string) => (cg === AERO.cg ? 2 : undefined)

const xfer = (over: Record<string, string>) => ({
  contractAddress: AERO.address, from: '0xother', to: WALLET, value: '0', tokenDecimal: '18', timeStamp: '1000', hash: '0xh', ...over,
})

test('mapTransfers: inbound transfer = buy, outbound = sell, priced in USD', () => {
  const rows = [
    xfer({ to: WALLET, value: (5n * 10n ** 18n).toString(), timeStamp: '2000', hash: '0xbuy' }),
    xfer({ from: WALLET, to: '0xsink', value: (2n * 10n ** 18n).toString(), timeStamp: '3000', hash: '0xsell' }),
  ]
  const events = mapTransfers('base', WALLET, 'Test', rows, px)
  assert.equal(events.length, 2)
  const buy = events.find((e) => e.txHash === '0xbuy')!
  assert.equal(buy.side, 'buy')
  assert.equal(buy.token, 'AERO')
  assert.equal(buy.qty, 5)
  assert.equal(buy.usd, 10)
  const sell = events.find((e) => e.txHash === '0xsell')!
  assert.equal(sell.side, 'sell')
  assert.equal(sell.qty, 2)
})

test('mapTransfers: ignores tokens not in the curated list and unrelated wallets', () => {
  const rows = [
    { ...xfer({}), contractAddress: '0xdeadbeef00000000000000000000000000000000' }, // unknown token
    xfer({ from: '0xa', to: '0xb' }), // wallet not involved
  ]
  assert.equal(mapTransfers('base', WALLET, 'Test', rows, px).length, 0)
})

test('mapTransfers: usd is null when price is unavailable', () => {
  const rows = [xfer({ value: (1n * 10n ** 18n).toString() })]
  const events = mapTransfers('base', WALLET, 'Test', rows, () => undefined)
  assert.equal(events[0].usd, null)
  assert.equal(events[0].qty, 1)
})

test('latestActionForToken returns the most recent event for that token', () => {
  const rows = [
    xfer({ value: (1n * 10n ** 18n).toString(), timeStamp: '1000', hash: '0xold' }),
    xfer({ from: WALLET, to: '0xz', value: (1n * 10n ** 18n).toString(), timeStamp: '5000', hash: '0xnew' }),
  ]
  const events = mapTransfers('base', WALLET, 'Test', rows, px)
  const latest = latestActionForToken(events, 'AERO')
  assert.equal(latest!.txHash, '0xnew')
  assert.equal(latest!.side, 'sell')
  assert.equal(latestActionForToken(events, 'WETH'), null)
})

test('mapTransfers returns [] for an unknown network', () => {
  assert.deepEqual(mapTransfers('nope', WALLET, 'x', [xfer({})], px), [])
})
