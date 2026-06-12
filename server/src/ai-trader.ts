// AI trading signals powered by Claude (claude-opus-4-8 via the Anthropic SDK).
//
// One signal is computed per (network, token) and SHARED by every AI bot on
// that token, refreshed at most every 10 minutes, so cost stays bounded no
// matter how many AI bots run. Needs ANTHROPIC_API_KEY; without it AI bots
// hold and clearly log that the key is missing.

import Anthropic from '@anthropic-ai/sdk'
import { sma, ema, rsi } from './indicators.js'

export const aiReady = () => Boolean(process.env.ANTHROPIC_API_KEY)

export interface AiSignal {
  action: 'buy' | 'sell' | 'hold'
  confidence: number // 0..1
  reason: string
  at: number
  stale?: boolean
}

const REFRESH_MS = 10 * 60_000
const cache = new Map<string, AiSignal>()
const inflight = new Map<string, Promise<AiSignal | null>>()

let client: Anthropic | null = null
function anthropic(): Anthropic {
  if (!client) client = new Anthropic() // reads ANTHROPIC_API_KEY from env
  return client
}

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['buy', 'sell', 'hold'] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['action', 'confidence', 'reason'],
} as const

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
    const res = await anthropic().messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 512,
      system:
        'You are a disciplined crypto trading analyst. Given a market snapshot, decide whether to BUY, SELL, or HOLD a swing position over the next several hours. Be risk-aware: prefer HOLD when signals conflict. Respond ONLY with the structured object: action, confidence (0..1), and a one-sentence reason citing the data.',
      messages: [{ role: 'user', content: marketBrief(symbol, closes) }],
      output_config: { format: { type: 'json_schema', schema: DECISION_SCHEMA } },
    } as any)
    const text = res.content.find((b: any) => b.type === 'text') as any
    if (!text?.text) return null
    const parsed = JSON.parse(text.text)
    const action = ['buy', 'sell', 'hold'].includes(parsed.action) ? parsed.action : 'hold'
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))
    return { action, confidence, reason: String(parsed.reason ?? '').slice(0, 240), at: Date.now() }
  } catch (e: any) {
    console.error('[ai] signal request failed:', e?.message ?? e)
    return null
  }
}

/**
 * Get the current AI signal for a token, refreshing in the background if stale.
 * Returns the cached signal immediately (or null on first call before any
 * result). Never blocks the engine tick on the network round-trip.
 */
export function getAiSignal(network: string, symbol: string, closes: number[]): AiSignal | null {
  if (!aiReady()) return { action: 'hold', confidence: 0, reason: 'ANTHROPIC_API_KEY not set — AI bot holding', at: Date.now(), stale: true }
  const key = `${network}:${symbol}`
  const cached = cache.get(key)
  const fresh = cached && Date.now() - cached.at < REFRESH_MS
  if (!fresh && !inflight.has(key) && closes.length >= 30) {
    const p = requestSignal(symbol, closes).then((sig) => {
      if (sig) cache.set(key, sig)
      inflight.delete(key)
      return sig
    })
    inflight.set(key, p)
  }
  return cached ?? null
}

/** Test seam: inject a signal without calling the API. */
export const __setSignal = (network: string, symbol: string, sig: AiSignal) => cache.set(`${network}:${symbol}`, sig)
