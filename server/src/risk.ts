// Risk-tolerance presets. Every strategy reads its knobs from here, so two
// bots on the same coin with different tolerances behave very differently
// and their P&L can be compared like-for-like.

export interface RiskParams {
  label: string
  blurb: string
  positionPct: number //  % of budget per entry
  stopLossPct: number
  takeProfitPct: number
  gridLevels: number
  gridSpacingPct: number
  rsiBuy: number
  rsiSell: number
  dcaIntervalMin: number
  dcaSlices: number
  cooldownMin: number // wait after an exit before re-entering
  /** Copy-trade only: a fixed per-entry USD size that overrides positionPct. Injected per
   *  copy bot by the engine from bot.copy.perTradeUsd; never set on the shared RISK presets. */
  perTradeUsd?: number
}

export const RISK: Record<string, RiskParams> = {
  conservative: {
    label: 'Conservative',
    blurb: 'Small positions, tight stops, quick profit-taking. Prioritises capital preservation.',
    positionPct: 12,
    stopLossPct: 3,
    takeProfitPct: 2.5,
    gridLevels: 4,
    gridSpacingPct: 1.5,
    rsiBuy: 25,
    rsiSell: 72,
    dcaIntervalMin: 240,
    dcaSlices: 10,
    cooldownMin: 45,
  },
  balanced: {
    label: 'Balanced',
    blurb: 'Moderate sizing and stops. The all-round default for trending or ranging markets.',
    positionPct: 22,
    stopLossPct: 5,
    takeProfitPct: 4.5,
    gridLevels: 6,
    gridSpacingPct: 2.5,
    rsiBuy: 30,
    rsiSell: 70,
    dcaIntervalMin: 120,
    dcaSlices: 8,
    cooldownMin: 30,
  },
  aggressive: {
    label: 'Aggressive',
    blurb: 'Larger positions, wider stops, bigger targets. Higher drawdowns in exchange for upside.',
    positionPct: 35,
    stopLossPct: 8,
    takeProfitPct: 8,
    gridLevels: 8,
    gridSpacingPct: 4,
    rsiBuy: 35,
    rsiSell: 65,
    dcaIntervalMin: 60,
    dcaSlices: 6,
    cooldownMin: 15,
  },
}
