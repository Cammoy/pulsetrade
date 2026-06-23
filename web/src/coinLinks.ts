// External research links for a token, by network + contract address.
// CoinGecko & CoinMarketCap resolve by contract on supported chains; DexScreener
// and the block explorer work universally (best for brand-new tokens).

import { explorerTokenUrl } from './explorer'

// Maps key by the SERVER network id (BNB Chain = 'bnb') → each provider's own slug. These
// were keyed 'bsc' before, so every BNB research link silently failed to render.
const CG_PLATFORM: Record<string, string> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  polygon: 'polygon-pos',
  bnb: 'binance-smart-chain',
}
const CMC_CHAIN: Record<string, string> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  bnb: 'bnb',
}
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
  if (CG_PLATFORM[network]) links.push({ label: 'CoinGecko', icon: '🦎', url: `https://www.coingecko.com/en/coins/${CG_PLATFORM[network]}/contract/${a}` })
  if (CMC_CHAIN[network]) links.push({ label: 'CoinMarketCap', icon: '📈', url: `https://coinmarketcap.com/dexscan/${CMC_CHAIN[network]}/${a}/` })
  if (DEX_CHAIN[network]) links.push({ label: 'DexScreener', icon: '📊', url: `https://dexscreener.com/${DEX_CHAIN[network]}/${a}` })
  const ex = explorerTokenUrl(network, a)
  if (ex) links.push({ label: 'Explorer', icon: '🔍', url: ex })
  return links
}
