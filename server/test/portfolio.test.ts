// Portfolio reader — the address guard (the only branch that doesn't touch the
// network). A valid address path makes real RPC reads, exercised live, not here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-portfolio-'))
const { readPortfolio, aggregateHoldings } = await import('../src/portfolio.js')

type H = Parameters<typeof aggregateHoldings>[1][number]
const h = (over: Partial<H>): H => ({ network: 'base', networkName: 'Base', color: '#06b6d4', symbol: 'ETH', name: 'Ether', kind: 'native', balance: 0, priceUsd: 2000, usd: 0, ...over })

test('aggregateHoldings keeps every native (even $0) so all networks show, but drops priced token dust', () => {
  const out = aggregateHoldings('0xabc', [
    h({ network: 'bnb', networkName: 'BNB Chain', symbol: 'BNB', kind: 'native', balance: 0.0013, priceUsd: 600, usd: 0.78 }),
    h({ network: 'polygon', networkName: 'Polygon', symbol: 'POL', kind: 'native', balance: 2, priceUsd: 0.075, usd: 0.15 }),
    h({ network: 'ethereum', networkName: 'Ethereum', symbol: 'ETH', kind: 'native', balance: 0, priceUsd: 2000, usd: 0 }), // empty network — must still show
    h({ network: 'solana', networkName: 'Solana', symbol: 'SOL', kind: 'native', balance: 0, priceUsd: 150, usd: 0 }), // empty Solana — must still show
    h({ network: 'base', networkName: 'Base', symbol: 'USDC', name: 'USD Coin', kind: 'token', balance: 0.004, priceUsd: 1, usd: 0.004 }), // token dust — drop
    h({ network: 'base', networkName: 'Base', symbol: 'cbBTC', name: 'cbBTC', kind: 'token', balance: 0.001, priceUsd: 65000, usd: 65 }), // real token — keep
    h({ network: 'arbitrum', networkName: 'Arbitrum', symbol: 'MYST', name: 'Mystery', kind: 'token', balance: 5, priceUsd: null, usd: 0 }), // held but unpriced — keep
  ])
  const symbols = out.holdings.map((x) => `${x.network}:${x.symbol}`)
  // Every native survives — including the two zero-balance ones.
  assert.ok(symbols.includes('ethereum:ETH'), 'zero-balance native ETH kept')
  assert.ok(symbols.includes('solana:SOL'), 'zero-balance native SOL kept')
  assert.ok(symbols.includes('bnb:BNB') && symbols.includes('polygon:POL'))
  // Real token + held-but-unpriced kept; priced token dust dropped.
  assert.ok(symbols.includes('base:cbBTC'), 'real token kept')
  assert.ok(symbols.includes('arbitrum:MYST'), 'unpriced token kept')
  assert.ok(!symbols.includes('base:USDC'), 'priced token dust dropped')
  // byNetwork lists every network that has a kept holding — incl. the $0 ones.
  const nets = out.byNetwork.map((n) => n.id)
  for (const id of ['bnb', 'polygon', 'ethereum', 'solana', 'base', 'arbitrum']) assert.ok(nets.includes(id), `byNetwork includes ${id}`)
  // Total only counts real value (the $0 natives add nothing).
  assert.ok(Math.abs(out.totalUsd - (0.78 + 0.15 + 65)) < 0.011, `total ${out.totalUsd}`)
})

test('readPortfolio rejects an unrecognized address with no network call', async () => {
  const out = await readPortfolio('not-an-address')
  assert.ok('error' in out && /recognized address|EVM|Solana/i.test(out.error))
})

test('readPortfolio rejects empty / malformed addresses', async () => {
  assert.ok('error' in (await readPortfolio('')))
  assert.ok('error' in (await readPortfolio('0x123'))) // too short
  assert.ok('error' in (await readPortfolio('0xZZZZ6BF26964aF9D7eEd9e03E53415D37aA96045'))) // non-hex
})

test('readPortfolio dispatches an ICP principal to the ledger reader (degrades without network on a bad principal)', async () => {
  // Shape-valid but checksum-invalid: readIcp catches the decode error before any
  // network call and returns a partial Portfolio (errors[]) — NOT the old "unknown
  // address" rejection, and NOT a real query (no valid principal to read). A valid
  // principal makes real IC-ledger reads, exercised live, not here.
  const out = await readPortfolio('aaaaa-aaaaa-aaaaa')
  assert.ok(!('error' in out), 'recognized as ICP, not rejected as an unknown address')
  const p = out as Exclude<typeof out, { error: string }>
  assert.equal(p.totalUsd, 0)
  assert.ok(p.errors.some((e) => /ICP/i.test(e)))
})
