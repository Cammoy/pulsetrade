// Limit (conditional) orders: "buy $X of a coin when it drops to P" / "sell when it rises to P".
// The engine watches each open order against fresh prices every tick and, on a trigger, FILLS it
// — at your limit price or better — booking the simulated outcome. PAPER-first: fills are
// simulated (no funds move), consistent with the rest of the app's safety model; the manual Swap
// stays the only thing that moves real funds (and only with a confirmation). A real
// auto-executing live order would route through the swap executor — that's a gated follow-up.

import { state, save, uid } from './store.js'
import { getSpotPrices, spotFresh } from './prices.js'
import { broadcast } from './broadcast.js'
import { notifyAsync } from './health.js'

export type OrderSide = 'buy' | 'sell'
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'expired'

export interface LimitOrder {
  id: string
  cg: string // CoinGecko id — the price source of truth
  symbol: string
  name: string
  side: OrderSide // buy the coin with USDT, or sell the coin for USDT
  amountUsd: number // USD to spend (buy) or USD of the coin to sell (sell)
  triggerPrice: number // fill when price ≤ trigger (buy) or ≥ trigger (sell)
  refPrice: number // price when the order was placed (for display)
  status: OrderStatus
  createdAt: number
  expiresAt: number
  filledAt?: number
  fillPrice?: number
  filledQty?: number // coin bought (buy) or sold (sell)
  proceedsUsd?: number // USDT received (sell only)
  mode: 'paper' | 'live'
  note?: string
}

// LP fee + slippage charged on a (simulated) fill — matches the app's swap cost assumptions.
const FILL_FEE = 0.003
const DEFAULT_TTL_MS = 30 * 24 * 3_600_000 // 30 days
const ORDER_CAP = 100
const round = (v: number, dp = 6) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : 0)
const round2 = (v: number) => round(v, 2)
const fmt = (v: number) => '$' + (v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : Number(v.toPrecision(4)).toString())

export interface LimitOrderInput {
  cg: string
  symbol: string
  name?: string
  side: OrderSide
  amountUsd: number
  triggerPrice: number
  ttlMs?: number
  note?: string
}

/** Validate + construct an order against the coin's CURRENT price. Pure (price/now/id in).
 *  A BUY waits for a dip (trigger < current); a SELL waits for a rise (trigger > current) —
 *  so an order can't fill the instant it's placed. */
export function buildLimitOrder(input: LimitOrderInput, currentPrice: number, now: number, id: string): { order: LimitOrder } | { error: string } {
  const cg = String(input?.cg ?? '').trim().toLowerCase()
  const symbol = String(input?.symbol ?? '').trim().toUpperCase().slice(0, 24)
  if (!cg || !/^[a-z0-9-]{1,80}$/.test(cg) || !symbol) return { error: 'Pick a coin' }
  if (input.side !== 'buy' && input.side !== 'sell') return { error: 'Choose buy or sell' }
  const amountUsd = Number(input.amountUsd)
  if (!(amountUsd > 0)) return { error: 'Amount must be greater than 0' }
  const triggerPrice = Number(input.triggerPrice)
  if (!(triggerPrice > 0)) return { error: 'Enter a valid trigger price' }
  if (!(currentPrice > 0)) return { error: "Couldn't read the current price — try again in a moment" }
  if (input.side === 'buy' && !(triggerPrice < currentPrice)) return { error: `A buy limit fills on a dip — set a target below ${fmt(currentPrice)}` }
  if (input.side === 'sell' && !(triggerPrice > currentPrice)) return { error: `A sell limit fills on a rise — set a target above ${fmt(currentPrice)}` }

  return {
    order: {
      id,
      cg,
      symbol,
      name: String(input.name ?? symbol).trim().slice(0, 80) || symbol,
      side: input.side,
      amountUsd: round2(amountUsd),
      triggerPrice: round(triggerPrice),
      refPrice: round(currentPrice),
      status: 'open',
      createdAt: now,
      expiresAt: now + (input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS),
      mode: 'paper',
      note: input.note ? String(input.note).slice(0, 200) : undefined,
    },
  }
}

/** True when the price has reached the order's trigger. Pure. */
export function evaluateLimit(order: LimitOrder, price: number): boolean {
  if (!(price > 0)) return false
  return order.side === 'buy' ? price <= order.triggerPrice : price >= order.triggerPrice
}

/** Simulate a fill at the limit price or better (a gap through the trigger fills at the better
 *  price), net of fee. Pure. Returns the booked numbers. */
export function simulateFill(order: LimitOrder, price: number): { fillPrice: number; filledQty: number; proceedsUsd?: number } {
  if (order.side === 'buy') {
    const fillPrice = Math.min(order.triggerPrice, price) // pay your price or less
    const filledQty = ((order.amountUsd / fillPrice) * (1 - FILL_FEE))
    return { fillPrice: round(fillPrice), filledQty: round(filledQty, 8) }
  }
  const fillPrice = Math.max(order.triggerPrice, price) // receive your price or more
  const filledQty = order.amountUsd / fillPrice // coin sold
  const proceedsUsd = order.amountUsd * (1 - FILL_FEE)
  return { fillPrice: round(fillPrice), filledQty: round(filledQty, 8), proceedsUsd: round2(proceedsUsd) }
}

/** Human-readable fill message (also the Telegram/webhook push). Pure. */
export function fillMessage(order: LimitOrder): string {
  if (order.side === 'buy') return `🎯 Limit BUY filled — bought ${order.filledQty} ${order.symbol} at ${fmt(order.fillPrice ?? 0)} (spent ${fmt(order.amountUsd)})`
  return `🎯 Limit SELL filled — sold ${order.filledQty} ${order.symbol} at ${fmt(order.fillPrice ?? 0)} for ${fmt(order.proceedsUsd ?? 0)}`
}

// ── State ───────────────────────────────────────────────────────────────────
const list = (): LimitOrder[] => (state.limitOrders ??= [])
const openOnes = () => list().filter((o) => o.status === 'open')

export function getLimitOrdersPayload(): { orders: LimitOrder[] } {
  return { orders: list() }
}
const broadcastOrders = () => broadcast({ type: 'limit-orders', orders: list() })

/** CoinGecko ids of open orders — folded into the engine's per-tick price batch so an order on
 *  a coin outside the bot universe still gets a fresh price (else the cache freezes it). */
export const limitPriceIds = (): string[] => [...new Set(openOnes().map((o) => o.cg))]

/** Create a limit order, validated against the coin's current price (fetched fresh). */
export async function createLimitOrder(input: LimitOrderInput): Promise<{ order: LimitOrder } | { error: string }> {
  const cg = String(input?.cg ?? '').trim().toLowerCase()
  if (!cg) return { error: 'Pick a coin' }
  if (openOnes().length >= ORDER_CAP) return { error: 'Too many open orders — cancel one first' }
  await getSpotPrices([cg]).catch(() => {})
  const price = spotFresh(cg) ?? 0
  const res = buildLimitOrder(input, price, Date.now(), uid())
  if ('error' in res) return res
  list().unshift(res.order)
  broadcastOrders()
  save()
  console.log(`[limit] ${res.order.side.toUpperCase()} ${fmt(res.order.amountUsd)} ${res.order.symbol} @ ${fmt(res.order.triggerPrice)} (ref ${fmt(res.order.refPrice)})`)
  return res
}

/** Cancel (or dismiss a settled) order. */
export function cancelLimitOrder(id: string): boolean {
  const l = list()
  const i = l.findIndex((o) => o.id === id)
  if (i < 0) return false
  if (l[i].status === 'open') {
    l[i].status = 'cancelled'
  } else {
    l.splice(i, 1) // dismiss an already-settled order
  }
  broadcastOrders()
  save()
  return true
}

/**
 * Evaluate every open order against fresh prices; FILL on a trigger (simulated), EXPIRE past
 * the TTL. Cheap (cached prices + pure math) — called each engine tick. Returns true on change.
 */
export async function checkLimitOrders(now: number = Date.now()): Promise<boolean> {
  const open = openOnes()
  if (!open.length) return false
  await getSpotPrices([...new Set(open.map((o) => o.cg))]).catch(() => {})
  let changed = false
  for (const order of open) {
    // Re-validate against the CURRENT list: `open` was snapshotted BEFORE the await above, so a
    // concurrent HTTP handler (cancelLimitOrder) may have cancelled/removed this order during the
    // fetch window. Without this, a just-cancelled order would still fill + notify. [race]
    if (order.status !== 'open' || !list().includes(order)) continue
    if (now >= order.expiresAt) {
      order.status = 'expired'
      changed = true
      broadcast({ type: 'limit-fill', order })
      continue
    }
    const price = spotFresh(order.cg)
    if (price === undefined) continue // unpriced this tick — retry next
    if (evaluateLimit(order, price)) {
      const fill = simulateFill(order, price)
      order.status = 'filled'
      order.filledAt = now
      order.fillPrice = fill.fillPrice
      order.filledQty = fill.filledQty
      order.proceedsUsd = fill.proceedsUsd
      changed = true
      broadcast({ type: 'limit-fill', order })
      notifyAsync('limit-order', fillMessage(order))
      console.log(`[limit] ${fillMessage(order)}`)
    }
  }
  if (changed) {
    broadcastOrders()
    save()
  }
  return changed
}
