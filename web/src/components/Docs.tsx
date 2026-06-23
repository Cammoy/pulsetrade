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
const C = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-white/10 px-1 py-0.5 text-xs">{children}</code>

const SECTIONS: Section[] = [
  {
    id: 'start',
    title: 'Getting started',
    body: (
      <>
        <P>PulseTrade runs automated crypto trading bots across seven networks — five low-fee EVM chains (Base, Arbitrum, Optimism, Polygon, BNB) plus Solana and the Internet Computer. Bots place buys and sells for you continuously and take profit in each chain’s <B>native coin</B> — or in <B>USDT</B> if you prefer dollars (every bot has an “auto-sell profits to” setting). Either way you never end up stuck holding an illiquid token.</P>
        <H>Paper vs Live</H>
        <P><B>Paper mode</B> (the default) trades with real, live market prices but simulated money — the honest way to prove a setup before risking funds. <B>Live mode</B> executes real on-chain swaps once per-chain keys are configured (0x for EVM, Jupiter for Solana — see “Going live & safety”). Switch workspaces with the <B>📝 Paper / 🔴 Live</B> toggle; each bot trades in the workspace it was born into, regardless of which you’re viewing.</P>
        <P>Every fill — paper or live — is recorded with fees and slippage, and your realized P&L is persisted to a monthly ledger that survives restarts and bot deletion.</P>
      </>
    ),
  },
  {
    id: 'bots',
    title: 'Creating bots',
    body: (
      <>
        <P>Hit <B>+ New Bot</B> for the guided wizard: connect a wallet (optional), choose a network and coin, pick a strategy and risk tolerance, set a budget, and optionally restrict trading to specific days and hours. The review step runs a real 30-day backtest of your exact configuration plus an advisory safety screen.</P>
        <H>Running many at once</H>
        <P>Launch any number of bots simultaneously — the same coin under several risk tolerances, or many coins at once. Each keeps its own cash, position, schedule and P&L, so you can compare tolerances side by side; the dashboard shows a P&L-by-tolerance breakdown. One-click <B>🌤️ All-Weather</B> spins up the adaptive strategy on a liquid coin.</P>
        <H>Schedules</H>
        <P>A bot can trade 24/7 or only within chosen day/hour windows (overnight windows supported). Outside its window it sleeps but still manages an open position’s exits, then resumes entries automatically.</P>
      </>
    ),
  },
  {
    id: 'strategies',
    title: 'Strategies',
    body: (
      <>
        <P>Every strategy runs the identical <C>decide()</C> code in backtests and live trading — what you backtest is exactly what trades.</P>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>All-Weather (Adaptive)</B> — reads the regime and switches behaviour: rides uptrends, mean-reverts ranges, steps to cash in downtrends.</LI>
          <LI><B>Grid</B> — lays a ladder of buys below an anchor and sells one rung higher as price oscillates. Earns from sideways chop.</LI>
          <LI><B>RSI Mean-Reversion</B> — buys oversold conditions, exits on overbought readings or the risk-tier take-profit / stop-loss.</LI>
          <LI><B>EMA Momentum</B> — enters when the fast EMA crosses above the slow EMA (confirmed uptrend), exits on the reverse cross or stop.</LI>
          <LI><B>Momentum Factor</B> — time-series momentum: enters only when the trailing return is strongly positive and price is above its 50-hour average, sizes inversely to volatility, and rides winners with a trailing stop.</LI>
          <LI><B>Smart DCA</B> — buys fixed slices on a schedule, but only below the 24h average; sells the stack once it’s in profit.</LI>
        </ul>
        <P><B>Risk tolerance</B> (Conservative / Balanced / Aggressive) scales position size, stop-loss, take-profit, grid spacing, RSI thresholds and cooldowns — so two bots on the same coin behave very differently.</P>
        <P><B>Honest edge:</B> the Profit Finder labels every backtest with an <B>Edge</B> verdict (no-edge / inconclusive / weak / significant) from a t-test, an annualised Sharpe and an out-of-sample check. Most retail setups land at no-edge — that’s the point: the app proves or disproves an edge, it never manufactures one.</P>
      </>
    ),
  },
  {
    id: 'swap',
    title: 'Swap',
    body: (
      <>
        <P>The <B>🔄 Swap</B> tool does ad-hoc, manual token swaps — <B>same-chain</B> via <B>0x</B> (EVM) / <B>Jupiter</B> (Solana), or <B>cross-chain</B> (any EVM chain → any other EVM chain) via the <B>LI.FI</B> bridge aggregator, all signed by your wallet. This is a <B>real swap that moves actual funds</B> (it is never paper-simulated), so it’s gated behind a confirmation.</P>
        <H>Any token, any of the supported chains</H>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI>Each token field opens a <B>searchable picker over the full token list</B> for that network (thousands of tokens, with logos) — or <B>＋ paste any address</B> for the long tail; pasted tokens are looked up and, on EVM, rug-screened before they can be chosen.</LI>
          <LI>Pick a <B>From</B> network/token and a <B>To</B> network/token. Leave them on the same chain for a normal swap, or choose a different <B>To</B> network for a <B>cross-chain</B> bridge swap (e.g. USDC on Base → USDT on Arbitrum).</LI>
          <LI>Enter an amount (Max fills your balance). A live quote shows the <B>rate</B>, <B>minimum received</B> at your slippage, and either <B>price impact / network fee</B> (same-chain) or the <B>bridge name, estimated time and bridge+gas fee</B> (cross-chain).</LI>
          <LI>Confirm to execute. Cross-chain swaps submit a source-chain transaction and settle on the destination in seconds–minutes; you get a tx hash + explorer link, and every swap lands in the <B>History</B> tab (cross-chain rows show the route + bridge).</LI>
        </ul>
        <P>Quotes work in any mode, but <B>execution needs the live executor configured for the source chain</B> (see “Going live”). Cross-chain is EVM↔EVM for now (Solana swaps stay same-chain). Manual swaps are your deliberate action, so they’re independent of the bot safety breaker — but the slippage guard and (on EVM) the honeypot screen on pasted tokens still protect you.</P>
      </>
    ),
  },
  {
    id: 'sniper',
    title: 'Sniper & Auto-Sniper',
    body: (
      <>
        <P>The <B>🎯 Sniper</B> surfaces freshly created and trending liquidity pools that pass the full safety screen. Selecting a token runs a mandatory screen; if it passes, you set a budget plus exit rules, then snipe. <B>New tokens are extremely high-risk</B> — size snipes small.</P>
        <H>Smart exits — take the stake back, ride the runner</H>
        <P>A smart snipe buys its full budget immediately. Once it’s up by your <B>“take stake back”</B> threshold (e.g. +100%) it sells exactly enough to return your <B>original investment</B> to safety (cash + the withdrawable vault), then rides the remainder as risk-free <B>“house money”</B> — trailing it a set % off its peak with <B>no fixed timer</B>, so a strong trend can run 24h+ and a clear reversal closes it. A stop-loss bounds the downside before you’ve de-risked. (A coin that dumps before reaching profit still stops out at a loss — recovery only applies once it’s in profit.)</P>
        <H>Auto-Sniper</H>
        <P>The <B>🤖 Auto-Sniper</B> runs as a <B>campaign</B>, set up in a quick four-step wizard (Budget → Targets → Strategy → Review). On launch the panel closes and it works in the background: it deploys your budget across <B>N snipes</B> (≈ budget ÷ per-snipe), opening <B>one best vetted coin every N hours</B> (default 2h), taking your stake back at the threshold and riding each runner. Because the point is to <B>snipe</B>, it only ever enters <B>genuinely new launches</B> — pools created within your <B>Max coin age</B> window (default 3 days; tighten to 6h or loosen to 30d), never a coin that launched months or years ago.</P>
        <P>Once the <B>whole budget is deployed the scan stops automatically</B> — the open runners keep riding to their own exits in your bot list — and the tab resets to the wizard with a recap, ready for the next campaign. It’s pinned to the workspace it was started in, so a <B>live</B> campaign keeps running even while you view the paper workspace, bounded by your live-spend caps + the breaker. End the campaign early (let runners finish) or stop &amp; sell all, any time.</P>
      </>
    ),
  },
  {
    id: 'safety',
    title: 'Token risk screening',
    body: (
      <>
        <P>Before any snipe — or before a pasted custom token enters a swap on EVM — PulseTrade screens the token through two independent providers, <B>GoPlus Security</B> and <B>honeypot.is</B>, scoring it 0–100 with named flags.</P>
        <H>What it checks</H>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>Honeypots / non-sellable contracts</B> — simulates a sell; if you could buy but not sell, the token is blocked.</LI>
          <LI><B>Rug-pull setups</B> — unlocked liquidity, mintable supply, owner-editable balances.</LI>
          <LI><B>Exit traps</B> — extreme sell taxes, transfer pausing, blacklists, cooldowns, modifiable max-tx limits.</LI>
          <LI><B>Contract control</B> — hidden owners, reclaimable ownership, self-destruct, upgradeable proxies, unverified source.</LI>
        </ul>
        <P>Any <B>critical</B> flag makes the token non-tradeable with <B>no override</B>. If neither provider returns data, the token is treated as unsafe — the engine never trades blind. The screen is a hard gate for the Sniper and for pasted swap tokens; curated wizard tokens are hand-picked blue-chips whose screen is advisory. The providers are EVM-only, so Solana tokens get an advisory note rather than a hard block.</P>
      </>
    ),
  },
  {
    id: 'market',
    title: 'Market & Profit Finder',
    body: (
      <>
        <P>The <B>📊 Market</B> view is your at-a-glance read on crypto overall: a single <B>regime</B> label (Risk-on / Neutral / Risk-off) with a 0–100 composite blending breadth with the Fear &amp; Greed index, global stats (market cap, 24h volume, BTC/ETH dominance), and the top coins each with a 7-day sparkline and a transparent <B>BUY / SELL / HOLD</B> read from RSI + EMA trend + momentum. Evidence to inform your judgement — <B>not financial advice</B>.</P>
        <H>Profit Finder</H>
        <P>Open <B>💡 Profit Finder</B>, enter a stake, choose a scope (Curated, Top-100 movers, or Trending-safe), and it backtests every strategy × risk tolerance over the same real history — with gas and slippage — and ranks the outcomes by profit, each tagged with its honest <B>Edge</B> verdict and an out-of-sample return. The top result is your best historical configuration for that stake; past performance never assures future returns.</P>
      </>
    ),
  },
  {
    id: 'calculator',
    title: 'Profit Calculator',
    body: (
      <>
        <P>The <B>🧮 Profit Calculator</B> answers “what would I make?” instantly and visually. Type an entry price, how much you’d put in (a <B>USD amount</B> or a <B>coin quantity</B>), and a target — and it shows the profit, %, ROI multiple, break-even and a live <B>profit curve</B> across exit prices, plus scenario cards at ½× / 2× / 3× / 5× / 10×. The math is a pure, unit-tested long-spot round-trip with an optional <B>per-side fee</B>, so the headline number always matches the chart. It’s a planning tool, <B>not a forecast</B>.</P>
        <H>Search a coin — real price, real market cap</H>
        <P>Start typing a coin name (e.g. <em>bitcoin</em>, <em>pepe</em>) and pick from the autocomplete: the calculator pulls that coin’s <B>live price</B>, <B>market cap</B> and <B>circulating supply</B> from CoinGecko and fills the entry price for you.</P>
        <H>Target a price — or a market cap</H>
        <P>Once a coin is selected you can switch the exit from <B>by price</B> to <B>by market cap</B> and ask “what if it hits a $5B / $10B cap?”. The implied price is computed the only correct way — <B>price = target market cap ÷ circulating supply</B> — which is exactly why the live supply matters: without it a market-cap target can’t be accurate, so the mode only turns on when a coin with known supply is selected. The milestone chips and scenario cards re-scale to multiples of the coin’s current market cap, and switching back to <B>by price</B> carries the implied price across so the numbers stay continuous.</P>
      </>
    ),
  },
  {
    id: 'smart-money',
    title: 'Smart money & copy-trading',
    body: (
      <>
        <P>The <B>🐋 Smart Money</B> view tracks individual traders’ wallets and lets you trade alongside them. It ships with a watchlist of publicly documented <B>individuals</B> — GCR, Tetranode, Andrew Kang, Machi Big Brother, Arthur Hayes, Cobie, Vitalik, Justin Sun, Kain Warwick, Sassal, Stani Kulechov and more — and deliberately <B>excludes exchange hot wallets and market makers</B> (they mix many users’ flow and are bad to copy). Add your own by address.</P>
        <H>Trading with a wallet</H>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>Activity</B> — a live feed of tracked wallets’ buys/sells of curated tokens. Hit <B>Copy</B> on a row to mirror that one token manually.</LI>
          <LI><B>Accounts</B> — open a wallet for its history, a cumulative net-flow chart, a per-token breakdown, and a copy-worthiness score (proven / promising / unproven, with a “flow heuristic, not verified PnL” caveat).</LI>
          <LI><B>Auto-follow</B> — give a wallet a budget + per-trade size; whenever it buys <em>any</em> curated token a mirror bot enters with your size and exits when it sells (plus your risk stops). Returns recycle into the next mirror.</LI>
        </ul>
        <H>The Copy Trading hub</H>
        <P>The <B>🔁 Copy Trading</B> channel is the action-focused companion to Smart Money — rank who’s worth copying, then mirror them.</P>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>Leaderboard</B> — every tracked wallet ranked by <B>true realized P&amp;L</B> reconstructed from on-chain transfers (average-cost basis at historical prices). Tiers: proven / promising / unproven. Without a <C>COINGECKO_API_KEY</C> the historical pricing is rate-limited and the board falls back to a net-flow heuristic (you’ll see a “degraded” hint).</LI>
          <LI><B>Discover</B> — a background crawl that finds wallets you don’t track yet by scanning recent buyers of your curated tokens, then verifying each by realized P&amp;L. Only genuinely profitable, recently-active round-trippers surface.</LI>
          <LI><B>Guided setup</B> — copy one token or auto-follow every buy, with a per-trade size and optional stop-loss / take-profit. A live preview spells out exactly what the bot will do and which safety caps apply. Click any wallet for the full analysis (net-flow chart, holdings, per-token flow, trades).</LI>
        </ul>
        <H>How a copy exits</H>
        <P>A copy <B>mirrors</B> the wallet — buys when they buy, exits when they sell — so you ride their <em>full</em> move rather than capping it at a tier take-profit. Stop-loss and take-profit are opt-in. The exception is live money: a copy in the <B>Live</B> workspace gets a wide <B>catastrophic stop-loss</B> by default (bounding a rug while the wallet’s sell is still being detected) — widen or replace it in Advanced.</P>
        <P>Live wallet data needs a free <C>ETHERSCAN_API_KEY</C>; the watchlist and follow setup work without it and act once tracking is enabled. Realized-P&amp;L scoring + discovery additionally benefit from a free <C>COINGECKO_API_KEY</C> (else they degrade to net-flow). Wallet tracking is EVM-only. Tracking is informational — <B>smart money is sometimes very wrong</B>; re-validate before live copy-trading.</P>
      </>
    ),
  },
  {
    id: 'portfolio',
    title: 'Portfolio & holdings',
    body: (
      <>
        <P>The <B>💼 Portfolio</B> view has four tabs:</P>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>Holdings</B> — a manual cost-basis tracker for positions you hold anywhere (independent of the bots): enter buys/sells, and it computes average cost, realised + unrealised P/L, allocation, best/worst, a value-over-time chart and per-asset sparklines.</LI>
          <LI><B>Wallet</B> — a read-only, keys-free view of any address’s on-chain holdings: native + curated tokens across the EVM chains, plus Solana and ICP, priced and aggregated, with by-network and by-asset allocation donuts. Add several addresses and they merge.</LI>
          <LI><B>Staking</B> — a read-only, keys-free view of everything you have <B>staked</B>, charted: paste an Ethereum wallet (liquid-staking tokens — stETH, wstETH, rETH, cbETH), a Solana wallet (native stake accounts, auto-detected) and/or your ICP neuron IDs, and each position is valued live, totalled, and broken down by network in a donut with per-position value bars. Positions that are unlocking (ICP dissolving neurons, Solana deactivating stake) show the <B>exact days remaining + the unlock date</B>; every position shows an <B>estimated APY</B> and projected rewards (per year, plus what you'd earn before an unlock). Unlock dates are exact from on-chain state; APY/reward figures are estimates. ICP neuron data is the public on-chain info from the governance canister.</LI>
          <LI><B>Withdraw</B> — pay banked profit (swept native/USDT) out to an external address. Paper withdrawals are simulated; live withdrawals are real on-chain transfers, with a saved, labelled address book.</LI>
        </ul>
        <H>Tracking P&L</H>
        <P>Each bot shows realized + unrealized P&L, win rate, fees, position value and native taken as profit — open one for its price chart with buy/sell markers and a plain-English activity log. The <B>Monthly P&L</B> panel is a persisted ledger (realized P&L, win rate, fees, native swept, volume, per-tolerance breakdown) that survives trade trimming and bot deletion.</P>
      </>
    ),
  },
  {
    id: 'live',
    title: 'Going live & safety',
    body: (
      <>
        <H>Enabling live trading</H>
        <P>Use a <B>dedicated</B> bot wallet per chain — never your main wallet — funded with only what the bots may trade. Configure the chains you want, restart the engine (a <C>.env</C> change isn’t hot-reloaded), then flip the workspace to <B>🔴 Live</B>.</P>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>EVM chains</B> — set <C>ZEROX_API_KEY</C> (free at dashboard.0x.org, the swap router) <em>and</em> a signer: a raw <C>BOT_WALLET_KEY</C> or a <B>Turnkey</B>-backed wallet (key never leaves Turnkey). The key authorises moving funds; 0x finds the route.</LI>
          <LI><B>Solana</B> — set a signer (<C>SOLANA_WALLET_KEY</C> or Turnkey) and optionally <C>SOLANA_RPC_URL</C>. Jupiter does the routing and needs no key, so Solana is live the moment its signer is set.</LI>
          <LI><B>Internet Computer (ICP)</B> — trades live-price in paper for now; KongSwap/ICPSwap are canister-only DEXes with no REST API, so the on-chain executor is pending.</LI>
        </ul>
        <H>The safety circuit breaker</H>
        <P>An account-level breaker protects a live account: it <B>pauses every live bot</B> the instant a hard limit is hit — a cumulative realised loss (<C>MAX_CUMULATIVE_LOSS_USD</C>), a lifetime live-spend ceiling (<C>MAX_LIVE_USD_TOTAL</C>), or an opt-in fleet-drawdown (<C>MAX_FLEET_DRAWDOWN_PCT</C>) — plus a per-day spend cap (<C>MAX_LIVE_USD_PER_DAY</C>). It often stops a bot <em>before</em> any over-spend, so nothing is lost. It stays tripped until you <B>reset</B> it from the <B>⛔ HALTED</B> button; resetting clears the halt and zeroes the counters, but your live bots stay <B>paused</B> until you resume them. Paper bots are never affected.</P>
        <P className="rounded-xl bg-amber-500/10 p-3 text-amber-200">Nothing here is financial advice. Backtested performance does not guarantee future results. Crypto is volatile and you can lose money — only trade what you can afford to lose.</P>
      </>
    ),
  },
]

export default function Docs() {
  const setView = useStore((s) => s.setView)
  const [active, setActive] = useState(SECTIONS[0].id)
  const section = SECTIONS.find((s) => s.id === active)!

  return (
    <div className="glass flex flex-col border-white/10 sm:flex-row">
      <aside className="shrink-0 border-b border-white/[0.08] p-3 sm:w-56 sm:self-start sm:border-b-0 sm:border-r sm:[position:sticky] sm:top-4">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="text-sm font-bold text-white">📖 Documentation</span>
          <button className="btn-ghost !px-2 !py-0.5 text-xs sm:hidden" onClick={() => setView('home')}>← Back</button>
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
        <button className="btn-ghost mt-3 hidden w-full text-xs sm:inline-flex" onClick={() => setView('home')}>← Back to dashboard</button>
      </aside>
      <div className="min-w-0 flex-1 p-5">
        <h3 className="mb-2 text-lg font-bold text-white">{section.title}</h3>
        {section.body}
      </div>
    </div>
  )
}
