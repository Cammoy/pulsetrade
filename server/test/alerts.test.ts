// Price alerts: the pure validate/evaluate/message core, plus the create→trigger→rearm
// lifecycle with fetch mocked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-alerts-'))

const { buildAlert, evaluateAlert, alertMessage, createAlert, deleteAlert, setAlertEnabled, rearmAlert, checkAlerts, getAlertsPayload } = await import('../src/alerts.js')
const { state } = await import('../src/store.js')
const { setBroadcast } = await import('../src/broadcast.js')
const { __test: prices } = await import('../src/prices.js')
type PriceAlert = import('../src/alerts.js').PriceAlert

const R = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200 })
const frames: any[] = []
setBroadcast((m) => frames.push(m))
// Mock the CoinGecko spot feed so createAlert/rearm/checkAlerts read a deterministic price.
// The spot cache is fresh for 20s, so expire it whenever we change the mocked price.
let priceUsd = 100
const setPrice = (p: number) => {
  priceUsd = p
  prices.expireSpot()
}
globalThis.fetch = (async (url: any) => {
  const u = String(url)
  if (u.includes('simple/price')) return R({ bitcoin: { usd: priceUsd } })
  return R({})
}) as typeof fetch

// ── pure: buildAlert ──────────────────────────────────────────────────────────

test('buildAlert: ABOVE requires a target above the current price', () => {
  assert.ok('alert' in buildAlert({ cg: 'bitcoin', symbol: 'btc', kind: 'above', value: 110 }, 100, 1, 'a'))
  const bad = buildAlert({ cg: 'bitcoin', symbol: 'btc', kind: 'above', value: 90 }, 100, 1, 'a')
  assert.ok('error' in bad && /above the current price/.test((bad as { error: string }).error))
})

test('buildAlert: BELOW requires a target below the current price', () => {
  assert.ok('alert' in buildAlert({ cg: 'bitcoin', symbol: 'btc', kind: 'below', value: 90 }, 100, 1, 'a'))
  assert.ok('error' in buildAlert({ cg: 'bitcoin', symbol: 'btc', kind: 'below', value: 110 }, 100, 1, 'a'))
})

test('buildAlert: MOVE needs a positive percent and stamps the armed price', () => {
  const res = buildAlert({ cg: 'bitcoin', symbol: 'btc', kind: 'move', value: 10 }, 100, 5, 'a')
  assert.ok('alert' in res)
  const al = (res as { alert: PriceAlert }).alert
  assert.equal(al.armedPrice, 100)
  assert.equal(al.status, 'armed')
  assert.equal(al.symbol, 'BTC')
  assert.ok('error' in buildAlert({ cg: 'bitcoin', symbol: 'btc', kind: 'move', value: 0 }, 100, 1, 'a'))
})

test('buildAlert: rejects a missing coin or unreadable price', () => {
  assert.ok('error' in buildAlert({ cg: '', symbol: '', kind: 'above', value: 110 }, 100, 1, 'a'))
  assert.ok('error' in buildAlert({ cg: 'bitcoin', symbol: 'btc', kind: 'above', value: 110 }, 0, 1, 'a'))
})

// ── pure: evaluateAlert ───────────────────────────────────────────────────────

const mk = (over: Partial<PriceAlert>): PriceAlert => ({ id: 'x', cg: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', kind: 'above', value: 110, armedPrice: 100, enabled: true, status: 'armed', createdAt: 0, ...over })

test('evaluateAlert: above/below cross + move from armed', () => {
  assert.equal(evaluateAlert(mk({ kind: 'above', value: 110 }), 109), false)
  assert.equal(evaluateAlert(mk({ kind: 'above', value: 110 }), 110), true)
  assert.equal(evaluateAlert(mk({ kind: 'below', value: 90 }), 91), false)
  assert.equal(evaluateAlert(mk({ kind: 'below', value: 90 }), 90), true)
  assert.equal(evaluateAlert(mk({ kind: 'move', value: 10, armedPrice: 100 }), 109), false)
  assert.equal(evaluateAlert(mk({ kind: 'move', value: 10, armedPrice: 100 }), 111), true) // +11%
  assert.equal(evaluateAlert(mk({ kind: 'move', value: 10, armedPrice: 100 }), 89), true) // −11% (either direction)
})

test('alertMessage: reads naturally per kind', () => {
  assert.match(alertMessage(mk({ kind: 'above', value: 110 }), 110), /crossed above/)
  assert.match(alertMessage(mk({ kind: 'below', value: 90 }), 90), /dropped below/)
  assert.match(alertMessage(mk({ kind: 'move', value: 10, armedPrice: 100 }), 112), /moved \+12\.0% from/)
})

// ── stateful: lifecycle ───────────────────────────────────────────────────────

test('createAlert validates against the live price, stores + broadcasts', async () => {
  state.alerts = []
  frames.length = 0
  setPrice(100)
  const ok = await createAlert({ cg: 'bitcoin', symbol: 'btc', name: 'Bitcoin', kind: 'above', value: 110 })
  assert.ok('alert' in ok, JSON.stringify(ok))
  assert.equal(state.alerts.length, 1)
  assert.ok(frames.some((f) => f.type === 'alerts'), 'broadcast the alerts list')

  const bad = await createAlert({ cg: 'bitcoin', symbol: 'btc', kind: 'above', value: 90 }) // below price
  assert.ok('error' in bad)
  assert.equal(state.alerts.length, 1, 'invalid alert not stored')
})

test('checkAlerts fires on a met condition, broadcasts the trigger, and is one-shot', async () => {
  state.alerts = []
  setPrice(100)
  await createAlert({ cg: 'bitcoin', symbol: 'btc', name: 'Bitcoin', kind: 'above', value: 110 })
  frames.length = 0

  setPrice(105) // not yet
  assert.equal(await checkAlerts(Date.now()), false)
  assert.equal(state.alerts[0].status, 'armed')

  setPrice(112) // crosses 110
  const fired = await checkAlerts(Date.now())
  assert.equal(fired, true)
  assert.equal(state.alerts[0].status, 'triggered')
  assert.ok((state.alerts[0].triggeredPrice ?? 0) >= 110)
  assert.ok(frames.some((f) => f.type === 'alert-trigger' && f.alert?.id), 'broadcast the trigger')

  frames.length = 0
  assert.equal(await checkAlerts(Date.now()), false, 'a triggered alert does not re-fire (one-shot)')
})

test('disabled alerts are skipped; rearm resets a triggered alert against a valid price', async () => {
  state.alerts = []
  setPrice(100)
  const created = await createAlert({ cg: 'bitcoin', symbol: 'btc', name: 'Bitcoin', kind: 'below', value: 90 })
  const id = (created as { alert: PriceAlert }).alert.id

  setAlertEnabled(id, false)
  setPrice(80) // would meet the below-90 condition…
  assert.equal(await checkAlerts(Date.now()), false, 'disabled alert is not evaluated')

  setAlertEnabled(id, true)
  assert.equal(await checkAlerts(Date.now()), true)
  assert.equal(state.alerts[0].status, 'triggered')

  // rearm: price (80) is still below 90 → re-arming would instantly re-fire → rejected
  assert.ok('error' in (await rearmAlert(id)))
  // move the price back above the target, then rearm succeeds
  setPrice(100)
  const re = await rearmAlert(id)
  assert.ok('alert' in re)
  assert.equal(state.alerts[0].status, 'armed')
  assert.equal(state.alerts[0].armedPrice, 100)

  assert.equal(deleteAlert(id), true)
  assert.equal(getAlertsPayload().alerts.length, 0)
  assert.equal(deleteAlert('nope'), false)
})

test('checkAlerts: an alert paused DURING the price fetch does not fire (race)', async () => {
  state.alerts = []
  setPrice(100)
  const created = await createAlert({ cg: 'bitcoin', symbol: 'btc', name: 'Bitcoin', kind: 'above', value: 110 })
  const id = (created as { alert: PriceAlert }).alert.id
  frames.length = 0
  // A concurrent PATCH /api/alerts/:id (pause) lands during the getSpotPrices await — the fetch mock
  // disables the alert mid-flight, the exact window checkAlerts must re-validate before firing.
  const prev = globalThis.fetch
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('simple/price')) setAlertEnabled(id, false)
    return R(String(url).includes('simple/price') ? { bitcoin: { usd: 112 } } : {})
  }) as typeof fetch
  const fired = await checkAlerts(Date.now())
  globalThis.fetch = prev
  assert.equal(fired, false, 'a just-paused alert must not fire')
  assert.equal(state.alerts[0].status, 'armed', 'stays armed, not triggered')
  assert.ok(!frames.some((f) => f.type === 'alert-trigger'), 'no trigger broadcast')
})
