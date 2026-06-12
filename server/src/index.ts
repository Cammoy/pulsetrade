import express from 'express'
import cors from 'cors'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { state, save } from './store.js'
import { NETWORKS } from './networks.js'
import { STRATEGIES } from './strategies.js'
import { RISK } from './risk.js'
import { startEngine, createBot, createSniper, controlBot, deleteBot, serializeBot, trimTrades } from './engine.js'
import { backtest, profitFinder } from './backtest.js'
import { liveReady, botWalletAddress } from './live.js'
import { screenToken, screenAddress } from './screen-fetch.js'
import { discoverPools } from './sniper.js'

const app = express()
app.use(cors())
app.use(express.json())

app.get('/api/meta', (_req, res) => {
  res.json({
    networks: NETWORKS,
    strategies: STRATEGIES.map(({ id, name, tagline, description }) => ({ id, name, tagline, description })),
    risk: RISK,
    live: { ready: liveReady(), botWallet: botWalletAddress() },
    mode: state.settings.mode,
  })
})

app.get('/api/state', (_req, res) => {
  trimTrades()
  res.json({
    bots: state.bots.map(serializeBot),
    trades: state.trades.slice(-500).reverse(),
    monthly: state.monthly,
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

// ── Sniper ───────────────────────────────────────────────────────────────────
app.get('/api/sniper/pools', async (req, res) => {
  const network = String(req.query.network ?? 'base')
  const mode = req.query.mode === 'trending' ? 'trending' : 'new'
  res.json(await discoverPools(network, mode))
})

app.post('/api/sniper', async (req, res) => {
  const out = await createSniper(req.body ?? {})
  if ('error' in out) return res.status(400).json(out)
  res.json(serializeBot(out))
})

app.post('/api/profit-finder', async (req, res) => {
  const { budgetUsd, network, token } = req.body ?? {}
  const out = await profitFinder({ budgetUsd: Number(budgetUsd), network, token })
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
