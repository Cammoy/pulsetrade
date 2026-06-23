// Cached coin-icon proxy: allowlist (no SSRF), serve-from-cache (no re-fetch), image-only.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { iconProxy, proxyableIcon, __resetIconCache, __expireIcons } = await import('../src/icons.js')

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

test('iconProxy revalidates a stale entry (304 → serve cached bytes, no re-download)', async () => {
  __resetIconCache()
  let lastHeaders: any
  globalThis.fetch = (async (_url: any, opts: any) => {
    lastHeaders = opts?.headers
    return opts?.headers?.['if-none-match']
      ? new Response(null, { status: 304 })
      : new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png', etag: '"v1"' } })
  }) as typeof fetch
  await iconProxy(req(GECKO), mockRes()) // caches with etag "v1"
  __expireIcons()
  const b = mockRes()
  await iconProxy(req(GECKO), b)
  assert.equal(b.statusCode, 200)
  assert.deepEqual([...(b.body as Buffer)], [1, 2, 3], 'served cached bytes on 304')
  assert.equal(lastHeaders?.['if-none-match'], '"v1"', 'sent the conditional revalidation header')
})

test('iconProxy serves stale bytes when the upstream fails', async () => {
  __resetIconCache()
  globalThis.fetch = (async () => new Response(Buffer.from([9, 9]), { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch
  await iconProxy(req(GECKO), mockRes()) // cache [9,9]
  __expireIcons()
  globalThis.fetch = (async () => { throw new Error('upstream down') }) as typeof fetch
  const b = mockRes()
  await iconProxy(req(GECKO), b)
  assert.equal(b.statusCode, 200)
  assert.deepEqual([...(b.body as Buffer)], [9, 9], 'served stale on upstream failure')
})

test('iconProxy rejects an oversized icon by Content-Length before buffering it', async () => {
  __resetIconCache()
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    headers: new Headers({ 'content-type': 'image/png', 'content-length': '2000000' }),
    arrayBuffer: async () => new ArrayBuffer(1),
  })) as unknown as typeof fetch
  const res = mockRes()
  await iconProxy(req('https://www.coingecko.com/huge.png'), res)
  assert.equal(res.statusCode, 413)
})

test('iconProxy serves but does NOT cache an oversized icon', async () => {
  __resetIconCache()
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response(Buffer.alloc(600 * 1024), { status: 200, headers: { 'content-type': 'image/png' } }) }) as typeof fetch
  await iconProxy(req(GECKO), mockRes())
  await iconProxy(req(GECKO), mockRes()) // not cached → fetched again
  assert.equal(calls, 2, 'an icon over the cache cap is served but re-fetched, never stored')
})
