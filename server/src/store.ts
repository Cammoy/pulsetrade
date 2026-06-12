// Tiny crash-safe JSON persistence — no native deps, atomic writes, debounced.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const FILE = path.join(DIR, 'state.json')

export interface Position {
  qty: number
  avgCostUsd: number
  costUsd: number
  openedAt: number | null
}

export interface BotLogEntry {
  ts: number
  msg: string
  kind: 'info' | 'buy' | 'sell' | 'warn'
}

export interface Bot {
  id: string
  name: string
  network: string
  token: string // symbol within network
  strategy: string
  risk: 'conservative' | 'balanced' | 'aggressive'
  budgetUsd: number
  cashUsd: number
  status: 'running' | 'paused' | 'stopped' | 'scheduled'
  schedule: { enabled: boolean; days: number[]; startHour: number; endHour: number }
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

export interface State {
  bots: Bot[]
  trades: Trade[]
  settings: { mode: 'paper' | 'live' }
}

const empty: State = { bots: [], trades: [], settings: { mode: 'paper' } }

function load(): State {
  try {
    return { ...empty, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }
  } catch {
    return structuredClone(empty)
  }
}

export const state: State = load()

let timer: ReturnType<typeof setTimeout> | null = null
export function save() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    try {
      fs.mkdirSync(DIR, { recursive: true })
      const tmp = FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(state))
      fs.renameSync(tmp, FILE)
    } catch (e) {
      console.error('[store] save failed', e)
    }
  }, 400)
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
