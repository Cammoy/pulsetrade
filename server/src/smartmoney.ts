// Smart-money wallet tracking + copy-trade signals.
//
// Watches a list of wallets and surfaces their recent BUYS and SELLS of the
// curated tokens we can price, via the Etherscan V2 multichain API (one key,
// every supported chain). Copy-trade bots mirror a wallet's flow in one token.
//
// Live tracking needs ETHERSCAN_API_KEY; without it the watchlist and UI still
// work and the feed clearly reports that a key is required. The signal-mapping
// core (mapTransfers / latestActionForToken) is pure and unit-tested.

import { state, save, type TrackedWallet } from './store.js'
import { networkById, tokenOf, NETWORKS } from './networks.js'
import { spot } from './prices.js'

export const trackingReady = () => Boolean(process.env.ETHERSCAN_API_KEY)

const ADDR = /^0x[a-fA-F0-9]{40}$/

// A few well-known wallets to demonstrate the feature. Users should add their
// own wallets they trust — these are examples, not trade recommendations.
const SEED_WALLETS: TrackedWallet[] = [
  { address: '0x28C6c06298d514Db089934071355E5743bf21d60', label: 'Binance 14 (example)', addedAt: 0 },
  { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', label: 'vitalik.eth (example)', addedAt: 0 },
]

export function ensureSeeded() {
  if (!state.wallets) state.wallets = []
  if (state.wallets.length === 0) state.wallets = SEED_WALLETS.map((w) => ({ ...w }))
}

export function listWallets(): TrackedWallet[] {
  ensureSeeded()
  return state.wallets
}

export function addWallet(address: string, label: string): TrackedWallet | { error: string } {
  ensureSeeded()
  if (!ADDR.test(address)) return { error: 'invalid wallet address' }
  const a = address.toLowerCase()
  if (state.wallets.some((w) => w.address.toLowerCase() === a)) return { error: 'wallet already tracked' }
  const w: TrackedWallet = { address, label: label?.trim() || `${address.slice(0, 6)}…${address.slice(-4)}`, addedAt: Date.now() }
  state.wallets.push(w)
  save()
  return w
}

export function removeWallet(address: string): boolean {
  ensureSeeded()
  const a = address.toLowerCase()
  const before = state.wallets.length
  state.wallets = state.wallets.filter((w) => w.address.toLowerCase() !== a)
  if (state.wallets.length !== before) {
    save()
    return true
  }
  return false
}

// ── Transfer fetching ────────────────────────────────────────────────────────

interface RawTransfer {
  contractAddress: string
  from: string
  to: string
  value: string
  tokenDecimal: string
  timeStamp: string
  hash: string
}

const txCache = new Map<string, { at: number; rows: RawTransfer[] }>()
const TX_TTL = 60_000

async function fetchTransfers(chainId: number, wallet: string): Promise<RawTransfer[] | null> {
  if (!trackingReady()) return null
  const key = `${chainId}:${wallet.toLowerCase()}`
  const hit = txCache.get(key)
  if (hit && Date.now() - hit.at < TX_TTL) return hit.rows
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&address=${wallet}&page=1&offset=100&sort=desc&apikey=${process.env.ETHERSCAN_API_KEY}`
  try {
    const res = await fetch(url)
    if (!res.ok) return hit?.rows ?? null
    const data: any = await res.json()
    const rows: RawTransfer[] = Array.isArray(data?.result) ? data.result : []
    txCache.set(key, { at: Date.now(), rows })
    return rows
  } catch {
    return hit?.rows ?? null
  }
}

export interface SmartMoneyEvent {
  wallet: string
  label: string
  network: string
  token: string
  tokenAddress: string
  side: 'buy' | 'sell'
  qty: number
  usd: number | null
  ts: number
  txHash: string
}

/**
 * Pure mapping of a wallet's raw transfers → buy/sell events for the curated
 * tokens on one network. A transfer INTO the wallet is a buy; OUT is a sell.
 */
export function mapTransfers(
  network: string,
  wallet: string,
  label: string,
  rows: RawTransfer[],
  priceOf: (cg: string) => number | undefined,
): SmartMoneyEvent[] {
  const net = networkById(network)
  if (!net) return []
  const w = wallet.toLowerCase()
  const byAddr = new Map(net.tokens.map((t) => [t.address.toLowerCase(), t]))
  const out: SmartMoneyEvent[] = []
  for (const r of rows) {
    const tok = byAddr.get(String(r.contractAddress).toLowerCase())
    if (!tok) continue
    const to = String(r.to).toLowerCase()
    const from = String(r.from).toLowerCase()
    if (to !== w && from !== w) continue
    const side: 'buy' | 'sell' = to === w ? 'buy' : 'sell'
    const decimals = Number(r.tokenDecimal) || tok.decimals
    const qty = Number(r.value) / 10 ** decimals
    if (!Number.isFinite(qty) || qty <= 0) continue
    const px = priceOf(tok.cg)
    out.push({
      wallet, label, network: net.id, token: tok.symbol, tokenAddress: tok.address,
      side, qty, usd: px ? +(qty * px).toFixed(2) : null,
      ts: Number(r.timeStamp) * 1000, txHash: r.hash,
    })
  }
  return out
}

/** The most recent buy/sell of one token by one wallet (pure). */
export function latestActionForToken(events: SmartMoneyEvent[], token: string): SmartMoneyEvent | null {
  let best: SmartMoneyEvent | null = null
  for (const e of events) {
    if (e.token === token && (!best || e.ts > best.ts)) best = e
  }
  return best
}

// ── Public feed + per-bot signal ─────────────────────────────────────────────

const feedCache = new Map<string, { at: number; events: SmartMoneyEvent[] }>()

/** Recent smart-money activity across all tracked wallets on a network. */
export async function smartMoneyFeed(network: string): Promise<{ events: SmartMoneyEvent[]; needsKey: boolean }> {
  ensureSeeded()
  const net = networkById(network)
  if (!net) return { events: [], needsKey: !trackingReady() }
  if (!trackingReady()) return { events: [], needsKey: true }
  const hit = feedCache.get(network)
  if (hit && Date.now() - hit.at < TX_TTL) return { events: hit.events, needsKey: false }

  const all: SmartMoneyEvent[] = []
  for (const w of state.wallets) {
    const rows = await fetchTransfers(net.chainId, w.address)
    if (rows) all.push(...mapTransfers(network, w.address, w.label, rows, spot))
  }
  all.sort((a, b) => b.ts - a.ts)
  const events = all.slice(0, 100)
  feedCache.set(network, { at: Date.now(), events })
  return { events, needsKey: false }
}

/** Latest action for a (wallet, network, token) — drives copy-trade bots. */
export async function walletTokenSignal(network: string, wallet: string, token: string): Promise<SmartMoneyEvent | null> {
  const net = networkById(network)
  const tok = net && tokenOf(network, token)
  if (!net || !tok || !trackingReady()) return null
  const rows = await fetchTransfers(net.chainId, wallet)
  if (!rows) return null
  const w = state.wallets.find((x) => x.address.toLowerCase() === wallet.toLowerCase())
  const events = mapTransfers(network, wallet, w?.label ?? wallet, rows, spot)
  return latestActionForToken(events, token)
}

export const tokensForCopyTrade = () =>
  NETWORKS.map((n) => ({ network: n.id, name: n.name, tokens: n.tokens.map((t) => t.symbol) }))
