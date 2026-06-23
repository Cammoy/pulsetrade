// Smart Money intelligence: aggregate what the tracked wallets are actually
// buying / selling / holding (in PRICED tokens — curated + mainnet majors, so
// it's clean signal, not airdrop spam), then have Gemini turn it into a concise,
// up-to-date narrative with actionable highlights. Cached so the model is hit at
// most once every 10 min regardless of how many clients are watching.

import { state } from './store.js'
import { ensureSeeded, trackingReady, walletEvents, looksLikeSpamSymbol, KNOWN_MAJOR_SYMBOLS, type SmartMoneyEvent } from './smartmoney.js'
import { geminiJson, geminiReady } from './gemini.js'

export interface TokenFlow {
  network: string
  token: string
  tokenAddress: string
  buyers: number // distinct wallets buying
  sellers: number
  buyUsd: number
  sellUsd: number
  netUsd: number // buyUsd − sellUsd (the accumulation/distribution signal)
  lastTs: number
  wallets: string[] // labels of the wallets driving the net flow (dominant side)
  curated: boolean // tradeable in-app (a curated-network token) ⇒ one-click action
}

export interface NotableMove {
  wallet: string
  side: 'buy' | 'sell'
  token: string
  network: string
  usd: number
  ts: number
}

/** A non-major token the whales are actively accumulating — the "new coins"
 *  radar. Often unpriced (small/new), so we surface research links instead. */
export interface EmergingCoin {
  network: string
  token: string
  tokenAddress: string
  buyers: number // distinct wallets buying
  buys: number // total buy transfers (DCA accumulation signal)
  usd: number | null // total bought where priced
  wallets: string[]
  lastTs: number
}

export interface SmartMoneyOverview {
  windowDays: number
  totalBuyUsd: number
  totalSellUsd: number
  netUsd: number
  activeWallets: number
  stableNetUsd: number // net flow INTO stablecoins (+ = de-risking / risk-off)
  accumulating: TokenFlow[] // top net-bought RISK assets (stables excluded)
  distributing: TokenFlow[] // top net-sold RISK assets
  emerging: EmergingCoin[] // "new coins" radar — non-major tokens being accumulated
  notable: NotableMove[] // biggest individual RISK-asset trades
  /** Cumulative net USD flow over the window (oldest→newest) — the accumulation
   *  trajectory. risk = non-stable assets, stable = stablecoins. */
  flowSeries: { t: number; risk: number; stable: number }[]
}

// Stablecoins aren't directional bets — moving USDC is risk parking, not a
// conviction trade. Tracked separately as a sentiment signal, not a "buy".
const STABLES = new Set(['usdc', 'usdt', 'dai', 'usds', 'usde', 'fdusd', 'tusd', 'busd', 'pyusd', 'frax', 'usdc.e', 'usdbc', 'usd1', 'usdt0', 'mim', 'gusd', 'lusd'])
const isStable = (sym: string) => STABLES.has(sym.toLowerCase())

/**
 * Pure: aggregate a flat list of (labelled) wallet events into the overview.
 * Only PRICED events count — unpriced long-tail / airdrop spam carries no
 * reliable USD signal, so it's excluded here (the per-wallet view still shows it).
 */
export function computeOverview(events: SmartMoneyEvent[], now: number, windowDays = 30): SmartMoneyOverview {
  const cutoff = now - windowDays * 86_400_000
  const recent = events.filter((e) => e.ts >= cutoff && e.usd !== null)
  const byTok = new Map<string, { network: string; token: string; tokenAddress: string; buyers: Set<string>; sellers: Set<string>; buyLabels: Set<string>; sellLabels: Set<string>; buyUsd: number; sellUsd: number; lastTs: number; curated: boolean }>()
  let totalBuyUsd = 0
  let totalSellUsd = 0
  const wallets = new Set<string>()
  for (const e of recent) {
    const usd = e.usd ?? 0
    wallets.add(e.wallet.toLowerCase())
    const key = `${e.network}:${e.tokenAddress.toLowerCase()}`
    const row = byTok.get(key) ?? { network: e.network, token: e.token, tokenAddress: e.tokenAddress, buyers: new Set<string>(), sellers: new Set<string>(), buyLabels: new Set<string>(), sellLabels: new Set<string>(), buyUsd: 0, sellUsd: 0, lastTs: 0, curated: false }
    if (e.side === 'buy') {
      row.buyers.add(e.wallet.toLowerCase())
      row.buyLabels.add(e.label)
      row.buyUsd += usd
      totalBuyUsd += usd
    } else {
      row.sellers.add(e.wallet.toLowerCase())
      row.sellLabels.add(e.label)
      row.sellUsd += usd
      totalSellUsd += usd
    }
    if (e.curated) row.curated = true
    row.lastTs = Math.max(row.lastTs, e.ts)
    byTok.set(key, row)
  }
  const allFlows: TokenFlow[] = [...byTok.values()].map((r) => {
    const netUsd = Math.round(r.buyUsd - r.sellUsd)
    return {
      network: r.network,
      token: r.token,
      tokenAddress: r.tokenAddress,
      buyers: r.buyers.size,
      sellers: r.sellers.size,
      buyUsd: Math.round(r.buyUsd),
      sellUsd: Math.round(r.sellUsd),
      netUsd,
      lastTs: r.lastTs,
      // The wallets driving the net direction (buyers if accumulating, else sellers).
      wallets: [...(netUsd >= 0 ? r.buyLabels : r.sellLabels)].slice(0, 4),
      curated: r.curated,
    }
  })
  const stableNetUsd = allFlows.filter((f) => isStable(f.token)).reduce((s, f) => s + f.netUsd, 0)
  const risk = allFlows.filter((f) => !isStable(f.token)) // directional flows only

  // Cumulative net-flow trajectory: walk events oldest→newest, accruing risk vs
  // stable net USD, sampled to ~40 points for a clean chart.
  const asc = [...recent].sort((a, b) => a.ts - b.ts)
  const raw: { t: number; risk: number; stable: number }[] = []
  let cumRisk = 0
  let cumStable = 0
  for (const e of asc) {
    const signed = (e.side === 'buy' ? 1 : -1) * (e.usd ?? 0)
    if (isStable(e.token)) cumStable += signed
    else cumRisk += signed
    raw.push({ t: e.ts, risk: Math.round(cumRisk), stable: Math.round(cumStable) })
  }
  const step = Math.max(1, Math.ceil(raw.length / 40))
  const flowSeries = raw.filter((_, i) => i % step === 0 || i === raw.length - 1)

  // "New coins" radar: non-stable, non-spam, non-major tokens being genuinely
  // ACCUMULATED. The hard part is that a "buy" is just an inbound transfer, and
  // famous wallets (Vitalik et al.) are spam magnets — so we must separate real
  // accumulation from airdrop/visibility spam WITHOUT price data (these tokens are
  // unlisted by definition). Two structural tells drive the filter: (1) genuine
  // alpha shows CONSENSUS — multiple distinct smart wallets, not one inbox getting
  // sprayed; (2) it shows REPEAT conviction — more buys than buyers — which a
  // one-shot airdrop campaign can't fake. See realAccumulation() below.
  const SPAM_FLOOD = 40 // a single wallet "receiving" a token >40× in 30d is a spam contract, not a trader
  // The displayed top-8 accumulating list, computed ONCE so the 'emerging' dedup set
  // (accAddrs) excludes exactly the tokens shown under 'accumulating' — not an arbitrary
  // insertion-order first-8, which diverges from the sorted list whenever >8 tokens are
  // net-bought and lets a top-accumulating token leak into the emerging radar. [emerging-dedup]
  const accumulating = risk.filter((f) => f.netUsd > 0).sort((a, b) => b.netUsd - a.netUsd).slice(0, 8)
  const accAddrs = new Set(accumulating.map((f) => `${f.network}:${f.tokenAddress.toLowerCase()}`))
  const emergeMap = new Map<string, { network: string; token: string; tokenAddress: string; buyers: Set<string>; buyLabels: Set<string>; buys: number; sells: number; usd: number; lastTs: number }>()
  for (const e of events) {
    if (e.ts < cutoff || isStable(e.token) || looksLikeSpamSymbol(e.token) || KNOWN_MAJOR_SYMBOLS.has(e.token.toUpperCase())) continue
    const key = `${e.network}:${e.tokenAddress.toLowerCase()}`
    const row = emergeMap.get(key) ?? { network: e.network, token: e.token, tokenAddress: e.tokenAddress, buyers: new Set<string>(), buyLabels: new Set<string>(), buys: 0, sells: 0, usd: 0, lastTs: 0 }
    if (e.side === 'buy') {
      row.buyers.add(e.wallet.toLowerCase())
      row.buyLabels.add(e.label)
      row.buys++
      row.usd += e.usd ?? 0
    } else {
      row.sells++
    }
    row.lastTs = Math.max(row.lastTs, e.ts)
    emergeMap.set(key, row)
  }
  const realAccumulation = (r: { buys: number; sells: number; buyers: Set<string> }) => {
    if (r.buys <= r.sells) return false // net-bought only
    const n = r.buyers.size
    // A single wallet "receiving" an UNLISTED token is indistinguishable from spam
    // (airdrop / address-poisoning), no matter the count — so require CONSENSUS:
    // ≥2 distinct smart wallets. Plus repeat conviction (buys > buyers) to reject
    // coordinated airdrop campaigns that hit several famous wallets exactly once.
    if (n < 2) return false
    return r.buys > n && r.buys <= n * SPAM_FLOOD
  }
  const emerging: EmergingCoin[] = [...emergeMap.values()]
    .filter((r) => realAccumulation(r) && !accAddrs.has(`${r.network}:${r.tokenAddress.toLowerCase()}`))
    .map((r) => ({ network: r.network, token: r.token, tokenAddress: r.tokenAddress, buyers: r.buyers.size, buys: r.buys, usd: r.usd > 0 ? Math.round(r.usd) : null, wallets: [...r.buyLabels].slice(0, 4), lastTs: r.lastTs }))
    .sort((a, b) => b.buyers - a.buyers || b.buys - a.buys || b.lastTs - a.lastTs)
    .slice(0, 12)

  return {
    windowDays,
    totalBuyUsd: Math.round(totalBuyUsd),
    totalSellUsd: Math.round(totalSellUsd),
    netUsd: Math.round(totalBuyUsd - totalSellUsd),
    activeWallets: wallets.size,
    stableNetUsd: Math.round(stableNetUsd),
    accumulating,
    distributing: risk.filter((f) => f.netUsd < 0).sort((a, b) => a.netUsd - b.netUsd).slice(0, 8),
    emerging,
    notable: recent
      .filter((e) => (e.usd ?? 0) >= 5000 && !isStable(e.token))
      .map((e) => ({ wallet: e.label, side: e.side, token: e.token, network: e.network, usd: Math.round(e.usd ?? 0), ts: e.ts }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 12),
    flowSeries,
  }
}

/** Gather recent activity across every tracked wallet (cached per wallet/chain). */
async function gatherActivity(): Promise<SmartMoneyEvent[]> {
  ensureSeeded()
  if (!trackingReady()) return []
  const all: SmartMoneyEvent[] = []
  for (const w of state.wallets) {
    const events = await walletEvents(w.address, { allTokens: true }).catch(() => [])
    all.push(...events)
  }
  return all
}

export interface SmartInsight {
  headline: string
  summary: string
  sentiment: 'risk-on' | 'neutral' | 'risk-off'
  rotation: string
  highlights: { title: string; detail: string }[]
  watch: string[]
}

const INSIGHT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    summary: { type: 'STRING' },
    sentiment: { type: 'STRING', enum: ['risk-on', 'neutral', 'risk-off'] },
    rotation: { type: 'STRING' },
    highlights: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, detail: { type: 'STRING' } }, required: ['title', 'detail'] } },
    watch: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['headline', 'summary', 'sentiment', 'rotation', 'highlights', 'watch'],
}

const SYSTEM =
  "You are a sharp on-chain analyst writing a smart-money intelligence brief for a crypto trader. You're given REAL aggregated wallet flow data (what well-known traders/whales bought and sold recently, in USD). Write a concise, specific, useful brief. Cite the actual tokens and dollar amounts. Be balanced and risk-aware — note when signals are thin or mixed. Never invent data not in the input. Output ONLY the JSON object."

function brief(o: SmartMoneyOverview): string {
  const flow = (f: TokenFlow) => `${f.token} (${f.network}): net ${f.netUsd >= 0 ? '+' : ''}$${f.netUsd.toLocaleString()} — ${f.buyers} buyer(s) bought $${f.buyUsd.toLocaleString()}, ${f.sellers} seller(s) sold $${f.sellUsd.toLocaleString()}`
  return [
    `Window: last ${o.windowDays} days. Active tracked wallets: ${o.activeWallets}.`,
    `Aggregate: bought $${o.totalBuyUsd.toLocaleString()}, sold $${o.totalSellUsd.toLocaleString()}, net ${o.netUsd >= 0 ? '+' : ''}$${o.netUsd.toLocaleString()}.`,
    `Stablecoin net flow: ${o.stableNetUsd >= 0 ? '+' : ''}$${o.stableNetUsd.toLocaleString()} (positive = moving INTO stables = de-risking/risk-off; negative = deploying stables into risk assets).`,
    `ACCUMULATING (net bought):\n${o.accumulating.map((f) => '  - ' + flow(f)).join('\n') || '  (none)'}`,
    `DISTRIBUTING (net sold):\n${o.distributing.map((f) => '  - ' + flow(f)).join('\n') || '  (none)'}`,
    `NEW/EMERGING COINS being accumulated (smaller/newer tokens, often unpriced):\n${o.emerging.map((c) => `  - ${c.token} (${c.network}): ${c.buyers} wallet(s), ${c.buys} buys${c.usd ? `, $${c.usd.toLocaleString()}` : ''} — ${c.wallets.join(', ')}`).join('\n') || '  (none)'}`,
    `NOTABLE TRADES:\n${o.notable.map((n) => `  - ${n.wallet}: ${n.side.toUpperCase()} $${n.usd.toLocaleString()} ${n.token} (${n.network})`).join('\n') || '  (none)'}`,
  ].join('\n\n')
}

let cache: { at: number; overview: SmartMoneyOverview; insight: SmartInsight | null } | null = null
let inflight: Promise<void> | null = null
const TTL = 10 * 60_000

/**
 * The full Smart Money intelligence payload: the aggregated overview plus a
 * Gemini-written narrative. Cached 10 min; refreshes in the background so a
 * request never blocks on the model. `needsTracking`/`needsAi` tell the UI which
 * key (if any) is missing.
 */
export async function smartMoneyIntelligence(now = Date.now()): Promise<{ overview: SmartMoneyOverview | null; insight: SmartInsight | null; needsTracking: boolean; needsAi: boolean; generatedAt: number | null }> {
  const needsTracking = !trackingReady()
  const needsAi = !geminiReady()
  if (needsTracking) return { overview: null, insight: null, needsTracking, needsAi, generatedAt: null }

  const fresh = cache && now - cache.at < TTL
  if (!fresh && !inflight) {
    inflight = (async () => {
      const events = await gatherActivity()
      const overview = computeOverview(events, Date.now())
      // Only spend a Gemini call when there's real flow to analyse.
      const hasFlow = overview.accumulating.length + overview.distributing.length > 0
      const insight = hasFlow ? await geminiJson<SmartInsight>(SYSTEM, brief(overview), INSIGHT_SCHEMA) : null
      cache = { at: Date.now(), overview, insight }
    })()
      .catch((e) => console.error('[insights] failed', e))
      .finally(() => {
        inflight = null
      })
  }
  // Block only on the very first build; thereafter serve cache and refresh behind it.
  if (!cache && inflight) await inflight

  return {
    overview: cache?.overview ?? null,
    insight: cache?.insight ?? null,
    needsTracking,
    needsAi,
    generatedAt: cache?.at ?? null,
  }
}
