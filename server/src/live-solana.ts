// Live on-chain execution for SOLANA via the Jupiter aggregator (v6 REST API):
// quote → build swap transaction → sign with the dedicated bot keypair → send.
// Dormant unless SOLANA_WALLET_KEY (base58 secret key) is set — paper mode
// otherwise. Trades are SOL ↔ token (or token → USDT for stable sweeps).

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'

const JUP = 'https://quote-api.jup.ag/v6'
export const SOL_MINT = 'So11111111111111111111111111111111111111112'

export const solanaLiveReady = () => Boolean(process.env.SOLANA_WALLET_KEY)

let keypair: Keypair | null = null
let keypairFor = ''
function signer(): Keypair {
  const secret = process.env.SOLANA_WALLET_KEY!
  if (!keypair || keypairFor !== secret) {
    keypair = Keypair.fromSecretKey(bs58.decode(secret))
    keypairFor = secret
  }
  return keypair
}

export function solanaWalletAddress(): string | null {
  if (!solanaLiveReady()) return null
  try {
    return signer().publicKey.toBase58()
  } catch {
    return null
  }
}

function connection(): Connection {
  return new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed')
}

/** Lamports of SOL that `usd` buys at the given SOL price (floor, ≥ 0). */
export function lamportsForUsd(usd: number, solPriceUsd: number): bigint {
  if (!(usd > 0) || !(solPriceUsd > 0)) return 0n
  return BigInt(Math.floor((usd / solPriceUsd) * 1e9))
}

/** Token base units for a quantity at the mint's decimals (floor, ≥ 0). */
export function baseUnitsForQty(qty: number, decimals: number): bigint {
  if (!(qty > 0)) return 0n
  return BigInt(Math.floor(qty * 10 ** decimals))
}

/**
 * Swap on Solana. Amounts are in the INPUT mint's base units.
 * Returns the transaction signature.
 */
export async function executeSolanaSwap(opts: {
  inputMint: string
  outputMint: string
  amountBaseUnits: bigint
  slippageBps?: number
}): Promise<string> {
  if (!solanaLiveReady()) throw new Error('SOLANA_WALLET_KEY not configured')
  if (opts.amountBaseUnits <= 0n) throw new Error('amount must be positive')

  const qs = new URLSearchParams({
    inputMint: opts.inputMint,
    outputMint: opts.outputMint,
    amount: opts.amountBaseUnits.toString(),
    slippageBps: String(opts.slippageBps ?? 100),
  })
  const quoteRes = await fetch(`${JUP}/quote?${qs}`, { headers: { accept: 'application/json' } })
  if (!quoteRes.ok) throw new Error(`jupiter quote failed: ${quoteRes.status} ${(await quoteRes.text()).slice(0, 160)}`)
  const quote = await quoteRes.json()
  if (quote.error) throw new Error(`jupiter quote: ${quote.error}`)

  const swapRes = await fetch(`${JUP}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: signer().publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  })
  if (!swapRes.ok) throw new Error(`jupiter swap build failed: ${swapRes.status} ${(await swapRes.text()).slice(0, 160)}`)
  const { swapTransaction } = await swapRes.json()
  if (!swapTransaction) throw new Error('jupiter returned no transaction')

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'))
  tx.sign([signer()])
  const conn = connection()
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  const latest = await conn.getLatestBlockhash('confirmed')
  const conf = await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed')
  if (conf.value.err) throw new Error(`solana tx failed: ${JSON.stringify(conf.value.err)}`)
  return sig
}
