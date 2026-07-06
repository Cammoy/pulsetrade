import { useStore } from '../store'
import { useModal } from '../useModal'

/**
 * New Bot hub — the single fork for every way to create a bot. The "+ New Bot" action
 * everywhere (header, sidebar, bottom-nav, empty states) opens this chooser, which routes
 * to the right detailed flow. This is the Cluster-B consolidation: the AI Trader, Profit
 * Finder, Sniper and Tournament used to be scattered in the Tools menu (mixed with
 * non-creation tools like Swap/Calc) — they're all really *ways to create a bot*, so they
 * live here together under one discoverable entry point. Pure router: each card opens the
 * existing modal unchanged.
 */

/** A creation method → the store action that opens its modal. */
type OpenAction = 'openWizard' | 'openAi' | 'openFinder' | 'openSniper' | 'openTournament'

interface Method {
  action: OpenAction
  icon: string
  title: string
  sub: string
  /** A short tag rendered as a pill (e.g. "Recommended", "AI", "Advanced"). */
  tag?: string
}

const METHODS: Method[] = [
  { action: 'openWizard', icon: '🛠️', title: 'Build from scratch', sub: 'Pick a network, coin, strategy, risk & schedule. Full control over how it trades.', tag: 'Recommended' },
  { action: 'openAi', icon: '🤖', title: 'AI Trader', sub: 'Let Gemini read the chart and call buy / sell / hold, sized by confidence.', tag: 'AI' },
  { action: 'openFinder', icon: '💡', title: 'Profit Finder', sub: 'Backtest every strategy on real history, ranked by profit — launch the winner.' },
  { action: 'openSniper', icon: '🎯', title: 'Sniper', sub: 'Snipe newly-launched & trending tokens, auto-screened for rugs.', tag: 'High-risk' },
  { action: 'openTournament', icon: '🏆', title: 'Tournament', sub: 'Pit strategies against each other on one coin and back the leader.' },
]

export default function NewBotHub() {
  const close = () => useStore.getState().openNewBot(false)
  useModal(close)

  // Close the hub, then open the chosen flow — only one modal renders at a time.
  const pick = (action: OpenAction) => {
    close()
    ;(useStore.getState()[action] as (o: boolean) => void)(true)
  }

  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onClick={close}>
      <div className="animate-in glass flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden p-4" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-white">＋ New bot</span>
          <span className="text-[12px] text-slate-500">choose how to create it</span>
          <button onClick={close} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-white/[0.06] hover:text-white" aria-label="Close">✕</button>
        </div>

        {/* method cards */}
        <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
          {METHODS.map((m) => (
            <button
              key={m.action}
              onClick={() => pick(m.action)}
              className="group flex w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-3 text-left transition-colors hover:border-indigo-500/40 hover:bg-white/[0.05]"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-xl">{m.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-100">{m.title}</span>
                  {m.tag && <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-300">{m.tag}</span>}
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-slate-500">{m.sub}</span>
              </span>
              <span className="shrink-0 text-slate-600 transition-colors group-hover:text-slate-300">›</span>
            </button>
          ))}
        </div>

        <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
          Every method launches a real bot that trades automatically with live market data — paper by default; live mode is opt-in and gated. Backtested performance does not guarantee future returns.
        </p>
      </div>
    </div>
  )
}
