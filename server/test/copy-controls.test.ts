// Copy-trade controls: a fixed per-entry size + custom stop-loss / take-profit that override
// the risk tier, on both single copy bots and the mirrors a follow spawns.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strategyById, type Ctx } from '../src/strategies.js'
import { RISK } from '../src/risk.js'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-copyctl-'))
process.env.ETHERSCAN_API_KEY = 'test-key'

const { state } = await import('../src/store.js')
const { createCopyBot, startFollow, followScan, copyParams } = await import('../src/engine.js')
const { getSpotPrices } = await import('../src/prices.js')
const { tokenOf } = await import('../src/networks.js')

const NOW = 1_750_000_000_000
const ctx = (over: Partial<Ctx>): Ctx => ({
  price: 100, closes: Array(40).fill(100), params: RISK.balanced, state: {},
  position: { qty: 0, avgCostUsd: 0, costUsd: 0 }, budgetUsd: 1000, cashUsd: 1000, now: NOW, ...over,
})

// ── Strategy: per-entry sizing override ──────────────────────────────────────
test('copytrade: a perTradeUsd override sets the exact entry size (capped to cash)', () => {
  const s = strategyById('copytrade')!
  const a = s.decide(ctx({ state: { copySignal: { side: 'buy', txHash: '0xa' } }, params: { ...RISK.balanced, perTradeUsd: 150 } }))
  assert.ok(a && a.type === 'buy')
  assert.equal(a.usd, 150) // the fixed override, NOT 22% of the $1000 budget
  const a2 = s.decide(ctx({ state: { copySignal: { side: 'buy', txHash: '0xb' } }, params: { ...RISK.balanced, perTradeUsd: 150 }, cashUsd: 80 }))
  assert.ok(a2 && a2.type === 'buy' && a2.usd === 80, 'never deploys more than available cash')
})

// ── copyParams: mirror by default (no tier take-profit cap) ──────────────────
test('copyParams: a plain copy bot has NO stop-loss / take-profit — it rides with the wallet', () => {
  const s = strategyById('copytrade')!
  const p = copyParams(RISK.balanced, { walletAddress: '0x', walletLabel: 'W' })
  assert.equal(p.stopLossPct, Infinity)
  assert.equal(p.takeProfitPct, Infinity)
  const held = { qty: 1, avgCostUsd: 100, costUsd: 100 }
  // +50% would have tripped the tier's +4.5% take-profit — now it holds (mirrors the wallet).
  assert.equal(s.decide(ctx({ params: p, position: held, price: 150 })), null)
  // −50% would have tripped the tier's −5% stop — also holds (exit comes from the wallet's sell).
  assert.equal(s.decide(ctx({ params: p, position: held, price: 50 })), null)
})

test('copyParams: opt-in stop-loss / take-profit + per-trade override are applied', () => {
  const p = copyParams(RISK.balanced, { walletAddress: '0x', walletLabel: 'W', stopLossPct: 12, takeProfitPct: 40, perTradeUsd: 75 })
  assert.equal(p.stopLossPct, 12)
  assert.equal(p.takeProfitPct, 40)
  assert.equal(p.perTradeUsd, 75)
})

// ── Strategy: custom stop-loss / take-profit ─────────────────────────────────
test('copytrade: custom stop-loss / take-profit thresholds drive the exit', () => {
  const s = strategyById('copytrade')!
  const held = { qty: 1, avgCostUsd: 100, costUsd: 100 }
  // A 10% custom stop: at -6% (past the tier's default 5%) it must still HOLD.
  assert.equal(s.decide(ctx({ params: { ...RISK.balanced, stopLossPct: 10 }, position: held, price: 94 })), null)
  const stop = s.decide(ctx({ params: { ...RISK.balanced, stopLossPct: 10 }, position: held, price: 89 }))
  assert.ok(stop && stop.type === 'sell' && /stop-loss/i.test(stop.reason))
  const tp = s.decide(ctx({ params: { ...RISK.balanced, takeProfitPct: 25 }, position: held, price: 130 }))
  assert.ok(tp && tp.type === 'sell' && /take-profit/i.test(tp.reason))
})

// ── createCopyBot validation + storage ───────────────────────────────────────
const EVM = '0x' + 'cd'.repeat(20)
const mk = (over: Record<string, unknown> = {}) =>
  createCopyBot({ network: 'base', token: 'AERO', risk: 'balanced', budgetUsd: 200, walletAddress: EVM, walletLabel: 'Whale', ...over }) as any

test('createCopyBot: validates the copy controls', () => {
  state.bots = []
  assert.ok('error' in mk({ perTradeUsd: 500 }), 'per-trade above budget rejected')
  assert.ok('error' in mk({ perTradeUsd: 0 }), 'non-positive per-trade rejected')
  assert.ok('error' in mk({ stopLossPct: 95 }), 'stop-loss out of range rejected')
  assert.ok('error' in mk({ takeProfitPct: 0 }), 'take-profit out of range rejected')
})

test('createCopyBot: stores supplied controls; unset ones fall back to the tier', () => {
  state.bots = []
  const ok = mk({ perTradeUsd: 120, stopLossPct: 8, takeProfitPct: 30 })
  assert.ok(!('error' in ok), JSON.stringify(ok))
  assert.equal(ok.copy.perTradeUsd, 120)
  assert.equal(ok.copy.stopLossPct, 8)
  assert.equal(ok.copy.takeProfitPct, 30)
  const plain = mk()
  assert.equal(plain.copy.perTradeUsd, undefined)
  assert.equal(plain.copy.stopLossPct, undefined)
})

// ── Follow propagation ───────────────────────────────────────────────────────
const AERO = tokenOf('base', 'AERO')!
let transfers: any[] = []
let walletSeq = 0
const freshWallet = () => '0x' + String(++walletSeq).padStart(2, '0').repeat(20)

before(async () => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('etherscan'))
      return new Response(JSON.stringify({ status: '1', result: u.includes('chainid=8453') ? transfers : [] }), { status: 200 })
    if (u.includes('simple/price'))
      return new Response(JSON.stringify({ ethereum: { usd: 2000 }, 'aerodrome-finance': { usd: 2 }, tether: { usd: 1 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  await getSpotPrices(['ethereum', 'aerodrome-finance', 'tether'])
})

const buyTx = (to: string, hash: string) => ({
  contractAddress: AERO.address, from: '0xdex', to,
  value: (10n * 10n ** BigInt(AERO.decimals)).toString(), tokenDecimal: String(AERO.decimals),
  timeStamp: String(Math.floor(Date.now() / 1000) + 60), hash,
})

test('startFollow rejects an out-of-range stop-loss', () => {
  assert.ok('error' in (startFollow({ walletAddress: freshWallet(), totalBudgetUsd: 300, perTradeUsd: 100, stopLossPct: 200 }) as any))
})

test('follow propagates its SL/TP overrides to every spawned mirror bot', async () => {
  state.bots = []
  state.follows = []
  const w = freshWallet()
  const f: any = startFollow({ walletAddress: w, label: 'Whale', totalBudgetUsd: 300, perTradeUsd: 100, stopLossPct: 12, takeProfitPct: 40 })
  assert.equal(f.stopLossPct, 12)
  assert.equal(f.takeProfitPct, 40)
  transfers = [buyTx(w, '0xbuyA')]
  await followScan(Date.now() + 100_000)
  const mirror = state.bots.find((b) => b.followId === f.id)
  assert.ok(mirror, 'spawned a mirror')
  assert.equal(mirror!.copy!.stopLossPct, 12)
  assert.equal(mirror!.copy!.takeProfitPct, 40)
})
