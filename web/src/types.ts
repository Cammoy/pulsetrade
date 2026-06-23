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
  usdt?: { symbol: string; cg: string; address: string; decimals: number }
  evm?: boolean
  tradeable?: boolean // false ⇒ holdings-only (shown in the portfolio, never offered for trading)
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
  live: {
    ready: boolean
    botWallet: string | null
    evm?: { ready: boolean; wallet: string | null; signer?: 'turnkey' | 'key' | null }
    solana?: { ready: boolean; wallet: string | null; signer?: 'turnkey' | 'key' | null }
    icp?: { ready: boolean; reason: string }
    maxUsdPerDay?: number
    spentTodayUsd?: number
    maxCumulativeLossUsd?: number
    maxLiveUsdTotal?: number
    breaker?: { tripped: boolean; reason: string; trippedAt: number | null; realizedUsd: number; spentUsd: number }
  }
  features: { ai: boolean; walletTracking: boolean }
  copyTokens: { network: string; name: string; tokens: string[] }[]
  mode: 'paper' | 'live'
}

export interface TrackedWallet {
  address: string
  label: string
  addedAt: number
  note?: string
  category?: 'trader' | 'whale' | 'fund' | 'public-figure'
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
  curated: boolean
}

export interface Holding {
  network: string
  token: string
  tokenAddress: string
  qty: number
  usd: number | null
  curated: boolean
  buys: number
  sells: number
  lastTs: number
  suspicious: boolean
}

export interface TokenFlow {
  network: string
  token: string
  tokenAddress: string
  buyers: number
  sellers: number
  buyUsd: number
  sellUsd: number
  netUsd: number
  lastTs: number
  wallets: string[]
  curated: boolean
}

export interface NotableMove {
  wallet: string
  side: 'buy' | 'sell'
  token: string
  network: string
  usd: number
  ts: number
}

export interface EmergingCoin {
  network: string
  token: string
  tokenAddress: string
  buyers: number
  buys: number
  usd: number | null
  wallets: string[]
  lastTs: number
}

export interface ConsensusHolding {
  network: string
  token: string
  tokenAddress: string
  holders: number
  totalWallets: number
  pctOfWhales: number
  wallets: { label: string; usd: number | null }[]
  totalUsd: number | null
  curated: boolean
}

export interface SmartMoneyOverview {
  windowDays: number
  totalBuyUsd: number
  totalSellUsd: number
  netUsd: number
  activeWallets: number
  stableNetUsd: number
  accumulating: TokenFlow[]
  distributing: TokenFlow[]
  emerging: EmergingCoin[]
  notable: NotableMove[]
  flowSeries: { t: number; risk: number; stable: number }[]
}

export interface SmartInsight {
  headline: string
  summary: string
  sentiment: 'risk-on' | 'neutral' | 'risk-off'
  rotation: string
  highlights: { title: string; detail: string }[]
  watch: string[]
}

export interface SmartIntelligence {
  overview: SmartMoneyOverview | null
  insight: SmartInsight | null
  needsTracking: boolean
  needsAi: boolean
  generatedAt: number | null
}

export interface MarketSignal {
  action: 'buy' | 'sell' | 'hold'
  score: number
  reasons: string[]
}

export interface MarketCoin {
  id: string
  symbol: string
  name: string
  image: string | null
  priceUsd: number | null
  change1h: number | null
  change24h: number | null
  change7d: number | null
  marketCapUsd: number | null
  marketCapRank: number | null
  volume24hUsd: number | null
  athChangePct: number | null
  volToMcap: number | null
  rsi: number | null
  stable: boolean
  sparkline7d: number[]
  signal: MarketSignal
}

export interface MarketOverview {
  at: number
  backoffMs: number
  global: {
    marketCapUsd: number | null
    marketCapChange24hPct: number | null
    volume24hUsd: number | null
    btcDominancePct: number | null
    ethDominancePct: number | null
    activeCryptocurrencies: number | null
  }
  fearGreed: { value: number; classification: string } | null
  status: { label: 'risk-on' | 'neutral' | 'risk-off'; composite: number; blurb: string }
  coins: MarketCoin[]
  trending: MarketCoin[]
  lanes: Record<string, string[]>
}

export interface ConsensusRow {
  network: string
  token: string
  tokenAddress: string
  buyers: number
  sellers: number
  buys: number
  sells: number
  netUsd: number
  lastTs: number
}

export interface WalletTokenStat {
  network: string
  token: string
  buys: number
  sells: number
  volumeUsd: number
  netFlowUsd: number
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
  tokens: WalletTokenStat[]
  series: { t: number; v: number }[]
}

export interface WalletScore {
  score: number
  tier: 'proven' | 'promising' | 'unproven' | 'thin'
  basis: 'realized-pnl' | 'flow'
  realizedFlowUsd: number
  realizedPnlUsd: number | null
  roundTrips: number
  recencyDays: number | null
  caveat: string
}

export interface WalletProfile {
  wallet: string
  label: string
  note?: string
  category?: string
  tracking: boolean
  events: SmartMoneyEvent[]
  holdings: Holding[]
  stats: WalletStats
  score: WalletScore
}

export interface Follow {
  id: string
  walletAddress: string
  label: string
  totalBudgetUsd: number
  poolUsd: number
  perTradeUsd: number
  maxConcurrent: number
  risk: string
  sweepTo?: 'native' | 'usdt'
  stopLossPct?: number
  takeProfitPct?: number
  enabled: boolean
  startedAt: number
  stats: { active: number; completed: number; realizedUsd: number; sweptUsd: number; wins: number; losses: number }
}

/** One wallet's copy-worthiness ranking row (GET /api/smart-money/leaderboard). */
export interface LeaderboardRow {
  address: string
  label: string
  category?: string
  note?: string
  score: number
  tier: 'proven' | 'promising' | 'unproven' | 'thin'
  basis: 'realized-pnl' | 'flow'
  realizedFlowUsd: number
  realizedPnlUsd: number | null
  roundTrips: number
  recencyDays: number | null
  trades: number
  netFlowUsd: number
  lastTs: number | null
  series: number[]
  topTokens: { network: string; token: string }[]
}

/** A copy-worthy wallet discovered on-chain (GET /api/smart-money/discover), verified by realized P&L. */
export interface DiscoveredTrader {
  address: string
  score: number
  tier: 'proven' | 'promising' | 'unproven' | 'thin'
  realizedPnlUsd: number
  roundTrips: number
  recencyDays: number | null
  trades: number
  viaTokens: { network: string; token: string }[]
}

export interface TournamentStanding {
  botId: string
  name: string
  strategy: string
  risk: string
  status: string
  totalPnlUsd: number
  returnPct: number
  wins: number
  losses: number
  trades: number
}

export interface Tournament {
  id: string
  name: string
  network: string
  token: string
  budgetUsd: number
  status: 'running' | 'ended'
  mode?: 'paper' | 'live' // workspace it belongs to (server backfills 'paper')
  createdAt: number
  endsAt: number | null
  sweepTo?: 'native' | 'usdt'
  winnerBotId: string | null
  standings: TournamentStanding[]
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
  pool?: { poolAddress: string; tokenAddress: string; decimals: number }
  sniper?: { takeProfitPct: number; stopLossPct: number; maxHoldMin: number; trailingPct?: number }
  copy?: { walletAddress: string; walletLabel: string; perTradeUsd?: number; stopLossPct?: number; takeProfitPct?: number }
  ai?: boolean
  tournamentId?: string
  followId?: string // set ⇒ this bot was spawned by an auto-follow pool
  cg?: string
  sweepTo?: 'native' | 'usdt'
  archived?: boolean
  mode?: 'paper' | 'live' // the workspace this bot belongs to (server backfills 'paper')
  riskReport?: RiskReport
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

export interface TradeStats {
  enabled: boolean
  count: number
  realizedUsd: number
  volumeUsd: number
  feesUsd: number
  wins: number
  losses: number
  firstTs: number | null
  lastTs: number | null
  byToken: { network: string; token: string; trades: number; realizedUsd: number; volumeUsd: number }[]
}

export interface MonthlyPnl {
  realizedUsd: number
  feesUsd: number
  nativeTakenUsd: number
  volumeUsd: number
  wins: number
  losses: number
  byRisk: Record<string, number>
}

export interface FinderRow {
  network: string
  token: string
  tokenName: string
  strategy: string
  strategyName: string
  risk: string
  /** Out-of-sample return (final third) — the honest headline rows are ranked on. */
  returnPct: number
  /** Full-window (in-sample) return — muted reference; it overfits. */
  inSampleReturnPct: number
  /** Median OOS return across every strategy×risk combo tried for this coin — the
   *  "typical" result, so the best-of-N headline isn't read as the expected outcome. */
  cohortMedianReturnPct: number
  profitUsd: number
  winRate: number | null
  maxDrawdownPct: number
  trades: number
  feesUsd: number
  /** Honest backtest edge label (verdict + key stats). Most rows read no-edge/inconclusive. */
  edge?: { verdict: 'no-edge' | 'inconclusive' | 'weak' | 'significant'; tStat: number; sharpe: number; expectancyPct: number }
  change24hPct?: number | null
  launch?:
    | { kind: 'bot'; network: string; token: string }
    | { kind: 'market'; cg: string; token: string; tokenName: string }
    | { kind: 'snipe'; network: string; token: string; poolAddress: string; tokenAddress: string }
    | null
}

export interface FinderResult {
  budgetUsd: number
  days: number
  rows: FinderRow[]
  skipped: string[]
  caveat?: string
}

export interface RiskFlag {
  id: string
  label: string
  detail: string
  severity: 'info' | 'warn' | 'critical'
}

export interface RiskReport {
  network: string
  chainId: number
  token: string
  score: number
  verdict: 'safe' | 'caution' | 'danger'
  tradeable: boolean
  flags: RiskFlag[]
  positives: string[]
  buyTaxPct: number | null
  sellTaxPct: number | null
  sources: string[]
  checkedAt: number
  error?: string
}

export interface PoolCandidate {
  network: string
  poolAddress: string
  tokenAddress: string
  tokenSymbol: string
  tokenName: string
  priceUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  priceChange1hPct: number | null
  fdvUsd: number | null
  createdAt: number | null
  ageMinutes: number | null
  dex: string | null
}

export interface SafePool extends PoolCandidate {
  report: RiskReport
}

export interface AutoSniperState {
  enabled: boolean
  network: string
  mode: 'new' | 'trending'
  totalBudgetUsd: number
  poolUsd: number
  perSnipeUsd: number
  maxConcurrent: number
  config: { takeProfitPct: number; stopLossPct: number; maxHoldMin: number; trailingPct?: number; deRiskAtPct?: number; runnerTrailPct?: number }
  minLiquidityUsd: number
  startedAt: number
  entryIntervalMs?: number
  lastEntryAt?: number
  lastScanAt?: number
  scanIntervalMs?: number // how often the scanner ticks (server: AUTO_SCAN_MS)
  triedCount?: number // coins vetted THIS campaign (server: a.vetted, legacy fallback tried.length)
  maxAgeMinutes?: number // only snipe coins newer than this (freshness gate)
  targetSnipes?: number // campaign size — total snipes to deploy the budget across
  openedCount?: number // how many snipes have opened so far this campaign
  workspace?: 'paper' | 'live'
  stats: { active: number; completed: number; realizedUsd: number; unrealizedUsd?: number; totalPnlUsd?: number; nativeTakenUsd: number; wins: number; losses: number }
}

/** A completed manual swap (the Swap panel history). */
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

export interface PortfolioHolding {
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
  holdings: PortfolioHolding[]
  byNetwork: { id: string; name: string; color: string; usd: number }[]
  errors: string[]
}

/** One withdrawable banked-profit balance (a chain + asset). */
export interface VaultBalance {
  network: string
  networkName: string
  asset: 'native' | 'usdt'
  symbol: string
  qty: number
  usdValue: number
  liveWithdrawable: boolean
}

/** A profit-withdrawal record (simulated in paper; a real transfer in live). */
export interface Withdrawal {
  id: string
  ts: number
  network: string
  asset: 'native' | 'usdt'
  symbol: string
  amountQty: number
  amountUsd: number
  toAddress: string
  mode: 'paper' | 'live'
  status: 'simulated' | 'pending' | 'confirmed' | 'failed'
  txHash?: string
  error?: string
}

export interface WithdrawalsPayload {
  vault: VaultBalance[]
  history: Withdrawal[]
  mode: 'paper' | 'live'
}

// ── Manual holdings tracker (cost-basis P/L) ─────────────────────────────────
export interface TrackerLot {
  id: string
  qty: number
  priceUsd: number
  ts: number
  feeUsd?: number
  note?: string
}
export interface TrackerSell {
  id: string
  qty: number
  priceUsd: number
  ts: number
  feeUsd?: number
  note?: string
}
export interface AssetMetrics {
  id: string
  cg: string
  symbol: string
  name: string
  qty: number
  avgCostUsd: number
  priceUsd: number | null
  costBasisUsd: number
  valueUsd: number
  unrealizedPnlUsd: number
  unrealizedPnlPct: number
  realizedPnlUsd: number
  allocationPct: number
  lots: TrackerLot[]
  sells: TrackerSell[]
  spark: number[]
}
export interface TrackerValuation {
  assets: AssetMetrics[]
  totals: {
    investedUsd: number
    valueUsd: number
    unrealizedPnlUsd: number
    unrealizedPnlPct: number
    realizedPnlUsd: number
    assetCount: number
  }
  best: { symbol: string; pct: number } | null
  worst: { symbol: string; pct: number } | null
  at: number
}
export interface CoinHit {
  id: string
  symbol: string
  name: string
  thumb: string | null
  rank: number | null
}
