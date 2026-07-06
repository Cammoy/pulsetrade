// Thin, dependency-free Gemini helper (v1beta REST, gemini-2.5-flash) for
// structured JSON responses. Shared by the AI trader and Smart Money insights.
// Needs GEMINI_API_KEY; callers degrade gracefully when it's absent.

export const geminiReady = () => Boolean(process.env.GEMINI_API_KEY)
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash'

// ── Shared quota breaker ─────────────────────────────────────────────────────────
// Gemini's free tier answers 429 once the per-minute/day quota is spent. Without a
// backoff every caller (signal validation AND grounded news) keeps hammering it each
// scan — flooding logs and burning more quota that would otherwise recover. A 429 trips
// one SHARED cooldown: all Gemini callers pause together, then resume automatically when
// it lifts. We honour the server's RetryInfo `retryDelay` when present, clamped sanely.
const DEFAULT_COOLDOWN_MS = 10 * 60_000
const MAX_COOLDOWN_MS = 60 * 60_000
let cooldownUntil = 0

/** True while the shared Gemini cooldown is in effect (set after a recent 429). Callers
 *  should skip the request and degrade, rather than pile on more throttled calls. */
export const geminiThrottled = (now: number = Date.now()): boolean => now < cooldownUntil
/** When the cooldown lifts, as an epoch ms (0 when not throttled) — surfaced to the UI. */
export const geminiCooldownUntil = (): number => cooldownUntil

/** Trip the shared cooldown after a 429. Honours a `retryDelay` (e.g. "37s") parsed from
 *  the error body when present, clamped to [DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS]. */
export function noteGeminiRateLimited(body = '', now: number = Date.now()): void {
  const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body)
  const retryMs = m ? Number(m[1]) * 1000 : DEFAULT_COOLDOWN_MS
  const ms = Math.min(MAX_COOLDOWN_MS, Math.max(DEFAULT_COOLDOWN_MS, retryMs))
  cooldownUntil = Math.max(cooldownUntil, now + ms)
}

/** Test seam: clear the breaker between cases. */
export const __resetGeminiBreaker = (): void => {
  cooldownUntil = 0
}

/**
 * Ask Gemini for a JSON object matching `schema` (OpenAPI-style). Returns the
 * parsed object, or null on any failure (no key, network error, bad JSON) so the
 * caller can fall back cleanly. `thinkingBudget: 0` keeps these small calls cheap.
 */
export async function geminiJson<T>(system: string, user: string, schema: object, maxTokens = 2048): Promise<T | null> {
  if (!geminiReady() || geminiThrottled()) return null
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          temperature: 0.3,
          maxOutputTokens: maxTokens,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      if (res.status === 429) noteGeminiRateLimited(body)
      console.error(`[gemini] request failed: ${res.status} ${body.slice(0, 200)}`)
      return null
    }
    const data: { candidates?: { content?: { parts?: { text?: string }[] } }[] } = await res.json()
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
    if (!text) return null
    return JSON.parse(text) as T
  } catch (e) {
    console.error('[gemini] request error:', e instanceof Error ? e.message : e)
    return null
  }
}
