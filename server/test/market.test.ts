// Market overview: pure signal/status math + the endpoint shape (fetch mocked).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-market-'))

const { technicalSignal, marketStatus, downsample, marketOverview } = await import('../src/market.js')

const rising = Array.from({ length: 60 }, (_, i) => 100 + i * 2) // strong uptrend
const falling = Array.from({ length: 60 }, (_, i) => 220 - i * 2) // strong downtrend
const flat = Array.from({ length: 60 }, () => 100)

test('technicalSignal: strong downtrends say sell… until oversold flips the read', () => {
  const sell = technicalSignal(falling.slice(0, 40))
  // a pure downtrend is eventually deeply oversold (RSI 0 adds +35), so the
  // verdict is hold-or-sell, never buy — and the reasons say why
  assert.notEqual(sell.action, 'buy')
  assert.ok(sell.reasons.some((r) => /downtrend/.test(r)))
})

const gentle = Array.from({ length: 60 }, (_, i) => 100 + i * 0.6 + Math.sin(i / 2) * 4)

test('technicalSignal: steady uptrend without overbought → buy', () => {
  const sig = technicalSignal(gentle)
  assert.equal(sig.action, 'buy')
  assert.ok(sig.score >= 30)
  assert.ok(sig.reasons.some((r) => /uptrend/.test(r)))
})

test('technicalSignal: overbought spike scores lower than a healthy trend', () => {
  const healthy = technicalSignal(gentle)
  const blowoff = technicalSignal(rising) // RSI ~100 → −35
  assert.ok(blowoff.score < healthy.score, 'overbought penalty applies')
})

test('technicalSignal: flat tape and short series → hold (no degenerate RSI lies)', () => {
  const f = technicalSignal(flat)
  assert.equal(f.action, 'hold')
  assert.equal(f.score, 0)
  assert.deepEqual(f.reasons, ['flat — no meaningful movement'])
  assert.equal(technicalSignal([1, 2, 3]).action, 'hold')
  assert.deepEqual(technicalSignal([1, 2, 3]).reasons, ['not enough history'])
})

test('marketStatus: breadth + sentiment compose into a labelled regime', () => {
  const up = Array.from({ length: 20 }, () => ({ change24h: 2 }))
  const down = Array.from({ length: 20 }, () => ({ change24h: -2 }))
  assert.equal(marketStatus(up, 80).label, 'risk-on')
  assert.equal(marketStatus(down, 15).label, 'risk-off')
  const mixed = [...up.slice(0, 10), ...down.slice(0, 10)]
  assert.equal(marketStatus(mixed, 50).label, 'neutral')
  // missing sentiment defaults to 50, missing prices to 50% breadth
  assert.equal(marketStatus([], null).composite, 50)
})

test('downsample keeps endpoints and caps length', () => {
  const big = Array.from({ length: 168 }, (_, i) => i)
  const small = downsample(big, 48)
  assert.equal(small.length, 48)
  assert.equal(small[0], 0)
  assert.equal(small[small.length - 1], 167)
  assert.deepEqual(downsample([1, 2, 3], 48), [1, 2, 3])
})

test('marketOverview assembles global stats, fear & greed, and per-coin signals', async () => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('/global'))
      return new Response(JSON.stringify({ data: { total_market_cap: { usd: 3.1e12 }, market_cap_change_percentage_24h_usd: 1.8, total_volume: { usd: 9e10 }, market_cap_percentage: { btc: 55.2, eth: 12.1 }, active_cryptocurrencies: 17000 } }), { status: 200 })
    if (u.includes('alternative.me'))
      return new Response(JSON.stringify({ data: [{ value: '72', value_classification: 'Greed' }] }), { status: 200 })
    if (u.includes('coins/markets'))
      return new Response(JSON.stringify([
        { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 100000, price_change_percentage_24h_in_currency: 2.5, price_change_percentage_7d_in_currency: 6, market_cap: 2e12, total_volume: 4e10, sparkline_in_7d: { price: Array.from({ length: 168 }, (_, i) => 95000 + i * 40 + Math.sin(i) * 200) } },
        { id: 'ethereum', symbol: 'eth', name: 'Ethereum', current_price: 4000, price_change_percentage_24h_in_currency: -1.2, price_change_percentage_7d_in_currency: -3, market_cap: 5e11, total_volume: 2e10, sparkline_in_7d: { price: Array.from({ length: 168 }, (_, i) => 4200 - i * 1.5) } },
      ]), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  const o = await marketOverview()
  assert.equal(o.global.marketCapUsd, 3.1e12)
  assert.equal(o.global.btcDominancePct, 55.2)
  assert.equal(o.fearGreed!.value, 72)
  assert.equal(o.coins.length, 2)
  assert.equal(o.coins[0].symbol, 'BTC')
  assert.ok(o.coins[0].sparkline7d.length <= 48, 'sparkline downsampled')
  assert.equal(o.coins[0].signal.action, 'buy', 'rising BTC reads as buy')
  assert.notEqual(o.coins[1].signal.action, 'buy', 'falling ETH is not a buy')
  assert.ok(['risk-on', 'neutral', 'risk-off'].includes(o.status.label))
  assert.ok(o.status.blurb.length > 20)
  // cached on second call (no refetch) — flip fetch to a bomb and re-call
  globalThis.fetch = (async () => { throw new Error('no refetch expected') }) as typeof fetch
  const o2 = await marketOverview()
  assert.equal(o2.at, o.at)
})
