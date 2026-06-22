// Observability + shutdown primitives: the provider heartbeat + outbound notifier
// (P1-14), the lane drain used by graceful shutdown (P1-12), and the UTC daily-cap
// boundary (P1-2). Pure/isolated — no engine, no network (fetch stubbed for notify).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

const { markProvider, providerHealth, alertConfigured, notify, __resetProviders, __resetThrottle } = await import('../src/health.js')
const { runExclusive, drainLanes } = await import('../src/lanes.js')
const { dayKey } = await import('../src/store.js')

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  __resetProviders()
  __resetThrottle()
  delete process.env.ALERT_WEBHOOK_URL
  delete process.env.ALERT_TELEGRAM_BOT_TOKEN
  delete process.env.ALERT_TELEGRAM_CHAT_ID
})

// ── Provider heartbeat (P1-14) ───────────────────────────────────────────────
test('markProvider records last-success and last-failure ages per provider', () => {
  __resetProviders()
  markProvider('coingecko', true)
  markProvider('0x', false, 'HTTP 500')
  const h = providerHealth()
  const cg = h.find((p) => p.name === 'coingecko')!
  const zx = h.find((p) => p.name === '0x')!
  assert.ok(cg.lastOkAgoMs !== null && cg.lastOkAgoMs >= 0, 'coingecko has a recent success')
  assert.equal(cg.lastErrAgoMs, null, 'no failure recorded for coingecko')
  assert.ok(zx.lastErrAgoMs !== null, '0x has a recent failure')
  assert.equal(zx.lastError, 'HTTP 500')
})

// ── Outbound notifier (P1-14) ────────────────────────────────────────────────
test('notify is a no-op when no alert transport is configured (never throws, never fetches)', async () => {
  let called = false
  globalThis.fetch = (async () => { called = true; return new Response('{}') }) as typeof fetch
  await notify('breaker-tripped', 'should not send')
  assert.equal(called, false, 'no transport → no outbound call')
})

test('notify posts to a configured webhook, and throttles a duplicate event', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://hook.test/alert'
  __resetThrottle()
  const calls: any[] = []
  globalThis.fetch = (async (url: any, init: any) => { calls.push({ url: String(url), body: init?.body }); return new Response('{}', { status: 200 }) }) as typeof fetch
  assert.equal(alertConfigured(), true)
  await notify('bot-halted', 'first')
  await notify('bot-halted', 'second (same event → throttled)')
  assert.equal(calls.length, 1, 'second identical event within the window is suppressed')
  assert.match(calls[0].url, /hook\.test\/alert/)
  const sent = JSON.parse(calls[0].body)
  assert.equal(sent.event, 'bot-halted')
  assert.match(sent.text, /PulseTrade/)
  // a DIFFERENT event still goes through
  await notify('breaker-tripped', 'distinct event')
  assert.equal(calls.length, 2)
})

test('notify supports Telegram and never throws on a transport error', async () => {
  process.env.ALERT_TELEGRAM_BOT_TOKEN = 'tok'
  process.env.ALERT_TELEGRAM_CHAT_ID = '123'
  __resetThrottle()
  let hit = ''
  globalThis.fetch = (async (url: any) => { hit = String(url); throw new Error('network down') }) as typeof fetch
  await notify('start', 'engine up') // must resolve despite the throw
  assert.match(hit, /api\.telegram\.org\/bot tok\/sendMessage|api\.telegram\.org\/bottok\/sendMessage/)
})

// ── drainLanes (P1-12 graceful shutdown) ─────────────────────────────────────
test('drainLanes awaits an in-flight lane task before resolving', async () => {
  let done = false
  // Enqueue work on a lane that completes on the next macrotask.
  void runExclusive('evm:8453', () => new Promise<void>((r) => setTimeout(() => { done = true; r() }, 20)))
  await drainLanes()
  assert.equal(done, true, 'drainLanes waited for the in-flight swap to finish')
})

test('drainLanes swallows a rejecting lane (a failed swap still settles the drain)', async () => {
  void runExclusive('solana', async () => { throw new Error('swap reverted') })
  await drainLanes() // must resolve, not reject
  assert.ok(true)
})

// ── dayKey UTC boundary (P1-2) ───────────────────────────────────────────────
test('dayKey buckets by UTC date (deterministic regardless of host timezone)', () => {
  // 2026-03-09T05:00:00Z → always 2026-03-09 in UTC, even where local time is the 8th.
  assert.equal(dayKey(Date.UTC(2026, 2, 9, 5, 0, 0)), '2026-03-09')
  // One ms before UTC midnight vs one ms after → different UTC days.
  assert.equal(dayKey(Date.UTC(2026, 2, 9, 23, 59, 59, 999)), '2026-03-09')
  assert.equal(dayKey(Date.UTC(2026, 2, 10, 0, 0, 0, 1)), '2026-03-10')
})
