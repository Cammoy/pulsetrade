import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { botsForMode } from '../stats'
import { fmtSign, pnlColor } from '../format'
import WalletButton from './WalletButton'
import ModeSwitch from './ModeSwitch'
import ThemeToggle from './ThemeToggle'
import BreakerBadge from './BreakerBadge'
import TurnkeyBadge from './TurnkeyBadge'

/**
 * Desktop content-column top bar, styled like a Slack channel header:
 * a "#"-prefixed channel name + a topic line on the left, and the live
 * trading controls (mode toggle, wallet, new bot) on the right. Shown lg+
 * only — mobile keeps the existing <Header>.
 *
 * `relative z-30` is load-bearing: this header has a backdrop-blur (its own
 * stacking context) and sits *before* <main> in the DOM, so without an
 * explicit z-index the scrolling content would paint over its dropdowns
 * (e.g. the wallet picker). The z lifts the header — and its popovers —
 * above the content, while staying below modals (z-50).
 */
const VIEW_META = {
  home: { hash: 'bots', topic: 'Your automated traders — entries, exits & profit-taking, around the clock' },
  portfolio: { hash: 'portfolio', topic: 'Everything in your wallet, by network and by asset' },
  market: { hash: 'market', topic: 'Live market regime, movers & signals across the majors' },
  smart: { hash: 'smart-money', topic: 'What tracked whales & smart-money wallets are buying and selling' },
  copy: { hash: 'copy-trade', topic: 'Rank copy-worthy wallets, then mirror their trades automatically' },
  docs: { hash: 'docs', topic: 'How everything works — strategies, sniper, swap, going live & safety' },
} as const

export default function ChannelHeader() {
  const { view, bots, mode, openWizard } = useStore(
    useShallow((s) => ({ view: s.view, bots: s.bots, mode: s.mode, openWizard: s.openWizard })),
  )
  const vm = VIEW_META[view]
  // Scope the header's bot count + P&L to the active workspace (no paper/live mix).
  const modeBots = botsForMode(bots, mode)
  const running = modeBots.filter((b) => b.status === 'running').length
  const totalPnl = modeBots.reduce((s, b) => s + b.totalPnlUsd, 0)

  return (
    <header className="relative z-30 hidden h-14 shrink-0 items-center gap-3 border-b border-white/[0.08] bg-[var(--header)] px-5 backdrop-blur-xl lg:flex">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="flex shrink-0 items-baseline gap-1 text-[15px] font-bold tracking-tight text-white">
          <span className="text-slate-500">#</span>
          {vm.hash}
        </h1>
        {view === 'home' ? (
          <span className="hidden min-w-0 items-baseline gap-2 truncate border-l border-white/10 pl-3 text-xs xl:flex">
            <span className="text-slate-500">
              {modeBots.length} {modeBots.length === 1 ? 'bot' : 'bots'} · {running} running · {mode} mode
            </span>
            {modeBots.length > 0 && <span className={`font-semibold tabular-nums ${pnlColor(totalPnl)}`}>{fmtSign(totalPnl)}</span>}
          </span>
        ) : (
          <span className="hidden min-w-0 truncate border-l border-white/10 pl-3 text-xs text-slate-500 xl:block">{vm.topic}</span>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <BreakerBadge />
        <TurnkeyBadge />
        <ThemeToggle />
        <ModeSwitch />
        <WalletButton />
        <button className="btn-primary" onClick={() => openWizard(true)}>
          + New Bot
        </button>
      </div>
    </header>
  )
}
