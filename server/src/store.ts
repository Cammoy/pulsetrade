// Tiny crash-safe JSON persistence — no native deps, atomic writes, debounced,
// flushed on shutdown. DATA_DIR env overrides the location (used by tests).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = process.env.DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const FILE = path.join(DIR, 'state.json')

/** The persistence directory — shared with the SQLite trade ledger (db.ts). */
export const DATA_DIR = DIR

export interface Position {
  qty: number
  avgCostUsd: number // includes buy fees — cost basis, not fill price
  costUsd: number
  openedAt: number | null
}

export interface BotLogEntry {
  ts: number
  msg: string
  kind: 'info' | 'buy' | 'sell' | 'warn'
}

/** Sniper bots price an off-CoinGecko token directly from its DEX pool. */
export interface PoolRef {
  poolAddress: string
  tokenAddress: string
  decimals: number
}

/** One-shot sniper configuration (instant entry, then TP/SL/time exit). */
export interface SniperConfig {
  takeProfitPct: number
  stopLossPct: number
  maxHoldMin: number
  trailingPct?: number // optional trailing stop from peak
  // ── Smart mode (opt-in; absent ⇒ legacy one-shot TP/SL/trail/maxHold) ──
  // Once a snipe is up this %, sell exactly enough to take the original stake back to
  // safety (cash + the withdrawable vault), then ride the rest as risk-free "house
  // money". Pairs with runnerTrailPct.
  deRiskAtPct?: number
  // After de-risking, trail the remaining runner this % off its peak — no fixed timer,
  // so a coin that keeps trending is held 24h+ and a clear reversal closes it.
  runnerTrailPct?: number
}

/** Copy-trade configuration: mirror a tracked wallet's flow in one token. */
export interface CopyConfig {
  walletAddress: string
  walletLabel: string
}

/** Where sweeps (profits, stop-liquidations) are converted to. */
export type SweepTarget = 'native' | 'usdt'

export interface Bot {
  id: string
  name: string
  network: string
  token: string // symbol within network (or sniped token symbol)
  strategy: string
  risk: 'conservative' | 'balanced' | 'aggressive'
  budgetUsd: number
  cashUsd: number
  status: 'running' | 'paused' | 'stopped' | 'scheduled'
  schedule: { enabled: boolean; days: number[]; startHour: number; endHour: number }
  pool?: PoolRef // present ⇒ priced from GeckoTerminal, not CoinGecko
  sniper?: SniperConfig // present ⇒ snipe bot
  auto?: boolean // spawned by the Auto-Sniper
  tournamentId?: string // competing in a tournament
  copy?: CopyConfig // present ⇒ copy-trades a tracked wallet
  ai?: boolean // present ⇒ AI-driven strategy
  followId?: string // spawned by an auto-follow of a smart-money wallet
  cg?: string // present ⇒ "market" bot priced directly from this CoinGecko id
  sweepTo?: SweepTarget // where profits / stop-sweeps land (default 'native')
  archived?: boolean // hidden from the active list (manual archive; retired bots also read as archived)
  // The WORKSPACE this bot belongs to, fixed at creation = the active mode then. A bot
  // ALWAYS executes in its OWN mode — a paper bot can never be flipped to live-trade by
  // the global toggle (and vice versa). The dashboard shows only the active workspace's
  // bots. Pre-existing bots (saved before this field) backfill to 'paper' in load().
  mode: 'paper' | 'live'
  riskReport?: unknown // safety screen captured at creation
  // Per-bot REAL on-chain holdings of bot.token, in base units at the decimals
  // mirrorLive sized with. Decimal STRING (base-units exceed 2^53 for 18-dp
  // tokens; JSON.stringify throws on bigint). Live-only — absent/'0' for paper.
  // Soft per-bot attribution of the SHARED wallet; the wallet balance is the
  // hard over-send guard. Reconstructed from chain on startup (reconcileRealHeld).
  realHeld?: string
  position: Position
  state: Record<string, any> // per-strategy scratch state
  stats: {
    realizedUsd: number
    feesUsd: number
    wins: number
    losses: number
    nativeTakenQty: number
    nativeTakenUsd: number
  }
  equityHistory: { t: number; v: number }[]
  log: BotLogEntry[]
  createdAt: number
  lastTickAt: number
}

export interface Trade {
  id: string
  botId: string
  ts: number
  side: 'buy' | 'sell'
  network: string
  token: string
  qty: number
  priceUsd: number
  usd: number
  feeUsd: number
  reason: string
  pnlUsd?: number
  sweptNative?: { qty: number; symbol: string; usd: number }
  mode: 'paper' | 'live'
}

/** Persistent monthly ledger — survives trade trimming and bot deletion. */
export interface MonthlyPnl {
  realizedUsd: number
  feesUsd: number
  nativeTakenUsd: number
  volumeUsd: number
  wins: number
  losses: number
  byRisk: Record<string, number> // realized P&L per risk tolerance
}

/** Auto-Sniper: a budget pool that autonomously snipes vetted new tokens. */
export interface AutoSniper {
  enabled: boolean
  network: string
  mode: 'new' | 'trending'
  totalBudgetUsd: number
  poolUsd: number // un-allocated budget remaining
  perSnipeUsd: number
  maxConcurrent: number
  config: SniperConfig
  sweepTo?: SweepTarget
  minLiquidityUsd: number
  tried: string[] // token addresses already attempted (never re-snipe)
  startedAt: number
  lastScanAt: number
  // Open at most ONE new best snipe per this interval (default 2h). The scanner still
  // runs often to discover pools; this gates how often it actually ENTERS.
  entryIntervalMs: number
  lastEntryAt: number // when the last auto-snipe was opened (0 = never)
  // Only enter pools created within this many minutes — the autopilot snipes NEW
  // launches, never a months/years-old coin (default 3 days; read defensively in autoScan).
  maxAgeMinutes: number
  // Finite CAMPAIGN model: deploy the budget across `targetSnipes` snipes (≈ total/per),
  // one per cadence. `openedCount` counts how many have opened; once it reaches the target
  // the budget is fully deployed → the scanner auto-stops (open runners ride on as normal
  // bots). Derived defensively in autoScan for an auto-sniper persisted before this field.
  targetSnipes: number
  openedCount: number
  // Distinct candidate coins the scanner has vetted THIS campaign (reset each start).
  // `tried` is the lifetime dedup buffer; `vetted` is the per-campaign count the UI shows
  // as "Coins vetted", so the panel stays scoped to the current campaign. Optional for
  // an auto-sniper persisted before this field (falls back to tried.length).
  vetted?: number
  // The WORKSPACE this auto-sniper trades in, pinned at start. A live auto-sniper keeps
  // sniping LIVE even while the paper workspace is being viewed (and vice versa) — its
  // spawned bots are born into this mode, gated by the live-spend caps + breaker.
  workspace: 'paper' | 'live'
}

/** A profitability competition between bots with equal budgets. */
export interface Tournament {
  id: string
  name: string
  network: string
  token: string
  budgetUsd: number
  status: 'running' | 'ended'
  mode: 'paper' | 'live' // the workspace it belongs to (backfilled to 'paper' for legacy)
  createdAt: number
  endsAt: number | null // auto-end time, or null for open-ended
  sweepTo: SweepTarget // on end, contestants liquidate to this
  winnerBotId: string | null
}

/** A wallet on the smart-money watchlist. */
export interface TrackedWallet {
  address: string
  label: string
  addedAt: number
  note?: string // one-line track record (seed wallets only)
  category?: 'trader' | 'whale' | 'fund' | 'public-figure'
}

/** Auto-follow: a budget that mirrors EVERY curated-token buy a wallet makes. */
export interface Follow {
  id: string
  walletAddress: string
  label: string
  totalBudgetUsd: number
  poolUsd: number // un-allocated budget remaining
  perTradeUsd: number
  maxConcurrent: number
  risk: 'conservative' | 'balanced' | 'aggressive'
  sweepTo?: SweepTarget
  enabled: boolean
  startedAt: number
  lastScanAt: number
  seenTx: string[] // wallet txs already mirrored (never double-follow)
}

/** A coin saved to the Market watchlist — identity kept so it renders even when
 *  it drops out of the live top-250 market pull. */
export interface SavedCoin {
  id: string
  symbol: string
  name: string
}

/** A profit withdrawal — banked profit sent OUT of the bot wallet to an external
 *  address the operator specifies. `simulated` ⇒ paper (no funds moved); the live
 *  states (`pending`→`confirmed`/`failed`) track a real on-chain transfer. */
export interface Withdrawal {
  id: string
  ts: number
  network: string
  asset: 'native' | 'usdt'
  symbol: string // the asset's display symbol at request time (ETH, USDT, …)
  amountQty: number
  amountUsd: number
  toAddress: string
  mode: 'paper' | 'live'
  status: 'simulated' | 'pending' | 'confirmed' | 'failed'
  txHash?: string
  error?: string
}

/** A completed manual swap (the Swap panel) — for the swap-history view. Display
 *  amounts are formatted by the web at execute time and stored verbatim. */
export interface SwapRecord {
  id: string
  ts: number
  network: string
  sellSymbol: string
  buySymbol: string
  sellAmount: string
  buyAmount: string
  txHash: string
  mode: 'paper' | 'live'
  toNetwork?: string // set for a CROSS-CHAIN swap (destination network ≠ `network`)
  bridge?: string // the bridge/tool used for a cross-chain swap
}

/** A single buy lot in the manual holdings tracker — what you paid for some units. */
export interface TrackerLot {
  id: string
  qty: number // units bought
  priceUsd: number // purchase price per unit (USD)
  ts: number // purchase date (ms)
  feeUsd?: number
  note?: string
}

/** A sale of tracked units — drives realised P/L. */
export interface TrackerSell {
  id: string
  qty: number
  priceUsd: number // sale price per unit (USD)
  ts: number
  feeUsd?: number
  note?: string
}

/** A tracked coin: identity + its buy lots + sells. Cost basis is the average of
 *  all lots (incl. fees); current quantity = bought − sold. */
export interface TrackedAsset {
  id: string
  cg: string // CoinGecko id — the pricing source of truth
  symbol: string
  name: string
  lots: TrackerLot[]
  sells: TrackerSell[]
}

/** The monthly P&L ledger, SEGREGATED BY WORKSPACE so the Live view never mixes in
 *  paper history (and vice versa). Each side keys YYYY-MM → MonthlyPnl. This is the
 *  only persistent record of DELETED bots' P&L, so the split lives in storage, not a
 *  filter. */
export interface MonthlyPnlByMode {
  paper: Record<string, MonthlyPnl>
  live: Record<string, MonthlyPnl>
}

export interface State {
  bots: Bot[]
  trades: Trade[]
  monthly: MonthlyPnlByMode // YYYY-MM (local time), per workspace
  autoSniper: AutoSniper | null
  tournaments: Tournament[]
  wallets: TrackedWallet[]
  follows: Follow[]
  settings: { mode: 'paper' | 'live' }
  // Cross-device UI preferences. Persisted in the same crash-safe state.json as
  // everything else — free, no external DB, syncs across any browser on this engine.
  prefs: { watchlist: SavedCoin[] }
  // Cumulative USD spent on LIVE buys today (local day) — enforces a daily spend
  // cap so a live bot can't drain the wallet. Resets when the day rolls over.
  liveSpend: { day: string; usd: number }
  // Account-level circuit breaker for live trading. Accumulates realized P&L and
  // total spend since the last manual arm; trips (pauses ALL bots) on a cumulative
  // loss or lifetime-spend breach and stays tripped until the operator re-arms.
  breaker: { tripped: boolean; reason: string; trippedAt: number | null; realizedUsd: number; spentUsd: number }
  // Banked-profit vault: qty of each swept asset still available to withdraw, keyed
  // by `${network}:${asset}:${mode}` (asset = 'native' | 'usdt', mode = the bot's
  // workspace). Per-workspace so a PAPER bot's simulated profit can never be paid out
  // as real funds in the live workspace. Credited whenever a sell sweeps profit to
  // native/USDT; debited by withdrawals. Survives bot deletion.
  vault: Record<string, number>
  // Ledger of profit withdrawals (simulated in paper; real transfers in live).
  withdrawals: Withdrawal[]
  swaps: SwapRecord[] // completed manual swaps (Swap panel history)
  // Manual holdings tracker — user-entered positions (cost basis + P/L), independent
  // of the bots and the on-chain wallet reader.
  tracker: TrackedAsset[]
}

const empty: State = {
  bots: [], trades: [], monthly: { paper: {}, live: {} }, autoSniper: null,
  tournaments: [], wallets: [], follows: [], settings: { mode: 'paper' },
  prefs: { watchlist: [] }, liveSpend: { day: '', usd: 0 },
  breaker: { tripped: false, reason: '', trippedAt: null, realizedUsd: 0, spentUsd: 0 },
  vault: {}, withdrawals: [], swaps: [], tracker: [],
}

export function monthKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** UTC YYYY-MM-DD — the bucket for the daily live-spend cap. UTC (not local) so the
 *  reset boundary is deterministic regardless of the host's timezone/DST. [P1-2] */
export function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function emptyMonth(): MonthlyPnl {
  return { realizedUsd: 0, feesUsd: 0, nativeTakenUsd: 0, volumeUsd: 0, wins: 0, losses: 0, byRisk: {} }
}

/** One-time rebuild for states saved before the monthly ledger existed. Buckets each
 *  trade into its OWN workspace (trade.mode) so the rebuilt ledger is mode-correct;
 *  a legacy trade with no mode falls back to 'paper'. */
function rebuildMonthly(s: State) {
  const riskOf = new Map(s.bots.map((b) => [b.id, b.risk]))
  for (const t of s.trades) {
    const dict = t.mode === 'live' ? s.monthly.live : s.monthly.paper
    const m = (dict[monthKey(t.ts)] ??= emptyMonth())
    m.volumeUsd += t.usd
    m.feesUsd += t.feeUsd
    if (t.side === 'sell' && t.pnlUsd !== undefined) {
      m.realizedUsd += t.pnlUsd
      if (t.pnlUsd >= 0) m.wins++
      else m.losses++
      const risk = riskOf.get(t.botId)
      if (risk) m.byRisk[risk] = (m.byRisk[risk] ?? 0) + t.pnlUsd
    }
    if (t.sweptNative) m.nativeTakenUsd += t.sweptNative.usd
  }
}

function load(): State {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    const s: State = { ...structuredClone(empty), ...raw }
    // Coerce malformed-but-parseable top-level collections: a persisted null/{} for
    // a field REPLACES the default in the shallow merge above, and consumers index
    // these directly (s.trades.length, s.bots loop, /api/state maps). load() must
    // tolerate a corrupt field, not only an absent one.
    if (!Array.isArray(s.bots)) s.bots = []
    if (!Array.isArray(s.trades)) s.trades = []
    if (!Array.isArray(s.tournaments)) s.tournaments = []
    // Backfill tournament workspace: pre-mode tournaments → 'paper' (matches their bots).
    else for (const t of s.tournaments) if (t && t.mode !== 'paper' && t.mode !== 'live') t.mode = 'paper'
    if (!Array.isArray(s.wallets)) s.wallets = []
    if (!Array.isArray(s.follows)) s.follows = []
    // Monthly ledger is now per-workspace { paper, live }. Migrate three shapes without
    // losing the only record of deleted bots' P&L:
    //  • missing/corrupt → empty both sides
    //  • already split (has paper/live) → coerce each side to a well-formed object
    //  • legacy FLAT { 'YYYY-MM': … } (pre-split; all earned in paper since we never went
    //    live) → { paper: <flat>, live: {} }
    if (!s.monthly || typeof s.monthly !== 'object' || Array.isArray(s.monthly)) {
      s.monthly = { paper: {}, live: {} }
    } else if ('paper' in s.monthly || 'live' in s.monthly) {
      const m = s.monthly as Partial<MonthlyPnlByMode>
      s.monthly = {
        paper: m.paper && typeof m.paper === 'object' && !Array.isArray(m.paper) ? m.paper : {},
        live: m.live && typeof m.live === 'object' && !Array.isArray(m.live) ? m.live : {},
      }
    } else {
      s.monthly = { paper: s.monthly as unknown as Record<string, MonthlyPnl>, live: {} }
    }
    if (!raw.monthly && s.trades.length) rebuildMonthly(s)
    // Backfill + normalize realHeld on every bot: the shallow {...empty,...raw}
    // merge never reaches into the bots array, so a new optional field is
    // undefined on pre-existing bots. Coerce to a well-formed non-negative
    // integer string so BigInt() can never throw at a hot-path use site.
    for (const b of s.bots) {
      b.realHeld = /^\d+$/.test(String(b.realHeld ?? '')) ? b.realHeld : '0'
      // Backfill the workspace: any bot saved before per-bot mode → 'paper' (safe — it
      // can then never live-trade until the user deliberately recreates it in live).
      if (b.mode !== 'paper' && b.mode !== 'live') b.mode = 'paper'
    }
    // Normalize prefs: a state.json from before prefs existed (or a partial one)
    // must still yield a well-formed watchlist array.
    if (!s.prefs || !Array.isArray(s.prefs.watchlist)) s.prefs = { watchlist: [] }
    // A non-numeric persisted liveSpend.usd would make `spentToday + usd > cap`
    // → `NaN > cap = false`, silently bypassing the daily live-spend cap after a reload.
    if (!s.liveSpend || typeof s.liveSpend.day !== 'string' || !Number.isFinite(s.liveSpend.usd)) s.liveSpend = { day: '', usd: 0 }
    // Merge breaker DEFAULTS into a persisted object (a partial/legacy breaker would
    // otherwise leave realizedUsd/spentUsd undefined → NaN-poisons the cumulative-loss
    // and lifetime-spend caps, silently disabling both money-safety guards), then
    // coerce the numeric accumulators to finite values (NaN persists back as null).
    s.breaker = {
      tripped: false, reason: '', trippedAt: null, realizedUsd: 0, spentUsd: 0,
      ...(s.breaker && typeof s.breaker.tripped === 'boolean' ? s.breaker : {}),
    }
    s.breaker.realizedUsd = Number.isFinite(s.breaker.realizedUsd) ? s.breaker.realizedUsd : 0
    s.breaker.spentUsd = Number.isFinite(s.breaker.spentUsd) ? s.breaker.spentUsd : 0
    // Fail CLOSED to paper: a missing/garbled settings block (settings:null, {},
    // or an unknown mode) must never leave mode undefined — every consumer reads
    // settings.mode, and a live-or-undefined value here is the worst default.
    if (!s.settings || (s.settings.mode !== 'paper' && s.settings.mode !== 'live')) s.settings = { mode: 'paper' }
    // Profit vault: a non-object (or array) persisted value must collapse to {} —
    // requestWithdrawal indexes it directly. Drop any non-finite/negative qty so a
    // corrupt entry can't make the `available >= amount` check NaN-compare false-open.
    if (!s.vault || typeof s.vault !== 'object' || Array.isArray(s.vault)) s.vault = {}
    else
      for (const k of Object.keys(s.vault)) {
        if (!(Number.isFinite(s.vault[k]) && s.vault[k] > 0)) {
          delete s.vault[k]
          continue
        }
        // Migrate legacy `network:asset` keys (pre per-workspace split; all earned in
        // paper since we never went live) → `network:asset:paper`, so existing banked
        // profit is paper-withdrawable (simulated) and can NEVER be paid out as real funds.
        if (k.split(':').length === 2) {
          const migrated = `${k}:paper`
          s.vault[migrated] = (s.vault[migrated] ?? 0) + s.vault[k]
          delete s.vault[k]
        }
      }
    if (!Array.isArray(s.withdrawals)) s.withdrawals = []
    if (!Array.isArray(s.swaps)) s.swaps = []
    // Tracker: coerce to a well-formed array of assets, each with lots/sells arrays,
    // so a corrupt persisted value can't crash the valuation loop.
    if (!Array.isArray(s.tracker)) s.tracker = []
    else
      s.tracker = s.tracker
        .filter((a) => a && typeof a.cg === 'string' && a.cg)
        .map((a) => ({
          ...a,
          // Drop any lot/sell with non-finite numbers so a corrupted state.json can't
          // surface a NaN/null row in the valuation. (addLot/editLot already reject
          // these at the API; this guards externally-edited state.) [verify-fix]
          lots: (Array.isArray(a.lots) ? a.lots : []).filter((l) => l && Number.isFinite(l.qty) && l.qty > 0 && Number.isFinite(l.priceUsd) && l.priceUsd >= 0),
          sells: (Array.isArray(a.sells) ? a.sells : []).filter((x) => x && Number.isFinite(x.qty) && x.qty > 0 && Number.isFinite(x.priceUsd) && x.priceUsd >= 0),
        }))
    // One-time backfill (states saved before the vault existed): reconstruct the
    // withdrawable balance from each bot's already-banked profit so existing profit
    // is immediately withdrawable. Keyed by chain+sweep-asset; only runs when the
    // persisted state had no vault at all, so going-forward credits never double-count.
    if (!raw.vault) {
      for (const b of s.bots) {
        const q = b.stats?.nativeTakenQty
        if (Number.isFinite(q) && q > 0) {
          // Key by the bot's WORKSPACE (backfilled to 'paper' just above) so a paper
          // bot's banked profit is never reconstructed as live-withdrawable.
          const k = `${b.network}:${b.sweepTo === 'usdt' ? 'usdt' : 'native'}:${b.mode}`
          s.vault[k] = (s.vault[k] ?? 0) + q
        }
      }
    }
    return s
  } catch {
    return structuredClone(empty)
  }
}

export const state: State = load()

let timer: ReturnType<typeof setTimeout> | null = null

function writeSync() {
  fs.mkdirSync(DIR, { recursive: true })
  const tmp = FILE + '.tmp'
  // fsync the file before the rename so an acknowledged write (a live realHeld
  // credit) survives power-loss, not just a process crash — atomic rename alone
  // is crash-safe but the contents can still be lost in the page-cache window.
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, JSON.stringify(state))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, FILE)
  // Best-effort directory fsync so the rename itself is durable.
  try {
    const dfd = fs.openSync(DIR, 'r')
    try {
      fs.fsyncSync(dfd)
    } finally {
      fs.closeSync(dfd)
    }
  } catch {
    /* directory fsync unsupported on some platforms — ignore */
  }
}

export function save() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    try {
      writeSync()
    } catch (e) {
      console.error('[store] save failed', e)
    }
  }, 400)
}

/** Replace the saved watchlist (sanitised + capped) and persist. Returns the
 *  stored list. Idempotent — the client PUTs the full array on every change. */
export function setWatchlist(items: unknown): SavedCoin[] {
  const clean: SavedCoin[] = Array.isArray(items)
    ? items
        .filter((c: any) => c && typeof c.id === 'string' && c.id && typeof c.symbol === 'string')
        .map((c: any) => ({ id: String(c.id).slice(0, 100), symbol: String(c.symbol).slice(0, 24), name: String(c.name ?? c.symbol).slice(0, 100) }))
        .slice(0, 500)
    : []
  // De-dupe by id, preserving order.
  const seen = new Set<string>()
  state.prefs.watchlist = clean.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
  save()
  return state.prefs.watchlist
}

/** Synchronous flush — used on shutdown and by tests. */
export function flushNow() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  writeSync()
}

// Last-resort synchronous flush on normal exit. SIGINT/SIGTERM are handled by the
// app entrypoint (index.ts), which DRAINS in-flight swaps before exiting — so this
// module no longer calls process.exit() on a signal (that would abandon a broadcast
// on-chain tx mid-flight). This 'exit' handler stays as a final safety net. [P1-12]
process.on('exit', () => {
  try {
    if (timer) flushNow()
  } catch {
    /* best effort on shutdown */
  }
})

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
