import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-tourney-'))

const PRICES: Record<string, number> = { ethereum: 2000, chainlink: 10, tether: 1 }

const { state } = await import('../src/store.js')
const { startTournament, endTournament, deleteTournament, serializeTournament, createCopyBot, createAiBot, createBot, __test } = await import('../src/engine.js')
const { getSpotPrices } = await import('../src/prices.js')
const { networkById } = await import('../src/networks.js')

const { execBuy, execSell } = __test
const gas = networkById('base')!.avgGasUsd

before(async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { usd: v }]))), { status: 200 })) as typeof fetch
  await getSpotPrices(Object.keys(PRICES))
})

beforeEach(() => {
  state.bots = []
  state.tournaments = []
  state.trades = []
})

const contestants = [
  { strategy: 'grid', risk: 'balanced' as const },
  { strategy: 'meanrev', risk: 'aggressive' as const },
  { strategy: 'momentum', risk: 'conservative' as const },
]

test('startTournament spawns one equal-budget bot per contestant', () => {
  const t: any = startTournament({ network: 'base', token: 'LINK', budgetUsd: 500, contestants })
  assert.ok(!('error' in t))
  assert.equal(t.status, 'running')
  const bots = state.bots.filter((b) => b.tournamentId === t.id)
  assert.equal(bots.length, 3)
  assert.ok(bots.every((b) => b.budgetUsd === 500))
  assert.equal(new Set(bots.map((b) => b.strategy)).size, 3)
  assert.equal(t.standings.length, 3, 'standings present')
})

test('validation: bad network, low budget, too few/many contestants', () => {
  assert.ok('error' in (startTournament({ network: 'nope', token: 'LINK', budgetUsd: 500, contestants }) as any))
  assert.ok('error' in (startTournament({ network: 'base', token: 'LINK', budgetUsd: 5, contestants }) as any))
  assert.ok('error' in (startTournament({ network: 'base', token: 'LINK', budgetUsd: 500, contestants: contestants.slice(0, 1) }) as any))
  assert.ok('error' in (startTournament({ network: 'base', token: 'LINK', budgetUsd: 500, contestants: Array(13).fill(contestants[0]) }) as any))
  // Holdings-only chain (Ethereum) is refused up front and leaves NO orphan record.
  assert.ok('error' in (startTournament({ network: 'ethereum', token: 'WETH', budgetUsd: 500, contestants }) as any))
  assert.equal(state.tournaments.length, 0, 'no orphan tournament pushed for a holdings-only chain')
})

test('standings rank by return %, best first', () => {
  const t: any = startTournament({ network: 'base', token: 'LINK', budgetUsd: 1000, contestants })
  const bots = state.bots.filter((b) => b.tournamentId === t.id)
  // Make the 2nd bot the clear winner with a realized profit.
  execBuy(bots[1], 10, 500, 'in')
  execSell(bots[1], 13, 1, 'out', true) // +~30% on the traded half
  // 1st bot takes a loss.
  execBuy(bots[0], 10, 500, 'in')
  execSell(bots[0], 9, 1, 'out', true)
  const ranked = serializeTournament(state.tournaments[0]).standings
  assert.equal(ranked[0].botId, bots[1].id, 'winner is the profitable bot')
  assert.ok(ranked[0].returnPct > ranked[1].returnPct && ranked[1].returnPct >= ranked[2].returnPct)
  assert.equal(ranked[ranked.length - 1].botId, bots[0].id, 'loser is last')
})

test('endTournament stamps the winner and stops all contestants', () => {
  const t: any = startTournament({ network: 'base', token: 'LINK', budgetUsd: 1000, contestants })
  const bots = state.bots.filter((b) => b.tournamentId === t.id)
  execBuy(bots[0], 10, 300, 'in')
  execSell(bots[0], 12, 1, 'out', true)
  const ended: any = endTournament(t.id)
  assert.equal(ended.status, 'ended')
  assert.equal(ended.winnerBotId, bots[0].id)
  assert.ok(state.bots.filter((b) => b.tournamentId === t.id).every((b) => b.status === 'stopped'))
})

test('tournament with sweepTo usdt: contestants inherit it and ending sells to USDT', () => {
  const t: any = startTournament({ network: 'base', token: 'LINK', budgetUsd: 1000, contestants, sweepTo: 'usdt' })
  assert.equal(t.sweepTo, 'usdt')
  const bots = state.bots.filter((b) => b.tournamentId === t.id)
  assert.ok(bots.every((b) => b.sweepTo === 'usdt'), 'every contestant sweeps to USDT')
  // open a position, then end the tournament → liquidation lands in USDT
  execBuy(bots[0], 10, 400, 'in')
  endTournament(t.id)
  const sweep = state.trades.filter((tr) => tr.botId === bots[0].id && tr.sweptNative).at(-1)!
  assert.equal(sweep.sweptNative!.symbol, 'USDT')
  assert.ok(state.bots.filter((b) => b.tournamentId === t.id).every((b) => b.status === 'stopped'))
})

test('tournament defaults to native sweep when unspecified', () => {
  const t: any = startTournament({ network: 'base', token: 'LINK', budgetUsd: 500, contestants })
  assert.equal(t.sweepTo, 'native')
  assert.ok(state.bots.filter((b) => b.tournamentId === t.id).every((b) => b.sweepTo === undefined))
})

test('deleteTournament removes the tournament and its bots', () => {
  const t: any = startTournament({ network: 'base', token: 'LINK', budgetUsd: 500, contestants })
  assert.equal(deleteTournament(t.id), true)
  assert.equal(state.tournaments.length, 0)
  assert.equal(state.bots.filter((b) => b.tournamentId === t.id).length, 0)
})

// ── copy & AI bot factories ──────────────────────────────────────────────────

test('createCopyBot rejects non-EVM networks (tracking is Etherscan-based)', () => {
  const out: any = createCopyBot({ network: 'solana', token: 'JUP', risk: 'balanced', budgetUsd: 100, walletAddress: '0x' + 'a'.repeat(40), walletLabel: 'x' })
  assert.ok('error' in out)
  assert.match(out.error, /EVM/)
})

test('paper bots work on the new non-EVM networks (solana JUP, icp ICP)', () => {
  const sol: any = createBot({ network: 'solana', token: 'JUP', strategy: 'meanrev', risk: 'balanced', budgetUsd: 100 })
  assert.ok(!('error' in sol), sol.error)
  assert.equal(sol.network, 'solana')
  const icp: any = createBot({ network: 'icp', token: 'ICP', strategy: 'dca', risk: 'conservative', budgetUsd: 100 })
  assert.ok(!('error' in icp), icp.error)
  assert.equal(icp.token, 'ICP')
})

test('createCopyBot validates the wallet and tags the bot', () => {
  assert.ok('error' in (createCopyBot({ network: 'base', token: 'LINK', risk: 'balanced', budgetUsd: 100, walletAddress: 'nope', walletLabel: 'x' }) as any))
  const bot: any = createCopyBot({ network: 'base', token: 'LINK', risk: 'balanced', budgetUsd: 100, walletAddress: '0x' + 'a'.repeat(40), walletLabel: 'Whale' })
  assert.ok(!('error' in bot))
  assert.equal(bot.strategy, 'copytrade')
  assert.equal(bot.copy.walletLabel, 'Whale')
})

test('createAiBot tags the bot as AI', () => {
  const bot: any = createAiBot({ network: 'base', token: 'LINK', risk: 'aggressive', budgetUsd: 100 })
  assert.ok(!('error' in bot))
  assert.equal(bot.strategy, 'ai')
  assert.equal(bot.ai, true)
})
