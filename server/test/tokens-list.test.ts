// The full per-network token list (CoinGecko-sourced) feeding the swap picker:
// normalize + dedup, cache within the TTL, and fail soft on a provider hiccup.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

const { tokenList } = await import('../src/tokens-list.js')

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const listJson = (tokens: unknown[]) => JSON.stringify({ name: 'CoinGecko', tokens })

test('normalizes + dedups (drops blank address/symbol and case-duplicate addresses)', async () => {
  globalThis.fetch = (async () =>
    new Response(
      listJson([
        { chainId: 8453, address: '0xAAA', symbol: 'AAA', name: 'Alpha', decimals: 18, logoURI: 'http://logo' },
        { chainId: 8453, address: '0xaaa', symbol: 'AAA2', name: 'dupe', decimals: 18 }, // same address (case) → dropped
        { chainId: 8453, address: '0xBBB', symbol: 'BBB', name: 'Beta', decimals: 6 },
        { chainId: 8453, address: '', symbol: 'NOADDR', decimals: 18 }, // no address → dropped
        { chainId: 8453, address: '0xCCC', symbol: '', decimals: 18 }, // no symbol → dropped
        { chainId: 8453, address: '0xDDD', symbol: 'FRAC', decimals: 18.5 }, // non-integer decimals → dropped (BigInt math)
      ]),
      { status: 200 },
    )) as typeof fetch
  const list = await tokenList('base', 1000)
  assert.deepEqual(list.map((t) => t.symbol), ['AAA', 'BBB'])
  assert.equal(list[0].logoURI, 'http://logo')
  assert.equal(list[1].decimals, 6)
  assert.equal(list[1].name, 'Beta')
})

test('caches within the TTL — a second call does not re-fetch', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response(listJson([{ chainId: 42161, address: '0xZ', symbol: 'Z', decimals: 18 }]), { status: 200 }) }) as typeof fetch
  await tokenList('arbitrum', 5_000)
  await tokenList('arbitrum', 6_000) // well within the 1h TTL
  assert.equal(calls, 1)
})

test('empty for an unsupported (non-swap) network — no fetch attempted', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 200 }) }) as typeof fetch
  assert.deepEqual(await tokenList('icp'), [])
  assert.equal(calls, 0)
})

test('fails soft on a provider error (empty list, never throws)', async () => {
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
  assert.deepEqual(await tokenList('optimism', 9_999_999), [])
})
