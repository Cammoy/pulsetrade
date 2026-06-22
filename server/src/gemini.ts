// Thin, dependency-free Gemini helper (v1beta REST, gemini-2.5-flash) for
// structured JSON responses. Shared by the AI trader and Smart Money insights.
// Needs GEMINI_API_KEY; callers degrade gracefully when it's absent.

export const geminiReady = () => Boolean(process.env.GEMINI_API_KEY)
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash'

/**
 * Ask Gemini for a JSON object matching `schema` (OpenAPI-style). Returns the
 * parsed object, or null on any failure (no key, network error, bad JSON) so the
 * caller can fall back cleanly. `thinkingBudget: 0` keeps these small calls cheap.
 */
export async function geminiJson<T>(system: string, user: string, schema: object, maxTokens = 2048): Promise<T | null> {
  if (!geminiReady()) return null
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
      console.error(`[gemini] request failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
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
