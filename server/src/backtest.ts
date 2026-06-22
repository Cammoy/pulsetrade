// Backtests run the SAME strategy.decide() the live engine uses, over real
// 30-day hourly history, with fees + slippage and the same cost-basis
// accounting (buy fees included), so wizard numbers are honest.

import { getCandles, backoffRemainingMs } from './prices.js'
import { strategyById, STRATEGIES, type Ctx } from './strategies.js'
import { RISK, type RiskParams } from './risk.js'
import { networkById, NETWORKS } from './networks.js'
import { discoverSafePools } from './sniper.js'
import { SLIPPAGE_PER_SIDE as SLIPPAGE } from './costs.js'

/** Honest edge statistics — these MEASURE whether a strategy's profit is distinguishable
 *  from luck; they do NOT create edge. Most retail strategies land at no-edge/inconclusive,
 *  which is the point: the app should prove or disprove edge, never imply it. */
export interface EdgeStats {
  trades: number // closed round trips that realized P&L
  expectancyPct: number // mean per-trade return %
  tStat: number // t-statistic of per-trade returns vs 0 (|t|≥2 ≈ p<0.05)
  sharpe: number // annualized Sharpe from the equity curve (approx, at the sample cadence)
  pValue: number // bootstrap P(summed trade return ≤ 0) — within-sample significance
  verdict: 'no-edge' | 'inconclusive' | 'weak' | 'significant'
}

export interface BacktestResult {
  days: number
  trades: number
  wins: number
  losses: number
  returnPct: number
  /** Out-of-sample return: the equity change over the FINAL third of the window
   *  after the strategy ran through the first two-thirds. The Profit Finder ranks
   *  on this so it can't headline a coin purely on a stale early pump it's now
   *  displaying — a walk-forward sanity check against in-sample overfit. */
  oosReturnPct: number
  buyHoldPct: number
  maxDrawdownPct: number
  feesUsd: number
  equity: { t: number; v: number }[]
  edge: EdgeStats
  error?: string
}

// Fraction of the trading window held out as the out-of-sample (OOS) test segment.
const OOS_FRACTION = 1 / 3

// SLIPPAGE (per-side execution cost) is the shared engine/backtest constant — see
// ./costs.js. Caveat specific to backtests: it models LIQUID coins; THIN/sniper pools
// cost far more (1%+ slippage the live quote tolerates, plus MEV), not captured by a
// flat rate, so treat sniper backtests as optimistic.
const WARMUP = 25 // candles consumed before trading starts (indicator warm-up)

const NO_EDGE: EdgeStats = { trades: 0, expectancyPct: 0, tStat: 0, sharpe: 0, pValue: 1, verdict: 'no-edge' }

function fail(days: number, error: string): BacktestResult {
  return {
    days, trades: 0, wins: 0, losses: 0, returnPct: 0, oosReturnPct: 0, buyHoldPct: 0,
    maxDrawdownPct: 0, feesUsd: 0, equity: [], edge: NO_EDGE, error,
  }
}

/** Honest edge stats from realized per-trade returns + the equity curve. Measures whether
 *  the result is distinguishable from luck (it usually isn't) — never manufactures edge. */
export function computeEdge(tradeRet: number[], equity: { t: number; v: number }[], oosReturnPct: number): EdgeStats {
  const n = tradeRet.length
  if (n === 0) return { ...NO_EDGE, verdict: 'inconclusive' }
  const mean = tradeRet.reduce((s, x) => s + x, 0) / n
  const variance = n > 1 ? tradeRet.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0
  const sd = Math.sqrt(variance)
  const tStat = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0
  // Bootstrap: resample the trades (with replacement) and sum — the share of resamples
  // whose total is ≤ 0 estimates the chance the positive result is just trade-luck. Seeded
  // LCG so the figure is deterministic (reproducible + testable), no Math.random.
  let seed = (0x9e3779b9 ^ n) >>> 0
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed / 0x100000000)
  const ITERS = 2000
  let leZero = 0
  for (let it = 0; it < ITERS; it++) {
    let total = 0
    for (let k = 0; k < n; k++) total += tradeRet[Math.floor(rand() * n)]
    if (total <= 0) leZero++
  }
  const pValue = +(leZero / ITERS).toFixed(3)
  // Sharpe from the equity samples (periodic returns), annualized at the ~4-candle cadence.
  const er: number[] = []
  for (let i = 1; i < equity.length; i++) if (equity[i - 1].v > 0) er.push(equity[i].v / equity[i - 1].v - 1)
  let sharpe = 0
  if (er.length >= 2) {
    const em = er.reduce((s, x) => s + x, 0) / er.length
    const esd = Math.sqrt(er.reduce((s, x) => s + (x - em) ** 2, 0) / (er.length - 1))
    if (esd > 0) sharpe = +((em / esd) * Math.sqrt((365 * 24) / 4)).toFixed(2)
  }
  // Conservative verdict — a backtest LABEL, not a promise: too few trades → inconclusive;
  // failed walk-forward (OOS ≤ 0) → no-edge; else gate on within-sample significance.
  let verdict: EdgeStats['verdict']
  if (n < 8) verdict = 'inconclusive'
  else if (oosReturnPct <= 0) verdict = 'no-edge'
  else if (tStat >= 2 && pValue <= 0.05) verdict = 'significant'
  else if (tStat >= 1) verdict = 'weak'
  else verdict = 'inconclusive'
  return { trades: n, expectancyPct: +(mean * 100).toFixed(2), tStat: +tStat.toFixed(2), sharpe, pValue, verdict }
}

/** Pure simulation over a candle series — no network access. */
export function simulate(
  candles: { t: number; c: number }[],
  opts: {
    strategy: string
    risk: string
    budgetUsd: number
    gasUsd: number
    days?: number
    // Override specific risk knobs on top of the chosen tier. Lets a
    // parameter-validation harness pin exact values (e.g. grid spacing/levels)
    // independently of what the live tiers happen to be set to. Production call
    // sites omit it, so behaviour is unchanged for them.
    paramsOverride?: Partial<RiskParams>
  },
): BacktestResult {
  const days = opts.days ?? 30
  const strat = strategyById(opts.strategy)
  const baseParams = RISK[opts.risk]
  if (!strat || !baseParams) return fail(days, 'bad parameters')
  if (!Number.isFinite(opts.budgetUsd) || opts.budgetUsd < 10) return fail(days, 'budget must be at least $10')
  if (candles.length < 50) return fail(days, 'not enough market history available right now (rate limited?) — try again shortly')
  const params: RiskParams = opts.paramsOverride ? { ...baseParams, ...opts.paramsOverride } : baseParams

  const gasUsd = opts.gasUsd
  let cash = opts.budgetUsd
  let qty = 0
  let avgCost = 0
  let costUsd = 0
  let fees = 0
  let swept = 0 // profit removed from the trading balance on each win (mirrors the engine's native sweep)
  let wins = 0
  let losses = 0
  let trades = 0
  let approved = false // first EVM sell of a token pays a one-time ERC-20 approve tx (gas) [P0-9]
  let peak = opts.budgetUsd
  let maxDD = 0
  const tradeRet: number[] = [] // realized return % per closing sell — drives the edge stats
  const state: Record<string, any> = {}
  const equity: { t: number; v: number }[] = []
  const closesAll = candles.map((c) => c.c)
  // Index where the out-of-sample (final third) segment begins; we snapshot the
  // portfolio equity entering it to measure walk-forward return.
  const oosStart = WARMUP + Math.floor((candles.length - WARMUP) * (1 - OOS_FRACTION))
  let equityAtOos: number | undefined

  for (let i = WARMUP; i < candles.length; i++) {
    const price = candles[i].c
    const ctx: Ctx = {
      price,
      closes: closesAll.slice(0, i + 1),
      params,
      state,
      position: { qty, avgCostUsd: avgCost, costUsd },
      budgetUsd: opts.budgetUsd,
      cashUsd: cash,
      now: candles[i].t,
    }
    const a = strat.decide(ctx)
    if (a?.type === 'buy' && a.usd > 1 && cash >= a.usd) {
      const fee = gasUsd + a.usd * SLIPPAGE
      const got = (a.usd - fee) / price
      // Cost basis includes the buy fee — identical to the live engine.
      avgCost = qty + got > 0 ? (avgCost * qty + a.usd) / (qty + got) : price
      qty += got
      costUsd += a.usd
      cash -= a.usd
      fees += fee
      trades++
    } else if (a?.type === 'sell' && qty > 0) {
      const sellQty = qty * Math.min(1, a.fraction)
      const gross = sellQty * price
      // The first sell of a token must approve the router before swapping — a separate,
      // one-time on-chain tx the live path pays but the backtest used to ignore, which
      // over-credited the first round trip (worst on tiny positions). [P0-9 / P2-7]
      const approveGas = approved ? 0 : gasUsd
      approved = true
      const fee = gasUsd + approveGas + gross * SLIPPAGE
      const costBasis = sellQty * avgCost
      const proceeds = gross - fee
      const pnl = proceeds - costBasis
      // Mirror the live engine's profit SWEEP: on a WIN only the cost basis returns to the
      // trading balance and the profit is swept to native (tracked separately), so cash —
      // which strategies size off — can't compound gains the engine takes off the table; on
      // a LOSS net proceeds return to cash. Without this the backtest over-states returns for
      // the high-turnover strategies (grid/DCA) the wizard surfaces. [no-compound]
      if (pnl > 0) { cash += costBasis; swept += pnl }
      else cash += proceeds
      if (costBasis > 0) tradeRet.push(pnl / costBasis) // realized return % of this closing sell
      costUsd = Math.max(0, costUsd - costBasis)
      qty -= sellQty
      if (qty < 1e-12) { qty = 0; costUsd = 0 }
      fees += fee
      trades++
      if (pnl >= 0) wins++
      else losses++
      if (a.exit || qty === 0) state.lastExitAt = candles[i].t
    }
    const v = cash + qty * price + swept // total equity = trading balance + open position + swept profit
    peak = Math.max(peak, v)
    maxDD = Math.max(maxDD, ((peak - v) / peak) * 100)
    if (i === oosStart) equityAtOos = v // equity entering the out-of-sample segment
    if (i % 4 === 0 || i === candles.length - 1) equity.push({ t: candles[i].t, v: +v.toFixed(2) })
  }

  const final = cash + qty * candles[candles.length - 1].c + swept
  const first = candles[WARMUP].c
  const last = candles[candles.length - 1].c
  // Out-of-sample return: portfolio change over the final third only (vs. where it
  // stood entering that segment). Falls back to the full return on a tiny window.
  const oosBase = equityAtOos ?? opts.budgetUsd
  const oosReturnPct = oosBase > 0 ? +(((final - oosBase) / oosBase) * 100).toFixed(2) : 0
  return {
    days,
    trades,
    wins,
    losses,
    returnPct: +(((final - opts.budgetUsd) / opts.budgetUsd) * 100).toFixed(2),
    oosReturnPct,
    buyHoldPct: +(((last - first) / first) * 100).toFixed(2),
    maxDrawdownPct: +maxDD.toFixed(2),
    feesUsd: +fees.toFixed(2),
    equity,
    edge: computeEdge(tradeRet, equity, oosReturnPct),
  }
}

export async function backtest(opts: {
  network: string
  tokenCg: string
  strategy: string
  risk: string
  budgetUsd: number
  days?: number
}): Promise<BacktestResult> {
  const net = networkById(opts.network)
  if (!net) return fail(opts.days ?? 30, 'unknown network')
  const candles = await getCandles(opts.tokenCg, opts.days ?? 30)
  return simulate(candles, { ...opts, gasUsd: net.avgGasUsd })
}

// ── Profit Finder ────────────────────────────────────────────────────────────

export interface FinderRow {
  network: string
  token: string
  tokenName: string
  strategy: string
  strategyName: string
  risk: string
  /** Out-of-sample return (final third) — the honest headline the rows rank on. */
  returnPct: number
  /** Full-window (in-sample) return — shown muted, for reference only; it overfits. */
  inSampleReturnPct: number
  /** Median OOS return across ALL strategy×risk combos tried for THIS token — the
   *  "typical" result. Shown so a best-of-N headline isn't mistaken for the expected
   *  outcome (selection / multiple-testing bias: the best of 15 tries flatters luck). */
  cohortMedianReturnPct: number
  profitUsd: number
  winRate: number | null
  maxDrawdownPct: number
  trades: number
  feesUsd: number
  /** Honest edge label from the backtest (verdict + key stats). Most rows are no-edge/inconclusive. */
  edge?: { verdict: EdgeStats['verdict']; tStat: number; sharpe: number; expectancyPct: number }
  change24hPct?: number | null
  /** How to act on this row: a curated bot, a paper market bot, or a screened snipe. */
  launch?:
    | { kind: 'bot'; network: string; token: string }
    | { kind: 'market'; cg: string; token: string; tokenName: string }
    | { kind: 'snipe'; network: string; token: string; poolAddress: string; tokenAddress: string }
    | null
}

export interface FinderResult {
  budgetUsd: number
  days: number
  rows: FinderRow[] // sorted by out-of-sample profit, best first
  skipped: string[] // tokens with no market data right now
  caveat?: string // honesty note (walk-forward / survivorship) shown above the table
}

// Shown for every Profit-Finder result; the momentum scopes append a stronger
// survivorship warning on top of this.
const WALK_FORWARD_NOTE =
  'Ranked on OUT-OF-SAMPLE return (the final third of the window, after a two-thirds warm-up) to fight overfit. The in-sample figure is shown muted for reference. Each coin is tried under many strategy/risk combos — the BEST is headlined, but its “typical” (median across all combos) result is shown too, because picking the best of many tries flatters luck. Costs (LP fee + slippage + gas, incl. the first-sell approval) are charged. Backtests are not a promise of future results.'
const SURVIVORSHIP_NOTE =
  'These coins were picked because they are ALREADY among the biggest recent movers — that selection is survivorship-biased and past momentum rarely repeats. Treat this as a starting point to research, not a prediction.'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Median of a numeric list (0 for empty). Used for the per-coin "typical config" figure. */
function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Stamp every row of one coin's strategy×risk cohort with the cohort's median OOS
 *  return, so the UI can show the "typical" result beside the best-of-N headline. */
function stampCohortMedian(cohort: FinderRow[]): FinderRow[] {
  const med = +median(cohort.map((c) => c.returnPct)).toFixed(2)
  for (const c of cohort) c.cohortMedianReturnPct = med
  return cohort
}

/**
 * "Here is $X — where would it have made the most?" Backtests every
 * strategy × risk tier for the chosen coin(s) over the same real history
 * and ranks the outcomes by profit.
 */
export async function profitFinder(opts: {
  budgetUsd: number
  network: string
  token?: string // symbol; omitted = every coin on the network
  scope?: 'curated' | 'top100' | 'trending'
}): Promise<FinderResult | { error: string }> {
  const net = networkById(opts.network)
  if (!net) return { error: 'unknown network' }
  const budget = Number(opts.budgetUsd)
  if (!Number.isFinite(budget) || budget < 10) return { error: 'budget must be at least $10' }
  if (opts.scope === 'top100') return top100Finder(budget)
  if (opts.scope === 'trending') return trendingFinder(budget, net.id)
  const tokens = opts.token ? net.tokens.filter((t) => t.symbol === opts.token) : net.tokens
  if (!tokens.length) return { error: 'unknown token' }

  const rows: FinderRow[] = []
  const skipped: string[] = []
  let fetched = 0
  for (const tok of tokens) {
    if (fetched > 0) await wait(1100) // stay under CoinGecko free-tier rate limits
    const candles = await getCandles(tok.cg, 30)
    fetched++
    if (candles.length < 50) {
      skipped.push(tok.symbol)
      continue
    }
    const cohort: FinderRow[] = []
    for (const s of STRATEGIES) {
      for (const risk of Object.keys(RISK)) {
        const r = simulate(candles, { strategy: s.id, risk, budgetUsd: budget, gasUsd: net.avgGasUsd })
        if (r.error) continue
        cohort.push({
          network: net.id,
          token: tok.symbol,
          tokenName: tok.name,
          strategy: s.id,
          strategyName: s.name,
          risk,
          returnPct: r.oosReturnPct,
          inSampleReturnPct: r.returnPct,
          cohortMedianReturnPct: 0,
          profitUsd: +((budget * r.oosReturnPct) / 100).toFixed(2),
          winRate: r.wins + r.losses > 0 ? +((r.wins / (r.wins + r.losses)) * 100).toFixed(0) : null,
          maxDrawdownPct: r.maxDrawdownPct,
          trades: r.trades,
          feesUsd: r.feesUsd,
          edge: { verdict: r.edge.verdict, tStat: r.edge.tStat, sharpe: r.edge.sharpe, expectancyPct: r.edge.expectancyPct },
          launch: { kind: 'bot', network: net.id, token: tok.symbol },
        })
      }
    }
    rows.push(...stampCohortMedian(cohort))
  }
  rows.sort((a, b) => b.profitUsd - a.profitUsd)
  return { budgetUsd: budget, days: 30, rows, skipped, caveat: WALK_FORWARD_NOTE }
}

// ── Scope: top-100 momentum ──────────────────────────────────────────────────
// Pulls the CoinGecko top-100 by market cap, ranks by 24h momentum (the coins
// "trending and likely to profit from"), and backtests the strongest movers.

const STABLE_OR_WRAPPED = new Set([
  'usdt', 'usdc', 'dai', 'usds', 'usde', 'usd1', 'fdusd', 'tusd', 'pyusd', 'usdt0',
  'wbtc', 'weth', 'wsteth', 'steth', 'weeth', 'cbbtc', 'reth', 'meth', 'rseth', 'cbeth', 'lbtc', 'wbeth', 'jitosol', 'bnsol', 'wbnb',
])

let marketsCache: { at: number; rows: any[] } | null = null

async function topMarkets(): Promise<any[]> {
  if (marketsCache && Date.now() - marketsCache.at < 300_000) return marketsCache.rows
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h',
      { headers: { accept: 'application/json' } },
    )
    if (!res.ok) return marketsCache?.rows ?? []
    const rows = await res.json()
    if (Array.isArray(rows) && rows.length) marketsCache = { at: Date.now(), rows }
    return marketsCache?.rows ?? []
  } catch {
    return marketsCache?.rows ?? []
  }
}

/** Map a CoinGecko id to a curated (network, symbol) so the row is launchable. */
function curatedHome(cg: string): { network: string; token: string } | null {
  for (const n of NETWORKS) {
    const t = n.tokens.find((x) => x.cg === cg)
    if (t) return { network: n.id, token: t.symbol }
  }
  return null
}

// A recommendable mover must have a real 24h tape AND turnover (recent activity).
// A low-volume "+25%" coin is a dead/manipulated pump you couldn't size into without
// huge slippage — never surface it as a profit candidate.
const MIN_VOL_USD = 1_000_000
const MIN_TURNOVER = 0.01 // 24h volume ≥ 1% of market cap
function liquidMover(m: any): boolean {
  const vol = Number(m.total_volume) || 0
  const mcap = Number(m.market_cap) || 0
  return vol >= MIN_VOL_USD && (mcap <= 0 || vol / mcap >= MIN_TURNOVER)
}

async function top100Finder(budget: number): Promise<FinderResult | { error: string }> {
  const markets = await topMarkets()
  if (!markets.length) return { error: 'market data unavailable right now — try again in a minute' }
  const movers = markets
    .filter((m) => m?.id && !STABLE_OR_WRAPPED.has(String(m.symbol).toLowerCase()))
    .filter(liquidMover) // ignore dead/illiquid coins — don't recommend what you can't actually trade
    .sort((a, b) => (b.price_change_percentage_24h ?? -999) - (a.price_change_percentage_24h ?? -999))
    .slice(0, 6)

  const rows: FinderRow[] = []
  const skipped: string[] = []
  let fetched = 0
  for (const m of movers) {
    if (fetched > 0) await wait(6000) // free-tier pacing — the engine shares this budget
    let candles = await getCandles(m.id, 30)
    if (candles.length < 50) {
      // A short result means CoinGecko has us in its penalty box, not that the
      // coin lacks history — wait the backoff out once, then retry.
      await wait(backoffRemainingMs() + 2000)
      candles = await getCandles(m.id, 30)
    }
    fetched++
    const symbol = String(m.symbol).toUpperCase()
    if (candles.length < 50) {
      skipped.push(symbol)
      continue
    }
    const home = curatedHome(m.id)
    const cohort: FinderRow[] = []
    for (const s of STRATEGIES) {
      for (const risk of Object.keys(RISK)) {
        const r = simulate(candles, { strategy: s.id, risk, budgetUsd: budget, gasUsd: home ? networkById(home.network)!.avgGasUsd : 0.02 })
        if (r.error) continue
        cohort.push({
          network: home?.network ?? 'market',
          token: symbol,
          tokenName: m.name ?? symbol,
          strategy: s.id,
          strategyName: s.name,
          risk,
          returnPct: r.oosReturnPct,
          inSampleReturnPct: r.returnPct,
          cohortMedianReturnPct: 0,
          profitUsd: +((budget * r.oosReturnPct) / 100).toFixed(2),
          winRate: r.wins + r.losses > 0 ? +((r.wins / (r.wins + r.losses)) * 100).toFixed(0) : null,
          maxDrawdownPct: r.maxDrawdownPct,
          trades: r.trades,
          feesUsd: r.feesUsd,
          edge: { verdict: r.edge.verdict, tStat: r.edge.tStat, sharpe: r.edge.sharpe, expectancyPct: r.edge.expectancyPct },
          change24hPct: m.price_change_percentage_24h != null ? +Number(m.price_change_percentage_24h).toFixed(2) : null,
          // Curated coins launch on their home network (live-capable); the rest
          // launch as paper "market" bots priced straight from CoinGecko.
          launch: home ? { kind: 'bot', ...home } : { kind: 'market', cg: m.id, token: symbol, tokenName: m.name ?? symbol },
        })
      }
    }
    rows.push(...stampCohortMedian(cohort))
  }
  if (!rows.length && skipped.length)
    return { error: 'market data provider is rate-limiting — try again in a minute' }
  rows.sort((a, b) => b.profitUsd - a.profitUsd)
  return { budgetUsd: budget, days: 30, rows, skipped, caveat: `${SURVIVORSHIP_NOTE} ${WALK_FORWARD_NOTE}` }
}

// ── Scope: trending-safe pools ───────────────────────────────────────────────
// Trending pools on the chosen network that already passed the FULL safety
// gate (verified · sellable · distributed holders), backtested on their real
// GeckoTerminal hourly candles. Launching one arms a screened snipe.

async function gtHourlyCloses(gt: string, poolAddress: string): Promise<{ t: number; c: number }[]> {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${gt}/pools/${poolAddress}/ohlcv/hour?limit=1000&currency=usd`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return []
    const data: any = await res.json()
    const list: any[] = data?.data?.attributes?.ohlcv_list ?? []
    return list
      .map((row) => ({ t: Number(row[0]) * 1000, c: Number(row[4]) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.c) && x.c > 0)
      .sort((a, b) => a.t - b.t)
  } catch {
    return []
  }
}

async function trendingFinder(budget: number, network: string): Promise<FinderResult | { error: string }> {
  const net = networkById(network)!
  const { pools, error } = await discoverSafePools(network, 'trending')
  if (!pools.length) return { error: error ?? 'no trending tokens pass the safety gate right now — try again in a few minutes' }

  const rows: FinderRow[] = []
  const skipped: string[] = []
  for (const p of pools.slice(0, 5)) {
    const candles = await gtHourlyCloses(net.gt, p.poolAddress)
    if (candles.length < 50) {
      skipped.push(p.tokenSymbol)
      continue
    }
    const days = Math.max(1, Math.round((candles[candles.length - 1].t - candles[0].t) / 86_400_000))
    const cohort: FinderRow[] = []
    for (const s of STRATEGIES) {
      for (const risk of Object.keys(RISK)) {
        const r = simulate(candles, { strategy: s.id, risk, budgetUsd: budget, gasUsd: net.avgGasUsd, days })
        if (r.error) continue
        cohort.push({
          network: net.id,
          token: p.tokenSymbol,
          tokenName: p.tokenName,
          strategy: s.id,
          strategyName: s.name,
          risk,
          returnPct: r.oosReturnPct,
          inSampleReturnPct: r.returnPct,
          cohortMedianReturnPct: 0,
          profitUsd: +((budget * r.oosReturnPct) / 100).toFixed(2),
          winRate: r.wins + r.losses > 0 ? +((r.wins / (r.wins + r.losses)) * 100).toFixed(0) : null,
          maxDrawdownPct: r.maxDrawdownPct,
          trades: r.trades,
          feesUsd: r.feesUsd,
          edge: { verdict: r.edge.verdict, tStat: r.edge.tStat, sharpe: r.edge.sharpe, expectancyPct: r.edge.expectancyPct },
          change24hPct: p.priceChange1hPct ?? null,
          launch: { kind: 'snipe', network: net.id, token: p.tokenSymbol, poolAddress: p.poolAddress, tokenAddress: p.tokenAddress },
        })
      }
    }
    rows.push(...stampCohortMedian(cohort))
  }
  rows.sort((a, b) => b.profitUsd - a.profitUsd)
  return { budgetUsd: budget, days: 30, rows, skipped, caveat: `${SURVIVORSHIP_NOTE} ${WALK_FORWARD_NOTE}` }
}
