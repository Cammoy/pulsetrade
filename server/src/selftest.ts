// Deterministic check of the paper executor's accounting: buy, profitable
// sell with native sweep, losing sell, and stop-sweep. Run: npx tsx src/selftest.ts
import assert from 'node:assert'
import { state } from './store.js'
import { createBot, __test } from './engine.js'
import { getSpotPrices } from './prices.js'
import { networkById } from './networks.js'

const { execBuy, execSell } = __test

// Real native price so sweeps convert at live rates.
await getSpotPrices(['ethereum', 'polygon-ecosystem-token'])
const gas = networkById('arbitrum')!.avgGasUsd

state.bots = []
state.trades = []
const bot = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000 })
assert(!('error' in bot), 'bot created')

// 1) Buy $500 at $10
execBuy(bot, 10, 500, 'test buy')
const fee1 = gas + 500 * 0.0015
assert(Math.abs(bot.cashUsd - 500) < 1e-9, 'cash reduced by buy')
assert(Math.abs(bot.position.qty - (500 - fee1) / 10) < 1e-9, 'qty net of fees')
assert(Math.abs(bot.position.avgCostUsd - 10) < 1e-9, 'avg cost = fill price')

// 2) Sell all at $11 (+10%) → profit swept to native, principal back to cash
const qty = bot.position.qty
execSell(bot, 11, 1, 'test profit exit', true)
const gross = qty * 11
const fee2 = gas + gross * 0.0015
const pnl = gross - fee2 - qty * 10
assert(bot.position.qty === 0, 'position closed')
assert(Math.abs(bot.stats.realizedUsd - pnl) < 1e-6, 'realized = pnl')
assert(Math.abs(bot.stats.nativeTakenUsd - pnl) < 1e-6, 'profit swept to native')
assert(bot.stats.nativeTakenQty > 0, 'native qty credited')
assert(Math.abs(bot.cashUsd - (500 + qty * 10)) < 1e-6, 'principal returned to cash')
assert(bot.stats.wins === 1, 'win counted')

// 3) Buy $500 at $10, sell at $9 (loss) → no sweep, proceeds to cash
const cashBefore = bot.cashUsd
execBuy(bot, 10, 500, 'test buy 2')
const q2 = (500 - fee1) / 10
execSell(bot, 9, 1, 'test loss exit', true)
const gross2 = q2 * 9
const fee3 = gas + gross2 * 0.0015
assert(Math.abs(bot.cashUsd - (cashBefore - 500 + gross2 - fee3)) < 1e-6, 'loss returns net proceeds to cash')
assert(bot.stats.losses === 1, 'loss counted')
assert(Math.abs(bot.stats.nativeTakenUsd - pnl) < 1e-6, 'no sweep on loss')

// 4) Stop-style sweep: buy, then sweepAll — ALL proceeds go native
const nativeBefore = bot.stats.nativeTakenUsd
execBuy(bot, 10, 200, 'test buy 3')
const q3 = bot.position.qty
execSell(bot, 10, 1, 'manual stop', true, true)
const gross3 = q3 * 10
const fee4 = gas + gross3 * 0.0015
assert(Math.abs(bot.stats.nativeTakenUsd - nativeBefore - (gross3 - fee4)) < 1e-6, 'stop sweeps all proceeds to native')

assert(state.trades.length === 6, 'all trades recorded')
assert(state.trades.every((t) => t.feeUsd > 0), 'fees recorded on every trade')

console.log('✅ self-test passed: buy/sell accounting, profit sweep, loss handling, stop-sweep all correct')
process.exit(0)
