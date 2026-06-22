// Live on-chain execution via the 0x Swap API (v2, allowance-holder flow)
// and a DEDICATED bot wallet. Dormant unless both env vars are set — the
// engine runs in paper mode otherwise. Trades are native-coin ↔ token, so
// proceeds always land in the chain's native currency.

import { createWalletClient, http, publicActions, erc20Abi, type Account, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, arbitrum, optimism, polygon, bsc } from 'viem/chains'
import { turnkeyEvmReady, turnkeyEvmAddress, turnkeyEvmAccount } from './live-turnkey.js'
import { markProvider } from './health.js'

const CHAINS = { 8453: base, 42161: arbitrum, 10: optimism, 137: polygon, 56: bsc } as const
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// Live EVM trading is armed when 0x is configured AND we have a VALID signer — either a
// raw BOT_WALLET_KEY (a 32-byte hex private key) or a Turnkey-backed wallet (key never
// leaves Turnkey). Validate the key's FORMAT (cheap regex, no EC derivation in this hot
// path) so `ready` never reports true for a malformed key that would fail at signing.
const EVM_PRIVKEY = /^0x[a-fA-F0-9]{64}$/
export const liveReady = () => Boolean(process.env.ZEROX_API_KEY) && (EVM_PRIVKEY.test(process.env.BOT_WALLET_KEY ?? '') || turnkeyEvmReady())

/** Which backend signs EVM live txs — 'turnkey' (key in Turnkey), 'key' (raw), or null. */
export const evmSigner = (): 'turnkey' | 'key' | null =>
  turnkeyEvmReady() ? 'turnkey' : process.env.BOT_WALLET_KEY ? 'key' : null

export function botWalletAddress(): string | null {
  if (turnkeyEvmReady()) return turnkeyEvmAddress()
  if (!process.env.BOT_WALLET_KEY) return null
  try {
    return privateKeyToAccount(process.env.BOT_WALLET_KEY as Hex).address
  } catch {
    return null
  }
}

/** The signer: a Turnkey-backed viem account when configured, else the raw key. */
async function account(): Promise<Account> {
  if (turnkeyEvmReady()) return turnkeyEvmAccount()
  return privateKeyToAccount(process.env.BOT_WALLET_KEY as Hex)
}

/** Per-chain dedicated RPC override (EVM_RPC_URL_<chainId>), or undefined to use
 *  viem's chain default. MUST be per-chain: the 5 EVM chains trade concurrently on
 *  separate lanes, so a single shared URL would point 4 of them at the wrong node. */
export function rpcUrlFor(chainId: number): string | undefined {
  return process.env[`EVM_RPC_URL_${chainId}`] || undefined
}

async function realClient(chainId: number) {
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  if (!chain) throw new Error(`unsupported chain ${chainId}`)
  // A dedicated RPC (Alchemy/Infura/…) replaces viem's rate-limited public default
  // under real load. http(undefined) keeps the chain default when unset.
  return createWalletClient({ account: await account(), chain, transport: http(rpcUrlFor(chainId)) }).extend(publicActions)
}

type WalletClient = Awaited<ReturnType<typeof realClient>>

// Indirection so unit tests can inject a fake wallet client and exercise the
// executor logic (quote handling, allowance, revert guard) without a real chain.
// Production always resolves through realClient(); the override is test-only.
let clientOverride: ((chainId: number) => Promise<unknown>) | null = null
async function client(chainId: number): Promise<WalletClient> {
  return (clientOverride ? clientOverride(chainId) : realClient(chainId)) as Promise<WalletClient>
}

/** Test seam — NOT used in production. Inject a fake client, then reset(). */
export const __test = {
  setClient(f: (chainId: number) => Promise<unknown>) {
    clientOverride = f
  },
  reset() {
    clientOverride = null
  },
}

/** The bot wallet's real on-chain balance of an ERC-20, in base units. Used to
 *  clamp live sells so a swap can never try to spend more than the wallet holds. */
export async function tokenBalanceBaseUnits(chainId: number, tokenAddress: string): Promise<bigint> {
  const wc = await client(chainId)
  return (await wc.readContract({
    address: tokenAddress as Hex,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [wc.account.address],
  })) as bigint
}

/** The bot wallet's native-coin balance (wei). Used to keep a gas reserve so a
 *  bot can always afford the gas to SELL out of a position it bought. */
export async function nativeBalanceWei(chainId: number): Promise<bigint> {
  const wc = await client(chainId)
  return wc.getBalance({ address: wc.account.address })
}

/** Send native coin OUT of the bot wallet to an external address (profit
 *  withdrawal). Waits for the receipt and throws on revert. Caller is responsible
 *  for leaving a gas reserve — this sends exactly `amountWei`. */
export async function sendNative(chainId: number, to: string, amountWei: bigint): Promise<Hex> {
  if (amountWei <= 0n) throw new Error('amount must be positive')
  const wc = await client(chainId)
  const hash = await wc.sendTransaction({ to: to as Hex, value: amountWei, chain: wc.chain })
  const receipt = await wc.waitForTransactionReceipt({ hash, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error(`native transfer reverted: ${hash}`)
  return hash
}

/** Send an ERC-20 (e.g. a USDT profit balance) OUT of the bot wallet to an
 *  external address. Waits for the receipt and throws on revert. */
export async function sendErc20(chainId: number, token: string, to: string, amountBaseUnits: bigint): Promise<Hex> {
  if (amountBaseUnits <= 0n) throw new Error('amount must be positive')
  const wc = await client(chainId)
  const hash = await wc.writeContract({
    address: token as Hex,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to as Hex, amountBaseUnits],
    chain: wc.chain,
  })
  const receipt = await wc.waitForTransactionReceipt({ hash, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error(`erc20 transfer reverted: ${hash}`)
  return hash
}

// Shape of the 0x v2 allowance-holder quote we actually read. External JSON, so the
// `as Hex` brands on transaction.to/.data are validated-external casts (unchanged), and
// every other access already guards with `??`/optional chaining.
interface ZeroXQuote {
  liquidityAvailable?: boolean
  buyAmount?: string
  minBuyAmount?: string
  issues?: { allowance?: { spender?: string } }
  transaction: { to: string; data: string; value?: string; gas?: string }
}

// HARD ceiling on execution slippage. A user-supplied slippageBps flows in from the
// manual-swap route; without a cap, an absurd value (e.g. 1_000_000 = 10,000%) would
// authorise a near-total-loss fill that MEV sandwiches drain. 50% is generous even for
// sniping ultra-thin launches — anything above is never a legitimate intent. Every
// executor resolves its bps through here so the cap can't be bypassed by any caller.
export const SLIPPAGE_BPS_CEILING = 5000
export const resolveSlippageBps = (override?: number): number =>
  Math.min(override && override > 0 ? Math.floor(override) : Number(process.env.MAX_SLIPPAGE_BPS) || 100, SLIPPAGE_BPS_CEILING)

// ── 0x router allowlist (drain protection) ───────────────────────────────────
// In the 0x v2 allowance-holder flow the token approval spender AND the swap
// `transaction.to` are the SAME contract: the AllowanceHolder. It's deployed at one
// deterministic address on every chain we trade (Base, Arbitrum, Optimism, Polygon,
// BNB — all Cancun/PUSH0 era). We pin to it so a spoofed/compromised/MITM'd quote
// can't redirect the approval or the calldata to a draining contract. Two further,
// deployment-INDEPENDENT guards back this up: we require to === spender (the flow's
// invariant), and we approve only the exact sell amount (never maxUint256), so even a
// quote that somehow slipped past can pull at most this one trade's tokens. 0x notes
// the address "may change with new deployments" — if it ever does, add the new one to
// ZEROX_ALLOWANCE_HOLDER (comma-separated, EXTENDS the default) and the pin follows.
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734'
function zeroxAllowlist(): Set<string> {
  const set = new Set([ZEROX_ALLOWANCE_HOLDER.toLowerCase()])
  for (const a of (process.env.ZEROX_ALLOWANCE_HOLDER ?? '').split(',')) {
    const t = a.trim().toLowerCase()
    if (t) set.add(t)
  }
  return set
}
/** Reject a 0x quote whose swap target — or approval spender — isn't the known
 *  AllowanceHolder, before any approve or send. `spender` is given on token sells
 *  (where an allowance is granted); omit it for native-funded buys. */
export function assertZeroxRoute(to: string | undefined, spender?: string): void {
  const allow = zeroxAllowlist()
  const t = (to ?? '').toLowerCase()
  if (!t || !allow.has(t))
    throw new Error(`0x swap target ${to ?? '(none)'} is not the known AllowanceHolder — refusing to send (spoofed/compromised quote, or 0x redeployed: set ZEROX_ALLOWANCE_HOLDER).`)
  if (spender !== undefined) {
    const sp = spender.toLowerCase()
    if (!allow.has(sp))
      throw new Error(`0x approval spender ${spender} is not the known AllowanceHolder — refusing to approve (spoofed/compromised quote, or 0x redeployed: set ZEROX_ALLOWANCE_HOLDER).`)
    if (sp !== t)
      throw new Error(`0x quote approval spender (${spender}) ≠ swap target (${to}) — refusing (allowance-holder flow requires them equal; possible spoofed quote).`)
  }
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
  // Expected token-out (base units) if we paid the FAIR price with no impact.
  // When given on a BUY, the quote is aborted if its token-out falls more than
  // MAX_PRICE_IMPACT_PCT below this — a thin/bad route. Sells never set it.
  fairBuyBaseUnits?: bigint
}): Promise<Hex> {
  const wc = await client(opts.chainId)
  const taker = wc.account.address
  const sellToken = opts.side === 'buy' ? NATIVE : opts.tokenAddress
  const buyToken = opts.side === 'buy' ? opts.tokenAddress : opts.buyTokenAddress ?? NATIVE

  const qs = new URLSearchParams({
    chainId: String(opts.chainId),
    sellToken,
    buyToken,
    sellAmount: opts.sellAmountBaseUnits.toString(),
    taker,
    // Max execution slippage (bps). Default 1% — tighten on deep pairs to give up
    // less to MEV/slippage; loosen on thin pools so exits don't revert.
    slippageBps: String(resolveSlippageBps()),
  })
  const res = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${qs}`, {
    headers: { '0x-api-key': process.env.ZEROX_API_KEY!, '0x-version': 'v2' },
    signal: AbortSignal.timeout(10_000), // never hang the serialized lane on a black-holed quote
  })
  if (!res.ok) { markProvider('0x', false, `quote HTTP ${res.status}`); throw new Error(`0x quote failed: ${res.status} ${await res.text()}`) }
  markProvider('0x', true)
  const quote = (await res.json()) as ZeroXQuote
  if (quote.liquidityAvailable === false) throw new Error('0x: no liquidity for this pair/size')

  // Entry price-impact backstop (BUYS only): 0x v2 bounds SLIPPAGE via slippageBps
  // but NOT the impact already baked into a thin-pool quote. If the quoted token-out
  // is far below what the fair price implies, the route is too thin — abort the
  // entry. Generous default (10%) so liquid pairs (impact ~0) never false-positive;
  // favorable fills (got >= fair) always pass. Sells skip this so exits always work.
  if (opts.side === 'buy' && opts.fairBuyBaseUnits && opts.fairBuyBaseUnits > 0n) {
    const got = BigInt(quote.buyAmount ?? quote.minBuyAmount ?? 0)
    if (got <= 0n) throw new Error('0x: quote returned no buy amount — entry aborted')
    // Explicit finite/non-negative parse so a deliberate 0 ("block any measurable
    // impact") isn't swallowed by `|| 10` and silently widened to the lenient default.
    const rawImpact = Number(process.env.MAX_PRICE_IMPACT_PCT)
    const maxImpact = Number.isFinite(rawImpact) && rawImpact >= 0 ? rawImpact : 10
    // (fair - got)/fair in %, via basis points to stay in integer/bigint math.
    const impactPct = got >= opts.fairBuyBaseUnits ? 0 : Number(((opts.fairBuyBaseUnits - got) * 10_000n) / opts.fairBuyBaseUnits) / 100
    if (impactPct > maxImpact) throw new Error(`price impact ${impactPct.toFixed(1)}% exceeds ${maxImpact}% — pool too thin, entry aborted`)
  }

  // Token sells need a one-time allowance for the 0x AllowanceHolder. Validate the
  // route FIRST (spender + transaction.to must both be the known AllowanceHolder and
  // equal), then approve only this trade's exact sell amount — never an unbounded
  // maxUint256 that a future bad quote could drain. [P1-4]
  const spender = quote.issues?.allowance?.spender
  if (opts.side === 'sell' && spender) {
    assertZeroxRoute(quote.transaction.to, spender)
    const approveHash = await wc.writeContract({
      address: opts.tokenAddress as Hex,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender as Hex, opts.sellAmountBaseUnits],
      chain: wc.chain,
    })
    await wc.waitForTransactionReceipt({ hash: approveHash, timeout: 90_000 })
  } else {
    assertZeroxRoute(quote.transaction.to) // native-funded buy (no approval) — pin the target
  }

  const hash = await wc.sendTransaction({
    to: quote.transaction.to as Hex,
    data: quote.transaction.data as Hex,
    value: BigInt(quote.transaction.value ?? 0),
    gas: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
    chain: wc.chain,
  })
  const receipt = await wc.waitForTransactionReceipt({ hash, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error(`swap tx reverted: ${hash}`)
  return hash
}

// ── Manual swap (the user-facing Swap panel) ─────────────────────────────────
// A GENERAL tokenA→tokenB swap (vs the bot's native↔token shape), reusing the same
// 0x v2 allowance-holder flow, key and Turnkey signer. `'native'` (or the 0xEeee…
// sentinel) means the chain's native coin.

const isNative = (t: string) => t.toLowerCase() === NATIVE.toLowerCase() || t.toLowerCase() === 'native'
const tokenAddr = (t: string) => (isNative(t) ? NATIVE : t)

/** Shape of the 0x v2 /price response we read (indicative quote — no calldata). */
interface ZeroXPrice {
  liquidityAvailable?: boolean
  buyAmount?: string
  minBuyAmount?: string
  gas?: string
  totalNetworkFee?: string
  issues?: { allowance?: { spender?: string } | null }
}

/** Indicative price for the live preview (0x /price — commits nothing). Amounts in
 *  the SELL token's base units. Throws when there's no route/liquidity. */
export async function swapPrice0x(
  chainId: number,
  sellToken: string,
  buyToken: string,
  sellAmountBaseUnits: bigint,
  slippageBps?: number,
): Promise<{ buyAmount: string; minBuyAmount: string; gas: string | null; totalNetworkFeeWei: string | null; needsAllowance: boolean }> {
  const qs = new URLSearchParams({
    chainId: String(chainId),
    sellToken: tokenAddr(sellToken),
    buyToken: tokenAddr(buyToken),
    sellAmount: sellAmountBaseUnits.toString(),
    slippageBps: String(resolveSlippageBps(slippageBps)),
  })
  const taker = botWalletAddress()
  if (taker) qs.set('taker', taker)
  const res = await fetch(`https://api.0x.org/swap/allowance-holder/price?${qs}`, {
    headers: { '0x-api-key': process.env.ZEROX_API_KEY!, '0x-version': 'v2' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`0x price failed: ${res.status} ${await res.text()}`)
  const q = (await res.json()) as ZeroXPrice
  if (q.liquidityAvailable === false || !q.buyAmount) throw new Error('no liquidity for this pair / size')
  return {
    buyAmount: String(q.buyAmount),
    minBuyAmount: String(q.minBuyAmount ?? q.buyAmount),
    gas: q.gas ?? null,
    totalNetworkFeeWei: q.totalNetworkFee ?? null,
    needsAllowance: Boolean(q.issues?.allowance),
  }
}

/** Execute a general swap LIVE: firm 0x quote → one-time allowance (ERC-20 sells) →
 *  send → wait for the receipt. Returns the tx hash + the bought base-unit amount. */
export async function executeSwapGeneral(opts: {
  chainId: number
  sellToken: string
  buyToken: string
  sellAmountBaseUnits: bigint
  slippageBps?: number
  // Expected token-out at the FAIR (no-impact) price, in buy-token base units. When given,
  // the swap aborts if the quoted output falls more than MAX_PRICE_IMPACT_PCT below it — the
  // same thin-pool backstop the bot path has. The route supplies it for priceable tokens;
  // a pasted/unpriceable token falls back to the (capped) slippage + the honeypot screen.
  fairBuyBaseUnits?: bigint
}): Promise<{ hash: Hex; buyAmount: string }> {
  const wc = await client(opts.chainId)
  const taker = wc.account.address
  const sell = tokenAddr(opts.sellToken)
  const bps = resolveSlippageBps(opts.slippageBps)
  const qs = new URLSearchParams({
    chainId: String(opts.chainId),
    sellToken: sell,
    buyToken: tokenAddr(opts.buyToken),
    sellAmount: opts.sellAmountBaseUnits.toString(),
    taker,
    slippageBps: String(bps),
  })
  const res = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${qs}`, {
    headers: { '0x-api-key': process.env.ZEROX_API_KEY!, '0x-version': 'v2' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`0x quote failed: ${res.status} ${await res.text()}`)
  const quote = (await res.json()) as ZeroXQuote
  if (quote.liquidityAvailable === false) throw new Error('no liquidity for this pair / size')
  // Price-impact backstop: slippageBps bounds slippage but NOT the impact baked into a
  // thin-pool quote. If the quoted output is far below the fair-price implied output, the
  // route is too thin — abort. (Mirrors executeSwap's bot-path guard.)
  if (opts.fairBuyBaseUnits && opts.fairBuyBaseUnits > 0n) {
    const got = BigInt(quote.buyAmount ?? quote.minBuyAmount ?? 0)
    if (got <= 0n) throw new Error('0x: quote returned no buy amount — swap aborted')
    const rawImpact = Number(process.env.MAX_PRICE_IMPACT_PCT)
    const maxImpact = Number.isFinite(rawImpact) && rawImpact >= 0 ? rawImpact : 10
    const impactPct = got >= opts.fairBuyBaseUnits ? 0 : Number(((opts.fairBuyBaseUnits - got) * 10_000n) / opts.fairBuyBaseUnits) / 100
    if (impactPct > maxImpact) throw new Error(`price impact ${impactPct.toFixed(1)}% exceeds ${maxImpact}% — pool too thin, swap aborted`)
  }
  // ERC-20 sells need a one-time allowance for the 0x AllowanceHolder (native skips it).
  // Pin the route + approve the exact amount, same as the bot path. [P1-4]
  const spender = quote.issues?.allowance?.spender
  if (!isNative(opts.sellToken) && spender) {
    assertZeroxRoute(quote.transaction.to, spender)
    const approveHash = await wc.writeContract({ address: sell as Hex, abi: erc20Abi, functionName: 'approve', args: [spender as Hex, opts.sellAmountBaseUnits], chain: wc.chain })
    await wc.waitForTransactionReceipt({ hash: approveHash, timeout: 90_000 })
  } else {
    assertZeroxRoute(quote.transaction.to)
  }
  const hash = await wc.sendTransaction({
    to: quote.transaction.to as Hex,
    data: quote.transaction.data as Hex,
    value: BigInt(quote.transaction.value ?? 0),
    gas: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
    chain: wc.chain,
  })
  const receipt = await wc.waitForTransactionReceipt({ hash, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error(`swap tx reverted: ${hash}`)
  return { hash, buyAmount: String(quote.buyAmount ?? quote.minBuyAmount ?? '0') }
}

// ── Cross-chain (bridge) swaps via LI.FI ─────────────────────────────────────
// Bridges between any EVM chains AND Solana, using the dedicated bot wallet on each
// chain. LI.FI aggregates bridges; its /quote returns the estimate + a ready-to-send
// transactionRequest (an EVM tx for an EVM source, OR a base64 Solana tx for a Solana
// source) + the spender to approve. The source tx deposits into the bridge; the
// destination delivery settles asynchronously (seconds–minutes). `toAddress` is the
// user's OWN wallet on the destination chain.

const LIFI = 'https://li.quest/v1'
const LIFI_NATIVE = '0x0000000000000000000000000000000000000000' // LI.FI native sentinel on EVM (zero address)
const LIFI_SOL_NATIVE = '11111111111111111111111111111111' // LI.FI native sentinel on Solana (system program)
export const LIFI_SOLANA_CHAIN = 1151111081099710 // LI.FI's chain id for Solana (NOT our networks 101)
const lifiNativeFor = (chainId: number) => (chainId === LIFI_SOLANA_CHAIN ? LIFI_SOL_NATIVE : LIFI_NATIVE)
const lifiToken = (t: string, chainId: number) => (isNative(t) ? lifiNativeFor(chainId) : t)

export interface BridgeQuote {
  toAmount: string
  toAmountMin: string
  approvalAddress: string
  durationSec: number
  toolName: string
  gasUsd: string | null
  feeUsd: string | null
  // EVM source: `to`/`value`/`gasLimit` set. Solana source: ONLY `data` (a base64 Solana tx).
  tx: { to?: string; data: string; value: string; gasLimit?: string; chainId: number }
}

const sumUsd = (arr: unknown): number =>
  Array.isArray(arr) ? arr.reduce((s: number, c) => s + (Number((c as { amountUSD?: unknown })?.amountUSD) || 0), 0) : 0

/** Indicative cross-chain quote (no funds move). Works EVM↔EVM, EVM↔Solana and Solana↔EVM. */
export async function lifiQuote(opts: {
  fromChainId: number
  toChainId: number
  sellToken: string
  buyToken: string
  sellAmountBaseUnits: bigint
  fromAddress: string
  toAddress?: string // the user's OWN wallet on the destination chain (defaults to fromAddress)
  slippageBps?: number
}): Promise<BridgeQuote> {
  const bps = resolveSlippageBps(opts.slippageBps)
  const qs = new URLSearchParams({
    fromChain: String(opts.fromChainId),
    toChain: String(opts.toChainId),
    fromToken: lifiToken(opts.sellToken, opts.fromChainId),
    toToken: lifiToken(opts.buyToken, opts.toChainId),
    fromAmount: opts.sellAmountBaseUnits.toString(),
    fromAddress: opts.fromAddress,
    toAddress: opts.toAddress ?? opts.fromAddress,
    slippage: String(bps / 10_000),
    integrator: 'pulsetrade',
  })
  const res = await fetch(`${LIFI}/quote?${qs}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`bridge quote failed: ${res.status} ${await res.text()}`)
  const q = (await res.json()) as {
    estimate?: { toAmount?: unknown; toAmountMin?: unknown; approvalAddress?: unknown; executionDuration?: unknown; gasCosts?: unknown; feeCosts?: unknown }
    transactionRequest?: { to?: unknown; data?: unknown; value?: unknown; gasLimit?: unknown; chainId?: unknown }
    toolDetails?: { name?: unknown }
    tool?: unknown
  }
  const est = q.estimate
  const tx = q.transactionRequest
  // A Solana-source quote carries ONLY `data` (a base64 tx); an EVM source also has `to`.
  // Require `data` either way — that's what actually gets signed + sent.
  if (!est || typeof tx?.data !== 'string') throw new Error('no bridge route for this pair / size')
  const g = sumUsd(est.gasCosts)
  const f = sumUsd(est.feeCosts)
  const toAmount = String(est.toAmount ?? '0')
  const toAmountMin = String(est.toAmountMin ?? est.toAmount ?? '0')
  // LI.FI hands back integer base-unit strings. If a route ever yields a non-integer
  // (decimal / scientific notation / null), fail HONESTLY here — otherwise the web's
  // BigInt() throws and is swallowed into a misleading "0 received" on a real quote.
  if (!/^\d+$/.test(toAmount) || !/^\d+$/.test(toAmountMin)) throw new Error('bridge quote returned a non-integer amount')
  return {
    toAmount,
    toAmountMin,
    approvalAddress: typeof est.approvalAddress === 'string' ? est.approvalAddress : typeof tx.to === 'string' ? tx.to : '',
    durationSec: Number(est.executionDuration) || 0,
    toolName: String(q.toolDetails?.name ?? q.tool ?? 'bridge'),
    gasUsd: g ? g.toFixed(2) : null,
    feeUsd: f ? f.toFixed(2) : null,
    tx: { to: typeof tx.to === 'string' ? tx.to : undefined, data: tx.data, value: typeof tx.value === 'string' ? tx.value : '0x0', gasLimit: typeof tx.gasLimit === 'string' ? tx.gasLimit : undefined, chainId: Number(tx.chainId) || opts.fromChainId },
  }
}

/** Execute a cross-chain swap from an EVM SOURCE chain (destination may be EVM or Solana).
 *  Approves the bridge spender for ERC-20 sources, sends the source tx, confirms it mined.
 *  The destination delivery settles afterwards — we return the SOURCE hash + the bridge/ETA.
 *  `toAddress` is the user's wallet on the destination chain (defaults to the same EVM wallet). */
export async function executeCrossChainEvm(opts: {
  fromChainId: number
  toChainId: number
  sellToken: string
  buyToken: string
  sellAmountBaseUnits: bigint
  toAddress?: string
  slippageBps?: number
}): Promise<{ hash: Hex; toAmount: string; toolName: string; durationSec: number }> {
  const wc = await client(opts.fromChainId)
  const q = await lifiQuote({ ...opts, fromAddress: wc.account.address, toAddress: opts.toAddress ?? wc.account.address })
  if (!q.tx.to) throw new Error('bridge quote returned no EVM transaction for this source') // EVM source must yield an EVM tx
  // ERC-20 sources need a one-time allowance for the bridge's spender (native skips it).
  // Approve only this bridge's exact amount, not maxUint256 — the LI.FI router varies by
  // route so it can't be allowlisted, but a bounded approval caps the blast radius. [P1-4]
  if (!isNative(opts.sellToken) && q.approvalAddress) {
    const approveHash = await wc.writeContract({ address: opts.sellToken as Hex, abi: erc20Abi, functionName: 'approve', args: [q.approvalAddress as Hex, opts.sellAmountBaseUnits], chain: wc.chain })
    await wc.waitForTransactionReceipt({ hash: approveHash, timeout: 90_000 })
  }
  const hash = await wc.sendTransaction({
    to: q.tx.to as Hex,
    data: q.tx.data as Hex,
    value: BigInt(q.tx.value || '0'),
    gas: q.tx.gasLimit ? BigInt(q.tx.gasLimit) : undefined,
    chain: wc.chain,
  })
  const receipt = await wc.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`bridge source tx reverted: ${hash}`)
  return { hash, toAmount: q.toAmount, toolName: q.toolName, durationSec: q.durationSec }
}

/** On-chain symbol + decimals for an arbitrary ERC-20 (the paste-an-address path). */
export async function tokenInfo(chainId: number, address: string): Promise<{ symbol: string; decimals: number }> {
  const wc = await client(chainId)
  const [symbol, decimals] = await Promise.all([
    wc.readContract({ address: address as Hex, abi: erc20Abi, functionName: 'symbol' }),
    wc.readContract({ address: address as Hex, abi: erc20Abi, functionName: 'decimals' }),
  ])
  return { symbol: String(symbol), decimals: Number(decimals) }
}

/** The bot wallet's balance of `token` (native or ERC-20) in base units. */
export async function swapBalance(chainId: number, token: string): Promise<bigint> {
  return isNative(token) ? nativeBalanceWei(chainId) : tokenBalanceBaseUnits(chainId, token)
}
