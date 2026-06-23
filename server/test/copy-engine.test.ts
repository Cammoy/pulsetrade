// Integration: a copy bot driven through the REAL engine tick (not just the pure strategy).
// Proves the engine wires copyParams into the trade — entry sizes to perTradeUsd (not the tier %),
// and the custom stop-loss it injects actually fires — through tickBot → settle → execBuy/execSell.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-copyeng-'))

const { state } = await import('../src/store.js')
const { createCopyBot, __test } = await import('../src/engine.js')
const pricesMod = await import('../src/prices.js')
const { getSpotPrices } = pricesMod

let prices: Record<string, number> = { chainlink: 10, ethereum: 2000, tether: 1 }
// 40 flat hourly candles so tickBot takes the indicator path (≥30) and evaluates an entry.
const candles = Array.from({ length: 40 }, (_, i) => [1_700_000_000_000 + i * 3_600_000, 10])

async function reprice(next: Record<string, number>) {
  prices = { ...prices, ...next }
  pricesMod.__test.expireSpot() // force a refetch (getSpotPrices skips while <20s fresh)
  await getSpotPrices(Object.keys(prices))
}

before(async () => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('simple/price')) return new Response(JSON.stringify(Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, { usd: v }]))), { status: 200 })
    if (u.includes('market_chart')) return new Response(JSON.stringify({ prices: candles }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  await getSpotPrices(Object.keys(prices))
})

test('copy bot ticks: enters at perTradeUsd and rides past the tier stop, then exits on its custom stop', async () => {
  state.bots = []
  await reprice({ chainlink: 10 })
  const bot = createCopyBot({ network: 'arbitrum', token: 'LINK', risk: 'balanced', budgetUsd: 1000, walletAddress: '0x' + 'ab'.repeat(20), walletLabel: 'W', perTradeUsd: 200, stopLossPct: 10 }) as any
  assert.ok(!('error' in bot), JSON.stringify(bot))

  // Smart money bought → mirror the entry on the next tick.
  bot.state.copySignal = { side: 'buy', txHash: '0xbuy' }
  await __test.tickBot(bot)
  assert.ok(bot.position.qty > 0, 'opened a position')
  assert.ok(Math.abs(bot.position.costUsd - 200) < 1, `deployed ~perTradeUsd ($200), not the 22% tier size ($220) — got ${bot.position.costUsd}`)

  // −6%: past the tier's 5% stop but inside our custom 10% — must HOLD (proves the override is live).
  await reprice({ chainlink: 9.4 })
  await __test.tickBot(bot)
  assert.ok(bot.position.qty > 0, 'held through −6% — the custom 10% stop overrode the tier 5%')

  // −16%: now the custom stop fires.
  await reprice({ chainlink: 8.4 })
  await __test.tickBot(bot)
  assert.equal(bot.position.qty, 0, 'custom stop-loss exited the position')
  assert.equal(bot.stats.losses, 1)
})
