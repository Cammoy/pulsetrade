// The smart-money DEAD-token liquidity filter: tokenLiquidityUsd (GeckoTerminal token-reserve
// probe + cache) and dropRuggedTokens (drops confirmed near-zero pools, keeps healthy +
// unknown). fetch is mocked so a controllable reserve per token drives the assertions.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-liq-'))

const { tokenLiquidityUsd } = await import('../src/prices.js')
const { dropRuggedTokens } = await import('../src/smartmoney.js')

// total_reserve_in_usd keyed by lowercased token address; an address absent from the map → 404.
let reserves: Record<string, string> = {}
before(() => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('geckoterminal') && u.includes('/tokens/')) {
      const addr = (u.match(/\/tokens\/(0x[a-f0-9]+)/i)?.[1] ?? '').toLowerCase()
      if (!(addr in reserves)) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify({ data: { attributes: { total_reserve_in_usd: reserves[addr] } } }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

const A = (c: string) => '0x' + c.repeat(40)

test('tokenLiquidityUsd: parses total_reserve_in_usd; 404 → null', async () => {
  reserves = { [A('a')]: '50000' }
  assert.equal(await tokenLiquidityUsd('base', A('a')), 50000)
  assert.equal(await tokenLiquidityUsd('base', A('b')), null) // not indexed → 404 → null (unknown)
})

test('dropRuggedTokens: drops confirmed near-zero liquidity, keeps healthy + unknown (no false drop), order preserved', async () => {
  reserves = { [A('1')]: '80000', [A('2')]: '120' } // A('3') absent → 404 → unknown
  const items = [
    { network: 'base', tokenAddress: A('1'), token: 'ALIVE' },
    { network: 'base', tokenAddress: A('2'), token: 'RUG' }, // < $1k floor
    { network: 'base', tokenAddress: A('3'), token: 'UNKNOWN' },
  ]
  const kept = (await dropRuggedTokens(items)).map((k) => k.token)
  assert.ok(kept.includes('ALIVE'), 'healthy pool kept')
  assert.ok(!kept.includes('RUG'), 'confirmed near-zero liquidity dropped')
  assert.ok(kept.includes('UNKNOWN'), 'unknown liquidity is NEVER a false drop')
  assert.deepEqual(kept, ['ALIVE', 'UNKNOWN'], 'original order preserved')
})
