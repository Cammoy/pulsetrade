// One per-chain block-explorer base, keyed by the server's network id (BNB Chain = 'bnb',
// NOT 'bsc'). Single source of truth so token / tx links can't drift — and so the BNB key
// is correct everywhere (coinLinks previously keyed it 'bsc', so BNB token links never rendered).
const BASE: Record<string, string> = {
  ethereum: 'https://etherscan.io',
  base: 'https://basescan.org',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
  polygon: 'https://polygonscan.com',
  bnb: 'https://bscscan.com',
  solana: 'https://solscan.io',
}

/** Block-explorer URL for a confirmed transaction, or null when the chain is unknown. */
export const explorerTxUrl = (network: string, hash: string): string | null => (BASE[network] ? `${BASE[network]}/tx/${hash}` : null)

/** Block-explorer URL for a token/address page, or null when the chain is unknown. */
export const explorerTokenUrl = (network: string, address: string): string | null => (BASE[network] ? `${BASE[network]}/token/${address}` : null)
