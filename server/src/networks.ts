// The 5 cheapest liquid EVM networks. avgGasUsd is used to simulate
// realistic round-trip costs in paper mode and to sanity-check live quotes.

export interface Token {
  symbol: string
  name: string
  cg: string // CoinGecko id (price source of truth)
  address: string // ERC-20 address on this network (live execution)
  decimals: number
}

export interface Network {
  id: string
  name: string
  chainId: number
  native: { symbol: string; cg: string }
  avgGasUsd: number
  color: string
  tokens: Token[]
}

export const NETWORKS: Network[] = [
  {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    native: { symbol: 'ETH', cg: 'ethereum' },
    avgGasUsd: 0.02,
    color: '#0052ff',
    tokens: [
      { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', cg: 'coinbase-wrapped-btc', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
      { symbol: 'WETH', name: 'Wrapped Ether', cg: 'weth', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      { symbol: 'AERO', name: 'Aerodrome', cg: 'aerodrome-finance', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 },
      { symbol: 'LINK', name: 'Chainlink', cg: 'chainlink', address: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196', decimals: 18 },
      { symbol: 'DEGEN', name: 'Degen', cg: 'degen-base', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18 },
    ],
  },
  {
    id: 'arbitrum',
    name: 'Arbitrum',
    chainId: 42161,
    native: { symbol: 'ETH', cg: 'ethereum' },
    avgGasUsd: 0.03,
    color: '#2d374b',
    tokens: [
      { symbol: 'WBTC', name: 'Wrapped Bitcoin', cg: 'wrapped-bitcoin', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
      { symbol: 'ARB', name: 'Arbitrum', cg: 'arbitrum', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
      { symbol: 'LINK', name: 'Chainlink', cg: 'chainlink', address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', decimals: 18 },
      { symbol: 'UNI', name: 'Uniswap', cg: 'uniswap', address: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', decimals: 18 },
      { symbol: 'GMX', name: 'GMX', cg: 'gmx', address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', decimals: 18 },
    ],
  },
  {
    id: 'optimism',
    name: 'Optimism',
    chainId: 10,
    native: { symbol: 'ETH', cg: 'ethereum' },
    avgGasUsd: 0.02,
    color: '#ff0420',
    tokens: [
      { symbol: 'OP', name: 'Optimism', cg: 'optimism', address: '0x4200000000000000000000000000000000000042', decimals: 18 },
      { symbol: 'WBTC', name: 'Wrapped Bitcoin', cg: 'wrapped-bitcoin', address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', decimals: 8 },
      { symbol: 'WETH', name: 'Wrapped Ether', cg: 'weth', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      { symbol: 'LINK', name: 'Chainlink', cg: 'chainlink', address: '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6', decimals: 18 },
      { symbol: 'SNX', name: 'Synthetix', cg: 'havven', address: '0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4', decimals: 18 },
    ],
  },
  {
    id: 'polygon',
    name: 'Polygon',
    chainId: 137,
    native: { symbol: 'POL', cg: 'polygon-ecosystem-token' },
    avgGasUsd: 0.01,
    color: '#8247e5',
    tokens: [
      { symbol: 'WBTC', name: 'Wrapped Bitcoin', cg: 'wrapped-bitcoin', address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8 },
      { symbol: 'WETH', name: 'Wrapped Ether', cg: 'weth', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
      { symbol: 'LINK', name: 'Chainlink', cg: 'chainlink', address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', decimals: 18 },
      { symbol: 'AAVE', name: 'Aave', cg: 'aave', address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', decimals: 18 },
      { symbol: 'UNI', name: 'Uniswap', cg: 'uniswap', address: '0xb33EaAd8d922B1083446DC23f610c2567fB5180f', decimals: 18 },
    ],
  },
  {
    id: 'bnb',
    name: 'BNB Chain',
    chainId: 56,
    native: { symbol: 'BNB', cg: 'binancecoin' },
    avgGasUsd: 0.1,
    color: '#f0b90b',
    tokens: [
      { symbol: 'BTCB', name: 'Bitcoin BEP-20', cg: 'bitcoin', address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18 },
      { symbol: 'ETH', name: 'Ethereum BEP-20', cg: 'ethereum', address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18 },
      { symbol: 'CAKE', name: 'PancakeSwap', cg: 'pancakeswap-token', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18 },
      { symbol: 'LINK', name: 'Chainlink', cg: 'chainlink', address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', decimals: 18 },
      { symbol: 'DOGE', name: 'Dogecoin BEP-20', cg: 'dogecoin', address: '0xbA2aE424d960c26247Dd6c32edC70B295c744C43', decimals: 8 },
    ],
  },
]

export const networkById = (id: string) => NETWORKS.find((n) => n.id === id)

export function tokenOf(networkId: string, symbol: string): Token | undefined {
  return networkById(networkId)?.tokens.find((t) => t.symbol === symbol)
}

/** Every CoinGecko id the engine may need a spot price for. */
export function allPriceIds(): string[] {
  const ids = new Set<string>()
  for (const n of NETWORKS) {
    ids.add(n.native.cg)
    for (const t of n.tokens) ids.add(t.cg)
  }
  return [...ids]
}
