// Regression tests for the multi-agent correctness-audit fixes (2026-06). Each
// guards one confirmed bug so it can't silently come back. Pure/isolated cases
// live here; the live-engine and persistence cases live with their own harnesses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-audit-'))

const { assess } = await import('../src/risk-screen.js')
const { mapTransfers, latestActionForToken, latestSellForToken } = await import('../src/smartmoney.js')
const { NETWORKS, tokenOf } = await import('../src/networks.js')
const { strategyById } = await import('../src/strategies.js')
const { RISK } = await import('../src/risk.js')
const { snipeSizeError, tokenExposureError } = await import('../src/safety-math.js')

// ── #5: Solana USDT sweep mint (a one-char typo routed live sweeps to a dead mint) ──
test('config: the Solana USDT mint is the canonical Tether SPL address (…NYB, not …NUS)', () => {
  const sol = NETWORKS.find((n) => n.id === 'solana')!
  assert.equal(sol.usdt!.address, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')
})

// ── #8 / #10: sniper safety gate ──
const ctx = { network: 'base', chainId: 8453, token: 'TEST' }
const cleanGp = {
  is_honeypot: '0', cannot_sell_all: '0', transfer_pausable: '0', is_blacklisted: '0',
  is_mintable: '0', selfdestruct: '0', hidden_owner: '0', can_take_back_ownership: '0',
  owner_change_balance: '0', is_proxy: '0', trading_cooldown: '0', is_open_source: '1',
  is_in_dex: '1', buy_tax: '0', sell_tax: '0', holder_count: '5000',
  lp_holder_count: '3', lp_holders: [{ percent: '0.98', is_locked: 1, address: '0xlock' }],
  holders: [{ percent: '0.08' }],
}
const cleanHp = { simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } }

test('#8 risk-screen: an EXTREME GoPlus sell tax fires even when honeypot.is reported only a lower (warn) tax', () => {
  // Providers disagree: honeypot.is simulates a small trade (~20%, warn) while GoPlus reads
  // the configured 95% (critical). The worse signal must win — not be suppressed as a dup.
  const r = assess(ctx, { ...cleanGp, sell_tax: '0.95' }, { simulationResult: { buyTax: 1, sellTax: 20 }, simulationSuccess: true })
  assert.ok(r.flags.some((f: any) => f.id === 'sell-tax-high' && f.severity === 'warn'), 'honeypot.is warn present')
  assert.ok(r.flags.some((f: any) => f.id === 'sell-tax-extreme-gp' && f.severity === 'critical'), 'GoPlus extreme STILL fires')
  assert.equal(r.tradeable, false, 'a critical flag blocks the trade')
})

test('#10 risk-screen: LP exists but its lock breakdown is unknown → precautionary warn, not silently safe', () => {
  // lp_holder_count present (token has an LP) but lp_holders not enumerable — common for the
  // minutes-old pools the sniper targets. Removable LP is the #1 rug vector; do not pass it clean.
  const r = assess(ctx, { ...cleanGp, lp_holder_count: '2', lp_holders: [] }, cleanHp)
  assert.ok(r.flags.some((f: any) => f.id === 'lp-lock-unknown' && f.severity === 'warn'))
  assert.ok(r.score < 100, `score is cut (was ${r.score})`)
})

// ── #15 self-transfer / #7 helper: smart-money classification ──
const WALLET = '0x1111111111111111111111111111111111111111'
const AERO = tokenOf('base', 'AERO')!
const px = (cg: string) => (cg === AERO.cg ? 2 : undefined)
const xfer = (over: Record<string, string>) => ({
  contractAddress: AERO.address, from: '0xother', to: WALLET, value: '0', tokenDecimal: '18', timeStamp: '1000', hash: '0xh', ...over,
})

test('#15 smart-money: a self-transfer (from === to) is neither a buy nor a sell (no one-way inflation)', () => {
  const rows = [xfer({ from: WALLET, to: WALLET, value: (3n * 10n ** 18n).toString(), hash: '0xself' })]
  assert.equal(mapTransfers('base', WALLET, 'Test', rows, px).length, 0)
})

test('#7 smart-money: latestSellForToken surfaces the wallet SELL even when a newer transfer follows it', () => {
  const rows = [
    xfer({ from: '0xa', to: WALLET, value: (5n * 10n ** 18n).toString(), timeStamp: '1000', hash: '0xbuy' }),
    xfer({ from: WALLET, to: '0xsink', value: (5n * 10n ** 18n).toString(), timeStamp: '2000', hash: '0xsell' }),
    xfer({ from: '0xb', to: WALLET, value: (1n * 10n ** 18n).toString(), timeStamp: '3000', hash: '0xnewbuy' }),
  ]
  const events = mapTransfers('base', WALLET, 'Test', rows, px)
  assert.equal(latestActionForToken(events, 'AERO')!.txHash, '0xnewbuy', 'latest ACTION is the newer buy')
  assert.equal(latestSellForToken(events, 'AERO')!.txHash, '0xsell', 'but the SELL is still surfaced so a holding mirror exits')
})

// ── #14: grid steps exactly one rung per tick (a fast multi-level move fills the ladder) ──
test('#14 grid: steps ONE rung per tick on a fast multi-level drop instead of skipping rungs', () => {
  const grid = strategyById('grid')!
  const params = RISK.balanced
  const state: Record<string, any> = {}
  const base = (price: number) => ({ price, closes: [], params, state, position: { qty: 0, avgCostUsd: 0, costUsd: 0 }, budgetUsd: 1000, cashUsd: 1000, now: 0 } as any)
  grid.decide(base(100)) // anchor
  const spacing = params.gridSpacingPct / 100
  const p = 100 * Math.pow(1 + spacing, -2.5) // exponent −2.5 → level floor(−2.5) = −3
  const a1 = grid.decide(base(p))
  assert.ok(a1 && a1.type === 'buy', 'first tick buys a rung')
  assert.equal(state.lastLevel, -1, 'stepped ONE rung, not jumped straight to −3')
  const a2 = grid.decide(base(p))
  assert.ok(a2 && a2.type === 'buy' && state.lastLevel === -2, 'next unchanged-price tick fills the next rung')
  const a3 = grid.decide(base(p))
  assert.ok(a3 && a3.type === 'buy' && state.lastLevel === -3, 'and the next, catching up to the real level over ticks')
  assert.equal(grid.decide(base(p)), null, 'once caught up, no further action at the same price')
})

// ── P0-6c/d: STRICT (sniper) screening is harsher than the informational report ──
const hpOk = { simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } }

test('P0-6c: an upgradeable proxy is a WARN in the UI report but NON-tradeable for a snipe', () => {
  const gp = { ...cleanGp, is_proxy: '1' }
  const lenient = assess(ctx, gp, cleanHp) // strict=false
  assert.ok(lenient.tradeable, 'general report still surfaces it (warn)')
  assert.ok(lenient.flags.some((f: any) => f.id === 'proxy' && f.severity === 'warn'))
  const strict = assess(ctx, gp, cleanHp, true)
  assert.equal(strict.tradeable, false, 'a snipe is blocked')
  assert.ok(strict.flags.some((f: any) => f.id === 'proxy' && f.severity === 'critical'))
})

test('P0-6c: reclaimable ownership is a WARN in the UI report but NON-tradeable for a snipe', () => {
  const gp = { ...cleanGp, can_take_back_ownership: '1' }
  assert.ok(assess(ctx, gp, cleanHp).tradeable, 'lenient: warn')
  assert.equal(assess(ctx, gp, cleanHp, true).tradeable, false, 'strict: blocked')
})

test('P0-6d: a single responding provider passes the UI report but NOT a snipe (both required)', () => {
  // Only honeypot.is answers (GoPlus null) — one source.
  const oneSource = assess(ctx, null, cleanHp)
  assert.equal(oneSource.sources.length, 1)
  assert.ok(oneSource.tradeable, 'lenient report surfaces on a single source')
  const strict = assess(ctx, null, cleanHp, true)
  assert.equal(strict.tradeable, false, 'a snipe needs BOTH providers')
  assert.ok(strict.flags.some((f: any) => f.id === 'single-source' && f.severity === 'critical'))
})

test('P0-6d: a clean token with BOTH providers passes even strict', () => {
  const r = assess(ctx, cleanGp, cleanHp, true)
  assert.equal(r.sources.length, 2)
  assert.ok(r.tradeable, 'two clean providers, no proxy/reclaim → snipeable')
})

// ── P0-6a / P1-5: exposure caps (pure) ──
test('P0-6a snipeSizeError: off unless BOTH a lifetime ceiling and a pct are set', () => {
  assert.equal(snipeSizeError(1000, 0, 25), null, 'no ceiling → off')
  assert.equal(snipeSizeError(1000, 200, 0), null, 'no pct → off')
})

test('P0-6a snipeSizeError: blocks a snipe over pct% of the lifetime ceiling, passes one under', () => {
  // 25% of a $200 ceiling = $50 max per snipe
  assert.match(snipeSizeError(60, 200, 25)!, /per-snipe limit of \$50/)
  assert.equal(snipeSizeError(50, 200, 25), null, 'exactly at the limit is fine')
  assert.equal(snipeSizeError(40, 200, 25), null)
})

test('P1-5 tokenExposureError: blocks when current + new exposure exceeds the cap', () => {
  // 40% of $200 = $80 per-token cap. Already $50 in the token, adding $40 → $90 > $80.
  assert.match(tokenExposureError(40, 50, 200, 40, 'PEPE')!, /concentration cap of \$80/)
  assert.equal(tokenExposureError(30, 50, 200, 40, 'PEPE'), null, '$50 + $30 = $80, at the cap')
  assert.equal(tokenExposureError(40, 50, 200, 0, 'PEPE'), null, 'pct 0 → off')
})
