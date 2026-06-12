// Auto-follow: budget pool mirrors a wallet's buys via spawned copy bots.
// Etherscan + CoinGecko mocked; tracking key set so the scan path is live.
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-follow-'))
process.env.ETHERSCAN_API_KEY = 'test-key'

const { state } = await import('../src/store.js')
const { startFollow, stopFollow, deleteFollow, followScan, followStats, __test } = await import('../src/engine.js')
const { computeWalletStats } = await import('../src/smartmoney.js')
const { getSpotPrices } = await import('../src/prices.js')
const { tokenOf } = await import('../src/networks.js')

// fetchTransfers caches by wallet for 60s, so each scan-test needs its own
// address to avoid reading a sibling test's cached transfers.
let walletSeq = 0
const freshWallet = () => '0x' + String(++walletSeq).padStart(2, '0').repeat(20)
const WALLET = '0x' + 'ab'.repeat(20)
const AERO = tokenOf('base', 'AERO')!
const LINK = tokenOf('base', 'LINK')!
const PRICES: Record<string, number> = { ethereum: 2000, 'aerodrome-finance': 2, chainlink: 10, tether: 1 }

let transfers: any[] = []

before(async () => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('etherscan')) {
      // Only the Base chain returns activity; other chains are quiet.
      const isBase = u.includes('chainid=8453')
      return new Response(JSON.stringify({ status: '1', result: isBase ? transfers : [] }), { status: 200 })
    }
    if (u.includes('simple/price'))
      return new Response(JSON.stringify(Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { usd: v }]))), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  await getSpotPrices(Object.keys(PRICES))
})

beforeEach(() => {
  state.bots = []
  state.follows = []
  transfers = []
})

// Buys are stamped slightly in the FUTURE so they land after the follow's
// startedAt — a follow only mirrors buys made after you start following.
const buyTx = (to: string, tok: typeof AERO, hash: string, secondsAhead = 60) => ({
  contractAddress: tok.address,
  from: '0xdex',
  to,
  value: (10n * 10n ** BigInt(tok.decimals)).toString(),
  tokenDecimal: String(tok.decimals),
  timeStamp: String(Math.floor(Date.now() / 1000) + secondsAhead),
  hash,
})

test('startFollow validation', () => {
  assert.ok('error' in (startFollow({ walletAddress: 'nope', totalBudgetUsd: 300, perTradeUsd: 100 }) as any))
  assert.ok('error' in (startFollow({ walletAddress: WALLET, totalBudgetUsd: 5, perTradeUsd: 5 }) as any))
  assert.ok('error' in (startFollow({ walletAddress: WALLET, totalBudgetUsd: 100, perTradeUsd: 200 }) as any))
  const ok: any = startFollow({ walletAddress: WALLET, label: 'Whale', totalBudgetUsd: 300, perTradeUsd: 100 })
  assert.equal(ok.enabled, true)
  assert.equal(ok.poolUsd, 300)
  assert.ok('error' in (startFollow({ walletAddress: WALLET, totalBudgetUsd: 300, perTradeUsd: 100 }) as any), 'no duplicate active follow')
})

test('followScan mirrors new buys: spawns tagged copy bots, debits the pool, dedupes tx', async () => {
  const w = freshWallet()
  const f: any = startFollow({ walletAddress: w, label: 'Whale', totalBudgetUsd: 250, perTradeUsd: 100, risk: 'aggressive', sweepTo: 'usdt' })
  transfers = [buyTx(w, AERO, '0xbuy1'), buyTx(w, LINK, '0xbuy2')]
  await followScan(Date.now() + 100_000)
  const bots = state.bots.filter((b) => b.followId === f.id)
  assert.equal(bots.length, 2, 'one mirror per token buy')
  assert.deepEqual(new Set(bots.map((b) => b.token)), new Set(['AERO', 'LINK']))
  assert.ok(bots.every((b) => b.strategy === 'copytrade' && b.sweepTo === 'usdt' && b.risk === 'aggressive'))
  assert.equal(state.follows[0].poolUsd, 50, 'pool debited per mirror')
  // same scan window: rate-limited
  await followScan(Date.now() + 110_000)
  assert.equal(state.bots.length, 2)
  // new window, same txs: seenTx dedupe
  await followScan(Date.now() + 300_000)
  assert.equal(state.bots.length, 2, 'never mirrors the same tx twice')
})

test('followScan respects maxConcurrent and pool floor', async () => {
  const w = freshWallet()
  startFollow({ walletAddress: w, totalBudgetUsd: 1000, perTradeUsd: 100, maxConcurrent: 1 })
  transfers = [buyTx(w, AERO, '0xa'), buyTx(w, LINK, '0xb')]
  await followScan(Date.now() + 100_000)
  assert.equal(state.bots.length, 1, 'maxConcurrent honoured')
})

test('retired mirror bots reclaim cash into the pool; stop/delete lifecycles', async () => {
  const w = freshWallet()
  // Two buys → two mirrors (budget 300 / $100 each). Set transfers once: the
  // 60s transfer cache means we can't change them again within this test.
  const f: any = startFollow({ walletAddress: w, totalBudgetUsd: 300, perTradeUsd: 100 })
  transfers = [buyTx(w, AERO, '0xa'), buyTx(w, LINK, '0xc')]
  await followScan(Date.now() + 100_000)
  assert.equal(state.bots.filter((b) => b.followId === f.id).length, 2)
  assert.equal(state.follows[0].poolUsd, 100, '300 − 2×100')

  // One mirror completes its round trip and retires with cash → reclaimed.
  const aero = state.bots.find((b) => b.followId === f.id && b.token === 'AERO')!
  aero.status = 'stopped'
  aero.cashUsd = 108
  await followScan(Date.now() + 300_000)
  assert.equal(state.follows[0].poolUsd, 208, 'cash reclaimed (100 idle + 108 returned)')
  assert.equal(aero.state.reclaimedByFollow, true)

  // The LINK mirror is still active → stop(liquidate) stops it.
  assert.ok(state.bots.some((b) => b.followId === f.id && b.status !== 'stopped'))
  stopFollow(f.id, true)
  assert.ok(state.bots.filter((b) => b.followId === f.id).every((b) => b.status === 'stopped'))
  const stats = followStats(state.follows[0])
  assert.equal(stats.active, 0)
  assert.ok(stats.completed >= 2)
  assert.equal(deleteFollow(f.id), true)
  assert.equal(state.follows.length, 0)
  assert.equal(state.bots.filter((b) => b.followId === f.id).length, 0)
})

test('computeWalletStats aggregates totals, per-token flows and a cumulative series', () => {
  const ev = (side: 'buy' | 'sell', token: string, usd: number, ts: number) => ({
    wallet: WALLET, label: 'W', network: 'base', token, tokenAddress: '0x0', side, qty: 1, usd, ts, txHash: 't' + ts,
  })
  const stats = computeWalletStats([
    ev('sell', 'AERO', 50, 3000),
    ev('buy', 'AERO', 100, 1000),
    ev('buy', 'LINK', 200, 2000),
  ] as any)
  assert.equal(stats.trades, 3)
  assert.equal(stats.buys, 2)
  assert.equal(stats.sells, 1)
  assert.equal(stats.volumeUsd, 350)
  assert.equal(stats.netFlowUsd, 250)
  assert.equal(stats.firstTs, 1000)
  assert.equal(stats.lastTs, 3000)
  assert.equal(stats.tokens[0].token, 'LINK', 'sorted by volume')
  const aero = stats.tokens.find((t) => t.token === 'AERO')!
  assert.equal(aero.buys, 1)
  assert.equal(aero.sells, 1)
  assert.equal(aero.netFlowUsd, 50)
  assert.deepEqual(stats.series.map((s) => s.v), [100, 300, 250], 'cumulative net flow, oldest first')
})
