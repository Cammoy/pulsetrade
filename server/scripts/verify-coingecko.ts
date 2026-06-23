// One-off verification that COINGECKO_API_KEY is wired and working — READ-ONLY (fetches public
// market data only, moves nothing). Confirms the key is attached to outbound requests and that
// HISTORICAL pricing — which powers Copy Trading's realized-P&L scoring + trader discovery —
// succeeds under a small burst that the keyless public tier would 429. Run: `npm run verify:coingecko`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Load server/.env exactly like the engine does (existing env wins).
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
try {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
} catch {
  /* no server/.env — fall back to ambient env */
}

async function main() {
  const { cgHeaders, getCandles, historicalSeries } = await import('../src/prices.js')
  const key = process.env.COINGECKO_API_KEY || ''
  const header = Object.keys(cgHeaders()).find((k) => k.startsWith('x-cg'))
  console.log(`key: ${key ? `set (${key.length} chars)` : 'NOT SET'} | mode: ${process.env.COINGECKO_PRO === 'true' ? 'pro' : 'demo'} | request header: ${header ?? 'NONE'}`)
  if (!key) {
    console.error('✗ COINGECKO_API_KEY is empty — set it in server/.env')
    process.exit(1)
  }
  if (!header) {
    console.error('✗ key is not attached to requests')
    process.exit(1)
  }

  // 1) A single historical series must return data — this is exactly what realized-P&L re-prices against.
  const btc = await getCandles('bitcoin', 365)
  console.log(`bitcoin 365d daily candles: ${btc.length} ${btc.length ? '✓' : '✗ EMPTY'}`)

  // 2) A burst of distinct coins — the keyless public tier 429s here; a working key sails through.
  const coins = ['ethereum', 'chainlink', 'aerodrome-finance', 'uniswap', 'aave', 'solana']
  const series = await Promise.all(coins.map((c) => historicalSeries(c)))
  const ok = series.filter((s) => s.length > 0).length
  console.log(`burst historical pricing: ${ok}/${coins.length} coins returned data`)

  const pass = btc.length > 0 && ok === coins.length
  console.log(pass
    ? '\n✅ CoinGecko key works — realized-P&L scoring + discovery are unthrottled.'
    : '\n✗ pricing incomplete — check the key and its tier (a PAID Pro key needs COINGECKO_PRO=true).')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
