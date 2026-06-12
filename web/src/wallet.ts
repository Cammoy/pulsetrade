import { http, createConfig } from 'wagmi'
import { base, arbitrum, optimism, polygon, bsc } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

export const wagmiConfig = createConfig({
  chains: [base, arbitrum, optimism, polygon, bsc],
  connectors: [injected()],
  transports: {
    [base.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [bsc.id]: http(),
  },
})
