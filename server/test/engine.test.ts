// Engine accounting + lifecycle. Uses DATA_DIR isolation and a mocked fetch
// so no network access happens; spot prices are seeded through the real
// getSpotPrices() path.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-engine-'))

const PRICES: Record<string, number> = { ethereum: 2000, chainlink: 10, 'polygon-ecosystem-token': 0.5, tether: 1 }

const { state, monthKey, flushNow } = await import('../src/store.js')
const { createBot, controlBot, deleteBot, inSchedule, serializeBot, __test } = await import('../src/engine.js')
const { getSpotPrices } = await import('../src/prices.js')
const { networkById } = await import('../src/networks.js')
const { execBuy, execSell } = __test

const SLIPPAGE = 0.0015
const gas = networkById('arbitrum')!.avgGasUsd
const approx = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} (${a} vs ${b})`)

before(async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { usd: v }]))), {
      status: 200,
    })) as typeof fetch
  await getSpotPrices(Object.keys(PRICES))
})

function freshBot(over: Partial<Parameters<typeof createBot>[0]> = {}) {
  const bot = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000, ...over })
  assert.ok(!('error' in bot), 'bot created')
  return bot
}

test('buy: cost basis includes the buy fee', () => {
  const bot = freshBot()
  execBuy(bot, 10, 500, 'test')
  const fee = gas + 500 * SLIPPAGE
  const qty = (500 - fee) / 10
  approx(bot.cashUsd, 500, 'cash')
  approx(bot.position.qty, qty, 'qty')
  approx(bot.position.avgCostUsd, 500 / qty, 'avg cost = dollars in / units (fee included)')
  approx(bot.position.costUsd, 500, 'cost bucket')
  assert.ok(bot.position.avgCostUsd > 10, 'basis is above fill price because of fees')
})

test('profitable sell: realized P&L is exact and profit sweeps to native', () => {
  const bot = freshBot()
  execBuy(bot, 10, 500, 'in')
  const qty = bot.position.qty
  execSell(bot, 11, 1, 'out', true)
  const gross = qty * 11
  const sellFee = gas + gross * SLIPPAGE
  const pnl = gross - sellFee - 500 // full round trip: everything in vs everything out
  approx(bot.stats.realizedUsd, pnl, 'realized = net proceeds − total cost (incl. both fees on basis side)')
  approx(bot.stats.nativeTakenUsd, pnl, 'profit swept')
  approx(bot.stats.nativeTakenQty, pnl / PRICES.ethereum, 'swept at the live ETH price')
  approx(bot.cashUsd, 1000, 'principal (incl. buy fee) returned to working cash')
  assert.equal(bot.position.qty, 0)
  assert.equal(bot.stats.wins, 1)
  assert.equal(bot.stats.losses, 0)
})

test('losing sell: no sweep, net proceeds return to cash, loss counted', () => {
  const bot = freshBot()
  execBuy(bot, 10, 500, 'in')
  const qty = bot.position.qty
  execSell(bot, 9, 1, 'out', true)
  const gross = qty * 9
  const sellFee = gas + gross * SLIPPAGE
  approx(bot.cashUsd, 500 + gross - sellFee, 'proceeds to cash')
  assert.equal(bot.stats.nativeTakenUsd, 0, 'no sweep on loss')
  assert.equal(bot.stats.losses, 1)
  approx(bot.stats.realizedUsd, gross - sellFee - 500, 'loss realized exactly')
})

test('partial sells: each rung counts a win and basis stays consistent', () => {
  const bot = freshBot({ strategy: 'grid' })
  execBuy(bot, 10, 300, 'rung 1')
  execBuy(bot, 9, 300, 'rung 2')
  const totalIn = 600
  approx(bot.position.avgCostUsd * bot.position.qty, totalIn, 'basis × qty = dollars in')
  const halfQty = bot.position.qty / 2
  execSell(bot, 12, 0.5, 'rung out', false)
  assert.equal(bot.stats.wins, 1, 'partial profitable sell counts a win')
  approx(bot.position.qty, halfQty, 'half remains')
  approx(bot.position.costUsd, totalIn / 2, 'half the basis remains')
  assert.ok(bot.position.openedAt !== null, 'position still open')
})

test('sweepTo usdt: profit sweeps to USDT at the tether price', () => {
  const bot = freshBot({ sweepTo: 'usdt' })
  execBuy(bot, 10, 500, 'in')
  const qty = bot.position.qty
  execSell(bot, 11, 1, 'out', true)
  const gross = qty * 11
  const sellFee = gas + gross * SLIPPAGE
  const pnl = gross - sellFee - 500
  approx(bot.stats.nativeTakenUsd, pnl, 'profit swept (USD value)')
  approx(bot.stats.nativeTakenQty, pnl / PRICES.tether, 'qty in USDT units')
  assert.equal(state.trades.at(-1)!.sweptNative!.symbol, 'USDT')
  approx(bot.cashUsd, 1000, 'principal returns to cash')
})

test('sweepTo usdt: stop & sweep liquidates everything to USDT', () => {
  const bot = freshBot({ sweepTo: 'usdt' })
  execBuy(bot, 10, 400, 'in')
  const qty = bot.position.qty
  controlBot(bot.id, 'stop')
  const gross = qty * PRICES.chainlink
  const fee = gas + gross * SLIPPAGE
  approx(bot.stats.nativeTakenUsd, gross - fee, 'everything swept')
  assert.equal(state.trades.at(-1)!.sweptNative!.symbol, 'USDT')
  assert.equal(bot.status, 'stopped')
})

test('createBot rejects an invalid sweepTo', () => {
  assert.ok('error' in createBot({ network: 'base', token: 'LINK', strategy: 'grid', risk: 'balanced', budgetUsd: 100, sweepTo: 'usdc' as any }))
})

test('stop & sweep: ALL proceeds convert to native and bot stops', () => {
  const bot = freshBot()
  execBuy(bot, 10, 400, 'in')
  const qty = bot.position.qty
  const out = controlBot(bot.id, 'stop')
  assert.ok(!('error' in out))
  const gross = qty * PRICES.chainlink
  const fee = gas + gross * SLIPPAGE
  approx(bot.stats.nativeTakenUsd, gross - fee, 'everything swept')
  assert.equal(bot.position.qty, 0)
  assert.equal(bot.status, 'stopped')
  assert.equal(state.trades.at(-1)!.sweptNative!.symbol, 'ETH')
})

test('equity identity: cash + position value + native taken = budget + total P&L', () => {
  const bot = freshBot()
  execBuy(bot, 10, 500, 'a')
  execSell(bot, 11, 0.4, 'b', false)
  execBuy(bot, 10.5, 200, 'c')
  execSell(bot, 9.8, 1, 'd', true)
  const price = 9.8
  const equity = bot.cashUsd + bot.position.qty * price + bot.stats.nativeTakenUsd
  const unrealized = bot.position.qty * (price - bot.position.avgCostUsd)
  approx(equity, bot.budgetUsd + bot.stats.realizedUsd + unrealized, 'no money created or lost in accounting')
})

test('monthly ledger: records realized, fees, volume, sweeps and per-risk P&L', () => {
  const m0 = structuredClone(state.monthly[monthKey(Date.now())] ?? null)
  const bot = freshBot({ risk: 'aggressive' })
  execBuy(bot, 10, 500, 'in')
  const qty = bot.position.qty
  execSell(bot, 11, 1, 'out', true)
  const gross = qty * 11
  const sellFee = gas + gross * SLIPPAGE
  const buyFee = gas + 500 * SLIPPAGE
  const pnl = gross - sellFee - 500
  const m = state.monthly[monthKey(Date.now())]
  approx(m.realizedUsd - (m0?.realizedUsd ?? 0), pnl, 'monthly realized')
  approx(m.feesUsd - (m0?.feesUsd ?? 0), buyFee + sellFee, 'monthly fees')
  approx(m.volumeUsd - (m0?.volumeUsd ?? 0), 500 + gross, 'monthly volume')
  approx(m.nativeTakenUsd - (m0?.nativeTakenUsd ?? 0), pnl, 'monthly native sweeps')
  approx((m.byRisk.aggressive ?? 0) - (m0?.byRisk?.aggressive ?? 0), pnl, 'attributed to the right tolerance')
  assert.equal(m.wins - (m0?.wins ?? 0), 1)
})

test('monthly ledger survives bot deletion (trades do not)', () => {
  const before = state.monthly[monthKey(Date.now())].realizedUsd
  const bot = freshBot()
  execBuy(bot, 10, 100, 'in')
  execSell(bot, 12, 1, 'out', true)
  const after = state.monthly[monthKey(Date.now())].realizedUsd
  assert.ok(after > before)
  deleteBot(bot.id)
  assert.equal(state.trades.filter((t) => t.botId === bot.id).length, 0, 'trades removed')
  assert.equal(state.monthly[monthKey(Date.now())].realizedUsd, after, 'ledger intact')
})

test('createBot validation rejects bad input', () => {
  assert.ok('error' in createBot({ network: 'nope', token: 'LINK', strategy: 'grid', risk: 'balanced', budgetUsd: 100 }))
  assert.ok('error' in createBot({ network: 'base', token: 'NOPE', strategy: 'grid', risk: 'balanced', budgetUsd: 100 }))
  assert.ok('error' in createBot({ network: 'base', token: 'LINK', strategy: 'nope' as any, risk: 'balanced', budgetUsd: 100 }))
  assert.ok('error' in createBot({ network: 'base', token: 'LINK', strategy: 'grid', risk: 'nope' as any, budgetUsd: 100 }))
  assert.ok('error' in createBot({ network: 'base', token: 'LINK', strategy: 'grid', risk: 'balanced', budgetUsd: 5 }))
  assert.ok('error' in createBot({ network: 'base', token: 'LINK', strategy: 'grid', risk: 'balanced', budgetUsd: NaN }))
  assert.ok(
    'error' in
      createBot({
        network: 'base', token: 'LINK', strategy: 'grid', risk: 'balanced', budgetUsd: 100,
        schedule: { enabled: true, days: [], startHour: 8, endHour: 20 },
      }),
    'empty schedule days rejected',
  )
  assert.ok(
    'error' in
      createBot({
        network: 'base', token: 'LINK', strategy: 'grid', risk: 'balanced', budgetUsd: 100,
        schedule: { enabled: true, days: [1], startHour: 9, endHour: 9 },
      }),
    'zero-width window rejected',
  )
})

test('pause / resume lifecycle', () => {
  const bot = freshBot()
  controlBot(bot.id, 'pause')
  assert.equal(bot.status, 'paused')
  controlBot(bot.id, 'resume')
  assert.equal(bot.status, 'running')
  assert.ok('error' in (controlBot('missing', 'pause') as any))
})

test('inSchedule: days, windows, overnight windows, disabled', () => {
  const mk = (enabled: boolean, days: number[], startHour: number, endHour: number) =>
    ({ schedule: { enabled, days, startHour, endHour } }) as any
  const mon10 = new Date(2026, 5, 8, 10) // Monday 10:00
  const mon23 = new Date(2026, 5, 8, 23)
  const tue3 = new Date(2026, 5, 9, 3)
  const sun12 = new Date(2026, 5, 7, 12)
  assert.equal(inSchedule(mk(true, [1], 9, 17), mon10), true, 'inside window')
  assert.equal(inSchedule(mk(true, [1], 9, 17), mon23), false, 'after hours')
  assert.equal(inSchedule(mk(true, [1], 9, 17), sun12), false, 'wrong day')
  assert.equal(inSchedule(mk(true, [1, 2], 22, 6), mon23), true, 'overnight: before midnight')
  assert.equal(inSchedule(mk(true, [1, 2], 22, 6), tue3), true, 'overnight: after midnight')
  assert.equal(inSchedule(mk(true, [1, 2], 22, 6), mon10), false, 'overnight: daytime excluded')
  assert.equal(inSchedule(mk(false, [], 0, 0), sun12), true, 'disabled schedule = always on')
})

test('serializeBot computes unrealized and total P&L from the live price', () => {
  const bot = freshBot()
  execBuy(bot, PRICES.chainlink, 500, 'in')
  const s = serializeBot(bot)
  const unreal = bot.position.qty * (PRICES.chainlink - bot.position.avgCostUsd)
  assert.ok(Math.abs(s.unrealizedUsd - unreal) < 1e-3)
  assert.ok(Math.abs(s.totalPnlUsd - (bot.stats.realizedUsd + unreal)) < 1e-3)
  assert.equal(s.priceUsd, PRICES.chainlink)
})

test('state persists and reloads byte-correct', async () => {
  flushNow()
  const reloaded = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR!, 'state.json'), 'utf8'))
  assert.equal(reloaded.bots.length, state.bots.length)
  assert.deepEqual(reloaded.monthly, state.monthly)
  assert.equal(reloaded.trades.length, state.trades.length)
})
