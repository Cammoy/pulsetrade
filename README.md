# ⚡ PulseTrade

Visual, multi-chain crypto trading bots. Run any number of bots concurrently — the same coin
under several risk tolerances, or many coins at once — each with its own budget, schedule and
independently tracked P&L. Profits are automatically swept into the chain's **native currency**
(ETH / BNB / POL), so you are never left holding an illiquid token.

## Quick start

```bash
npm install
npm run dev          # engine on :8787  +  web app on :5173
```

Open <http://localhost:5173>, click **New Bot** and follow the wizard.

The app starts in **paper mode**: strategies run against *real live market data* with simulated
fills (gas + slippage included), so you can prove a configuration is profitable before risking
a cent. All state persists in `server/data/state.json`.

## The 5 networks

| Network | ~Cost per swap | Profits swept to |
|---|---|---|
| Base | $0.02 | ETH |
| Arbitrum | $0.03 | ETH |
| Optimism | $0.02 | ETH |
| Polygon | $0.01 | POL |
| BNB Chain | $0.10 | BNB |

All EVM — one wallet works everywhere. Each network carries a curated list of deep-liquidity
tokens only (BTC/ETH wrappers, LINK, UNI, AAVE, ARB, OP, …).

## Strategies

Every strategy is the *same code* in backtests and live trading — what you see in the wizard's
30-day backtest is exactly what runs.

- **Grid** — ladder of buys below an anchor, sells one rung up. Earns from sideways chop.
- **RSI Mean Reversion** — buys oversold (RSI < tier threshold), exits overbought / TP / SL.
- **EMA Momentum** — enters on 9/21 EMA cross up, exits on cross down or stop.
- **Smart DCA** — scheduled slice buys only below the 24h average, exits the stack in profit.

Risk tolerance (**Conservative / Balanced / Aggressive**) scales position size, stop-loss,
take-profit, grid spacing, RSI thresholds and cooldowns. Launch the same coin+strategy at two
tolerances and compare their P&L side by side — the dashboard shows a per-tolerance breakdown.

## Features

- 🧭 **Guided onboarding** — a first-run tour (replayable via the `?` button) plus full in-app
  documentation (`📖 Docs`) and a standalone [DOCS.md](DOCS.md)
- 🎯 **Sniper** — live feed of freshly created / trending pools (GeckoTerminal); pick one, it’s
  screened, then a one-shot snipe bot enters instantly and exits on take-profit / stop-loss /
  trailing stop / max-hold, sweeping to native and retiring itself
- 🛡️ **Pre-trade risk screening** — every token screened via GoPlus Security + honeypot.is for
  honeypots, non-sellable contracts, rug-pull setups, exit traps and owner controls; scored
  0–100 with named flags. A **hard, no-override block** for the Sniper; advisory in the wizard
- 💡 **Profit Finder** — "here is $100": backtests every strategy × risk × coin on a network
  over identical real 30-day history, ranks by profit, one click launches the winner
- 📒 **Monthly P&L ledger** — realized P&L, win rate, fees, native sweeps, volume and
  per-tolerance attribution per calendar month; persisted independently of trade history,
  so it survives trade trimming and bot deletion
- 🧙 Setup wizard: wallet → network → coin → strategy (with one-click "backtest all") → risk &
  budget → trading hours → review with auto-backtest of the exact configuration
- ⏰ Schedules: 24/7 or specific days + hour windows (overnight windows supported); bots sleep
  outside their window and resume automatically
- 📈 Live dashboard over WebSocket: per-bot equity sparkline, status pulse, price chart with
  buy/sell markers, per-bot activity log explaining every decision
- 📜 Toggleable trade history with bot/side filters, fees, per-trade P&L and native sweeps
- 🛑 **Stop & sweep**: stopping a bot liquidates everything into the chain's native coin
- 👛 Wallet connect (MetaMask / Rabby / any injected wallet) across all 5 chains

## Going live (optional, at your own risk)

1. Create a **dedicated bot wallet** (never your main wallet) and fund it on the target chain.
2. Get a free API key at [0x.org](https://0x.org/docs).
3. `cp server/.env.example server/.env` and set `ZEROX_API_KEY` + `BOT_WALLET_KEY`.
4. Restart, then flip the header toggle to **Live**.

Live trades execute native↔token via the 0x allowance-holder API with 1% max slippage. Paper
accounting continues in parallel as the source of truth for P&L.

## Honesty notes

- "Proven" means *backtested on real data in front of you* — no strategy wins in all markets.
  Grid and mean-reversion suit ranging markets; momentum suits trends; DCA suits accumulation.
- Backtests include fees and slippage but not liquidity depth or MEV. Paper-trade first, size
  small, and never trade money you can't afford to lose.

## Testing

```bash
npm test
```

67 tests cover the indicators (known-value checks), every strategy's entry/exit/cooldown
logic against deterministic price series, the paper executor's accounting (cost basis
includes buy fees; an equity-identity test proves cash + position + native sweeps always
equals budget + P&L), profit sweeps, stop-&-sweep, schedule windows (including overnight),
the monthly ledger (including the legacy-state rebuild), backtester invariants on synthetic
ranging/crashing markets, the Profit Finder ranking, **the risk-screen scoring (honeypots,
non-sellable, rug setups, tax traps, owner controls, provider redundancy and the
trade-blind refusal), the sniper strategy (instant entry; TP/SL/trailing/max-hold exits;
one-shot), pool discovery mapping, and createSniper's mandatory no-override safety gate**,
input validation, and crash-safe persistence (atomic writes, corrupt-file fallback). No
network access — all providers are mocked at the fetch layer; the same `decide()` code
paths run in tests, backtests and live.

## Architecture

```
server/  Express + WebSocket engine (Node, tsx)
  src/engine.ts      tick loop, paper executor, profit sweep, schedules
  src/strategies.ts  the 4 strategies (shared by engine + backtester)
  src/backtest.ts    30-day hourly backtests with fees/slippage + Profit Finder
  src/prices.ts      CoinGecko spot + candles + GeckoTerminal pool pricing, cached
  src/risk-screen.ts pure 0–100 risk scorer (rug/honeypot/exploit flags)
  src/screen-fetch.ts  GoPlus + honeypot.is fetch wrapper, cached
  src/sniper.ts      GeckoTerminal new/trending pool discovery
  src/live.ts        0x v2 swap execution (dormant without keys)
web/     Vite + React + Tailwind v4 + wagmi/viem + lightweight-charts
```
