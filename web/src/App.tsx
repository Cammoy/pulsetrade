import { useEffect, useState } from 'react'
import { useStore } from './store'
import Header from './components/Header'
import StatsBar from './components/StatsBar'
import BotCard from './components/BotCard'
import TradeList from './components/TradeList'
import MonthlyPnl from './components/MonthlyPnl'
import ProfitFinder from './components/ProfitFinder'
import Sniper from './components/Sniper'
import Docs from './components/Docs'
import Onboarding from './components/Onboarding'
import Wizard from './components/Wizard'
import BotDetail from './components/BotDetail'
import ErrorBoundary from './components/ErrorBoundary'
import SmartMoney from './components/SmartMoney'
import AiBot from './components/AiBot'
import { TournamentPanel, TournamentModal } from './components/Tournament'

function Main() {
  const { init, bots, wizardOpen, finderOpen, sniperOpen, docsOpen, tourOpen, smartMoneyOpen, aiOpen, tournamentOpen, openWizard, openTour, selectedBotId } = useStore()
  const [ready, setReady] = useState(false)
  const [bootErr, setBootErr] = useState(false)

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
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-5">
        <StatsBar />

        {bots.length === 0 ? (
          <div className="glass flex flex-col items-center gap-4 px-6 py-16 text-center">
            <div className="text-5xl">🤖</div>
            <div>
              <h2 className="text-xl font-bold text-white">No bots yet</h2>
              <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-slate-400">
                Launch your first automated trader in under a minute. Pick a cheap network, a liquid coin, a proven strategy and a risk
                tolerance — the engine handles entries, exits and profit-taking around the clock.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button className="btn-primary !px-6 !py-3 text-base" onClick={() => openWizard(true)}>
                🚀 Create your first bot
              </button>
              <button className="btn-ghost !px-5 !py-3 text-base" onClick={() => useStore.getState().openFinder(true)}>
                💡 Find max profit for $100
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {bots.map((b) => (
              <BotCard key={b.id} bot={b} />
            ))}
            <button
              onClick={() => openWizard(true)}
              className="glass glass-hover flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 border-dashed text-slate-500 hover:text-slate-300"
            >
              <span className="text-3xl">+</span>
              <span className="text-sm font-medium">New bot</span>
            </button>
          </div>
        )}

        <TournamentPanel />

        <MonthlyPnl />

        <TradeList />

        <footer className="pb-6 pt-2 text-center text-[11px] leading-relaxed text-slate-600">
          PulseTrade trades automatically with real market data. Paper mode simulates fills; live mode executes on-chain via 0x.
          <br />
          Nothing here is financial advice — backtested performance does not guarantee future returns.
        </footer>
      </main>

      {wizardOpen && <Wizard />}
      {finderOpen && <ProfitFinder />}
      {sniperOpen && <Sniper />}
      {smartMoneyOpen && <SmartMoney />}
      {aiOpen && <AiBot />}
      {tournamentOpen && <TournamentModal />}
      {docsOpen && <Docs />}
      {tourOpen && <Onboarding />}
      {selectedBotId && <BotDetail />}
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <Main />
    </ErrorBoundary>
  )
}
