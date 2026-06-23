// Cached coin-icon proxy: allowlist (no SSRF), serve-from-cache (no re-fetch), image-only.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { iconProxy, proxyableIcon, __resetIconCache } = await import('../src/icons.js')

function mockRes(): any {
  const r: any = { headers: {}, statusCode: 200, body: undefined }
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v }
  r.status = (c: number) => { r.statusCode = c; return r }
  r.json = (b: unknown) => { r.body = b; return r }
  r.end = (b: unknown) => { r.body = b; return r }
  return r
}
const req = (u: string): any => ({ query: { u } })
const GECKO = 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png'

test('proxyableIcon: only https + allowlisted icon hosts', () => {
  assert.equal(proxyableIcon('https://assets.coingecko.com/x.png'), true)
  assert.equal(proxyableIcon('https://coin-images.coingecko.com/x.png'), true)
  assert.equal(proxyableIcon('https://evil.example/x.png'), false)
  assert.equal(proxyableIcon('http://assets.coingecko.com/x.png'), false) // not https
  assert.equal(proxyableIcon('not a url'), false)
})

test('iconProxy rejects non-allowlisted hosts (no SSRF)', async () => {
  const res = mockRes()
  await iconProxy(req('https://169.254.169.254/latest/meta-data/'), res)
  assert.equal(res.statusCode, 400)
})

test('iconProxy fetches once, then serves from cache with a week-long browser cache header', async () => {
  __resetIconCache()
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png', etag: '"v1"' } }) }) as typeof fetch
  const a = mockRes()
  await iconProxy(req(GECKO), a)
  assert.equal(calls, 1)
  assert.equal(a.headers['content-type'], 'image/png')
  assert.match(a.headers['cache-control'], /max-age=604800/)
  const b = mockRes()
  await iconProxy(req(GECKO), b)
  assert.equal(calls, 1, 'second request is served from cache — no re-fetch')
})

test('iconProxy refuses non-image upstream responses', async () => {
  __resetIconCache()
  globalThis.fetch = (async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch
  const res = mockRes()
  await iconProxy(req('https://www.coingecko.com/evil.html'), res)
  assert.equal(res.statusCode, 415)
})
