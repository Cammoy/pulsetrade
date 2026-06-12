import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-tourney-'))

const PRICES: Record<string, number> = { ethereum: 2000, chainlink: 10 }

const { state } = await import('../src/store.js')
const { startTournament, endTournament, deleteTournament, serializeTournament, createCopyBot, createAiBot, __test } = await import('../src/engine.js')
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

test('deleteTournament removes the tournament and its bots', () => {
  const t: any = startTournament({ network: 'base', token: 'LINK', budgetUsd: 500, contestants })
  assert.equal(deleteTournament(t.id), true)
  assert.equal(state.tournaments.length, 0)
  assert.equal(state.bots.filter((b) => b.tournamentId === t.id).length, 0)
})

// ── copy & AI bot factories ──────────────────────────────────────────────────

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
