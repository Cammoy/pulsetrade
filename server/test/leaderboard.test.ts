// Copy-worthiness leaderboard: scores + ranks every tracked wallet from its on-chain flow.
// Etherscan + CoinGecko mocked, branching per wallet address so ranking is testable.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-lb-'))

const { addWallet, smartMoneyLeaderboard } = await import('../src/smartmoney.js')
const { getSpotPrices } = await import('../src/prices.js')
const { tokenOf } = await import('../src/networks.js')

const AERO = tokenOf('base', 'AERO')!
const LINK = tokenOf('base', 'LINK')!
const OTHER = '0x' + 'ee'.repeat(20)
const WHALE = '0x' + 'a1'.repeat(20)
const NOOB = '0x' + 'b2'.repeat(20)

const tx = (dir: 'in' | 'out', wallet: string, tok: typeof AERO, qty: number, hash: string) => ({
  contractAddress: tok.address,
  from: dir === 'in' ? OTHER : wallet,
  to: dir === 'in' ? wallet : OTHER,
  value: (BigInt(qty) * 10n ** BigInt(tok.decimals)).toString(),
  tokenDecimal: String(tok.decimals),
  timeStamp: String(Math.floor(Date.now() / 1000) - 3600),
  hash,
})

// WHALE: two profitable round trips (sells out more value than bought) → high score.
// NOOB: a single buy, never closed → no round trip → thin.
const BY_WALLET: Record<string, any[]> = {
  [WHALE]: [tx('in', WHALE, AERO, 10, '0x1'), tx('out', WHALE, AERO, 30, '0x2'), tx('in', WHALE, LINK, 5, '0x3'), tx('out', WHALE, LINK, 8, '0x4')],
  [NOOB]: [tx('in', NOOB, AERO, 10, '0x5')],
}

before(async () => {
  process.env.ETHERSCAN_API_KEY = 'test-key'
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('etherscan')) {
      const isBase = u.includes('chainid=8453')
      const who = Object.keys(BY_WALLET).find((w) => u.toLowerCase().includes('address=' + w.toLowerCase()))
      return new Response(JSON.stringify({ status: '1', result: isBase && who ? BY_WALLET[who] : [] }), { status: 200 })
    }
    if (u.includes('simple/price'))
      return new Response(JSON.stringify({ ethereum: { usd: 2000 }, 'aerodrome-finance': { usd: 2 }, chainlink: { usd: 10 }, tether: { usd: 1 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  await getSpotPrices(['ethereum', 'aerodrome-finance', 'chainlink', 'tether'])
  addWallet(WHALE, 'Whale')
  addWallet(NOOB, 'Noob')
})

test('leaderboard needs an Etherscan key', async () => {
  const saved = process.env.ETHERSCAN_API_KEY
  delete process.env.ETHERSCAN_API_KEY
  const out = await smartMoneyLeaderboard()
  assert.equal(out.needsKey, true)
  assert.equal(out.rows.length, 0)
  process.env.ETHERSCAN_API_KEY = saved
})

test('leaderboard ranks the profitable round-tripper above a buy-only wallet', async () => {
  const out = await smartMoneyLeaderboard()
  assert.equal(out.needsKey, false)
  assert.ok(out.totalWallets >= 2)
  assert.ok(out.caveat.length > 0, 'carries the flow-not-PnL caveat')

  const whale = out.rows.find((r) => r.address.toLowerCase() === WHALE.toLowerCase())!
  const noob = out.rows.find((r) => r.address.toLowerCase() === NOOB.toLowerCase())!
  assert.ok(whale && noob)
  assert.equal(whale.tier, 'promising') // 2 profitable round trips, recent
  assert.ok(whale.score > 0 && whale.roundTrips === 2 && whale.realizedFlowUsd > 0)
  assert.equal(noob.tier, 'thin') // a single open buy
  assert.equal(noob.score, 0)
  assert.ok(out.rows[0].score >= whale.score, 'sorted best-first')
  assert.ok(out.rows.indexOf(whale) < out.rows.indexOf(noob), 'whale outranks noob')
  assert.ok(Array.isArray(whale.series) && whale.series.length > 0, 'has a flow sparkline series')
})
