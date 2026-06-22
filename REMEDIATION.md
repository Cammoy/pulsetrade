# Audit Remediation Tracker

Tracks progress against `AUDIT.md` (2026-06-15). Status verified against the working
tree on 2026-06-22. Legend: ✅ fixed · 🟡 partial · ⬜ open.

Tests: `cd server && node --import tsx --test test/*.test.ts` (needs Node ≥22.5 — see
`.nvmrc` 24.15.0; the suite errors under the default Node 18). Web: `cd web && npx vitest run`.

## P0 — block real money
- ✅ P0-1 Live P&L/position reconciled to on-chain fill (`engine.ts` settle threads `r.delta`)
- ✅ P0-2 Fail-closed auth + loopback bind (`index.ts`)
- ✅ P0-3 Mirror-first stop (`controlBot` async, sell-on-chain before paper mutate)
- 🟡 P0-4 EVM-disarm gate present; **no boot-time env-coherence check / no test for the gate**
- ✅ P0-5 Circuit breaker (cumulative loss / lifetime spend / opt-in drawdown). Missing: per-trade max-USD env
- ✅ P0-6 Sniper safety — strict screen (c/d) default-on; sizing (a) + price-impact (e) done; see cluster below
- ✅ P0-7 Price staleness ceilings (`prices.ts` fetchedAt + fresh-gates)
- 🟡 P0-8 Fetch timeouts done; receipt waits 90s (audit wanted 30–60s)
- ✅ P0-9 Cost model → ~1%/side (explicit LP fee + slippage/impact in `costs.ts`) + one-time approve-gas leg on the first sell in the backtest + per-coin median ("typical" vs best-of-N) surfaced in the finder + UI + DOCS corrected. (Walk-forward/OOS + survivorship labels were already done.)

## P1 — production correctness
- ✅ P1-1 Atomic daily-cap reservation (`reservedLiveUsd`)
- ✅ P1-2 Daily/lifetime caps book the measured native outflow (input+gas) when readable, else fall back to intended USD; `dayKey()` now UTC. Minor: buy *position* cost-basis still uses intended USD (sells already measure proceeds)
- ✅ P1-3 Gas reserve before buys (`GAS_RESERVE_MULT`)
- ✅ P1-4 Bounded approvals (exact amount) + 0x AllowanceHolder allowlist + `to===spender`. Minor: no stale-allowance reset-to-0 (low risk with exact + transient AllowanceHolder)
- ✅ P1-5 Per-token concentration cap (opt-in) in settle/createBot/createSniper. Minor: runtime check not reserved across concurrent same-tick buys (create-time + daily/lifetime caps backstop)
- ✅ P1-6 Confirmed buy with failed after-read books spend + flags untrusted
- 🟡 P1-7 Re-buy closed via boot-disarm; no flush-in-mirrorLive / no pending-buy journal
- 🟡 P1-8 Price-impact abort + raised cost; no per-pool slippage scaling / no explicit slippageBps from engine
- 🟡 P1-9 Pool prices timestamped; no stale→exit trigger, no tight sniper poll
- ✅ P1-10 Honest copy ("Adapts to the regime, defends capital"; "capital-preserving default, not a profit guarantee" in strategies.ts + App.tsx) + fast drawdown-from-peak crash exit added to the adaptive strategy
- ✅ P1-11 Profit Finder OOS-ranked + survivorship labels
- ✅ P1-12 Graceful drain on SIGTERM/SIGINT (`index.ts` → `stopEngine` awaits in-flight lanes via `drainLanes`); removed `store.ts`'s synchronous `process.exit(0)`
- 🟡 P1-13 `.nvmrc` added; launcher doesn't read it / falls back to ambient Node; no supervisor; `tradeDbReady()` not surfaced
- ✅ P1-14 `GET /health` (tick age, mode, bot counts, spend vs cap, breaker, provider heartbeats, db) + env-gated webhook/Telegram notifier on halt/breaker/stall/untrusted-ledger/start/shutdown (`health.ts`)
- 🟡 P1-15 Receipt timeouts 90s; still re-approves every sell (no allowance read)

## P2 — lower urgency
Done: ✅ P2-3 (WS upgrade auth + `:address`/`:cg` param validation), ✅ P2-4 (flushNow on live
control-plane writes), ✅ P2-5 (candle-free protective SL/TP), ✅ P2-8 (DCA 50h downtrend filter
+ tighter capitulation), ✅ P2-9 (manual-snipe pool-liquidity floor + budget-vs-liquidity cap),
✅ P2-10 (daily-cap fail-closed at arm), ✅ P2-12 (boot rejects malformed cap envs), ✅ P2-14
(autopilot Stop/Delete race + delete budget reclaim), ✅ P2-15 (strict-win counting + on-chain
sniper decimals when live), ✅ P2-2 (cross-origin mutations rejected server-side), ✅ P2-13
(launcher reads `.nvmrc` + exits non-zero on no modern Node; `tradeDbReady` already on /health).
P2-7 approve-gas leg landed with P0-9 (min-economic-trade guard open).
Still open: P2-1 (MEV/private-RPC — needs real endpoints), P2-6 (closed-bar eval — behavior
change), P2-11 (fail-fast if dedicated RPC unset — debatable; public RPCs work), P2-7
(min-economic-trade guard — low value on cheap L2s).

---

## This session — P0-6 / P1-4 / P1-5 cluster ✅ DONE
The three "drains your wallet" risks. 464 server tests pass (+14), `tsc --noEmit` clean.

- **P0-6c** ✅ proxy / reclaimable-ownership → non-tradeable for snipes (`risk-screen.ts` strict mode)
- **P0-6d** ✅ require BOTH safety providers to pass for a snipe (strict mode)
- **P0-6a** ✅ per-snipe stake cap `MAX_SNIPE_EQUITY_PCT` × lifetime ceiling (`safety-math.ts`/`engine.ts` createSniper)
- **P1-4** ✅ bounded approvals (exact amount, not maxUint256) at all 3 sites + 0x
  AllowanceHolder allowlist + `to === spender` invariant (`live.ts assertZeroxRoute`)
- **P1-5** ✅ per-token concentration cap `MAX_TOKEN_EXPOSURE_PCT` × lifetime ceiling,
  enforced in settle (runtime) + createBot + createSniper

Files: `risk-screen.ts`, `screen-fetch.ts` (strict threaded + cache-keyed), `safety-math.ts`
(`snipeSizeError`/`tokenExposureError`), `live.ts` (`assertZeroxRoute`, exact approvals),
`engine.ts` (env helpers, `liveTokenExposureUsd`, wiring), `.env.example`. Tests:
`audit-fixes.test.ts` (strict + caps), `live-exec.test.ts` (P1-4 route/approval),
`create-sniper.test.ts` (strict integration); fixtures in `swap.test.ts`/`live-exec.test.ts`
updated to the real AllowanceHolder route.

Design notes:
- Equity-relative caps (P0-6a, P1-5) are keyed to `MAX_LIVE_USD_TOTAL` and default OFF
  (pct env unset = off), matching the existing safety-env convention. Recommended values
  (`MAX_SNIPE_EQUITY_PCT=25`, `MAX_TOKEN_EXPOSURE_PCT=40`) shipped in `.env.example`. The
  default-ON sniper hardening is the strict screen (P0-6c/d), which also applies to paper
  snipes so the simulation matches the live gate.
- The 0x route pin (P1-4) is hard-reject with a `ZEROX_ALLOWANCE_HOLDER` env extend-escape
  for redeploys; the exact-amount approval + `to===spender` are deployment-independent.

## Session 2 — P1-14 / P1-12 / P1-2 cluster ✅ DONE
Operational readiness + accounting. 474 server tests pass (+10), `tsc --noEmit` clean.

- **P1-14** ✅ `GET /health` (503 when degraded/stalled) + `health.ts` provider heartbeats
  (CoinGecko/0x/Jupiter instrumented) + env-gated notifier (webhook + Telegram), fired on
  bot-halt, breaker-trip, tick-stall (watchdog), untrusted-ledger, start, shutdown.
- **P1-12** ✅ `stopEngine()` drains in-flight swap lanes (`drainLanes`) under a bounded
  race on SIGTERM/SIGINT in `index.ts`; `store.ts`'s synchronous `process.exit(0)` removed.
- **P1-2** ✅ buys book the measured native outflow (input+gas) to the daily/lifetime caps
  when readable (defensive fallback to intended USD); `dayKey()` → UTC.

Files: `health.ts` (new), `lanes.ts` (`drainLanes`), `engine.ts` (tick heartbeat, watchdog,
`stopEngine`, `engineHealth`, native-outflow in `mirrorLive`, cap booking, notify hooks),
`store.ts` (UTC `dayKey`, removed signal exit), `index.ts` (graceful shutdown + start alert),
`app.ts` (`/health`), `prices.ts`/`live.ts`/`live-solana.ts` (provider heartbeats),
`.env.example` (ALERT_*). Tests: `observability.test.ts` (new), `http.test.ts` (/health),
`live-mirror.test.ts` (native-outflow measured + fallback).

## Session 3 — P1-10 ✅ DONE
Stop over-promising. 475 server tests pass (+1), web 74, tsc clean.
- Honest copy: adaptive tagline/description (`strategies.ts`) + the one-click card (`App.tsx`)
  reframed as a capital-preserving default, returns-not-guaranteed (removed "Profits in any
  market" / "Backtested to profit in … markets").
- Fast crash exit: a drawdown-from-peak exit (`max(2×stopLoss, 10)%` off peak) in the
  adaptive strategy, firing before the slow 50h-average regime check. Test in `adaptive.test.ts`.

## Session 4 — P0-9 ✅ DONE
Honest cost model. 478 server tests pass (+3 net), web 74, both tsc clean.
- `costs.ts`: per-side cost = LP fee (0.3%) + slippage/impact (0.7%) = ~1%/side (was 0.6%).
- `backtest.ts`: one-time approve-gas leg on the first sell; per-coin cohort median
  (`stampCohortMedian`) so the table shows "typical" beside best-of-N; caveat expanded.
- `ProfitFinder.tsx` + `types.ts`: render the "typ X%" median; `DOCS.md` Profit Finder
  section rewritten (realistic costs / walk-forward / best-vs-typical / survivorship).
- Tests now assert the HONEST consequences: adaptive is bounded (not profitable) in
  range/chop after costs; the tight-grid edge is ERASED; meanrev range loss bounded not
  catastrophic; cost-constant + approve-leg + cohort-median guards added.
- Note: the higher cost made several synthetic-regime "profit" assertions false — they were
  updated to the truth (the whole point of P0-9), NOT softened to force a pass.

## Session 5 — P2 safety batch ✅ DONE
483 server tests pass (+5), web 74, both tsc clean.
- **P2-15a** strict win-counting: `pnl > $0.01` is a win, break-even/dust is neither
  (`engine.ts` `DUST_PNL`, `db.ts` win query) — stops win-rate inflation.
- **P2-15b** sniper decimals read on-chain (EVM live via `live.tokenInfo`) when not provided;
  paper/no-signer falls back to 18.
- **P2-10** live arming fail-closed: `POST /api/mode live` rejects when `MAX_LIVE_USD_PER_DAY<=0`.
- **P2-12** boot rejects a malformed safety-cap env (`invalidCapEnv` in `app.ts`, wired in
  `index.ts`) — a typo no longer silently parses to 0 = unlimited.
- **P2-3** WS upgrade gated by the engine token (`verifyClient` in `index.ts`; web passes
  `?token=`); `/api/coin|candles|smart-money/wallet|wallet` params validated (`validators.ts`
  `CG_ID`/`isKnownAddress`) → bad input 400s before any outbound fetch.
- **P2-9** `createSniper` enforces a pool-liquidity floor ($2k) + budget ≤1.5% of pool;
  auto-sniper passes discovery's liquidity, manual path fetches it (`poolLiquidityUsd`),
  unknown liquidity → refuse.

Tests: `create-sniper.test.ts` (liquidity floor/budget/unknown), `http.test.ts` (param
validation + `invalidCapEnv`), plus the dust-win behaviour exercised via the engine suites.

## Session 6 — P2 tail: correctness + durability ✅ DONE
489 server tests pass (+6), tsc clean.
- **P2-5** `slTpFallback` (engine.ts) runs a candle-free stop-loss/take-profit on the live
  spot price when candle data is unavailable, hoisted into `tickBot`'s outage gate.
- **P2-8** DCA gets a 50h downtrend filter (skip new slices >8% below the 50h mean) and a
  tighter capitulation stop (2× from 2.5×) — no more martingale into a dying token.
- **P2-14** `autoScan`/`followScan` re-read `enabled` (+ caps) across the spawn awaits so a
  Stop mid-scan halts further snipes/mirrors; `deleteBot` reclaims a running spawn's cash to
  its auto/follow pool (reclaim-flag guarded against double-count).
- **P2-4** live `createBot`/`createSniper` + the autopilot pool decrements `flushNow()` so a
  just-armed live position survives a crash in the debounce window.
Tests: `p2-tail.test.ts` (fallback SL/TP, DCA filter, delete reclaim).

## Session 7 — P2 tail: CSRF + launcher ✅ DONE
491 server tests pass (+2), tsc clean.
- **P2-2** `app.ts` rejects cross-origin MUTATIONS server-side (403) — cors() only omits
  headers, so a malicious page's no-cors POST still ran; now blocked before any handler.
  Origin-less callers pass (no browser CSRF surface; the token gates them).
- **P2-13** `launch.mjs` prefers the `.nvmrc`-pinned Node and EXITS NON-ZERO when no Node
  >=22.5 is found (override `PULSETRADE_ALLOW_LEGACY_NODE=1`) instead of silently disabling
  the durable ledger. (`tradeDbReady` is already surfaced on `/health` via engineHealth.)
Tests: `http.test.ts` (cross-origin 403, same-origin/origin-less pass).

### Remaining (deliberate calls — not done)
- **P2-1** MEV/private-RPC + Jito: needs real protected endpoints; can't implement/test
  without infra. Operational config, not a code change.
- **P2-6** closed-bar evaluation: changes live trade cadence broadly; behavior-risky, would
  churn many tests — do deliberately if desired.
- **P2-11** fail-fast if dedicated RPC unset when live: debatable (public RPCs work, just
  rate-limited) — left as a non-blocking gap rather than forcing paid RPC.
- **P2-7** min-economic-trade guard: low value on cheap L2s (gas is cents; the $10 budget
  floor already covers it) — skipped to avoid false rejections.
Partials: P1-7 (pending-buy journal), P1-9 (stale→exit + tight sniper poll), P1-15 (allowance
read). Plus the minor notes on P0-4/P0-5/P0-8 in the P0 list above.
