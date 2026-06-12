export interface Token {
  symbol: string
  name: string
  cg: string
  address: string
  decimals: number
}

export interface Network {
  id: string
  name: string
  chainId: number
  native: { symbol: string; cg: string }
  avgGasUsd: number
  color: string
  tokens: Token[]
}

export interface StrategyMeta {
  id: string
  name: string
  tagline: string
  description: string
}

export interface RiskParams {
  label: string
  blurb: string
  positionPct: number
  stopLossPct: number
  takeProfitPct: number
  gridLevels: number
  gridSpacingPct: number
  rsiBuy: number
  rsiSell: number
  dcaIntervalMin: number
  dcaSlices: number
  cooldownMin: number
}

export interface Meta {
  networks: Network[]
  strategies: StrategyMeta[]
  risk: Record<string, RiskParams>
  live: { ready: boolean; botWallet: string | null }
  mode: 'paper' | 'live'
}

export interface Bot {
  id: string
  name: string
  network: string
  token: string
  strategy: string
  risk: 'conservative' | 'balanced' | 'aggressive'
  budgetUsd: number
  cashUsd: number
  status: 'running' | 'paused' | 'stopped' | 'scheduled'
  schedule: { enabled: boolean; days: number[]; startHour: number; endHour: number }
  position: { qty: number; avgCostUsd: number; costUsd: number; openedAt: number | null }
  state: Record<string, unknown>
  stats: {
    realizedUsd: number
    feesUsd: number
    wins: number
    losses: number
    nativeTakenQty: number
    nativeTakenUsd: number
  }
  equityHistory: { t: number; v: number }[]
  log: { ts: number; msg: string; kind: 'info' | 'buy' | 'sell' | 'warn' }[]
  createdAt: number
  lastTickAt: number
  priceUsd: number
  unrealizedUsd: number
  totalPnlUsd: number
  positionValueUsd: number
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

export interface BacktestResult {
  days: number
  trades: number
  wins: number
  losses: number
  returnPct: number
  buyHoldPct: number
  maxDrawdownPct: number
  feesUsd: number
  equity: { t: number; v: number }[]
  error?: string
}
