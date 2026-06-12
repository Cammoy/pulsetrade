import { create } from 'zustand'
import type { AutoSniperState, Bot, Follow, Meta, MonthlyPnl, Tournament, Trade } from './types'

interface AppState {
  meta: Meta | null
  bots: Bot[]
  trades: Trade[]
  monthly: Record<string, MonthlyPnl>
  autoSniper: AutoSniperState | null
  tournaments: Tournament[]
  follows: Follow[]
  prices: Record<string, number>
  wsOk: boolean
  mode: 'paper' | 'live'
  showTrades: boolean
  finderOpen: boolean
  sniperOpen: boolean
  docsOpen: boolean
  tourOpen: boolean
  smartMoneyOpen: boolean
  aiOpen: boolean
  tournamentOpen: boolean
  wizardOpen: boolean
  selectedBotId: string | null
  lastTradeId: string | null
  init(): Promise<void>
  refresh(): Promise<void>
  toggleTrades(): void
  openWizard(open: boolean): void
  openFinder(open: boolean): void
  openSniper(open: boolean): void
  openDocs(open: boolean): void
  openTour(open: boolean): void
  openSmartMoney(open: boolean): void
  openAi(open: boolean): void
  openTournament(open: boolean): void
  selectBot(id: string | null): void
  createBot(payload: object): Promise<{ error?: string; id?: string }>
  control(id: string, action: 'pause' | 'resume' | 'stop'): Promise<void>
  remove(id: string): Promise<void>
  setMode(mode: 'paper' | 'live'): Promise<{ error?: string }>
}

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function jpost<T>(url: string, body?: object): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return r.json()
}

export const useStore = create<AppState>((set, get) => ({
  meta: null,
  bots: [],
  trades: [],
  monthly: {},
  autoSniper: null,
  tournaments: [],
  follows: [],
  prices: {},
  wsOk: false,
  mode: 'paper',
  showTrades: true,
  finderOpen: false,
  sniperOpen: false,
  docsOpen: false,
  tourOpen: false,
  smartMoneyOpen: false,
  aiOpen: false,
  tournamentOpen: false,
  wizardOpen: false,
  selectedBotId: null,
  lastTradeId: null,

  async init() {
    const [meta, st] = await Promise.all([
      jget<Meta>('/api/meta'),
      jget<{ bots: Bot[]; trades: Trade[]; monthly: Record<string, MonthlyPnl>; autoSniper: AutoSniperState | null; tournaments: Tournament[]; follows: Follow[]; mode: 'paper' | 'live' }>('/api/state'),
    ])
    set({ meta, bots: st.bots, trades: st.trades, monthly: st.monthly, autoSniper: st.autoSniper, tournaments: st.tournaments ?? [], follows: st.follows ?? [], mode: st.mode })
    connectWs()
  },

  async refresh() {
    const st = await jget<{ bots: Bot[]; trades: Trade[]; monthly: Record<string, MonthlyPnl>; autoSniper: AutoSniperState | null; tournaments: Tournament[]; follows: Follow[]; mode: 'paper' | 'live' }>('/api/state')
    set({ bots: st.bots, trades: st.trades, monthly: st.monthly, autoSniper: st.autoSniper, tournaments: st.tournaments ?? [], follows: st.follows ?? [], mode: st.mode })
  },

  toggleTrades: () => set((s) => ({ showTrades: !s.showTrades })),
  openWizard: (wizardOpen) => set({ wizardOpen }),
  openFinder: (finderOpen) => set({ finderOpen }),
  openSniper: (sniperOpen) => set({ sniperOpen }),
  openDocs: (docsOpen) => set({ docsOpen }),
  openTour: (tourOpen) => set({ tourOpen }),
  openSmartMoney: (smartMoneyOpen) => set({ smartMoneyOpen }),
  openAi: (aiOpen) => set({ aiOpen }),
  openTournament: (tournamentOpen) => set({ tournamentOpen }),
  selectBot: (selectedBotId) => set({ selectedBotId }),

  async createBot(payload) {
    const out = await jpost<Bot & { error?: string }>('/api/bots', payload)
    if (out.error) return { error: out.error }
    await get().refresh()
    return { id: out.id }
  },

  async control(id, action) {
    await jpost(`/api/bots/${id}/${action}`)
    await get().refresh()
  },

  async remove(id) {
    await fetch(`/api/bots/${id}`, { method: 'DELETE' })
    set((s) => ({
      bots: s.bots.filter((b) => b.id !== id),
      trades: s.trades.filter((t) => t.botId !== id),
      selectedBotId: s.selectedBotId === id ? null : s.selectedBotId,
    }))
  },

  async setMode(mode) {
    const out = await jpost<{ mode?: string; error?: string }>('/api/mode', { mode })
    if (out.error) return { error: out.error }
    set({ mode })
    return {}
  },
}))

let ws: WebSocket | null = null
function connectWs() {
  // Idempotent: React StrictMode mounts twice and reconnects can race —
  // never hold more than one socket or trade events arrive duplicated.
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)
  ws.onopen = () => useStore.setState({ wsOk: true })
  ws.onclose = () => {
    useStore.setState({ wsOk: false })
    setTimeout(connectWs, 3000)
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'snapshot') {
        useStore.setState({ bots: msg.bots, prices: msg.prices, monthly: msg.monthly ?? {}, autoSniper: msg.autoSniper ?? null, tournaments: msg.tournaments ?? [], follows: msg.follows ?? [] })
      } else if (msg.type === 'trade') {
        useStore.setState((s) =>
          s.trades.some((t) => t.id === msg.trade.id)
            ? s
            : { trades: [msg.trade, ...s.trades].slice(0, 500), lastTradeId: msg.trade.id },
        )
      }
    } catch {
      /* ignore malformed frames */
    }
  }
}
