import { create } from 'zustand'
import type { ReactNode } from 'react'
import type { AutoSniperState, Bot, Follow, Meta, MonthlyPnl, SwapRecord, Tournament, Trade } from './types'
import { getStoredTheme, setTheme as applyThemePref, type ThemePref } from './theme'

export interface Toast {
  id: number
  msg: string
  type: 'error' | 'success' | 'info'
}

/** Options for the in-app confirm dialog (replaces blocking native window.confirm). */
export interface ConfirmOptions {
  title?: string
  /** Plain-text body (whitespace-pre-line). Use `body` instead for a rich/visual layout. */
  message?: string
  /** Optional rich body — rendered in place of `message` for a visual dialog. */
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 'danger' = destructive/irreversible action — red confirm button, Cancel focused. */
  tone?: 'default' | 'danger'
}
export interface ConfirmState extends ConfirmOptions {
  resolve: (result: boolean) => void
}

interface AppState {
  toasts: Toast[]
  notify(msg: string, type?: Toast['type']): void
  dismissToast(id: number): void
  /** Promise-based confirm rendered by <ConfirmDialog> (HTML5 <dialog>). */
  confirmState: ConfirmState | null
  confirm(opts: ConfirmOptions): Promise<boolean>
  resolveConfirm(result: boolean): void
  meta: Meta | null
  bots: Bot[]
  trades: Trade[]
  monthly: { paper: Record<string, MonthlyPnl>; live: Record<string, MonthlyPnl> }
  autoSniper: AutoSniperState | null
  tournaments: Tournament[]
  follows: Follow[]
  swaps: SwapRecord[]
  prices: Record<string, number>
  /** Live circuit-breaker state from the WS snapshot (null until the first frame —
   *  consumers fall back to the boot-time meta.live.breaker). Kept fresh so the HALTED
   *  badge appears/clears in real time. */
  breaker: { tripped: boolean; reason: string; trippedAt: number | null; realizedUsd: number; spentUsd: number } | null
  wsOk: boolean
  mode: 'paper' | 'live'
  showTrades: boolean
  finderOpen: boolean
  sniperOpen: boolean
  sniperTab: 'manual' | 'auto' // which tab the Sniper modal opens on
  swapOpen: boolean
  calcOpen: boolean
  tourOpen: boolean
  smartMoneyOpen: boolean
  aiOpen: boolean
  tournamentOpen: boolean
  wizardOpen: boolean
  moreOpen: boolean
  view: 'home' | 'market' | 'smart' | 'portfolio' | 'docs'
  /** Which Portfolio sub-tab is active — lifted into the store so other surfaces
   *  (e.g. the "Staking" app entry) can deep-link straight to it. */
  portfolioTab: 'holdings' | 'wallet' | 'staking' | 'withdraw'
  theme: ThemePref
  setTheme(theme: ThemePref): void
  selectedBotId: string | null
  lastTradeId: string | null
  /** Per-bot in-flight lifecycle action (pause / resume / stop). Set while the request
   *  is in flight so the UI can show a spinner and BLOCK that bot's controls — a
   *  stop-&-sweep can take a while (a real on-chain liquidation in live mode). */
  pendingByBot: Record<string, 'pause' | 'resume' | 'stop'>
  init(): Promise<void>
  refresh(): Promise<void>
  toggleTrades(): void
  openWizard(open: boolean): void
  openFinder(open: boolean): void
  openSniper(open: boolean): void
  openSniperAuto(): void // open the Sniper modal straight to the Auto-Sniper tab
  openSwap(open: boolean): void
  openCalc(open: boolean): void
  openDocs(open: boolean): void
  openTour(open: boolean): void
  openSmartMoney(open: boolean): void
  openAi(open: boolean): void
  openTournament(open: boolean): void
  openMore(open: boolean): void
  setView(view: 'home' | 'market' | 'smart' | 'portfolio' | 'docs'): void
  setPortfolioTab(tab: 'holdings' | 'wallet' | 'staking' | 'withdraw'): void
  selectBot(id: string | null): void
  createBot(payload: object): Promise<{ error?: string; id?: string }>
  control(id: string, action: 'pause' | 'resume' | 'stop'): Promise<void>
  archive(id: string, archived: boolean): Promise<void>
  editBot(id: string, patch: { takeProfitPct?: number; stopLossPct?: number; maxHoldMin?: number; trailingPct?: number | null; budgetUsd?: number }): Promise<{ error?: string }>
  remove(id: string): Promise<void>
  setMode(mode: 'paper' | 'live'): Promise<{ error?: string }>
}

/** Shape of GET /api/state — shared by init() and refresh(). */
type StatePayload = {
  bots: Bot[]
  trades: Trade[]
  monthly: { paper: Record<string, MonthlyPnl>; live: Record<string, MonthlyPnl> }
  autoSniper: AutoSniperState | null
  tournaments: Tournament[]
  follows: Follow[]
  swaps: SwapRecord[]
  mode: 'paper' | 'live'
}

/** Coerce a (possibly partial) state payload into a fully-defaulted slice. */
export function normalizeState(st: Partial<StatePayload>) {
  return {
    // Backfill bot.mode so an older payload (or a bot saved before the workspace split)
    // is treated as paper — the dashboard filters by mode and must never drop a bot.
    bots: (st.bots ?? []).map((b) => ({ ...b, mode: b.mode ?? 'paper' })),
    trades: st.trades ?? [],
    monthly: st.monthly ?? { paper: {}, live: {} },
    autoSniper: st.autoSniper ?? null,
    tournaments: st.tournaments ?? [],
    follows: st.follows ?? [],
    swaps: st.swaps ?? [],
    mode: st.mode ?? 'paper',
  }
}

let nextToastId = 1
let initPromise: Promise<void> | null = null

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

/**
 * POST helper that never throws on an HTTP error or non-JSON body. Mutations
 * (create/control/mode) all expect `{ error? }`, so a 4xx/5xx that returns an
 * HTML error page must degrade to `{ error }` instead of crashing the app with
 * a raw SyntaxError from `r.json()`.
 */
export async function jpost<T extends { error?: string }>(url: string, body?: object, method: 'POST' | 'PATCH' | 'DELETE' = 'POST'): Promise<T> {
  let r: Response
  try {
    r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    return { error: 'Network error — is the engine running?' } as T
  }
  const text = await r.text()
  let data: T
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T)
  } catch {
    return { error: r.ok ? 'Unexpected response from engine' : text || `Request failed (${r.status})` } as T
  }
  if (!r.ok && !data.error) return { ...data, error: text || `Request failed (${r.status})` }
  return data
}

export const useStore = create<AppState>((set, get) => ({
  meta: null,
  bots: [],
  trades: [],
  swaps: [],
  monthly: { paper: {}, live: {} },
  autoSniper: null,
  tournaments: [],
  follows: [],
  prices: {},
  breaker: null,
  wsOk: false,
  mode: 'paper',
  showTrades: true,
  finderOpen: false,
  sniperOpen: false,
  sniperTab: 'manual',
  swapOpen: false,
  calcOpen: false,
  tourOpen: false,
  smartMoneyOpen: false,
  aiOpen: false,
  tournamentOpen: false,
  wizardOpen: false,
  moreOpen: false,
  view: 'home',
  portfolioTab: 'holdings',
  theme: getStoredTheme(),
  selectedBotId: null,
  lastTradeId: null,
  pendingByBot: {},
  toasts: [],

  notify: (msg, type = 'info') => {
    const id = nextToastId++
    set((s) => ({ toasts: [...s.toasts, { id, msg, type }] }))
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  confirmState: null,
  confirm: (opts) =>
    new Promise<boolean>((resolve) => set({ confirmState: { confirmLabel: 'Confirm', cancelLabel: 'Cancel', tone: 'default', ...opts, resolve } })),
  resolveConfirm: (result) => {
    const cs = get().confirmState
    if (!cs) return // idempotent — the dialog's onClose can fire after a button already resolved
    set({ confirmState: null })
    cs.resolve(result)
  },

  async init() {
    // De-duplicate the StrictMode double-mount: both callers await one promise
    // so we never fire two boot round-trips or open two sockets.
    if (initPromise) return initPromise
    initPromise = (async () => {
      const [meta, st] = await Promise.all([
        jget<Meta>('/api/meta'),
        jget<StatePayload>('/api/state'),
      ])
      set({ meta, ...normalizeState(st) })
      connectWs()
    })()
    try {
      await initPromise
    } catch (e) {
      initPromise = null // allow a retry after a failed boot
      throw e
    }
  },

  async refresh() {
    const st = await jget<StatePayload>('/api/state')
    set(normalizeState(st))
  },

  toggleTrades: () => set((s) => ({ showTrades: !s.showTrades })),
  openWizard: (wizardOpen) => set({ wizardOpen }),
  openFinder: (finderOpen) => set({ finderOpen }),
  openSniper: (sniperOpen) => set({ sniperOpen }),
  openSniperAuto: () => set({ sniperOpen: true, sniperTab: 'auto' }),
  openSwap: (swapOpen) => set({ swapOpen }),
  openCalc: (calcOpen) => set({ calcOpen }),
  // Documentation is a navigable VIEW now (not a modal) — `openDocs(true)` from the
  // Tools menu / More sheet / onboarding just routes to it.
  openDocs: (open) => { if (open) set({ view: 'docs' }) },
  openTour: (tourOpen) => set({ tourOpen }),
  openSmartMoney: (smartMoneyOpen) => set({ smartMoneyOpen }),
  openAi: (aiOpen) => set({ aiOpen }),
  openTournament: (tournamentOpen) => set({ tournamentOpen }),
  openMore: (moreOpen) => set({ moreOpen }),
  setView: (view) => set({ view }),
  setPortfolioTab: (portfolioTab) => set({ portfolioTab }),
  setTheme: (theme) => {
    applyThemePref(theme)
    set({ theme })
  },
  selectBot: (selectedBotId) => set({ selectedBotId }),

  async createBot(payload) {
    const out = await jpost<Bot & { error?: string }>('/api/bots', payload)
    if (out.error) return { error: out.error }
    await get().refresh()
    return { id: out.id }
  },

  async control(id, action) {
    // Flag this bot as busy so its card shows a spinner and blocks further clicks —
    // a stop sells the position + sweeps (a real on-chain leg in live mode), which isn't
    // instant. Cleared in `finally` whether it succeeds, errors, or the network drops.
    set((s) => ({ pendingByBot: { ...s.pendingByBot, [id]: action } }))
    try {
      const out = await jpost<Bot & { error?: string }>(`/api/bots/${id}/${action}`)
      if (out.error) {
        get().notify(out.error, 'error')
        return
      }
      // The response IS the updated bot — patch it straight in so the card reflects the
      // change immediately (don't wait on a follow-up /api/state that could be slow).
      if (out.id) set((s) => ({ bots: s.bots.map((b) => (b.id === id ? { ...b, ...out } : b)) }))
      get().refresh().catch(() => {}) // background reconcile
    } finally {
      set((s) => {
        const p = { ...s.pendingByBot }
        delete p[id]
        return { pendingByBot: p }
      })
    }
  },

  async archive(id, archived) {
    const out = await jpost<Bot & { error?: string }>(`/api/bots/${id}/archive`, { archived })
    if (out.error) {
      get().notify(out.error, 'error')
      return
    }
    if (out.id) set((s) => ({ bots: s.bots.map((b) => (b.id === id ? { ...b, ...out } : b)) }))
    get().refresh().catch(() => {})
  },

  async editBot(id, patch) {
    const out = await jpost<Bot & { error?: string }>(`/api/bots/${id}`, patch, 'PATCH')
    if (out.error) {
      get().notify(out.error, 'error')
      return { error: out.error }
    }
    // Patch the bot in immediately so the detail view reflects the new params.
    if (out.id) set((s) => ({ bots: s.bots.map((b) => (b.id === id ? { ...b, ...out } : b)) }))
    get().refresh().catch(() => {})
    return {}
  },

  async remove(id) {
    // Snapshot for rollback if the delete fails mid-flight.
    const prev = get().bots
    set((s) => ({
      bots: s.bots.filter((b) => b.id !== id),
      trades: s.trades.filter((t) => t.botId !== id),
      selectedBotId: s.selectedBotId === id ? null : s.selectedBotId,
    }))
    try {
      const r = await fetch(`/api/bots/${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(await r.text())
    } catch {
      set({ bots: prev })
      get().notify('Could not delete bot — restored it', 'error')
      await get().refresh().catch(() => {})
    }
  },

  async setMode(mode) {
    const out = await jpost<{ mode?: string; error?: string }>('/api/mode', { mode })
    if (out.error) return { error: out.error }
    set({ mode })
    return {}
  },
}))

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
function connectWs() {
  // Idempotent: React StrictMode mounts twice and reconnects can race —
  // never hold more than one socket or trade events arrive duplicated.
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // Pass the engine token (when configured) on the WS URL — the server gates the upgrade
  // with it, and browsers can't set WS headers. Mirrors the Bearer header on HTTP. [P2-3]
  const wsToken = import.meta.env.VITE_ENGINE_TOKEN as string | undefined
  const q = wsToken ? `?token=${encodeURIComponent(wsToken)}` : ''
  ws = new WebSocket(`${proto}://${location.host}/ws${q}`)
  ws.onopen = () => useStore.setState({ wsOk: true })
  ws.onclose = () => {
    useStore.setState({ wsOk: false })
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connectWs, 3000)
  }
  ws.onmessage = (ev) => handleWsMessage(typeof ev.data === 'string' ? ev.data : String(ev.data))
}

/**
 * Apply one raw WebSocket frame to the store. Extracted from the socket so it can
 * be unit-tested directly: a partial/garbled snapshot must default every field
 * (consumers assume non-null, e.g. `bots.length`), a duplicate trade id must be
 * dropped, and the trade buffer is capped. Malformed frames are ignored.
 */
export function handleWsMessage(raw: string) {
  try {
    const msg = JSON.parse(raw)
    if (msg.type === 'snapshot') {
      const prevBreaker = useStore.getState().breaker
      const nextBreaker = msg.breaker ?? null
      useStore.setState({
        bots: (msg.bots ?? []).map((b: Bot) => ({ ...b, mode: b.mode ?? 'paper' })),
        prices: msg.prices ?? {},
        breaker: nextBreaker,
        // Keep the active workspace in sync with the SERVER (a cached /api/state at boot,
        // or a second tab, could otherwise leave the toggle/wizard on the wrong mode).
        ...(msg.mode === 'paper' || msg.mode === 'live' ? { mode: msg.mode } : {}),
        monthly: msg.monthly ?? { paper: {}, live: {} },
        autoSniper: msg.autoSniper ?? null,
        tournaments: msg.tournaments ?? [],
        follows: msg.follows ?? [],
      })
      // Proactively alert the operator the instant the live breaker trips — the HALTED
      // badge alone is easy to miss. Fire only on the false→true edge, and never on the
      // first snapshot after boot (prevBreaker null) so an already-tripped breaker doesn't
      // re-toast on every reload — the persistent badge covers that.
      if (prevBreaker !== null && nextBreaker?.tripped && !prevBreaker.tripped) {
        useStore.getState().notify(`⛔ Live trading halted — ${nextBreaker.reason || 'a safety limit was hit'}. Reset it from the ⛔ HALTED badge to resume.`, 'error')
      }
    } else if (msg.type === 'trade' && msg.trade?.id) {
      useStore.setState((s) => {
        const dup = s.trades.some((t) => t.id === msg.trade.id)
        // The trade frame carries the freshly-updated monthly ledger so the Monthly
        // P&L reflects this fill IMMEDIATELY (not on the next ~20s snapshot). Apply it
        // even for a duplicate trade so a reconnect/replay still lands fresh. [realtime]
        const patch: Partial<AppState> = msg.monthly ? { monthly: msg.monthly } : {}
        if (!dup) {
          patch.trades = [msg.trade, ...s.trades].slice(0, 500)
          patch.lastTradeId = msg.trade.id
        }
        return patch
      })
    }
  } catch {
    /* ignore malformed frames */
  }
}
