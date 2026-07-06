// Up-to-the-minute news/social sentiment per asset, powered by Gemini — no separate
// news API. The catch: on v1beta you CANNOT combine Google Search grounding (a tool)
// with a responseSchema (structured JSON) in one call (see the note in ai-trader.ts).
// So sentiment is a TWO-STEP flow:
//   1. a GROUNDED call (google_search tool) → a short, cited news brief for the asset
//   2. a STRUCTURED call (responseSchema, via geminiJson) → a −1..+1 score of that brief
// One result per symbol, cached + refreshed in the background (like ai-trader/insights)
// so the scan never blocks on the network and Gemini cost stays bounded. Degrades to a
// NEUTRAL score (0) when GEMINI_API_KEY is absent or either call fails, so a missing key
// never silently biases the sentiment filter — it just makes it a no-op.

import { geminiJson, geminiReady, geminiThrottled, noteGeminiRateLimited } from './gemini.js'

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash'
export const newsReady = () => geminiReady()

export interface NewsSentiment {
  symbol: string
  score: number // −1 (very bearish) .. +1 (very bullish); 0 = neutral/unknown
  label: 'bullish' | 'neutral' | 'bearish'
  summary: string // one-line synthesis of the news
  headlines: string[] // grounded source titles (citations)
  sources: string[] // grounded source URLs
  at: number
  stale: boolean // true when we couldn't reach the model (neutral fallback)
}

const REFRESH_MS = 15 * 60_000
const STALE_CEILING_MS = 3 * REFRESH_MS // 45 min — past this, a cached score is treated as neutral
const cache = new Map<string, NewsSentiment>()
const inflight = new Map<string, Promise<NewsSentiment | null>>()

const neutral = (symbol: string, now: number, stale = true): NewsSentiment => ({
  symbol,
  score: 0,
  label: 'neutral',
  summary: newsReady() ? 'No fresh news read — treating sentiment as neutral.' : 'Sentiment disabled (GEMINI_API_KEY not set).',
  headlines: [],
  sources: [],
  at: now,
  stale,
})

const SCORE_SYSTEM =
  'You are a crypto market sentiment analyst. Given a short news brief about ONE asset, output a single sentiment score from -1 (very bearish) to +1 (very bullish), a label, and a one-sentence summary. Weigh price-relevant, recent, credible news most. If the brief is empty or irrelevant, score 0 (neutral). Output ONLY the JSON object.'

const SCORE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: { type: 'NUMBER' },
    label: { type: 'STRING', enum: ['bullish', 'neutral', 'bearish'] },
    summary: { type: 'STRING' },
  },
  required: ['score', 'label', 'summary'],
}

interface GroundedBrief {
  text: string
  headlines: string[]
  sources: string[]
}

/** Step 1: a grounded (google_search) Gemini call → recent news text + citations.
 *  No responseSchema here (can't mix with tools on v1beta). Returns null on any failure. */
async function fetchGroundedNews(symbol: string, name: string): Promise<GroundedBrief | null> {
  if (geminiThrottled()) return null
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: 'You are a crypto news researcher. Using web search, summarize the most market-relevant news and social sentiment for the given asset over the LAST 48 HOURS in 3-5 concise bullet points. Note catalysts (ETF flows, listings, hacks, regulation, unlocks, partnerships) and the overall tone. If there is no notable recent news, say so plainly.',
            },
          ],
        },
        contents: [{ role: 'user', parts: [{ text: `Asset: ${name} (${symbol}). What is the latest crypto news and sentiment?` }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text()
      if (res.status === 429) noteGeminiRateLimited(body)
      console.error(`[news] grounded request failed: ${res.status} ${body.slice(0, 200)}`)
      return null
    }
    const data: {
      candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } }[]
    } = await res.json()
    const cand = data?.candidates?.[0]
    const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    const chunks = cand?.groundingMetadata?.groundingChunks ?? []
    const headlines: string[] = []
    const sources: string[] = []
    for (const c of chunks) {
      const title = c.web?.title
      const uri = c.web?.uri
      if (title && !headlines.includes(title)) headlines.push(title)
      if (uri && !sources.includes(uri)) sources.push(uri)
    }
    return { text, headlines: headlines.slice(0, 6), sources: sources.slice(0, 6) }
  } catch (e) {
    console.error('[news] grounded request error:', e instanceof Error ? e.message : e)
    return null
  }
}

/** Build the cached sentiment for a symbol (both Gemini steps). Null on failure so
 *  the caller keeps its previous value / neutral. */
async function buildSentiment(symbol: string, name: string, now: number): Promise<NewsSentiment | null> {
  const brief = await fetchGroundedNews(symbol, name)
  if (!brief) return null
  const scored = await geminiJson<{ score: number; label: NewsSentiment['label']; summary: string }>(
    SCORE_SYSTEM,
    `Asset: ${name} (${symbol}).\n\nNews brief:\n${brief.text || '(no notable recent news)'}`,
    SCORE_SCHEMA,
    512,
  )
  if (!scored) return null
  const score = Math.max(-1, Math.min(1, Number(scored.score) || 0))
  const label: NewsSentiment['label'] = ['bullish', 'neutral', 'bearish'].includes(scored.label) ? scored.label : score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral'
  return {
    symbol,
    score: Math.round(score * 100) / 100,
    label,
    summary: String(scored.summary ?? '').slice(0, 240),
    headlines: brief.headlines,
    sources: brief.sources,
    at: now,
    stale: false,
  }
}

/**
 * Current news sentiment for an asset. Serves a fresh cache immediately; refreshes in
 * the BACKGROUND when stale so the signal scan never blocks on Gemini. Returns a neutral
 * score when no key is set, before the first result lands, or when the cache has gone
 * too stale to trust — so the sentiment filter is a clean no-op rather than a wrong veto.
 */
export function getNewsSentiment(symbol: string, name: string, now: number = Date.now()): NewsSentiment {
  if (!newsReady()) return neutral(symbol, now)
  const key = symbol.toUpperCase()
  const cached = cache.get(key)
  const age = cached ? now - cached.at : Infinity
  if (age >= REFRESH_MS && !inflight.has(key)) {
    const p = buildSentiment(key, name, Date.now())
      .then((s) => {
        if (s) cache.set(key, s)
        return s
      })
      .catch((e) => {
        console.error('[news] sentiment build failed:', e instanceof Error ? e.message : e)
        return null
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  if (!cached) return neutral(symbol, now)
  if (age >= STALE_CEILING_MS) return { ...cached, score: 0, label: 'neutral', stale: true }
  return cached
}

/** Await the next refresh for a symbol (used by the engine's first scan + tests), then
 *  return the freshest value. Falls back to the sync getter. */
export async function ensureNewsSentiment(symbol: string, name: string, now: number = Date.now()): Promise<NewsSentiment> {
  if (!newsReady()) return neutral(symbol, now)
  const key = symbol.toUpperCase()
  getNewsSentiment(symbol, name, now) // kick a refresh if stale
  const p = inflight.get(key)
  if (p) await p.catch(() => {})
  return getNewsSentiment(symbol, name, Date.now())
}

/** Test seam: inject a sentiment without calling the API. */
export const __setSentiment = (symbol: string, s: NewsSentiment) => cache.set(symbol.toUpperCase(), s)
