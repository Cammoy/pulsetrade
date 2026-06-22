// Read-only wallet portfolio: native + curated-token balances for an address,
// priced via CoinGecko and aggregated. No keys / no wallet — just public reads, so
// any address can be inspected. The reader DISPATCHES by address type:
//   • EVM (0x…)          → native + curated ERC-20s across the 6 supported EVM chains
//   • Solana (base58)    → native SOL + curated SPL tokens
//   • ICP (principal)    → native ICP + ckBTC / ckUSDT via the ICRC-1 ledger canisters
// Powers the "what's in my wallet" view (totals + by-network + by-asset breakdowns).
// The web client reads several addresses (one per ecosystem) and merges them, so a
// user sees EVM + Solana holdings together.

import { createPublicClient, http, erc20Abi, isAddress, type Hex, type Chain } from 'viem'
import { base, arbitrum, optimism, polygon, bsc, mainnet } from 'viem/chains'
import { Connection, PublicKey } from '@solana/web3.js'
import { NETWORKS, networkById } from './networks.js'
import { getSpotPrices } from './prices.js'
import { rpcUrlFor } from './live.js'
import { SOL_ADDR, ICP_PRINCIPAL } from './validators.js'

const VIEM_CHAINS: Record<number, Chain> = { 1: mainnet, 8453: base, 42161: arbitrum, 10: optimism, 137: polygon, 56: bsc }

// Reliable public RPCs for the read-only balance reads, used when EVM_RPC_URL_<id> is
// unset. viem's defaults (esp. mainnet → cloudflare-eth) are heavily rate-limited and
// were timing out; publicnode endpoints are far more dependable and need no key.
const DEFAULT_RPC: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  56: 'https://bsc-rpc.publicnode.com',
}

// SPL token program — owner of every standard SPL token account.
const SPL_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

// SOL_ADDR / ICP_PRINCIPAL address-shape regexes — shared, in ./validators.js.

/** Reject a promise that outruns `ms` so a slow/rate-limited public RPC degrades to
 *  an error row instead of hanging the HTTP request (web3.js has no built-in timeout). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
      t.unref?.()
    }),
  ])
}

// Last GOOD read per address. Public RPCs rate-limit, so without this a repeated
// load re-hits them (and a transient 429 shows an empty wallet). We serve a fresh
// cache directly, and on a failed/partial read fall back to a recent good one — so
// "my portfolio didn't load" becomes "showing balances from a minute ago". [robustness]
const portCache = new Map<string, { at: number; data: Portfolio }>()
const FRESH_MS = 45_000 // within this window, serve the cache without touching an RPC
const STALE_FALLBACK_MS = 300_000 // on a failed read, prefer a good cache up to this old

export interface Holding {
  network: string
  networkName: string
  color: string
  symbol: string
  name: string
  kind: 'native' | 'token'
  balance: number
  priceUsd: number | null
  usd: number
}

export interface Portfolio {
  address: string
  totalUsd: number
  holdings: Holding[] // sorted by USD desc; native assets always kept (even at $0), token dust dropped
  byNetwork: { id: string; name: string; color: string; usd: number }[]
  errors: string[] // chains/ecosystems whose read failed (partial result)
}

/** Intermediate balance row before pricing. */
type Raw = { netId: string; netName: string; color: string; symbol: string; name: string; cg: string; kind: 'native' | 'token'; balance: number }

/**
 * Dust-filter + by-network rollup over already-priced holdings. PURE (no network) —
 * exported for unit tests. The wallet view must be COMPREHENSIVE: every integrated
 * network the address touches has to show, so a chain's NATIVE asset is ALWAYS kept
 * even at a $0 balance (the readers emit one native row per successfully-read chain).
 * Only priced *token* dust (< $0.01) is dropped; a held-but-unpriced row is kept so
 * nothing silently vanishes. byNetwork is derived from the kept holdings, so it then
 * lists every read network (the zero ones surface as a $0 / 0% slice in the UI).
 */
export function aggregateHoldings(address: string, priced: Holding[], errors: string[] = []): Portfolio {
  const holdings = priced
    .filter((h) => h.kind === 'native' || h.usd >= 0.01 || h.priceUsd === null)
    .sort((a, b) => b.usd - a.usd)

  const byNetworkMap = new Map<string, { id: string; name: string; color: string; usd: number }>()
  for (const h of holdings) {
    const e = byNetworkMap.get(h.network) ?? { id: h.network, name: h.networkName, color: h.color, usd: 0 }
    e.usd += h.usd
    byNetworkMap.set(h.network, e)
  }

  return {
    address,
    totalUsd: +holdings.reduce((s, h) => s + h.usd, 0).toFixed(2),
    holdings,
    byNetwork: [...byNetworkMap.values()].sort((a, b) => b.usd - a.usd),
    errors,
  }
}

/** Price every distinct asset once, then aggregate raws → a Portfolio. */
async function priceAndAggregate(address: string, raws: Raw[], errors: string[]): Promise<Portfolio> {
  const ids = [...new Set(raws.map((r) => r.cg))]
  let prices = new Map<string, number>()
  if (ids.length) {
    try {
      prices = await getSpotPrices(ids)
    } catch {
      /* leave unpriced → usd 0 */
    }
  }

  const priced: Holding[] = raws.map((r) => {
    const priceUsd = prices.get(r.cg) ?? null
    return { network: r.netId, networkName: r.netName, color: r.color, symbol: r.symbol, name: r.name, kind: r.kind, balance: r.balance, priceUsd, usd: priceUsd ? r.balance * priceUsd : 0 }
  })
  return aggregateHoldings(address, priced, errors)
}

/** Native + curated ERC-20 balances across the 6 supported EVM chains. */
async function readEvm(address: string): Promise<Portfolio> {
  const chains = NETWORKS.filter((n) => n.evm && VIEM_CHAINS[n.chainId])
  const errors: string[] = []
  const raws: Raw[] = []

  await Promise.all(
    chains.map(async (net) => {
      try {
        const client = createPublicClient({ chain: VIEM_CHAINS[net.chainId], transport: http(rpcUrlFor(net.chainId) ?? DEFAULT_RPC[net.chainId]) })
        // Bound each chain so one slow/rate-limited public RPC can't hang the whole
        // wallet read — it degrades to an error row instead. [robustness]
        const [nativeWei, tokenBalances] = await withTimeout(
          Promise.all([
            client.getBalance({ address: address as Hex }),
            client.multicall({
              contracts: net.tokens.map((t) => ({ address: t.address as Hex, abi: erc20Abi, functionName: 'balanceOf' as const, args: [address as Hex] })),
              allowFailure: true,
            }),
          ]),
          12_000,
          net.name,
        )
        // Always emit the native row for a chain we read successfully — even at a 0
        // balance — so every integrated EVM network shows in the wallet view. [comprehensive]
        raws.push({ netId: net.id, netName: net.name, color: net.color, symbol: net.native.symbol, name: net.native.symbol, cg: net.native.cg, kind: 'native', balance: Number(nativeWei) / 1e18 })
        net.tokens.forEach((t, i) => {
          const r = tokenBalances[i]
          if (r.status === 'success' && typeof r.result === 'bigint' && r.result > 0n)
            raws.push({ netId: net.id, netName: net.name, color: net.color, symbol: t.symbol, name: t.name, cg: t.cg, kind: 'token', balance: Number(r.result) / 10 ** t.decimals })
        })
      } catch (e) {
        errors.push(`${net.name}: ${e instanceof Error ? e.message.slice(0, 80) : 'read failed'}`)
      }
    }),
  )

  return priceAndAggregate(address, raws, errors)
}

/** Native SOL + curated SPL-token balances for a Solana address. */
async function readSolana(address: string): Promise<Portfolio> {
  const net = networkById('solana')
  if (!net) return { address, totalUsd: 0, holdings: [], byNetwork: [], errors: ['Solana network not configured'] }
  const errors: string[] = []
  const raws: Raw[] = []
  // Curated mints we know how to price (the network's token list + its USDT mint).
  const byMint = new Map(net.tokens.map((t) => [t.address, t]))
  if (net.usdt.address) byMint.set(net.usdt.address, { symbol: net.usdt.symbol, name: 'Tether USD', cg: net.usdt.cg, address: net.usdt.address, decimals: net.usdt.decimals })

  try {
    const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed')
    const owner = new PublicKey(address)
    const [lamports, tokenAccounts] = await withTimeout(
      Promise.all([conn.getBalance(owner, 'confirmed'), conn.getParsedTokenAccountsByOwner(owner, { programId: SPL_TOKEN_PROGRAM }, 'confirmed')]),
      12_000,
      'Solana RPC',
    )
    // Always emit native SOL (even at 0) so Solana shows in the wallet view. [comprehensive]
    raws.push({ netId: net.id, netName: net.name, color: net.color, symbol: net.native.symbol, name: net.native.symbol, cg: net.native.cg, kind: 'native', balance: lamports / 1e9 })
    // Sum balances per mint (a wallet can hold several accounts of the same mint).
    const perMint = new Map<string, number>()
    for (const { account } of tokenAccounts.value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number } } } }).parsed?.info
      const mint = info?.mint
      const amt = info?.tokenAmount?.uiAmount
      if (mint && byMint.has(mint) && typeof amt === 'number' && amt > 0) perMint.set(mint, (perMint.get(mint) ?? 0) + amt)
    }
    for (const [mint, balance] of perMint) {
      const t = byMint.get(mint)!
      raws.push({ netId: net.id, netName: net.name, color: net.color, symbol: t.symbol, name: t.name, cg: t.cg, kind: 'token', balance })
    }
  } catch (e) {
    errors.push(`Solana: ${e instanceof Error ? e.message.slice(0, 80) : 'read failed'}`)
  }

  return priceAndAggregate(address, raws, errors)
}

/** Native ICP + curated ICRC-1 token balances (ckBTC, ckUSDT) for an IC principal,
 *  read straight from the ledger canisters via `icrc1_balance_of` over the public IC
 *  gateway. No identity needed — balance queries are anonymous. @dfinity is dynamically
 *  imported so the SDK stays out of the EVM/Solana hot path. */
async function readIcp(principal: string): Promise<Portfolio> {
  const net = networkById('icp')
  if (!net) return { address: principal, totalUsd: 0, holdings: [], byNetwork: [], errors: ['ICP network not configured'] }
  const errors: string[] = []
  const raws: Raw[] = []

  // Ledgers to read: native ICP (the network's native holding) + the curated ICRC
  // tokens (ckBTC) + the ckUSDT stable — each an ICRC-1 ledger canister. ICP is
  // listed in net.tokens (for pricing) but surfaced here as the single native row,
  // so it isn't double-counted.
  const ledgers: { canister: string; symbol: string; name: string; cg: string; decimals: number; kind: 'native' | 'token' }[] = []
  const icpLedger = net.tokens.find((t) => t.symbol === 'ICP')
  if (icpLedger) ledgers.push({ canister: icpLedger.address, symbol: net.native.symbol, name: 'Internet Computer', cg: net.native.cg, decimals: icpLedger.decimals, kind: 'native' })
  for (const t of net.tokens) if (t.symbol !== 'ICP') ledgers.push({ canister: t.address, symbol: t.symbol, name: t.name, cg: t.cg, decimals: t.decimals, kind: 'token' })
  if (net.usdt.address) ledgers.push({ canister: net.usdt.address, symbol: net.usdt.symbol, name: 'Tether USD', cg: net.usdt.cg, decimals: net.usdt.decimals, kind: 'token' })

  try {
    const { HttpAgent, Actor } = await import('@dfinity/agent')
    const { Principal } = await import('@dfinity/principal')
    const owner = Principal.fromText(principal)
    const agent = await HttpAgent.create({ host: process.env.ICP_GATEWAY_URL || 'https://icp-api.io' })
    // Minimal ICRC-1 interface — only the balance query we use. The factory receives
    // the candid `IDL` module from createActor (typed `any`, the dfinity convention).
    const idl = ({ IDL }: { IDL: any }) => {
      const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })
      return IDL.Service({ icrc1_balance_of: IDL.Func([Account], [IDL.Nat], ['query']) })
    }

    await Promise.all(
      ledgers.map(async (l) => {
        try {
          const actor = Actor.createActor(idl, { agent, canisterId: l.canister })
          const bal = (await withTimeout(actor.icrc1_balance_of({ owner, subaccount: [] }) as Promise<bigint>, 12_000, `ICP ${l.symbol}`))
          const balance = Number(bal) / 10 ** l.decimals
          // Native ICP always shows (even at 0) so the network appears; curated tokens
          // only when actually held, to avoid listing every ck-token at $0. [comprehensive]
          if (l.kind === 'native' || balance > 0) raws.push({ netId: net.id, netName: net.name, color: net.color, symbol: l.symbol, name: l.name, cg: l.cg, kind: l.kind, balance })
        } catch (e) {
          errors.push(`ICP ${l.symbol}: ${e instanceof Error ? e.message.slice(0, 80) : 'read failed'}`)
        }
      }),
    )
  } catch (e) {
    errors.push(`ICP: ${e instanceof Error ? e.message.slice(0, 80) : 'read failed'}`)
  }

  return priceAndAggregate(principal, raws, errors)
}

/** Detect the address ecosystem and read the matching balances, with a short-lived
 *  cache + stale-fallback so a rate-limited RPC degrades to recent balances instead
 *  of an empty wallet. `force` bypasses the fresh cache (the Refresh button). */
export async function readPortfolio(address: string, force = false): Promise<Portfolio | { error: string }> {
  const addr = (address ?? '').trim()
  let read: (() => Promise<Portfolio>) | null = null
  if (isAddress(addr)) read = () => readEvm(addr)
  else if (SOL_ADDR.test(addr)) {
    // base58 length overlaps some other formats — confirm it's a real Solana pubkey.
    try {
      // eslint-disable-next-line no-new
      new PublicKey(addr)
    } catch {
      return { error: 'not a recognized address (expects an EVM 0x… or a Solana address)' }
    }
    read = () => readSolana(addr)
  } else if (ICP_PRINCIPAL.test(addr)) read = () => readIcp(addr)
  else return { error: 'not a recognized address — expects an EVM 0x…, a Solana address, or an ICP principal' }

  const cached = portCache.get(addr)
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return cached.data

  const data = await read()
  // A fully-clean read becomes the new good baseline.
  if (data.errors.length === 0) {
    portCache.set(addr, { at: Date.now(), data })
    return data
  }
  // Failed / partial read: a recent good cache beats showing nothing.
  if (cached && Date.now() - cached.at < STALE_FALLBACK_MS)
    return { ...cached.data, errors: [...new Set([...data.errors, 'showing recently-cached balances — a live read was rate-limited; Refresh to retry'])] }
  return data
}
