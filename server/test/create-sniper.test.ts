// createSniper must screen the token and REFUSE non-tradeable ones with no
// override. fetch is mocked to return controllable GoPlus/honeypot payloads.
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-cs-'))

const { state } = await import('../src/store.js')
const { createSniper } = await import('../src/engine.js')

const POOL = '0x2222222222222222222222222222222222222222'

// toggled per test; a fresh token address per test avoids the 5-min screen cache
let goplus: Record<string, any> | null = null
let honeypot: Record<string, any> | null = null
let poolReserve = '90000' // GeckoTerminal pool reserve_in_usd (liquidity floor input) [P2-9]
let seq = 0
const nextToken = () => '0x' + String(++seq).padStart(40, 'a')

const cleanGp = {
  is_honeypot: '0', cannot_sell_all: '0', transfer_pausable: '0', is_blacklisted: '0',
  is_mintable: '0', selfdestruct: '0', hidden_owner: '0', owner_change_balance: '0',
  is_open_source: '1', is_in_dex: '1', buy_tax: '0', sell_tax: '0', holder_count: '5000',
  lp_holder_count: '2', lp_holders: [{ percent: '1', is_locked: 1, address: '0xlock' }], holders: [{ percent: '0.05' }],
}

before(() => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('gopluslabs')) {
      const addr = (u.match(/contract_addresses=(0x[a-f0-9]+)/i)?.[1] ?? '').toLowerCase()
      return new Response(JSON.stringify({ code: 1, result: goplus && addr ? { [addr]: goplus } : {} }), { status: 200 })
    }
    if (u.includes('honeypot.is')) {
      return new Response(JSON.stringify(honeypot ?? {}), { status: 200 })
    }
    if (u.includes('geckoterminal')) return new Response(JSON.stringify({ data: { attributes: { reserve_in_usd: poolReserve, base_token_price_usd: '1.5' } } }), { status: 200 })
    if (u.includes('coingecko')) return new Response(JSON.stringify({ ethereum: { usd: 2000 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

beforeEach(() => {
  state.bots = []
  poolReserve = '90000' // healthy pool by default; the floor tests override it
})

const mk = () => ({ network: 'base', poolAddress: POOL, tokenAddress: nextToken(), tokenSymbol: 'SAFE', budgetUsd: 100, decimals: 18, sniper: { takeProfitPct: 50, stopLossPct: 25, maxHoldMin: 30 } })

test('clean token → sniper bot created with risk report attached', async () => {
  goplus = cleanGp
  honeypot = { simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 1, sellTax: 1 } }
  const input = mk()
  const out: any = await createSniper(input)
  assert.ok(!('error' in out), out.error)
  assert.equal(out.strategy, 'sniper')
  assert.equal(out.pool.tokenAddress, input.tokenAddress)
  assert.ok(out.riskReport.tradeable)
  assert.equal(state.bots.length, 1)
})

test('honeypot → snipe REFUSED, no bot created, report returned', async () => {
  goplus = cleanGp
  honeypot = { honeypotResult: { isHoneypot: true, honeypotReason: 'cannot sell' } }
  const out: any = await createSniper(mk())
  assert.ok('error' in out, 'must be refused')
  assert.match(out.error, /blocked by safety screen/i)
  assert.equal(out.riskReport.tradeable, false)
  assert.equal(state.bots.length, 0, 'no bot persisted')
})

test('rug setup (unlocked LP) → refused', async () => {
  goplus = { ...cleanGp, lp_holders: [{ percent: '0.95', is_locked: 0, address: '0xdev' }] }
  honeypot = { simulationSuccess: true, honeypotResult: { isHoneypot: false } }
  const out: any = await createSniper(mk())
  assert.ok('error' in out)
  assert.equal(state.bots.length, 0)
})

test('no safety data at all → refused (never snipe blind)', async () => {
  goplus = null
  honeypot = null
  const out: any = await createSniper(mk())
  assert.ok('error' in out)
  assert.equal(state.bots.length, 0)
})

test('P2-9: a pool below the liquidity floor → snipe refused (too thin to exit)', async () => {
  goplus = cleanGp
  honeypot = { simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 1, sellTax: 1 } }
  poolReserve = '1500' // below the $2000 floor
  const out: any = await createSniper(mk())
  assert.ok('error' in out)
  assert.match(out.error, /liquidity .* below the \$2000 floor/i)
  assert.equal(state.bots.length, 0)
})

test('P2-9: a budget that is an outsized fraction of the pool → refused (own-buy price impact)', async () => {
  goplus = cleanGp
  honeypot = { simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 1, sellTax: 1 } }
  poolReserve = '5000' // $100 budget is 2% of a $5000 pool → over the 1.5% cap
  const out: any = await createSniper(mk())
  assert.ok('error' in out)
  assert.match(out.error, /over 1\.5% of the/i)
  assert.equal(state.bots.length, 0)
})

test('P2-9: unknown pool liquidity → refused (never snipe blind)', async () => {
  goplus = cleanGp
  honeypot = { simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 1, sellTax: 1 } }
  poolReserve = 'n/a' // GeckoTerminal returns a non-numeric reserve → unverifiable
  const out: any = await createSniper(mk())
  assert.ok('error' in out)
  assert.match(out.error, /couldn't verify .* liquidity/i)
  assert.equal(state.bots.length, 0)
})

test('P0-6d strict: only ONE provider answers (honeypot up, GoPlus blind) → snipe refused', async () => {
  // Pre-strict this passed on honeypot.is alone; a snipe now needs BOTH providers.
  goplus = null
  honeypot = { simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 1, sellTax: 1 } }
  const out: any = await createSniper(mk())
  assert.ok('error' in out, 'a single-source token is not snipeable')
  assert.match(out.error, /blocked by safety screen/i)
  assert.equal(state.bots.length, 0)
})

test('P0-6c strict: an upgradeable proxy token → snipe refused (warn-tier in the UI, blocking for a snipe)', async () => {
  goplus = { ...cleanGp, is_proxy: '1' }
  honeypot = { simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 1, sellTax: 1 } }
  const out: any = await createSniper(mk())
  assert.ok('error' in out)
  assert.equal(state.bots.length, 0)
})

test('input validation: bad address / budget / sniper params', async () => {
  goplus = cleanGp
  honeypot = { simulationSuccess: true, honeypotResult: { isHoneypot: false } }
  assert.ok('error' in (await createSniper({ ...mk(), tokenAddress: 'nope' })))
  assert.ok('error' in (await createSniper({ ...mk(), poolAddress: 'nope' })))
  assert.ok('error' in (await createSniper({ ...mk(), budgetUsd: 5 })))
  assert.ok('error' in (await createSniper({ ...mk(), sniper: { takeProfitPct: 0, stopLossPct: 25, maxHoldMin: 30 } })))
  assert.equal(state.bots.length, 0)
})

test('accepts a 64-hex Uniswap v4 pool ID (not just 40-hex contract pools)', async () => {
  goplus = cleanGp
  honeypot = { simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 1, sellTax: 1 } }
  const v4Pool = '0x' + 'a'.repeat(64) // 32-byte bytes32 pool id
  const out: any = await createSniper({ ...mk(), poolAddress: v4Pool })
  assert.ok(!('error' in out), out.error)
  assert.equal(out.pool.poolAddress, v4Pool)
})

test('holdings-only chain (Ethereum) → snipe refused before the screen, no bot', async () => {
  goplus = cleanGp
  honeypot = { simulationSuccess: true, honeypotResult: { isHoneypot: false } }
  const out: any = await createSniper({ ...mk(), network: 'ethereum' })
  assert.ok('error' in out, 'holdings-only chain must be refused')
  assert.match(out.error, /holdings-only/i)
  assert.equal(state.bots.length, 0)
})
