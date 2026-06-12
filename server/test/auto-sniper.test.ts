// Auto-Sniper: budget pool, concurrent snipes of vetted tokens, no repeats,
// cash reclaim on completion. All providers mocked.
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-auto-'))

const { state } = await import('../src/store.js')
const { autoScan, startAutoSniper, stopAutoSniper, autoSniperStats } = await import('../src/engine.js')

const NOW = 1_750_000_000_000
const addr = (c: string) => '0x' + c.repeat(40)

const cleanGp = {
  is_open_source: '1', is_honeypot: '0', cannot_sell_all: '0', transfer_pausable: '0',
  is_blacklisted: '0', is_mintable: '0', selfdestruct: '0', hidden_owner: '0',
  owner_change_balance: '0', is_in_dex: '1', buy_tax: '0', sell_tax: '0', holder_count: '900',
  lp_holder_count: '2', lp_holders: [{ percent: '1', is_locked: 1, address: '0xlock' }],
  holders: [{ percent: '0.04', address: '0xaaa' }],
}

function poolJson(sym: string, tokenAddr: string, poolAddr: string) {
  return {
    attributes: {
      address: poolAddr, name: `${sym} / WETH`, base_token_price_usd: '2', reserve_in_usd: '90000',
      volume_usd: { h24: '50000' }, price_change_percentage: { h1: '1' }, fdv_usd: '5000000',
      pool_created_at: new Date(NOW - 20 * 60_000).toISOString(),
    },
    relationships: { base_token: { data: { id: `base_${tokenAddr}` } }, dex: { data: { id: 'aerodrome' } } },
  }
}

const FEED = {
  data: [poolJson('AAA', addr('a'), addr('1')), poolJson('BBB', addr('b'), addr('2')), poolJson('CCC', addr('c'), addr('3'))],
  included: [
    { id: `base_${addr('a')}`, type: 'token', attributes: { address: addr('a'), symbol: 'AAA', name: 'AAA' } },
    { id: `base_${addr('b')}`, type: 'token', attributes: { address: addr('b'), symbol: 'BBB', name: 'BBB' } },
    { id: `base_${addr('c')}`, type: 'token', attributes: { address: addr('c'), symbol: 'CCC', name: 'CCC' } },
  ],
}

before(() => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('geckoterminal')) return new Response(JSON.stringify(FEED), { status: 200 })
    if (u.includes('gopluslabs')) {
      const result: Record<string, any> = { [addr('a')]: cleanGp, [addr('b')]: cleanGp, [addr('c')]: cleanGp }
      return new Response(JSON.stringify({ code: 1, result }), { status: 200 })
    }
    if (u.includes('honeypot.is'))
      return new Response(JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } }), { status: 200 })
    if (u.includes('coingecko')) return new Response(JSON.stringify({ ethereum: { usd: 2000 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

beforeEach(() => {
  state.bots = []
  state.autoSniper = null
})

const cfg = { takeProfitPct: 40, stopLossPct: 20, maxHoldMin: 45 }

test('start validation', () => {
  assert.ok('error' in (startAutoSniper({ network: 'nope', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg }) as any))
  assert.ok('error' in (startAutoSniper({ network: 'base', totalBudgetUsd: 5, perSnipeUsd: 5, config: cfg }) as any))
  assert.ok('error' in (startAutoSniper({ network: 'base', totalBudgetUsd: 100, perSnipeUsd: 200, config: cfg }) as any))
  assert.ok('error' in (startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, config: { ...cfg, stopLossPct: 0 } }) as any))
  const ok: any = startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg })
  assert.equal(ok.enabled, true)
  assert.equal(ok.poolUsd, 300)
  assert.ok('error' in (startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg }) as any), 'no double-start')
})

test('scan snipes multiple distinct safe tokens within budget and concurrency', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 250, perSnipeUsd: 100, maxConcurrent: 5, config: cfg })
  await autoScan(NOW + 100_000)
  const a = state.autoSniper!
  // 250 / 100 → only 2 snipes fit the pool
  assert.equal(state.bots.length, 2, 'two snipes spawned')
  assert.ok(state.bots.every((b) => b.auto && b.strategy === 'sniper'))
  assert.equal(new Set(state.bots.map((b) => b.pool!.tokenAddress)).size, 2, 'distinct tokens')
  assert.equal(a.poolUsd, 50, 'pool debited per snipe')
  assert.equal(a.tried.length >= 2, true)
})

test('scan never re-snipes a tried token and respects maxConcurrent', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 1000, perSnipeUsd: 100, maxConcurrent: 1, config: cfg })
  await autoScan(NOW + 100_000)
  assert.equal(state.bots.length, 1, 'maxConcurrent honoured')
  const first = state.bots[0].pool!.tokenAddress
  // next scan window: still 1 active → nothing new
  await autoScan(NOW + 200_000)
  assert.equal(state.bots.length, 1)
  // snipe completes → reclaimed, and the NEXT scan picks a DIFFERENT token
  state.bots[0].status = 'stopped'
  state.bots[0].cashUsd = 110 // came back with profit principal
  await autoScan(NOW + 300_000)
  assert.equal(state.bots[0].state.reclaimedByAuto, true)
  const a = state.autoSniper!
  assert.equal(a.poolUsd, 1000 - 100 + 110 - 100, 'reclaimed then re-allocated')
  assert.equal(state.bots.length, 2)
  assert.notEqual(state.bots[1].pool!.tokenAddress, first, 'never the same token twice')
})

test('scan is rate-limited and disabled stops spawning but still reclaims', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, maxConcurrent: 9, config: cfg })
  await autoScan(NOW + 100_000)
  const n = state.bots.length
  await autoScan(NOW + 110_000) // 10s later — inside the 90s window
  assert.equal(state.bots.length, n, 'no scan inside the rate window')

  stopAutoSniper(false)
  state.bots[0].status = 'stopped'
  state.bots[0].cashUsd = 42
  const poolBefore = state.autoSniper!.poolUsd
  await autoScan(NOW + 500_000)
  assert.equal(state.autoSniper!.poolUsd, poolBefore + 42, 'reclaim still happens when disabled')
  assert.equal(state.bots.length, n, 'nothing new spawned while disabled')
})

test('stop with liquidate=true stops all active auto snipes', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, maxConcurrent: 3, config: cfg })
  await autoScan(NOW + 100_000)
  assert.ok(state.bots.some((b) => b.status === 'running'))
  stopAutoSniper(true)
  assert.ok(state.bots.every((b) => b.status === 'stopped'), 'all auto snipes stopped')
  const stats = autoSniperStats()
  assert.equal(stats.active, 0)
  assert.ok(stats.completed >= 1)
})
