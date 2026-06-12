# PulseTrade — User Documentation

The same content is available in-app via the **📖 Docs** button, and the guided
tour (the **?** button) walks new users through the highlights.

---

## 1. Getting started

PulseTrade runs automated trading bots on seven networks — five low-fee EVM
chains (Base, Arbitrum, Optimism, Polygon, BNB) plus Solana and the Internet
Computer. Bots place buys and sells for you continuously and take profit in
each chain's **native coin** — or in **USDT** if you prefer dollars (every bot
has an "auto-sell profits to" setting) — so you never end up stuck holding an
illiquid token.

### Paper vs Live

- **Paper mode** (default) — trades with real, live market prices but simulated
  money. The honest way to prove a setup before risking funds.
- **Live mode** — executes real on-chain swaps once per-chain keys are
  configured: 0x for the EVM chains, Jupiter for Solana (see "Going live").

Every fill (paper or live) is recorded with fees and slippage, and realized
P&L is persisted to a monthly ledger that survives restarts and bot deletion.

---

## 2. Creating bots

Click **New Bot** for the guided wizard: connect a wallet (optional), choose a
network and coin, pick a strategy and risk tolerance, set a budget, and
optionally restrict trading to chosen days/hours.

- **Run many at once** — the same coin under several risk tolerances, or many
  coins at once. Each bot keeps its own cash, position, schedule and P&L, so you
  can compare tolerances side by side (the dashboard shows a per-tolerance
  breakdown).
- **Schedules** — 24/7 or specific day/hour windows (overnight supported). A bot
  sleeps outside its window and resumes automatically.

---

## 3. Strategies

All four run identical code in backtests and live trading — what you backtest is
exactly what trades.

| Strategy | Best market | Idea |
|---|---|---|
| **Grid** | sideways chop | Ladder of buys below an anchor, sell one rung up |
| **RSI Mean Reversion** | ranging | Buy oversold, exit overbought / TP / SL |
| **EMA Momentum** | trending | Enter on 9/21 EMA cross up, exit on cross down |
| **Smart DCA** | accumulation | Scheduled slice buys below 24h avg, exit in profit |

**Risk tolerance** (Conservative / Balanced / Aggressive) scales position size,
stop-loss, take-profit, grid spacing, RSI thresholds and cooldowns.

---

## 4. Profit Finder

"Here is $100 — show me the max profit." Enter a stake and network; it backtests
every strategy × risk × coin on that network over the same real 30-day history
(fees and slippage included) and ranks the outcomes by profit. One click
launches the winner with that exact configuration.

Results are evidence, not a guarantee — past performance never assures future
returns.

---

## 5. Sniper

The Sniper shows **only safe coins**. It scans freshly created and trending
pools, then displays only those that are **verified (open-source), proven
sellable (passes a live sell-simulation), and held by many distinct wallets**
with no single-wallet or top-10 EOA dominance — everything else is filtered out
before you see it. (DEX pools, bridges, lockers and burn addresses don't count
as "whales" — only real end-user wallets do.) Selecting a coin shows its full
screen; you then set a budget plus take-profit, stop-loss, max-hold time and an
optional trailing stop, and snipe.

### Auto-Sniper

Hand the Auto-Sniper a total budget and a per-snipe size. It continuously scans
the same safe-only feed and snipes vetted coins on its own — up to a concurrency
limit — taking profit and **recycling returned cash into new snipes**. Live
stats show total P&L, profit taken in native, active snipes and budget deployed.
Stop it any time (optionally liquidating all open snipes to native). Every
auto-snipe still passes the full safety screen; nothing is bought blind.

**Behaviour:** buys the full budget immediately, then exits the entire position
on the first of take-profit, stop-loss, trailing stop, or max-hold timeout —
sweeping proceeds to the native coin. Once it exits, the bot retires itself.

> New tokens are extremely high-risk. The screen blocks the worst traps but
> cannot eliminate volatility — size snipes small.

---

## 6. Pre-trade risk screening

Before any snipe, PulseTrade screens the token through two independent security
providers — **GoPlus Security** and **honeypot.is** — and scores it 0–100 with
named flags.

**What it checks:**

- **Honeypots / non-sellable contracts** — simulates a sell; if you could buy
  but not sell, the token is blocked.
- **Rug-pull setups** — unlocked liquidity the team can withdraw, mintable
  supply, owner-editable balances.
- **Exit traps** — extreme sell taxes, transfer pausing, blacklists/whitelists,
  trading cooldowns, modifiable max-tx limits.
- **Contract control** — hidden owners, reclaimable ownership, self-destruct,
  upgradeable proxies, unverified source.
- **Concentration / liquidity** — top-holder dominance, very few holders, LP
  lock percentage.

Any **critical** flag makes the token non-tradeable with **no override**. If
neither provider returns data, the token is treated as unsafe — the engine never
trades blind.

**Scope:** the screen is a hard gate only for the Sniper. The curated wizard
tokens are hand-picked blue-chips; their screen is shown for transparency but is
advisory, because canonical bridged tokens (e.g. L2 wrapped LINK/WETH) can
legitimately show mint/LP flags.

---

## 7. Tracking P&L

Each bot shows realized and unrealized P&L, win rate, fees, position value and
native coin taken as profit. Open a bot for its price chart with buy/sell
markers and a plain-English activity log of every decision.

The **Monthly P&L** panel is a persisted ledger: realized P&L, win rate, fees,
native swept, volume and a per-tolerance breakdown for each calendar month. It's
independent of the trade list, so it survives trade trimming and bot deletion.

---

## 8. Smart money & following

The **🐋 Smart Money** panel tracks wallets and lets you trade alongside them.
It ships with a permanent watchlist of publicly documented wallets (Wintermute,
DWF Labs, machibigbrother.eth, James Fickel, gcr.eth, …); add your own too.

- **Activity** — live feed of tracked wallets' buys/sells of curated tokens, per
  network. Hit **Copy** on a row to mirror that one token manually.
- **Accounts** — open any wallet for its trading history: totals, a cumulative
  net-flow chart, and a per-token breakdown of buys, sells, volume and net flow.
- **Watchlist** — add/remove wallets by address.

**Trade with an account.** *Manually:* a copy bot mirrors the wallet's entries
and exits in one token. *Automatically:* from the account view, hand it a budget
and per-trade size — every curated-token buy spawns a mirror that exits when the
wallet sells (plus your risk-tier stops); returns recycle into the next mirror,
up to a concurrency limit. Live wallet data needs `ETHERSCAN_API_KEY`; setup
works without it. Wallet tracking is EVM-only.

## 9. Going live & safety

Use a **dedicated** bot wallet per chain — never your main wallet — funded with
only what the bot may trade. Live mode activates if *any* chain's keys are set;
bots on unconfigured chains keep trading in paper.

- **EVM (Base, Arbitrum, Optimism, Polygon, BNB)** — set `ZEROX_API_KEY` (free at
  [0x.org](https://0x.org/docs)) and `BOT_WALLET_KEY`. Swaps route via 0x (1%
  slippage cap).
- **Solana** — set `SOLANA_WALLET_KEY` (base58 secret key) and optionally
  `SOLANA_RPC_URL`. Swaps route via the Jupiter aggregator.
- **ICP** — live-price paper for now; KongSwap/ICPSwap are canister-only DEXes
  with no REST API, so the on-chain executor is pending.

Restart and flip the header toggle to **Live**. Paper accounting continues in
parallel as the source of truth for P&L. Sniping and wallet tracking are
EVM-only.

> Nothing here is financial advice. Backtested performance does not guarantee
> future results. Crypto is volatile and you can lose money — only trade what you
> can afford to lose.
