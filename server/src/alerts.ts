// Price alerts: get notified the moment a coin crosses a level or makes a move. The pure
// core (buildAlert/evaluateAlert/alertMessage) validates + decides; the stateful helpers
// persist alerts in state.alerts, evaluate them every engine tick against fresh spot
// prices, and on a trigger broadcast a WS frame AND fire the configured Telegram/webhook
// (reusing health.notify). Three kinds: cross ABOVE a price, drop BELOW a price, or MOVE
// ±% from where it was armed. Mode-agnostic and AI-free — alerts work regardless of
// workspace or whether a Gemini key is set.

import { state, save, uid } from './store.js'
import { getSpotPrices, spotFresh } from './prices.js'
import { broadcast } from './broadcast.js'
import { notifyAsync } from './health.js'

export type AlertKind = 'above' | 'below' | 'move'
export type AlertStatus = 'armed' | 'triggered'

export interface PriceAlert {
  id: string
  cg: string // CoinGecko id — the pricing source of truth
  symbol: string
  name: string
  kind: AlertKind
  value: number // target price (above/below) or percent move (move)
  armedPrice: number // price when (re)armed — the basis for `move` and for display
  note?: string
  enabled: boolean // paused alerts are skipped by checkAlerts
  status: AlertStatus
  createdAt: number
  triggeredAt?: number
  triggeredPrice?: number
}

export interface AlertInput {
  cg: string
  symbol: string
  name?: string
  kind: AlertKind
  value: number
  note?: string
}

const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0)
const fmt = (v: number) => '$' + (v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : Number(v.toPrecision(4)).toString())

/** Validate + normalize an alert against the coin's CURRENT price. Pure (price/now/id in). */
export function buildAlert(input: AlertInput, currentPrice: number, now: number, id: string): { alert: PriceAlert } | { error: string } {
  const cg = String(input?.cg ?? '').trim().toLowerCase()
  const symbol = String(input?.symbol ?? '').trim().toUpperCase().slice(0, 24)
  if (!cg || !/^[a-z0-9-]{1,80}$/.test(cg) || !symbol) return { error: 'Pick a coin' }
  const value = Number(input?.value)
  if (!Number.isFinite(value)) return { error: 'Enter a valid number' }
  if (!(currentPrice > 0)) return { error: "Couldn't read the current price — try again in a moment" }

  if (input.kind === 'above') {
    if (!(value > currentPrice)) return { error: `Target must be above the current price (${fmt(currentPrice)})` }
  } else if (input.kind === 'below') {
    if (!(value < currentPrice)) return { error: `Target must be below the current price (${fmt(currentPrice)})` }
  } else if (input.kind === 'move') {
    if (!(value > 0)) return { error: 'Percent must be greater than 0' }
  } else {
    return { error: 'Unknown alert type' }
  }

  return {
    alert: {
      id,
      cg,
      symbol,
      name: String(input.name ?? symbol).trim().slice(0, 80) || symbol,
      kind: input.kind,
      value: round(value),
      armedPrice: round(currentPrice),
      note: input.note ? String(input.note).slice(0, 200) : undefined,
      enabled: true,
      status: 'armed',
      createdAt: now,
    },
  }
}

/** True when the alert's condition is met at `price`. Pure. */
export function evaluateAlert(a: PriceAlert, price: number): boolean {
  if (!(price > 0)) return false
  if (a.kind === 'above') return price >= a.value
  if (a.kind === 'below') return price <= a.value
  if (a.kind === 'move') return a.armedPrice > 0 && (Math.abs(price - a.armedPrice) / a.armedPrice) * 100 >= a.value
  return false
}

/** Human-readable trigger message (also used for the Telegram/webhook push). Pure. */
export function alertMessage(a: PriceAlert, price: number): string {
  if (a.kind === 'above') return `🔔 ${a.symbol} crossed above ${fmt(a.value)} — now ${fmt(price)}`
  if (a.kind === 'below') return `🔔 ${a.symbol} dropped below ${fmt(a.value)} — now ${fmt(price)}`
  const pct = a.armedPrice > 0 ? ((price - a.armedPrice) / a.armedPrice) * 100 : 0
  return `🔔 ${a.symbol} moved ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% from ${fmt(a.armedPrice)} — now ${fmt(price)}`
}

// ── State ───────────────────────────────────────────────────────────────────
const ALERT_CAP = 100
const list = (): PriceAlert[] => (state.alerts ??= [])

export function getAlertsPayload(): { alerts: PriceAlert[] } {
  return { alerts: list() }
}

/** CoinGecko ids of armed alerts — folded into the engine's per-tick price batch so an
 *  alert on a coin OUTSIDE the bot universe still gets a fresh price every tick (otherwise
 *  the 20s spot-cache freshness gate would freeze it after the first fetch). */
export const alertPriceIds = (): string[] => [...new Set(list().filter((a) => a.enabled && a.status === 'armed').map((a) => a.cg))]
const broadcastAlerts = () => broadcast({ type: 'alerts', alerts: list() })

/** Create an alert, validated against the coin's current price (fetched fresh). */
export async function createAlert(input: AlertInput): Promise<{ alert: PriceAlert } | { error: string }> {
  const cg = String(input?.cg ?? '').trim().toLowerCase()
  // Validate the id FORMAT before it reaches getSpotPrices' query string (buildAlert re-checks it).
  if (!/^[a-z0-9-]{1,80}$/.test(cg)) return { error: 'Pick a coin' }
  await getSpotPrices([cg]).catch(() => {})
  const price = spotFresh(cg) ?? 0
  const res = buildAlert(input, price, Date.now(), uid())
  if ('error' in res) return res
  list().unshift(res.alert)
  if (list().length > ALERT_CAP) list().length = ALERT_CAP
  broadcastAlerts()
  save()
  console.log(`[alerts] armed ${res.alert.symbol} ${res.alert.kind} ${res.alert.value} (at ${res.alert.armedPrice})`)
  return res
}

export function deleteAlert(id: string): boolean {
  const l = list()
  const i = l.findIndex((a) => a.id === id)
  if (i < 0) return false
  l.splice(i, 1)
  broadcastAlerts()
  save()
  return true
}

/** Pause / resume an alert. */
export function setAlertEnabled(id: string, enabled: boolean): { alert: PriceAlert } | { error: string } {
  const a = list().find((x) => x.id === id)
  if (!a) return { error: 'Alert not found' }
  a.enabled = enabled
  broadcastAlerts()
  save()
  return { alert: a }
}

/** Re-arm a triggered alert against the current price (new basis for `move`; for
 *  above/below the target must still be on the correct side, else it'd re-fire instantly). */
export async function rearmAlert(id: string): Promise<{ alert: PriceAlert } | { error: string }> {
  const a = list().find((x) => x.id === id)
  if (!a) return { error: 'Alert not found' }
  await getSpotPrices([a.cg]).catch(() => {})
  const price = spotFresh(a.cg) ?? 0
  if (!(price > 0)) return { error: "Couldn't read the current price — try again in a moment" }
  if (a.kind === 'above' && !(a.value > price)) return { error: `Price is already at/above ${fmt(a.value)} — set a new target` }
  if (a.kind === 'below' && !(a.value < price)) return { error: `Price is already at/below ${fmt(a.value)} — set a new target` }
  a.armedPrice = round(price)
  a.status = 'armed'
  a.enabled = true
  a.triggeredAt = undefined
  a.triggeredPrice = undefined
  broadcastAlerts()
  save()
  return { alert: a }
}

/**
 * Evaluate every armed alert against fresh spot prices; fire (status→triggered) on a met
 * condition, broadcasting a WS frame and pushing the configured Telegram/webhook. Cheap
 * (cached prices + pure compare) — called each engine tick. Returns true if anything fired.
 */
export async function checkAlerts(now: number = Date.now()): Promise<boolean> {
  const armed = list().filter((a) => a.enabled && a.status === 'armed')
  if (!armed.length) return false
  await getSpotPrices([...new Set(armed.map((a) => a.cg))]).catch(() => {})
  let changed = false
  for (const a of armed) {
    // Re-validate against the CURRENT list: `armed` was snapshotted BEFORE the await above, so a
    // concurrent HTTP handler (deleteAlert / setAlertEnabled / rearmAlert) may have removed, paused
    // or re-armed this alert during the fetch window. Without this, a just-paused or just-deleted
    // alert would still fire + push a notification. [race]
    if (!a.enabled || a.status !== 'armed' || !list().includes(a)) continue
    const price = spotFresh(a.cg)
    if (price === undefined) continue // unpriced this tick — retry next
    if (evaluateAlert(a, price)) {
      a.status = 'triggered'
      a.triggeredAt = now
      a.triggeredPrice = round(price)
      changed = true
      broadcast({ type: 'alert-trigger', alert: a })
      notifyAsync('price-alert', alertMessage(a, price)) // Telegram/webhook if configured
      console.log(`[alerts] ${alertMessage(a, price)}`)
    }
  }
  if (changed) {
    broadcastAlerts()
    save()
  }
  return changed
}
