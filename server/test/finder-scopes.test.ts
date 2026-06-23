// Profit Finder scopes: top-100 momentum and trending-safe pools.
// All providers mocked (CoinGecko markets/candles, GeckoTerminal, GoPlus, honeypot).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-scopes-'))

const { profitFinder } = await import('../src/backtest.js')
const { STRATEGIES } = await import('../src/strategies.js')
const { RISK } = await import('../src/risk.js')

const NOW = 1_750_000_000_000
const HOUR = 3_600_000
const addr = (c: string) => '0x' + c.repeat(40)

const sineSeries = (n = 720, amp = 6) => Array.from({ length: n }, (_, i) => [NOW - (n - i) * HOUR, 100 + amp * Math.sin(i / 10)])

const MARKETS = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', price_change_percentage_24h: 2.0, total_volume: 30_000_000_000, market_cap: 1_300_000_000_000 },
  { id: 'tether', symbol: 'usdt', name: 'Tether', price_change_percentage_24h: 0.01, total_volume: 50_000_000_000, market_cap: 100_000_000_000 }, // stable — excluded
  { id: 'chainlink', symbol: 'link', name: 'Chainlink', price_change_percentage_24h: 9.5, total_volume: 500_000_000, market_cap: 10_000_000_000 }, // curated → launchable
  { id: 'wrapped-bitcoin', symbol: 'wbtc', name: 'Wrapped Bitcoin', price_change_percentage_24h: 8.0, total_volume: 200_000_000, market_cap: 12_000_000_000 }, // wrapped — excluded
  { id: 'some-moon-coin', symbol: 'moon', name: 'MoonCoin', price_change_percentage_24h: 25.0, total_volume: 80_000_000, market_cap: 400_000_000 }, // not curated → watch-only
  { id: 'dead-coin', symbol: 'dead', name: 'DeadCoin', price_change_percentage_24h: 40.0, total_volume: 50_000, market_cap: 30_000_000 }, // biggest "pump" but DEAD volume → must be excluded
]

const cleanGp = {
  is_open_source: '1', is_honeypot: '0', cannot_sell_all: '0', is_in_dex: '1', buy_tax: '0', sell_tax: '0',
  holder_count: '900', lp_holder_count: '2', lp_holders: [{ percent: '1', is_locked: 1, address: '0xlock' }],
  holders: [{ percent: '0.04', address: '0xaaa' }],
}

const TRENDING_FEED = {
  data: [{
    attributes: {
      address: addr('e'), name: 'TREND / WETH', base_token_price_usd: '1.5', reserve_in_usd: '80000',
      volume_usd: { h24: '60000' }, price_change_percentage: { h1: '5' }, fdv_usd: '2000000',
      pool_created_at: new Date(NOW - 60 * 60_000).toISOString(),
    },
    relationships: { base_token: { data: { id: `base_${addr('d')}` } }, dex: { data: { id: 'uniswap_v3' } } },
  }],
  included: [{ id: `base_${addr('d')}`, type: 'token', attributes: { address: addr('d'), symbol: 'TREND', name: 'Trend Coin' } }],
}

before(() => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('coins/markets')) return new Response(JSON.stringify(MARKETS), { status: 200 })
    if (u.includes('market_chart')) return new Response(JSON.stringify({ prices: sineSeries() }), { status: 200 })
    if (u.includes('ohlcv/hour')) {
      const list = sineSeries(300, 8).map(([t, c]) => [Math.floor((t as number) / 1000), c, c, c, c, 1000]).reverse()
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } } }), { status: 200 })
    }
    if (u.includes('geckoterminal')) return new Response(JSON.stringify(TRENDING_FEED), { status: 200 })
    if (u.includes('gopluslabs')) {
      return new Response(JSON.stringify({ code: 1, result: { [addr('d')]: cleanGp } }), { status: 200 })
    }
    if (u.includes('honeypot.is'))
      return new Response(JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

test('top100 scope: ranks movers, excludes stables/wrapped, maps launchability', async () => {
  const out: any = await profitFinder({ budgetUsd: 100, network: 'base', scope: 'top100' })
  assert.ok(!('error' in out), out.error)
  const tokens = new Set(out.rows.map((r: any) => r.token))
  assert.ok(!tokens.has('USDT'), 'stablecoin excluded')
  assert.ok(!tokens.has('WBTC'), 'wrapped excluded')
  assert.ok(!tokens.has('DEAD'), 'the biggest 24h pump is EXCLUDED — dead volume, not recommendable')
  assert.ok(tokens.has('LINK') && tokens.has('MOON') && tokens.has('BTC'))
  assert.equal(out.rows.length, 3 * STRATEGIES.length * Object.keys(RISK).length, 'all combos for the 3 LIQUID eligible movers')
  // sorted best-first
  for (let i = 1; i < out.rows.length; i++) assert.ok(out.rows[i - 1].profitUsd >= out.rows[i].profitUsd)
  // launch mapping
  const link = out.rows.find((r: any) => r.token === 'LINK')
  assert.deepEqual(link.launch, { kind: 'bot', network: 'base', token: 'LINK' }, 'curated coin is launchable on its home network')
  const moon = out.rows.find((r: any) => r.token === 'MOON')
  assert.deepEqual(moon.launch, { kind: 'market', cg: 'some-moon-coin', token: 'MOON', tokenName: 'MoonCoin' }, 'non-curated coin is immediately tradable as a paper market bot')
  assert.equal(moon.change24hPct, 25)
})

test('P0-9 cohort median: every row of a coin carries its cohort median, and best ≥ typical', async () => {
  const out: any = await profitFinder({ budgetUsd: 100, network: 'base', scope: 'top100' })
  assert.ok(!('error' in out), out.error)
  const linkRows = out.rows.filter((r: any) => r.token === 'LINK')
  assert.equal(linkRows.length, STRATEGIES.length * Object.keys(RISK).length)
  // every combo of the SAME coin shares one cohort median
  const med = linkRows[0].cohortMedianReturnPct
  for (const r of linkRows) assert.equal(r.cohortMedianReturnPct, med, 'all rows of a coin share its cohort median')
  // and it is the actual median of that coin's per-combo OOS returns
  const rets = linkRows.map((r: any) => r.returnPct).sort((a: number, b: number) => a - b)
  const m = Math.floor(rets.length / 2)
  const expected = +(rets.length % 2 ? rets[m] : (rets[m - 1] + rets[m]) / 2).toFixed(2)
  assert.equal(med, expected)
  // the headline (best of N) must be ≥ the typical (median) — the selection-bias point
  assert.ok(Math.max(...rets) >= med, 'best-of-N headline ≥ the typical config')
  assert.match(out.caveat, /typical|median/i, 'the caveat warns that the best is not the expected result')
})

test('trending scope: safety-gated pools backtested on their real pool candles, launchable as snipes', async () => {
  const out: any = await profitFinder({ budgetUsd: 100, network: 'base', scope: 'trending' })
  assert.ok(!('error' in out), out.error)
  assert.ok(out.rows.length > 0, 'the safe trending token produced rows')
  for (const r of out.rows) {
    assert.equal(r.token, 'TREND')
    assert.equal(r.launch.kind, 'snipe')
    assert.equal(r.launch.tokenAddress, addr('d'))
    assert.ok(r.launch.poolAddress)
  }
})

test('trending scope on a non-EVM network reports the limitation', async () => {
  const out: any = await profitFinder({ budgetUsd: 100, network: 'solana', scope: 'trending' })
  assert.ok('error' in out)
  assert.match(out.error, /not available|EVM/i)
})
