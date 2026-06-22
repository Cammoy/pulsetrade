// Auto-Sniper: budget pool, concurrent snipes of vetted tokens, no repeats,
// cash reclaim on completion. All providers mocked.
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-auto-'))

const { state } = await import('../src/store.js')
const { autoScan, startAutoSniper, stopAutoSniper, autoSniperStats, serializeAutoSniper } = await import('../src/engine.js')

const NOW = 1_750_000_000_000
const addr = (c: string) => '0x' + c.repeat(40)

const cleanGp = {
  is_open_source: '1', is_honeypot: '0', cannot_sell_all: '0', transfer_pausable: '0',
  is_blacklisted: '0', is_mintable: '0', selfdestruct: '0', hidden_owner: '0',
  owner_change_balance: '0', is_in_dex: '1', buy_tax: '0', sell_tax: '0', holder_count: '900',
  lp_holder_count: '2', lp_holders: [{ percent: '1', is_locked: 1, address: '0xlock' }],
  holders: [{ percent: '0.04', address: '0xaaa' }],
}

function poolJson(sym: string, tokenAddr: string, poolAddr: string) {
  return {
    attributes: {
      address: poolAddr, name: `${sym} / WETH`, base_token_price_usd: '2', reserve_in_usd: '90000',
      volume_usd: { h24: '50000' }, price_change_percentage: { h1: '1' }, fdv_usd: '5000000',
      pool_created_at: new Date(NOW - 20 * 60_000).toISOString(),
    },
    relationships: { base_token: { data: { id: `base_${tokenAddr}` } }, dex: { data: { id: 'aerodrome' } } },
  }
}

const FEED = {
  data: [poolJson('AAA', addr('a'), addr('1')), poolJson('BBB', addr('b'), addr('2')), poolJson('CCC', addr('c'), addr('3'))],
  included: [
    { id: `base_${addr('a')}`, type: 'token', attributes: { address: addr('a'), symbol: 'AAA', name: 'AAA' } },
    { id: `base_${addr('b')}`, type: 'token', attributes: { address: addr('b'), symbol: 'BBB', name: 'BBB' } },
    { id: `base_${addr('c')}`, type: 'token', attributes: { address: addr('c'), symbol: 'CCC', name: 'CCC' } },
  ],
}

before(() => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('geckoterminal')) return new Response(JSON.stringify(FEED), { status: 200 })
    if (u.includes('gopluslabs')) {
      const result: Record<string, any> = { [addr('a')]: cleanGp, [addr('b')]: cleanGp, [addr('c')]: cleanGp }
      return new Response(JSON.stringify({ code: 1, result }), { status: 200 })
    }
    if (u.includes('honeypot.is'))
      return new Response(JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } }), { status: 200 })
    if (u.includes('coingecko')) return new Response(JSON.stringify({ ethereum: { usd: 2000 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

beforeEach(() => {
  state.bots = []
  state.autoSniper = null
  state.settings.mode = 'paper' // each test starts in the paper workspace
})

const cfg = { takeProfitPct: 40, stopLossPct: 20, maxHoldMin: 45 }

test('start validation', () => {
  assert.ok('error' in (startAutoSniper({ network: 'nope', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg }) as any))
  assert.ok('error' in (startAutoSniper({ network: 'ethereum', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg }) as any), 'holdings-only chain rejected up front')
  assert.ok('error' in (startAutoSniper({ network: 'base', totalBudgetUsd: 5, perSnipeUsd: 5, config: cfg }) as any))
  assert.ok('error' in (startAutoSniper({ network: 'base', totalBudgetUsd: 100, perSnipeUsd: 200, config: cfg }) as any))
  assert.ok('error' in (startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, config: { ...cfg, stopLossPct: 0 } }) as any))
  const ok: any = startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg })
  assert.equal(ok.enabled, true)
  assert.equal(ok.poolUsd, 300)
  assert.ok('error' in (startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg }) as any), 'no double-start')
})

const TWO_H = 2 * 60 * 60_000

test('scan opens ONE best snipe per cadence (not a multi-fill)', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 250, perSnipeUsd: 100, maxConcurrent: 5, config: cfg })
  await autoScan(NOW + 100_000)
  const a = state.autoSniper!
  assert.equal(state.bots.length, 1, 'one best coin this cycle (despite room + budget for more)')
  assert.ok(state.bots[0].auto && state.bots[0].strategy === 'sniper')
  assert.equal(a.poolUsd, 150, 'pool debited exactly one snipe')
  assert.equal(a.lastEntryAt, NOW + 100_000, 'entry timestamp recorded for the cadence')
})

test('cadence gates entries to ~one per entryIntervalMs (2h), opening a new best each cycle', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 1000, perSnipeUsd: 100, maxConcurrent: 5, config: cfg, entryIntervalMs: TWO_H })
  await autoScan(NOW + 100_000) // cycle 1 → one snipe
  assert.equal(state.bots.length, 1)
  const first = state.bots[0].pool!.tokenAddress
  // a later scan still INSIDE the 2h cadence (past the 90s discovery window) → no new entry
  await autoScan(NOW + 100_000 + 100_000)
  assert.equal(state.bots.length, 1, 'cadence-gated: no second snipe within 2h')
  // a scan AFTER the 2h cadence → opens the next-best DISTINCT token
  await autoScan(NOW + 100_000 + TWO_H + 1000)
  assert.equal(state.bots.length, 2, 'next cadence opens one more')
  assert.notEqual(state.bots[1].pool!.tokenAddress, first, 'never the same token twice')
})

test('the auto-sniper ALWAYS hunts the fresh-launch feed — never the (incompatible) trending feed', async () => {
  // start with mode 'trending' → stored mode is forced to 'new'
  const a: any = startAutoSniper({ network: 'base', mode: 'trending', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg, entryIntervalMs: TWO_H })
  assert.equal(a.mode, 'new', 'a trending request is stored as new (trending = established coins, no fresh launches)')
  // a LEGACY persisted campaign stuck on trending is migrated to new in autoScan, so it can actually snipe
  a.mode = 'trending'
  await autoScan(NOW + 100_000)
  assert.equal(state.autoSniper!.mode, 'new', 'legacy trending campaign migrated to new in-place')
  assert.equal(state.bots.length, 1, 'it now opens a fresh-launch snipe instead of finding nothing')
})

test('a campaign auto-stops once the budget is fully deployed; runners keep riding', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 200, perSnipeUsd: 100, maxConcurrent: 5, config: cfg, entryIntervalMs: TWO_H })
  const a = state.autoSniper!
  assert.equal(a.targetSnipes, 2, 'campaign size = floor(budget / per-snipe)')
  await autoScan(NOW + 100_000) // cycle 1 → snipe 1
  assert.equal(a.openedCount, 1)
  assert.equal(a.enabled, true, 'still deploying after 1 of 2')
  await autoScan(NOW + 100_000 + TWO_H + 1000) // cycle 2 → snipe 2 = budget fully deployed
  assert.equal(a.openedCount, 2)
  assert.equal(a.enabled, false, 'budget fully deployed → the scan auto-stops')
  assert.equal(state.bots.filter((b) => b.auto && b.status !== 'stopped').length, 2, 'both runners keep riding independently')
  await autoScan(NOW + 100_000 + 2 * TWO_H + 2000) // later tick opens nothing — campaign is done
  assert.equal(state.bots.length, 2, 'no further snipes after the campaign completes')
})

test('finished snipes reclaim their cash to the pool, freeing it for the next cadence', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 1000, perSnipeUsd: 100, maxConcurrent: 1, config: cfg, entryIntervalMs: TWO_H })
  await autoScan(NOW + 100_000)
  assert.equal(state.bots.length, 1, 'maxConcurrent honoured')
  // snipe completes with its principal (and profit) back in cash
  state.bots[0].status = 'stopped'
  state.bots[0].cashUsd = 110
  await autoScan(NOW + 100_000 + TWO_H + 1000) // past cadence → reclaim + open the next
  assert.equal(state.bots[0].state.reclaimedByAuto, true, 'finished snipe reclaimed')
  const a = state.autoSniper!
  assert.equal(a.poolUsd, 1000 - 100 + 110 - 100, 'reclaimed then re-allocated')
  assert.equal(state.bots.length, 2)
})

test('scan is rate-limited and disabled stops spawning but still reclaims', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, maxConcurrent: 9, config: cfg })
  await autoScan(NOW + 100_000)
  const n = state.bots.length
  await autoScan(NOW + 110_000) // 10s later — inside the 90s window
  assert.equal(state.bots.length, n, 'no scan inside the rate window')

  stopAutoSniper(false)
  state.bots[0].status = 'stopped'
  state.bots[0].cashUsd = 42
  const poolBefore = state.autoSniper!.poolUsd
  await autoScan(NOW + 500_000)
  assert.equal(state.autoSniper!.poolUsd, poolBefore + 42, 'reclaim still happens when disabled')
  assert.equal(state.bots.length, n, 'nothing new spawned while disabled')
})

test('a LIVE auto-sniper pins its workspace — snipes are born LIVE even while viewing paper', async () => {
  state.settings.mode = 'live'
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg, entryIntervalMs: TWO_H })
  assert.equal(state.autoSniper!.workspace, 'live', 'workspace pinned at start')
  state.settings.mode = 'paper' // user switches to VIEW the paper workspace
  await autoScan(NOW + 100_000)
  assert.equal(state.bots.length, 1)
  assert.equal(state.bots[0].mode, 'live', 'snipe born LIVE despite the active view being paper')
})

test('snipes only FRESH launches — an old coin is filtered out, never sniped', async () => {
  const prev = globalThis.fetch
  const OLDADDR = addr('e')
  const oldFeed = {
    data: [
      {
        attributes: {
          address: addr('f'), name: 'OLDIE / WETH', base_token_price_usd: '2', reserve_in_usd: '90000',
          volume_usd: { h24: '50000' }, price_change_percentage: { h1: '1' }, fdv_usd: '5000000',
          pool_created_at: new Date(NOW - 400 * 24 * 60 * 60_000).toISOString(), // >1 year old
        },
        relationships: { base_token: { data: { id: `base_${OLDADDR}` } }, dex: { data: { id: 'aerodrome' } } },
      },
    ],
    included: [{ id: `base_${OLDADDR}`, type: 'token', attributes: { address: OLDADDR, symbol: 'OLDIE', name: 'OLDIE' } }],
  }
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('geckoterminal')) return new Response(JSON.stringify(oldFeed), { status: 200 })
    if (u.includes('gopluslabs')) return new Response(JSON.stringify({ code: 1, result: { [OLDADDR]: cleanGp } }), { status: 200 })
    if (u.includes('honeypot.is'))
      return new Response(JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } }), { status: 200 })
    if (u.includes('coingecko')) return new Response(JSON.stringify({ ethereum: { usd: 2000 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  // 'arbitrum' gives this test a fresh discovery cache; window = 24h, coin is >1yr old.
  startAutoSniper({ network: 'arbitrum', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg, entryIntervalMs: TWO_H, maxAgeMinutes: 24 * 60 })
  await autoScan(NOW + 50_000)
  assert.equal(state.bots.length, 0, 'the old coin is filtered by the freshness gate — nothing sniped')
  globalThis.fetch = prev
})

test('a corrupt/huge persisted maxAgeMinutes is re-clamped in autoScan — old coins still excluded', async () => {
  const prev = globalThis.fetch
  const OLDADDR = addr('d')
  const oldFeed = {
    data: [
      {
        attributes: {
          address: '0xpc', name: 'STALE / WETH', base_token_price_usd: '2', reserve_in_usd: '90000',
          volume_usd: { h24: '50000' }, price_change_percentage: { h1: '1' }, fdv_usd: '5000000',
          pool_created_at: new Date(NOW - 500 * 24 * 60 * 60_000).toISOString(), // 500 days old (> the 1yr cap)
        },
        relationships: { base_token: { data: { id: `base_${OLDADDR}` } }, dex: { data: { id: 'aerodrome' } } },
      },
    ],
    included: [{ id: `base_${OLDADDR}`, type: 'token', attributes: { address: OLDADDR, symbol: 'STALE', name: 'STALE' } }],
  }
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('geckoterminal')) return new Response(JSON.stringify(oldFeed), { status: 200 })
    if (u.includes('gopluslabs')) return new Response(JSON.stringify({ code: 1, result: { [OLDADDR]: cleanGp } }), { status: 200 })
    if (u.includes('honeypot.is'))
      return new Response(JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } }), { status: 200 })
    if (u.includes('coingecko')) return new Response(JSON.stringify({ ethereum: { usd: 2000 } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  startAutoSniper({ network: 'optimism', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg, entryIntervalMs: TWO_H })
  // Simulate a hand-edited / corrupt state.json: a 10,000-year window that would defeat
  // the gate entirely if autoScan trusted the persisted value. autoScan must re-clamp it.
  state.autoSniper!.maxAgeMinutes = 5_256_000_000
  await autoScan(NOW + 60_000)
  assert.equal(state.bots.length, 0, 'autoScan re-clamps the poisoned window to 1yr → the 500-day-old coin is still excluded')
  globalThis.fetch = prev
})

test('start clamps maxAgeMinutes — a bad value defaults to the 3-day window, never disabled', () => {
  const a: any = startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg, maxAgeMinutes: 0 })
  assert.equal(a.maxAgeMinutes, 72 * 60, '0 (would disable the gate) falls back to the 3-day default')
  stopAutoSniper(false)
  state.autoSniper = null
  const b: any = startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg, maxAgeMinutes: 999_999_999 })
  assert.equal(b.maxAgeMinutes, 365 * 24 * 60, 'an absurd value is capped at 1 year')
  stopAutoSniper(false)
  state.autoSniper = null
  const c: any = startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, config: cfg, maxAgeMinutes: 6 * 60 })
  assert.equal(c.maxAgeMinutes, 6 * 60, 'a sensible value is honoured')
})

test('stop with liquidate=true stops all active auto snipes', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, maxConcurrent: 3, config: cfg })
  await autoScan(NOW + 100_000)
  assert.ok(state.bots.some((b) => b.status === 'running'))
  stopAutoSniper(true)
  assert.ok(state.bots.every((b) => b.status === 'stopped'), 'all auto snipes stopped')
  const stats = autoSniperStats()
  assert.equal(stats.active, 0)
  assert.ok(stats.completed >= 1)
})

// ── Campaign-scoped panel stats (the dashboard must reflect THIS campaign, not lifetime) ──
test('autoSniperStats is scoped to the CURRENT campaign — prior-campaign bots are excluded', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, maxConcurrent: 3, config: cfg })
  await autoScan(NOW + 100_000)
  stopAutoSniper(true)
  const prior = state.bots.find((b) => b.auto)!
  prior.createdAt = 1 // belongs to a PRIOR campaign — born long before the next one starts
  assert.equal(prior.status, 'stopped')

  // New campaign → fresh startedAt (real now ≫ 1). The prior bot must not leak into its stats.
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, maxConcurrent: 3, config: cfg })
  const s = autoSniperStats()
  assert.equal(s.completed, 0, 'prior-campaign closed bot excluded from the new campaign')
  assert.equal(s.active, 0)
  assert.equal(s.realizedUsd, 0, 'no P&L carried over from a prior campaign')
  assert.equal(s.nativeTakenUsd, 0, 'no banked value carried over from a prior campaign')
})

test('campaign stats are mark-to-market: totalPnlUsd = realized + unrealized on open runners', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, maxConcurrent: 3, config: cfg })
  await autoScan(NOW + 100_000)
  const s = autoSniperStats()
  assert.equal(s.active, 1, 'one open runner this campaign')
  assert.equal(typeof s.unrealizedUsd, 'number')
  assert.equal(typeof s.totalPnlUsd, 'number')
  assert.equal(+(s.realizedUsd + s.unrealizedUsd).toFixed(2), s.totalPnlUsd, 'totalPnl = realized + unrealized')
})

test('campaign win/loss is per ROUND-TRIP (net P&L), not per sell — de-risk win + net-loss exit = ONE loss', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, maxConcurrent: 3, config: cfg })
  await autoScan(NOW + 100_000)
  const bot = state.bots.find((b) => b.auto)!
  // Simulate a snipe that de-risked (a winning partial) then exited at a net LOSS: per-SELL
  // it logged 1 win + 1 loss, but the round-trip's NET realized is negative → ONE loss.
  bot.status = 'stopped'
  bot.stats.wins = 1
  bot.stats.losses = 1
  bot.stats.realizedUsd = -5
  const s = autoSniperStats()
  assert.equal(s.completed, 1)
  assert.equal(s.wins, 0, 'a net-negative round-trip is not a win, despite the winning de-risk sell')
  assert.equal(s.losses, 1)
  assert.equal(s.wins + s.losses, s.completed, 'every closed snipe is exactly one W or one L')
})

test('"coins vetted" is per-campaign (a.vetted), not the lifetime tried buffer', async () => {
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, maxConcurrent: 3, config: cfg })
  await autoScan(NOW + 100_000)
  const a = state.autoSniper!
  assert.ok((a.vetted ?? 0) >= 1, 'vetted increments as candidates are considered')
  assert.equal((serializeAutoSniper(a) as { triedCount: number }).triedCount, a.vetted, 'triedCount surfaces the per-campaign vetted count')
  // A fresh campaign resets the vetted counter even though the tried dedup buffer persists.
  stopAutoSniper(false)
  startAutoSniper({ network: 'base', totalBudgetUsd: 300, perSnipeUsd: 100, maxConcurrent: 3, config: cfg })
  assert.equal(state.autoSniper!.vetted, 0, 'new campaign starts coins-vetted at 0')
})
