// H5 / H6 (AI-1, AI-2): the AI trader must fail CLOSED — hold without a key, hold
// on a signal too stale to refresh, clamp/whitelist a garbage model response, and
// gemini.geminiJson must degrade to null on every failure. Stubs global.fetch so
// no real Gemini call runs.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.GEMINI_API_KEY = 'test-key' // aiReady()/geminiReady() are env-gated
const realFetch = globalThis.fetch

const { getAiSignal, __setSignal } = await import('../src/ai-trader.js')
const { geminiJson, geminiReady } = await import('../src/gemini.js')

const CLOSES = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3)) // >=30, non-constant

/** Build the Gemini REST envelope around a model text payload. */
const envelope = (text: string, status = 200) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status })

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key'
  globalThis.fetch = realFetch
})

test('no GEMINI_API_KEY → AI holds and flags itself stale (never trades blind)', () => {
  delete process.env.GEMINI_API_KEY
  const sig = getAiSignal('arbitrum', 'NOKEY', CLOSES)
  assert.ok(sig)
  assert.equal(sig!.action, 'hold')
  assert.equal(sig!.stale, true)
})

test('H5: a cached signal too old to refresh is returned as HOLD, not acted on', () => {
  // Refresh keeps failing → the cache can never update.
  globalThis.fetch = (async () => envelope('', 500)) as typeof fetch
  const old = Date.now() - 31 * 60_000 // 31 min — past the 30 min staleness ceiling
  __setSignal('arbitrum', 'STALE', { action: 'buy', confidence: 0.9, reason: 'old bullish call', at: old })
  const sig = getAiSignal('arbitrum', 'STALE', CLOSES)
  assert.ok(sig)
  assert.equal(sig!.action, 'hold', 'a stale buy must NOT keep firing — it degrades to hold')
  assert.equal(sig!.stale, true)
})

test('a fresh cached signal is returned as-is (acted on)', () => {
  __setSignal('arbitrum', 'FRESH', { action: 'buy', confidence: 0.8, reason: 'fresh', at: Date.now() })
  const sig = getAiSignal('arbitrum', 'FRESH', CLOSES)
  assert.equal(sig!.action, 'buy')
  assert.notEqual(sig!.stale, true)
})

test('AI-2: a garbage model response is clamped — action whitelisted to hold, confidence ∈ [0,1], reason truncated', async () => {
  globalThis.fetch = (async () =>
    envelope(JSON.stringify({ action: 'frobnicate', confidence: 5, reason: 'x'.repeat(400) }))) as typeof fetch
  // First call has no cache → returns null but kicks off the (stubbed) refresh.
  assert.equal(getAiSignal('arbitrum', 'CLAMP', CLOSES), null)
  await new Promise((r) => setTimeout(r, 25)) // let the background refresh settle
  const sig = getAiSignal('arbitrum', 'CLAMP', CLOSES)
  assert.ok(sig, 'signal cached after refresh')
  assert.equal(sig!.action, 'hold', 'unknown action falls back to hold')
  assert.ok(sig!.confidence >= 0 && sig!.confidence <= 1, `confidence clamped, got ${sig!.confidence}`)
  assert.ok(sig!.reason.length <= 240, `reason truncated, got ${sig!.reason.length}`)
})

test('geminiJson returns null without a key, on a non-OK status, and on unparseable JSON', async () => {
  assert.equal(geminiReady(), true)

  delete process.env.GEMINI_API_KEY
  assert.equal(await geminiJson('s', 'u', {}), null, 'no key → null')

  process.env.GEMINI_API_KEY = 'test-key'
  globalThis.fetch = (async () => envelope('whatever', 500)) as typeof fetch
  assert.equal(await geminiJson('s', 'u', {}), null, 'non-OK → null')

  globalThis.fetch = (async () => envelope('not json at all')) as typeof fetch
  assert.equal(await geminiJson('s', 'u', {}), null, 'bad JSON → null')
})

test('geminiJson parses a valid structured response', async () => {
  globalThis.fetch = (async () => envelope(JSON.stringify({ verdict: 'risk-on', score: 7 }))) as typeof fetch
  const out = await geminiJson<{ verdict: string; score: number }>('s', 'u', {})
  assert.deepEqual(out, { verdict: 'risk-on', score: 7 })
})
