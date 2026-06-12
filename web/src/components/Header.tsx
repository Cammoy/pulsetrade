import { useStore } from '../store'
import WalletButton from './WalletButton'

export default function Header() {
  const { wsOk, mode, setMode, meta, openWizard, openFinder, openSniper, openDocs, openTour } = useStore()

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#070a12]/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-lg shadow-lg shadow-indigo-500/30">
            ⚡
          </div>
          <div>
            <div className="text-base font-bold tracking-tight text-white">PulseTrade</div>
            <div className="-mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className={`h-1.5 w-1.5 rounded-full ${wsOk ? 'bg-emerald-400' : 'bg-rose-400'}`} />
              {wsOk ? 'engine live' : 'reconnecting…'}
            </div>
          </div>
        </div>

        <div className="ml-3 flex items-center rounded-xl border border-white/10 bg-white/[0.03] p-0.5 text-xs">
          {(['paper', 'live'] as const).map((m) => (
            <button
              key={m}
              onClick={async () => {
                const out = await setMode(m)
                if (out.error) alert(out.error)
              }}
              className={`cursor-pointer rounded-[10px] px-3 py-1.5 font-semibold transition-all ${
                mode === m
                  ? m === 'live'
                    ? 'bg-rose-500/90 text-white shadow'
                    : 'bg-indigo-500/90 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={m === 'live' && !meta?.live.ready ? 'Add ZEROX_API_KEY + BOT_WALLET_KEY to server/.env to enable' : ''}
            >
              {m === 'paper' ? '📝 Paper' : '🔴 Live'}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <WalletButton />
          <button className="btn-ghost hidden sm:inline-flex" onClick={() => openSniper(true)} title="Snipe freshly launched tokens — auto-screened for honeypots and rugs">
            🎯 Sniper
          </button>
          <button className="btn-ghost hidden sm:inline-flex" onClick={() => openFinder(true)} title="Backtest every strategy × risk × coin for a stake and rank by profit">
            💡 Profit Finder
          </button>
          <button className="btn-ghost !px-2.5" onClick={() => openDocs(true)} title="Documentation">📖</button>
          <button className="btn-ghost !px-2.5" onClick={() => openTour(true)} title="Replay the welcome tour">?</button>
          <button className="btn-primary" onClick={() => openWizard(true)}>
            + New Bot
          </button>
        </div>
      </div>
    </header>
  )
}
