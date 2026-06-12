import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assess } from '../src/risk-screen.js'

const ctx = { network: 'base', chainId: 8453, token: 'TEST' }

// A clean blue-chip-style GoPlus payload.
const cleanGp = {
  is_honeypot: '0', cannot_sell_all: '0', transfer_pausable: '0', is_blacklisted: '0',
  is_mintable: '0', selfdestruct: '0', hidden_owner: '0', can_take_back_ownership: '0',
  owner_change_balance: '0', is_proxy: '0', trading_cooldown: '0', is_open_source: '1',
  is_in_dex: '1', buy_tax: '0', sell_tax: '0', holder_count: '5000',
  lp_holder_count: '3', lp_holders: [{ percent: '0.98', is_locked: 1, address: '0xlock' }],
  holders: [{ percent: '0.08' }],
}
const cleanHp = { simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } }

test('clean token → safe and tradeable', () => {
  const r = assess(ctx, cleanGp, cleanHp)
  assert.equal(r.verdict, 'safe')
  assert.equal(r.tradeable, true)
  assert.ok(r.score >= 90, `score ${r.score}`)
  assert.ok(r.positives.length > 0)
  assert.deepEqual([...r.sources].sort(), ['GoPlus', 'honeypot.is'])
})

test('honeypot.is honeypot → score 0, danger, NOT tradeable', () => {
  const r = assess(ctx, cleanGp, { honeypotResult: { isHoneypot: true, honeypotReason: 'sell reverts' } })
  assert.equal(r.tradeable, false)
  assert.equal(r.verdict, 'danger')
  assert.equal(r.score, 0)
  assert.ok(r.flags.some((f) => f.id === 'honeypot' && f.severity === 'critical'))
})

test('GoPlus honeypot flag also blocks (provider redundancy)', () => {
  const r = assess(ctx, { ...cleanGp, is_honeypot: '1' }, null)
  assert.equal(r.tradeable, false)
  assert.ok(r.flags.some((f) => f.id === 'honeypot-gp'))
})

test('cannot-sell-all is treated as a partial honeypot', () => {
  const r = assess(ctx, { ...cleanGp, cannot_sell_all: '1' }, cleanHp)
  assert.equal(r.tradeable, false)
  assert.ok(r.flags.some((f) => f.id === 'cannot-sell-all' && f.severity === 'critical'))
})

test('extreme sell tax is a soft honeypot', () => {
  const r = assess(ctx, cleanGp, { simulationResult: { buyTax: 1, sellTax: 99 }, simulationSuccess: true })
  assert.equal(r.tradeable, false)
  assert.ok(r.flags.some((f) => f.id === 'sell-tax-extreme'))
})

test('rug setup: most LP unlocked → critical, blocked', () => {
  const r = assess(ctx, { ...cleanGp, lp_holders: [{ percent: '0.9', is_locked: 0, address: '0xdev' }] }, cleanHp)
  assert.ok(r.flags.some((f) => f.id === 'lp-unlocked' && f.severity === 'critical'))
  assert.equal(r.tradeable, false)
})

test('owner can edit balances → critical, blocked', () => {
  const r = assess(ctx, { ...cleanGp, owner_change_balance: '1' }, cleanHp)
  assert.ok(r.flags.some((f) => f.id === 'owner-balance'))
  assert.equal(r.tradeable, false)
})

test('soft warnings accumulate into caution without a hard block', () => {
  const r = assess(ctx, { ...cleanGp, is_mintable: '1', is_proxy: '1', trading_cooldown: '1', holder_count: '20' }, cleanHp)
  assert.equal(r.verdict, 'caution')
  assert.equal(r.tradeable, true)
  assert.ok(r.score < 75 && r.score >= 40, `score ${r.score}`)
})

test('no provider data → unsafe by default (never trade blind)', () => {
  const r = assess(ctx, null, null)
  assert.equal(r.tradeable, false)
  assert.equal(r.score, 0)
  assert.ok(r.flags.some((f) => f.id === 'no-data'))
})

test('honeypot.is alone (GoPlus blind) still yields a usable verdict', () => {
  const r = assess(ctx, null, cleanHp)
  assert.deepEqual(r.sources, ['honeypot.is'])
  assert.equal(r.tradeable, true)
})

test('tax figures are surfaced from whichever provider has them', () => {
  const r = assess(ctx, { ...cleanGp, buy_tax: '0.03', sell_tax: '0.05' }, cleanHp)
  assert.ok(Math.abs((r.buyTaxPct ?? 0) - 3) < 1e-9)
  assert.ok(Math.abs((r.sellTaxPct ?? 0) - 5) < 1e-9)
})

test('score is always clamped to 0..100', () => {
  for (const gp of [cleanGp, { ...cleanGp, is_honeypot: '1', selfdestruct: '1', owner_change_balance: '1' }]) {
    const r = assess(ctx, gp, cleanHp)
    assert.ok(r.score >= 0 && r.score <= 100)
  }
})
