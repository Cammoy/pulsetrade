// Cached coin-icon proxy. Coin/token icons are fetched from CoinGecko's asset CDN; without this
// the browser re-requests them whenever the upstream cache headers are short/absent. We proxy a
// small ALLOWLIST of icon hosts (no SSRF — only these hosts, https only, image responses only),
// cache the bytes in-memory with conditional revalidation (ETag / Last-Modified), and serve them
// with a long `Cache-Control` so the browser keeps them for a week and only re-checks occasionally
// ("unless they change, which is rare"). Non-allowlisted logos pass through unproxied client-side.

import type { Request, Response } from 'express'

// Only these hosts may be proxied. CoinGecko serves nearly all coin images/thumbs from these.
const ALLOW_HOSTS = new Set(['assets.coingecko.com', 'coin-images.coingecko.com', 'www.coingecko.com', 's2.coinmarketcap.com'])

interface Cached { buf: Buffer; type: string; at: number; etag?: string; lastModified?: string }

const cache = new Map<string, Cached>()
let bytes = 0
const MAX_BYTES = 8 * 1024 * 1024 // cap total cached icon bytes
const MAX_ICON_BYTES = 512 * 1024 // an icon over 512KB isn't an icon — don't cache it
const TTL_MS = 7 * 86_400_000 // serve from cache a week before revalidating
const BROWSER_CACHE = 'public, max-age=604800, stale-while-revalidate=86400' // a week, then soft-revalidate

/** Is this URL safe + eligible to proxy? (https + an allowlisted icon host). */
export function proxyableIcon(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && ALLOW_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

function store(url: string, c: Cached): void {
  const prev = cache.get(url)
  if (prev) bytes -= prev.buf.length
  cache.set(url, c)
  bytes += c.buf.length
  // Evict oldest (Map preserves insertion order) until back under the cap.
  while (bytes > MAX_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value as string
    bytes -= cache.get(oldest)!.buf.length
    cache.delete(oldest)
  }
}

function serve(res: Response, c: Cached): void {
  res.setHeader('content-type', c.type)
  res.setHeader('cache-control', BROWSER_CACHE)
  res.end(c.buf)
}

/** GET /api/icon?u=<https icon url>. Cached + revalidated; rejects anything off the allowlist. */
export async function iconProxy(req: Request, res: Response): Promise<void> {
  const url = String(req.query.u ?? '')
  if (!proxyableIcon(url)) {
    res.status(400).json({ error: 'icon host not allowed' })
    return
  }
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < TTL_MS) {
    serve(res, hit)
    return
  }
  try {
    const headers: Record<string, string> = {}
    if (hit?.etag) headers['if-none-match'] = hit.etag
    if (hit?.lastModified) headers['if-modified-since'] = hit.lastModified
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (r.status === 304 && hit) {
      hit.at = Date.now() // still current — extend freshness, serve cached bytes
      serve(res, hit)
      return
    }
    if (!r.ok) {
      if (hit) return serve(res, hit) // upstream hiccup → serve stale rather than nothing
      res.status(502).end()
      return
    }
    const type = r.headers.get('content-type') || 'image/png'
    if (!type.startsWith('image/')) {
      res.status(415).end()
      return
    }
    const buf = Buffer.from(await r.arrayBuffer())
    const c: Cached = { buf, type, at: Date.now(), etag: r.headers.get('etag') ?? undefined, lastModified: r.headers.get('last-modified') ?? undefined }
    if (buf.length <= MAX_ICON_BYTES) store(url, c) // cache normal-sized icons only
    serve(res, c)
  } catch {
    if (hit) return serve(res, hit)
    res.status(502).end()
  }
}

/** Test-only: reset the cache between cases. */
export function __resetIconCache(): void {
  cache.clear()
  bytes = 0
}
