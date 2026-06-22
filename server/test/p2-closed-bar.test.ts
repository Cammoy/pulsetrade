// P2-6: an indicator bot only OPENS a new entry once per closed hourly bar, not on every
// 20s intra-bar tick. Exits are unaffected. Drives the REAL tickBot with mocked candles/spot.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-cbar-'))

const { state } = await import('../src/store.js')
const { __test } = await import('../src/engine.js')
const { getSpotPrices } = await import('../src/prices.js')
const { tickBot } = __test

const T0 = 1_700_000_000_000
const HOUR = 3_600_000
// Rise then a short pure-loss tail → RSI deeply oversold, but price stays within 8% of the
// 50h average (so meanrev's downtrend filter doesn't veto the entry).
const PRICES: [number, number][] = []
for (let i = 0; i < 40; i++) PRICES.push([T0 + i * HOUR, 100 + i * 0.3])
for (let i = 0; i < 14; i++) PRICES.push([T0 + (40 + i) * HOUR, 111.7 - (i + 1) * 0.5])
const LAST = PRICES[PRICES.length - 1][1]

before(async () => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('market_chart')) return new Response(JSON.stringify({ prices: PRICES }), { status: 200 })
    if (u.includes('simple/price') || u.includes('coingecko')) return new Response(JSON.stringify({ testcoin: { usd: LAST } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  await getSpotPrices(['testcoin'])
})

function flatBot(): any {
  return {
    id: 'cbar1', name: 'cbar', network: 'base', token: 'TEST', cg: 'testcoin', strategy: 'meanrev', risk: 'balanced',
    budgetUsd: 1000, cashUsd: 1000, status: 'running',
    schedule: { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
    mode: 'paper', position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null },
    state: {}, stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 },
    equityHistory: [], log: [], createdAt: T0, lastTickAt: 0,
  }
}

test('P2-6: a flat indicator bot enters at most once per closed bar (no re-entry on same-bar ticks)', async () => {
  state.bots.length = 0
  state.trades.length = 0
  const bot = flatBot()
  state.bots.push(bot)

  await tickBot(bot)
  assert.ok(bot.position.qty > 0, 'first tick on a new bar opens the oversold entry')
  assert.equal(bot.state.lastBarT, PRICES[PRICES.length - 1][0], 'the evaluated bar timestamp is recorded')

  // Force flat WITHOUT advancing the bar (cache still serves the same candles).
  bot.position = { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null }
  bot.cashUsd = 1000
  await tickBot(bot)
  assert.equal(bot.position.qty, 0, 'a second tick on the SAME bar does NOT re-enter')

  // A new closed bar re-enables entries (simulated by clearing the recorded bar).
  bot.state.lastBarT = undefined
  await tickBot(bot)
  assert.ok(bot.position.qty > 0, 'a new bar re-enables the entry')
})
