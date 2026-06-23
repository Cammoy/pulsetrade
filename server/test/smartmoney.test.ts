import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-sm-'))

const { mapTransfers, latestActionForToken, ensureSeeded, listWallets, walletTokenSignal, smartMoneyFeed, computeWalletScore, computeWalletStats } = await import('../src/smartmoney.js')
const { state } = await import('../src/store.js')
const { tokenOf } = await import('../src/networks.js')

const WALLET = '0x1111111111111111111111111111111111111111'
const AERO = tokenOf('base', 'AERO')! // base token with 18 decimals
const px = (cg: string) => (cg === AERO.cg ? 2 : undefined)

const xfer = (over: Record<string, string>) => ({
  contractAddress: AERO.address, from: '0xother', to: WALLET, value: '0', tokenDecimal: '18', timeStamp: '1000', hash: '0xh', ...over,
})

test('mapTransfers: inbound transfer = buy, outbound = sell, priced in USD', () => {
  const rows = [
    xfer({ to: WALLET, value: (5n * 10n ** 18n).toString(), timeStamp: '2000', hash: '0xbuy' }),
    xfer({ from: WALLET, to: '0xsink', value: (2n * 10n ** 18n).toString(), timeStamp: '3000', hash: '0xsell' }),
  ]
  const events = mapTransfers('base', WALLET, 'Test', rows, px)
  assert.equal(events.length, 2)
  const buy = events.find((e) => e.txHash === '0xbuy')!
  assert.equal(buy.side, 'buy')
  assert.equal(buy.token, 'AERO')
  assert.equal(buy.qty, 5)
  assert.equal(buy.usd, 10)
  const sell = events.find((e) => e.txHash === '0xsell')!
  assert.equal(sell.side, 'sell')
  assert.equal(sell.qty, 2)
})

test('mapTransfers: ignores tokens not in the curated list and unrelated wallets', () => {
  const rows = [
    { ...xfer({}), contractAddress: '0xdeadbeef00000000000000000000000000000000' }, // unknown token
    xfer({ from: '0xa', to: '0xb' }), // wallet not involved
  ]
  assert.equal(mapTransfers('base', WALLET, 'Test', rows, px).length, 0)
})

test('mapTransfers: usd is null when price is unavailable', () => {
  const rows = [xfer({ value: (1n * 10n ** 18n).toString() })]
  const events = mapTransfers('base', WALLET, 'Test', rows, () => undefined)
  assert.equal(events[0].usd, null)
  assert.equal(events[0].qty, 1)
})

test('latestActionForToken returns the most recent event for that token', () => {
  const rows = [
    xfer({ value: (1n * 10n ** 18n).toString(), timeStamp: '1000', hash: '0xold' }),
    xfer({ from: WALLET, to: '0xz', value: (1n * 10n ** 18n).toString(), timeStamp: '5000', hash: '0xnew' }),
  ]
  const events = mapTransfers('base', WALLET, 'Test', rows, px)
  const latest = latestActionForToken(events, 'AERO')
  assert.equal(latest!.txHash, '0xnew')
  assert.equal(latest!.side, 'sell')
  assert.equal(latestActionForToken(events, 'WETH'), null)
})

test('mapTransfers returns [] for an unknown network', () => {
  assert.deepEqual(mapTransfers('nope', WALLET, 'x', [xfer({})], px), [])
})

test('seeds reconcile: user wallets + stale seeds pruned, current seeds added with notes', () => {
  // A user wallet (addedAt>0) plus a STALE seed (addedAt:0, no longer curated).
  state.wallets = [
    { address: '0x' + '9'.repeat(40), label: 'My wallet', addedAt: 1 },
    { address: '0xdBF5E9c5206d0dB70a90108bf936DA60221dC080', label: 'Wintermute (market maker)', addedAt: 0 },
  ]
  ensureSeeded()
  const labels = listWallets().map((w) => w.label)
  assert.ok(labels.includes('My wallet'), 'user wallet kept')
  assert.ok(!labels.some((l) => /Wintermute/.test(l)), 'stale exchange/MM seed pruned')
  assert.ok(labels.some((l) => /GCR/.test(l)), 'GCR seeded')
  assert.ok(labels.some((l) => /Tetranode/.test(l)), 'Tetranode seeded')
  assert.ok(labels.some((l) => /Arthur Hayes/.test(l)), 'Arthur Hayes seeded')
  // Seeds carry a track-record note.
  const gcr = listWallets().find((w) => /GCR/.test(w.label))!
  assert.ok(gcr.note && gcr.note.length > 0, 'seed has a note')
  assert.equal(gcr.category, 'trader')
  const count = listWallets().length
  ensureSeeded() // idempotent — no duplicates
  assert.equal(listWallets().length, count)
  assert.ok(count >= 9, 'all current seeds + the user wallet present')
})

test('wallet tracking is EVM-only: solana/icp are politely unsupported', async () => {
  assert.equal(await walletTokenSignal('solana', '0x' + 'a'.repeat(40), 'JUP'), null)
  const feed = await smartMoneyFeed('solana')
  assert.equal(feed.events.length, 0)
  assert.equal(feed.unsupported, true)
})

// ── consensus aggregation ────────────────────────────────────────────────────
const { smartMoneyConsensus } = await import('../src/smartmoney.js')

test('smartMoneyConsensus: ranks tokens by distinct buyers, net inflow first', () => {
  const ev = (wallet: string, token: string, tokenAddress: string, side: 'buy' | 'sell', usd: number, ts: number) =>
    ({ wallet, label: wallet, network: 'base', token, tokenAddress, side, qty: 1, usd, ts, txHash: `${wallet}-${token}-${side}-${ts}` })
  const events = [
    // AAA: two DISTINCT wallets buying — strong consensus
    ev('0xA', 'AAA', '0xaaa', 'buy', 1000, 5),
    ev('0xB', 'AAA', '0xaaa', 'buy', 500, 4),
    // BBB: one wallet net selling
    ev('0xA', 'BBB', '0xbbb', 'sell', 800, 3),
    // CCC: one wallet buying (weaker than AAA's two buyers)
    ev('0xC', 'CCC', '0xccc', 'buy', 2000, 2),
  ]
  const rows = smartMoneyConsensus(events as never, 5) // now=5 so the tiny synthetic ts aren't "stale"
  assert.equal(rows[0].token, 'AAA', 'two distinct buyers ranks first')
  assert.equal(rows[0].buyers, 2)
  assert.equal(rows[0].netUsd, 1500)
  // BBB (net seller) ranks last
  assert.equal(rows[rows.length - 1].token, 'BBB')
  assert.equal(rows.find((r) => r.token === 'BBB')!.sellers, 1)
  // same wallet buying twice counts as ONE distinct buyer
  const dup = smartMoneyConsensus([ev('0xA', 'D', '0xd', 'buy', 1, 1), ev('0xA', 'D', '0xd', 'buy', 1, 2)] as never, 2)
  assert.equal(dup[0].buyers, 1)
  assert.equal(dup[0].buys, 2)
})

test('smartMoneyConsensus: EXCLUDES majors/wrapped/stables (WETH, USDC) and stale activity [accum-filter/stale-filter]', () => {
  const NOW = 1_800_000_000_000
  const ev = (token: string, ts: number) =>
    ({ wallet: '0xA', label: 'A', network: 'ethereum', token, tokenAddress: '0x' + token, side: 'buy' as const, qty: 1, usd: 1000, ts, txHash: `${token}${ts}` })
  const rows = smartMoneyConsensus(
    [ev('AERO', NOW), ev('WETH', NOW), ev('USDC', NOW), ev('OLDCOIN', NOW - 200 * 86_400_000)] as never,
    NOW,
  )
  const tokens = rows.map((r) => r.token)
  assert.ok(tokens.includes('AERO'), 'a real alt is a signal')
  assert.ok(!tokens.includes('WETH'), 'WETH is not an accumulation signal')
  assert.ok(!tokens.includes('USDC'), 'parking in a stable is not a signal')
  assert.ok(!tokens.includes('OLDCOIN'), 'activity older than the staleness window is dropped')
})

// ── comprehensive holdings (all tokens) ──────────────────────────────────────
const { computeHoldings } = await import('../src/smartmoney.js')

test('mapTransfers allTokens: includes non-curated tokens (qty only) with a curated flag', () => {
  const rows = [
    { contractAddress: AERO.address, from: '0x0', to: WALLET, value: String(5n * 10n ** 18n), tokenDecimal: '18', timeStamp: '100', hash: '0xa' },
    { contractAddress: '0x' + 'f'.repeat(40), from: '0x0', to: WALLET, value: String(3n * 10n ** 6n), tokenDecimal: '6', tokenSymbol: 'PEPE', timeStamp: '200', hash: '0xb' },
  ]
  const curatedOnly = mapTransfers('base', WALLET, 'W', rows, px)
  assert.equal(curatedOnly.length, 1, 'default = curated only')
  const all = mapTransfers('base', WALLET, 'W', rows, px, { allTokens: true })
  assert.equal(all.length, 2, 'allTokens includes the non-curated token')
  const pepe = all.find((e) => e.token === 'PEPE')!
  assert.equal(pepe.curated, false)
  assert.equal(pepe.usd, null, 'non-curated has no USD price')
  assert.equal(all.find((e) => e.token === 'AERO')!.curated, true)
})

test('computeHoldings: nets buys minus sells per token, drops flat positions, prices where known', () => {
  const ev = (token: string, addr: string, side: 'buy' | 'sell', qty: number, usd: number | null, ts: number, curated: boolean) =>
    ({ wallet: WALLET, label: 'W', network: 'base', token, tokenAddress: addr, side, qty, usd, ts, txHash: `${token}${side}${ts}`, curated })
  const holdings = computeHoldings([
    ev('AERO', '0xa', 'buy', 10, 20, 1, true),
    ev('AERO', '0xa', 'sell', 4, 8, 2, true), // net 6 AERO held
    ev('FLAT', '0xb', 'buy', 5, null, 1, false),
    ev('FLAT', '0xb', 'sell', 5, null, 2, false), // net 0 → dropped
    ev('PEPE', '0xc', 'buy', 1000, null, 3, false), // held, unpriced
  ] as never)
  const aero = holdings.find((h) => h.token === 'AERO')!
  assert.equal(aero.qty, 6, 'net 10 - 4 = 6')
  assert.equal(aero.usd, 12, 'priced at $2/unit → 6 × 2 = 12')
  assert.equal(aero.suspicious, false, 'priced + traded = real holding')
  assert.ok(!holdings.some((h) => h.token === 'FLAT'), 'flat position dropped')
  const pepe = holdings.find((h) => h.token === 'PEPE')!
  assert.equal(pepe.qty, 1000)
  assert.equal(pepe.usd, null)
  // unpriced, received-once → flagged suspicious (likely an airdrop)
  assert.equal(pepe.suspicious, true)
  // real (non-suspicious) holdings sort first
  assert.equal(holdings[0].token, 'AERO')
})

const { consensusHoldings } = await import('../src/smartmoney.js')

test('consensusHoldings: 2+ whales, but EXCLUDES majors/stables + stale + single-holder + spam', () => {
  const NOW = 1_800_000_000_000
  const hold = (token: string, addr: string, usd: number | null, over: Record<string, unknown> = {}) =>
    ({ network: 'ethereum', token, tokenAddress: addr, qty: 1, usd, curated: false, buys: 1, sells: 0, lastTs: NOW, suspicious: false, ...over })
  const ch = consensusHoldings(
    [
      { label: 'GCR', holdings: [hold('AERO', '0xaero', 5000), hold('WETH', '0xweth', 100000), hold('DEGEN', '0xdeg', 2000), hold('SCAM', '0xscam', null, { suspicious: true })] },
      { label: 'Tetranode', holdings: [hold('AERO', '0xaero', 9000), hold('WETH', '0xweth', 200000), hold('SOLO', '0xsolo', 9000), hold('DEAD', '0xdead', 3000, { lastTs: NOW - 200 * 86_400_000 })] },
      { label: 'Machi', holdings: [hold('AERO', '0xaero', 3000), hold('WETH', '0xweth', 50000), hold('DEGEN', '0xdeg', 1000), hold('DEAD', '0xdead', 4000, { lastTs: NOW - 200 * 86_400_000 })] },
    ],
    NOW,
  )
  const tokens = ch.map((c) => c.token)
  assert.ok(tokens.includes('AERO'), 'AERO (3 whales) qualifies')
  assert.ok(tokens.includes('DEGEN'), 'DEGEN (2 whales) qualifies')
  assert.ok(!tokens.includes('WETH'), 'WETH excluded — a major, not an accumulation signal [accum-filter]')
  assert.ok(!tokens.includes('DEAD'), 'a 2-holder bag not traded in 200d is excluded [stale-filter]')
  assert.ok(!tokens.includes('SOLO'), 'single-holder token excluded')
  assert.ok(!tokens.includes('SCAM'), 'suspicious airdrop excluded')
  assert.equal(ch[0].token, 'AERO', 'most-held real token ranks first')
  const aero = ch.find((c) => c.token === 'AERO')!
  assert.equal(aero.holders, 3)
  assert.equal(aero.totalUsd, 17000, 'combined value across holders (5000+9000+3000)')
  assert.equal(aero.wallets[0].usd, 9000, 'largest holder listed first')
})

const { isDeadToken, MIN_LIVE_LIQUIDITY_USD } = await import('../src/smartmoney.js')

test('isDeadToken: drops stale (no trades for months) OR confirmed near-zero liquidity; keeps unknown', () => {
  const NOW = 1_800_000_000_000
  // no activity in >90 days → dead (the dexscreener-style rug: liquidity pulled, trading stopped)
  assert.equal(isDeadToken({ lastTs: NOW - 200 * 86_400_000, liquidityUsd: 50_000 }, NOW), true)
  // recently active but a CONFIRMED near-zero DEX pool (liquidity removed) → dead
  assert.equal(isDeadToken({ lastTs: NOW, liquidityUsd: 100 }, NOW), true)
  // recent + healthy liquidity → alive
  assert.equal(isDeadToken({ lastTs: NOW, liquidityUsd: 50_000 }, NOW), false)
  // unknown liquidity (null, e.g. fetch failed / not indexed) is NEVER a reason to drop
  assert.equal(isDeadToken({ lastTs: NOW, liquidityUsd: null }, NOW), false)
  // omitting lastTs skips the staleness leg (consensus rows, already recency-filtered upstream)
  assert.equal(isDeadToken({ liquidityUsd: null }, NOW), false)
  assert.equal(isDeadToken({ liquidityUsd: MIN_LIVE_LIQUIDITY_USD - 1 }, NOW), true)
  assert.equal(isDeadToken({ liquidityUsd: MIN_LIVE_LIQUIDITY_USD }, NOW), false)
})

test('computeHoldings: flags scam-airdrop symbols (URLs, claim/reward, unicode) as suspicious', () => {
  const ev = (token: string, addr: string, ts: number) =>
    ({ wallet: WALLET, label: 'W', network: 'base', token, tokenAddress: addr, side: 'buy' as const, qty: 1, usd: null, ts, txHash: `${addr}${ts}`, curated: false })
  const h = computeHoldings([
    ev('Visit claim-rewards.io', '0x1', 1),
    ev('UṢDC', '0x2', 2), // unicode look-alike of USDC
    ev('AIRDROP', '0x3', 3),
  ] as never)
  assert.ok(h.every((x) => x.suspicious), 'all three flagged as suspicious')
})

// ── #2 copy-trade wallet scoring: honest, persistence-weighted, net-losers capped ──
const NOW = 1_800_000_000_000
test('computeWalletStats: per-token priced flag separates valued tokens from unlisted ones', () => {
  const ev = (token: string, side: 'buy' | 'sell', usd: number | null) => ({ wallet: '0x', label: 'W', network: 'base', token, tokenAddress: '0x', side, qty: 1, usd, ts: NOW, txHash: `0x${token}${side}`, curated: true })
  const s = computeWalletStats([ev('AERO', 'buy', 100), ev('AERO', 'sell', 150), ev('JUNK', 'buy', null), ev('JUNK', 'sell', null)])
  const aero = s.tokens.find((t: any) => t.token === 'AERO')!
  const junk = s.tokens.find((t: any) => t.token === 'JUNK')!
  assert.equal(aero.priced, true)
  assert.equal(aero.volumeUsd, 250)
  assert.equal(aero.netFlowUsd, -50) // 100 bought − 150 sold
  assert.equal(junk.priced, false) // no USD value → "—" in the UI, not $0
  assert.equal(junk.volumeUsd, 0)
  assert.equal(junk.buys, 1) // trade COUNTS are still complete
  assert.equal(junk.sells, 1)
})

const mkStats = (over: Partial<any>): any => ({ trades: 10, buys: 5, sells: 5, volumeUsd: 1000, netFlowUsd: 0, firstTs: 0, lastTs: NOW, tokens: [], series: [], ...over })
const tok = (token: string, netFlowUsd: number) => ({ network: 'base', token, buys: 2, sells: 2, volumeUsd: 1000, netFlowUsd, lastTs: NOW })

test('computeWalletScore: a recent, persistent, net-positive wallet is "proven"', () => {
  const s = computeWalletScore(mkStats({ trades: 20, tokens: [tok('A', -2000), tok('B', -1000), tok('C', -500), tok('D', -1500), tok('E', -1000)] }), NOW)
  assert.equal(s.realizedFlowUsd, 6000, 'realized flow = sells − buys across round-tripped tokens')
  assert.equal(s.roundTrips, 5)
  assert.equal(s.tier, 'proven')
  assert.ok(s.score >= 60, `score ${s.score}`)
})

test('computeWalletScore: a net-LOSER can never score high (capped) and is never "proven"', () => {
  const s = computeWalletScore(mkStats({ trades: 12, tokens: [tok('A', 2000), tok('B', 1500), tok('C', 1000)] }), NOW)
  assert.ok(s.realizedFlowUsd < 0, 'put in more than took out')
  assert.ok(s.score <= 25, `net-loser capped, got ${s.score}`)
  assert.notEqual(s.tier, 'proven')
})

test('computeWalletScore: profitable but STALE (60d) is "promising", not "proven"', () => {
  const s = computeWalletScore(mkStats({ trades: 20, lastTs: NOW - 60 * 86_400_000, tokens: [tok('A', -2000), tok('B', -1000), tok('C', -500), tok('D', -1500), tok('E', -1000)].map((t) => ({ ...t, lastTs: NOW - 60 * 86_400_000 })) }), NOW)
  assert.equal(s.tier, 'promising')
})

test('computeWalletScore: a thin track record (<3 trades / no round trip) is "thin", score 0', () => {
  assert.equal(computeWalletScore(mkStats({ trades: 2, tokens: [tok('A', -100)] }), NOW).tier, 'thin')
  assert.equal(computeWalletScore(mkStats({ trades: 8, tokens: [{ network: 'base', token: 'A', buys: 3, sells: 0, volumeUsd: 500, netFlowUsd: 500, lastTs: NOW }] }), NOW).tier, 'thin')
})
