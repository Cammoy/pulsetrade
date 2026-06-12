import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-sniper-'))

const { strategyById } = await import('../src/strategies.js')
const { RISK } = await import('../src/risk.js')
const { discoverPools } = await import('../src/sniper.js')

const NOW = 1_750_000_000_000
const sniperCtx = (over: any) => ({
  price: 1, closes: [1], params: RISK.aggressive, state: {},
  position: { qty: 0, avgCostUsd: 0, costUsd: 0 }, budgetUsd: 100, cashUsd: 100, now: NOW, ...over,
})

const snipe = { takeProfitPct: 50, stopLossPct: 20, maxHoldMin: 30 }

test('sniper: full-budget entry on first tick, then nothing until exit', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe }
  const buy = s.decide(sniperCtx({ state }))
  assert.ok(buy && buy.type === 'buy' && buy.usd === 100, 'buys whole budget')
  assert.equal(state.entryAt, NOW)
  // holding, price flat → hold
  assert.equal(s.decide(sniperCtx({ state, position: { qty: 100, avgCostUsd: 1, costUsd: 100 }, cashUsd: 0, price: 1 })), null)
})

test('sniper: take-profit exit', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe, entryAt: NOW }
  const a = s.decide(sniperCtx({ state, price: 1.6, position: { qty: 100, avgCostUsd: 1, costUsd: 100 }, cashUsd: 0 }))
  assert.ok(a && a.type === 'sell' && a.exit && /Take-profit/.test(a.reason))
  assert.equal(state.sniped, true)
})

test('sniper: stop-loss exit', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe, entryAt: NOW }
  const a = s.decide(sniperCtx({ state, price: 0.7, position: { qty: 100, avgCostUsd: 1, costUsd: 100 }, cashUsd: 0 }))
  assert.ok(a && a.type === 'sell' && a.exit && /Stop-loss/.test(a.reason))
})

test('sniper: max-hold timeout exit', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe, entryAt: NOW }
  const a = s.decide(
    sniperCtx({ state, now: NOW + 31 * 60_000, price: 1.1, position: { qty: 100, avgCostUsd: 1, costUsd: 100 }, cashUsd: 0 }),
  )
  assert.ok(a && a.type === 'sell' && /Max hold/.test(a.reason))
})

test('sniper: trailing stop locks profit after a peak', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe: { ...snipe, trailingPct: 10 }, entryAt: NOW }
  const pos = { qty: 100, avgCostUsd: 1, costUsd: 100 }
  s.decide(sniperCtx({ state, price: 1.4, position: pos, cashUsd: 0 })) // sets peak 1.4
  const a = s.decide(sniperCtx({ state, price: 1.25, position: pos, cashUsd: 0 })) // ~10.7% off peak, still +25%
  assert.ok(a && a.type === 'sell' && /Trailing/.test(a.reason))
})

test('sniper: is one-shot — will not re-enter after firing', () => {
  const s = strategyById('sniper')!
  const state: any = { snipe, entryAt: NOW, sniped: true }
  assert.equal(s.decide(sniperCtx({ state, position: { qty: 0, avgCostUsd: 0, costUsd: 0 } })), null)
})

test('sniper strategy is excluded from the wizard/backtester strategy list', async () => {
  const { STRATEGIES } = await import('../src/strategies.js')
  assert.ok(!STRATEGIES.some((s) => s.id === 'sniper'), 'sniper not in the 4 backtestable strategies')
})

// ── discovery (fetch mocked) ─────────────────────────────────────────────────

const poolsPayload = {
  data: [
    {
      attributes: {
        address: '0xpool1', name: 'PEPE / WETH', base_token_price_usd: '0.0001',
        reserve_in_usd: '50000', volume_usd: { h24: '120000' }, price_change_percentage: { h1: '12.5' },
        fdv_usd: '900000', pool_created_at: new Date(NOW - 5 * 60_000).toISOString(),
      },
      relationships: { base_token: { data: { id: 'base_0xpepe' } }, dex: { data: { id: 'uniswap_v3' } } },
    },
    {
      attributes: {
        address: '0xpool2', name: 'DOGE2 / WETH', base_token_price_usd: '0.002',
        reserve_in_usd: '8000', volume_usd: { h24: '4000' }, price_change_percentage: { h1: '-3' },
        fdv_usd: '40000', pool_created_at: new Date(NOW - 60 * 60_000).toISOString(),
      },
      relationships: { base_token: { data: { id: 'base_0xdoge2' } }, dex: { data: { id: 'aerodrome' } } },
    },
  ],
  included: [
    { id: 'base_0xpepe', type: 'token', attributes: { address: '0xpepe', symbol: 'PEPE', name: 'Pepe' } },
    { id: 'base_0xdoge2', type: 'token', attributes: { address: '0xdoge2', symbol: 'DOGE2', name: 'Doge Two' } },
  ],
}

before(() => {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('geckoterminal')) return new Response(JSON.stringify(poolsPayload), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

test('discoverPools maps GeckoTerminal payload and sorts newest-first', async () => {
  const { pools, error } = await discoverPools('base', 'new', NOW)
  assert.equal(error, undefined)
  assert.equal(pools.length, 2)
  const p = pools[0]
  assert.equal(p.tokenSymbol, 'PEPE')
  assert.equal(p.tokenAddress, '0xpepe')
  assert.equal(p.poolAddress, '0xpool1')
  assert.equal(p.priceUsd, 0.0001)
  assert.equal(p.liquidityUsd, 50000)
  assert.equal(p.volume24hUsd, 120000)
  assert.equal(p.ageMinutes, 5)
  assert.equal(p.dex, 'uniswap_v3')
  assert.ok((pools[0].ageMinutes ?? 0) < (pools[1].ageMinutes ?? 0), 'newest first')
})

test('discoverPools rejects unknown network', async () => {
  const { error } = await discoverPools('nope', 'new', NOW)
  assert.ok(error)
})
