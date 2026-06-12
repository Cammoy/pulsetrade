// Network catalog invariants — especially the new non-EVM entries.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-nets-'))

const { NETWORKS, networkById, tokenOf, allPriceIds } = await import('../src/networks.js')
const { screenToken } = await import('../src/screen-fetch.js')

test('solana and icp networks exist and are flagged non-EVM', () => {
  const sol = networkById('solana')!
  assert.equal(sol.evm, false)
  assert.equal(sol.native.symbol, 'SOL')
  assert.equal(sol.gt, 'solana')
  assert.ok(sol.tokens.length >= 4, 'has curated solana coins')
  const icp = networkById('icp')!
  assert.equal(icp.evm, false)
  assert.equal(icp.native.cg, 'internet-computer')
  assert.ok(tokenOf('icp', 'ICP'), 'ICP itself is tradable')
  assert.ok(tokenOf('icp', 'ckBTC'))
})

test('the original five networks stay EVM with valid 0x USDT addresses', () => {
  const evm = NETWORKS.filter((n) => n.evm)
  assert.equal(evm.length, 5)
  for (const n of evm) {
    assert.match(n.usdt.address, /^0x[a-fA-F0-9]{40}$/, `${n.id} USDT address`)
    assert.equal(n.usdt.cg, 'tether')
    for (const t of n.tokens) assert.match(t.address, /^0x[a-fA-F0-9]{40}$/, `${n.id}/${t.symbol}`)
  }
})

test('price-id universe covers the new chains', () => {
  const ids = allPriceIds()
  for (const id of ['solana', 'internet-computer', 'tether', 'jupiter-exchange-solana', 'chain-key-bitcoin', 'bonk']) {
    assert.ok(ids.includes(id), `missing ${id}`)
  }
})

test('every network has a unique id and every token a unique symbol within it', () => {
  assert.equal(new Set(NETWORKS.map((n) => n.id)).size, NETWORKS.length)
  for (const n of NETWORKS) {
    assert.equal(new Set(n.tokens.map((t) => t.symbol)).size, n.tokens.length, n.id)
  }
})

test('screening on non-EVM networks returns an honest advisory, not a block', async () => {
  const rep = await screenToken('solana', 'JUP')
  assert.equal(rep.tradeable, true, 'curated solana coins may paper-trade')
  assert.equal(rep.verdict, 'caution')
  assert.ok(rep.flags.some((f) => f.id === 'screening-unavailable'))
  assert.equal(rep.sources.length, 0, 'no provider claimed')
  const icp = await screenToken('icp', 'ICP')
  assert.ok(icp.flags.some((f) => f.id === 'screening-unavailable'))
})
