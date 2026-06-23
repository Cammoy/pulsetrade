// Smart Money intelligence overview — the pure aggregation that feeds Gemini.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { computeOverview } = await import('../src/smart-insights.js')

const NOW = 1_750_000_000_000
const ev = (wallet: string, token: string, addr: string, side: 'buy' | 'sell', usd: number | null, ts: number) =>
  ({ wallet, label: wallet, network: 'ethereum', token, tokenAddress: addr, side, qty: 1, usd, ts, txHash: `${wallet}-${token}-${side}-${ts}`, curated: false })

test('computeOverview: nets buy/sell USD per token, ranks accumulating vs distributing', () => {
  const o = computeOverview(
    [
      ev('0xA', 'WETH', '0xweth', 'buy', 100_000, NOW - 1000),
      ev('0xB', 'WETH', '0xweth', 'buy', 50_000, NOW - 2000), // WETH net +150k, 2 buyers
      ev('0xA', 'LINK', '0xlink', 'sell', 80_000, NOW - 3000), // LINK net -80k (risk asset)
      ev('0xC', 'PEPE', '0xpepe', 'buy', 20_000, NOW - 4000), // PEPE net +20k
    ] as never,
    NOW,
  )
  assert.equal(o.accumulating[0].token, 'WETH', 'biggest net buy ranks first')
  assert.equal(o.accumulating[0].netUsd, 150_000)
  assert.equal(o.accumulating[0].buyers, 2, 'two distinct buyers')
  assert.equal(o.distributing[0].token, 'LINK')
  assert.equal(o.distributing[0].netUsd, -80_000)
  assert.equal(o.totalBuyUsd, 170_000)
  assert.equal(o.totalSellUsd, 80_000)
  assert.equal(o.netUsd, 90_000)
  assert.equal(o.activeWallets, 3)
  // cumulative flow trajectory ends at the running totals
  assert.ok(o.flowSeries.length >= 2)
  const last = o.flowSeries[o.flowSeries.length - 1]
  assert.equal(last.risk, 90_000, 'risk cumulative = net WETH+PEPE buys minus LINK sell')
  assert.equal(last.stable, 0, 'no stablecoin flow in this set')
})

test('computeOverview: stablecoins are a separate risk signal, not "accumulating"', () => {
  const o = computeOverview(
    [
      ev('0xA', 'USDC', '0xusdc', 'buy', 2_000_000, NOW - 1000), // moving INTO stables = risk-off
      ev('0xB', 'USDT', '0xusdt', 'buy', 500_000, NOW - 2000),
      ev('0xA', 'WETH', '0xweth', 'buy', 100_000, NOW - 3000), // the only real risk-asset buy
    ] as never,
    NOW,
  )
  assert.equal(o.stableNetUsd, 2_500_000, 'stable inflow tracked separately')
  assert.ok(!o.accumulating.some((f) => f.token === 'USDC' || f.token === 'USDT'), 'stables excluded from accumulating')
  assert.equal(o.accumulating[0].token, 'WETH', 'only the risk asset is "accumulating"')
})

test('computeOverview: excludes unpriced events and stale (out-of-window) activity', () => {
  const o = computeOverview(
    [
      ev('0xA', 'WETH', '0xweth', 'buy', 100_000, NOW - 1000), // in window, priced
      ev('0xA', 'SCAM', '0xscam', 'buy', null, NOW - 1000), // unpriced → excluded
      ev('0xA', 'OLD', '0xold', 'buy', 100_000, NOW - 40 * 86_400_000), // 40d ago → excluded (30d window)
    ] as never,
    NOW,
  )
  assert.equal(o.accumulating.length, 1, 'only the priced, recent token counts')
  assert.equal(o.accumulating[0].token, 'WETH')
})

test('computeOverview: emerging radar requires multi-whale consensus + repeat conviction', () => {
  const evs: ReturnType<typeof ev>[] = []
  // MOON: 2 distinct whales, one buys twice → consensus + repeat, KEEP
  evs.push(ev('0xA', 'MOON', '0xmoon', 'buy', null, NOW - 1000))
  evs.push(ev('0xA', 'MOON', '0xmoon', 'buy', null, NOW - 2000))
  evs.push(ev('0xB', 'MOON', '0xmoon', 'buy', null, NOW - 3000))
  // DROP: 3 whales, exactly one receive each → coordinated airdrop, REJECT (no repeat)
  evs.push(ev('0xA', 'DROP', '0xdrop', 'buy', null, NOW - 1000))
  evs.push(ev('0xB', 'DROP', '0xdrop', 'buy', null, NOW - 2000))
  evs.push(ev('0xC', 'DROP', '0xdrop', 'buy', null, NOW - 3000))
  // SOLO: 1 whale, 4 receives → single inbox is indistinguishable from spam, REJECT
  for (let i = 0; i < 4; i++) evs.push(ev('0xA', 'SOLO', '0xsolo', 'buy', null, NOW - i * 1000))
  // FLOOD: 1 whale, 50 receives → address-poisoning spam contract, REJECT
  for (let i = 0; i < 50; i++) evs.push(ev('0xA', 'FLOOD', '0xflood', 'buy', null, NOW - i * 100))
  // WETH is a major → never in the radar even with multi-whale repeat buys
  evs.push(ev('0xA', 'WETH', '0xweth', 'buy', null, NOW - 1000))
  evs.push(ev('0xB', 'WETH', '0xweth', 'buy', null, NOW - 2000))
  evs.push(ev('0xA', 'WETH', '0xweth', 'buy', null, NOW - 3000))

  const o = computeOverview(evs as never, NOW)
  const tokens = o.emerging.map((c) => c.token)
  assert.ok(tokens.includes('MOON'), 'multi-whale repeat conviction is surfaced')
  assert.ok(!tokens.includes('DROP'), 'one-receive-per-wallet airdrop is rejected (no repeat)')
  assert.ok(!tokens.includes('SOLO'), 'single-wallet inbound is rejected (no consensus)')
  assert.ok(!tokens.includes('FLOOD'), 'high-frequency flood spam is rejected')
  assert.ok(!tokens.includes('WETH'), 'blue-chip majors never appear in the new-coins radar')
  const moon = o.emerging.find((c) => c.token === 'MOON')!
  assert.equal(moon.buyers, 2)
  assert.equal(moon.buys, 3)
})

test('computeOverview: notable trades are the biggest individual fills (>= $5k)', () => {
  const o = computeOverview(
    [
      ev('GCR', 'WETH', '0xweth', 'buy', 500_000, NOW - 1000),
      ev('Cobie', 'LINK', '0xlink', 'sell', 9_000, NOW - 2000),
      ev('Tetra', 'UNI', '0xuni', 'buy', 1_000, NOW - 3000), // < $5k → not notable
    ] as never,
    NOW,
  )
  assert.equal(o.notable[0].wallet, 'GCR')
  assert.equal(o.notable[0].usd, 500_000)
  assert.ok(!o.notable.some((n) => n.token === 'UNI'), 'sub-$5k trade excluded from notable')
})
