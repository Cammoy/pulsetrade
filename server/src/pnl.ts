// One definition of what counts as a winning / losing closed trade, shared by the live
// engine, the backtester, and the SQLite ledger — so the win-rate the wizard/Profit-Finder
// shows is computed the SAME way as the live bot's, and the two are directly comparable.
//
// A break-even or DUST round trip (|pnl| below a cent) is NEITHER a win nor a loss: counting
// it would inflate the exact win-rate the owner uses to judge edge. [P2-15]
//
// (The auto-sniper campaign tally is intentionally NOT built on this: it partitions every
//  completed snipe into win OR loss so `wins + losses === completed`, so it has no "flat"
//  bucket and uses realizedUsd >= 0 by design.)
export const DUST_PNL = 0.01
export const isWin = (pnl: number): boolean => pnl > DUST_PNL
export const isLoss = (pnl: number): boolean => pnl < -DUST_PNL
