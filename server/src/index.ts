// Process bootstrap: load env, build the app, start the HTTP + WebSocket server
// and the trading engine, and enforce the boot guards. The HTTP surface itself
// lives in app.ts (createApp) so it can be tested without any of this.
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { state, flushNow, DATA_DIR } from './store.js'
import { initTradeDb, backfillTrades } from './db.js'
import { startEngine, stopEngine, disarmLiveBotsForBoot } from './engine.js'
import { liveReady } from './live.js'
import { solanaLiveReady } from './live-solana.js'
import { createApp, shouldDowngradeLiveOnBoot, liveArmedButNoToken, invalidCapEnv, tokenOk } from './app.js'
import { notifyAsync, notify } from './health.js'

// Load server/.env (ETHERSCAN_API_KEY, GEMINI_API_KEY, live keys, ENGINE_TOKEN)
// with a tiny dependency-free parser. process.loadEnvFile is Node ≥20.12 only and
// the dev runner can be Node 18, so we parse by hand. Path is resolved from THIS
// file (server/src → ../.env) so it's launch-cwd independent. Existing env wins.
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
} catch {
  /* no server/.env — fall back to the ambient environment */
}

// Auth is disabled when ENGINE_TOKEN is unset to keep local dev frictionless —
// but the FAIL-CLOSED guard below refuses to boot live without it, so an
// unauthenticated engine is always paper-only.
const ENGINE_TOKEN = process.env.ENGINE_TOKEN

const app = createApp(ENGINE_TOKEN)
const server = createServer(app)
// Gate the WS upgrade with the same token as the HTTP API when one is set — the feed
// broadcasts every bot's positions, P&L, live fills and copied wallet addresses, so it
// must not be open to any local/LAN connector. Browsers can't set headers on a WS, so the
// web passes it as `?token=`; constant-time compared. No token configured (dev) → open,
// same as the HTTP reads. [P2-3]
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ENGINE_TOKEN
    ? (info, cb) => {
        const tok = new URL(info.req.url ?? '', 'http://localhost').searchParams.get('token') ?? undefined
        cb(tokenOk(tok, ENGINE_TOKEN))
      }
    : undefined,
})
const sockets = new Set<WebSocket>()

// Heartbeat: terminate half-open sockets so they don't accumulate.
const alive = new WeakMap<WebSocket, boolean>()
wss.on('connection', (ws) => {
  sockets.add(ws)
  alive.set(ws, true)
  ws.on('pong', () => alive.set(ws, true))
  ws.on('close', () => sockets.delete(ws))
  ws.on('error', () => {
    try {
      ws.terminate()
    } catch {
      /* already gone */
    }
    sockets.delete(ws)
  })
})
const heartbeat = setInterval(() => {
  for (const ws of sockets) {
    if (alive.get(ws) === false) {
      ws.terminate()
      sockets.delete(ws)
      continue
    }
    alive.set(ws, false)
    try {
      ws.ping()
    } catch {
      ws.terminate()
      sockets.delete(ws)
    }
  }
}, 30000)
heartbeat.unref?.()

// Append-only SQLite trade ledger (Node ≥22.5). Seed it from the JSON window so
// existing trades are queryable; every future trade is recorded as it happens.
if (initTradeDb(DATA_DIR)) {
  const n = backfillTrades(state.trades)
  console.log(`[db] SQLite trade ledger ready — backfilled ${n} trade(s) from state.json`)
}

// SAFE BOOT (must run BEFORE startEngine so no live tick fires first): never auto-resume
// LIVE trading on a restart/crash. The persisted live WORKSPACE is downgraded to paper AND
// every running live bot is PAUSED — because a bot's mode is independent of the viewed
// workspace, the flag downgrade alone wouldn't stop them. Opt in with RESUME_LIVE_ON_BOOT=true.
if (process.env.RESUME_LIVE_ON_BOOT !== 'true') {
  const downgraded = shouldDowngradeLiveOnBoot(state.settings.mode, process.env.RESUME_LIVE_ON_BOOT)
  if (downgraded) state.settings.mode = 'paper'
  const pausedLive = disarmLiveBotsForBoot()
  if (downgraded || pausedLive) {
    flushNow()
    console.warn(
      `[server] ⚠ SAFE BOOT — ${downgraded ? 'persisted LIVE workspace downgraded to paper; ' : ''}${pausedLive} running live bot(s) paused. ` +
        'Re-arm via the Live button + resume them (set RESUME_LIVE_ON_BOOT=true to auto-resume).',
    )
  }
}

startEngine((msg) => {
  const data = JSON.stringify(msg)
  for (const ws of sockets) {
    if (ws.readyState !== WebSocket.OPEN) continue
    // Drop snapshots to a backed-up slow client rather than growing memory unbounded.
    if (ws.bufferedAmount > 1_000_000) continue
    try {
      ws.send(data)
    } catch {
      try {
        ws.terminate()
      } catch {
        /* already gone */
      }
      sockets.delete(ws)
    }
  }
})

// Last-resort guards: never let one stray rejection/throw silently kill the
// engine while live positions are open — log, persist, and (for fatal throws)
// exit so the process manager can restart cleanly.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err)
  try {
    flushNow()
  } catch {
    /* best effort */
  }
  process.exit(1)
})

const PORT = Number(process.env.ENGINE_PORT) || 8787
// Bind to loopback by default — the engine controls a real wallet, so it must not
// be LAN-reachable unless the operator explicitly opts in via ENGINE_HOST.
const HOST = process.env.ENGINE_HOST || '127.0.0.1'

// FAIL-CLOSED: never run with live trading armed but no auth token. An
// unauthenticated engine holding live wallet keys can be drained by any local or
// LAN caller (POST /api/mode {live} → real swaps). Refuse to boot instead.
// Reject a malformed safety-cap env at boot (a typo'd cap silently parses to 0 =
// unlimited) — fail loud rather than run unbounded. [P2-12]
const capErr = invalidCapEnv()
if (capErr) {
  console.error(`[server] FATAL: ${capErr}`)
  process.exit(1)
}

if (liveArmedButNoToken(liveReady() || solanaLiveReady(), ENGINE_TOKEN)) {
  console.error(
    '[server] FATAL: live trading is armed (wallet/Turnkey keys present) but ENGINE_TOKEN is not set.\n' +
      '  An unauthenticated engine with a live wallet can be drained by any local/LAN process.\n' +
      '  → Set a strong ENGINE_TOKEN in server/.env and a matching VITE_ENGINE_TOKEN for the web app, then restart.\n' +
      '  → Or remove the wallet/Turnkey vars to run paper-only.',
  )
  process.exit(1)
}

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST}:${PORT} (mode: ${state.settings.mode})`)
  if (!ENGINE_TOKEN)
    console.warn('[server] ⚠ ENGINE_TOKEN not set — mutating endpoints are UNAUTHENTICATED (paper-only; live is blocked at boot). Set ENGINE_TOKEN + VITE_ENGINE_TOKEN before going live.')
  if (HOST !== '127.0.0.1' && HOST !== 'localhost')
    console.warn(`[server] ⚠ bound to ${HOST} (network-reachable) — ensure ENGINE_TOKEN is strong and the network is trusted.`)
  notifyAsync('start', `PulseTrade engine up on ${HOST}:${PORT} (mode: ${state.settings.mode})`)
})

// Graceful shutdown: on SIGTERM/SIGINT (deploy, reboot, Ctrl-C) stop scheduling ticks,
// DRAIN any in-flight on-chain swap/withdrawal so a broadcast tx isn't abandoned
// mid-flight, close sockets, flush state, then exit. Replaces store.ts's old synchronous
// process.exit(0), which could quit while a real buy was confirming. [P1-12]
let shuttingDown = false
async function shutdown(sig: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${sig} received — draining in-flight trades before exit…`)
  await notify('shutdown', `engine shutting down (${sig})`).catch(() => {})
  try {
    await stopEngine() // stop new ticks + await in-flight swap lanes (bounded)
  } catch (e) {
    console.error('[server] drain error', e)
  }
  clearInterval(heartbeat)
  for (const ws of sockets) {
    try { ws.close() } catch { /* already gone */ }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  try { flushNow() } catch { /* best effort */ }
  console.log('[server] drain complete — exiting')
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown(sig))
