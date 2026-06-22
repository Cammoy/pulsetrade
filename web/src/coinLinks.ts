// External research links for a token, by network + contract address.
// CoinGecko & CoinMarketCap resolve by contract on supported chains; DexScreener
// and the block explorer work universally (best for brand-new tokens).

const CG_PLATFORM: Record<string, string> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  polygon: 'polygon-pos',
  bsc: 'binance-smart-chain',
}
const CMC_CHAIN: Record<string, string> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  bsc: 'bnb',
}
const DEX_CHAIN: Record<string, string> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  bsc: 'bsc',
}
const EXPLORER: Record<string, string> = {
  ethereum: 'https://etherscan.io/token/',
  base: 'https://basescan.org/token/',
  arbitrum: 'https://arbiscan.io/token/',
  optimism: 'https://optimistic.etherscan.io/token/',
  polygon: 'https://polygonscan.com/token/',
  bsc: 'https://bscscan.com/token/',
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
  if (EXPLORER[network]) links.push({ label: 'Explorer', icon: '🔍', url: `${EXPLORER[network]}${a}` })
  return links
}
