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

test('hard filter: unverified contract is NOT hard-rejected (scored, not eliminated)', () => {
  // Verification often lands minutes after launch; it's a -20 score penalty in
  // assess(), not a danger signal, so it must not eliminate a sellable token.
  assert.equal(passesHardFilter({ ...cleanGp, is_open_source: '0' }, SAFE_DEFAULTS), true)
})

test('hard filter: honeypot / cannot-sell rejected', () => {
  assert.equal(passesHardFilter({ ...cleanGp, is_honeypot: '1' }, SAFE_DEFAULTS), false)
  assert.equal(passesHardFilter({ ...cleanGp, cannot_sell_all: '1' }, SAFE_DEFAULTS), false)
})

test('hard filter: few INDEXED holders rejected, but an un-indexed fresh token is not', () => {
  // GoPlus reports a real low count → genuinely thin distribution → reject.
  assert.equal(passesHardFilter({ ...cleanGp, holder_count: '12' }, SAFE_DEFAULTS), false)
  // A minutes-old token GoPlus hasn't indexed (count 0, empty holders) must NOT
  // be rejected here — that's what made the "new" feed structurally always-empty.
  // Sellability/honeypot still gate it downstream.
  assert.equal(passesHardFilter({ ...cleanGp, holder_count: '0', holders: [] }, SAFE_DEFAULTS), true)
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

test('hard filter: missing GoPlus is NOT hard-rejected (honeypot.is is the gate downstream)', () => {
  // GoPlus anonymous tier rate-limits constantly; requiring it = empty feed.
  // Missing GoPlus flows on to the screen, where honeypot.is must vouch for
  // sellability and assess() blocks blind when BOTH providers are silent.
  assert.equal(passesHardFilter(undefined, SAFE_DEFAULTS), true)
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

test('safe feed: hard-excludes honeypots & thin distribution; passes sellable tokens (verified scores higher)', async () => {
  const { pools, scanned, error } = await discoverSafePools('base', 'new', NOW)
  assert.equal(error, undefined)
  assert.equal(scanned, 5, 'all candidates were scanned')
  // HONEY (honeypot.is fails the sell sim) and FEW (8 indexed holders) are
  // hard-excluded; DUST is below the liquidity floor. SAFE (verified) and NOSRC
  // (unverified but sellable & distributed) both pass — the latter scored down,
  // not eliminated.
  assert.deepEqual(pools.map((p) => p.tokenSymbol).sort(), ['NOSRC', 'SAFE'])
  assert.ok(!pools.some((p) => p.tokenSymbol === 'HONEY'), 'honeypot excluded')
  assert.ok(!pools.some((p) => p.tokenSymbol === 'FEW'), 'thin distribution excluded')
  const safe = pools.find((p) => p.tokenSymbol === 'SAFE')!
  const nosrc = pools.find((p) => p.tokenSymbol === 'NOSRC')!
  assert.ok(safe.report.tradeable && nosrc.report.tradeable)
  assert.ok(safe.report.score > nosrc.report.score, 'verified scores above unverified')
  assert.ok(nosrc.report.flags.some((f) => f.id === 'closed-source'), 'unverified is flagged, not hidden')
})

test('safe feed: a high-liquidity but ZERO-VOLUME (dead) pool is rejected — never recommended', async () => {
  const prev = globalThis.fetch
  const deadAddr = addr('9')
  const deadFeed = {
    data: [
      {
        attributes: {
          address: '0xpdead', name: 'DEAD / WETH', base_token_price_usd: '0.5',
          reserve_in_usd: '50000', // liquidity well ABOVE the floor…
          volume_usd: { h24: '0' }, // …but ZERO recent turnover → a dead pool (the ROIJIN case)
          price_change_percentage: { h1: '0' }, fdv_usd: '1000000',
          pool_created_at: new Date(NOW - 30 * 60_000).toISOString(),
        },
        relationships: { base_token: { data: { id: `base_${deadAddr}` } }, dex: { data: { id: 'uniswap_v2' } } },
      },
    ],
    included: [{ id: `base_${deadAddr}`, type: 'token', attributes: { address: deadAddr, symbol: 'DEAD', name: 'DEAD' } }],
  }
  globalThis.fetch = (async (url: any) =>
    String(url).includes('geckoterminal')
      ? new Response(JSON.stringify(deadFeed), { status: 200 })
      : new Response('{}', { status: 200 })) as typeof fetch // never even reaches GoPlus/honeypot — filtered pre-screen
  const { pools } = await discoverSafePools('arbitrum', 'new', NOW + 9_999_999) // fresh cache key
  assert.equal(pools.length, 0, 'a zero-volume pool never reaches the safe feed, despite ample liquidity')
  globalThis.fetch = prev
})

// ── freshness gate (the Auto-Sniper "snipe NEW launches only" guarantee) ──────

function agedPool(sym: string, tokenAddr: string, poolAddr: string, createdAtIso: string | null) {
  const attrs: Record<string, any> = {
    address: poolAddr, name: `${sym} / WETH`, base_token_price_usd: '0.5', reserve_in_usd: '50000',
    volume_usd: { h24: '90000' }, price_change_percentage: { h1: '4' }, fdv_usd: '1000000',
  }
  if (createdAtIso) attrs.pool_created_at = createdAtIso // omitted entirely ⇒ unknown creation time
  return { attributes: attrs, relationships: { base_token: { data: { id: `base_${tokenAddr}` } }, dex: { data: { id: 'uniswap_v3' } } } }
}

test('freshness gate: maxAgeMinutes keeps fresh launches, drops old coins, fail-closed on unknown age', async () => {
  const prev = globalThis.fetch
  const FRESH = addr('7'), OLD = addr('8'), NOAGE = addr('6')
  const mixed = {
    data: [
      agedPool('FRESH', FRESH, '0xpf', new Date(NOW - 30 * 60_000).toISOString()), // 30 min old
      agedPool('OLD', OLD, '0xpo', new Date(NOW - 200 * 24 * 60 * 60_000).toISOString()), // 200 days old
      agedPool('NOAGE', NOAGE, '0xpn', null), // no creation time → can't prove it's new
    ],
    included: [
      { id: `base_${FRESH}`, type: 'token', attributes: { address: FRESH, symbol: 'FRESH', name: 'FRESH' } },
      { id: `base_${OLD}`, type: 'token', attributes: { address: OLD, symbol: 'OLD', name: 'OLD' } },
      { id: `base_${NOAGE}`, type: 'token', attributes: { address: NOAGE, symbol: 'NOAGE', name: 'NOAGE' } },
    ],
  }
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('geckoterminal')) return new Response(JSON.stringify(mixed), { status: 200 })
    if (u.includes('gopluslabs'))
      return new Response(JSON.stringify({ code: 1, result: { [FRESH]: cleanGp, [OLD]: cleanGp, [NOAGE]: cleanGp } }), { status: 200 })
    if (u.includes('honeypot.is'))
      return new Response(JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  // 24h window → only FRESH survives; OLD (200d) and NOAGE (unknown age) are both dropped.
  const gated = await discoverSafePools('optimism', 'new', NOW + 1_000, { maxAgeMinutes: 24 * 60 })
  assert.deepEqual(gated.pools.map((p) => p.tokenSymbol).sort(), ['FRESH'], 'only the fresh launch survives the age gate')

  // The 'trending' feed is age-gated too — the filter runs regardless of mode, so an
  // old coin can never ride in via trending (new + trending, never an established coin).
  // (Trending raises the liq/vol floors to 25k; the fixtures' 50k/90k clear them.)
  const trending = await discoverSafePools('optimism', 'trending', NOW + 3_000, { maxAgeMinutes: 24 * 60 })
  assert.deepEqual(trending.pools.map((p) => p.tokenSymbol).sort(), ['FRESH'], 'trending feed is age-gated too')

  // Opt-in: with NO window (the manual sniper feed + backtest) age is not enforced,
  // so the old coin still surfaces — behaviour for those callers is unchanged.
  const ungated = await discoverSafePools('polygon', 'new', NOW + 2_000)
  assert.ok(ungated.pools.some((p) => p.tokenSymbol === 'OLD'), 'no age gate when maxAgeMinutes is unset')
  assert.ok(ungated.pools.some((p) => p.tokenSymbol === 'FRESH'))

  globalThis.fetch = prev
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
