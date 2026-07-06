// Perpetual-futures domain: the PURE math + types behind leveraged long/short positions —
// sizing, isolated-margin liquidation, PnL, funding accrual, and the tp/stop/liquidation
// close logic. No I/O, no clock beyond an injected `now`, so every rule is unit-testable.
//
// PAPER-FIRST: the engine (perp-engine.ts) drives these with REAL mark prices + funding from
// Hyperliquid (perps-data.ts) but simulates the fills — no funds move. A PerpExecutor seam is
// defined so a real on-chain executor can slot in. The live one (Hyperliquid) uses
// testnet-verified order signing but stays FAIL-CLOSED behind two env gates (see liveExecutor).
import { signL1Action, buildOrderAction, formatPrice, formatSize } from './hyperliquid-sign.js'

export type PerpSide = 'long' | 'short'
export type PerpStatus = 'open' | 'closed'
export type PerpCloseReason = 'tp' | 'stop' | 'liquidated' | 'manual'

export interface PerpPosition {
  id: string
  symbol: string // BTC
  cgId: string // for the CoinGecko mark-price fallback
  side: PerpSide
  leverage: number
  marginUsd: number // collateral committed (isolated)
  notionalUsd: number // marginUsd × leverage, at entry
  entryPrice: number
  sizeCoin: number // notionalUsd ÷ entryPrice (position size in coin units)
  liqPrice: number // isolated liquidation price (estimate; fixed at open)
  takeProfit?: number
  stopLoss?: number
  status: PerpStatus
  closeReason?: PerpCloseReason
  openedAt: number
  lastTickAt: number // last funding-accrual time
  closedAt?: number
  closePrice?: number
  realizedPnlUsd?: number
  fundingPaidUsd: number // cumulative funding PAID (negative = received)
  feesUsd: number // cumulative taker fees (open + close)
  reason?: string
  source: 'manual' | 'signal'
  mode: 'paper' | 'live'
}

// Tunables. Hyperliquid uses tiered maintenance margins; a flat 0.5% is a documented
// approximation for the paper liquidation estimate. Taker fee ≈ 0.05% per side.
export const MAINTENANCE_MARGIN_RATE = 0.005
export const TAKER_FEE = 0.0005
export const MAX_LEVERAGE = 50
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const round = (v: number, dp = 6) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : 0)
const round2 = (v: number) => round(v, 2)

/** Isolated-margin liquidation price (estimate). Long liquidates as price falls, short as it
 *  rises; the maintenance margin pulls it slightly toward entry. Pure. */
export function liquidationPrice(side: PerpSide, entry: number, leverage: number, mmr = MAINTENANCE_MARGIN_RATE): number {
  const lev = Math.max(1, leverage)
  const move = 1 / lev - mmr // fraction of entry the price can move against you before liquidation
  return side === 'long' ? round(Math.max(0, entry * (1 - move))) : round(entry * (1 + move))
}

/** Gross (price-only) PnL in USD at `mark`, before fees + funding. Pure. */
export function grossPnl(pos: Pick<PerpPosition, 'side' | 'entryPrice' | 'sizeCoin'>, mark: number): number {
  const diff = mark - pos.entryPrice
  return (pos.side === 'long' ? diff : -diff) * pos.sizeCoin
}

/** Net unrealized PnL = gross − funding paid − fees booked so far. Pure. */
export function positionPnl(pos: PerpPosition, mark: number): number {
  return grossPnl(pos, mark) - pos.fundingPaidUsd - pos.feesUsd
}

/** Funding owed over `elapsedMs` at an hourly `rate` on `notionalUsd`. Positive funding ⇒ longs
 *  pay (cost > 0), shorts receive (cost < 0). Pure. */
export function fundingDelta(side: PerpSide, notionalUsd: number, hourlyRate: number, elapsedMs: number): number {
  if (!Number.isFinite(hourlyRate) || !Number.isFinite(notionalUsd) || elapsedMs <= 0) return 0
  const hours = elapsedMs / 3_600_000
  const cost = notionalUsd * hourlyRate * hours // long pays positive funding
  return round2(side === 'long' ? cost : -cost)
}

/** True when `mark` has reached the liquidation price for this side. Pure. */
export function isLiquidated(pos: Pick<PerpPosition, 'side' | 'liqPrice'>, mark: number): boolean {
  return pos.side === 'long' ? mark <= pos.liqPrice : mark >= pos.liqPrice
}

export interface OpenPerpInput {
  symbol: string
  cgId: string
  side: PerpSide
  leverage: number
  marginUsd: number
  takeProfit?: number
  stopLoss?: number
  reason?: string
  source?: 'manual' | 'signal'
  mode?: 'paper' | 'live'
}

/** Validate + construct a position from a market fill at `entryPrice`. Pure (id/now in). */
export function openPerp(input: OpenPerpInput, entryPrice: number, now: number, id: string): { position: PerpPosition } | { error: string } {
  const side = input.side
  if (side !== 'long' && side !== 'short') return { error: 'Pick a direction' }
  if (!(entryPrice > 0)) return { error: "Couldn't read the mark price — try again in a moment" }
  const leverage = Math.round(Number(input.leverage))
  if (!(leverage >= 1 && leverage <= MAX_LEVERAGE)) return { error: `Leverage must be between 1× and ${MAX_LEVERAGE}×` }
  const marginUsd = Number(input.marginUsd)
  // Number.isFinite rejects Infinity/NaN — `Infinity > 0` is true and would give an Infinity-size,
  // NaN-PnL position that corrupts stats and the payload. [finite-margin]
  if (!(Number.isFinite(marginUsd) && marginUsd > 0)) return { error: 'Margin must be a positive number' }

  const long = side === 'long'
  if (input.stopLoss !== undefined && input.stopLoss !== null) {
    if (!(input.stopLoss > 0) || (long ? input.stopLoss >= entryPrice : input.stopLoss <= entryPrice)) return { error: `Stop-loss must be ${long ? 'below' : 'above'} the entry (${entryPrice})` }
  }
  if (input.takeProfit !== undefined && input.takeProfit !== null) {
    if (!(input.takeProfit > 0) || (long ? input.takeProfit <= entryPrice : input.takeProfit >= entryPrice)) return { error: `Take-profit must be ${long ? 'above' : 'below'} the entry (${entryPrice})` }
  }

  const notionalUsd = marginUsd * leverage
  const sizeCoin = notionalUsd / entryPrice
  return {
    position: {
      id,
      symbol: input.symbol.toUpperCase(),
      cgId: input.cgId,
      side,
      leverage,
      marginUsd: round2(marginUsd),
      notionalUsd: round2(notionalUsd),
      entryPrice: round(entryPrice),
      sizeCoin: round(sizeCoin, 8),
      liqPrice: liquidationPrice(side, entryPrice, leverage),
      takeProfit: input.takeProfit ? round(input.takeProfit) : undefined,
      stopLoss: input.stopLoss ? round(input.stopLoss) : undefined,
      status: 'open',
      openedAt: now,
      lastTickAt: now,
      fundingPaidUsd: 0,
      feesUsd: round2(notionalUsd * TAKER_FEE), // taker fee on the opening fill
      reason: input.reason?.slice(0, 240),
      source: input.source === 'signal' ? 'signal' : 'manual',
      mode: input.mode === 'live' ? 'live' : 'paper',
    },
  }
}

/** Close a position at `price` for `reason`, booking the closing fee + realized PnL. Pure. */
export function closePerp(pos: PerpPosition, price: number, now: number, reason: PerpCloseReason): PerpPosition {
  if (pos.status === 'closed') return pos
  const closeNotional = pos.sizeCoin * price
  const feesUsd = round2(pos.feesUsd + closeNotional * TAKER_FEE)
  let realizedPnlUsd = round2(grossPnl(pos, price) - pos.fundingPaidUsd - feesUsd)
  // Isolated margin: a LIQUIDATION can never cost more than the posted margin — the shortfall
  // beyond it is a bankruptcy the venue's insurance fund absorbs, not the trader's loss. Clamp so
  // paper realized P&L (and thus equity / ROE) can't fall below −margin. [liq-loss-floor]
  if (reason === 'liquidated') realizedPnlUsd = Math.max(realizedPnlUsd, -pos.marginUsd)
  return { ...pos, status: 'closed', closeReason: reason, closedAt: now, closePrice: round(price), feesUsd, realizedPnlUsd }
}

/**
 * Advance a position against the current mark: liquidation first (worst case), then the stop,
 * then the take-profit. Returns a CLOSED copy on a hit, else the position unchanged. Funding
 * accrual is handled separately by the engine (it needs elapsed time). Pure. Idempotent once
 * closed.
 */
export function nextPerpState(pos: PerpPosition, mark: number, now: number): PerpPosition {
  if (pos.status === 'closed' || !(mark > 0)) return pos
  if (isLiquidated(pos, mark)) return closePerp(pos, pos.liqPrice, now, 'liquidated')
  // Funding-aware (equity) liquidation: isolated equity = margin + net PnL (incl. accrued funding
  // + fees). When it falls to the maintenance floor, liquidate at the current mark even if PRICE
  // never reached liqPrice — else a flat position bleeding funding rides below −100% ROE forever
  // without ever closing. The price-based check above fires FIRST on a real drop (closing at
  // liqPrice), so this only adds the funding-drain trigger; it doesn't change price-liq behavior.
  if (pos.marginUsd + positionPnl(pos, mark) <= pos.marginUsd * MAINTENANCE_MARGIN_RATE) return closePerp(pos, mark, now, 'liquidated')
  const long = pos.side === 'long'
  if (pos.stopLoss !== undefined && (long ? mark <= pos.stopLoss : mark >= pos.stopLoss)) return closePerp(pos, pos.stopLoss, now, 'stop')
  if (pos.takeProfit !== undefined && (long ? mark >= pos.takeProfit : mark <= pos.takeProfit)) return closePerp(pos, pos.takeProfit, now, 'tp')
  return pos
}

export interface PerpStats {
  open: number
  closed: number
  wins: number
  losses: number
  winRatePct: number | null
  realizedPnlUsd: number
  openMarginUsd: number
}

/** Aggregate realized performance over closed positions (+ open counts). Pure. */
export function summarizePerps(all: PerpPosition[]): PerpStats {
  const open = all.filter((p) => p.status === 'open')
  const closed = all.filter((p) => p.status === 'closed' && p.realizedPnlUsd !== undefined)
  const wins = closed.filter((p) => (p.realizedPnlUsd as number) > 0).length
  return {
    open: open.length,
    closed: closed.length,
    wins,
    losses: closed.length - wins,
    winRatePct: closed.length ? round(((wins / closed.length) * 100), 1) : null,
    realizedPnlUsd: round2(closed.reduce((s, p) => s + (p.realizedPnlUsd as number), 0)),
    openMarginUsd: round2(open.reduce((s, p) => s + p.marginUsd, 0)),
  }
}

// ── Executor seam (paper now; live = a gated stub pending testnet verification) ──────────
export interface PerpExecutor {
  readonly kind: 'paper' | 'live'
  readonly ready: boolean
  /** Return the fill price for a market open/close (paper: the mark). Throws if not ready. */
  fill(symbol: string, side: PerpSide, notionalUsd: number, mark: number): Promise<{ price: number }>
}

export const paperExecutor: PerpExecutor = {
  kind: 'paper',
  ready: true,
  async fill(_symbol, _side, _notionalUsd, mark) {
    return { price: mark } // simulated market fill at the mark
  },
}

// ── Live executor (Hyperliquid) ──────────────────────────────────────────────────────────
// The order SIGNING is verified against real testnet (`npm run verify:hyperliquid`). Live
// placement stays FAIL-CLOSED behind two env gates so it can never fire by accident:
//   HL_API_PRIVATE_KEY      — an APPROVED Hyperliquid API/agent wallet key (NOT your main key)
//   HL_ENABLE_LIVE_PERPS=true — explicit opt-in after you've confirmed on testnet
//   HL_TESTNET=false        — (optional) trade mainnet instead of the default testnet
const HL_TESTNET = process.env.HL_TESTNET !== 'false'
const HL_BASE = HL_TESTNET ? 'https://api.hyperliquid-testnet.xyz' : 'https://api.hyperliquid.xyz'
const HL_KEY = process.env.HL_API_PRIVATE_KEY as `0x${string}` | undefined
const liveReady = Boolean(HL_KEY && process.env.HL_ENABLE_LIVE_PERPS === 'true')

/** asset symbol → { index, szDecimals } from the venue's perp universe (cached 10 min). */
let assetCache: { at: number; map: Map<string, { index: number; szDecimals: number }> } | null = null
async function assetFor(symbol: string): Promise<{ index: number; szDecimals: number } | undefined> {
  if (!assetCache || Date.now() - assetCache.at > 600_000) {
    const res = await fetch(`${HL_BASE}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) })
    if (!res.ok) throw new Error(`Hyperliquid meta ${res.status}`)
    const data = (await res.json()) as { universe: { name: string; szDecimals: number }[] }
    const map = new Map<string, { index: number; szDecimals: number }>()
    data.universe.forEach((u, index) => map.set(u.name.toUpperCase(), { index, szDecimals: u.szDecimals }))
    assetCache = { at: Date.now(), map }
  }
  return assetCache.map.get(symbol.toUpperCase())
}

export const liveExecutor: PerpExecutor = {
  kind: 'live',
  get ready() {
    return liveReady
  },
  async fill(symbol, side, notionalUsd, mark) {
    // Fail closed when not explicitly enabled (keeps the gated message the tests assert on).
    if (!liveReady) throw new Error('Live perps execution is not enabled yet — set HL_API_PRIVATE_KEY + HL_ENABLE_LIVE_PERPS=true (verify first: npm run verify:hyperliquid)')
    if (!(mark > 0)) throw new Error('no live mark price for the order')
    const asset = await assetFor(symbol)
    if (!asset) throw new Error(`Hyperliquid has no perp market for ${symbol}`)
    const isBuy = side === 'long'
    const sz = formatSize(notionalUsd / mark, asset.szDecimals)
    // Aggressive IOC (5% through the mark) to take liquidity like a market order.
    const px = formatPrice(isBuy ? mark * 1.05 : mark * 0.95, asset.szDecimals)
    const action = buildOrderAction({ assetIndex: asset.index, isBuy, px, sz, tif: 'Ioc' })
    const nonce = Date.now()
    const signature = await signL1Action({ privateKey: HL_KEY!, action, nonce, isMainnet: !HL_TESTNET })
    const res = await fetch(`${HL_BASE}/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, nonce, signature, vaultAddress: null }) })
    const data = (await res.json()) as { status?: string; response?: { data?: { statuses?: { filled?: { avgPx: string }; error?: string }[] } } }
    if (data.status !== 'ok') throw new Error(`Hyperliquid rejected the order: ${JSON.stringify(data).slice(0, 200)}`)
    const st = data.response?.data?.statuses?.[0]
    if (st?.error) throw new Error(`Hyperliquid: ${st.error}`)
    const avgPx = Number(st?.filled?.avgPx)
    if (!(avgPx > 0)) throw new Error('Hyperliquid order did not fill (IOC, no liquidity at the limit)')
    return { price: avgPx }
  },
}

export const clampLeverage = (v: number): number => clamp(Math.round(Number(v) || 1), 1, MAX_LEVERAGE)
