// Live on-chain execution via the 0x Swap API (v2, allowance-holder flow)
// and a DEDICATED bot wallet. Dormant unless both env vars are set — the
// engine runs in paper mode otherwise. Trades are native-coin ↔ token, so
// proceeds always land in the chain's native currency.

import { createWalletClient, http, publicActions, erc20Abi, maxUint256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, arbitrum, optimism, polygon, bsc } from 'viem/chains'

const CHAINS = { 8453: base, 42161: arbitrum, 10: optimism, 137: polygon, 56: bsc } as const
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

export const liveReady = () => Boolean(process.env.ZEROX_API_KEY && process.env.BOT_WALLET_KEY)

export function botWalletAddress(): string | null {
  if (!process.env.BOT_WALLET_KEY) return null
  try {
    return privateKeyToAccount(process.env.BOT_WALLET_KEY as Hex).address
  } catch {
    return null
  }
}

function client(chainId: number) {
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  if (!chain) throw new Error(`unsupported chain ${chainId}`)
  const account = privateKeyToAccount(process.env.BOT_WALLET_KEY as Hex)
  return createWalletClient({ account, chain, transport: http() }).extend(publicActions)
}

/**
 * Swap on-chain. side 'buy' = spend native for token, 'sell' = token → native
 * (or token → buyTokenAddress when given, e.g. USDT sweeps).
 * Amounts are in the SELL asset's base units. Returns the tx hash.
 */
export async function executeSwap(opts: {
  chainId: number
  tokenAddress: string
  side: 'buy' | 'sell'
  sellAmountBaseUnits: bigint
  buyTokenAddress?: string
}): Promise<Hex> {
  const wc = client(opts.chainId)
  const taker = wc.account.address
  const sellToken = opts.side === 'buy' ? NATIVE : opts.tokenAddress
  const buyToken = opts.side === 'buy' ? opts.tokenAddress : opts.buyTokenAddress ?? NATIVE

  const qs = new URLSearchParams({
    chainId: String(opts.chainId),
    sellToken,
    buyToken,
    sellAmount: opts.sellAmountBaseUnits.toString(),
    taker,
    slippageBps: '100',
  })
  const res = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${qs}`, {
    headers: { '0x-api-key': process.env.ZEROX_API_KEY!, '0x-version': 'v2' },
  })
  if (!res.ok) throw new Error(`0x quote failed: ${res.status} ${await res.text()}`)
  const quote: any = await res.json()
  if (quote.liquidityAvailable === false) throw new Error('0x: no liquidity for this pair/size')

  // Token sells need a one-time allowance for the 0x AllowanceHolder.
  const spender = quote.issues?.allowance?.spender
  if (opts.side === 'sell' && spender) {
    const approveHash = await wc.writeContract({
      address: opts.tokenAddress as Hex,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender as Hex, maxUint256],
      chain: wc.chain,
    })
    await wc.waitForTransactionReceipt({ hash: approveHash })
  }

  const hash = await wc.sendTransaction({
    to: quote.transaction.to as Hex,
    data: quote.transaction.data as Hex,
    value: BigInt(quote.transaction.value ?? 0),
    gas: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
    chain: wc.chain,
  })
  const receipt = await wc.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`swap tx reverted: ${hash}`)
  return hash
}
