import { useStore } from '../store'
import WalletButton from './WalletButton'
import ModeSwitch from './ModeSwitch'
import BreakerBadge from './BreakerBadge'
import TurnkeyBadge from './TurnkeyBadge'

/**
 * Mobile / tablet top bar (below lg). The brand + engine status on the left,
 * the live-trading controls on the right; views and tools live in the
 * BottomNav. On desktop this is replaced by the Slack Sidebar + ChannelHeader.
 */
export default function Header() {
  const { wsOk } = useStore()

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-[var(--header)] backdrop-blur-xl lg:hidden">
      <div className="flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4">
        {/* Brand */}
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="brand-gradient flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-lg shadow-lg dark:shadow-fuchsia-500/30">
            ⚡
          </div>
          <div className="min-w-0">
            <div className="text-gradient truncate text-base font-bold tracking-tight">PulseTrade</div>
            <div className="-mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className={`h-1.5 w-1.5 rounded-full ${wsOk ? 'bg-emerald-400 pulse-dot' : 'bg-rose-400'}`} />
              <span className="whitespace-nowrap">{wsOk ? 'engine live' : 'reconnecting…'}</span>
            </div>
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <BreakerBadge />
          <TurnkeyBadge />
          <ModeSwitch />
          <WalletButton />
        </div>
      </div>
    </header>
  )
}
