// Live on-chain execution for SOLANA via the Jupiter aggregator (v6 REST API):
// quote → build swap transaction → sign with the dedicated bot keypair → send.
// Dormant unless SOLANA_WALLET_KEY (base58 secret key) is set — paper mode
// otherwise. Trades are SOL ↔ token (or token → USDT for stable sweeps).

import { Connection, Keypair, PublicKey, VersionedTransaction, SystemProgram, TransactionMessage, type TransactionInstruction } from '@solana/web3.js'
import bs58 from 'bs58'
import { turnkeySolReady, turnkeySolAddress, turnkeySignSolana } from './live-turnkey.js'
import { lifiQuote, LIFI_SOLANA_CHAIN, resolveSlippageBps } from './live.js'
import { markProvider } from './health.js'

// Jupiter Swap API v1 (free "lite" tier). The old quote-api.jup.ag/v6 host was
// deprecated + taken down — this is the current base; paths are /quote and /swap.
const JUP = 'https://lite-api.jup.ag/swap/v1'
export const SOL_MINT = 'So11111111111111111111111111111111111111112'

// Armed when we have a VALID Solana signer — a raw SOLANA_WALLET_KEY (base58 of a 64-byte
// secret key) or Turnkey. Validate the key actually decodes, so `ready` never reports true
// for a malformed key that would throw at the first signature.
const rawSolanaKeyOk = (): boolean => {
  const s = process.env.SOLANA_WALLET_KEY
  if (!s) return false
  try { return bs58.decode(s).length === 64 } catch { return false }
}
export const solanaLiveReady = () => turnkeySolReady() || rawSolanaKeyOk()

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

/** The bot's Solana public key — from Turnkey when configured, else the keypair. */
function ownerPubkey(): PublicKey {
  if (turnkeySolReady()) return new PublicKey(turnkeySolAddress()!)
  return signer().publicKey
}

/** Which backend signs Solana live txs — 'turnkey', 'key' (raw), or null. */
export const solanaSigner = (): 'turnkey' | 'key' | null =>
  turnkeySolReady() ? 'turnkey' : process.env.SOLANA_WALLET_KEY ? 'key' : null

export function solanaWalletAddress(): string | null {
  if (!solanaLiveReady()) return null
  try {
    return ownerPubkey().toBase58()
  } catch {
    return null
  }
}

// Indirection so unit tests can inject a fake RPC connection and exercise the
// sign+send+confirm path (deserialize → sign → sendRawTransaction → confirm)
// without a real cluster. Production always builds a real Connection.
let connectionOverride: (() => Connection) | null = null
function connection(): Connection {
  return connectionOverride ? connectionOverride() : new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed')
}

/** Test seam — NOT used in production. Inject a fake Connection, then reset(). */
export const __test = {
  setConnection(f: () => Connection) { connectionOverride = f },
  reset() { connectionOverride = null },
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

/** The bot wallet's real on-chain balance of a mint, in base units (lamports for
 *  native SOL; summed across token accounts for SPL). Clamps live sells. */
export async function splTokenBalanceBaseUnits(mint: string): Promise<bigint> {
  const conn = connection()
  const owner = ownerPubkey()
  if (mint === SOL_MINT) return BigInt(await conn.getBalance(owner, 'confirmed'))
  const res = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) })
  let total = 0n
  for (const { account } of res.value) {
    const amt = (account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount
    if (amt) total += BigInt(amt)
  }
  return total
}

/** Indicative Jupiter quote for the manual-swap preview (no tx is built). Amounts in
 *  the INPUT mint's base units. Throws when there's no route. */
export async function jupiterQuote(
  inputMint: string,
  outputMint: string,
  amountBaseUnits: bigint,
  slippageBps?: number,
): Promise<{ outAmount: string; minAmount: string; priceImpactPct: string }> {
  const qs = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountBaseUnits.toString(),
    slippageBps: String(resolveSlippageBps(slippageBps)),
  })
  const res = await fetch(`${JUP}/quote?${qs}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) { markProvider('jupiter', false, `quote HTTP ${res.status}`); throw new Error(`jupiter quote failed: ${res.status}`) }
  markProvider('jupiter', true)
  const q = await res.json()
  if (q.error || !q.outAmount) throw new Error(q.error ? `jupiter: ${q.error}` : 'no route for this pair / size')
  return { outAmount: String(q.outAmount), minAmount: String(q.otherAmountThreshold ?? q.outAmount), priceImpactPct: String(q.priceImpactPct ?? '0') }
}

/** symbol + decimals for a Solana mint (the paste-a-mint path). Decimals are read
 *  on-chain (authoritative); the symbol is best-effort from the Jupiter token list. */
export async function splTokenInfo(mint: string): Promise<{ symbol: string; decimals: number }> {
  const { getMint } = await import('@solana/spl-token')
  const info = await getMint(connection(), new PublicKey(mint))
  let symbol = `${mint.slice(0, 4)}…`
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6_000) })
    if (r.ok) {
      const t = await r.json()
      if (t?.symbol) symbol = String(t.symbol)
    }
  } catch {
    /* symbol stays the short mint — decimals are what actually matter for sizing */
  }
  return { symbol, decimals: Number(info.decimals) }
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
    // Caller override, else MAX_SLIPPAGE_BPS, else 1% — same knob as the EVM path.
    slippageBps: String(resolveSlippageBps(opts.slippageBps)),
  })
  const quoteRes = await fetch(`${JUP}/quote?${qs}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
  if (!quoteRes.ok) throw new Error(`jupiter quote failed: ${quoteRes.status} ${(await quoteRes.text()).slice(0, 160)}`)
  const quote = await quoteRes.json()
  if (quote.error) throw new Error(`jupiter quote: ${quote.error}`)

  // Price-impact guard on ENTRIES only (a buy = spending native): a thin pool
  // bakes a huge impact into the quote that the slippage tolerance can't catch —
  // you'd get a terrible fill. Abort above the ceiling. Exits (sells) always go
  // through so a position can be liquidated even from a thin pool.
  if (opts.inputMint === SOL_MINT) {
    // Explicit finite/non-negative parse so a deliberate 0 ("block any measurable
    // impact") isn't swallowed by `|| 10` and silently widened to the lenient default.
    const rawImpact = Number(process.env.MAX_PRICE_IMPACT_PCT)
    const maxImpact = Number.isFinite(rawImpact) && rawImpact >= 0 ? rawImpact : 10
    const raw = quote.priceImpactPct // Jupiter returns a fraction string, e.g. "0.012"
    const impactPct = Number(raw) * 100
    // FAIL CLOSED on a missing/garbled impact: a buy must never proceed on an
    // unknown price impact. Without the explicit empty/null guard, Number(null)*100
    // and Number('')*100 are 0 (finite) and would masquerade as 0% impact, silently
    // disabling thin-pool protection. Sells (inputMint != SOL) skip this entirely so
    // a position can always be liquidated.
    const valid = raw != null && String(raw).trim() !== '' && Number.isFinite(impactPct)
    if (!valid || impactPct > maxImpact)
      throw new Error(`price impact ${valid ? impactPct.toFixed(1) + '%' : 'unavailable'} exceeds the ${maxImpact}% ceiling — pool too thin / quote unsafe, entry aborted`)
  }

  const swapRes = await fetch(`${JUP}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: ownerPubkey().toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  })
  if (!swapRes.ok) throw new Error(`jupiter swap build failed: ${swapRes.status} ${(await swapRes.text()).slice(0, 160)}`)
  const { swapTransaction } = await swapRes.json()
  if (!swapTransaction) throw new Error('jupiter returned no transaction')

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'))
  if (turnkeySolReady()) await turnkeySignSolana(tx)
  else tx.sign([signer()])
  const conn = connection()
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  const latest = await conn.getLatestBlockhash('confirmed')
  const conf = await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed')
  if (conf.value.err) throw new Error(`solana tx failed: ${JSON.stringify(conf.value.err)}`)
  return sig
}

/**
 * Execute a CROSS-CHAIN swap FROM Solana via LI.FI (destination may be any EVM chain or
 * Solana). LI.FI returns a base64-encoded Solana transaction; we deserialize it, sign with
 * the bot's Solana signer (Turnkey or raw keypair) and send — the same sign+send tail as a
 * Jupiter swap. The destination delivery settles afterwards; we return the SOURCE Solana
 * signature + the bridge/ETA. `toAddress` is the user's OWN wallet on the destination chain.
 */
export async function executeCrossChainSolana(opts: {
  toChainId: number // LI.FI destination chain id (an EVM chainId, or LIFI_SOLANA_CHAIN)
  sellToken: string // Solana mint, or 'native' for SOL
  buyToken: string // destination token (EVM address or Solana mint)
  amountBaseUnits: bigint
  toAddress: string // the user's wallet on the destination chain
  slippageBps?: number
}): Promise<{ sig: string; toAmount: string; toolName: string; durationSec: number }> {
  if (!solanaLiveReady()) throw new Error('Solana signer not configured')
  if (opts.amountBaseUnits <= 0n) throw new Error('amount must be positive')
  const q = await lifiQuote({
    fromChainId: LIFI_SOLANA_CHAIN,
    toChainId: opts.toChainId,
    sellToken: opts.sellToken,
    buyToken: opts.buyToken,
    sellAmountBaseUnits: opts.amountBaseUnits,
    fromAddress: ownerPubkey().toBase58(),
    toAddress: opts.toAddress,
    slippageBps: opts.slippageBps,
  })
  if (!q.tx.data) throw new Error('bridge returned no Solana transaction')
  const tx = VersionedTransaction.deserialize(Buffer.from(q.tx.data, 'base64'))
  if (turnkeySolReady()) await turnkeySignSolana(tx)
  else tx.sign([signer()])
  const conn = connection()
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  const latest = await conn.getLatestBlockhash('confirmed')
  const conf = await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed')
  if (conf.value.err) throw new Error(`solana bridge tx failed: ${JSON.stringify(conf.value.err)}`)
  return { sig, toAmount: q.toAmount, toolName: q.toolName, durationSec: q.durationSec }
}

/** Build a v0 tx from `instructions` (fee payer = the bot wallet), sign it via
 *  Turnkey or the raw keypair, send and confirm — the same send+confirm tail as
 *  executeSolanaSwap, reused by the withdrawal transfers below. */
async function signSendConfirm(conn: Connection, payer: PublicKey, instructions: TransactionInstruction[]): Promise<string> {
  const latest = await conn.getLatestBlockhash('confirmed')
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: latest.blockhash, instructions }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  if (turnkeySolReady()) await turnkeySignSolana(tx)
  else tx.sign([signer()])
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  const conf = await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed')
  if (conf.value.err) throw new Error(`solana tx failed: ${JSON.stringify(conf.value.err)}`)
  return sig
}

/** Send native SOL OUT of the bot wallet to an external address (profit
 *  withdrawal). `lamports` is the exact amount — the caller leaves the gas
 *  reserve. Returns the transaction signature; throws on confirm failure. */
export async function sendSolNative(to: string, lamports: bigint): Promise<string> {
  if (!solanaLiveReady()) throw new Error('SOLANA signer not configured')
  if (lamports <= 0n) throw new Error('amount must be positive')
  const conn = connection()
  const from = ownerPubkey()
  const ix = SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(to), lamports })
  return signSendConfirm(conn, from, [ix])
}

/** Send an SPL token (e.g. a USDT profit balance) OUT of the bot wallet to an
 *  external owner address. Derives both associated token accounts; creates the
 *  recipient's ATA (rent paid by the bot wallet) when it doesn't exist yet so a
 *  payout to a fresh wallet still lands. `amountBaseUnits` is in the mint's base
 *  units. Returns the signature; throws on confirm failure. */
export async function sendSplToken(mint: string, to: string, amountBaseUnits: bigint): Promise<string> {
  if (!solanaLiveReady()) throw new Error('SOLANA signer not configured')
  if (amountBaseUnits <= 0n) throw new Error('amount must be positive')
  // Dynamic import keeps @solana/spl-token out of the paper-mode / test module graph.
  const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } = await import('@solana/spl-token')
  const conn = connection()
  const owner = ownerPubkey()
  const mintPk = new PublicKey(mint)
  const toOwner = new PublicKey(to)
  const sourceAta = getAssociatedTokenAddressSync(mintPk, owner)
  const destAta = getAssociatedTokenAddressSync(mintPk, toOwner)
  // Idempotently ensure the recipient's ATA exists (a fresh wallet has none) — the
  // bot wallet pays the ~0.002 SOL rent only when it's actually created, and the
  // instruction is a no-op if it already exists. Without it the transfer reverts.
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(owner, destAta, toOwner, mintPk),
    createTransferInstruction(sourceAta, destAta, owner, amountBaseUnits),
  ]
  return signSendConfirm(conn, owner, ixs)
}
