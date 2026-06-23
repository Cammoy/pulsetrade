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
import { spot, getSpotPrices, tokenLiquidityUsd } from './prices.js'
import { ttlCache } from './ttl-cache.js'

export const trackingReady = () => Boolean(process.env.ETHERSCAN_API_KEY)

// Ethereum-mainnet majors (canonical contract addresses), so a tracked wallet's
// biggest, most-relevant holdings get a USD value & feed the allocation chart.
// Tracking-only (mainnet isn't tradeable here), so these stay non-curated.
const MAINNET_PRICED: Record<string, { symbol: string; cg: string; decimals: number }> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', cg: 'weth', decimals: 18 },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', cg: 'wrapped-bitcoin', decimals: 8 },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', cg: 'usd-coin', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', cg: 'tether', decimals: 6 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', cg: 'dai', decimals: 18 },
  '0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', cg: 'chainlink', decimals: 18 },
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', cg: 'uniswap', decimals: 18 },
  '0x6982508145454ce325ddbe47a25d4ec3d2311933': { symbol: 'PEPE', cg: 'pepe', decimals: 18 },
  '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': { symbol: 'SHIB', cg: 'shiba-inu', decimals: 18 },
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { symbol: 'AAVE', cg: 'aave', decimals: 18 },
  '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': { symbol: 'MKR', cg: 'maker', decimals: 18 },
  '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72': { symbol: 'ENS', cg: 'ethereum-name-service', decimals: 18 },
  '0x5a98fcbea516cf06857215779fd812ca3bef1b32': { symbol: 'LDO', cg: 'lido-dao', decimals: 18 },
  '0xd533a949740bb3306d119cc777fa900ba034cd52': { symbol: 'CRV', cg: 'curve-dao-token', decimals: 18 },
}
/** CoinGecko ids for the mainnet majors — fed into the engine's price tick so
 *  they're cached (spotCache persists), surviving CoinGecko backoff windows. */
export const MAINNET_CG_IDS = [...new Set(Object.values(MAINNET_PRICED).map((t) => t.cg))]

/** Blue-chip / wrapped-native symbols (across all chains) that must never show up
 *  in the "new coins" radar — they are majors, not emerging plays. Symbol-based so
 *  it works on every L2 regardless of the per-chain contract address. */
export const KNOWN_MAJOR_SYMBOLS = new Set([
  'WETH', 'ETH', 'WBTC', 'BTC', 'WSTETH', 'STETH', 'RETH', 'CBETH', 'WEETH', 'EETH', 'FRXETH', 'SFRXETH',
  'LINK', 'UNI', 'PEPE', 'SHIB', 'AAVE', 'MKR', 'ENS', 'LDO', 'CRV', 'COMP', 'SNX', 'SUSHI', 'GRT', 'MANA', 'SAND',
  'ARB', 'OP', 'MATIC', 'WMATIC', 'POL', 'WBNB', 'BNB', 'GMX', 'AVAX', 'WAVAX', 'SOL', 'WSOL', 'JUP',
])

// Stablecoins — parking cash in a stable is not a directional "accumulation" signal.
const STABLE_SYMBOLS = new Set([
  'USDC', 'USDT', 'DAI', 'USDS', 'USDE', 'FRAX', 'TUSD', 'USDD', 'PYUSD', 'GUSD', 'LUSD',
  'USD1', 'FDUSD', 'USDT0', 'SUSD', 'CRVUSD', 'SDAI', 'USDL', 'USDX', 'BUSD',
])
/** A token that is NOT a smart-money "accumulation" signal: wrapped-native + blue-chip
 *  majors (WETH, WBTC, stETH, …) and stablecoins. A whale holding WETH or parking in USDC
 *  is noise, not a play — these are excluded from the consensus / accumulation signals
 *  (the raw activity feed still shows them). [accum-filter] */
const isSignalToken = (symbol: string): boolean => {
  const s = symbol.toUpperCase()
  return !KNOWN_MAJOR_SYMBOLS.has(s) && !STABLE_SYMBOLS.has(s)
}
/** A token not traded by ANY tracked wallet in this long is dead/abandoned (rugged tokens
 *  stop trading once liquidity is pulled) — drop it from the accumulation signals so the
 *  view shows live conviction, not stale bags. [stale-filter] */
const STALE_ACCUM_MS = 90 * 86_400_000 // ~3 months
/** A token whose total DEX liquidity is below this is effectively dead/rugged — untradeable,
 *  so it's dropped from every smart-money signal regardless of recency. [liquidity-filter] */
export const MIN_LIVE_LIQUIDITY_USD = 1_000

/**
 * Pure: is a token DEAD for smart-money purposes? Two independent conditions (either drops it):
 *   • no tracked activity in ~3 months (rugged tokens stop trading), and/or
 *   • a CONFIRMED near-zero DEX pool (liquidity removed).
 * `liquidityUsd === null` means "unknown" — never a reason to drop (we only drop on a
 * confirmed-low reserve). Omit `lastTs` to skip the staleness leg (e.g. consensus rows that
 * were already recency-filtered upstream). [stale-filter + liquidity-filter]
 */
export function isDeadToken(opts: { lastTs?: number; liquidityUsd: number | null }, now = Date.now()): boolean {
  if (opts.lastTs !== undefined && now - opts.lastTs > STALE_ACCUM_MS) return true
  if (opts.liquidityUsd !== null && opts.liquidityUsd < MIN_LIVE_LIQUIDITY_USD) return true
  return false
}

/** Drop tokens whose CURRENT on-chain DEX liquidity is confirmed near-zero (rugged). Bounded
 *  concurrency + a 30-min cache keep the GeckoTerminal budget sane; unknown/unreadable
 *  liquidity is KEPT (never a false drop). Order-preserving. Works for any row carrying a
 *  network + tokenAddress (per-wallet holdings AND consensus rows). [liquidity-filter] */
export async function dropRuggedTokens<T extends { network: string; tokenAddress: string }>(items: T[], now: number = Date.now()): Promise<T[]> {
  const dead = new Set<string>()
  let i = 0
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++]
      const net = networkById(it.network)
      const liq = net ? await tokenLiquidityUsd(net.gt, it.tokenAddress).catch(() => null) : null
      if (isDeadToken({ liquidityUsd: liq }, now)) dead.add(`${it.network}:${it.tokenAddress.toLowerCase()}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
  return items.filter((it) => !dead.has(`${it.network}:${it.tokenAddress.toLowerCase()}`))
}

const ADDR = /^0x[a-fA-F0-9]{40}$/

// Curated watchlist of well-documented "smart money" INDIVIDUALS — each address
// confirmed against its live Etherscan public name tag / ENS (June 2026), chosen
// for a public, directional track record that's actually useful to follow. We
// deliberately exclude exchange hot wallets and market makers (Binance, Wintermute,
// DWF): they mix many users' flow and are bad to copy. Tracking is informational,
// NOT an endorsement — smart money is sometimes very wrong. Users add their own on
// top. Re-validate quarterly: tagged wallets can go cold as figures rotate to fresh
// addresses to avoid being front-run.
const SEED_WALLETS: TrackedWallet[] = [
  { address: '0x398d282487b44b6e53Ce0AebcA3CB60C3B6325E9', label: 'GCR (gcr.eth)', note: 'Legendary macro/directional trader — famously shorted LUNA vs Do Kwon', category: 'trader', addedAt: 0 },
  { address: '0x8E1D8B147cC4C939a597dC501C47cC8B4ab26BD5', label: 'Tetranode', note: 'One of the best-known blue-chip DeFi whales', category: 'whale', addedAt: 0 },
  { address: '0x67c0fc4b0490Ab7E76C08C2bbD30fAC0059bbc7a', label: 'Andrew Kang (rewkang.eth)', note: 'Mechanism Capital — high-conviction macro/directional bets', category: 'trader', addedAt: 0 },
  { address: '0x020Ca66C30beC2c4Fe3861a94E4DB4A498A35872', label: 'Machi Big Brother (machibigbrother.eth)', note: 'Jeff Huang — extremely active token & NFT trader across chains', category: 'trader', addedAt: 0 },
  { address: '0x534a0076Fb7C2b1f83Fa21497429Ad7Ad3bd7587', label: 'Arthur Hayes', note: 'BitMEX co-founder — documented altcoin & ETH positioning', category: 'public-figure', addedAt: 0 },
  { address: '0x2eB5e5713A874786af6Da95f6E4DEaCEdb5dC246', label: 'Cobie (maniac.eth)', note: 'Veteran trader & UpOnly host with a long on-chain history', category: 'trader', addedAt: 0 },
  { address: '0x0Ddf9bAe2aF4B874B96D287a5aD42Eb47138A902', label: 'pension-usdt.eth', note: 'Lookonchain-tracked ETH whale (~$14M/30d on ETH) — verify it is still active', category: 'whale', addedAt: 0 },
  { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', label: 'Vitalik Buterin (vitalik.eth)', note: 'Most-watched address on Ethereum — mostly holdings & donations, not active trading', category: 'public-figure', addedAt: 0 },
  // ── Added 2026-06-20: individual traders, each verified against an Etherscan public
  // name-tag or ENS reverse-record (not just a search snippet). Conflicting/unconfirmed
  // candidates (James Wynn, Hayden Adams, Erik Voorhees) were deliberately NOT added —
  // a wrong address is worse than fewer entries. Re-validate before live copy-trading.
  { address: '0x3DdfA8eC3052539b6C9549F12cEA2C295cfF5296', label: 'Justin Sun', note: 'TRON founder — very active multi-chain mover (Etherscan name-tagged)', category: 'public-figure', addedAt: 0 },
  { address: '0x42f9134E9d3bf7eEE1f8A5Ac2a4328B059E7468c', label: 'Kain Warwick (kain.eth)', note: 'Synthetix / Infinex founder — long-running active DeFi wallet', category: 'public-figure', addedAt: 0 },
  { address: '0x648aA14e4424e0825A5cE739C8c68610e143FB79', label: 'Sassal (sassal.eth)', note: 'The Daily Gwei — ETH educator; active personal DeFi wallet', category: 'public-figure', addedAt: 0 },
  { address: '0x54BE3a794282C030b15E43aE2bB182E14c409C5e', label: 'dingaling (dingaling.eth)', note: 'Active degen trader — 1inch swaps + Aave borrow/repay on-chain', category: 'trader', addedAt: 0 },
  { address: '0x2E21f5d32841cf8C7da805185A041400bF15f21A', label: 'Stani Kulechov (stani.eth)', note: 'Aave founder — Lookonchain-tracked ETH sells; verify it stays active', category: 'public-figure', addedAt: 0 },
]

/**
 * Reconcile the watchlist with the curated seeds (idempotent). Seeds use
 * addedAt:0; user-added wallets use a real timestamp. So we can safely PRUNE
 * deprecated seeds (e.g. the old exchange/MM wallets) without touching anything
 * the user added, add any new seeds, and refresh seed metadata (label/note).
 */
export function ensureSeeded() {
  if (!state.wallets) state.wallets = []
  const seedByAddr = new Map(SEED_WALLETS.map((w) => [w.address.toLowerCase(), w]))
  let changed = false

  // Drop stale seeds (addedAt:0 and no longer curated); keep all user-added.
  const before = state.wallets.length
  state.wallets = state.wallets.filter((w) => w.addedAt !== 0 || seedByAddr.has(w.address.toLowerCase()))
  if (state.wallets.length !== before) changed = true

  // Refresh metadata on existing seeds + collect which addresses we already have.
  const have = new Set<string>()
  for (const w of state.wallets) {
    const a = w.address.toLowerCase()
    have.add(a)
    const seed = seedByAddr.get(a)
    if (seed && w.addedAt === 0 && (w.label !== seed.label || w.note !== seed.note || w.category !== seed.category)) {
      w.label = seed.label
      w.note = seed.note
      w.category = seed.category
      changed = true
    }
  }

  // Add any missing seeds.
  for (const w of SEED_WALLETS) {
    if (!have.has(w.address.toLowerCase())) {
      state.wallets.push({ ...w })
      changed = true
    }
  }
  if (changed) save()
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
  tokenSymbol?: string
  tokenName?: string
  timeStamp: string
  hash: string
}

const TX_TTL = 60_000
const txCache = ttlCache<RawTransfer[]>(TX_TTL)

async function fetchTransfers(chainId: number, wallet: string): Promise<RawTransfer[] | null> {
  if (!trackingReady()) return null
  const key = `${chainId}:${wallet.toLowerCase()}`
  const fresh = txCache.fresh(key)
  if (fresh) return fresh
  // Pull a deep window so holdings (netted from history) are reasonably complete.
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&address=${wallet}&page=1&offset=1000&sort=desc&apikey=${process.env.ETHERSCAN_API_KEY}`
  try {
    const res = await fetch(url)
    if (!res.ok) return txCache.stale(key) ?? null
    const data: any = await res.json()
    const rows: RawTransfer[] = Array.isArray(data?.result) ? data.result : []
    return txCache.set(key, rows)
  } catch {
    return txCache.stale(key) ?? null
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
  curated: boolean // in our token list ⇒ priced & copy-tradeable
}

/**
 * Pure mapping of a wallet's raw transfers → buy/sell events. A transfer INTO
 * the wallet is a buy; OUT is a sell. By default only CURATED tokens are kept
 * (priced & copy-tradeable). With `allTokens`, EVERY ERC-20 the wallet moves is
 * included (curated ones priced, the rest with qty only) — used to build the
 * comprehensive holdings view.
 */
export function mapTransfers(
  network: string,
  wallet: string,
  label: string,
  rows: RawTransfer[],
  priceOf: (cg: string) => number | undefined,
  opts: { allTokens?: boolean } = {},
): SmartMoneyEvent[] {
  const net = networkById(network)
  // Curated mode needs a known network. allTokens mode also works for a
  // tracking-only chain (e.g. Ethereum mainnet) that has no curated token list.
  if (!net && !opts.allTokens) return []
  const w = wallet.toLowerCase()
  const byAddr = new Map((net?.tokens ?? []).map((t) => [t.address.toLowerCase(), t]))
  const out: SmartMoneyEvent[] = []
  for (const r of rows) {
    const addr = String(r.contractAddress).toLowerCase()
    const tok = byAddr.get(addr)
    // On mainnet (no curated list) price the known majors so big holdings value.
    const main = !tok && network === 'ethereum' ? MAINNET_PRICED[addr] : undefined
    if (!tok && !main && !opts.allTokens) continue
    const to = String(r.to).toLowerCase()
    const from = String(r.from).toLowerCase()
    // A self-transfer (wallet's own addresses / unwrap round-trip / router refund) is
    // net-zero — neither a buy nor a sell. Without this it survives the filter below
    // (to === w) and is mis-booked as a BUY, one-directionally inflating holdings,
    // consensus buyers, and net-flow. [self-transfer]
    if (to === from) continue
    if (to !== w && from !== w) continue
    const side: 'buy' | 'sell' = to === w ? 'buy' : 'sell'
    const decimals = Number(r.tokenDecimal) || tok?.decimals || main?.decimals || 18
    const qty = Number(r.value) / 10 ** decimals
    if (!Number.isFinite(qty) || qty <= 0) continue
    const symbol = tok?.symbol ?? main?.symbol ?? (r.tokenSymbol ? String(r.tokenSymbol).slice(0, 12) : 'TOKEN')
    const cg = tok?.cg ?? main?.cg
    const px = cg ? priceOf(cg) : undefined
    out.push({
      wallet, label, network: net?.id ?? network, token: symbol, tokenAddress: tok?.address ?? addr,
      side, qty, usd: px ? +(qty * px).toFixed(2) : null,
      ts: Number(r.timeStamp) * 1000, txHash: r.hash, curated: !!tok,
    })
  }
  return out
}

/** A wallet's current net holding of one token (derived from its activity). */
export interface Holding {
  network: string
  token: string
  tokenAddress: string
  qty: number // net units held (buys − sells over tracked history)
  usd: number | null // value where the token is priced
  curated: boolean
  buys: number
  sells: number
  lastTs: number
  /** Likely an airdropped scam token, not a real holding (received-only +
   *  spammy symbol). Surfaced separately so the holdings list stays useful. */
  suspicious: boolean
}

// Whale wallets are flooded with scam airdrops whose SYMBOL is the lure: a URL,
// a "claim/reward" call-to-action, or a unicode look-alike of a real ticker.
const SPAM_SYMBOL_RE = /https?:|www\.|\.(?:com|io|xyz|org|net|app|fi|vip|gift|live|cash|claim)\b|visit|claim|reward|airdrop|bonus|gift|t\.me|[^\x00-\x7F]/i
export function looksLikeSpamSymbol(symbol: string): boolean {
  return symbol.length > 12 || /\s/.test(symbol) || SPAM_SYMBOL_RE.test(symbol)
}

/**
 * Pure: a wallet's current holdings, netted per token from its buy/sell events
 * (an on-chain-activity estimate, not a balance call). Tokens netting to ~zero
 * are dropped. Each is flagged `suspicious` when it's an unpriced token that was
 * only RECEIVED (never sold) or has a scammy symbol — i.e. an airdrop, not a
 * real position. Sorted real-first, then by USD value, then recency.
 */
export function computeHoldings(events: SmartMoneyEvent[]): Holding[] {
  const byTok = new Map<string, { e: SmartMoneyEvent; qty: number; usdPerUnit: number | null; bestQty: number; lastTs: number; buys: number; sells: number }>()
  for (const e of events) {
    const key = `${e.network}:${e.tokenAddress.toLowerCase()}`
    const cur = byTok.get(key) ?? { e, qty: 0, usdPerUnit: null, bestQty: 0, lastTs: 0, buys: 0, sells: 0 }
    if (e.side === 'buy') {
      cur.qty += e.qty
      cur.buys++
    } else {
      cur.qty -= e.qty
      cur.sells++
    }
    // Unit price from the LARGEST-qty priced event: e.usd is rounded to cents, so
    // a tiny-qty event would round to $0 and zero out the whole position's value.
    if (e.usd !== null && e.qty > cur.bestQty) {
      cur.usdPerUnit = e.usd / e.qty
      cur.bestQty = e.qty
    }
    cur.lastTs = Math.max(cur.lastTs, e.ts)
    byTok.set(key, cur)
  }
  return [...byTok.values()]
    .filter((h) => h.qty > 1e-9)
    .map((h) => {
      const value = h.usdPerUnit !== null ? +(h.qty * h.usdPerUnit).toFixed(2) : null
      // Treat a value that rounds below a cent as unpriced (avoids a misleading $0).
      const usd = value !== null && value >= 0.01 ? value : null
      const priced = usd !== null
      // A priced or actively-traded token is a real position; an unpriced token
      // received once with a spammy symbol is an airdrop.
      const suspicious = !priced && (looksLikeSpamSymbol(h.e.token) || (h.buys <= 1 && h.sells === 0))
      return {
        network: h.e.network,
        token: h.e.token,
        tokenAddress: h.e.tokenAddress,
        qty: +h.qty.toFixed(6),
        usd,
        curated: h.e.curated,
        buys: h.buys,
        sells: h.sells,
        lastTs: h.lastTs,
        suspicious,
      }
    })
    .sort((a, b) => Number(a.suspicious) - Number(b.suspicious) || (b.usd ?? -1) - (a.usd ?? -1) || b.lastTs - a.lastTs)
}

/** A token multiple tracked wallets are trading — the "consensus" signal. */
export interface ConsensusRow {
  network: string
  token: string
  tokenAddress: string
  buyers: number // DISTINCT wallets buying — the real signal
  sellers: number
  buys: number
  sells: number
  netUsd: number // net smart-money flow (buys − sells, USD where priced)
  lastTs: number
}

/**
 * Aggregate recent activity into "what smart money is accumulating": per token,
 * how many DISTINCT tracked wallets are buying vs selling and the net USD flow.
 * Pure. The standout signal is several independent smart wallets buying the same
 * token — far more actionable than a raw activity list. Ranked by net inflow,
 * tokens with ≥1 net buyer first.
 */
export function smartMoneyConsensus(events: SmartMoneyEvent[], now = Date.now()): ConsensusRow[] {
  const agg = new Map<string, ConsensusRow & { buyerSet: Set<string>; sellerSet: Set<string> }>()
  for (const e of events) {
    if (!isSignalToken(e.token)) continue // no WETH / wrapped-native / stables in accumulation [accum-filter]
    if (now - e.ts > STALE_ACCUM_MS) continue // ignore activity older than the staleness window [stale-filter]
    const key = `${e.network}:${e.token}`
    const row =
      agg.get(key) ??
      { network: e.network, token: e.token, tokenAddress: e.tokenAddress, buyers: 0, sellers: 0, buys: 0, sells: 0, netUsd: 0, lastTs: 0, buyerSet: new Set<string>(), sellerSet: new Set<string>() }
    const w = e.wallet.toLowerCase()
    if (e.side === 'buy') {
      row.buys++
      row.buyerSet.add(w)
      row.netUsd += e.usd ?? 0
    } else {
      row.sells++
      row.sellerSet.add(w)
      row.netUsd -= e.usd ?? 0
    }
    row.lastTs = Math.max(row.lastTs, e.ts)
    agg.set(key, row)
  }
  return [...agg.values()]
    .map(({ buyerSet, sellerSet, ...r }) => ({ ...r, buyers: buyerSet.size, sellers: sellerSet.size, netUsd: +r.netUsd.toFixed(2) }))
    // Net buyers first, then by the number of independent buyers, then net USD.
    .sort((a, b) => b.buyers - b.sellers - (a.buyers - a.sellers) || b.buyers - a.buyers || b.netUsd - a.netUsd)
}

/** A token currently HELD by 2+ tracked whales — the "consensus holdings" signal
 *  (conviction positions, not just recent flow). */
export interface ConsensusHolding {
  network: string
  token: string
  tokenAddress: string
  holders: number // distinct whales currently holding it
  totalWallets: number // whales tracked, for an "N of M" read
  pctOfWhales: number // holders / totalWallets, 0–100
  wallets: { label: string; usd: number | null }[] // who holds it (largest first)
  totalUsd: number | null // combined value across holders, where priced
  curated: boolean
}

/**
 * Pure: reduce each wallet's holdings into tokens held by ≥2 wallets. Airdrop
 * spam is excluded (Holding.suspicious). Ranked by holder count, then value —
 * the tokens the most independent whales actually hold.
 */
export function consensusHoldings(perWallet: { label: string; holdings: Holding[] }[], now = Date.now()): ConsensusHolding[] {
  const totalWallets = perWallet.length
  const byTok = new Map<string, { network: string; token: string; tokenAddress: string; wallets: { label: string; usd: number | null }[]; totalUsd: number; anyPriced: boolean; curated: boolean }>()
  for (const { label, holdings } of perWallet) {
    for (const h of holdings) {
      if (h.suspicious) continue // skip airdrops — only real positions count
      if (!isSignalToken(h.token)) continue // no WETH / wrapped-native / stables in the accumulation signal [accum-filter]
      if (now - h.lastTs > STALE_ACCUM_MS) continue // drop dead/abandoned bags (no activity for months — rugged or illiquid) [stale-filter]
      const key = `${h.network}:${h.tokenAddress.toLowerCase()}`
      const cur = byTok.get(key) ?? { network: h.network, token: h.token, tokenAddress: h.tokenAddress, wallets: [], totalUsd: 0, anyPriced: false, curated: false }
      cur.wallets.push({ label, usd: h.usd })
      if (h.usd !== null) {
        cur.totalUsd += h.usd
        cur.anyPriced = true
      }
      cur.curated = cur.curated || h.curated
      byTok.set(key, cur)
    }
  }
  return [...byTok.values()]
    .filter((c) => c.wallets.length >= 2)
    .map((c) => ({
      network: c.network,
      token: c.token,
      tokenAddress: c.tokenAddress,
      holders: c.wallets.length,
      totalWallets,
      pctOfWhales: totalWallets ? Math.round((c.wallets.length / totalWallets) * 100) : 0,
      wallets: c.wallets.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1)).slice(0, 8),
      totalUsd: c.anyPriced ? +c.totalUsd.toFixed(2) : null,
      curated: c.curated,
    }))
    // Most-held first; then priced-with-value above unpriced obscure tokens; then
    // curated (known tradeable) above the long tail.
    .sort((a, b) => b.holders - a.holders || (b.totalUsd ?? -1) - (a.totalUsd ?? -1) || Number(b.curated) - Number(a.curated))
    .slice(0, 30)
}

let chCache: { at: number; data: ConsensusHolding[] } | null = null
const CH_TTL = 600_000 // 10 min — holdings shift slowly; eases the per-wallet Etherscan budget

/** Gather every tracked wallet's holdings and reduce to ≥2-whale consensus. Cached. */
export async function gatherConsensusHoldings(): Promise<{ holdings: ConsensusHolding[]; needsKey: boolean; totalWallets: number }> {
  ensureSeeded()
  const totalWallets = listWallets().length
  if (!trackingReady()) return { holdings: [], needsKey: true, totalWallets }
  if (chCache && Date.now() - chCache.at < CH_TTL) return { holdings: chCache.data, needsKey: false, totalWallets }
  const now = Date.now()
  const perWallet: { label: string; holdings: Holding[] }[] = []
  for (const w of listWallets()) {
    const events = await walletEvents(w.address, { allTokens: true }).catch(() => [])
    // Drop dead-by-recency bags up front (free); the liquidity check runs once on the ≤30 result.
    perWallet.push({ label: w.label, holdings: computeHoldings(events).filter((h) => !isDeadToken({ lastTs: h.lastTs, liquidityUsd: null }, now)) })
  }
  // Liquidity-prune the bounded consensus set so a rug-pulled (liquidity-removed) token never
  // surfaces as a "whale consensus" pick, even if it was traded recently. [liquidity-filter]
  const data = await dropRuggedTokens(consensusHoldings(perWallet, now), now)
  chCache = { at: Date.now(), data }
  return { holdings: data, needsKey: false, totalWallets }
}

/** The most recent buy/sell of one token by one wallet (pure). */
export function latestActionForToken(events: SmartMoneyEvent[], token: string): SmartMoneyEvent | null {
  let best: SmartMoneyEvent | null = null
  for (const e of events) {
    if (e.token === token && (!best || e.ts > best.ts)) best = e
  }
  return best
}

/** The most recent SELL of one token by one wallet (pure). Lets a holding mirror still
 *  exit when the wallet sold even if a NEWER same-token transfer (re-buy / inbound) followed. */
export function latestSellForToken(events: SmartMoneyEvent[], token: string): SmartMoneyEvent | null {
  let best: SmartMoneyEvent | null = null
  for (const e of events) {
    if (e.token === token && e.side === 'sell' && (!best || e.ts > best.ts)) best = e
  }
  return best
}

// ── Public feed + per-bot signal ─────────────────────────────────────────────

const feedCache = ttlCache<SmartMoneyEvent[]>(TX_TTL)

/** Recent smart-money activity + the consensus signal across tracked wallets. */
export async function smartMoneyFeed(network: string): Promise<{ events: SmartMoneyEvent[]; consensus: ConsensusRow[]; needsKey: boolean; unsupported?: boolean }> {
  ensureSeeded()
  const net = networkById(network)
  if (!net) return { events: [], consensus: [], needsKey: !trackingReady() }
  if (!net.evm) return { events: [], consensus: [], needsKey: false, unsupported: true } // Etherscan is EVM-only
  if (!trackingReady()) return { events: [], consensus: [], needsKey: true }
  const fresh = feedCache.fresh(network)
  if (fresh) return { events: fresh, consensus: smartMoneyConsensus(fresh), needsKey: false }

  const all: SmartMoneyEvent[] = []
  for (const w of state.wallets) {
    const rows = await fetchTransfers(net.chainId, w.address)
    if (rows) all.push(...mapTransfers(network, w.address, w.label, rows, spot))
  }
  all.sort((a, b) => b.ts - a.ts)
  const events = all.slice(0, 100)
  feedCache.set(network, events)
  return { events, consensus: smartMoneyConsensus(events), needsKey: false }
}

/** Latest action AND latest sell for a (wallet, network, token) — drives copy bots.
 *  Returning the sell separately lets a holding mirror exit when the wallet sold even
 *  if a newer same-token transfer (re-buy / inbound) followed it (one fetch). */
export async function walletCopySignal(
  network: string,
  wallet: string,
  token: string,
): Promise<{ latest: SmartMoneyEvent | null; latestSell: SmartMoneyEvent | null }> {
  const net = networkById(network)
  const tok = net && tokenOf(network, token)
  if (!net || !net.evm || !tok || !trackingReady()) return { latest: null, latestSell: null }
  const rows = await fetchTransfers(net.chainId, wallet)
  if (!rows) return { latest: null, latestSell: null }
  const w = state.wallets.find((x) => x.address.toLowerCase() === wallet.toLowerCase())
  const events = mapTransfers(network, wallet, w?.label ?? wallet, rows, spot)
  return { latest: latestActionForToken(events, token), latestSell: latestSellForToken(events, token) }
}

/** Latest action for a (wallet, network, token) — backward-compatible single-event accessor. */
export async function walletTokenSignal(network: string, wallet: string, token: string): Promise<SmartMoneyEvent | null> {
  return (await walletCopySignal(network, wallet, token)).latest
}

export const tokensForCopyTrade = () =>
  NETWORKS.filter((n) => n.evm && n.tradeable !== false).map((n) => ({ network: n.id, name: n.name, tokens: n.tokens.map((t) => t.symbol) }))

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

export interface WalletScore {
  score: number // 0-100 heuristic
  tier: 'proven' | 'promising' | 'unproven' | 'thin'
  realizedFlowUsd: number // approx cash extracted from round-tripped tokens (sells − buys)
  roundTrips: number // tokens with BOTH a buy and a sell (a closed/partly-closed position)
  recencyDays: number | null
  caveat: string
}

const SCORE_CAVEAT =
  'Heuristic from on-chain transfer FLOW (cash out − cash in on round-tripped tokens), NOT true realized PnL — it ignores still-held bags, unpriced transfers, fees, and off-chain context. A high score is a research starting point, not proof of skill or a guarantee.'

/** Score a tracked wallet's COPY-WORTHINESS from its transfer flow. Honest by construction:
 *  it rewards persistence (many round trips, not one lucky hit) + recency + a positive net
 *  realized FLOW, caps net-losers low, and carries a loud caveat that this is a flow proxy,
 *  not verified PnL. Copy-trading is a borrowed edge — only as good as the wallet you copy. */
export function computeWalletScore(stats: WalletStats, now = Date.now()): WalletScore {
  const roundTripTokens = stats.tokens.filter((t) => t.buys > 0 && t.sells > 0)
  const roundTrips = roundTripTokens.length
  // −netFlow = sells − buys: positive ⇒ extracted more cash than deployed on closed names.
  const realizedFlowUsd = +roundTripTokens.reduce((s, t) => s - t.netFlowUsd, 0).toFixed(2)
  const recencyDays = stats.lastTs ? +Math.max(0, (now - stats.lastTs) / 86_400_000).toFixed(1) : null
  if (stats.trades < 3 || roundTrips < 1 || recencyDays === null)
    return { score: 0, tier: 'thin', realizedFlowUsd, roundTrips, recencyDays, caveat: SCORE_CAVEAT }
  const profitable = realizedFlowUsd > 0
  const persistence = Math.min(1, roundTrips / 5) // ≥5 closed positions = full marks
  const recency = recencyDays <= 7 ? 1 : recencyDays <= 30 ? 0.6 : recencyDays <= 90 ? 0.3 : 0.1
  const diversity = Math.min(1, stats.tokens.length / 4)
  const magnitude = Math.min(1, Math.abs(realizedFlowUsd) / 10_000) // ~$10k extracted = full marks
  const raw = profitable
    ? 100 * (0.45 * persistence + 0.2 * recency + 0.15 * diversity + 0.2 * magnitude)
    : 100 * (0.1 * recency + 0.1 * diversity)
  const score = Math.round(profitable ? raw : Math.min(raw, 25)) // a net-loser can never score high
  const tier: WalletScore['tier'] =
    profitable && roundTrips >= 5 && recencyDays <= 30 ? 'proven' : profitable && roundTrips >= 2 ? 'promising' : 'unproven'
  return { score, tier, realizedFlowUsd, roundTrips, recencyDays, caveat: SCORE_CAVEAT }
}

// Chains scanned for a wallet's full activity/holdings. Ethereum MAINNET (chainId
// 1) is included read-only: it's where these whales actually operate, but it's
// not a tradeable network here (gas), so it carries no curated token list — its
// tokens show qty-only via allTokens mapping.
// Wallet tracking covers every EVM network incl. Ethereum mainnet (now a holdings-only
// entry in NETWORKS) — whales operate there, so it's tracked even though it isn't tradeable.
const TRACK_CHAINS: { id: string; chainId: number }[] = NETWORKS.filter((n) => n.evm).map((n) => ({ id: n.id, chainId: n.chainId }))

/** A tracked wallet's token activity across mainnet + every tradeable EVM chain.
 *  By default only curated tokens; with `allTokens` every ERC-20 (full view). */
export async function walletEvents(address: string, opts: { allTokens?: boolean } = {}): Promise<SmartMoneyEvent[]> {
  ensureSeeded()
  if (!trackingReady()) return []
  const label = state.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())?.label ?? `${address.slice(0, 6)}…${address.slice(-4)}`
  const all: SmartMoneyEvent[] = []
  for (const c of TRACK_CHAINS) {
    const rows = await fetchTransfers(c.chainId, address)
    if (rows) all.push(...mapTransfers(c.id, address, label, rows, spot, opts))
  }
  return all.sort((a, b) => b.ts - a.ts)
}

export async function walletProfile(address: string): Promise<{
  wallet: string
  label: string
  note?: string
  category?: string
  tracking: boolean
  events: SmartMoneyEvent[]
  holdings: Holding[]
  stats: WalletStats
  score: WalletScore
}> {
  ensureSeeded()
  const tracked = state.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())
  const label = tracked?.label ?? `${address.slice(0, 6)}…${address.slice(-4)}`
  // Warm the mainnet majors' prices (cached upstream) so big WETH/USDC/etc.
  // holdings get a USD value and feed the allocation chart.
  if (trackingReady()) await getSpotPrices(MAINNET_CG_IDS).catch(() => {})
  // Comprehensive view: include EVERY token the wallet trades (curated priced,
  // the rest qty-only) so holdings and activity are complete, not just curated.
  const events = await walletEvents(address, { allTokens: true })
  const stats = computeWalletStats(events)
  // Holdings shown in the profile drop DEAD bags: no activity in months (free) and, for the
  // top positions, a confirmed near-zero DEX pool (rug-pulled). Recency-survivors beyond the
  // liquidity-check cap are kept (recent activity ⇒ almost certainly still alive). [dead-token]
  const now = Date.now()
  const recent = computeHoldings(events).filter((h) => !isDeadToken({ lastTs: h.lastTs, liquidityUsd: null }, now))
  const holdings = [...(await dropRuggedTokens(recent.slice(0, 40), now)), ...recent.slice(40)]
  return {
    wallet: address,
    label,
    note: tracked?.note,
    category: tracked?.category,
    tracking: trackingReady(),
    events: events.slice(0, 200),
    holdings,
    stats,
    score: computeWalletScore(stats),
  }
}

/** Recent BUY events (for the auto-follow engine). */
export async function walletRecentBuys(address: string, sinceTs: number): Promise<SmartMoneyEvent[]> {
  const events = await walletEvents(address)
  return events.filter((e) => e.side === 'buy' && e.ts > sinceTs)
}

// ── Copy-worthiness leaderboard ──────────────────────────────────────────────
// Ranks EVERY tracked wallet by the same flow-based copy-worthiness score the wallet
// profile shows, so the Copy Trading hub can answer "who is worth copying?" up front.
// Reuses the pure stats/score functions; carries the same loud caveat (flow ≠ true PnL).

export interface LeaderboardRow {
  address: string
  label: string
  category?: string
  note?: string
  score: number
  tier: WalletScore['tier']
  realizedFlowUsd: number
  roundTrips: number
  recencyDays: number | null
  trades: number
  netFlowUsd: number
  lastTs: number | null
  series: number[] // cumulative-flow sparkline (downsampled, oldest→newest)
  topTokens: { network: string; token: string }[] // a few signal tokens they trade
}

/** Evenly downsample a series to at most `max` points (keeps first + last). */
function downsampleSeries(series: { v: number }[], max: number): number[] {
  const vals = series.map((p) => p.v)
  if (vals.length <= max) return vals
  const step = (vals.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => vals[Math.round(i * step)])
}

let leaderboardCache: { at: number; rows: LeaderboardRow[] } | null = null
const LEADERBOARD_TTL = 10 * 60_000 // 10 min — same wallet fetches as consensus; scores move slowly

/** Score + rank all tracked wallets by copy-worthiness. Cached 10 min (same per-wallet
 *  Etherscan fetches as the consensus view). Returns `needsKey` when tracking is off. */
export async function smartMoneyLeaderboard(now = Date.now()): Promise<{ rows: LeaderboardRow[]; needsKey: boolean; totalWallets: number; caveat: string }> {
  ensureSeeded()
  const totalWallets = listWallets().length
  if (!trackingReady()) return { rows: [], needsKey: true, totalWallets, caveat: SCORE_CAVEAT }
  if (leaderboardCache && now - leaderboardCache.at < LEADERBOARD_TTL)
    return { rows: leaderboardCache.rows, needsKey: false, totalWallets, caveat: SCORE_CAVEAT }
  // Warm mainnet majors so USD-valued flow (and thus realized-flow) is populated.
  await getSpotPrices(MAINNET_CG_IDS).catch(() => {})
  const rows: LeaderboardRow[] = []
  for (const w of listWallets()) {
    const events = await walletEvents(w.address, { allTokens: true }).catch(() => [])
    const stats = computeWalletStats(events)
    const score = computeWalletScore(stats, now)
    rows.push({
      address: w.address,
      label: w.label,
      category: w.category,
      note: w.note,
      score: score.score,
      tier: score.tier,
      realizedFlowUsd: score.realizedFlowUsd,
      roundTrips: score.roundTrips,
      recencyDays: score.recencyDays,
      trades: stats.trades,
      netFlowUsd: stats.netFlowUsd,
      lastTs: stats.lastTs,
      series: downsampleSeries(stats.series, 48),
      topTokens: stats.tokens.filter((t) => isSignalToken(t.token)).slice(0, 3).map((t) => ({ network: t.network, token: t.token })),
    })
  }
  // Best first: score, then realized flow, then most recent activity.
  rows.sort((a, b) => b.score - a.score || b.realizedFlowUsd - a.realizedFlowUsd || (b.lastTs ?? 0) - (a.lastTs ?? 0))
  leaderboardCache = { at: now, rows }
  return { rows, needsKey: false, totalWallets, caveat: SCORE_CAVEAT }
}
