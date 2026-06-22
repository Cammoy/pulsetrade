// SM-1: a copy bot must only mirror wallet actions that happened AFTER it started
// following. walletTokenSignal returns the wallet's LATEST event, which on a new
// bot's first ticks is often a stale pre-creation buy — entering on it chases a
// move that may be hours old. freshCopySignal() is the cutoff.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strategyById, type Ctx } from '../src/strategies.js'
import { RISK } from '../src/risk.js'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-copy-'))
const { freshCopySignal, copyRefreshSignal } = await import('../src/engine.js')

const CREATED = 1_750_000_000_000

test('SM-1: a wallet action OLDER than the bot is ignored (no stale entry)', () => {
  assert.equal(freshCopySignal({ side: 'buy', txHash: '0xold', ts: CREATED - 60_000 }, CREATED), null)
})

test('SM-1: an action at or after creation is mirrored', () => {
  assert.deepEqual(freshCopySignal({ side: 'buy', txHash: '0xnew', ts: CREATED + 1 }, CREATED), { side: 'buy', txHash: '0xnew' })
  assert.deepEqual(freshCopySignal({ side: 'sell', txHash: '0xs', ts: CREATED }, CREATED), { side: 'sell', txHash: '0xs' }, 'exactly at createdAt is fresh')
})

test('SM-1: null / tx-less signals seed nothing', () => {
  assert.equal(freshCopySignal(null, CREATED), null)
  assert.equal(freshCopySignal({ side: 'buy', txHash: '', ts: CREATED + 1 }, CREATED), null)
})

test('SM-1: the copytrade strategy does not enter on a filtered-out stale signal, but does on a fresh one', () => {
  const copy = strategyById('copytrade')!
  const ctx = (copySignal: unknown): Ctx => ({
    price: 100,
    closes: Array(40).fill(100),
    params: RISK.balanced,
    state: { copySignal },
    position: { qty: 0, avgCostUsd: 0, costUsd: 0 },
    budgetUsd: 1000,
    cashUsd: 1000,
    now: CREATED + 1000,
  })
  // A stale buy is filtered to null upstream → the strategy sees nothing → no entry.
  assert.equal(copy.decide(ctx(freshCopySignal({ side: 'buy', txHash: '0xold', ts: CREATED - 1 }, CREATED))), null)
  // A fresh buy is seeded → the strategy copies the entry.
  const a = copy.decide(ctx(freshCopySignal({ side: 'buy', txHash: '0xnew', ts: CREATED + 1 }, CREATED)))
  assert.ok(a && a.type === 'buy', 'a fresh smart-money buy is copied')
})

// copy-exit: a holding mirror must still exit on the wallet's sell even after a newer
// inbound transfer — but must NOT resurface a stale pre-re-buy sell after it re-enters.
const ev = (side: 'buy' | 'sell', txHash: string, ts: number) => ({ side, txHash, ts })

test('copy-exit: a SELL newer than the current entry wins over a newer inbound buy (mirror still exits)', () => {
  const bot: any = { createdAt: CREATED, position: { qty: 5, openedAt: CREATED + 100 }, state: { lastCopiedTx: '0xb1' } }
  const latest = ev('buy', '0xinbound', CREATED + 300) // a newer inbound transfer classified as a buy
  const sell = ev('sell', '0xs1', CREATED + 200) // the wallet's sell, AFTER the entry
  assert.equal(copyRefreshSignal(bot, latest, sell)!.txHash, '0xs1', 'the post-entry sell is surfaced as the exit')
})

test('copy-exit: a pre-re-buy SELL is NOT resurfaced after a manual copy bot re-enters (no premature dump)', () => {
  // After re-buying, openedAt = re-entry time; the prior sell predates it and must be ignored.
  const bot: any = { createdAt: CREATED, position: { qty: 5, openedAt: CREATED + 500 }, state: { lastCopiedTx: '0xb2' } }
  const latest = ev('buy', '0xb2', CREATED + 500) // the re-entry buy (already copied)
  const staleSell = ev('sell', '0xs1', CREATED + 200) // the OLD sell, from BEFORE the re-entry
  assert.equal(copyRefreshSignal(bot, latest, staleSell)!.txHash, '0xb2', 'the stale pre-re-buy sell is ignored; the re-bought position is kept')
})

test('copy-exit: a flat bot never surfaces a sell (only the latest action)', () => {
  const bot: any = { createdAt: CREATED, position: { qty: 0, openedAt: null }, state: {} }
  assert.equal(copyRefreshSignal(bot, ev('buy', '0xb', CREATED + 10), ev('sell', '0xs', CREATED + 5))!.txHash, '0xb')
})
