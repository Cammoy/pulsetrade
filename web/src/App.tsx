import { useEffect, useState } from 'react'
import { useStore } from './store'
import { useHashRoute } from './routing'
import { useShallow } from 'zustand/react/shallow'
import { botsForMode } from './stats'
import Header from './components/Header'
import Sidebar from './components/Sidebar'
import ChannelHeader from './components/ChannelHeader'
import Overview from './components/Overview'
import BotCard from './components/BotCard'
import ArchivedBots from './components/ArchivedBots'
import TradeList from './components/TradeList'
import MonthlyPnl from './components/MonthlyPnl'
import ProfitFinder from './components/ProfitFinder'
import Sniper from './components/Sniper'
import AutoSniperStrip from './components/AutoSniperStrip'
import SwapPanel from './components/SwapPanel'
import ProfitCalculator from './components/ProfitCalculator'
import Docs from './components/Docs'
import Onboarding from './components/Onboarding'
import Wizard from './components/Wizard'
import BotDetail from './components/BotDetail'
import ErrorBoundary from './components/ErrorBoundary'
import SmartMoney from './components/SmartMoney'
import CopyTrading from './components/CopyTrading'
import AiBot from './components/AiBot'
import MarketPanel from './components/MarketPanel'
import Portfolio from './components/Portfolio'
import BottomNav from './components/BottomNav'
import Toaster from './components/Toaster'
import ConfirmDialog from './components/ConfirmDialog'
import { TournamentPanel, TournamentModal } from './components/Tournament'

/** Small dashboard section heading — title + optional sub + right-aligned slot. */
function SectionLabel({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 px-0.5">
      <div className="min-w-0">
        <h2 className="text-sm font-bold tracking-tight text-white">{title}</h2>
        {sub && <p className="mt-0.5 truncate text-[11px] text-slate-500">{sub}</p>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  )
}

function Main() {
  const {
    init, bots, view, wizardOpen, finderOpen, sniperOpen, swapOpen, calcOpen, tourOpen,
    aiOpen, tournamentOpen, openWizard, openTour, selectedBotId, createBot, notify, mode, confirm,
  } = useStore(
    useShallow((s) => ({
      init: s.init, bots: s.bots, view: s.view, wizardOpen: s.wizardOpen, finderOpen: s.finderOpen,
      sniperOpen: s.sniperOpen, swapOpen: s.swapOpen, calcOpen: s.calcOpen, tourOpen: s.tourOpen, aiOpen: s.aiOpen,
      tournamentOpen: s.tournamentOpen, openWizard: s.openWizard, openTour: s.openTour,
      selectedBotId: s.selectedBotId, createBot: s.createBot, notify: s.notify, mode: s.mode, confirm: s.confirm,
    })),
  )
  const [ready, setReady] = useState(false)
  const [bootErr, setBootErr] = useState(false)
  const [launching, setLaunching] = useState(false)
  // Bookmarkable URLs: sync the location hash with the active channel / portfolio tab / open bot.
  useHashRoute(ready)

  // A bot is archived if manually archived OR retired (status 'stopped') — either way
  // it's hidden from the active grid and shown in the collapsible Archived section.
  const isArchived = (b: (typeof bots)[number]) => b.archived === true || b.status === 'stopped'
  // Scope the dashboard to the ACTIVE workspace — the Live view never shows paper bots.
  const botsByMode = botsForMode(bots, mode)
  const activeBots = botsByMode.filter((b) => !isArchived(b))
  const archivedBots = botsByMode.filter(isArchived)

  // One-click "All-Weather" bot: the regime-switching adaptive strategy (rides
  // uptrends, mean-reverts ranges, goes to cash in downtrends) on a liquid coin,
  // balanced risk — backtested to profit across rising/falling/ranging markets.
  const launchAllWeather = async () => {
    const m = useStore.getState().meta
    const net = m?.networks.find((n) => n.evm !== false && n.tokens?.length)
    const token = net?.tokens[0]?.symbol
    if (!net || !token) {
      notify('No tradeable network is available', 'error')
      return
    }
    const ok = await confirm({
      title: 'Launch the All-Weather bot?',
      message: `Creates an adaptive, balanced-risk bot on ${token} with a $200 budget in the ${mode} workspace. It switches tactics by market regime — riding uptrends, mean-reverting ranges, moving to cash in downtrends — and trades automatically around the clock.${mode === 'live' ? '\n\n⚠ Live workspace: this bot trades REAL funds.' : ''}`,
      confirmLabel: 'Launch bot',
      tone: mode === 'live' ? 'danger' : 'default',
    })
    if (!ok) return
    setLaunching(true)
    const out = await createBot({ network: net.id, token, strategy: 'adaptive', risk: 'balanced', budgetUsd: 200, sweepTo: 'native' })
    setLaunching(false)
    if (out.error) notify(out.error, 'error')
    else notify(`🌤️ All-Weather bot launched on ${token} (${mode} mode)`, 'success')
  }

  useEffect(() => {
    init()
      .then(() => {
        setReady(true)
        if (!localStorage.getItem('pulsetrade.onboarded')) openTour(true)
      })
      .catch(() => setBootErr(true))
  }, [])

  if (bootErr)
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 text-slate-400">
        <div className="text-3xl">😴</div>
        <p className="text-sm">Engine offline — start it with <code className="rounded bg-white/10 px-1.5 py-0.5">npm run dev</code></p>
      </div>
    )

  if (!ready)
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        <div className="animate-pulse text-sm">Connecting to engine…</div>
      </div>
    )

  return (
    <div className="lg:flex lg:h-screen lg:overflow-hidden">
      <Sidebar />

      <div className="flex min-h-screen min-w-0 flex-1 flex-col lg:min-h-0">
        <Header />
        <ChannelHeader />

        <main className="has-bottom-nav flex-1 lg:overflow-y-auto">
          <div className="mx-auto max-w-7xl space-y-6 px-4 py-5 lg:px-8 lg:py-7">
            {/* Persistent across every view: a backgrounded auto-sniper campaign is always visible. */}
            <AutoSniperStrip />
            {/* key={view} remounts on a channel switch, so each view cross-fades in. */}
            <div key={view} className="animate-in space-y-6">
            {view === 'portfolio' ? (
              <Portfolio />
            ) : view === 'market' ? (
              <MarketPanel />
            ) : view === 'smart' ? (
              <SmartMoney />
            ) : view === 'copy' ? (
              <CopyTrading />
            ) : view === 'docs' ? (
              <Docs />
            ) : (
              <>
                <section className="space-y-3">
                  <SectionLabel title="Dashboard" sub="Your whole operation at a glance" />
                  <Overview />
                </section>

                {/* Market pulse is always one tap/scroll away — compact strip on the tablet/phone home */}
                <div className="lg:hidden">
                  <MarketPulseStrip />
                </div>

                {botsByMode.length === 0 ? (
                  <div className="glass animate-in flex flex-col items-center gap-4 px-6 py-16 text-center">
                    <div className="text-5xl">🤖</div>
                    <div>
                      <h2 className="text-xl font-bold text-white">{mode === 'live' ? 'No live bots yet' : 'No bots yet'}</h2>
                      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-slate-400">
                        Launch your first automated trader in under a minute. Pick a network, a liquid coin, a proven strategy and a risk
                        tolerance — the engine handles entries, exits and profit-taking around the clock.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <button className="btn-primary !px-6 !py-3 text-base" onClick={launchAllWeather} disabled={launching}>
                        {launching ? 'Launching…' : '🌤️ One-click All-Weather bot'}
                      </button>
                      <button className="btn-ghost !px-5 !py-3 text-base" onClick={() => openWizard(true)}>
                        🚀 Customize a bot
                      </button>
                      <button className="btn-ghost !px-5 !py-3 text-base" onClick={() => useStore.getState().openFinder(true)}>
                        💡 Find max profit
                      </button>
                    </div>
                    <p className="-mt-1 max-w-md text-xs text-slate-500">
                      All-Weather auto-switches tactics by market regime — rides uptrends, mean-reverts ranges, and moves to cash in downtrends. A capital-preserving default that limits drawdowns in falling and choppy markets — not a profit guarantee; returns depend on fees and slippage.
                    </p>
                  </div>
                ) : (
                  <section className="space-y-3">
                    <SectionLabel
                      title="Your bots"
                      sub={`${activeBots.length} active · ${activeBots.filter((b) => b.status === 'running').length} running${archivedBots.length ? ` · ${archivedBots.length} archived` : ''}`}
                      right={
                        <>
                          <button onClick={launchAllWeather} disabled={launching} className="btn-ghost hidden !py-1.5 text-xs sm:inline-flex">
                            {launching ? 'Launching…' : '🌤️ All-Weather'}
                          </button>
                          <button onClick={() => openWizard(true)} className="btn-primary !py-1.5 text-xs">
                            + New bot
                          </button>
                        </>
                      }
                    />
                    <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                      {activeBots.map((b, i) => (
                        <BotCard key={b.id} bot={b} index={i} />
                      ))}
                      <div className="glass flex min-h-44 flex-col items-center justify-center gap-2.5 self-start border-dashed p-4 text-slate-500">
                        <button onClick={launchAllWeather} disabled={launching} className="btn-primary w-full !py-2.5 text-sm">
                          {launching ? 'Launching…' : '🌤️ One-click All-Weather'}
                        </button>
                        <button onClick={() => openWizard(true)} className="text-sm font-medium hover:text-slate-300">
                          + Customize a new bot
                        </button>
                      </div>
                    </div>
                    <ArchivedBots bots={archivedBots} />
                  </section>
                )}

                <TournamentPanel />
                <MonthlyPnl />
                <TradeList />
              </>
            )}
            </div>

            <footer className="pb-2 pt-2 text-center text-[11px] leading-relaxed text-slate-600">
              PulseTrade trades automatically with real market data. Paper mode simulates fills; live mode executes on-chain (0x · Jupiter).
              <br />
              Nothing here is financial advice — backtested performance does not guarantee future returns.
            </footer>
          </div>
        </main>
      </div>

      <BottomNav />
      <Toaster />
      <ConfirmDialog />

      {wizardOpen && <Wizard />}
      {finderOpen && <ProfitFinder />}
      {sniperOpen && <Sniper />}
      {swapOpen && <SwapPanel />}
      {calcOpen && <ProfitCalculator />}
      {aiOpen && <AiBot />}
      {tournamentOpen && <TournamentModal />}
      {tourOpen && <Onboarding />}
      {selectedBotId && <BotDetail />}
    </div>
  )
}

/** Tiny one-line market regime strip shown on the mobile Home view. */
function MarketPulseStrip() {
  const setView = useStore((s) => s.setView)
  const [s, setS] = useState<{ label: string; composite: number; up: number; total: number } | null>(null)
  useEffect(() => {
    let alive = true
    fetch('/api/market')
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d?.status) return
        const priced = (d.coins ?? []).filter((c: any) => c.change24h !== null)
        setS({
          label: d.status.label,
          composite: d.status.composite,
          up: priced.filter((c: any) => c.change24h > 0).length,
          total: priced.length,
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  if (!s) return null
  const tone =
    s.label === 'risk-on' ? 'border-emerald-400/30 text-emerald-300' : s.label === 'risk-off' ? 'border-rose-400/30 text-rose-300' : 'border-amber-400/30 text-amber-300'
  return (
    <button onClick={() => setView('market')} className={`animate-in flex w-full items-center gap-2 rounded-xl border bg-white/[0.02] px-3 py-2 text-left ${tone}`}>
      <span className="shrink-0 text-sm font-semibold capitalize">{s.label.replace('-', ' ')}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500">pulse {s.composite}/100 · {s.up}/{s.total} coins up</span>
      <span className="shrink-0 text-[11px] text-slate-500">Market →</span>
    </button>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <Main />
    </ErrorBoundary>
  )
}
