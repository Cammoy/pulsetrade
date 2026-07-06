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
        <P>Hit <B>+ New Bot</B> to open the <B>New Bot hub</B> — one chooser with every way to create a bot: <B>🛠️ Build from scratch</B> (the guided wizard), <B>🤖 AI Trader</B>, <B>💡 Profit Finder</B>, <B>🎯 Sniper</B> and <B>🏆 Tournament</B>. The guided wizard: connect a wallet (optional), choose a network and coin, pick a strategy and risk tolerance, set a budget, and optionally restrict trading to specific days and hours. The review step runs a real 30-day backtest of your exact configuration plus an advisory safety screen.</P>
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
        <P>Open it from <B>+ New Bot → 🎯 Sniper</B>. The <B>Sniper</B> surfaces freshly created and trending liquidity pools that pass the full safety screen. Selecting a token runs a mandatory screen; if it passes, you set a budget plus exit rules, then snipe. <B>New tokens are extremely high-risk</B> — size snipes small.</P>
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
        <H>Candlestick chart</H>
        <P>The <B>💱 Trade</B> channel shows a full candlestick chart for any coin — real <B>OHLC</B> from CoinGecko with an <B>SMA(20)</B> overlay and <B>1D / 7D / 30D / 90D</B> timeframes (TradingView lightweight-charts). Search any coin; the period change is read straight off the candles.</P>
        <H>Profit Finder</H>
        <P>From <B>+ New Bot → 💡 Profit Finder</B>, enter a stake, choose a scope (Curated, Top-100 movers, or Trending-safe), and it backtests every strategy × risk tolerance over the same real history — with gas and slippage — and ranks the outcomes by profit, each tagged with its honest <B>Edge</B> verdict and an out-of-sample return. The top result is your best historical configuration for that stake; past performance never assures future returns.</P>
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
    id: 'trade',
    title: 'Trade',
    body: (
      <>
        <P>The <B>💱 Trade</B> channel is a one-coin <B>terminal</B>: pick a coin once and everything binds to it — a candlestick chart (OHLC + SMA + 1D/7D/30D/90D) on the left, and a single <B>order ticket</B> on the right with tabs for <B>Perp</B> (open a leveraged paper position), <B>Limit</B> (buy-the-dip / sell-the-rip), <B>Alert</B> (price cross / move), and <B>Calc</B> (a what-if profit estimate).</P>
        <P>Below the ticket, your open positions, limit orders and alerts are listed together with one-tap close / cancel / pause / re-arm / dismiss — toggle <B>This coin</B> vs <B>All</B> to manage everything in one place. This channel <B>replaces</B> the old separate Chart, Positions, Limit Orders and Price Alerts apps. Everything is paper/advisory; arbitrary token swaps stay in the <B>Swap</B> app and the full <B>Profit Calculator</B> remains its own app (the Calc tab here is a quick what-if).</P>
      </>
    ),
  },
  {
    id: 'signals',
    title: 'Signal Channel',
    body: (
      <>
        <P>The <B>📡 Signals</B> channel posts <B>advisory</B> LONG/SHORT trade calls for listed coins. It’s built for perps traders — each signal carries a direction, an <B>entry zone</B> (a range, to scale in), an isolated-<B>leverage</B> recommendation, three take-profits, a hard stop-loss, a confidence score and a one-sentence AI rationale. Signals are <B>informational</B>: nothing here is auto-executed by the bots — you place the trade on your own venue.</P>
        <H>The filter-first workflow</H>
        <P>Quality over noise — a setup only becomes a post if it clears <em>every</em> stage:</P>
        <ul className="mb-3 ml-4 list-disc space-y-1.5">
          <LI><B>Scanner</B> — sweeps the top coins for ones genuinely <em>in play</em> (unusual turnover, a volatility breakout, a momentum shift) with a clear directional technical edge; ranging, illiquid and stable coins are dropped.</LI>
          <LI><B>AI validation</B> — Gemini reads the chart history <em>and</em> live news, and must confirm the market is <B>trending</B> (not choppy), flag any imminent <B>binary event</B> (CPI, FOMC, a major unlock) that would invalidate the setup, and pick the direction.</LI>
          <LI><B>News sentiment</B> — Gemini, grounded with web search, scores each asset’s news <B>−1…+1</B>. A bullish technical setup into <B>strongly negative</B> news is discarded; milder opposition lowers confidence.</LI>
          <LI><B>Risk gate</B> — the structural stop and projected targets must give a <B>reward:risk ≥ 1.5</B>, and confidence must clear the floor. Anything less is rejected.</LI>
        </ul>
        <H>Reading a signal</H>
        <P>The stop-loss is the <B>invalidation level</B> — it is never widened. The <B>risk ladder</B> draws stop → entry → TP1/TP2/TP3 left to right and fills in as targets print. The built-in <B>position-size helper</B> turns your account size and chosen risk (0.5–2%) into a suggested order size from the stop distance, so a single trade never risks more than you set. Leverage is an advisory cap, scaled <em>down</em> for higher-volatility coins.</P>
        <H>The radar — always something to watch</H>
        <P>Most coins in play never clear every filter, so alongside the posted signals the <B>Radar</B> shows the top <B>long- and short-leaning</B> candidates the scanner is weighing — each tagged <B>✓ Signal</B> or <B>Watching</B> with the exact reason it hasn’t graduated (R:R too tight, market ranging, sentiment opposed…). It’s candidates under evaluation, not calls.</P>
        <H>Set up &amp; track your own trade</H>
        <P>Open the <B>trade ticket</B> three ways: the <B>📍 Set up a trade</B> button (search <em>any</em> coin and it seeds sensible levels around the live price), <B>tap any radar candidate</B>, or click a posted signal (or <B>Edit</B> a tracked one). Then choose LONG/SHORT and set your own <B>entry zone, leverage, stop-loss and TP1/2/3</B>. Everything recomputes live — reward:risk, the risk-based <B>position size</B>, margin, the isolated <B>liquidation estimate</B> and the <B>$ outcome at each target</B> — and an invalid plan (stop/targets on the wrong side) is blocked with the reason. <B>Track</B> hands the plan to the engine, which monitors your levels tick-by-tick and <B>alerts you on a hit</B>; manage, re-configure or close them under <B>My setups</B>. Tracking is advisory — it watches and notifies, it does <em>not</em> place the order — so it works in either workspace, with or without a wallet.</P>
        <H>Forward-test track record</H>
        <P>Every posted signal is tracked tick-by-tick against live price (a scale-out-thirds model with a fixed stop) — so the channel reports its <B>own</B> real-time accuracy: win rate, average R, TP1 hit-rate and total R across closed signals. This <B>is</B> the paper-trading verification step: prove the channel’s edge on real market conditions before acting on it with capital.</P>
        <P>The channel needs a free <C>GEMINI_API_KEY</C> (every signal is AI-validated). Without it the channel idles and prompts for the key. Tune it with <C>SIGNALS_MIN_RR</C>, <C>SIGNALS_MIN_CONFIDENCE</C>, <C>SIGNALS_SCAN_MS</C> and <C>SIGNALS_MAX_ACTIVE</C>; turn it off with <C>SIGNALS_DISABLED=true</C>. Signals are <B>probabilities, not guarantees</B> — not financial advice.</P>
        <P><B>If you see “⏳ AI rate-limited”:</B> your Gemini key hit its quota (the free tier is easy to exhaust — each scan validates several coins plus their news). The channel <B>pauses AI calls</B> for a short cooldown and resumes automatically, so no new signals post in the meantime and the radar shows candidates without an AI verdict. The <B>radar</B> and your own <B>tracked setups</B> keep working — they need no AI. To post signals continuously, use a key with available quota (a paid Gemini tier, or wait for the free quota to reset).</P>
      </>
    ),
  },
  {
    id: 'alerts',
    title: 'Price Alerts',
    body: (
      <>
        <P>In the <B>💱 Trade</B> channel's <B>Alert</B> tab, set a price alert on the selected coin and get notified the moment it moves: <B>cross above</B> a price, <B>drop below</B> a price, or <B>move ±%</B> from where it is now (a volatility alert). The engine checks every armed alert each tick against the live price; manage them all under the channel's activity (This coin / All).</P>
        <P>Alerts are <B>one-shot</B> — they fire once, then sit as “triggered” until you <B>re-arm</B> (re-arming uses the current price as the new basis) or delete them; <B>pause/resume</B> any time. Each trigger shows an in-app toast and, if you've configured <C>ALERT_TELEGRAM_*</C> or <C>ALERT_WEBHOOK_URL</C>, pushes there too. No Gemini key needed.</P>
      </>
    ),
  },
  {
    id: 'earn',
    title: 'Earn',
    body: (
      <>
        <P>Open <B>💼 Portfolio → 🌱 Earn</B> to see where to park <B>idle stablecoins</B> for yield. It pulls live rates from <B>DefiLlama</B> (free, no key) and shows a safety-filtered shortlist — <B>single-asset stablecoin</B> pools (no impermanent-loss pairs) with <B>≥ $5M TVL</B> on the supported chains — ranked by APY, with TVL and a base/reward split. Type an amount and each row projects the <B>$/yr</B>.</P>
        <P>It's informational: depositing is done on the protocol directly (tap a row to open it on DefiLlama). High stablecoin APYs usually carry extra risk — check the TVL and protocol. DeFi has smart-contract risk; nothing here is financial advice. In-app auto-deposit is a gated follow-up.</P>
      </>
    ),
  },
  {
    id: 'limit-orders',
    title: 'Limit Orders',
    body: (
      <>
        <P>In the <B>💱 Trade</B> channel's <B>Limit</B> tab, set conditional spot orders on the selected coin: <B>buy the dip</B> (fills when the price drops to your target) or <B>sell the rip</B> (fills when it rises to your target). The engine watches each open order against the live price every tick and fills it at <B>your price or better</B>, with a fee — then toasts you (and Telegram/webhook if configured).</P>
        <P>Pick a coin, a side, a USD amount and a trigger; a buy target must be <em>below</em> the current price and a sell target <em>above</em>, so nothing fills the instant you place it. Fills are <B>paper</B> (no funds move) — live auto-execution through the swap router is a gated follow-up. Cancel an open order or dismiss a settled one any time.</P>
      </>
    ),
  },
  {
    id: 'perps',
    title: 'Perps (paper)',
    body: (
      <>
        <P>In the <B>💱 Trade</B> channel's <B>Perp</B> tab, open leveraged <B>long / short</B> perpetual futures on any coin — <B>paper</B> for now, so no funds move. Each position is marked every tick against <B>real Hyperliquid prices and funding rates</B> (a free, no-key public API; coins Hyperliquid doesn't list fall back to the CoinGecko spot price), with a live PnL/ROE, an isolated-margin <B>liquidation</B> estimate, and accruing funding + fees. Manage open positions under the channel's activity.</P>
        <H>Opening + managing</H>
        <P>Open a position three ways: the <B>Open a position</B> button (search any coin), the trade ticket's <B>📈 Open (paper)</B> action, or from a signal. You set the <B>leverage</B>, and the size comes from your position-sizing risk; an optional stop + take-profit close it automatically, alongside the hard <B>liquidation</B>. A position closes on <B>take-profit</B>, <B>stop</B>, <B>liquidation</B>, or when you <B>close at market</B>. Stats track your realized P&L and win rate.</P>
        <P className="rounded-xl bg-amber-500/10 p-3 text-amber-200">Paper only. Leverage amplifies losses and a position can be fully <B>liquidated</B> — size responsibly. Live on-chain perps execution is intentionally disabled until it's verified on testnet.</P>
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
        <P><B>CSV export:</B> the Trade history header has a <B>⤓ CSV</B> button that downloads the full ledger for the active workspace — date, side, asset, quantity, price, value, fee and realized P&L per fill — ready for a spreadsheet or your accountant.</P>
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
