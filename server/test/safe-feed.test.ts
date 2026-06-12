// Safe-only sniper feed: ONLY verified, sellable, well-distributed tokens
// survive. fetch is mocked end-to-end (GeckoTerminal, GoPlus batch, honeypot).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-safe-'))

const { passesHardFilter, discoverSafePools, SAFE_DEFAULTS } = await import('../src/sniper.js')

const NOW = 1_750_000_000_000
const addr = (c: string) => '0x' + c.repeat(40)

const cleanGp = {
  is_open_source: '1', is_honeypot: '0', cannot_sell_all: '0', transfer_pausable: '0',
  is_blacklisted: '0', is_mintable: '0', selfdestruct: '0', hidden_owner: '0',
  owner_change_balance: '0', is_in_dex: '1', buy_tax: '0', sell_tax: '0',
  holder_count: '500',
  lp_holder_count: '2', lp_holders: [{ percent: '1', is_locked: 1, address: '0xlock' }],
  holders: [{ percent: '0.05', address: '0xaaa' }, { percent: '0.04', address: '0xbbb' }],
}

// ── pure hard-filter unit tests ──────────────────────────────────────────────

test('hard filter: clean verified token passes', () => {
  assert.equal(passesHardFilter(cleanGp, SAFE_DEFAULTS), true)
})

test('hard filter: unverified contract is rejected', () => {
  assert.equal(passesHardFilter({ ...cleanGp, is_open_source: '0' }, SAFE_DEFAULTS), false)
})

test('hard filter: honeypot / cannot-sell rejected', () => {
  assert.equal(passesHardFilter({ ...cleanGp, is_honeypot: '1' }, SAFE_DEFAULTS), false)
  assert.equal(passesHardFilter({ ...cleanGp, cannot_sell_all: '1' }, SAFE_DEFAULTS), false)
})

test('hard filter: too few holders rejected', () => {
  assert.equal(passesHardFilter({ ...cleanGp, holder_count: '12' }, SAFE_DEFAULTS), false)
  assert.equal(passesHardFilter({ ...cleanGp, holder_count: undefined }, SAFE_DEFAULTS), false)
})

test('hard filter: single-wallet dominance rejected', () => {
  assert.equal(passesHardFilter({ ...cleanGp, holders: [{ percent: '0.45', address: '0xwhale' }] }, SAFE_DEFAULTS), false)
})

test('hard filter: a project treasury under the cap passes (relaxed thresholds)', () => {
  assert.equal(passesHardFilter({ ...cleanGp, holders: [{ percent: '0.35', address: '0xtreasury' }] }, SAFE_DEFAULTS), true)
})

test('safe feed: non-EVM networks return a clear error, not silence', async () => {
  const sol = await discoverSafePools('solana', 'new', NOW)
  assert.equal(sol.pools.length, 0)
  assert.match(sol.error ?? '', /not available|EVM/i)
  const icp = await discoverSafePools('icp', 'new', NOW)
  assert.match(icp.error ?? '', /not available|EVM/i)
})

test('hard filter: top-10 cabal rejected, locked/dead wallets ignored', () => {
  const cabal = Array.from({ length: 10 }, (_, i) => ({ percent: '0.09', address: `0xc${i}` }))
  assert.equal(passesHardFilter({ ...cleanGp, holders: cabal }, SAFE_DEFAULTS), false, '90% across 10 wallets fails')
  const mostlyBurned = [{ percent: '0.6', address: '0x' + '0'.repeat(40), is_locked: 0 }, { percent: '0.05', address: '0xaaa' }]
  assert.equal(passesHardFilter({ ...cleanGp, holders: mostlyBurned }, SAFE_DEFAULTS), true, 'burn address exempt from dominance')
})

test('hard filter: missing security data rejected', () => {
  assert.equal(passesHardFilter(undefined, SAFE_DEFAULTS), false)
})

// ── end-to-end feed test with all providers mocked ───────────────────────────

const FEED = {
  data: [
    poolJson('SAFE', addr('1'), '0xp1', 50_000),
    poolJson('NOSRC', addr('2'), '0xp2', 60_000), // unverified
    poolJson('HONEY', addr('3'), '0xp3', 70_000), // honeypot per sim
    poolJson('FEW', addr('4'), '0xp4', 80_000), // 8 holders
    poolJson('DUST', addr('5'), '0xp5', 500), // below liquidity floor
  ],
  included: ['SAFE', 'NOSRC', 'HONEY', 'FEW', 'DUST'].map((s, i) => ({
    id: `base_${addr(String(i + 1))}`,
    type: 'token',
    attributes: { address: addr(String(i + 1)), symbol: s, name: s },
  })),
}

function poolJson(sym: string, tokenAddr: string, poolAddr: string, liq: number) {
  return {
    attributes: {
      address: poolAddr, name: `${sym} / WETH`, base_token_price_usd: '0.5', reserve_in_usd: String(liq),
      volume_usd: { h24: '90000' }, price_change_percentage: { h1: '4' }, fdv_usd: '1000000',
      pool_created_at: new Date(NOW - 30 * 60_000).toISOString(),
    },
    relationships: { base_token: { data: { id: `base_${tokenAddr}` } }, dex: { data: { id: 'uniswap_v3' } } },
  }
}

before(() => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('geckoterminal')) return new Response(JSON.stringify(FEED), { status: 200 })
    if (u.includes('gopluslabs')) {
      const result: Record<string, any> = {
        [addr('1')]: cleanGp,
        [addr('2')]: { ...cleanGp, is_open_source: '0' },
        [addr('3')]: cleanGp, // looks clean on GoPlus — honeypot.is catches it
        [addr('4')]: { ...cleanGp, holder_count: '8' },
        [addr('5')]: cleanGp,
      }
      return new Response(JSON.stringify({ code: 1, result }), { status: 200 })
    }
    if (u.includes('honeypot.is')) {
      const isHoney = u.includes(addr('3'))
      return new Response(
        JSON.stringify({ simulationSuccess: !isHoney, honeypotResult: { isHoneypot: isHoney }, simulationResult: { buyTax: 0, sellTax: 0 } }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

test('safe feed returns ONLY the verified, sellable, distributed token', async () => {
  const { pools, scanned, error } = await discoverSafePools('base', 'new', NOW)
  assert.equal(error, undefined)
  assert.equal(scanned, 5, 'all candidates were scanned')
  assert.equal(pools.length, 1, 'only one survives the gate')
  assert.equal(pools[0].tokenSymbol, 'SAFE')
  assert.ok(pools[0].report.tradeable)
  assert.ok(pools[0].report.score >= SAFE_DEFAULTS.minScore)
  assert.deepEqual([...pools[0].report.sources].sort(), ['GoPlus', 'honeypot.is'])
})

test('safe feed result is cached', async () => {
  let calls = 0
  const prev = globalThis.fetch
  globalThis.fetch = (async (...args: any[]) => {
    calls++
    return (prev as any)(...args)
  }) as typeof fetch
  await discoverSafePools('base', 'new', NOW + 1000) // within 90s TTL
  assert.equal(calls, 0, 'served entirely from cache')
  globalThis.fetch = prev
})
