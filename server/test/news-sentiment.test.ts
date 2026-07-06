// Gemini-powered news sentiment: the two-step grounded→structured flow, with fetch
// mocked. Asserts the grounded call (google_search tool) feeds the structured scorer,
// citations are surfaced, and every failure path degrades to a clean neutral score.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-news-'))
process.env.GEMINI_API_KEY = 'test-key'

const { ensureNewsSentiment, getNewsSentiment, newsReady } = await import('../src/news-sentiment.js')

const R = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status })
const geminiText = (obj: unknown) => R({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] })
const grounded = (text: string, chunks: { uri: string; title: string }[]) =>
  R({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: chunks.map((c) => ({ web: c })) } }] })

// Route a Gemini call by its body: the grounded step carries a `tools` array; the scoring
// step carries a responseSchema with a `score` property.
let calls: string[] = []
beforeEach(() => {
  calls = []
})

test('ensureNewsSentiment: grounded brief feeds the scorer; citations surface', async () => {
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = String(init?.body ?? '')
    calls.push(body.includes('google_search') ? 'grounded' : 'score')
    if (body.includes('google_search')) return grounded('• Spot ETF saw record inflows\n• Network upgrade shipped', [{ uri: 'https://news/etf', title: 'Record ETF inflows' }])
    return geminiText({ score: 0.7, label: 'bullish', summary: 'Strong inflows and a successful upgrade.' })
  }) as typeof fetch

  const s = await ensureNewsSentiment('BTC', 'Bitcoin', 1_000)
  assert.equal(s.score, 0.7)
  assert.equal(s.label, 'bullish')
  assert.equal(s.stale, false)
  assert.deepEqual(s.headlines, ['Record ETF inflows'])
  assert.deepEqual(s.sources, ['https://news/etf'])
  assert.deepEqual(calls, ['grounded', 'score'], 'both steps ran in order')
  // Within the refresh window, the cached value serves without another call.
  const cached = getNewsSentiment('BTC', 'Bitcoin', 1_000 + 60_000)
  assert.equal(cached.score, 0.7)
})

test('ensureNewsSentiment: score is clamped to [-1, 1]', async () => {
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = String(init?.body ?? '')
    if (body.includes('google_search')) return grounded('• Exchange hack drained reserves', [])
    return geminiText({ score: -4.2, label: 'bearish', summary: 'Hack.' })
  }) as typeof fetch
  const s = await ensureNewsSentiment('HACKED', 'Hacked Coin', 2_000)
  assert.equal(s.score, -1, 'out-of-range score clamped')
  assert.equal(s.label, 'bearish')
})

test('ensureNewsSentiment: a failed grounded call degrades to neutral', async () => {
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = String(init?.body ?? '')
    if (body.includes('google_search')) return R({ error: 'boom' }, 500)
    return geminiText({ score: 0.9, label: 'bullish', summary: 'unused' })
  }) as typeof fetch
  const s = await ensureNewsSentiment('FAIL', 'Fail Coin', 3_000)
  assert.equal(s.score, 0, 'neutral on failure')
  assert.equal(s.label, 'neutral')
  assert.equal(s.stale, true)
})

test('getNewsSentiment: no key → disabled neutral, no fetch', async () => {
  const prev = process.env.GEMINI_API_KEY
  delete process.env.GEMINI_API_KEY
  let hit = false
  globalThis.fetch = (async () => {
    hit = true
    return R({})
  }) as typeof fetch
  assert.equal(newsReady(), false)
  const s = getNewsSentiment('ETH', 'Ethereum')
  assert.equal(s.score, 0)
  assert.equal(s.label, 'neutral')
  assert.equal(hit, false, 'never calls the API without a key')
  process.env.GEMINI_API_KEY = prev
})
