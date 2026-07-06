// The trading-signal channel ORCHESTRATOR — the "intelligent", filter-first workflow:
//
//   1. SCANNER   — marketOverview() (top-by-cap, with technicals) → scanCandidates()
//                  flags the coins that are genuinely in play with a directional edge.
//   2. VALIDATE  — Gemini reads each candidate's chart history + news sentiment and
//                  decides whether to proceed: is it trending (not ranging/choppy)? any
//                  imminent binary event? which direction? how confident?
//   3. RISK GATE — buildSignal() constructs the standardized signal and REJECTS it
//                  unless R:R ≥ 1.5, confidence clears the floor, and sentiment doesn't
//                  strongly oppose the trade.
//   4. PUBLISH   — only validated signals reach the channel (WS broadcast + REST).
//
// Every active signal is then tracked tick-by-tick against live price (the forward-test
// harness) so the channel reports its OWN real-time accuracy. State lives in state.signals
// (persisted), so the forward-test record survives restarts. The whole thing is a no-op
// without GEMINI_API_KEY — the channel reports `needsAi` and the UI prompts for the key.

import { state, save, uid } from './store.js'
import { broadcast } from './broadcast.js'
import { geminiJson, geminiReady, geminiThrottled } from './gemini.js'
import { marketOverview } from './market.js'
import { getCandles, getSpotPrices, spotFresh } from './prices.js'
import { ensureNewsSentiment, type NewsSentiment } from './news-sentiment.js'
import {
  scanCandidates,
  buildSignal,
  buildUserTrade,
  nextSignalState,
  summarizeSignals,
  toRadarEntry,
  type Candidate,
  type RadarEntry,
  type SignalConfig,
  type SignalDirection,
  type TradeSignal,
  type UserTradeInput,
} from './signals.js'

// ── Config (env-overridable; clamped to sane ranges) ────────────────────────
const envNum = (name: string, def: number, min: number, max: number): number => {
  const v = Number(process.env[name])
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def
}
const SCAN_MS = envNum('SIGNALS_SCAN_MS', 5 * 60_000, 60_000, 3_600_000)
const MAX_ACTIVE = envNum('SIGNALS_MAX_ACTIVE', 12, 1, 100)
const CANDIDATES_PER_SCAN = envNum('SIGNALS_CANDIDATES', 6, 1, 25)
// How many directional candidates to surface on the always-on radar. Floored at
// CANDIDATES_PER_SCAN — a lower value (e.g. SIGNALS_RADAR=0) would make scanCandidates return []
// so NOTHING is ever AI-validated or posted, while the channel still reports enabled:true. The
// extra radar entries beyond CANDIDATES_PER_SCAN are shown "queued" (not AI-validated, no Gemini cost).
const RADAR_N = Math.max(CANDIDATES_PER_SCAN, envNum('SIGNALS_RADAR', 12, 0, 50))
const HISTORY_CAP = 200
// Per-asset cooldown after a signal closes, so the channel doesn't immediately re-post the
// same coin. An asset with an ACTIVE signal is always skipped regardless.
const COOLDOWN_MS = envNum('SIGNALS_COOLDOWN_MS', 6 * 3_600_000, 0, 72 * 3_600_000)

const CONFIG: SignalConfig = {
  minRr: envNum('SIGNALS_MIN_RR', 1.5, 1, 10),
  minConfidence: envNum('SIGNALS_MIN_CONFIDENCE', 55, 0, 100),
  ttlMs: envNum('SIGNALS_TTL_HOURS', 48, 1, 720) * 3_600_000,
  maxLeverage: envNum('SIGNALS_MAX_LEVERAGE', 10, 1, 50),
}

/** The channel is live only with a Gemini key — every signal requires AI validation.
 *  Opt out entirely with SIGNALS_DISABLED=true. */
export const signalsEnabled = (): boolean => geminiReady() && process.env.SIGNALS_DISABLED !== 'true'

// ── AI validation phase ─────────────────────────────────────────────────────
interface AiValidation {
  proceed: boolean
  direction: SignalDirection | 'NONE'
  marketState: 'trending' | 'ranging' | 'choppy'
  binaryEventRisk: boolean
  confidence: number // 0..1
  rationale: string
}

const VALIDATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    proceed: { type: 'BOOLEAN' },
    direction: { type: 'STRING', enum: ['LONG', 'SHORT', 'NONE'] },
    marketState: { type: 'STRING', enum: ['trending', 'ranging', 'choppy'] },
    binaryEventRisk: { type: 'BOOLEAN' },
    confidence: { type: 'NUMBER' },
    rationale: { type: 'STRING' },
  },
  required: ['proceed', 'direction', 'marketState', 'binaryEventRisk', 'confidence', 'rationale'],
}

const VALIDATION_SYSTEM =
  'You are a disciplined crypto trading analyst validating a scanner candidate for a trade-signal channel. ' +
  'Given the chart snapshot, the scanner\'s proposed direction, and a news-sentiment read, decide whether to PROCEED. ' +
  'Set proceed=false when the market is RANGING or CHOPPY (directionless), when a known imminent binary event (CPI, FOMC, a major unlock/listing/vote) makes the technical setup unreliable, or when conviction is low. ' +
  'Confirm the direction (LONG/SHORT) or return NONE to reject. Give a confidence 0..1 and a single-sentence rationale that cites the actual data (e.g. "Bullish EMA cross on the 1h with RSI 41 and positive ETF-inflow news"). Output ONLY the JSON object.'

/** Build a compact, factual brief for the validator from a candidate + its closes + sentiment. */
function validationBrief(c: Candidate, closes: number[], sent: NewsSentiment): string {
  const last = closes[closes.length - 1]
  const pct = (h: number) => {
    const i = closes.length - 1 - h
    return i >= 0 ? (((last - closes[i]) / closes[i]) * 100).toFixed(2) + '%' : 'n/a'
  }
  return [
    `Asset: ${c.symbol} (${c.name})`,
    `Scanner proposes: ${c.direction}. Flagged because: ${c.triggers.join('; ')}.`,
    `Price: $${last}`,
    `Change 1h/6h/24h/7d: ${pct(1)} / ${pct(6)} / ${pct(24)} / ${pct(168)}`,
    `Technical signal: ${c.signal.action} (score ${c.signal.score}) — ${c.signal.reasons.join(', ')}`,
    `24h volume: $${(c.volume24hUsd ?? 0).toLocaleString()}; turnover (vol/mcap): ${c.volToMcap !== null ? (c.volToMcap * 100).toFixed(1) + '%' : 'n/a'}`,
    `News sentiment: ${sent.score >= 0 ? '+' : ''}${sent.score.toFixed(2)} (${sent.label})${sent.stale ? ' [no fresh news]' : ''} — ${sent.summary}`,
  ].join('\n')
}

async function aiValidate(c: Candidate, closes: number[], sent: NewsSentiment): Promise<AiValidation | null> {
  const raw = await geminiJson<Partial<AiValidation>>(VALIDATION_SYSTEM, validationBrief(c, closes, sent), VALIDATION_SCHEMA, 768)
  if (!raw) return null
  const direction = raw.direction === 'LONG' || raw.direction === 'SHORT' ? raw.direction : 'NONE'
  const marketState = raw.marketState === 'trending' || raw.marketState === 'ranging' || raw.marketState === 'choppy' ? raw.marketState : 'choppy'
  return {
    proceed: raw.proceed === true,
    direction,
    marketState,
    binaryEventRisk: raw.binaryEventRisk === true,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    rationale: String(raw.rationale ?? '').slice(0, 240),
  }
}

// ── Channel state accessors ─────────────────────────────────────────────────
// Each array is backfilled on access, so a partial/legacy state.signals (e.g. one saved
// before `tracked` existed) can never surface an undefined list to a consumer.
const store = () => (state.signals ??= { active: [], history: [], tracked: [] })
const active = (): TradeSignal[] => (store().active ??= [])
const history = (): TradeSignal[] => (store().history ??= [])
const tracked = (): TradeSignal[] => (store().tracked ??= [])

let lastScanAt = 0
let scanInflight = false
// The most recent scan's radar — the always-on watchlist of directional candidates,
// rebuilt each scan. Ephemeral market state (not persisted), served via REST + WS.
let radar: RadarEntry[] = []

export interface SignalsPayload {
  active: TradeSignal[]
  history: TradeSignal[]
  tracked: TradeSignal[]
  radar: RadarEntry[]
  stats: ReturnType<typeof summarizeSignals>
  enabled: boolean
  needsAi: boolean
  aiThrottled: boolean
  scanMs: number
  generatedAt: number | null
}

/** The full channel payload (REST + the dedicated WS frame). */
export function getSignalsPayload(): SignalsPayload {
  return {
    active: active(),
    history: history().slice(0, 50),
    tracked: tracked(),
    radar,
    stats: summarizeSignals(history(), active().length),
    enabled: signalsEnabled(),
    needsAi: !geminiReady(),
    aiThrottled: geminiReady() && geminiThrottled(),
    scanMs: SCAN_MS,
    generatedAt: lastScanAt || null,
  }
}

/** Lighter slice for the 20s snapshot — active + tracked + radar + stats (history rarely
 *  changes and is delivered by the dedicated `signals` frame + REST). */
export function getSignalsSnapshot() {
  return { active: active(), tracked: tracked(), radar, stats: summarizeSignals(history(), active().length), enabled: signalsEnabled(), needsAi: !geminiReady(), aiThrottled: geminiReady() && geminiThrottled(), generatedAt: lastScanAt || null }
}

const broadcastChannel = () => broadcast({ type: 'signals', payload: getSignalsPayload() })

/** CoinGecko ids the engine must keep priced for outcome tracking (active + tracked).
 *  Folded into the engine's per-tick batch so these coins — which live OUTSIDE the bot
 *  universe — get refreshed every tick instead of going stale after one fetch. */
export const signalPriceIds = (): string[] => [...new Set([...active(), ...tracked()].map((s) => s.cgId))]

/** Skip an asset that already has a live signal or closed one within the cooldown. */
function recentlySignalled(symbol: string, now: number): boolean {
  const s = symbol.toUpperCase()
  if (active().some((sig) => sig.symbol === s)) return true
  return history().some((sig) => sig.symbol === s && sig.closedAt !== undefined && now - sig.closedAt < COOLDOWN_MS)
}

function publish(sig: TradeSignal) {
  active().unshift(sig) // newest first
  broadcast({ type: 'signal', signal: sig })
  broadcastChannel()
  save()
  console.log(`[signals] ${sig.asset} ${sig.direction} @ ${sig.entryMid} — conf ${sig.confidence}%, R:R ${sig.riskReward}, sentiment ${sig.sentimentScore}`)
}

// ── Tracked trades (the operator's own configured plans) ─────────────────────
// These are user-owned, tracked exactly like signals but never counted in the AI stats.
// CRUD works WITHOUT a Gemini key — tracking a hand-built plan needs no AI.
const TRACKED_CAP = 50

/** What a tracked-trade request may carry (the rest is server-stamped). */
export type TrackedRequest = Omit<UserTradeInput, 'id' | 'now'>

export function createTracked(input: TrackedRequest): { trade: TradeSignal } | { error: string } {
  const res = buildUserTrade({ ...input, id: uid(), now: Date.now() })
  if ('error' in res) return res
  tracked().unshift(res.trade)
  if (tracked().length > TRACKED_CAP) tracked().length = TRACKED_CAP
  broadcast({ type: 'tracked', trade: res.trade })
  broadcastChannel()
  save()
  console.log(`[signals] tracked ${res.trade.asset} ${res.trade.direction} @ ${res.trade.entryMid} (SL ${res.trade.stopLoss}, R:R ${res.trade.riskReward})`)
  return res
}

/** Re-configure an open tracked trade. Changing the levels resets its outcome tracking
 *  (it's a new plan), so it can't carry stale target/stop hits. */
export function updateTracked(id: string, patch: Partial<TrackedRequest>): { trade: TradeSignal } | { error: string } {
  const list = tracked()
  const idx = list.findIndex((t) => t.id === id)
  if (idx < 0) return { error: 'Tracked trade not found' }
  const cur = list[idx]
  if (cur.closedAt !== undefined) return { error: 'This trade is already closed' }
  const res = buildUserTrade({
    id: cur.id,
    now: cur.createdAt,
    symbol: patch.symbol ?? cur.symbol,
    cgId: patch.cgId ?? cur.cgId,
    direction: patch.direction ?? cur.direction,
    entryLow: patch.entryLow ?? cur.entryLow,
    entryHigh: patch.entryHigh ?? cur.entryHigh,
    stopLoss: patch.stopLoss ?? cur.stopLoss,
    tp1: patch.tp1 ?? cur.tp1,
    tp2: patch.tp2 ?? cur.tp2,
    tp3: patch.tp3 ?? cur.tp3,
    leverageMin: patch.leverageMin ?? cur.leverageMin,
    leverageMax: patch.leverageMax ?? cur.leverageMax,
    refPrice: patch.refPrice ?? cur.refPrice,
    confidence: patch.confidence ?? cur.confidence,
    sentimentScore: patch.sentimentScore ?? cur.sentimentScore,
    rationale: patch.rationale ?? cur.rationale,
    technicals: cur.technicals,
  })
  if ('error' in res) return res
  // Re-configuring is "a new plan", so give it a FRESH full lifetime from now — keeping the
  // original createdAt (passed as `now` above, for history) but re-basing expiry to now + the
  // originally-chosen TTL. Anchoring expiry to the original createdAt (as buildUserTrade does)
  // would truncate — or instantly expire — an edit to an aging trade. [expiry-reset]
  res.trade.expiresAt = Date.now() + Math.max(0, cur.expiresAt - cur.createdAt)
  list[idx] = res.trade // fresh plan — outcome tracking starts clean
  broadcastChannel()
  save()
  return res
}

/** Remove a tracked trade (dismiss). */
export function closeTracked(id: string): boolean {
  const list = tracked()
  const idx = list.findIndex((t) => t.id === id)
  if (idx < 0) return false
  list.splice(idx, 1)
  broadcastChannel()
  save()
  return true
}

/**
 * Run one filter-first scan: discover candidates, validate with Gemini, gate on risk,
 * publish survivors. Throttled to SCAN_MS and single-flight. Safe to call often.
 */
export async function runSignalScan(now: number = Date.now()): Promise<void> {
  if (!signalsEnabled() || scanInflight || now - lastScanAt < SCAN_MS) return
  scanInflight = true
  lastScanAt = now
  try {
    const overview = await marketOverview()
    // Scan a WIDER set for the radar; only the top CANDIDATES_PER_SCAN spend a Gemini
    // validation. The rest are surfaced as "queued" watch rows (no AI cost).
    const candidates = scanCandidates(overview.coins, RADAR_N)
    const nextRadar: RadarEntry[] = []
    let aiBudget = CANDIDATES_PER_SCAN
    for (const c of candidates) {
      // Already have a live signal on this asset → show it on the radar as a signal.
      if (active().some((s) => s.symbol === c.symbol)) {
        nextRadar.push(toRadarEntry(c, 'signal', 'Live signal active'))
        continue
      }
      if (recentlySignalled(c.symbol, now)) {
        nextRadar.push(toRadarEntry(c, 'watching', 'Recently signalled — cooling down'))
        continue
      }
      // Gemini is cooling down after a quota 429 — don't spend (failing) calls; say so
      // honestly so the radar reflects WHY nothing is being validated right now.
      if (geminiThrottled(now)) {
        nextRadar.push(toRadarEntry(c, 'watching', 'AI paused — provider rate-limited'))
        continue
      }
      // Out of AI budget for this scan (or at capacity) → queue it, no Gemini call.
      if (aiBudget <= 0 || active().length >= MAX_ACTIVE) {
        nextRadar.push(toRadarEntry(c, 'watching', active().length >= MAX_ACTIVE ? 'Channel at capacity' : 'Queued — lower priority this scan'))
        continue
      }
      aiBudget--
      const closes = (await getCandles(c.cgId, 14)).map((p) => p.c).filter((x) => Number.isFinite(x) && x > 0)
      if (closes.length < 40) {
        nextRadar.push(toRadarEntry(c, 'watching', 'Not enough price history'))
        continue
      }
      const sentiment = await ensureNewsSentiment(c.symbol, c.name, now)
      const v = await aiValidate(c, closes, sentiment)
      if (!v) {
        nextRadar.push(toRadarEntry(c, 'watching', 'AI validation unavailable'))
        continue
      }
      if (!v.proceed || v.marketState !== 'trending' || v.binaryEventRisk) {
        const why = v.binaryEventRisk ? 'Binary event risk near-term' : v.marketState !== 'trending' ? `Market ${v.marketState}, not trending` : 'AI held — low conviction'
        nextRadar.push(toRadarEntry(c, 'watching', why))
        continue
      }
      const direction = v.direction === 'LONG' || v.direction === 'SHORT' ? v.direction : c.direction
      const res = buildSignal({ candidate: c, direction, closes, sentimentScore: sentiment.score, aiConfidence: v.confidence, rationale: v.rationale, now: Date.now(), config: CONFIG, id: uid() })
      if ('rejected' in res) {
        console.log(`[signals] ${c.symbol} ${direction} rejected — ${res.rejected}`)
        nextRadar.push(toRadarEntry({ ...c, direction }, 'watching', res.rejected))
        continue
      }
      publish(res.signal)
      nextRadar.push(toRadarEntry({ ...c, direction }, 'signal', 'Posted — cleared all filters'))
    }
    radar = nextRadar
    broadcastChannel() // push the refreshed radar even when nothing was published
  } catch (e) {
    console.error('[signals] scan failed', e)
  } finally {
    scanInflight = false
  }
}

/**
 * Forward-test step: advance every active signal against fresh price, move closed ones
 * to history, and broadcast on any transition. Cheap (cached spot prices + pure math) —
 * called every engine tick. Returns true if anything changed (for the snapshot).
 */
export async function trackSignalOutcomes(now: number = Date.now()): Promise<boolean> {
  const live = active()
  const userTrades = tracked()
  const openUser = userTrades.filter((t) => t.closedAt === undefined)
  if (!live.length && !openUser.length) return false
  await getSpotPrices([...new Set([...live, ...openUser].map((s) => s.cgId))]).catch(() => {})

  let changed = false

  // ── AI signals: closed ones graduate to history (feeding the forward-test stats) ──
  const remaining: TradeSignal[] = []
  const closed: TradeSignal[] = []
  for (const sig of live) {
    const price = spotFresh(sig.cgId)
    if (price === undefined) {
      remaining.push(sig) // unpriced this tick — keep, retry next
      continue
    }
    const next = nextSignalState(sig, price, now)
    const transitioned = next.status !== sig.status || (next.closedAt !== undefined && sig.closedAt === undefined)
    if (transitioned) {
      changed = true
      broadcast({ type: 'signal-update', signal: next })
    }
    if (next.closedAt !== undefined) closed.push(next)
    else remaining.push(next)
  }
  if (closed.length) {
    store().history = [...closed, ...history()].slice(0, HISTORY_CAP)
    for (const c of closed) console.log(`[signals] ${c.asset} ${c.direction} closed ${c.status} — ${c.realizedR && c.realizedR >= 0 ? '+' : ''}${c.realizedR}R`)
  }
  store().active = remaining

  // ── Tracked trades: advanced in place (closed ones stay until the operator dismisses) ──
  if (openUser.length) {
    store().tracked = userTrades.map((t) => {
      if (t.closedAt !== undefined) return t
      const price = spotFresh(t.cgId)
      if (price === undefined) return t
      const next = nextSignalState(t, price, now)
      if (next.status !== t.status || (next.closedAt !== undefined && t.closedAt === undefined)) {
        changed = true
        broadcast({ type: 'tracked-update', trade: next })
        if (next.closedAt !== undefined) console.log(`[signals] tracked ${next.asset} ${next.direction} closed ${next.status} — ${next.realizedR && next.realizedR >= 0 ? '+' : ''}${next.realizedR}R`)
      }
      return next
    })
  }

  if (changed) {
    broadcastChannel()
    save()
  }
  return changed
}

/** Test seam: reset the scan throttle so a unit test can drive runSignalScan deterministically. */
export const __resetScanClock = () => {
  lastScanAt = 0
  scanInflight = false
}
