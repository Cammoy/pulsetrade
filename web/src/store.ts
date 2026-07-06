import { create } from 'zustand'
import type { ReactNode } from 'react'
import type { AutoSniperState, Bot, Follow, LimitOrder, LimitOrderDraft, Meta, MonthlyPnl, PerpDraft, PerpsPayload, PriceAlert, SignalsPayload, SwapRecord, Tournament, Trade, TradeSignal, TrackedRequest } from './types'

/** Body for POST /api/alerts. */
export type AlertDraft = { cg: string; symbol: string; name?: string; kind: 'above' | 'below' | 'move'; value: number; note?: string }
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
  /** Advisory signal channel: live + closed signals plus forward-test stats. Hydrated
   *  from /api/signals at boot, kept fresh by the WS `signals`/`snapshot` frames. */
  signals: SignalsPayload
  /** Price alerts — hydrated from /api/alerts at boot, kept fresh by WS frames. */
  alerts: PriceAlert[]
  /** Paper perps positions (open + closed + stats) — hydrated from /api/perps, fresh via WS. */
  perps: PerpsPayload
  /** Limit (conditional) orders — hydrated from /api/limit-orders, fresh via WS. */
  limitOrders: LimitOrder[]
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
  newBotOpen: boolean // the "+ New bot" hub — a chooser that routes to wizard/ai/finder/sniper/tournament
  moreOpen: boolean
  view: 'home' | 'market' | 'smart' | 'copy' | 'signals' | 'trade' | 'portfolio' | 'docs'
  /** Which Portfolio sub-tab is active — lifted into the store so other surfaces
   *  (e.g. the "Staking" app entry) can deep-link straight to it. */
  portfolioTab: 'holdings' | 'wallet' | 'staking' | 'earn' | 'withdraw'
  /** A coin to focus in the Trade channel — set by other surfaces (e.g. Market) to hand a
   *  coin off to the terminal; the Trade view consumes it then clears it. */
  tradeFocus: { symbol: string; name: string; cg: string } | null
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
  openNewBot(open: boolean): void
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
  setView(view: 'home' | 'market' | 'smart' | 'copy' | 'signals' | 'trade' | 'portfolio' | 'docs'): void
  /** Focus a coin in the Trade channel and switch to it (used by Market's "Trade" action). */
  openTradeCoin(coin: { symbol: string; name: string; cg: string }): void
  clearTradeFocus(): void
  setPortfolioTab(tab: 'holdings' | 'wallet' | 'staking' | 'earn' | 'withdraw'): void
  selectBot(id: string | null): void
  createBot(payload: object): Promise<{ error?: string; id?: string }>
  control(id: string, action: 'pause' | 'resume' | 'stop'): Promise<void>
  archive(id: string, archived: boolean): Promise<void>
  editBot(id: string, patch: { takeProfitPct?: number; stopLossPct?: number; maxHoldMin?: number; trailingPct?: number | null; budgetUsd?: number }): Promise<{ error?: string }>
  remove(id: string): Promise<void>
  setMode(mode: 'paper' | 'live'): Promise<{ error?: string }>
  /** Price-alert actions. */
  addAlert(draft: AlertDraft): Promise<{ error?: string }>
  deleteAlert(id: string): Promise<void>
  rearmAlert(id: string): Promise<{ error?: string }>
  toggleAlert(id: string, enabled: boolean): Promise<void>
  /** Paper perps actions. */
  openPerp(draft: PerpDraft): Promise<{ error?: string }>
  closePerp(id: string): Promise<{ error?: string }>
  editPerpStops(id: string, patch: { stopLoss?: number | null; takeProfit?: number | null }): Promise<{ error?: string }>
  dismissPerp(id: string): Promise<void>
  /** Limit-order actions. */
  addLimitOrder(draft: LimitOrderDraft): Promise<{ error?: string }>
  cancelLimitOrder(id: string): Promise<void>
  /** Create / re-configure / dismiss an operator-tracked trade (the signal-ticket flow). */
  trackTrade(payload: TrackedRequest): Promise<{ error?: string }>
  updateTracked(id: string, patch: Partial<TrackedRequest>): Promise<{ error?: string }>
  closeTracked(id: string): Promise<void>
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
  signals: { active: [], history: [], tracked: [], radar: [], stats: { closed: 0, wins: 0, losses: 0, winRatePct: null, avgR: null, totalR: 0, tp1HitRatePct: null, bestR: null, worstR: null, active: 0 }, enabled: false, needsAi: true, aiThrottled: false, generatedAt: null },
  alerts: [],
  perps: { open: [], closed: [], stats: { open: 0, closed: 0, wins: 0, losses: 0, winRatePct: null, realizedPnlUsd: 0, openMarginUsd: 0 }, maxLeverage: 50, liveEnabled: false },
  limitOrders: [],
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
  newBotOpen: false,
  moreOpen: false,
  view: 'home',
  portfolioTab: 'holdings',
  tradeFocus: null,
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
      const [meta, st, signals, alerts, perps, limits] = await Promise.all([
        jget<Meta>('/api/meta'),
        jget<StatePayload>('/api/state'),
        jget<SignalsPayload>('/api/signals').catch(() => null), // optional — channel may be off
        jget<{ alerts: PriceAlert[] }>('/api/alerts').catch(() => null),
        jget<PerpsPayload>('/api/perps').catch(() => null),
        jget<{ orders: LimitOrder[] }>('/api/limit-orders').catch(() => null),
      ])
      set({ meta, ...normalizeState(st), ...(signals ? { signals } : {}), ...(alerts ? { alerts: alerts.alerts } : {}), ...(perps ? { perps } : {}), ...(limits ? { limitOrders: limits.orders } : {}) })
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
  openNewBot: (newBotOpen) => set({ newBotOpen }),
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
  openTradeCoin: (coin) => set({ tradeFocus: coin, view: 'trade' }),
  clearTradeFocus: () => set({ tradeFocus: null }),
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

  async trackTrade(payload) {
    // The WS `signals` frame delivers the authoritative tracked list; here we just fire
    // and surface any validation error.
    const out = await jpost<{ trade?: unknown; error?: string }>('/api/signals/track', payload)
    if (out.error) get().notify(out.error, 'error')
    return { error: out.error }
  },

  async updateTracked(id, patch) {
    const out = await jpost<{ trade?: unknown; error?: string }>(`/api/signals/track/${id}`, patch, 'PATCH')
    if (out.error) get().notify(out.error, 'error')
    return { error: out.error }
  },

  async closeTracked(id) {
    // Optimistically drop it; the WS frame reconciles.
    const prev = get().signals
    set({ signals: { ...prev, tracked: prev.tracked.filter((t) => t.id !== id) } })
    const out = await jpost<{ ok?: boolean; error?: string }>(`/api/signals/track/${id}`, undefined, 'DELETE')
    if (out.error) {
      set({ signals: prev })
      get().notify('Could not remove the trade', 'error')
    }
  },

  // ── Price alerts (the WS `alerts` frame is authoritative; these fire + surface errors) ──
  async addAlert(draft) {
    const out = await jpost<{ alert?: unknown; error?: string }>('/api/alerts', draft)
    if (out.error) get().notify(out.error, 'error')
    return { error: out.error }
  },

  async deleteAlert(id) {
    const prev = get().alerts
    set({ alerts: prev.filter((a) => a.id !== id) }) // optimistic; WS reconciles
    const out = await jpost<{ ok?: boolean; error?: string }>(`/api/alerts/${id}`, undefined, 'DELETE')
    if (out.error) {
      set({ alerts: prev })
      get().notify('Could not remove the alert', 'error')
    }
  },

  async rearmAlert(id) {
    const out = await jpost<{ alert?: unknown; error?: string }>(`/api/alerts/${id}/rearm`)
    if (out.error) get().notify(out.error, 'error')
    return { error: out.error }
  },

  async toggleAlert(id, enabled) {
    const prev = get().alerts
    set({ alerts: prev.map((a) => (a.id === id ? { ...a, enabled } : a)) }) // optimistic
    const out = await jpost<{ error?: string }>(`/api/alerts/${id}`, { enabled }, 'PATCH')
    if (out.error) {
      set({ alerts: prev })
      get().notify('Could not update the alert', 'error')
    }
  },

  // ── Paper perps (the WS `perps` frame is authoritative; these fire + surface errors) ──
  async openPerp(draft) {
    const out = await jpost<{ position?: unknown; error?: string }>('/api/perps', draft)
    if (out.error) get().notify(out.error, 'error')
    return { error: out.error }
  },

  async closePerp(id) {
    const out = await jpost<{ position?: unknown; error?: string }>(`/api/perps/${id}/close`)
    if (out.error) get().notify(out.error, 'error')
    return { error: out.error }
  },

  async editPerpStops(id, patch) {
    const out = await jpost<{ position?: unknown; error?: string }>(`/api/perps/${id}`, patch, 'PATCH')
    if (out.error) get().notify(out.error, 'error')
    return { error: out.error }
  },

  async dismissPerp(id) {
    const prev = get().perps
    set({ perps: { ...prev, closed: prev.closed.filter((p) => p.id !== id) } }) // optimistic
    const out = await jpost<{ ok?: boolean; error?: string }>(`/api/perps/${id}`, undefined, 'DELETE')
    if (out.error) {
      set({ perps: prev })
      get().notify('Could not dismiss the position', 'error')
    }
  },

  // ── Limit orders (the WS `limit-orders` frame is authoritative) ──
  async addLimitOrder(draft) {
    const out = await jpost<{ order?: unknown; error?: string }>('/api/limit-orders', draft)
    if (out.error) get().notify(out.error, 'error')
    return { error: out.error }
  },

  async cancelLimitOrder(id) {
    const prev = get().limitOrders
    set({ limitOrders: prev.filter((o) => o.id !== id) }) // optimistic (cancel or dismiss)
    const out = await jpost<{ ok?: boolean; error?: string }>(`/api/limit-orders/${id}`, undefined, 'DELETE')
    if (out.error) {
      set({ limitOrders: prev })
      get().notify('Could not update the order', 'error')
    }
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
        // The snapshot carries the live slice (active + stats); history is preserved
        // from the boot fetch / the dedicated `signals` frame.
        ...(msg.signals
          ? { signals: { ...useStore.getState().signals, active: msg.signals.active ?? [], tracked: msg.signals.tracked ?? useStore.getState().signals.tracked, radar: msg.signals.radar ?? useStore.getState().signals.radar, stats: msg.signals.stats ?? useStore.getState().signals.stats, enabled: !!msg.signals.enabled, needsAi: !!msg.signals.needsAi, aiThrottled: !!msg.signals.aiThrottled, generatedAt: msg.signals.generatedAt ?? null } }
          : {}),
        ...(Array.isArray(msg.alerts) ? { alerts: msg.alerts } : {}),
        // Perps snapshot carries open positions (live PnL) + stats; closed history is kept.
        ...(msg.perps ? { perps: { ...useStore.getState().perps, open: msg.perps.open ?? [], stats: msg.perps.stats ?? useStore.getState().perps.stats, liveEnabled: !!msg.perps.liveEnabled } } : {}),
        ...(Array.isArray(msg.limitOrders) ? { limitOrders: msg.limitOrders } : {}),
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
    } else if (msg.type === 'signals' && msg.payload) {
      // Authoritative full channel payload (after a publish, close, or radar refresh).
      // Default radar so an older/partial frame can't leave it undefined (consumers .filter it).
      const p = msg.payload as SignalsPayload
      useStore.setState({ signals: { ...p, radar: Array.isArray(p.radar) ? p.radar : [], tracked: Array.isArray(p.tracked) ? p.tracked : [] } })
    } else if (msg.type === 'signal' && msg.signal?.id) {
      // A freshly published signal — toast it (state arrives via the `signals` frame).
      const s = msg.signal as TradeSignal
      useStore.getState().notify(`📡 New signal — ${s.asset} ${s.direction} · ${s.confidence}% conf · R:R ${s.riskReward}`, 'info')
    } else if ((msg.type === 'signal-update' || msg.type === 'tracked-update') && (msg.signal?.id || msg.trade?.id)) {
      // Toast only the meaningful close transitions (targets hit / stopped / expired).
      const s = (msg.signal ?? msg.trade) as TradeSignal
      if (s.closedAt) {
        const won = (s.realizedR ?? 0) >= 0
        const verb = s.status === 'tp3' ? 'ran to TP3' : s.status === 'stopped' ? 'hit its stop' : 'expired'
        const who = msg.type === 'tracked-update' ? 'Your trade' : s.asset
        useStore.getState().notify(`${won ? '✅' : '🛑'} ${who} ${s.asset !== who ? s.asset + ' ' : ''}${s.direction} ${verb} — ${won ? '+' : ''}${s.realizedR}R`, won ? 'success' : 'info')
      }
    } else if (msg.type === 'tracked' && msg.trade?.id) {
      const t = msg.trade as TradeSignal
      useStore.getState().notify(`📍 Tracking ${t.asset} ${t.direction} — entry ${t.entryMid}, SL ${t.stopLoss}`, 'success')
    } else if (msg.type === 'alerts' && Array.isArray(msg.alerts)) {
      useStore.setState({ alerts: msg.alerts as PriceAlert[] })
    } else if (msg.type === 'alert-trigger' && msg.alert?.id) {
      const a = msg.alert as PriceAlert
      const p = a.triggeredPrice ?? a.value
      const what = a.kind === 'above' ? `crossed above $${a.value}` : a.kind === 'below' ? `dropped below $${a.value}` : `moved ${a.value}%`
      useStore.getState().notify(`🔔 ${a.symbol} ${what} — now $${p}`, 'info')
    } else if (msg.type === 'perps' && msg.payload) {
      useStore.setState({ perps: msg.payload as PerpsPayload })
    } else if (msg.type === 'perp' && msg.position?.id) {
      const p = msg.position
      useStore.getState().notify(`📈 Opened ${p.symbol} ${String(p.side).toUpperCase()} ${p.leverage}× (paper) @ ${p.entryPrice}`, 'success')
    } else if (msg.type === 'perp-update' && msg.position?.id && msg.position.status === 'closed') {
      const p = msg.position
      const won = (p.realizedPnlUsd ?? 0) >= 0
      const how = p.closeReason === 'liquidated' ? 'liquidated' : p.closeReason === 'tp' ? 'hit take-profit' : p.closeReason === 'stop' ? 'hit stop' : 'closed'
      const r = p.realizedPnlUsd ?? 0
      useStore.getState().notify(`${won ? '✅' : p.closeReason === 'liquidated' ? '💥' : '🛑'} ${p.symbol} ${String(p.side).toUpperCase()} ${how} — ${r >= 0 ? '+' : '-'}$${Math.abs(r)}`, won ? 'success' : 'info')
    } else if (msg.type === 'limit-orders' && Array.isArray(msg.orders)) {
      useStore.setState({ limitOrders: msg.orders as LimitOrder[] })
    } else if (msg.type === 'limit-fill' && msg.order?.id) {
      const o = msg.order as LimitOrder
      if (o.status === 'filled') useStore.getState().notify(`🎯 Limit ${o.side.toUpperCase()} filled — ${o.symbol} at $${o.fillPrice}`, 'success')
      else if (o.status === 'expired') useStore.getState().notify(`⌛ Limit ${o.side.toUpperCase()} on ${o.symbol} expired`, 'info')
    }
  } catch {
    /* ignore malformed frames */
  }
}
