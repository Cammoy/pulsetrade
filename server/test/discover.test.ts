// Discovery crawler: find copy-worthy traders we don't track by crawling curated-pool buyers and
// verifying each by TRUE cost-basis realized P&L. GeckoTerminal + Etherscan + CoinGecko mocked.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-discover-'))
process.env.ETHERSCAN_API_KEY = 'test-key'

const { discoverTopTraders } = await import('../src/discover.js')
const { etherscanChainLimited } = await import('../src/smartmoney.js')
const { tokenOf } = await import('../src/networks.js')

const NOW = Date.now()
const D = 86_400_000
const AERO = tokenOf('base', 'AERO')!
const cbBTC = tokenOf('base', 'cbBTC')!
const OTHER = '0x' + 'ee'.repeat(20)
const POOL = '0x' + '99'.repeat(20) // the dominant counterparty → inferred + excluded as the DEX pool
const WHALE = '0x' + '11'.repeat(20) // profitable round-tripper → should be discovered
const NOISE = '0x' + '22'.repeat(20) // buys only, never closes → should be filtered out

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const xfer = (wallet: string, tok: typeof AERO, dir: 'in' | 'out', qty: number, agoDays: number, hash: string) => ({
  contractAddress: tok.address,
  from: dir === 'in' ? OTHER : wallet,
  to: dir === 'in' ? wallet : OTHER,
  value: (BigInt(qty) * 10n ** BigInt(tok.decimals)).toString(),
  tokenDecimal: String(tok.decimals),
  timeStamp: String(Math.floor((NOW - agoDays * D) / 1000)),
  hash,
})

// WHALE: bought AERO + cbBTC ~30d ago, sold both today — and the historical series rose 1→3,
// so each is a real realized profit (2 closed positions). NOISE: a single open AERO buy.
const WHALE_ROWS = [
  xfer(WHALE, AERO, 'in', 10, 30, '0xa1'), xfer(WHALE, AERO, 'out', 10, 0, '0xa2'),
  xfer(WHALE, cbBTC, 'in', 1, 30, '0xb1'), xfer(WHALE, cbBTC, 'out', 1, 0, '0xb2'),
]
const NOISE_ROWS = [xfer(NOISE, AERO, 'in', 10, 0, '0xc1')]

// Sourcing: a token's recent transfers. POOL is the dominant counterparty (drop it); WHALE + NOISE
// are recipients (candidate buyers). Etherscan tokentx-by-contractaddress shape: { from, to }.
const SOURCING = {
  status: '1',
  result: [
    { from: POOL, to: WHALE }, { from: POOL, to: WHALE }, { from: POOL, to: WHALE },
    { from: POOL, to: NOISE }, { from: POOL, to: OTHER }, { from: POOL, to: '0x' + '33'.repeat(20) },
    { from: '0x' + '44'.repeat(20), to: POOL }, { from: '0x' + '55'.repeat(20), to: POOL },
  ],
}

before(() => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('etherscan')) {
      if (u.includes('contractaddress=')) return json(SOURCING) // discovery sourcing (by token)
      if (!u.includes('chainid=8453')) return json({ status: '1', result: [] }) // verification, non-Base chains quiet
      const who = u.toLowerCase()
      if (who.includes('address=' + WHALE.toLowerCase())) return json({ status: '1', result: WHALE_ROWS })
      if (who.includes('address=' + NOISE.toLowerCase())) return json({ status: '1', result: NOISE_ROWS })
      return json({ status: '1', result: [] })
    }
    if (u.includes('market_chart')) return json({ prices: [[NOW - 30 * D, 1], [NOW - 15 * D, 2], [NOW, 3]] })
    return json({})
  }) as typeof fetch
})

test('discoverTopTraders flags coverage when a mainnet-only (free) Etherscan key rejects an L2', async () => {
  const saved = globalThis.fetch
  globalThis.fetch = (async (url: any) =>
    String(url).includes('etherscan')
      ? json({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.' })
      : json({})) as typeof fetch
  try {
    const out = await discoverTopTraders()
    assert.equal(out.length, 0) // no candidates can be sourced
    assert.equal(etherscanChainLimited(), true) // …but we KNOW why, so the UI won't claim "no traders"
  } finally {
    globalThis.fetch = saved
  }
})

test('discoverTopTraders surfaces a verified profitable round-tripper and filters buy-only noise', async () => {
  const out = await discoverTopTraders()
  const whale = out.find((t) => t.address.toLowerCase() === WHALE.toLowerCase())
  assert.ok(whale, 'profitable round-tripper is discovered')
  assert.ok(whale!.realizedPnlUsd > 0, `realized P&L positive (${whale!.realizedPnlUsd})`)
  assert.ok(whale!.roundTrips >= 2, 'has multiple closed positions')
  assert.ok(['promising', 'proven'].includes(whale!.tier))
  assert.ok(whale!.viaTokens.length > 0, 'records which curated tokens it traded')
  assert.ok(!out.some((t) => t.address.toLowerCase() === NOISE.toLowerCase()), 'buy-only wallet is filtered out')
})
