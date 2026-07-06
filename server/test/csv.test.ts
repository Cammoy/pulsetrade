// Trade CSV export: the pure serializer + the /api/export/trades.csv route (driven over a
// real loopback server, DB not initialized → in-memory `state.trades` fallback).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-csv-'))

const { tradesToCsv, TRADE_CSV_HEADERS } = await import('../src/csv.js')
const { createApp } = await import('../src/app.js')
const { state } = await import('../src/store.js')
type Trade = import('../src/store.js').Trade

const tr = (o: Partial<Trade>): Trade => ({ id: 'id', botId: 'b', ts: 0, side: 'buy', network: 'base', token: 'ETH', qty: 1, priceUsd: 100, usd: 100, feeUsd: 0.1, reason: 'x', mode: 'paper', ...o })

// ── pure ────────────────────────────────────────────────────────────────────

test('tradesToCsv: header row + one row per trade, ISO date, blank PnL on buys', () => {
  const csv = tradesToCsv([
    tr({ id: 't1', ts: Date.parse('2026-01-02T03:04:05Z'), side: 'buy', token: 'ETH', qty: 0.5, priceUsd: 2000, usd: 1000, feeUsd: 1.5, reason: 'entry' }),
    tr({ id: 't2', ts: Date.parse('2026-01-03T00:00:00Z'), side: 'sell', token: 'ETH', qty: 0.5, priceUsd: 2200, usd: 1100, feeUsd: 1.6, reason: 'take profit', pnlUsd: 97.9, mode: 'live' }),
  ])
  const lines = csv.trimEnd().split('\r\n')
  assert.equal(lines[0], TRADE_CSV_HEADERS.join(','))
  assert.equal(lines.length, 3)
  assert.ok(lines[1].startsWith('2026-01-02T03:04:05.000Z,paper,buy,base,ETH,0.5,2000,1000,1.5,,'), lines[1])
  assert.ok(lines[1].endsWith(',entry,t1'))
  // sell carries realized PnL
  assert.ok(lines[2].includes(',97.9,'))
  assert.ok(lines[2].includes(',live,sell,'))
})

test('tradesToCsv: RFC-4180 quoting for commas / quotes / newlines in the reason', () => {
  const csv = tradesToCsv([tr({ id: 't', reason: 'EMA 9 > 21, "confirmed"\nuptrend' })])
  const row = csv.trimEnd().split('\r\n')[1]
  assert.ok(row.includes('"EMA 9 > 21, ""confirmed""\nuptrend"'), row)
})

test('tradesToCsv: empty input still emits the header', () => {
  assert.equal(tradesToCsv([]).trimEnd(), TRADE_CSV_HEADERS.join(','))
})

test('tradesToCsv: neutralizes spreadsheet formula injection in token / reason cells', () => {
  // A sniped token symbol comes from on-chain metadata (attacker-controlled). A leading =/+/@ (or a
  // -expr) must be prefixed with a quote so Excel/Sheets shows it as text, never executes it.
  const csv = tradesToCsv([
    tr({ id: 't', token: '=HYPERLINK("http://evil","x")', reason: '@SUM(A1:A9)' }),
  ])
  const row = csv.trimEnd().split('\r\n')[1]
  // token contains a comma+quotes → RFC-quoted, and the interior starts with '= after neutralizing.
  assert.ok(row.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), row)
  assert.ok(row.includes(`'@SUM(A1:A9)`), row)
  assert.ok(!/,=HYPERLINK/.test(row), 'raw =HYPERLINK must not appear unescaped')
})

test('tradesToCsv: a negative number cell stays numeric (not quote-prefixed)', () => {
  // The formula guard must not corrupt legitimate negative P&L into text.
  const row = tradesToCsv([tr({ id: 't', side: 'sell', pnlUsd: -12.5 })]).trimEnd().split('\r\n')[1]
  assert.ok(row.includes(',-12.5,'), row)
  assert.ok(!row.includes(`'-12.5`), 'negative number must not be prefixed with a quote')
})

// ── route ─────────────────────────────────────────────────────────────────────

let srv: Server, base: string
before(async () => {
  state.trades = [tr({ id: 'p1', mode: 'paper', token: 'ETH' }), tr({ id: 'l1', mode: 'live', token: 'BTC' })]
  const app = createApp(undefined) // no token → reads are open
  await new Promise<void>((resolve) => {
    srv = createServer(app)
    srv.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
      resolve()
    })
  })
})
after(() => srv?.close())

test('GET /api/export/trades.csv downloads a CSV (right headers, filtered by mode)', async () => {
  const res = await fetch(`${base}/api/export/trades.csv?mode=paper`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/)
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="pulsetrade-trades-paper\.csv"/)
  const body = await res.text()
  assert.ok(body.startsWith(TRADE_CSV_HEADERS.join(',')))
  assert.ok(body.includes(',ETH,'), 'includes the paper ETH trade')
  assert.ok(!body.includes(',BTC,'), 'excludes the live BTC trade when mode=paper')
})
