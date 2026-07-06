// The shared Gemini quota breaker: a 429 trips a cooldown that ALL callers (signal
// validation + grounded news) respect, so the scan stops re-hammering an exhausted
// quota. Covers the cooldown window, retryDelay honouring, and the skip-while-throttled
// fast path in geminiJson. fetch is mocked; no network.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.GEMINI_API_KEY = 'test-key'

const { geminiJson, geminiThrottled, noteGeminiRateLimited, geminiCooldownUntil, __resetGeminiBreaker } = await import('../src/gemini.js')

const R = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status })
const SCHEMA = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] }
const ok = (obj: unknown) => R({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] })

beforeEach(() => __resetGeminiBreaker())

test('breaker: not throttled by default', () => {
  assert.equal(geminiThrottled(0), false)
  assert.equal(geminiCooldownUntil(), 0)
})

test('breaker: a 429 trips a default 10-minute cooldown that then lifts', () => {
  noteGeminiRateLimited('', 1_000)
  assert.equal(geminiThrottled(1_000), true)
  assert.equal(geminiThrottled(1_000 + 10 * 60_000 - 1), true)
  assert.equal(geminiThrottled(1_000 + 10 * 60_000 + 1), false, 'lifts after the window')
})

test('breaker: honours a longer retryDelay, clamped to one hour', () => {
  noteGeminiRateLimited('{"error":{"code":429},"retryDelay":"1200s"}', 0) // 20 min > default
  assert.equal(geminiThrottled(20 * 60_000 - 1), true)
  assert.equal(geminiThrottled(20 * 60_000 + 1), false)
  __resetGeminiBreaker()
  noteGeminiRateLimited('"retryDelay":"99999s"', 0) // would be ~27h → clamped to 60 min
  assert.equal(geminiThrottled(60 * 60_000 - 1), true)
  assert.equal(geminiThrottled(60 * 60_000 + 1), false)
})

test('geminiJson: a 429 response trips the shared breaker and returns null', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return R({ error: { code: 429, message: 'quota' }, retryDelay: '30s' }, 429)
  }) as typeof fetch
  const out = await geminiJson('sys', 'user', SCHEMA)
  assert.equal(out, null)
  assert.equal(calls, 1)
  assert.equal(geminiThrottled(), true, 'the 429 tripped the breaker for every caller')
})

test('geminiJson: while throttled it returns null WITHOUT calling fetch', async () => {
  noteGeminiRateLimited('') // trip it now
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return ok({ ok: true })
  }) as typeof fetch
  const out = await geminiJson('sys', 'user', SCHEMA)
  assert.equal(out, null)
  assert.equal(calls, 0, 'no request is made while the breaker is open')
})

test('geminiJson: a normal call parses and returns the JSON object', async () => {
  globalThis.fetch = (async () => ok({ ok: true })) as typeof fetch
  const out = await geminiJson<{ ok: boolean }>('sys', 'user', SCHEMA)
  assert.deepEqual(out, { ok: true })
})
