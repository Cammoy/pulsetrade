// Pure trade-ticket math, shared by the setup modal and its tests. Given a plan (entry
// zone, stop, take-profits, leverage) plus the operator's account size + risk %, it
// computes the validated levels, reward:risk, a risk-based position size, the isolated
// liquidation estimate, and the $ outcome at each target. No React, no I/O — so the numbers
// the UI shows are unit-tested and always consistent with the validation.

export type Direction = 'LONG' | 'SHORT'

export interface TradePlan {
  direction: Direction
  entryLow: number
  entryHigh: number
  stopLoss: number
  tp1: number
  tp2: number
  tp3: number
  leverage: number
}

export interface TradeCalc {
  valid: boolean
  error: string | null
  entryMid: number
  stopPct: number // distance entry → stop, %
  riskReward: number // reward to TP1 ÷ risk to stop
  liqPrice: number // estimated isolated-margin liquidation price (fees/maintenance ignored)
  dollarRisk: number // account × risk%
  positionUsd: number // notional sized so a stop-out loses ~dollarRisk
  marginUsd: number // positionUsd ÷ leverage
  tps: { price: number; movePct: number; r: number; profitUsd: number }[] // per-target outcome
}

const n = (v: number) => (Number.isFinite(v) ? v : NaN)
const round = (v: number, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : 0)

/** Sensible starting levels for a fresh trade around `price` (≈2:1 R:R) — the user then
 *  fine-tunes. LONG buys at/just-below price with the stop under it; SHORT mirrors. */
export function seedLevels(direction: Direction, price: number): { entryLow: number; entryHigh: number; stopLoss: number; tp1: number; tp2: number; tp3: number } {
  const p = Number.isFinite(price) && price > 0 ? price : 0
  const r = (m: number) => round(p * m, 6)
  return direction === 'LONG'
    ? { entryLow: r(0.995), entryHigh: r(1), stopLoss: r(0.96), tp1: r(1.08), tp2: r(1.12), tp3: r(1.2) }
    : { entryLow: r(1), entryHigh: r(1.005), stopLoss: r(1.04), tp1: r(0.92), tp2: r(0.88), tp3: r(0.8) }
}

/** Validate + price out a trade plan. `error` is set (and `valid` false) on a bad plan. */
export function computeTrade(plan: TradePlan, accountUsd: number, riskPct: number): TradeCalc {
  const long = plan.direction === 'LONG'
  const entryLow = Math.min(n(plan.entryLow), n(plan.entryHigh))
  const entryHigh = Math.max(n(plan.entryLow), n(plan.entryHigh))
  const entryMid = (entryLow + entryHigh) / 2
  const lev = Math.max(1, n(plan.leverage) || 1)
  const account = Math.max(0, n(accountUsd) || 0)
  const risk = Math.max(0, n(riskPct) || 0)
  const blank = (error: string): TradeCalc => ({ valid: false, error, entryMid: round(entryMid, 6), stopPct: 0, riskReward: 0, liqPrice: 0, dollarRisk: 0, positionUsd: 0, marginUsd: 0, tps: [] })

  if (!(entryMid > 0)) return blank('Enter a valid entry price')
  if (!(n(plan.stopLoss) > 0)) return blank('Enter a stop-loss')
  if (long ? plan.stopLoss >= entryMid : plan.stopLoss <= entryMid) return blank(`Stop-loss must be ${long ? 'below' : 'above'} the entry`)

  const tpsRaw = [plan.tp1, plan.tp2, plan.tp3].map(n)
  if (tpsRaw.some((t) => !(t > 0))) return blank('Enter all three take-profits')
  const ordered = long ? tpsRaw[0] > entryMid && tpsRaw[1] >= tpsRaw[0] && tpsRaw[2] >= tpsRaw[1] : tpsRaw[0] < entryMid && tpsRaw[1] <= tpsRaw[0] && tpsRaw[2] <= tpsRaw[1]
  if (!ordered) return blank(`Take-profits must be ${long ? 'above' : 'below'} entry and ordered TP1 → TP3`)

  const riskPerUnit = Math.abs(entryMid - plan.stopLoss)
  const stopPct = (riskPerUnit / entryMid) * 100
  const riskReward = Math.abs(tpsRaw[0] - entryMid) / riskPerUnit
  const liqPrice = long ? entryMid * (1 - 1 / lev) : entryMid * (1 + 1 / lev)

  const dollarRisk = (account * risk) / 100
  const positionUsd = stopPct > 0 ? dollarRisk / (stopPct / 100) : 0
  const marginUsd = positionUsd / lev

  const tps = tpsRaw.map((price) => {
    const movePct = (Math.abs(price - entryMid) / entryMid) * 100
    return { price: round(price, 6), movePct: round(movePct), r: round(movePct / stopPct), profitUsd: round((positionUsd * movePct) / 100) }
  })

  return {
    valid: true,
    error: null,
    entryMid: round(entryMid, 6),
    stopPct: round(stopPct),
    riskReward: round(riskReward),
    liqPrice: round(liqPrice, 6),
    dollarRisk: round(dollarRisk),
    positionUsd: round(positionUsd),
    marginUsd: round(marginUsd),
    tps,
  }
}
