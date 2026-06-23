// Single source of truth for the simulated trading cost model. The engine's PAPER
// fills and the backtester MUST charge the same per-side cost, or paper P&L and
// backtest edge would disagree about what a trade really costs.
//
// Built from the REAL components of a DEX round trip so PAPER/backtest numbers don't
// over-promise vs live (which is the whole point — a too-cheap model makes the Profit
// Finder rank the most overfit, thinnest-pool configs as winners):
//   - LP fee:           the AMM pool's swap fee, paid on every swap (~0.30% pool).
//   - slippage/impact:  toward the ~1% band the live 0x/Jupiter quote tolerates; a small
//                       order on a liquid pair is less, a thin/sniper pool is far MORE
//                       (plus MEV) — not captured by a flat rate, so sniper/thin backtests
//                       remain optimistic even at this level.
// History: 0.15% (original) was ~6x too cheap; 0.6% was still below the live ceiling.
export const LP_FEE_PER_SIDE = 0.003
export const SLIPPAGE_IMPACT_PER_SIDE = 0.007
/** Total cost charged on EACH side (buy AND sell): LP fee + slippage/impact ≈ 1%/side. */
export const SLIPPAGE_PER_SIDE = LP_FEE_PER_SIDE + SLIPPAGE_IMPACT_PER_SIDE

/** Native to keep in the wallet (as a multiple of the chain's avg gas) so a bot
 *  can always afford the gas to SELL out of a position it bought — a buy that
 *  would leave less than this is refused, and a live withdrawal keeps this in
 *  reserve. ~3× covers approve + swap + a margin. Tunable via GAS_RESERVE_MULT;
 *  on these cheap L2s the reserve is a few cents. */
export const gasReserveMult = (): number => {
  const n = Number(process.env.GAS_RESERVE_MULT)
  return Number.isFinite(n) && n > 0 ? n : 3
}
