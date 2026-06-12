import { http, createConfig } from 'wagmi'
import { base, arbitrum, optimism, polygon, bsc } from 'wagmi/chains'
import { injected, coinbaseWallet, walletConnect, metaMask } from 'wagmi/connectors'

// Build the connector list defensively. The previous config offered ONLY the
// injected() connector, which silently fails when the browser has no wallet
// extension — that was the "connect doesn't work" bug. We now also offer
// MetaMask (its SDK can deep-link / QR without an extension), Coinbase Wallet,
// and (when a project id is configured) WalletConnect for any mobile wallet.
const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined

const connectors = [
  injected({ shimDisconnect: true }),
  metaMask(),
  coinbaseWallet({ appName: 'PulseTrade', preference: 'all' }),
  ...(wcProjectId ? [walletConnect({ projectId: wcProjectId, showQrModal: true })] : []),
]

export const wagmiConfig = createConfig({
  chains: [base, arbitrum, optimism, polygon, bsc],
  connectors,
  // EIP-6963 discovery stays on (default) so installed wallets appear too.
  transports: {
    [base.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [bsc.id]: http(),
  },
})
