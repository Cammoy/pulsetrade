import { useState } from 'react'
import { useStore } from '../store'

interface Section {
  id: string
  title: string
  body: React.ReactNode
}

const P = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <p className={className ?? 'mb-3 text-sm leading-relaxed text-slate-300'}>{children}</p>
)
const H = ({ children }: { children: React.ReactNode }) => <h4 className="mt-4 mb-1.5 text-sm font-bold text-white">{children}</h4>
const LI = ({ children }: { children: React.ReactNode }) => <li className="text-sm leading-relaxed text-slate-300">{children}</li>
const B = ({ children }: { children: React.ReactNode }) => <strong className="text-slate-100">{children}</strong>

const SECTIONS: Section[] = [
  {
    id: 'start',
    title: 'Getting started',
    body: (
      <>
        <P>PulseTrade runs automated trading bots on seven networks — five low-fee EVM chains (Base, Arbitrum, Optimism, Polygon, BNB) plus Solana and the Internet Computer. Bots place buys and sells for you continuously and take profit in each chain’s <B>native coin</B> — or in <B>USDT</B> if you prefer dollars: every bot has an “auto-sell profits to” setting. Either way you never end up stuck holding an illiquid token.</P>
        <H>Paper vs Live</H>
        <P><B>Paper mode</B> (the default) trades with real, live market prices but simulated money — the honest way to prove a setup before risking funds. <B>Live mode</B> executes real on-chain swaps once per-chain keys are configured (0x for EVM chains, Jupiter for Solana — see “Going live”).</P>
        <P>Every fill — paper or live — is recorded with fees and slippage, and your realized P&L is persisted to a monthly ledger that survives restarts and bot deletion.</P>
      </>
    ),
  },
  {
    id: 'bots',
    title: 'Creating bots',
    body: (
      <>
        <P>Click <B>New Bot</B> for the guided wizard: connect a wallet (optional), choose a network and coin, pick a strategy and risk tolerance, set a budget, and optionally restrict trading to specific days and hours.</P>
        <H>Running many at once</H>
        <P>You can launch any number of bots simultaneously — the same coin under several risk tolerances, or many coins at once. Each bot keeps its own cash, position, schedule and P&L, so you can compare tolerances side by side. The dashboard shows a P&L-by-tolerance breakdown.</P>
        <H>Schedules</H>
        <P>A bot can trade 24/7 or only within chosen day/hour windows (overnight windows are supported). Outside its window a bot sleeps and resumes automatically.</P>
      </>
    ),
  },
  {
    id: 'strategies',
    title: 'Strategies',
    body: (
      <>
        <P>All four strategies run the identical code in backtests and live trading — what you backtest is exactly what trades.</P>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>Grid</B> — lays a ladder of buys below an anchor and sells one rung higher as price oscillates. Earns from sideways chop.</LI>
          <LI><B>RSI Mean Reversion</B> — buys oversold conditions, exits on overbought readings or the risk-tier take-profit / stop-loss.</LI>
          <LI><B>EMA Momentum</B> — enters when the fast EMA crosses above the slow EMA (confirmed uptrend), exits on the reverse cross or stop.</LI>
          <LI><B>Smart DCA</B> — buys fixed slices on a schedule, but only below the 24h average; sells the stack once it’s in profit.</LI>
        </ul>
        <P><B>Risk tolerance</B> (Conservative / Balanced / Aggressive) scales position size, stop-loss, take-profit, grid spacing, RSI thresholds and cooldowns — so two bots on the same coin behave very differently.</P>
      </>
    ),
  },
  {
    id: 'finder',
    title: 'Profit Finder',
    body: (
      <>
        <P>Open <B>Profit Finder</B>, enter a stake (e.g. $100), and choose a scope. It backtests every strategy × risk tolerance over the same real history — including gas and slippage — and ranks the outcomes by profit.</P>
        <H>Three scopes</H>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>Curated</B> — every coin on one network.</LI>
          <LI><B>Top-100 movers</B> — the strongest 24h gainers among the top-100 coins by market cap. Curated ones launch on their live-capable home network; every other candidate launches instantly as a <B>paper market bot</B> priced live from the market — one click, trading immediately.</LI>
          <LI><B>Trending (safe)</B> — trending pools that pass the full safety screen, backtested on their real pool candles and launchable as screened snipes.</LI>
        </ul>
        <P>The top result is your best historical configuration for that stake. Results are evidence, not a guarantee — past performance never assures future returns. The top-100 scan is paced for the free data tier, so it can take a minute or two.</P>
      </>
    ),
  },
  {
    id: 'smart-money',
    title: 'Smart money & following',
    body: (
      <>
        <P>The <B>🐋 Smart Money</B> panel tracks wallets and lets you trade alongside them. It ships with a permanent watchlist of publicly documented wallets (Wintermute, DWF Labs, machibigbrother.eth, James Fickel, gcr.eth, …) and you can add your own.</P>
        <H>Three tabs</H>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>Activity</B> — a live feed of tracked wallets’ buys and sells of curated tokens, per network. Hit <B>Copy</B> on any row to mirror that one token manually.</LI>
          <LI><B>Accounts</B> — open any wallet for its trading history: totals, a cumulative net-flow chart, and a per-token breakdown of buys, sells, volume and net flow.</LI>
          <LI><B>Watchlist</B> — add or remove wallets by address.</LI>
        </ul>
        <H>Trading with an account</H>
        <P><B>Manually</B>: pick one token and launch a copy bot that mirrors that wallet’s entries and exits in that token. <B>Automatically</B>: from an account’s detail view, hand it a budget and a per-trade size — whenever the wallet buys <em>any</em> curated token, a mirror bot enters with your size and exits when the wallet sells (plus your risk-tier stops). Returns recycle into the next mirror, up to a concurrency limit. Stop or liquidate any time.</P>
        <P>Live wallet data needs a free <code className="rounded bg-white/10 px-1 py-0.5 text-xs">ETHERSCAN_API_KEY</code>; the watchlist and follow setup work without it and act once tracking is enabled. Wallet tracking is EVM-only.</P>
      </>
    ),
  },
  {
    id: 'sniper',
    title: 'Sniper',
    body: (
      <>
        <P>The <B>Sniper</B> surfaces freshly created and trending liquidity pools across the supported networks. Selecting a token runs a mandatory safety screen; if it passes, you set a budget plus take-profit, stop-loss, max-hold time and an optional trailing stop, then snipe.</P>
        <H>How a snipe behaves</H>
        <P>It buys the full budget immediately, then exits the entire position on the first of: take-profit, stop-loss, trailing stop, or max-hold timeout — sweeping proceeds to the native coin. Once it exits, the bot retires itself.</P>
        <P><B>New tokens are extremely high-risk.</B> The screen blocks the worst traps but cannot eliminate volatility — size snipes small.</P>
      </>
    ),
  },
  {
    id: 'safety',
    title: 'Risk screening',
    body: (
      <>
        <P>Before any snipe, PulseTrade screens the token through two independent security providers — <B>GoPlus Security</B> and <B>honeypot.is</B> — and scores it 0–100 with named flags.</P>
        <H>What it checks</H>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>Honeypots / non-sellable contracts</B> — simulates a sell; if you could buy but not sell, the token is blocked.</LI>
          <LI><B>Rug-pull setups</B> — unlocked liquidity the team can withdraw, mintable supply, owner-editable balances.</LI>
          <LI><B>Exit traps</B> — extreme sell taxes, transfer pausing, blacklists, trading cooldowns, modifiable max-tx limits.</LI>
          <LI><B>Contract control</B> — hidden owners, reclaimable ownership, self-destruct, upgradeable proxies, unverified source.</LI>
        </ul>
        <P>Any <B>critical</B> flag makes the token non-tradeable with <B>no override</B>. If neither provider returns data, the token is treated as unsafe — the engine never trades blind.</P>
        <P>Note: the screen is a hard gate only for the Sniper. The curated wizard tokens are hand-picked blue-chips; their screen is shown for transparency but is advisory, because canonical bridged tokens can legitimately show mint/LP flags.</P>
      </>
    ),
  },
  {
    id: 'pnl',
    title: 'Tracking P&L',
    body: (
      <>
        <P>Each bot shows realized and unrealized P&L, win rate, fees, position value and the amount of native coin taken as profit. Open a bot for its price chart with buy/sell markers and a plain-English activity log of every decision.</P>
        <P>The <B>Monthly P&L</B> panel is a persisted ledger: realized P&L, win rate, fees, native swept, volume and a per-tolerance breakdown for each calendar month. It’s independent of the trade list, so it survives trade trimming and even bot deletion.</P>
      </>
    ),
  },
  {
    id: 'live',
    title: 'Going live & safety',
    body: (
      <>
        <H>Enabling live trading</H>
        <P>Use a <B>dedicated</B> bot wallet per chain — never your main wallet — and fund it with only what the bot may trade. Configure the chains you want, restart, then flip the header toggle to Live. Live mode activates if <em>any</em> chain’s keys are set; bots on unconfigured chains keep trading in paper.</P>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>EVM chains (Base, Arbitrum, Optimism, Polygon, BNB)</B> — set <code className="rounded bg-white/10 px-1 py-0.5 text-xs">ZEROX_API_KEY</code> (free at 0x.org) and <code className="rounded bg-white/10 px-1 py-0.5 text-xs">BOT_WALLET_KEY</code>. Swaps route through the 0x API with a 1% slippage cap.</LI>
          <LI><B>Solana</B> — set <code className="rounded bg-white/10 px-1 py-0.5 text-xs">SOLANA_WALLET_KEY</code> (a base58 secret key for a dedicated Solana wallet) and optionally <code className="rounded bg-white/10 px-1 py-0.5 text-xs">SOLANA_RPC_URL</code>. Swaps route through the Jupiter aggregator.</LI>
          <LI><B>Internet Computer (ICP)</B> — trades live-price in paper for now. KongSwap and ICPSwap are canister-only DEXes with no REST API, so the on-chain executor is pending a verified canister integration.</LI>
        </ul>
        <P>Paper accounting continues in parallel as the source of truth for P&L. Sniping and wallet tracking remain EVM-only.</P>
        <P className="rounded-xl bg-amber-500/10 p-3 text-amber-200">Nothing here is financial advice. Backtested performance does not guarantee future results. Crypto is volatile and you can lose money — only trade what you can afford to lose.</P>
      </>
    ),
  },
]

export default function Docs() {
  const { openDocs } = useStore()
  const [active, setActive] = useState(SECTIONS[0].id)
  const section = SECTIONS.find((s) => s.id === active)!

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onClick={() => openDocs(false)}>
      <div className="glass flex h-[88vh] w-full max-w-4xl flex-col border-white/10 bg-[#0b0f1a]/95 sm:flex-row" onClick={(e) => e.stopPropagation()}>
        <aside className="flex shrink-0 flex-col gap-0.5 border-b border-white/[0.06] p-3 sm:w-52 sm:border-b-0 sm:border-r">
          <div className="mb-1 flex items-center justify-between">
            <span className="px-2 text-sm font-bold text-white">📖 Documentation</span>
            <button className="btn-ghost !px-2 !py-0.5 text-xs sm:hidden" onClick={() => openDocs(false)}>✕</button>
          </div>
          <nav className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setActive(s.id)}
                className={`shrink-0 cursor-pointer rounded-lg px-3 py-1.5 text-left text-xs font-medium transition-colors ${active === s.id ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'}`}
              >
                {s.title}
              </button>
            ))}
          </nav>
        </aside>
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-lg font-bold text-white">{section.title}</h3>
            <button className="btn-ghost !px-2.5 !py-1 hidden sm:inline-flex" onClick={() => openDocs(false)}>✕</button>
          </div>
          {section.body}
        </div>
      </div>
    </div>
  )
}
