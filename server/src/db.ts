// Append-only SQLite trade ledger — the one piece of data that genuinely grows
// without bound and benefits from indexed queries (full history + per-token /
// per-strategy / date-range analytics without loading everything into memory).
//
// HYBRID DESIGN: state.json stays the source of truth for live mutable state
// (bots, settings, wallets, prefs, …). This DB is an additive, query-only ledger
// of every trade ever made. It is loaded LAZILY via node:sqlite (built into
// Node ≥22.5, zero native deps). On older Node the import fails gracefully and the
// engine runs exactly as before — only the unbounded history/analytics is off.

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import type { Trade } from './store.js'
import { DUST_PNL } from './pnl.js'

// node:sqlite is a built-in on Node ≥22.5. createRequire loads it SYNCHRONOUSLY
// (so recordTrade can stay sync in the tick loop) and throws on older Node → null.
let DatabaseSync: (new (p: string) => SqliteDb) | null = null
try {
  DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync
} catch {
  DatabaseSync = null // Node <22.5 — ledger disabled, JSON store unaffected
}

interface Stmt {
  run(...params: unknown[]): unknown
  all<T = Record<string, unknown>>(...params: unknown[]): T[]
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined
}
interface SqliteDb {
  exec(sql: string): void
  prepare(sql: string): Stmt
  close(): void
}

/** A row of the `trades` table. id/botId/ts/side are NOT NULL; the columns recordTrade
 *  always writes from a Trade are non-null too; only pnlUsd/sweptUsd are genuinely nullable. */
interface TradeRow {
  id: string
  botId: string
  ts: number
  side: 'buy' | 'sell'
  network: string
  token: string
  qty: number
  priceUsd: number
  usd: number
  feeUsd: number
  reason: string
  pnlUsd: number | null
  sweptUsd: number | null
  mode: 'paper' | 'live'
}

let db: SqliteDb | null = null
let insertStmt: Stmt | null = null

export const tradeDbReady = () => !!db

/** Open the ledger and ensure the schema. Idempotent. Returns whether SQLite is on. */
export function initTradeDb(dir: string): boolean {
  if (db) return true
  if (!DatabaseSync) {
    console.warn('[db] node:sqlite unavailable (needs Node ≥22.5) — trade ledger disabled; JSON store still active')
    return false
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    db = new DatabaseSync(path.join(dir, 'trades.db'))
    db.exec('PRAGMA journal_mode = WAL') // concurrent reads while the engine writes
    db.exec(`CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      botId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      side TEXT NOT NULL,
      network TEXT,
      token TEXT,
      qty REAL, priceUsd REAL, usd REAL, feeUsd REAL,
      reason TEXT, pnlUsd REAL, sweptUsd REAL, mode TEXT
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_trades_bot ON trades(botId)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(network, token)')
    insertStmt = db.prepare(`INSERT OR IGNORE INTO trades
      (id, botId, ts, side, network, token, qty, priceUsd, usd, feeUsd, reason, pnlUsd, sweptUsd, mode)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    return true
  } catch (e) {
    console.error('[db] SQLite init failed — trade ledger disabled', e)
    db = null
    return false
  }
}

/** Append one trade (INSERT OR IGNORE — re-recording the same id is a no-op).
 *  Never throws: persistence must not be able to break a trade execution. */
export function recordTrade(t: Trade): void {
  if (!insertStmt) return
  try {
    insertStmt.run(t.id, t.botId, t.ts, t.side, t.network, t.token, t.qty, t.priceUsd, t.usd, t.feeUsd, t.reason, t.pnlUsd ?? null, t.sweptNative?.usd ?? null, t.mode)
  } catch {
    /* ignore — the JSON store still has the recent window */
  }
}

/** Seed the ledger from the in-memory/JSON trades on startup (idempotent). */
export function backfillTrades(trades: Trade[]): number {
  if (!insertStmt) return 0
  for (const t of trades) recordTrade(t)
  return trades.length
}

export interface TradeQuery {
  botId?: string
  token?: string
  network?: string
  side?: 'buy' | 'sell'
  mode?: 'paper' | 'live'
  since?: number
  until?: number
  limit?: number
  offset?: number
}

function whereClause(q: TradeQuery): { sql: string; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  const add = (cond: string, val: unknown) => {
    where.push(cond)
    params.push(val)
  }
  if (q.botId) add('botId = ?', q.botId)
  if (q.token) add('token = ?', q.token)
  if (q.network) add('network = ?', q.network)
  if (q.side) add('side = ?', q.side)
  if (q.mode) add('mode = ?', q.mode)
  if (Number.isFinite(q.since)) add('ts >= ?', q.since)
  if (Number.isFinite(q.until)) add('ts <= ?', q.until)
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params }
}

/** Full trade history (newest first), filtered + paged. Empty when SQLite is off. */
export function queryTrades(q: TradeQuery = {}): Trade[] {
  if (!db) return []
  const { sql, params } = whereClause(q)
  const limit = Math.min(Math.max(1, Number(q.limit) || 200), 5000)
  const offset = Math.max(0, Number(q.offset) || 0)
  const rows = db.prepare(`SELECT * FROM trades ${sql} ORDER BY ts DESC LIMIT ? OFFSET ?`).all<TradeRow>(...params, limit, offset)
  return rows.map((r) => ({
    id: r.id, botId: r.botId, ts: r.ts, side: r.side, network: r.network, token: r.token,
    qty: r.qty, priceUsd: r.priceUsd, usd: r.usd, feeUsd: r.feeUsd, reason: r.reason,
    pnlUsd: r.pnlUsd ?? undefined, mode: r.mode,
    ...(r.sweptUsd != null ? { sweptNative: { qty: 0, symbol: '', usd: r.sweptUsd } } : {}),
  }))
}

export interface TradeStats {
  enabled: boolean
  count: number
  realizedUsd: number
  volumeUsd: number
  feesUsd: number
  wins: number
  losses: number
  firstTs: number | null
  lastTs: number | null
  byToken: { network: string; token: string; trades: number; realizedUsd: number; volumeUsd: number }[]
}

/** Aggregate analytics over the FULL ledger (what the in-memory window can't do). */
export function tradeStats(q: TradeQuery = {}): TradeStats {
  if (!db) return { enabled: false, count: 0, realizedUsd: 0, volumeUsd: 0, feesUsd: 0, wins: 0, losses: 0, firstTs: null, lastTs: null, byToken: [] }
  const { sql, params } = whereClause(q)
  const tot = db.prepare(`SELECT
      COUNT(*) c,
      COALESCE(SUM(pnlUsd),0) pnl,
      COALESCE(SUM(usd),0) vol,
      COALESCE(SUM(feeUsd),0) fees,
      COALESCE(SUM(CASE WHEN side='sell' AND pnlUsd>${DUST_PNL} THEN 1 ELSE 0 END),0) wins,
      COALESCE(SUM(CASE WHEN side='sell' AND pnlUsd<${-DUST_PNL} THEN 1 ELSE 0 END),0) losses,
      MIN(ts) firstTs, MAX(ts) lastTs
    FROM trades ${sql}`).get<{ c: number; pnl: number; vol: number; fees: number; wins: number; losses: number; firstTs: number | null; lastTs: number | null }>(...params)
    ?? { c: 0, pnl: 0, vol: 0, fees: 0, wins: 0, losses: 0, firstTs: null, lastTs: null } // a single-row aggregate is never undefined, but satisfy the optional
  const byToken = db.prepare(`SELECT network, token, COUNT(*) trades,
      COALESCE(SUM(pnlUsd),0) realizedUsd, COALESCE(SUM(usd),0) volumeUsd
    FROM trades ${sql} GROUP BY network, token ORDER BY realizedUsd DESC LIMIT 50`).all<{ network: string; token: string; trades: number; realizedUsd: number; volumeUsd: number }>(...params)
  return {
    enabled: true,
    count: tot.c,
    realizedUsd: +Number(tot.pnl).toFixed(2),
    volumeUsd: +Number(tot.vol).toFixed(2),
    feesUsd: +Number(tot.fees).toFixed(2),
    wins: tot.wins,
    losses: tot.losses,
    firstTs: tot.firstTs ?? null,
    lastTs: tot.lastTs ?? null,
    byToken: byToken.map((r) => ({ network: r.network, token: r.token, trades: r.trades, realizedUsd: +Number(r.realizedUsd).toFixed(2), volumeUsd: +Number(r.volumeUsd).toFixed(2) })),
  }
}
