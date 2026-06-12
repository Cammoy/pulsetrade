// Tiny crash-safe JSON persistence — no native deps, atomic writes, debounced,
// flushed on shutdown. DATA_DIR env overrides the location (used by tests).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = process.env.DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const FILE = path.join(DIR, 'state.json')

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
  sweepTo?: SweepTarget // where profits / stop-sweeps land (default 'native')
  riskReport?: unknown // safety screen captured at creation
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
}

/** A profitability competition between bots with equal budgets. */
export interface Tournament {
  id: string
  name: string
  network: string
  token: string
  budgetUsd: number
  status: 'running' | 'ended'
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
}

export interface State {
  bots: Bot[]
  trades: Trade[]
  monthly: Record<string, MonthlyPnl> // key: YYYY-MM (local time)
  autoSniper: AutoSniper | null
  tournaments: Tournament[]
  wallets: TrackedWallet[]
  settings: { mode: 'paper' | 'live' }
}

const empty: State = {
  bots: [], trades: [], monthly: {}, autoSniper: null,
  tournaments: [], wallets: [], settings: { mode: 'paper' },
}

export function monthKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function emptyMonth(): MonthlyPnl {
  return { realizedUsd: 0, feesUsd: 0, nativeTakenUsd: 0, volumeUsd: 0, wins: 0, losses: 0, byRisk: {} }
}

/** One-time rebuild for states saved before the monthly ledger existed. */
function rebuildMonthly(s: State) {
  const riskOf = new Map(s.bots.map((b) => [b.id, b.risk]))
  for (const t of s.trades) {
    const m = (s.monthly[monthKey(t.ts)] ??= emptyMonth())
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
    if (!raw.monthly && s.trades.length) rebuildMonthly(s)
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
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, FILE)
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

/** Synchronous flush — used on shutdown and by tests. */
export function flushNow() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  writeSync()
}

process.on('exit', () => {
  try {
    if (timer) flushNow()
  } catch {
    /* best effort on shutdown */
  }
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    try {
      flushNow()
    } catch {}
    process.exit(0)
  })
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
