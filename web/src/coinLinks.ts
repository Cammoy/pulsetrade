// External research links for a token, by network + contract ADDRESS (no CoinGecko id needed):
// GeckoTerminal (CoinGecko's on-chain explorer), DexScreener, and the block explorer. All three
// resolve directly from the token address. Keep the slug maps in sync with the server's networks.ts.
//
// (Dropped the old CoinGecko `/coins/{platform}/contract/{addr}` link — that web route 404s — and
// CoinMarketCap DexScan, which 302-redirected to a moved host and is redundant with the two
// on-chain explorers here.)

import { explorerTokenUrl } from './explorer'

// network id → GeckoTerminal network slug (mirrors server networks.ts `gt`).
const GT_CHAIN: Record<string, string> = {
  ethereum: 'eth',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon_pos',
  bnb: 'bsc',
}
// network id → DexScreener chain slug.
const DEX_CHAIN: Record<string, string> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  bnb: 'bsc', // DexScreener's own slug for BNB Chain is 'bsc'
}

export interface CoinLink {
  label: string
  icon: string
  url: string
}

export function coinLinks(network: string, address: string): CoinLink[] {
  const a = address.toLowerCase()
  const links: CoinLink[] = []
  if (GT_CHAIN[network]) links.push({ label: 'GeckoTerminal', icon: '🦎', url: `https://www.geckoterminal.com/${GT_CHAIN[network]}/tokens/${a}` })
  if (DEX_CHAIN[network]) links.push({ label: 'DexScreener', icon: '📊', url: `https://dexscreener.com/${DEX_CHAIN[network]}/${a}` })
  const ex = explorerTokenUrl(network, a)
  if (ex) links.push({ label: 'Explorer', icon: '🔍', url: ex })
  return links
}
