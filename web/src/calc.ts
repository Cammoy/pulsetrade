// Profit-calculator math — pure, exact, unit-tested. The single source of truth the
// ProfitCalculator UI renders. Models a LONG spot position: buy at `entryPrice`, sell at
// `exitPrice`, with an optional per-side fee. Two amount modes: a USD amount invested, or a
// coin quantity held. Everything downstream (hero numbers, scenario cards, profit curve)
// is derived from computeProfit so the UI can never disagree with the math.

export type AmountMode = 'usd' | 'qty'

export interface ProfitInput {
  entryPrice: number
  exitPrice: number
  amount: number // interpreted per `amountMode`
  amountMode: AmountMode
  feePct?: number // per-side fee %, e.g. 0.5 = 0.5% on the buy AND the sell
}

export interface ProfitResult {
  quantity: number // coins held
  costUsd: number // total invested (cost basis)
  exitValueUsd: number // net proceeds after the sell fee
  profitUsd: number // exitValue − cost
  profitPct: number // profit / cost, %
  roi: number // exitValue / cost (a multiple, e.g. 2 = doubled)
  priceChangePct: number // (exit/entry − 1) × 100 — pure price move
  breakEvenPrice: number // the exit price at which profit = 0 (covers the fee drag)
  valid: boolean // false when inputs aren't usable (≤0 price/amount, NaN)
}

const ZERO: Omit<ProfitResult, 'valid'> = {
  quantity: 0, costUsd: 0, exitValueUsd: 0, profitUsd: 0, profitPct: 0, roi: 0, priceChangePct: 0, breakEvenPrice: 0,
}

const finite = (n: number) => (Number.isFinite(n) ? n : 0)

/** Exact P&L for a long spot round-trip. Fees apply to each leg's USD notional. */
export function computeProfit(input: ProfitInput): ProfitResult {
  const entryPrice = finite(input.entryPrice)
  const exitPrice = finite(input.exitPrice)
  const amount = finite(input.amount)
  const fee = Math.min(Math.max(finite(input.feePct ?? 0), 0), 100) / 100 // clamp 0–100%

  if (entryPrice <= 0 || amount <= 0 || exitPrice < 0) return { ...ZERO, valid: false }

  // Derive (quantity held, cost basis) from the chosen amount mode.
  // · 'usd': you spend `amount` USD; the buy fee is taken from it, the rest buys coins.
  // · 'qty': you hold `amount` coins bought at `entryPrice` (entry IS your per-coin cost).
  let quantity: number
  let costUsd: number
  if (input.amountMode === 'usd') {
    costUsd = amount
    quantity = (amount * (1 - fee)) / entryPrice
  } else {
    quantity = amount
    costUsd = amount * entryPrice
  }

  const exitValueUsd = quantity * exitPrice * (1 - fee) // net of the sell fee
  const profitUsd = exitValueUsd - costUsd
  const profitPct = costUsd > 0 ? (profitUsd / costUsd) * 100 : 0
  const roi = costUsd > 0 ? exitValueUsd / costUsd : 0
  const priceChangePct = (exitPrice / entryPrice - 1) * 100
  // Self-consistent for whatever (cost, qty, fee) we derived: proceeds = cost ⟹ profit 0.
  const breakEvenPrice = quantity > 0 && fee < 1 ? costUsd / (quantity * (1 - fee)) : entryPrice

  return {
    quantity: finite(quantity),
    costUsd: finite(costUsd),
    exitValueUsd: finite(exitValueUsd),
    profitUsd: finite(profitUsd),
    profitPct: finite(profitPct),
    roi: finite(roi),
    priceChangePct: finite(priceChangePct),
    breakEvenPrice: finite(breakEvenPrice),
    valid: true,
  }
}

/** The exit price for a given multiple of the entry price (e.g. mult 2 = a 2× / +100%). */
export const priceForMultiple = (entryPrice: number, mult: number) => finite(entryPrice) * finite(mult)

/** Implied per-coin price at a target market cap — the ONLY correct conversion, which is
 *  exactly why the calculator needs the live circulating supply: price = market cap ÷ supply.
 *  Returns 0 for a non-positive / non-finite supply (can't target a cap without it). */
export const priceFromMarketCap = (targetMarketCap: number, circulatingSupply: number) => {
  const cap = finite(targetMarketCap)
  const supply = finite(circulatingSupply)
  return supply > 0 ? cap / supply : 0
}
