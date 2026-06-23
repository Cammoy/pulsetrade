// The Express application + its auth gate, assembled by `createApp()`. Kept
// separate from index.ts (the process bootstrap: listen, WebSocket, engine, boot
// guards) so the HTTP surface can be unit-tested without starting a server,
// opening a socket, or running the engine. index.ts wires this into a real
// server; tests import `createApp` and the pure boot-guard helpers directly.

import express from 'express'
import cors from 'cors'
import { timingSafeEqual } from 'node:crypto'
import { state, flushNow, setWatchlist, uid, type SwapRecord } from './store.js'
import { queryTrades, tradeStats, tradeDbReady } from './db.js'
import { NETWORKS, networkById } from './networks.js'
import { STRATEGIES } from './strategies.js'
import { RISK } from './risk.js'
import { createBot, createSniper, createCopyBot, createAiBot, controlBot, archiveBot, editBot, deleteBot, serializeBot, trimTrades, startAutoSniper, stopAutoSniper, serializeAutoSniper, startTournament, endTournament, deleteTournament, serializeTournament, startFollow, stopFollow, deleteFollow, serializeFollow, reconcileRealHeld, maxLiveUsdPerDay, spentTodayUsd, maxCumulativeLossUsd, maxLiveUsdTotal, breakerState, resetBreaker, profitVault, listWithdrawals, requestWithdrawal, engineHealth } from './engine.js'
import { addLot, addSell, editLot, removeLot, removeSell, removeAsset, valueTracker, trackerHistory, searchCoins, coinMarket } from './tracker.js'
import { backtest, profitFinder } from './backtest.js'
import { liveReady, botWalletAddress, evmSigner, swapPrice0x, executeSwapGeneral, tokenInfo, swapBalance, lifiQuote, executeCrossChainEvm, LIFI_SOLANA_CHAIN } from './live.js'
import { tokenList } from './tokens-list.js'
import { spot } from './prices.js'
import { solanaLiveReady, solanaWalletAddress, solanaSigner, jupiterQuote, splTokenInfo, splTokenBalanceBaseUnits, executeSolanaSwap, executeCrossChainSolana, SOL_MINT } from './live-solana.js'
import { screenToken, screenAddress } from './screen-fetch.js'
import { discoverSafePools } from './sniper.js'
import { listWallets, addWallet, removeWallet, smartMoneyFeed, walletProfile, trackingReady, tokensForCopyTrade, gatherConsensusHoldings, smartMoneyLeaderboard } from './smartmoney.js'
import { EVM_ADDR, CG_ID, isKnownAddress } from './validators.js'
import { smartMoneyIntelligence } from './smart-insights.js'
import { aiReady } from './ai-trader.js'
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express'

/** Wrap an async route so a rejected promise becomes a clean 500 instead of an
 *  unhandled rejection that hangs the client and can crash the process. */
const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next)

/**
 * Constant-time check of a caller-provided token against the engine token.
 * Pure (token passed in) so it is unit-testable. Returns false when either side
 * is missing, and the length pre-check keeps timingSafeEqual from throwing on a
 * mismatched-length buffer (which would itself be a side channel).
 */
export function tokenOk(provided: string | undefined, engineToken: string | undefined): boolean {
  if (!engineToken || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(engineToken)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Should a WebSocket upgrade be allowed? Open when no token is configured (dev); otherwise
 *  the request must carry the matching `?token=`. Pure (URL + token in) so it's unit-testable
 *  independently of the live server. The WS feed leaks positions/fills/wallets, so this is the
 *  same fail-closed boundary as the HTTP mutating routes. [P2-3] */
export function wsAuthOk(reqUrl: string | undefined, engineToken: string | undefined): boolean {
  if (!engineToken) return true
  const tok = new URL(reqUrl ?? '', 'http://localhost').searchParams.get('token') ?? undefined
  return tokenOk(tok, engineToken)
}

// ── Pure boot guards (no process.exit / no I/O — testable in isolation) ───────

/** SAFE BOOT: a persisted LIVE mode must NOT auto-resume on a restart unless the
 *  operator explicitly opts in. True ⇒ downgrade to paper. */
export const shouldDowngradeLiveOnBoot = (mode: string, resumeEnv: string | undefined): boolean =>
  mode === 'live' && resumeEnv !== 'true'

/** FAIL-CLOSED: never run with live trading armed but no auth token — an
 *  unauthenticated engine holding live wallet keys can be drained. True ⇒ refuse boot. */
export const liveArmedButNoToken = (liveArmed: boolean, engineToken: string | undefined): boolean =>
  liveArmed && !engineToken

/** Every numeric safety env that, if SET but malformed, would silently parse to 0 via
 *  `Number(x) || 0` — i.e. "no cap / no reserve". A typo there opens a hole, so reject it
 *  at boot (fail loud) instead of running unbounded. Returns an error string or null. [P2-12] */
export const NUMERIC_SAFETY_ENVS = [
  'MAX_LIVE_USD_PER_DAY', 'MAX_LIVE_USD_TOTAL', 'MAX_CUMULATIVE_LOSS_USD', 'MAX_FLEET_DRAWDOWN_PCT',
  'MAX_SNIPE_EQUITY_PCT', 'MAX_TOKEN_EXPOSURE_PCT', 'GAS_RESERVE_MULT', 'MAX_PRICE_IMPACT_PCT', 'MAX_SLIPPAGE_BPS',
] as const
export function invalidCapEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const k of NUMERIC_SAFETY_ENVS) {
    const v = env[k]
    if (v === undefined || v === '') continue // unset = use the documented default
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0)
      return `${k}="${v}" is not a valid non-negative number — fix or unset it (a malformed value would silently parse to 0 = unlimited/no-reserve).`
  }
  return null
}

/** Warnings when live is armed but no DEDICATED RPC is configured for a ready chain: public
 *  RPCs rate-limit and serve stale state under 24/7 load (feeding stale balances into the
 *  sell-clamp). EVM RPC is per-chain (EVM_RPC_URL_<chainId>); Solana is SOLANA_RPC_URL.
 *  Advisory by default; REQUIRE_DEDICATED_RPC=true turns these into a hard arm-time block. [P2-11] */
export function missingDedicatedRpc(evmReady: boolean, solReady: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  if (evmReady && !Object.keys(env).some((k) => /^EVM_RPC_URL_\d+$/.test(k) && env[k]))
    out.push('No dedicated EVM RPC (EVM_RPC_URL_<chainId>) — live EVM trading will use rate-limited public nodes.')
  if (solReady && !env.SOLANA_RPC_URL)
    out.push('No SOLANA_RPC_URL — live Solana trading will use the throttled public mainnet-beta.')
  return out
}

/**
 * Build the Express app. `engineToken` gates every mutating request; when it is
 * undefined auth is disabled (local dev) — the bootstrap separately refuses to
 * boot live with no token, so an unauthenticated engine is always paper-only.
 */
export function createApp(engineToken: string | undefined = process.env.ENGINE_TOKEN): Express {
  const app = express()

  // Only same-machine origins may drive the engine. Without this, any website the
  // user visits could POST to localhost and flip live mode / move funds (CSRF).
  app.use(
    cors({
      origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/],
    }),
  )
  // cors() only OMITS response headers for a disallowed origin — the request still reaches
  // Express and executes. So reject cross-origin MUTATIONS server-side: a malicious page's
  // no-cors POST carries its Origin, and we 403 it before any handler runs. Defense-in-depth
  // beside ENGINE_TOKEN, and the only gate in token-less local-dev mode. Origin-less callers
  // (curl/server-to-server) have no browser CSRF surface and pass (the token still gates them). [P2-2]
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
    const origin = req.get('origin')
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
      return res.status(403).json({ error: 'cross-origin request blocked' })
    next()
  })
  app.use(express.json({ limit: '256kb' }))

  // ── Auth ───────────────────────────────────────────────────────────────────
  // Every state-changing request must carry the shared token; reads (GET/HEAD)
  // and the WS feed stay open. The client sends `Authorization: Bearer <token>`.
  app.use((req, res, next) => {
    if (!engineToken) return next()
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
    const auth = req.get('authorization')
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
    if (tokenOk(bearer ?? req.get('x-engine-token') ?? undefined, engineToken)) return next()
    res.status(401).json({ error: 'unauthorized' })
  })

  // Liveness/observability probe (GET → unauthenticated, like the other reads). A
  // monitor or the operator polls this for tick age, mode, spend-vs-cap, breaker state,
  // provider heartbeats and the SQLite ledger status. 200 when ok, 503 when degraded
  // (stalled tick) or the breaker is tripped, so a uptime check pages on it. [P1-14]
  app.get('/health', (_req, res) => {
    const h = engineHealth()
    res.status(h.status === 'ok' ? 200 : 503).json(h)
  })

  app.get('/api/meta', (_req, res) => {
    res.json({
      networks: NETWORKS,
      strategies: STRATEGIES.map(({ id, name, tagline, description }) => ({ id, name, tagline, description })),
      risk: RISK,
      live: {
        ready: liveReady() || solanaLiveReady(),
        botWallet: botWalletAddress(),
        evm: { ready: liveReady(), wallet: botWalletAddress(), signer: evmSigner() },
        solana: { ready: solanaLiveReady(), wallet: solanaWalletAddress(), signer: solanaSigner() },
        icp: { ready: false, reason: 'KongSwap/ICPSwap are canister-only DEXes — live executor pending' },
        maxUsdPerDay: maxLiveUsdPerDay(),
        spentTodayUsd: spentTodayUsd(),
        maxCumulativeLossUsd: maxCumulativeLossUsd(),
        maxLiveUsdTotal: maxLiveUsdTotal(),
        breaker: breakerState(),
      },
      features: { ai: aiReady(), walletTracking: trackingReady() },
      copyTokens: tokensForCopyTrade(),
      mode: state.settings.mode,
    })
  })

  app.get('/api/state', (_req, res) => {
    trimTrades()
    res.json({
      bots: state.bots.map(serializeBot),
      trades: state.trades.slice(-500).reverse(),
      monthly: state.monthly,
      autoSniper: state.autoSniper ? serializeAutoSniper(state.autoSniper) : null,
      tournaments: state.tournaments.map(serializeTournament),
      follows: state.follows.map(serializeFollow),
      swaps: state.swaps.slice(-100).reverse(), // newest first
      smartMoney: { tracking: trackingReady() },
      mode: state.settings.mode,
    })
  })

  app.get('/api/pnl/monthly', (_req, res) => {
    res.json(state.monthly)
  })

  // ── Pre-trade risk screening ───────────────────────────────────────────────
  app.get('/api/screen/:network/:symbol', ah(async (req, res) => {
    res.json(await screenToken(req.params.network, req.params.symbol))
  }))

  app.post('/api/screen', ah(async (req, res) => {
    const { network, address, symbol } = req.body ?? {}
    if (!network || !address) return res.status(400).json({ error: 'network and address required' })
    res.json(await screenAddress(network, address, symbol))
  }))

  // ── Manual swap (0x on EVM, Jupiter on Solana) ─────────────────────────────
  // A general tokenA→tokenB swap for the user. Quotes/reads are GET (no auth);
  // execution moves real funds so it's a POST (auth-gated above). `'native'` means
  // the chain's native coin (ETH/BNB/… via the 0xEeee sentinel, or SOL via SOL_MINT).
  const swapNet = (network: string) => {
    const net = networkById(network)
    return net && net.tradeable !== false && (net.evm === true || net.id === 'solana') ? net : null
  }
  const validSwapAddr = (evm: boolean, addr: string) => addr === 'native' || (evm ? /^0x[a-fA-F0-9]{40}$/.test(addr) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr))

  // Cross-chain (LI.FI) helpers: a network's LI.FI chain id, the bot's wallet on that
  // chain (the receive address — null when no signer), and a neutral routing placeholder
  // for preview-only quotes (execution always uses the real wallet).
  const lifiChainOf = (n: { id: string; chainId: number }) => (n.id === 'solana' ? LIFI_SOLANA_CHAIN : n.chainId)
  const swapWalletOf = (n: { id: string }) => (n.id === 'solana' ? solanaWalletAddress() : botWalletAddress())
  const previewAddrOf = (n: { id: string }) => (n.id === 'solana' ? '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9' : '0x000000000000000000000000000000000000dEaD')

  // Price-impact backstop for a MANUAL EVM swap: the FAIR (no-impact) token-out in buy-token
  // base units, from INDEPENDENT spot prices. executeSwapGeneral aborts if the quoted output
  // falls > MAX_PRICE_IMPACT_PCT below this (the same guard the bot path has). Returns
  // undefined for a pasted/unpriceable token — then the (capped) slippage + the EVM honeypot
  // screen are the protection. EVM-only (Solana's executeSolanaSwap has its own impact guard).
  type SwapNet = NonNullable<ReturnType<typeof networkById>>
  const swapTokenMeta = (n: SwapNet, t: string): { cg: string; decimals: number } | null => {
    if (t === 'native') return { cg: n.native.cg, decimals: 18 }
    const lc = t.toLowerCase()
    if (lc === n.usdt.address.toLowerCase()) return { cg: n.usdt.cg, decimals: n.usdt.decimals }
    const tok = n.tokens.find((x) => x.address.toLowerCase() === lc)
    return tok ? { cg: tok.cg, decimals: tok.decimals } : null
  }
  const fairBuyBaseUnits = (n: SwapNet, sell: string, buy: string, amt: bigint): bigint | undefined => {
    const sm = swapTokenMeta(n, sell)
    const bm = swapTokenMeta(n, buy)
    if (!sm || !bm) return undefined
    const sp = spot(sm.cg)
    const bp = spot(bm.cg)
    if (!sp || !bp || sp <= 0 || bp <= 0) return undefined
    // bigint-safe: amt × (sellPx/buyPx, fixed-point 1e9) × 10^buyDec / (10^sellDec × 1e9)
    const ratio = BigInt(Math.round((sp / bp) * 1e9))
    return (amt * ratio * 10n ** BigInt(bm.decimals)) / (10n ** BigInt(sm.decimals) * 1_000_000_000n)
  }

  // Comprehensive per-network token list for the swap picker (CoinGecko-sourced, cached).
  app.get('/api/swap/tokens/:network', ah(async (req, res) => {
    const net = swapNet(req.params.network)
    if (!net) return res.status(400).json({ error: 'EVM chains + Solana only' })
    res.json({ tokens: await tokenList(net.id) })
  }))

  // Custom-token info (symbol/decimals) + safety screen — for the paste-an-address flow.
  app.get('/api/swap/token/:network/:address', ah(async (req, res) => {
    const net = swapNet(req.params.network)
    if (!net) return res.status(400).json({ error: 'swaps are supported on the EVM chains + Solana' })
    const address = String(req.params.address)
    if (address === 'native' || !validSwapAddr(net.evm === true, address)) return res.status(400).json({ error: 'invalid token address' })
    try {
      const info = net.evm === true ? await tokenInfo(net.chainId, address) : await splTokenInfo(address)
      const riskReport = await screenAddress(req.params.network, address, info.symbol) // EVM: real honeypot/rug screen. Solana: advisory.
      res.json({ address, symbol: info.symbol, decimals: info.decimals, tradeable: riskReport.tradeable, riskReport })
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'could not read that token' })
    }
  }))

  // Bot-wallet balance of a token, in base units.
  app.get('/api/swap/balance/:network/:token', ah(async (req, res) => {
    const net = swapNet(req.params.network)
    if (!net) return res.status(400).json({ error: 'EVM chains + Solana only' })
    try {
      const bal = net.evm === true ? await swapBalance(net.chainId, req.params.token) : await splTokenBalanceBaseUnits(req.params.token === 'native' ? SOL_MINT : req.params.token)
      res.json({ balanceBaseUnits: bal.toString() })
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'balance read failed' })
    }
  }))

  // Indicative price for the live preview (no funds move).
  app.get('/api/swap/quote', ah(async (req, res) => {
    const net = swapNet(String(req.query.network ?? ''))
    if (!net) return res.status(400).json({ error: 'swaps are supported on the EVM chains + Solana' })
    let amt: bigint
    try {
      amt = BigInt(String(req.query.sellAmount ?? ''))
    } catch {
      return res.status(400).json({ error: 'invalid sellAmount' })
    }
    if (amt <= 0n) return res.status(400).json({ error: 'amount must be greater than 0' })
    const sell = String(req.query.sellToken ?? '')
    const buy = String(req.query.buyToken ?? '')
    const bps = Number(req.query.slippageBps) || undefined
    // CROSS-CHAIN: a destination network ≠ the source → route through LI.FI. Supported
    // between any EVM chains AND Solana (either direction).
    const toId = String(req.query.toNetwork ?? '')
    if (toId && toId !== net.id) {
      const toNet = swapNet(toId)
      if (!toNet) return res.status(400).json({ error: 'unknown destination network' })
      // Preview-only: use the real wallet if set, else a neutral routing placeholder per chain.
      const fromAddr = swapWalletOf(net) || previewAddrOf(net)
      const toAddr = swapWalletOf(toNet) || previewAddrOf(toNet)
      try {
        const q = await lifiQuote({ fromChainId: lifiChainOf(net), toChainId: lifiChainOf(toNet), sellToken: sell, buyToken: buy, sellAmountBaseUnits: amt, fromAddress: fromAddr, toAddress: toAddr, slippageBps: bps })
        return res.json({ buyAmount: q.toAmount, minBuyAmount: q.toAmountMin, crossChain: true, durationSec: q.durationSec, toolName: q.toolName, gasUsd: q.gasUsd, feeUsd: q.feeUsd, totalNetworkFeeWei: null })
      } catch (e) {
        return res.status(502).json({ error: e instanceof Error ? e.message : 'bridge quote failed' })
      }
    }
    try {
      if (net.evm === true) {
        res.json(await swapPrice0x(net.chainId, sell, buy, amt, bps))
      } else {
        const q = await jupiterQuote(sell === 'native' ? SOL_MINT : sell, buy === 'native' ? SOL_MINT : buy, amt, bps)
        res.json({ buyAmount: q.outAmount, minBuyAmount: q.minAmount, totalNetworkFeeWei: null, priceImpactPct: q.priceImpactPct })
      }
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'quote failed' })
    }
  }))

  // Execute the swap LIVE (mutating → auth-gated by the middleware above).
  app.post('/api/swap/execute', ah(async (req, res) => {
    const { network, toNetwork, sellToken, buyToken, sellAmount, slippageBps, sellSymbol, buySymbol, sellDisplay, buyDisplay } = req.body ?? {}
    const net = swapNet(String(network ?? ''))
    if (!net) return res.status(400).json({ error: 'swaps are supported on the EVM chains + Solana' })
    const crossChain = toNetwork && String(toNetwork) !== net.id
    let toNet = net
    if (crossChain) {
      const t = swapNet(String(toNetwork))
      if (!t) return res.status(400).json({ error: 'unknown destination network' })
      toNet = t
    }
    // Live gating. SAME-chain: the chain's own signer. CROSS-chain (LI.FI): the SOURCE must
    // be able to SIGN, AND the DESTINATION must have a wallet to RECEIVE into — refuse
    // otherwise so we never attempt a bridge to a chain where the user has no wallet.
    if (crossChain) {
      if (net.id === 'solana' ? !solanaLiveReady() : !liveReady())
        return res.status(400).json({ error: `live execution isn’t configured for the ${net.name} source — add its key + signer` })
      if (!swapWalletOf(toNet))
        return res.status(400).json({ error: `no ${toNet.name} wallet configured to receive the bridged funds — add its signer first` })
    } else if (net.evm === true ? !liveReady() : !solanaLiveReady()) {
      return res.status(400).json({ error: 'live execution isn’t configured for this chain — add the key + signer' })
    }
    const sell = String(sellToken ?? '')
    const buy = String(buyToken ?? '')
    let amt: bigint
    try {
      amt = BigInt(String(sellAmount ?? ''))
    } catch {
      return res.status(400).json({ error: 'invalid sellAmount' })
    }
    if (amt <= 0n) return res.status(400).json({ error: 'amount must be greater than 0' })
    // Safety-screen a CUSTOM buy token on the DESTINATION network. EVM: HARD-block
    // honeypots. Solana: advisory only (GoPlus / honeypot.is are EVM-only).
    const curated = buy.toLowerCase() === toNet.usdt.address.toLowerCase() || toNet.tokens.some((t) => t.address.toLowerCase() === buy.toLowerCase())
    if (toNet.evm === true && buy.toLowerCase() !== 'native' && !curated) {
      const report = await screenAddress(toNet.id, buy)
      if (!report.tradeable) return res.status(400).json({ error: `swap blocked by the safety screen (${report.verdict}) — that token looks unsafe to hold`, riskReport: report })
    }
    try {
      let txHash: string
      let buyAmount = ''
      let bridge: string | undefined
      if (crossChain) {
        const dst = swapWalletOf(toNet)! // guaranteed non-null by the gating above
        if (net.id === 'solana') {
          // Solana SOURCE → sign LI.FI's base64 Solana tx with the Solana signer.
          const r = await executeCrossChainSolana({ toChainId: lifiChainOf(toNet), sellToken: sell, buyToken: buy, amountBaseUnits: amt, toAddress: dst, slippageBps: Number(slippageBps) || undefined })
          txHash = r.sig
          buyAmount = r.toAmount
          bridge = r.toolName
        } else {
          // EVM SOURCE (dest EVM or Solana) → sign the EVM tx; receive at `dst`.
          const r = await executeCrossChainEvm({ fromChainId: net.chainId, toChainId: lifiChainOf(toNet), sellToken: sell, buyToken: buy, sellAmountBaseUnits: amt, toAddress: dst, slippageBps: Number(slippageBps) || undefined })
          txHash = r.hash
          buyAmount = r.toAmount
          bridge = r.toolName
        }
      } else if (net.evm === true) {
        const r = await executeSwapGeneral({ chainId: net.chainId, sellToken: sell, buyToken: buy, sellAmountBaseUnits: amt, slippageBps: Number(slippageBps) || undefined, fairBuyBaseUnits: fairBuyBaseUnits(net, sell, buy, amt) })
        txHash = r.hash
        buyAmount = r.buyAmount
      } else {
        txHash = await executeSolanaSwap({ inputMint: sell === 'native' ? SOL_MINT : sell, outputMint: buy === 'native' ? SOL_MINT : buy, amountBaseUnits: amt, slippageBps: Number(slippageBps) || undefined })
      }
      // Record the swap for the history view (display strings are formatted by the web).
      const rec: SwapRecord = { id: uid(), ts: Date.now(), network: String(network), sellSymbol: String(sellSymbol ?? sell), buySymbol: String(buySymbol ?? buy), sellAmount: String(sellDisplay ?? ''), buyAmount: String(buyDisplay ?? ''), txHash, mode: state.settings.mode, ...(crossChain ? { toNetwork: toNet.id, bridge } : {}) }
      state.swaps.push(rec)
      if (state.swaps.length > 200) state.swaps.splice(0, state.swaps.length - 200)
      flushNow()
      res.json({ txHash, buyAmount, chainId: net.evm === true ? net.chainId : undefined, crossChain: !!crossChain, bridge })
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'swap failed' })
    }
  }))

  // ── Sniper (safe-only feed: verified · sellable · distributed holders) ──────
  app.get('/api/sniper/pools', ah(async (req, res) => {
    const network = String(req.query.network ?? 'base')
    const mode = req.query.mode === 'trending' ? 'trending' : 'new'
    res.json(await discoverSafePools(network, mode))
  }))

  app.post('/api/sniper', ah(async (req, res) => {
    const out = await createSniper(req.body ?? {})
    if ('error' in out) return res.status(400).json(out)
    res.json(serializeBot(out))
  }))

  // ── Auto-Sniper ─────────────────────────────────────────────────────────────
  app.post('/api/auto-sniper', (req, res) => {
    const out = startAutoSniper(req.body ?? {})
    if (out && 'error' in out) return res.status(400).json(out)
    res.json(out ? serializeAutoSniper(out) : null)
  })

  app.post('/api/auto-sniper/stop', (req, res) => {
    const out = stopAutoSniper(Boolean(req.body?.liquidate))
    res.json(out ? serializeAutoSniper(out) : null)
  })

  // ── Smart money / wallet tracking & copy trading ───────────────────────────
  app.get('/api/wallets', (_req, res) => res.json({ wallets: listWallets(), tracking: trackingReady() }))

  app.post('/api/wallets', (req, res) => {
    const out = addWallet(req.body?.address ?? '', req.body?.label ?? '')
    if ('error' in out) return res.status(400).json(out)
    res.json(out)
  })

  app.delete('/api/wallets/:address', (req, res) => res.json({ ok: removeWallet(req.params.address) }))

  app.get('/api/smart-money/wallet/:address', ah(async (req, res) => {
    if (!EVM_ADDR.test(req.params.address)) return res.status(400).json({ error: 'invalid wallet address' })
    res.json(await walletProfile(req.params.address))
  }))

  // Cross-wallet AI intelligence — registered before /:network so 'insights'
  // isn't captured as a network param.
  app.get('/api/smart-money/insights', ah(async (_req, res) => {
    res.json(await smartMoneyIntelligence())
  }))

  // Tokens held by 2+ tracked whales right now — registered before /:network.
  app.get('/api/smart-money/consensus-holdings', ah(async (_req, res) => {
    res.json(await gatherConsensusHoldings())
  }))

  // Copy-worthiness ranking of every tracked wallet — registered before /:network.
  app.get('/api/smart-money/leaderboard', ah(async (_req, res) => {
    res.json(await smartMoneyLeaderboard())
  }))

  app.get('/api/smart-money/:network', ah(async (req, res) => {
    res.json(await smartMoneyFeed(req.params.network))
  }))

  // ── Auto-follow a smart-money wallet ───────────────────────────────────────
  app.post('/api/follows', (req, res) => {
    const out = startFollow(req.body ?? {})
    if ('error' in out) return res.status(400).json(out)
    res.json(serializeFollow(out))
  })

  app.post('/api/follows/:id/stop', (req, res) => {
    const out = stopFollow(req.params.id, Boolean(req.body?.liquidate))
    if ('error' in out) return res.status(404).json(out)
    res.json(serializeFollow(out))
  })

  app.delete('/api/follows/:id', (req, res) => res.json({ ok: deleteFollow(req.params.id) }))

  app.post('/api/copy-bot', (req, res) => {
    const out = createCopyBot(req.body ?? {})
    if ('error' in out) return res.status(400).json(out)
    res.json(serializeBot(out))
  })

  // ── AI trading ───────────────────────────────────────────────────────────────
  app.post('/api/ai-bot', (req, res) => {
    const out = createAiBot(req.body ?? {})
    if ('error' in out) return res.status(400).json(out)
    res.json(serializeBot(out))
  })

  // ── Tournaments ──────────────────────────────────────────────────────────────
  app.post('/api/tournaments', (req, res) => {
    const out = startTournament(req.body ?? {})
    if ('error' in out) return res.status(400).json(out)
    res.json(out)
  })

  app.post('/api/tournaments/:id/end', (req, res) => {
    const out = endTournament(req.params.id)
    if ('error' in out) return res.status(404).json(out)
    res.json(out)
  })

  app.delete('/api/tournaments/:id', (req, res) => res.json({ ok: deleteTournament(req.params.id) }))

  app.post('/api/profit-finder', ah(async (req, res) => {
    const { budgetUsd, network, token, scope } = req.body ?? {}
    const out = await profitFinder({ budgetUsd: Number(budgetUsd), network, token, scope })
    if ('error' in out) return res.status(400).json(out)
    res.json(out)
  }))

  app.post('/api/bots', (req, res) => {
    const out = createBot(req.body ?? {})
    if ('error' in out) return res.status(400).json(out)
    res.json(serializeBot(out))
  })

  // Archive / un-archive a bot (hide from the active list). Body: { archived: boolean }.
  // MUST be registered before the generic /:action route, which would otherwise capture
  // 'archive' as an action and reject it as "bad action".
  app.post('/api/bots/:id/archive', (req, res) => {
    const out = archiveBot(req.params.id, req.body?.archived !== false)
    if ('error' in out) return res.status(404).json(out)
    res.json(serializeBot(out))
  })

  app.post('/api/bots/:id/:action', ah(async (req, res) => {
    const action = req.params.action as 'pause' | 'resume' | 'stop'
    if (!['pause', 'resume', 'stop'].includes(action)) return res.status(400).json({ error: 'bad action' })
    const out = await controlBot(req.params.id, action) // stop awaits the on-chain sell (mirror-first)
    if ('error' in out) return res.status(404).json(out)
    res.json(serializeBot(out))
  }))

  // Adjust an existing bot's parameters (sniper TP/SL/max-hold/trailing + budget).
  // Distinct method (PATCH) on /:id, so it never collides with the POST /:action route.
  app.patch('/api/bots/:id', (req, res) => {
    const out = editBot(req.params.id, req.body ?? {})
    if ('error' in out) return res.status(out.error === 'not found' ? 404 : 400).json(out)
    res.json(serializeBot(out))
  })

  app.delete('/api/bots/:id', (req, res) => {
    res.json({ ok: deleteBot(req.params.id) })
  })

  app.post('/api/backtest', ah(async (req, res) => {
    const { network, tokenCg, strategy, risk, budgetUsd } = req.body ?? {}
    const out = await backtest({ network, tokenCg, strategy, risk, budgetUsd: Number(budgetUsd) || 1000 })
    res.json(out)
  }))

  // Re-arm the circuit breaker (mutating → requires the auth token). Resumes are
  // manual on purpose: after a breaker trip the operator must consciously re-arm.
  app.post('/api/breaker/reset', (_req, res) => res.json({ breaker: resetBreaker() }))

  // ── Profit withdrawals ─────────────────────────────────────────────────────
  // Banked profit (swept native/USDT) the operator can send to an external address.
  app.get('/api/withdrawals', (_req, res) => res.json({ vault: profitVault(), history: listWithdrawals(), mode: state.settings.mode }))

  // Withdraw profit. Mutating → auth-gated; in live mode this moves real funds, so
  // it inherits the same loopback-bind + CORS + token protections as going live.
  app.post('/api/withdraw', ah(async (req, res) => {
    const out = await requestWithdrawal(req.body ?? {})
    if ('error' in out) return res.status(400).json(out)
    res.json(out)
  }))

  // ── Manual holdings tracker (cost-basis P/L) ───────────────────────────────
  app.get('/api/tracker', ah(async (_req, res) => res.json(await valueTracker())))
  app.get('/api/tracker/history', ah(async (req, res) => {
    const days = Math.max(1, Math.min(3650, Number(req.query.days) || 30))
    res.json({ days, series: await trackerHistory(days) })
  }))
  app.get('/api/coins/search', ah(async (req, res) => res.json({ coins: await searchCoins(String(req.query.q ?? '')) })))
  app.get('/api/coin/:id', ah(async (req, res) => {
    if (!CG_ID.test(req.params.id)) return res.status(400).json({ error: 'invalid coin id' })
    const m = await coinMarket(req.params.id)
    if (!m) return res.status(404).json({ error: 'coin not found' })
    res.json(m)
  }))

  app.post('/api/tracker/lot', (req, res) => {
    const out = addLot(req.body ?? {})
    if ('error' in out) return res.status(400).json(out)
    res.json(out)
  })
  app.post('/api/tracker/sell', (req, res) => {
    const out = addSell(req.body ?? {})
    if ('error' in out) return res.status(400).json(out)
    res.json(out)
  })
  app.patch('/api/tracker/lot/:id', (req, res) => {
    const out = editLot(req.params.id, req.body ?? {})
    if ('error' in out) return res.status(400).json(out)
    res.json(out)
  })
  app.delete('/api/tracker/lot/:id', (req, res) => res.json({ ok: removeLot(req.params.id) }))
  app.delete('/api/tracker/sell/:id', (req, res) => res.json({ ok: removeSell(req.params.id) }))
  app.delete('/api/tracker/asset/:id', (req, res) => res.json({ ok: removeAsset(req.params.id) }))

  // Cross-device UI prefs (watchlist). Stored in state.json — free, no external DB.
  app.get('/api/prefs', (_req, res) => res.json(state.prefs))
  app.put('/api/prefs/watchlist', (req, res) => res.json({ watchlist: setWatchlist(req.body?.watchlist) }))

  // Full trade history + analytics from the SQLite ledger (unbounded, queryable).
  const tradeFilters = (q: any) => ({
    botId: q.botId || undefined,
    token: q.token || undefined,
    network: q.network || undefined,
    side: q.side === 'buy' || q.side === 'sell' ? q.side : undefined,
    mode: q.mode === 'paper' || q.mode === 'live' ? q.mode : undefined,
    since: q.since ? Number(q.since) : undefined,
    until: q.until ? Number(q.until) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  })
  app.get('/api/trades', (req, res) => res.json({ enabled: tradeDbReady(), trades: queryTrades(tradeFilters(req.query)) }))
  app.get('/api/trades/stats', (req, res) => res.json(tradeStats(tradeFilters(req.query))))

  app.get('/api/market', ah(async (_req, res) => {
    const { marketOverview } = await import('./market.js')
    res.json(await marketOverview())
  }))

  app.get('/api/candles/:cg', ah(async (req, res) => {
    if (!CG_ID.test(req.params.cg)) return res.status(400).json({ error: 'invalid coin id' })
    const { getCandles } = await import('./prices.js')
    res.json(await getCandles(req.params.cg, Number(req.query.days) || 7))
  }))

  // Read-only wallet portfolio (native + curated tokens across EVM chains, priced).
  app.get('/api/wallet/:address', ah(async (req, res) => {
    if (!isKnownAddress(req.params.address)) return res.status(400).json({ error: 'invalid wallet address' })
    const { readPortfolio } = await import('./portfolio.js')
    const out = await readPortfolio(req.params.address, req.query.force === '1' || req.query.force === 'true')
    if ('error' in out) return res.status(400).json(out)
    res.json(out)
  }))

  // Read-only staking view: ICP neurons (by id), Solana native staking (by wallet),
  // EVM liquid-staking tokens (by wallet). No keys, no writes — same open-read posture
  // as /api/wallet. `?evm=&solana=&neurons=id1,id2`.
  app.get('/api/staking', ah(async (req, res) => {
    const { readStaking } = await import('./staking.js')
    const neuronIds = String(req.query.neurons ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 50)
    const out = await readStaking({
      evm: req.query.evm ? String(req.query.evm) : undefined,
      solana: req.query.solana ? String(req.query.solana) : undefined,
      neuronIds,
    })
    res.json(out)
  }))

  app.post('/api/mode', (req, res) => {
    const mode = req.body?.mode
    if (mode !== 'paper' && mode !== 'live') return res.status(400).json({ error: 'bad mode' })
    if (mode === 'live' && !liveReady() && !solanaLiveReady())
      return res.status(400).json({ error: 'Live mode needs a signer in server/.env: EVM = ZEROX_API_KEY + (BOT_WALLET_KEY or Turnkey TURNKEY_API_* + TURNKEY_EVM_ADDRESS); Solana = SOLANA_WALLET_KEY or Turnkey + TURNKEY_SOLANA_ADDRESS' })
    // FAIL-CLOSED on the daily spend cap: never arm live with no per-day bound (an
    // unbounded daily cap lets a losing/runaway session drain the wallet). [P2-10]
    if (mode === 'live' && maxLiveUsdPerDay() <= 0)
      return res.status(400).json({ error: 'Set MAX_LIVE_USD_PER_DAY (a daily live-spend cap, e.g. 50) in server/.env before going live — live mode is fail-closed without a per-day spend bound.' })
    // Dedicated-RPC check: advisory by default, hard block under REQUIRE_DEDICATED_RPC. [P2-11]
    if (mode === 'live') {
      const rpcWarn = missingDedicatedRpc(liveReady(), solanaLiveReady())
      if (rpcWarn.length) {
        if (process.env.REQUIRE_DEDICATED_RPC === 'true')
          return res.status(400).json({ error: `Live blocked (REQUIRE_DEDICATED_RPC): ${rpcWarn.join(' ')}` })
        for (const w of rpcWarn) console.warn(`[server] ⚠ ${w}`)
      }
    }
    const wasPaper = state.settings.mode !== 'live'
    state.settings.mode = mode
    flushNow() // arming/disarming live trading must survive a crash immediately
    // Re-derive per-bot realHeld from the real wallet when arming live — paper
    // positions were built without a live ledger, so attribution must be seeded
    // from chain (otherwise the first live sells lose per-bot attribution).
    if (mode === 'live' && wasPaper) void reconcileRealHeld().catch((e) => console.error('[server] realHeld reconcile on mode flip failed', e))
    res.json({ mode })
  })

  // Unknown API routes get a JSON 404 (not Express's HTML page the client can't parse).
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }))

  // Terminal error handler — async routes funnel rejections here via ah().
  // Honor a 4xx client error (e.g. body-parser tags a malformed JSON body as 400)
  // so a caller's mistake isn't mis-reported as a server fault; only genuine 5xx
  // faults are logged at error level. Everything unclassified defaults to 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode
    const code = Number.isInteger(status) && status! >= 400 && status! < 500 ? status! : 500
    if (code >= 500) console.error('[server] request error:', err)
    if (!res.headersSent) res.status(code).json({ error: code >= 500 ? 'internal error' : 'bad request' })
  })

  return app
}
