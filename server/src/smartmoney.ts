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

// Permanent watchlist of publicly documented "smart money" wallets — entities
// tagged on Etherscan/Arkham with long, public track records (market makers,
// well-known traders, founders). Tracking them is informational, NOT an
// endorsement: smart money is sometimes wrong, and exchange wallets mix many
// users' flow. Users can add/remove their own wallets on top.
const SEED_WALLETS: TrackedWallet[] = [
  { address: '0x020Ca66C30beC2c4Fe3861a94E4DB4A498A35872', label: 'machibigbrother.eth (trader/collector)', addedAt: 0 },
  { address: '0xdBF5E9c5206d0dB70a90108bf936DA60221dC080', label: 'Wintermute (market maker)', addedAt: 0 },
  { address: '0xdDAcAd3B1eDeE8E2F5b2E84F658202534fcb0374', label: 'DWF Labs (market maker)', addedAt: 0 },
  { address: '0xd85351181b3F264ee0FDFa94518464d7c3DefaDa', label: 'James Fickel (ETH whale)', addedAt: 0 },
  { address: '0x1c37FCbD2EC4Cc71cfA991681cf146346f9B8994', label: 'gcr.eth (trader)', addedAt: 0 },
  { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', label: 'vitalik.eth', addedAt: 0 },
  { address: '0x28C6c06298d514Db089934071355E5743bf21d60', label: 'Binance 14 (exchange flow)', addedAt: 0 },
]

/** Merge any missing permanent seeds into the user's watchlist (idempotent). */
export function ensureSeeded() {
  if (!state.wallets) state.wallets = []
  const have = new Set(state.wallets.map((w) => w.address.toLowerCase()))
  let added = false
  for (const w of SEED_WALLETS) {
    if (!have.has(w.address.toLowerCase())) {
      state.wallets.push({ ...w })
      added = true
    }
  }
  if (added) save()
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
export async function smartMoneyFeed(network: string): Promise<{ events: SmartMoneyEvent[]; needsKey: boolean; unsupported?: boolean }> {
  ensureSeeded()
  const net = networkById(network)
  if (!net) return { events: [], needsKey: !trackingReady() }
  if (!net.evm) return { events: [], needsKey: false, unsupported: true } // Etherscan is EVM-only
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
  if (!net || !net.evm || !tok || !trackingReady()) return null
  const rows = await fetchTransfers(net.chainId, wallet)
  if (!rows) return null
  const w = state.wallets.find((x) => x.address.toLowerCase() === wallet.toLowerCase())
  const events = mapTransfers(network, wallet, w?.label ?? wallet, rows, spot)
  return latestActionForToken(events, token)
}

export const tokensForCopyTrade = () =>
  NETWORKS.filter((n) => n.evm).map((n) => ({ network: n.id, name: n.name, tokens: n.tokens.map((t) => t.symbol) }))

// ── Per-wallet account profile (detail tab) ──────────────────────────────────

export interface WalletTokenStat {
  network: string
  token: string
  buys: number
  sells: number
  volumeUsd: number
  netFlowUsd: number // buys − sells (USD value, where priced)
  lastTs: number
}

export interface WalletStats {
  trades: number
  buys: number
  sells: number
  volumeUsd: number
  netFlowUsd: number
  firstTs: number | null
  lastTs: number | null
  tokens: WalletTokenStat[] // sorted by volume desc
  /** Cumulative net flow over time (oldest→newest) — the account chart. */
  series: { t: number; v: number }[]
}

/** Pure aggregation of a wallet's events into account-level stats. */
export function computeWalletStats(events: SmartMoneyEvent[]): WalletStats {
  const asc = [...events].sort((a, b) => a.ts - b.ts)
  const byTok = new Map<string, WalletTokenStat>()
  let buys = 0
  let sells = 0
  let volume = 0
  let net = 0
  const series: { t: number; v: number }[] = []
  for (const e of asc) {
    const usd = e.usd ?? 0
    if (e.side === 'buy') {
      buys++
      net += usd
    } else {
      sells++
      net -= usd
    }
    volume += usd
    series.push({ t: e.ts, v: +net.toFixed(2) })
    const key = `${e.network}:${e.token}`
    const t = byTok.get(key) ?? { network: e.network, token: e.token, buys: 0, sells: 0, volumeUsd: 0, netFlowUsd: 0, lastTs: 0 }
    if (e.side === 'buy') {
      t.buys++
      t.netFlowUsd += usd
    } else {
      t.sells++
      t.netFlowUsd -= usd
    }
    t.volumeUsd += usd
    t.lastTs = Math.max(t.lastTs, e.ts)
    byTok.set(key, t)
  }
  const tokens = [...byTok.values()]
    .map((t) => ({ ...t, volumeUsd: +t.volumeUsd.toFixed(2), netFlowUsd: +t.netFlowUsd.toFixed(2) }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
  return {
    trades: asc.length,
    buys,
    sells,
    volumeUsd: +volume.toFixed(2),
    netFlowUsd: +net.toFixed(2),
    firstTs: asc[0]?.ts ?? null,
    lastTs: asc[asc.length - 1]?.ts ?? null,
    tokens,
    series,
  }
}

/** A tracked wallet's curated-token activity across every EVM network. */
export async function walletEvents(address: string): Promise<SmartMoneyEvent[]> {
  ensureSeeded()
  if (!trackingReady()) return []
  const label = state.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())?.label ?? `${address.slice(0, 6)}…${address.slice(-4)}`
  const all: SmartMoneyEvent[] = []
  for (const net of NETWORKS.filter((n) => n.evm)) {
    const rows = await fetchTransfers(net.chainId, address)
    if (rows) all.push(...mapTransfers(net.id, address, label, rows, spot))
  }
  return all.sort((a, b) => b.ts - a.ts)
}

export async function walletProfile(address: string): Promise<{
  wallet: string
  label: string
  tracking: boolean
  events: SmartMoneyEvent[]
  stats: WalletStats
}> {
  ensureSeeded()
  const label = state.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())?.label ?? `${address.slice(0, 6)}…${address.slice(-4)}`
  const events = await walletEvents(address)
  return { wallet: address, label, tracking: trackingReady(), events: events.slice(0, 200), stats: computeWalletStats(events) }
}

/** Recent BUY events (for the auto-follow engine). */
export async function walletRecentBuys(address: string, sinceTs: number): Promise<SmartMoneyEvent[]> {
  const events = await walletEvents(address)
  return events.filter((e) => e.side === 'buy' && e.ts > sinceTs)
}
