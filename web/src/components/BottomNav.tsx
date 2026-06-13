import { useStore } from '../store'

/**
 * Native-feeling bottom navigation for mobile (hidden on md+). Two views
 * (Home, Market), a prominent center "New Bot" action, the Sniper, and a
 * "More" sheet with the rest of the tools.
 */
export default function BottomNav() {
  const { view, setView, openWizard, openSniper, openMore, moreOpen } = useStore()

  const Item = ({ active, icon, label, onClick }: { active?: boolean; icon: string; label: string; onClick: () => void }) => (
    <button
      onClick={onClick}
      className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 py-1.5 transition-all active:scale-95 ${active ? 'text-indigo-300' : 'text-slate-500'}`}
    >
      <span className="text-lg leading-none">{icon}</span>
      <span className="text-[10px] font-medium">{label}</span>
      <span className={`h-0.5 w-5 rounded-full transition-all ${active ? 'bg-indigo-400' : 'bg-transparent'}`} />
    </button>
  )

  return (
    <>
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-[#0a0e17]/95 backdrop-blur-xl md:hidden">
        <div className="mx-auto flex max-w-md items-end px-2">
          <Item active={view === 'home'} icon="🤖" label="Bots" onClick={() => setView('home')} />
          <Item active={view === 'market'} icon="📊" label="Market" onClick={() => setView('market')} />
          <button
            onClick={() => openWizard(true)}
            aria-label="New bot"
            className="mx-1 -mt-5 flex h-13 w-13 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-2xl text-white shadow-lg shadow-indigo-500/40 transition-transform active:scale-90"
            style={{ height: 52, width: 52 }}
          >
            +
          </button>
          <Item icon="🎯" label="Sniper" onClick={() => openSniper(true)} />
          <Item active={moreOpen} icon="⋯" label="More" onClick={() => openMore(true)} />
        </div>
      </nav>
      {moreOpen && <MoreSheet />}
    </>
  )
}

function MoreSheet() {
  const { openMore, openFinder, openAi, openSmartMoney, openTournament, openDocs, openTour } = useStore()
  const go = (fn: (o: boolean) => void) => () => {
    openMore(false)
    fn(true)
  }
  const items = [
    { icon: '💡', label: 'Profit Finder', sub: 'Backtest everything, rank by profit', onClick: go(openFinder) },
    { icon: '🤖', label: 'AI Trader', sub: 'Gemini calls buy / sell / hold', onClick: go(openAi) },
    { icon: '🐋', label: 'Smart Money', sub: 'Track, copy & follow whale wallets', onClick: go(openSmartMoney) },
    { icon: '🏆', label: 'Tournament', sub: 'Bots compete for the best return', onClick: go(openTournament) },
    { icon: '📖', label: 'Documentation', sub: 'How everything works', onClick: go(openDocs) },
    { icon: '✨', label: 'Welcome tour', sub: 'Replay the onboarding', onClick: go(openTour) },
  ]
  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm md:hidden" onClick={() => openMore(false)}>
      <div className="animate-sheet pb-safe w-full max-w-md rounded-t-3xl border-t border-white/10 bg-[#0d1320] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" />
        <div className="space-y-1">
          {items.map((it) => (
            <button
              key={it.label}
              onClick={it.onClick}
              className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors active:bg-white/[0.08]"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.06] text-xl">{it.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-100">{it.label}</span>
                <span className="block truncate text-[11px] text-slate-500">{it.sub}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
