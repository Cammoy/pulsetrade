// The paper perps engine: opens/closes leveraged long/short positions, marks them every tick
// against REAL Hyperliquid prices (perps-data.ts), accrues funding, and closes on take-profit,
// stop, or liquidation — all simulated, no funds moved. State lives in state.perps (persisted).
// The live executor is gated (perps.ts), so `mode:'live'` fails closed until it's verified.

import { state, save, uid } from './store.js'
import { broadcast } from './broadcast.js'
import { getSpotPrices } from './prices.js'
import { refreshPerpMarkets, markPriceFor, fundingFor } from './perps-data.js'
import {
  openPerp,
  closePerp,
  nextPerpState,
  fundingDelta,
  positionPnl,
  summarizePerps,
  paperExecutor,
  liveExecutor,
  clampLeverage,
  type PerpPosition,
  type OpenPerpInput,
} from './perps.js'

const MAX_OPEN = 50
const CLOSED_CAP = 50
const round = (v: number, dp = 6) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : 0)
const round2 = (v: number) => round(v, 2)
const round1 = (v: number) => round(v, 1)

const all = (): PerpPosition[] => (state.perps ??= [])
const openOnes = () => all().filter((p) => p.status === 'open')

/** A position plus the live, server-computed display fields the web renders. */
export interface SerializedPerp extends PerpPosition {
  markPrice: number
  unrealizedPnlUsd: number
  roePct: number // return on margin
}

function serialize(pos: PerpPosition): SerializedPerp {
  if (pos.status === 'closed') {
    const roe = pos.marginUsd > 0 ? ((pos.realizedPnlUsd ?? 0) / pos.marginUsd) * 100 : 0
    return { ...pos, markPrice: pos.closePrice ?? pos.entryPrice, unrealizedPnlUsd: 0, roePct: round1(roe) }
  }
  const mark = markPriceFor(pos.symbol, pos.cgId) ?? pos.entryPrice
  const uPnl = positionPnl(pos, mark)
  return { ...pos, markPrice: round(mark), unrealizedPnlUsd: round2(uPnl), roePct: round1(pos.marginUsd > 0 ? (uPnl / pos.marginUsd) * 100 : 0) }
}

export interface PerpsPayload {
  open: SerializedPerp[]
  closed: SerializedPerp[]
  stats: ReturnType<typeof summarizePerps>
  maxLeverage: number
  liveEnabled: boolean
}

export function getPerpsPayload(): PerpsPayload {
  const list = all()
  return {
    open: openOnes().map(serialize),
    closed: list.filter((p) => p.status === 'closed').slice(0, CLOSED_CAP).map(serialize),
    stats: summarizePerps(list),
    maxLeverage: clampLeverage(Infinity),
    liveEnabled: liveExecutor.ready,
  }
}

/** Lighter slice for the 20s snapshot — open positions (live PnL) + stats. */
export function getPerpsSnapshot() {
  return { open: openOnes().map(serialize), stats: summarizePerps(all()), liveEnabled: liveExecutor.ready }
}

const broadcastPerps = () => broadcast({ type: 'perps', payload: getPerpsPayload() })

/** CoinGecko ids of open perps — folded into the engine's per-tick price batch so a fallback
 *  (non-Hyperliquid) coin stays freshly priced for marking. */
export const perpPriceIds = (): string[] => [...new Set(openOnes().map((p) => p.cgId))]

function trimClosed() {
  const list = all()
  const closed = list.filter((p) => p.status === 'closed')
  if (closed.length <= CLOSED_CAP) return
  const drop = new Set(closed.slice(CLOSED_CAP).map((p) => p.id))
  state.perps = list.filter((p) => !drop.has(p.id))
}

/** Open a paper perp at the live mark. `mode:'live'` routes to the gated live executor (throws). */
export async function createPerp(input: OpenPerpInput): Promise<{ position: PerpPosition } | { error: string }> {
  // Guard identity TYPES before any use: markPriceFor(input.symbol, …) calls symbol.toUpperCase()
  // and getSpotPrices([input.cgId]) runs below — both throw a 500 on a non-string symbol/cgId from
  // a raw request body. Mirror buildUserTrade's guards so it's a clean 400. [route-validation]
  if (typeof input.symbol !== 'string' || !input.symbol.trim()) return { error: 'Pick a coin (symbol required)' }
  if (typeof input.cgId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(input.cgId)) return { error: 'A valid coin id is required' }
  if (openOnes().length >= MAX_OPEN) return { error: 'Too many open positions — close one first' }
  const ex = input.mode === 'live' ? liveExecutor : paperExecutor
  await refreshPerpMarkets().catch(() => {})
  let mark = markPriceFor(input.symbol, input.cgId)
  if (mark === undefined) {
    await getSpotPrices([input.cgId]).catch(() => {}) // seed the CoinGecko fallback for a non-HL coin
    mark = markPriceFor(input.symbol, input.cgId)
  }
  if (mark === undefined) return { error: "Couldn't read the mark price — try again in a moment" }

  let entry: number
  try {
    ;({ price: entry } = await ex.fill(input.symbol, input.side, input.marginUsd * clampLeverage(input.leverage), mark))
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Execution failed' }
  }

  const res = openPerp({ ...input, mode: ex.kind }, entry, Date.now(), uid())
  if ('error' in res) return res
  all().unshift(res.position)
  broadcast({ type: 'perp', position: serialize(res.position) })
  broadcastPerps()
  save()
  console.log(`[perps] opened ${res.position.symbol} ${res.position.side} ${res.position.leverage}× — margin $${res.position.marginUsd}, entry ${res.position.entryPrice}, liq ${res.position.liqPrice}`)
  return res
}

/** Close an open position at the current mark (manual). */
export async function closePerpById(id: string): Promise<{ position: PerpPosition } | { error: string }> {
  if (!all().some((p) => p.id === id && p.status === 'open')) return { error: 'Position not found or already closed' }
  // Do the async price work FIRST, then find + mutate SYNCHRONOUSLY (no await in between). A tick
  // can run during these awaits — trackPerps → trimClosed rebuilds state.perps, and createPerp
  // unshifts — so a position index/array ref captured before the await could write into a detached
  // array (close silently lost) or hit the wrong position. The pre-lookup only decides whether to
  // seed a spot price; the authoritative find happens after. [close-race]
  await refreshPerpMarkets().catch(() => {})
  const pre = all().find((p) => p.id === id && p.status === 'open')
  if (pre && markPriceFor(pre.symbol, pre.cgId) === undefined) await getSpotPrices([pre.cgId]).catch(() => {})
  const list = all()
  const i = list.findIndex((p) => p.id === id && p.status === 'open')
  if (i < 0) return { error: 'Position not found or already closed' }
  const mark = markPriceFor(list[i].symbol, list[i].cgId)
  if (mark === undefined) return { error: "Couldn't read the mark price — try again in a moment" }
  list[i] = closePerp(list[i], mark, Date.now(), 'manual')
  broadcast({ type: 'perp-update', position: serialize(list[i]) })
  trimClosed()
  broadcastPerps()
  save()
  return { position: list[i] }
}

/** Adjust the stop / take-profit on an open position (validated against its entry). */
export function editPerpStops(id: string, patch: { stopLoss?: number | null; takeProfit?: number | null }): { position: PerpPosition } | { error: string } {
  const pos = openOnes().find((p) => p.id === id)
  if (!pos) return { error: 'Position not found or already closed' }
  const long = pos.side === 'long'
  if (patch.stopLoss !== undefined && patch.stopLoss !== null) {
    const sl = Number(patch.stopLoss)
    if (!(sl > 0) || (long ? sl >= pos.entryPrice : sl <= pos.entryPrice)) return { error: `Stop-loss must be ${long ? 'below' : 'above'} the entry (${pos.entryPrice})` }
    pos.stopLoss = round(sl)
  } else if (patch.stopLoss === null) {
    pos.stopLoss = undefined
  }
  if (patch.takeProfit !== undefined && patch.takeProfit !== null) {
    const tp = Number(patch.takeProfit)
    if (!(tp > 0) || (long ? tp <= pos.entryPrice : tp >= pos.entryPrice)) return { error: `Take-profit must be ${long ? 'above' : 'below'} the entry (${pos.entryPrice})` }
    pos.takeProfit = round(tp)
  } else if (patch.takeProfit === null) {
    pos.takeProfit = undefined
  }
  broadcastPerps()
  save()
  return { position: pos }
}

/** Remove a CLOSED position from the list (dismiss). */
export function dismissPerp(id: string): boolean {
  const list = all()
  const i = list.findIndex((p) => p.id === id && p.status === 'closed')
  if (i < 0) return false
  list.splice(i, 1)
  broadcastPerps()
  save()
  return true
}

/**
 * Mark every open position against fresh prices, accrue funding, and close on tp/stop/liq.
 * Called each engine tick. Funding changes silently (carried by the 20s snapshot); only a
 * CLOSE broadcasts a dedicated frame (for the toast + history). Returns true if anything changed.
 */
export async function trackPerps(now: number = Date.now()): Promise<boolean> {
  const list = all()
  const open = openOnes()
  if (!open.length) return false
  await refreshPerpMarkets(now).catch(() => {})
  let changed = false
  let anyClosed = false
  for (const pos of open) {
    const mark = markPriceFor(pos.symbol, pos.cgId)
    if (mark === undefined) continue // unpriced this tick — don't accrue/close on a stale price
    // Accrue funding on the CURRENT notional since the last tick.
    const elapsed = now - pos.lastTickAt
    if (elapsed > 0) {
      const delta = fundingDelta(pos.side, pos.sizeCoin * mark, fundingFor(pos.symbol), elapsed)
      if (delta !== 0) pos.fundingPaidUsd = round2(pos.fundingPaidUsd + delta)
      pos.lastTickAt = now
      changed = true
    }
    const next = nextPerpState(pos, mark, now)
    if (next.status === 'closed') {
      const i = list.indexOf(pos)
      if (i >= 0) list[i] = next
      changed = true
      anyClosed = true
      broadcast({ type: 'perp-update', position: serialize(next) })
      console.log(`[perps] ${next.symbol} ${next.side} closed ${next.closeReason} — ${(next.realizedPnlUsd ?? 0) >= 0 ? '+' : ''}$${next.realizedPnlUsd}`)
    }
  }
  if (anyClosed) {
    trimClosed()
    broadcastPerps()
  }
  if (changed) save()
  return changed
}
