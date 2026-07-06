// The trading-signal channel's PURE domain: the standardized signal shape plus
// every piece of math behind it — candidate scanning, risk construction (entry
// zone, structural stop, scaled take-profits, volatility-scaled leverage, R:R),
// the confidence blend, the sentiment filter, live outcome tracking and the
// forward-test stats. No I/O, no AI, no clock beyond an injected `now` — so the
// whole signal pipeline is unit-testable end to end. The engine (signal-engine.ts)
// supplies the data (market overview, candles, Gemini validation, news sentiment)
// and wires these functions together.
//
// Signals are ADVISORY (a perps-style channel): they carry a LONG/SHORT direction,
// a leverage RECOMMENDATION and TP/SL levels for the reader to act on — nothing here
// is executed by the spot engine. Every signal states its own invalidation (the stop)
// and carries a disclaimer; see DISCLAIMER below and the risk rules in the README.

import { sma, ema, rsi, stdevReturnsPct, trailingReturnPct } from './indicators.js'
import type { TechnicalSignal } from './market.js'

export type SignalDirection = 'LONG' | 'SHORT'
// Lifecycle: active → (climbs tp1/tp2/tp3 as targets print) → closed by a stop, the
// final target, or expiry. A closed signal carries a realized R multiple for the stats.
export type SignalStatus = 'active' | 'tp1' | 'tp2' | 'tp3' | 'stopped' | 'expired'

/** The standardized, machine-readable + human-actionable signal (one channel post). */
export interface TradeSignal {
  id: string
  asset: string // display pair, e.g. "BTC/USDT"
  symbol: string // base symbol, e.g. "BTC"
  cgId: string // CoinGecko id — the pricing source of truth for outcome tracking
  direction: SignalDirection
  // Entry ZONE (a range, to scale in) rather than a single price. entryMid is the
  // reference fill used for all R math + outcome tracking.
  entryLow: number
  entryHigh: number
  entryMid: number
  leverageMin: number // advisory, isolated; scaled inversely to volatility
  leverageMax: number
  tp1: number // conservative — secure initial risk
  tp2: number // moderate
  tp3: number // runner / "moon bag"
  stopLoss: number // hard invalidation — never moved
  confidence: number // 0..100, from technical + momentum + trend + sentiment + AI alignment
  riskReward: number // reward-to-TP1 ÷ risk-to-stop (gated ≥ minRr)
  sentimentScore: number // −1..+1 news/social sentiment that filtered this signal
  rationale: string // one-sentence AI summary
  technicals: SignalTechnicals
  refPrice: number // price at issue
  status: SignalStatus
  createdAt: number
  expiresAt: number
  // ── outcome tracking (stamped as the trade plays out) ──
  hitTp1At?: number
  hitTp2At?: number
  hitTp3At?: number
  closedAt?: number
  closePrice?: number
  realizedR?: number // signed R multiple at close (scale-out thirds, fixed stop)
  disclaimer: string
  source?: 'ai' | 'user' // 'user' ⇒ a hand-configured trade the operator is tracking (default 'ai')
}

export interface SignalTechnicals {
  rsi: number
  emaFast: number // EMA(9)
  emaSlow: number // EMA(21)
  sma: number // SMA(24)
  trend: 'up' | 'down' | 'range'
  change24hPct: number
  volatilityPct: number // realized hourly volatility (stdev of hourly returns)
}

/** A scanner-flagged coin handed to the AI validation phase. */
export interface Candidate {
  cgId: string
  symbol: string
  name: string
  price: number
  change1h: number
  change24h: number
  change7d: number
  rsi: number | null
  volToMcap: number | null
  volume24hUsd: number | null
  marketCapUsd: number | null
  signal: TechnicalSignal
  direction: SignalDirection // scanner's proposed bias (AI may override/reject)
  scanScore: number // higher = more "in play"
  triggers: string[] // why it was flagged
}

/** Tunable thresholds (env-overridable in the engine; defaults here keep the math pure). */
export interface SignalConfig {
  minRr: number // reject if reward-to-TP1 < this × risk (filter-first R:R gate)
  minConfidence: number // reject below this confidence (0..100)
  ttlMs: number // signal lifetime before it expires
  maxLeverage: number // hard cap on the advisory leverage recommendation
}

export const DEFAULT_CONFIG: SignalConfig = {
  minRr: 1.5,
  minConfidence: 55,
  ttlMs: 48 * 3_600_000, // 48h
  maxLeverage: 10,
}

export const DISCLAIMER =
  'Not financial advice. This is a probabilistic signal, not a guarantee. The stop-loss is the invalidation level — size so a single trade risks ≤1–2% of your account. Do your own research.'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// ── Candidate scanning ──────────────────────────────────────────────────────
// Liquidity floors so the channel never surfaces a coin you couldn't trade
// without huge slippage (mirrors the market.ts movement-lane floors).
const MIN_MCAP = 75_000_000
const MIN_VOL_24H = 3_000_000
// A directional technical read is required — a near-zero score is a ranging /
// directionless tape, which the filter-first workflow explicitly avoids.
const MIN_TECH_SCORE = 25

/** The shape scanCandidates reads from a market row (a structural subset of MarketCoin,
 *  so the scanner is testable without constructing the full overview). */
export interface ScanRow {
  id: string
  symbol: string
  name: string
  priceUsd: number | null
  change1h: number | null
  change24h: number | null
  change7d: number | null
  marketCapUsd: number | null
  volume24hUsd: number | null
  volToMcap: number | null
  rsi: number | null
  stable: boolean
  signal: TechnicalSignal
}

/**
 * Scanner phase: from the wide market pull, flag the coins that are genuinely "in
 * play" AND carry a directional technical edge — unusual turnover, a volatility
 * breakout, or a momentum shift — then rank them. Stables, illiquid micro-caps and
 * directionless (ranging) tapes are excluded here so the AI only ever validates
 * real candidates. Pure + deterministic; `limit` caps how many reach the AI phase.
 */
export function scanCandidates(rows: ScanRow[], limit = 6): Candidate[] {
  const out: Candidate[] = []
  for (const r of rows) {
    if (r.stable) continue
    const price = r.priceUsd ?? 0
    if (price <= 0) continue
    if ((r.marketCapUsd ?? 0) < MIN_MCAP || (r.volume24hUsd ?? 0) < MIN_VOL_24H) continue

    const score = r.signal?.score ?? 0
    if (Math.abs(score) < MIN_TECH_SCORE) continue // ranging / no directional edge
    const direction: SignalDirection = score > 0 ? 'LONG' : 'SHORT'

    // "In play" triggers — at least one must fire, so a quietly-trending coin with no
    // unusual activity doesn't flood the channel.
    const triggers: string[] = []
    const turnover = r.volToMcap ?? 0
    if (turnover > 0.18) triggers.push(`unusual turnover (${(turnover * 100).toFixed(0)}% of cap traded 24h)`)
    if (Math.abs(r.change24h ?? 0) >= 6) triggers.push(`${(r.change24h ?? 0) >= 0 ? '+' : ''}${(r.change24h ?? 0).toFixed(1)}% 24h move`)
    if (Math.abs(r.change1h ?? 0) >= 2.5) triggers.push(`${(r.change1h ?? 0) >= 0 ? '+' : ''}${(r.change1h ?? 0).toFixed(1)}% 1h impulse`)
    if (r.rsi !== null && (r.rsi <= 32 || r.rsi >= 68)) triggers.push(`RSI ${r.rsi} ${r.rsi <= 32 ? 'oversold' : 'overbought'}`)
    if (!triggers.length) continue

    // Rank: technical conviction + how "in play" it is. Turnover and the 24h impulse
    // both push a coin up the queue so the most active setups reach the AI first.
    const scanScore =
      Math.abs(score) + Math.min(40, turnover * 60) + Math.min(25, Math.abs(r.change24h ?? 0)) + Math.min(15, Math.abs(r.change1h ?? 0) * 2)

    out.push({
      cgId: r.id,
      symbol: r.symbol.toUpperCase(),
      name: r.name,
      price,
      change1h: r.change1h ?? 0,
      change24h: r.change24h ?? 0,
      change7d: r.change7d ?? 0,
      rsi: r.rsi,
      volToMcap: r.volToMcap,
      volume24hUsd: r.volume24hUsd,
      marketCapUsd: r.marketCapUsd,
      signal: r.signal,
      direction,
      scanScore,
      triggers,
    })
  }
  return out.sort((a, b) => b.scanScore - a.scanScore).slice(0, limit)
}

// ── Radar (the always-on watchlist) ─────────────────────────────────────────
// Not every in-play coin becomes a signal — most get filtered out. The radar surfaces
// the scanner's directional candidates anyway, each tagged with whether it became a
// signal or WHY it's only being watched, so the channel always shows what it's looking
// at (both long-leaning and short-leaning), not just the rare fully-validated calls.
export type RadarStatus = 'signal' | 'watching'

export interface RadarEntry {
  symbol: string
  cgId: string
  name: string
  bias: SignalDirection
  price: number
  change24hPct: number
  rsi: number | null
  triggers: string[]
  status: RadarStatus
  reason: string // "Posted — cleared all filters" or the rejection cause
}

/** Project a scanned candidate onto a radar row (pure). */
export function toRadarEntry(c: Candidate, status: RadarStatus, reason: string): RadarEntry {
  return { symbol: c.symbol, cgId: c.cgId, name: c.name, bias: c.direction, price: c.price, change24hPct: c.change24h, rsi: c.rsi, triggers: c.triggers, status, reason }
}

// ── Signal construction (risk math) ─────────────────────────────────────────

const SWING_LOOKBACK = 24 // bars for the structural swing that anchors the stop
const VOL_LOOKBACK = 48 // bars for realized volatility
const HORIZON_HOURS = 48 // expected-move projection horizon (≈ signal lifetime)
const MIN_STOP_PCT = 1.5 // never tighter than this (avoids noise stop-outs)
const MAX_STOP_PCT = 14 // never wider than this (caps risk per unit)
// Take-profit projection: fractions of the expected horizon move. TP1 is the
// conservative slice, TP3 the runner. Reward-to-TP1 vs the structural stop IS the
// R:R that gets gated, so these are NOT fixed R-multiples — a wide stop relative to
// the expected move legitimately fails the gate.
const TP1_FRAC = 0.5
const TP2_FRAC = 1.0
const TP3_FRAC = 1.8
const LEVERAGE_RISK_BUDGET_PCT = 12 // target ≈ this much notional move to a liquidation; ÷ daily vol → cap

export interface BuildInput {
  candidate: Candidate
  direction: SignalDirection // resolved direction (AI may have overridden the scanner)
  closes: number[] // hourly closes, oldest → newest
  sentimentScore: number // −1..+1
  aiConfidence: number // 0..1 from the AI validation phase
  rationale: string // one-sentence AI summary
  now: number
  config?: Partial<SignalConfig>
  id: string // caller-supplied id (keeps this module clock/RNG-free)
}

export type BuildResult = { signal: TradeSignal } | { rejected: string }

/** Realized hourly volatility as a %, with a tiny floor so degenerate flat series
 *  don't collapse the stop/leverage math to zero. */
function hourlyVolPct(closes: number[]): number {
  const v = stdevReturnsPct(closes, Math.min(VOL_LOOKBACK, closes.length - 1))
  return Number.isFinite(v) && v > 0.05 ? v : 0.05
}

/** Confidence (0..100): a weighted blend of technical conviction, momentum, trend
 *  agreement, sentiment alignment and the AI's own confidence. Each term is scaled
 *  to 0..1 and DISCOUNTED when it points against the trade direction, so conflicting
 *  signals never read as high conviction. Pure. */
export function blendConfidence(input: {
  technicalScore: number
  direction: SignalDirection
  change24h: number
  emaTrendUp: boolean
  sentimentScore: number
  aiConfidence: number
}): number {
  const dirSign = input.direction === 'LONG' ? 1 : -1
  const techAligned = Math.sign(input.technicalScore) === dirSign
  const tech = clamp(Math.abs(input.technicalScore) / 100, 0, 1) * (techAligned ? 1 : 0.3)
  const momoAligned = Math.sign(input.change24h) === dirSign
  const momo = clamp(1 - Math.exp(-Math.abs(input.change24h) / 8), 0, 1) * (momoAligned ? 1 : 0.2)
  const trend = input.emaTrendUp === (input.direction === 'LONG') ? 1 : 0
  const sent = clamp((input.sentimentScore * dirSign + 1) / 2, 0, 1) // 0 = fully against, 1 = fully with
  const ai = clamp(input.aiConfidence, 0, 1)
  const score = 100 * (0.3 * tech + 0.15 * momo + 0.15 * trend + 0.15 * sent + 0.25 * ai)
  return Math.round(clamp(score, 0, 100))
}

/** Advisory leverage band, scaled INVERSELY to volatility: a high-vol asset gets a
 *  lower cap. maxLev ≈ risk-budget ÷ expected daily move, clamped to [2, cap]. */
export function leverageFor(hourlyVol: number, cap: number): { min: number; max: number } {
  const dailyMovePct = hourlyVol * Math.sqrt(24)
  const max = clamp(Math.round(LEVERAGE_RISK_BUDGET_PCT / Math.max(0.5, dailyMovePct)), 2, cap)
  const min = clamp(Math.round(max * 0.6), 2, max)
  return { min, max }
}

/**
 * Build the full standardized signal from a candidate + its hourly closes + the
 * sentiment/AI inputs, OR reject it. Applies the filter-first quantitative gates:
 *   • sentiment filter — discard if sentiment strongly opposes the direction
 *   • R:R gate — reject if reward-to-TP1 < minRr × risk-to-stop
 *   • confidence gate — reject below minConfidence
 * Pure: all randomness/clock come in via `id`/`now`.
 */
export function buildSignal(input: BuildInput): BuildResult {
  const cfg = { ...DEFAULT_CONFIG, ...input.config }
  const { candidate, direction, closes, sentimentScore, now } = input
  if (closes.length < 30) return { rejected: 'insufficient price history' }
  const isLong = direction === 'LONG'

  const price = closes[closes.length - 1]
  if (!(price > 0)) return { rejected: 'no valid price' }

  // Sentiment filter: bullish setup into heavily negative news (or vice-versa) is
  // discarded outright — technicals don't override a strong sentiment veto.
  const aligned = sentimentScore * (isLong ? 1 : -1)
  if (aligned <= -0.4) return { rejected: `sentiment ${sentimentScore.toFixed(2)} strongly opposes ${direction}` }

  const vol = hourlyVolPct(closes)
  const projMovePct = vol * Math.sqrt(HORIZON_HOURS) // expected |move| over the horizon

  // Entry zone: a scale-in band on the entry side of price (below for LONG, above for
  // SHORT), sized to ~half a horizon move and clamped to a sane width.
  const bandPct = clamp(projMovePct * 0.25, 0.3, 2.5)
  const entryHigh = isLong ? price : price * (1 + bandPct / 100)
  const entryLow = isLong ? price * (1 - bandPct / 100) : price
  const entryMid = (entryLow + entryHigh) / 2

  // Structural stop: beyond the recent swing extreme, but floored to ≥1.5 hourly-σ
  // (so noise can't trip it) and clamped to [MIN_STOP_PCT, MAX_STOP_PCT].
  const window = closes.slice(-SWING_LOOKBACK)
  const swing = isLong ? Math.min(...window) : Math.max(...window)
  const rawStopPct = (Math.abs(entryMid - swing) / entryMid) * 100
  let stopPct = clamp(Math.max(rawStopPct, vol * 1.5), MIN_STOP_PCT, MAX_STOP_PCT)
  const stopLoss = isLong ? entryMid * (1 - stopPct / 100) : entryMid * (1 + stopPct / 100)
  const risk = Math.abs(entryMid - stopLoss)
  if (!(risk > 0)) return { rejected: 'degenerate stop' }

  // Take-profits projected from the expected move (NOT fixed R-multiples).
  const tpPct = (frac: number) => projMovePct * frac
  const tgt = (frac: number) => (isLong ? entryMid * (1 + tpPct(frac) / 100) : entryMid * (1 - tpPct(frac) / 100))
  const tp1 = tgt(TP1_FRAC)
  const tp2 = tgt(TP2_FRAC)
  const tp3 = tgt(TP3_FRAC)

  const riskReward = Math.abs(tp1 - entryMid) / risk
  if (riskReward < cfg.minRr) return { rejected: `R:R ${riskReward.toFixed(2)} below ${cfg.minRr}` }

  const emaFast = ema(closes, 9)
  const emaSlow = ema(closes, 21)
  const emaTrendUp = emaFast >= emaSlow
  const confidence = blendConfidence({
    technicalScore: candidate.signal?.score ?? 0,
    direction,
    change24h: candidate.change24h,
    emaTrendUp,
    sentimentScore,
    aiConfidence: input.aiConfidence,
  })
  if (confidence < cfg.minConfidence) return { rejected: `confidence ${confidence} below ${cfg.minConfidence}` }

  const lev = leverageFor(vol, cfg.maxLeverage)
  const change24hPct = trailingReturnPct(closes, Math.min(24, closes.length - 1))
  const technicals: SignalTechnicals = {
    rsi: round2(rsi(closes, 14)),
    emaFast: round6(emaFast),
    emaSlow: round6(emaSlow),
    sma: round6(sma(closes, Math.min(24, closes.length))),
    trend: emaFast > emaSlow * 1.001 ? 'up' : emaFast < emaSlow * 0.999 ? 'down' : 'range',
    change24hPct: round2(Number.isFinite(change24hPct) ? change24hPct : candidate.change24h),
    volatilityPct: round2(vol),
  }

  const signal: TradeSignal = {
    id: input.id,
    asset: `${candidate.symbol}/USDT`,
    symbol: candidate.symbol,
    cgId: candidate.cgId,
    direction,
    entryLow: round6(entryLow),
    entryHigh: round6(entryHigh),
    entryMid: round6(entryMid),
    leverageMin: lev.min,
    leverageMax: lev.max,
    tp1: round6(tp1),
    tp2: round6(tp2),
    tp3: round6(tp3),
    stopLoss: round6(stopLoss),
    confidence,
    riskReward: round2(riskReward),
    sentimentScore: round2(sentimentScore),
    rationale: input.rationale.slice(0, 240),
    technicals,
    refPrice: round6(price),
    status: 'active',
    createdAt: now,
    expiresAt: now + cfg.ttlMs,
    disclaimer: DISCLAIMER,
  }
  return { signal }
}

// ── User-configured trades ──────────────────────────────────────────────────
// A signal is a suggestion; a tracked trade is the operator's OWN plan — their chosen
// entry zone, leverage, stop and take-profits. buildUserTrade validates that plan
// (levels on the correct side of entry, ordered outward) and returns a TradeSignal the
// engine tracks exactly like an AI signal. Pure — no clock/RNG (id/now injected).

export interface UserTradeInput {
  id: string
  now: number
  symbol: string
  cgId: string
  direction: SignalDirection
  entryLow: number
  entryHigh: number
  stopLoss: number
  tp1: number
  tp2?: number // defaults to tp1 (single-target plan)
  tp3?: number // defaults to tp2
  leverageMin?: number
  leverageMax?: number
  refPrice?: number
  confidence?: number // carried from the source signal (display only)
  sentimentScore?: number
  rationale?: string
  technicals?: SignalTechnicals
  ttlMs?: number // default 14d for a hand-managed trade
}

const USER_TTL_MS = 14 * 24 * 3_600_000
const ZERO_TECH: SignalTechnicals = { rsi: 0, emaFast: 0, emaSlow: 0, sma: 0, trend: 'range', change24hPct: 0, volatilityPct: 0 }

/** Validate + normalize an operator-configured trade into a trackable TradeSignal. */
export function buildUserTrade(i: UserTradeInput): { trade: TradeSignal } | { error: string } {
  // Validate identity BEFORE the numeric checks: `i.symbol.toUpperCase()` / the cgId price
  // source are used unguarded below, so a missing/non-string symbol would throw a 500 (a
  // TypeError has no .status) instead of a clean 400, and a garbage direction would silently
  // build a SHORT. Guard both here. [route-validation]
  if (typeof i.symbol !== 'string' || !i.symbol.trim()) return { error: 'Pick a coin (symbol required)' }
  if (typeof i.cgId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(i.cgId)) return { error: 'A valid coin id is required' }
  if (i.direction !== 'LONG' && i.direction !== 'SHORT') return { error: 'Direction must be LONG or SHORT' }
  const long = i.direction === 'LONG'
  const entryLow = Math.min(i.entryLow, i.entryHigh)
  const entryHigh = Math.max(i.entryLow, i.entryHigh)
  const entryMid = (entryLow + entryHigh) / 2
  if (!(entryMid > 0)) return { error: 'Entry price must be greater than 0' }

  const sl = i.stopLoss
  if (!(sl > 0)) return { error: 'Stop-loss must be greater than 0' }
  if (long ? sl >= entryMid : sl <= entryMid) return { error: `Stop-loss must be ${long ? 'below' : 'above'} the entry for a ${i.direction}` }

  const tp1 = i.tp1
  const tp2 = i.tp2 ?? tp1
  const tp3 = i.tp3 ?? tp2
  const ordered = long ? tp1 > entryMid && tp2 >= tp1 && tp3 >= tp2 : tp1 < entryMid && tp2 <= tp1 && tp3 <= tp2
  if (!ordered) return { error: `Take-profits must be ${long ? 'above' : 'below'} entry and ordered TP1 → TP2 → TP3` }

  const risk = Math.abs(entryMid - sl)
  if (!(risk > 0)) return { error: 'Stop-loss is too close to the entry' }
  const riskReward = Math.abs(tp1 - entryMid) / risk

  const levMax = clamp(Math.round(i.leverageMax ?? 5), 1, 125)
  const levMin = clamp(Math.round(i.leverageMin ?? Math.min(2, levMax)), 1, levMax)

  const trade: TradeSignal = {
    id: i.id,
    asset: `${i.symbol.toUpperCase()}/USDT`,
    symbol: i.symbol.toUpperCase(),
    cgId: i.cgId,
    direction: i.direction,
    entryLow: round6(entryLow),
    entryHigh: round6(entryHigh),
    entryMid: round6(entryMid),
    leverageMin: levMin,
    leverageMax: levMax,
    tp1: round6(tp1),
    tp2: round6(tp2),
    tp3: round6(tp3),
    stopLoss: round6(sl),
    confidence: Math.round(clamp(i.confidence ?? 0, 0, 100)),
    riskReward: round2(riskReward),
    sentimentScore: round2(clamp(i.sentimentScore ?? 0, -1, 1)),
    rationale: (i.rationale ?? 'Operator-configured trade').slice(0, 240),
    technicals: i.technicals ?? ZERO_TECH,
    refPrice: round6(i.refPrice ?? entryMid),
    status: 'active',
    createdAt: i.now,
    expiresAt: i.now + (i.ttlMs && i.ttlMs > 0 ? i.ttlMs : USER_TTL_MS),
    disclaimer: DISCLAIMER,
    source: 'user',
  }
  return { trade }
}

// ── Outcome tracking (forward-test) ─────────────────────────────────────────

/** Signed R multiple of a price vs the signal's entry/stop (positive = favorable). */
function rOf(sig: TradeSignal, price: number): number {
  const risk = Math.abs(sig.entryMid - sig.stopLoss)
  if (!(risk > 0)) return 0
  return sig.direction === 'LONG' ? (price - sig.entryMid) / risk : (sig.entryMid - price) / risk
}

const reached = (sig: TradeSignal, price: number, level: number) => (sig.direction === 'LONG' ? price >= level : price <= level)
const stopped = (sig: TradeSignal, price: number) => (sig.direction === 'LONG' ? price <= sig.stopLoss : price >= sig.stopLoss)

/**
 * Advance a signal against the current price, returning the (new object) updated
 * signal. Stamps tp1/tp2/tp3 touches once each, and CLOSES on a stop, the final
 * target, or expiry. Models scale-out thirds with a FIXED stop (the stop is never
 * moved): ⅓ booked at each target as it prints; the residual is closed at the stop
 * (−1R) or marked-to-market at expiry. Pure — `now`/`price` are injected. Idempotent
 * once closed. This is the forward-test harness: zero capital, real price action.
 */
export function nextSignalState(prev: TradeSignal, price: number, now: number): TradeSignal {
  if (prev.status === 'stopped' || prev.status === 'tp3' || prev.status === 'expired') return prev
  if (!(price > 0)) return prev
  const sig: TradeSignal = { ...prev }

  // Stamp target touches (monotonic — once set, never cleared).
  if (sig.hitTp1At === undefined && reached(sig, price, sig.tp1)) sig.hitTp1At = now
  if (sig.hitTp2At === undefined && reached(sig, price, sig.tp2)) sig.hitTp2At = now
  if (sig.hitTp3At === undefined && reached(sig, price, sig.tp3)) sig.hitTp3At = now

  const filled = (sig.hitTp1At ? 1 : 0) + (sig.hitTp2At ? 1 : 0) + (sig.hitTp3At ? 1 : 0)

  const close = (status: SignalStatus, closePrice: number) => {
    sig.status = status
    sig.closedAt = now
    sig.closePrice = round6(closePrice)
    // Booked thirds at each printed target + the residual third(s) at the close price.
    const bookedR = (sig.hitTp1At ? rOf(sig, sig.tp1) : 0) + (sig.hitTp2At ? rOf(sig, sig.tp2) : 0) + (sig.hitTp3At ? rOf(sig, sig.tp3) : 0)
    const residual = (3 - filled) / 3
    sig.realizedR = round2(bookedR / 3 + residual * rOf(sig, closePrice))
    return sig
  }

  if (sig.hitTp3At) return close('tp3', sig.tp3) // full runner home
  if (stopped(sig, price)) return close('stopped', sig.stopLoss)
  if (now >= sig.expiresAt) return close('expired', price)

  // Still open — reflect the furthest target reached in the live status.
  sig.status = sig.hitTp2At ? 'tp2' : sig.hitTp1At ? 'tp1' : 'active'
  return sig
}

// ── Forward-test stats ──────────────────────────────────────────────────────

export interface SignalStats {
  closed: number
  wins: number // realizedR > 0
  losses: number
  winRatePct: number | null
  avgR: number | null // mean realized R across closed signals
  totalR: number
  tp1HitRatePct: number | null // share of closed signals that printed TP1
  bestR: number | null
  worstR: number | null
  active: number
}

/** Forward-test summary over closed (+ active count) signals. Pure. */
export function summarizeSignals(closed: TradeSignal[], activeCount = 0): SignalStats {
  const done = closed.filter((s) => s.realizedR !== undefined)
  const n = done.length
  if (!n) return { closed: 0, wins: 0, losses: 0, winRatePct: null, avgR: null, totalR: 0, tp1HitRatePct: null, bestR: null, worstR: null, active: activeCount }
  const rs = done.map((s) => s.realizedR as number)
  const wins = rs.filter((r) => r > 0).length
  const totalR = rs.reduce((a, b) => a + b, 0)
  const tp1 = done.filter((s) => s.hitTp1At !== undefined).length
  return {
    closed: n,
    wins,
    losses: n - wins,
    winRatePct: round1((wins / n) * 100),
    avgR: round2(totalR / n),
    totalR: round2(totalR),
    tp1HitRatePct: round1((tp1 / n) * 100),
    bestR: round2(Math.max(...rs)),
    worstR: round2(Math.min(...rs)),
    active: activeCount,
  }
}

const round1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0)
const round2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0)
const round6 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0)
