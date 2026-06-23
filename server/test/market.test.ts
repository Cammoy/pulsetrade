// Market overview: pure signal/status math + the endpoint shape (fetch mocked).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-market-'))

const { technicalSignal, marketStatus, downsample, marketOverview, assignLanes, isStableLike, looksStable } = await import('../src/market.js')

type MC = import('../src/market.js').MarketCoin
const coin = (over: Partial<MC>): MC => ({
  id: over.id ?? over.symbol ?? 'x',
  symbol: over.symbol ?? 'X',
  name: over.name ?? 'Coin',
  image: null,
  priceUsd: 1,
  change1h: null,
  change24h: over.change24h ?? 0,
  change7d: over.change7d ?? 0,
  marketCapUsd: over.marketCapUsd ?? 1e9,
  marketCapRank: over.marketCapRank ?? null,
  volume24hUsd: over.volume24hUsd ?? 5_000_000, // liquid by default; a dead coin sets this sub-floor

  athChangePct: null,
  volToMcap: over.volToMcap ?? 0.05,
  rsi: over.rsi ?? null,
  stable: over.stable ?? false,
  sparkline7d: [],
  signal: over.signal ?? { action: 'hold', score: 0, reasons: [] },
})

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

test('isStableLike: stablecoins and wrapped natives are flagged, real coins are not', () => {
  assert.ok(isStableLike('USDC') && isStableLike('weth') && isStableLike('WSTETH'))
  assert.ok(!isStableLike('BTC') && !isStableLike('ETH') && !isStableLike('PEPE'))
})

test('assignLanes: ranks movement lanes, excludes stables + sub-floor micro-caps', () => {
  const coins = [
    coin({ id: 'big', symbol: 'BTC', marketCapUsd: 2e12, change24h: 1 }), // topcap anchor
    coin({ id: 'gain', symbol: 'GAIN', change24h: 22, marketCapUsd: 1e9 }),
    coin({ id: 'gain2', symbol: 'GAIN2', change24h: 12, marketCapUsd: 1e9 }),
    coin({ id: 'lose', symbol: 'LOSE', change24h: -18, marketCapUsd: 1e9 }),
    coin({ id: 'churn', symbol: 'CHURN', change24h: 2, volToMcap: 0.9, marketCapUsd: 1e9 }),
    coin({ id: 'ovsld', symbol: 'OVSLD', change7d: -12, volToMcap: 0.06, marketCapUsd: 1e9, rsi: 24, signal: { action: 'buy', score: 45, reasons: ['RSI 24 — oversold'] } }),
    coin({ id: 'stable', symbol: 'USDC', change24h: 40, marketCapUsd: 3e10, stable: true }), // huge mover but a stablecoin
    coin({ id: 'micro', symbol: 'MICRO', change24h: 90, marketCapUsd: 1e6 }), // below the $50M floor
  ]
  const lanes = assignLanes(coins)
  assert.equal(lanes.topcap[0], 'big', 'first by market cap anchors top-cap')
  assert.deepEqual(lanes.gainers.slice(0, 2), ['gain', 'gain2'], 'gainers ranked by 24h desc')
  assert.ok(!lanes.gainers.includes('stable'), 'stablecoin excluded from gainers despite +40%')
  assert.ok(!lanes.gainers.includes('micro'), 'sub-$50M micro-cap excluded despite +90%')
  assert.deepEqual(lanes.losers, ['lose'], 'losers are the negative movers')
  assert.equal(lanes.inplay[0], 'churn', 'highest turnover leads in-play')
  assert.deepEqual(lanes.oversold, ['ovsld'], 'technical-buy + down-7d + liquid = oversold')
})

test('assignLanes: a DEAD coin (sub-floor 24h volume) is excluded from the movement lanes', () => {
  const coins = [
    coin({ id: 'live', symbol: 'LIVE', change24h: 8, marketCapUsd: 2e9, volume24hUsd: 5e7 }),
    coin({ id: 'dead', symbol: 'DEAD', change24h: 40, marketCapUsd: 2e9, volume24hUsd: 50_000 }), // biggest mover, dead tape
  ]
  const lanes = assignLanes(coins)
  assert.ok(lanes.gainers.includes('live'), 'the liquid gainer is recommended')
  assert.ok(!lanes.gainers.includes('dead'), 'a +40% pump on dead volume never appears as a gainer')
})

test('assignLanes: oversold is a real low-RSI read, ranked most-oversold first', () => {
  const coins = [
    coin({ id: 'mom', symbol: 'MOM', change7d: -4, volToMcap: 0.1, rsi: 68 }), // down a bit but RSI high → not oversold
    coin({ id: 'os', symbol: 'OS', change7d: -9, volToMcap: 0.1, rsi: 28 }), // genuinely oversold
    coin({ id: 'deep', symbol: 'DEEP', change7d: -20, volToMcap: 0.1, rsi: 18 }), // even more oversold
    coin({ id: 'up', symbol: 'UP', change7d: 8, volToMcap: 0.1, rsi: 22 }), // oversold but UP on the week → excluded
  ]
  assert.deepEqual(assignLanes(coins).oversold, ['deep', 'os'], 'lowest RSI first, up-on-week excluded')
})

test('looksStable: pegged dollar-named coins outside the hardcoded set are still caught', () => {
  assert.ok(isStableLike('USDC'), 'known stable')
  assert.ok(looksStable('RUSD', 'Royal Dollar', 1.0), 'pegged dollar coin not in the set')
  assert.ok(looksStable('USDX', 'USDX', 0.999))
  assert.ok(!looksStable('TRUMP', 'Official Trump', 2.05), 'a $2 non-dollar coin is not stable')
  assert.ok(!looksStable('AUSD', 'Aave Token', 4.2), 'usd-substring but far off peg → not stable')
  assert.ok(!looksStable('BTC', 'Bitcoin', 65000))
})

test('marketOverview assembles global stats, fear & greed, and per-coin signals', async () => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('/global'))
      return new Response(JSON.stringify({ data: { total_market_cap: { usd: 3.1e12 }, market_cap_change_percentage_24h_usd: 1.8, total_volume: { usd: 9e10 }, market_cap_percentage: { btc: 55.2, eth: 12.1 }, active_cryptocurrencies: 17000 } }), { status: 200 })
    if (u.includes('alternative.me'))
      return new Response(JSON.stringify({ data: [{ value: '72', value_classification: 'Greed' }] }), { status: 200 })
    if (u.includes('coins/markets')) {
      // Enrichment pull for out-of-top-250 trending ids: 'newthing' is liquid (kept),
      // 'deadcoin' has zero 24h volume (must be dropped by the trending floor). [R5]
      if (u.includes('ids=')) {
        const body: any[] = []
        if (u.includes('newthing')) body.push({ id: 'newthing', symbol: 'new', name: 'New Thing', image: 'new.png', market_cap_rank: 400, current_price: 0.42, price_change_percentage_24h_in_currency: 18, market_cap: 1e8, total_volume: 5e6, sparkline_in_7d: { price: Array.from({ length: 168 }, (_, i) => 0.4 + i * 0.0002) } })
        if (u.includes('deadcoin')) body.push({ id: 'deadcoin', symbol: 'dead', name: 'Dead Coin', current_price: 1e-7, price_change_percentage_24h_in_currency: 0, market_cap: 0, total_volume: 0, sparkline_in_7d: { price: [] } })
        return new Response(JSON.stringify(body), { status: 200 })
      }
      return new Response(JSON.stringify([
        { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: 'btc.png', market_cap_rank: 1, current_price: 100000, price_change_percentage_1h_in_currency: 0.3, price_change_percentage_24h_in_currency: 2.5, price_change_percentage_7d_in_currency: 6, market_cap: 2e12, total_volume: 4e10, ath_change_percentage: -12, sparkline_in_7d: { price: Array.from({ length: 168 }, (_, i) => 95000 + i * 40 + Math.sin(i) * 200) } },
        { id: 'ethereum', symbol: 'eth', name: 'Ethereum', image: 'eth.png', market_cap_rank: 2, current_price: 4000, price_change_percentage_24h_in_currency: -1.2, price_change_percentage_7d_in_currency: -3, market_cap: 5e11, total_volume: 2e10, ath_change_percentage: -40, sparkline_in_7d: { price: Array.from({ length: 168 }, (_, i) => 4200 - i * 1.5) } },
      ]), { status: 200 })
    }
    if (u.includes('search/trending'))
      return new Response(JSON.stringify({ coins: [
        { item: { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1 } }, // in the pull → hydrated full
        { item: { id: 'newthing', symbol: 'new', name: 'New Thing', thumb: 'new.png', market_cap_rank: 400, data: { price: 0.42, price_change_percentage_24h: { usd: 18 } } } }, // outside pull, liquid → enriched + kept
        { item: { id: 'deadcoin', symbol: 'dead', name: 'Dead Coin', market_cap_rank: 9000, data: { price: 1e-7 } } }, // outside pull, zero volume → DROPPED
      ] }), { status: 200 })
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
  // enriched fields
  assert.equal(o.coins[0].image, 'btc.png')
  assert.equal(o.coins[0].marketCapRank, 1)
  assert.equal(o.coins[0].change1h, 0.3)
  assert.equal(o.coins[0].athChangePct, -12)
  assert.ok(Math.abs((o.coins[0].volToMcap ?? 0) - 0.02) < 1e-9, 'volToMcap = volume / market cap')
  assert.equal(typeof o.coins[0].rsi, 'number', 'RSI computed from the sparkline')
  assert.ok((o.coins[1].rsi ?? 100) < 35, 'falling ETH is oversold by RSI')
  assert.equal(typeof o.backoffMs, 'number')
  // lanes computed server-side
  assert.ok(o.lanes.topcap.includes('bitcoin'), 'btc in top-cap lane')
  assert.ok(o.lanes.gainers.includes('bitcoin') && o.lanes.losers.includes('ethereum'), 'movers split by 24h direction')
  // trending: in-pull coin hydrated; an out-of-pull LIQUID coin is enriched + kept;
  // an out-of-pull ZERO-VOLUME coin is DROPPED (never recommended). [R5]
  assert.equal(o.trending.length, 2, 'dead/zero-volume trending coin is dropped')
  assert.equal(o.trending[0].id, 'bitcoin')
  assert.ok(o.trending[0].sparkline7d.length > 2, 'hydrated trending coin keeps its sparkline')
  assert.ok(!o.trending.some((t) => t.id === 'deadcoin'), 'zero-volume trending coin never surfaces')
  const newish = o.trending.find((t) => t.id === 'newthing')!
  assert.ok(newish, 'liquid out-of-pull trending coin is enriched and kept')
  assert.equal(newish.priceUsd, 0.42)
  assert.equal(newish.change24h, 18)
  assert.ok((newish.volume24hUsd ?? 0) >= 250_000, 'enriched trending coin has a verified 24h volume')
  assert.equal(newish.marketCapUsd, 1e8, 'enriched from a real market row, not the pre-formatted trending string')
  assert.ok(['risk-on', 'neutral', 'risk-off'].includes(o.status.label))
  assert.ok(o.status.blurb.length > 20)
  // cached on second call (no refetch) — flip fetch to a bomb and re-call
  globalThis.fetch = (async () => { throw new Error('no refetch expected') }) as typeof fetch
  const o2 = await marketOverview()
  assert.equal(o2.at, o.at)
})
