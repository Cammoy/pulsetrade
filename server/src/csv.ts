// CSV export of the trade ledger for accounting / taxes. Pure + dependency-free: turns the
// canonical Trade rows into a spreadsheet-ready CSV (RFC-4180 quoting, ISO timestamps, raw
// numeric fields so a spreadsheet parses them as numbers). Realized P&L is the per-sell
// figure already computed by the engine; buys leave it blank.

import type { Trade } from './store.js' // type-only — erased at runtime

export const TRADE_CSV_HEADERS = ['Date (UTC)', 'Mode', 'Side', 'Network', 'Token', 'Quantity', 'Price USD', 'Value USD', 'Fee USD', 'Realized PnL USD', 'Reason', 'Trade ID'] as const

/** RFC-4180 field escaping + CSV-injection defense: neutralize any cell a spreadsheet would
 *  parse as a formula (leading = + - @, tab or CR) by prefixing a single quote — EXCEPT a plain
 *  negative/positive number, which is left intact so it still parses numerically. Token symbols
 *  (incl. attacker-chosen sniped-token metadata) and reasons flow into cells, so `=HYPERLINK(…)`
 *  / `=cmd|…` must not execute when the export is opened in Excel/Sheets. Then wrap in quotes +
 *  double interior quotes when the (possibly prefixed) value needs it. */
function esc(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  const looksFormula = /^[=+\-@\t\r]/.test(s) && !(s !== '' && Number.isFinite(Number(s)))
  const body = looksFormula ? `'${s}` : s
  return /[",\n\r]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body
}

const iso = (ts: number): string => (Number.isFinite(ts) ? new Date(ts).toISOString() : '')
const numCell = (v: number | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '')

/** Serialize trades to a CSV string (header + CRLF rows). Pure. */
export function tradesToCsv(trades: Trade[]): string {
  const lines = [TRADE_CSV_HEADERS.join(',')]
  for (const t of trades) {
    lines.push(
      [iso(t.ts), t.mode, t.side, t.network, t.token, numCell(t.qty), numCell(t.priceUsd), numCell(t.usd), numCell(t.feeUsd), numCell(t.pnlUsd), t.reason, t.id]
        .map(esc)
        .join(','),
    )
  }
  return lines.join('\r\n') + '\r\n'
}
