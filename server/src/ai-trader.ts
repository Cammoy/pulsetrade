// AI trading signals powered by Google Gemini (gemini-2.5-flash, v1beta REST —
// no SDK needed). Chosen over other providers to keep AI costs minimal: the
// free tier covers this usage pattern comfortably.
//
// One signal is computed per (network, token) and SHARED by every AI bot on
// that token, refreshed at most every 10 minutes, so cost stays bounded no
// matter how many AI bots run. Needs GEMINI_API_KEY; without it AI bots hold
// and clearly log that the key is missing.

import { sma, ema, rsi } from './indicators.js'

export const aiReady = () => Boolean(process.env.GEMINI_API_KEY)
export const AI_PROVIDER = 'gemini'
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

export interface AiSignal {
  action: 'buy' | 'sell' | 'hold'
  confidence: number // 0..1
  reason: string
  at: number
  stale?: boolean
}

const REFRESH_MS = 10 * 60_000
// Consumer-side staleness ceiling: if Gemini refresh keeps failing (outage, quota
// exhausted, key revoked), never act on the last signal forever — past this age it
// is treated as HOLD. Background refresh still runs; we just stop trading on stale.
const STALE_CEILING_MS = 3 * REFRESH_MS // 30 min
const cache = new Map<string, AiSignal>()
const inflight = new Map<string, Promise<AiSignal | null>>()

const SYSTEM =
  'You are a disciplined crypto trading analyst. Given a market snapshot, decide whether to BUY, SELL, or HOLD a swing position over the next several hours. Be risk-aware: prefer HOLD when signals conflict. Respond only with the JSON object: action, confidence (0..1), and a one-sentence reason citing the data.'

// Gemini structured output (OpenAPI-style schema). Note: response schema and
// tool use cannot be combined on v1beta — we use no tools, so this is fine.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING', enum: ['buy', 'sell', 'hold'] },
    confidence: { type: 'NUMBER' },
    reason: { type: 'STRING' },
  },
  required: ['action', 'confidence', 'reason'],
}

/** Build a compact, factual market summary for the model from recent closes. */
function marketBrief(symbol: string, closes: number[]): string {
  const last = closes[closes.length - 1]
  const chg = (h: number) => {
    const i = closes.length - 1 - h
    return i >= 0 ? (((last - closes[i]) / closes[i]) * 100).toFixed(2) + '%' : 'n/a'
  }
  return [
    `Token: ${symbol}`,
    `Price: $${last}`,
    `Change 1h/6h/24h/7d: ${chg(1)} / ${chg(6)} / ${chg(24)} / ${chg(168)}`,
    `RSI(14): ${rsi(closes, 14).toFixed(1)}`,
    `SMA(24): $${sma(closes, 24).toFixed(6)}  EMA(9): $${ema(closes, 9).toFixed(6)}  EMA(21): $${ema(closes, 21).toFixed(6)}`,
    `24h high/low: $${Math.max(...closes.slice(-24))} / $${Math.min(...closes.slice(-24))}`,
  ].join('\n')
}

async function requestSignal(symbol: string, closes: number[]): Promise<AiSignal | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: marketBrief(symbol, closes) }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.2,
            maxOutputTokens: 1024,
            // 2.5-flash "thinks" by default, which burns tokens before the JSON
            // arrives — disable it for this small classification-style call.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
    )
    if (!res.ok) {
      console.error(`[ai] gemini request failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
      return null
    }
    const data: { candidates?: { content?: { parts?: { text?: string }[] } }[] } = await res.json()
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
    if (!text) return null
    const parsed = JSON.parse(text)
    const action = ['buy', 'sell', 'hold'].includes(parsed.action) ? parsed.action : 'hold'
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))
    return { action, confidence, reason: String(parsed.reason ?? '').slice(0, 240), at: Date.now() }
  } catch (e) {
    console.error('[ai] signal request failed:', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Get the current AI signal for a token, refreshing in the background if stale.
 * Returns the cached signal immediately (or null on first call before any
 * result). Never blocks the engine tick on the network round-trip.
 */
export function getAiSignal(network: string, symbol: string, closes: number[]): AiSignal | null {
  if (!aiReady()) return { action: 'hold', confidence: 0, reason: 'GEMINI_API_KEY not set — AI bot holding', at: Date.now(), stale: true }
  const key = `${network}:${symbol}`
  const cached = cache.get(key)
  const age = cached ? Date.now() - cached.at : Infinity
  const fresh = age < REFRESH_MS
  if (!fresh && !inflight.has(key) && closes.length >= 30) {
    const p = requestSignal(symbol, closes).then((sig) => {
      if (sig) cache.set(key, sig)
      inflight.delete(key)
      return sig
    })
    inflight.set(key, p)
  }
  if (!cached) return null
  // A signal we couldn't refresh for too long is no longer safe to trade on — hold
  // (the background refresh above still runs, so a recovered API resumes trading).
  if (age >= STALE_CEILING_MS)
    return { action: 'hold', confidence: 0, reason: `AI signal ${Math.round(age / 60_000)}m stale — holding until refresh`, at: cached.at, stale: true }
  return cached
}

/** Test seam: inject a signal without calling the API. */
export const __setSignal = (network: string, symbol: string, sig: AiSignal) => cache.set(`${network}:${symbol}`, sig)
