// Route coin icons from CoinGecko's CDN through our cached `/api/icon` proxy, so the browser keeps
// them for a week instead of re-fetching each load (the server revalidates when they change).
// Non-allowlisted logos (arbitrary token-list CDNs) pass through unchanged — still browser-cached
// by their own headers, just not via our proxy. Keep ALLOW_HOSTS in sync with server/src/icons.ts.
const ALLOW_HOSTS = new Set(['assets.coingecko.com', 'coin-images.coingecko.com', 'www.coingecko.com', 's2.coinmarketcap.com'])

export function iconUrl(url?: string | null): string | undefined {
  if (!url) return undefined
  try {
    return ALLOW_HOSTS.has(new URL(url).hostname) ? `/api/icon?u=${encodeURIComponent(url)}` : url
  } catch {
    return url
  }
}
