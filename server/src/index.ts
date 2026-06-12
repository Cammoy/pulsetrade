import express from 'express'
import cors from 'cors'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { state, save } from './store.js'
import { NETWORKS } from './networks.js'
import { STRATEGIES } from './strategies.js'
import { RISK } from './risk.js'
import { startEngine, createBot, createSniper, createCopyBot, createAiBot, controlBot, deleteBot, serializeBot, trimTrades, startAutoSniper, stopAutoSniper, autoSniperStats, startTournament, endTournament, deleteTournament, serializeTournament } from './engine.js'
import { backtest, profitFinder } from './backtest.js'
import { liveReady, botWalletAddress } from './live.js'
import { screenToken, screenAddress } from './screen-fetch.js'
import { discoverSafePools } from './sniper.js'
import { listWallets, addWallet, removeWallet, smartMoneyFeed, trackingReady, tokensForCopyTrade } from './smartmoney.js'
import { aiReady } from './ai-trader.js'

const app = express()
app.use(cors())
app.use(express.json())

app.get('/api/meta', (_req, res) => {
  res.json({
    networks: NETWORKS,
    strategies: STRATEGIES.map(({ id, name, tagline, description }) => ({ id, name, tagline, description })),
    risk: RISK,
    live: { ready: liveReady(), botWallet: botWalletAddress() },
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
    autoSniper: state.autoSniper ? { ...state.autoSniper, tried: undefined, stats: autoSniperStats() } : null,
    tournaments: state.tournaments.map(serializeTournament),
    smartMoney: { tracking: trackingReady() },
    mode: state.settings.mode,
  })
})

app.get('/api/pnl/monthly', (_req, res) => {
  res.json(state.monthly)
})

// ── Pre-trade risk screening ─────────────────────────────────────────────────
app.get('/api/screen/:network/:symbol', async (req, res) => {
  res.json(await screenToken(req.params.network, req.params.symbol))
})

app.post('/api/screen', async (req, res) => {
  const { network, address, symbol } = req.body ?? {}
  if (!network || !address) return res.status(400).json({ error: 'network and address required' })
  res.json(await screenAddress(network, address, symbol))
})

// ── Sniper (safe-only feed: verified · sellable · distributed holders) ──────
app.get('/api/sniper/pools', async (req, res) => {
  const network = String(req.query.network ?? 'base')
  const mode = req.query.mode === 'trending' ? 'trending' : 'new'
  res.json(await discoverSafePools(network, mode))
})

app.post('/api/sniper', async (req, res) => {
  const out = await createSniper(req.body ?? {})
  if ('error' in out) return res.status(400).json(out)
  res.json(serializeBot(out))
})

// ── Auto-Sniper ──────────────────────────────────────────────────────────────
app.post('/api/auto-sniper', (req, res) => {
  const out = startAutoSniper(req.body ?? {})
  if (out && 'error' in out) return res.status(400).json(out)
  res.json({ ...out, tried: undefined, stats: autoSniperStats() })
})

app.post('/api/auto-sniper/stop', (req, res) => {
  const out = stopAutoSniper(Boolean(req.body?.liquidate))
  res.json(out ? { ...out, tried: undefined, stats: autoSniperStats() } : null)
})

// ── Smart money / wallet tracking & copy trading ────────────────────────────
app.get('/api/wallets', (_req, res) => res.json({ wallets: listWallets(), tracking: trackingReady() }))

app.post('/api/wallets', (req, res) => {
  const out = addWallet(req.body?.address ?? '', req.body?.label ?? '')
  if ('error' in out) return res.status(400).json(out)
  res.json(out)
})

app.delete('/api/wallets/:address', (req, res) => res.json({ ok: removeWallet(req.params.address) }))

app.get('/api/smart-money/:network', async (req, res) => {
  res.json(await smartMoneyFeed(req.params.network))
})

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

app.post('/api/profit-finder', async (req, res) => {
  const { budgetUsd, network, token, scope } = req.body ?? {}
  const out = await profitFinder({ budgetUsd: Number(budgetUsd), network, token, scope })
  if ('error' in out) return res.status(400).json(out)
  res.json(out)
})

app.post('/api/bots', (req, res) => {
  const out = createBot(req.body ?? {})
  if ('error' in out) return res.status(400).json(out)
  res.json(serializeBot(out))
})

app.post('/api/bots/:id/:action', (req, res) => {
  const action = req.params.action as 'pause' | 'resume' | 'stop'
  if (!['pause', 'resume', 'stop'].includes(action)) return res.status(400).json({ error: 'bad action' })
  const out = controlBot(req.params.id, action)
  if ('error' in out) return res.status(404).json(out)
  res.json(serializeBot(out))
})

app.delete('/api/bots/:id', (req, res) => {
  res.json({ ok: deleteBot(req.params.id) })
})

app.post('/api/backtest', async (req, res) => {
  const { network, tokenCg, strategy, risk, budgetUsd } = req.body ?? {}
  const out = await backtest({ network, tokenCg, strategy, risk, budgetUsd: Number(budgetUsd) || 1000 })
  res.json(out)
})

app.get('/api/candles/:cg', async (req, res) => {
  const { getCandles } = await import('./prices.js')
  res.json(await getCandles(req.params.cg, Number(req.query.days) || 7))
})

app.post('/api/mode', (req, res) => {
  const mode = req.body?.mode
  if (mode === 'live' && !liveReady())
    return res.status(400).json({ error: 'Live mode needs ZEROX_API_KEY and BOT_WALLET_KEY in server/.env' })
  if (mode !== 'paper' && mode !== 'live') return res.status(400).json({ error: 'bad mode' })
  state.settings.mode = mode
  save()
  res.json({ mode })
})

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
const sockets = new Set<WebSocket>()
wss.on('connection', (ws) => {
  sockets.add(ws)
  ws.on('close', () => sockets.delete(ws))
})

startEngine((msg) => {
  const data = JSON.stringify(msg)
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(data)
})

const PORT = Number(process.env.ENGINE_PORT) || 8787
server.listen(PORT, () => console.log(`[server] http://localhost:${PORT} (mode: ${state.settings.mode})`))
