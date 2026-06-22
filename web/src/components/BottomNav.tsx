import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { useModal } from '../useModal'
import { TOOL_ITEMS, type ToolAction } from './tools'
import ThemeToggle from './ThemeToggle'

/**
 * Native-feeling bottom navigation for mobile (hidden on lg+). Four primary views
 * with a sliding active indicator that glides between tabs, a prominent center
 * "New bot" action, and a "More" sheet for Smart Money + the rest of the tools.
 */

// Crisp line icons (currentColor) — sharper + more premium than emoji on the phone bar.
const Icon = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)
const ICONS: Record<string, ReactNode> = {
  home: <Icon d="M5 10.5 12 4l7 6.5M6 9.5V20h12V9.5M9.5 20v-5h5v5" />,
  portfolio: <Icon d="M3 7.5h18v11H3zM3 7.5 5.5 4h13L21 7.5M16 12.5h2.5" />,
  market: <Icon d="M4 19V5M4 19h16M8 16l3.5-4 3 2.5L20 8" />,
  more: <Icon d="M5 6h14M5 12h14M5 18h14" />,
}

export default function BottomNav() {
  const { view, setView, openWizard, openMore, moreOpen } = useStore(
    useShallow((s) => ({ view: s.view, setView: s.setView, openWizard: s.openWizard, openMore: s.openMore, moreOpen: s.moreOpen })),
  )

  // Smart Money lives in the More sheet now, so "More" reads active on that view too.
  const activeKey = moreOpen ? 'more' : view === 'smart' ? 'more' : view
  const railRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [pill, setPill] = useState<{ left: number; width: number }>({ left: 0, width: 0 })

  // Measure the active tab and slide the indicator to it (re-measures on resize/rotate).
  useLayoutEffect(() => {
    const measure = () => {
      const el = itemRefs.current[activeKey]
      const rail = railRef.current
      if (!el || !rail) return
      setPill({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()
    if (typeof ResizeObserver === 'undefined' || !railRef.current) return
    const ro = new ResizeObserver(measure)
    ro.observe(railRef.current)
    return () => ro.disconnect()
  }, [activeKey])

  const Tab = ({ id, label, onClick }: { id: string; label: string; onClick: () => void }) => {
    const active = activeKey === id
    return (
      <button
        ref={(el) => { itemRefs.current[id] = el }}
        onClick={onClick}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={`tap relative z-10 flex flex-1 flex-col items-center gap-1 py-2 transition-colors duration-200 active:scale-90 ${
          active ? 'text-indigo-500 dark:text-indigo-300' : 'text-slate-400 dark:text-slate-500'
        }`}
      >
        {ICONS[id]}
        <span className={`text-[10px] font-semibold tracking-tight transition-opacity ${active ? 'opacity-100' : 'opacity-80'}`}>{label}</span>
      </button>
    )
  }

  return (
    <>
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-[var(--header)] backdrop-blur-xl lg:hidden">
        <div ref={railRef} className="relative mx-auto flex max-w-md items-end px-1">
          {/* sliding active indicator */}
          {pill.width > 0 && (
            <span
              aria-hidden
              className="absolute top-1 h-[46px] rounded-2xl bg-indigo-500/[0.12] ring-1 ring-indigo-400/20 dark:bg-indigo-400/[0.14]"
              style={{ left: pill.left, width: pill.width, transform: 'translateZ(0)', transition: 'left 0.32s var(--ease-out), width 0.32s var(--ease-out)' }}
            />
          )}
          <Tab id="home" label="Bots" onClick={() => setView('home')} />
          <Tab id="portfolio" label="Wallet" onClick={() => setView('portfolio')} />
          {/* center "New bot" action */}
          <button
            onClick={() => openWizard(true)}
            aria-label="New bot"
            className="brand-gradient relative z-10 mx-1 -mt-5 flex shrink-0 items-center justify-center rounded-[18px] text-2xl text-[var(--ink)] shadow-lg shadow-indigo-500/30 transition-transform active:scale-90 dark:shadow-fuchsia-500/40"
            style={{ height: 54, width: 54 }}
          >
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <Tab id="market" label="Market" onClick={() => setView('market')} />
          <Tab id="more" label="More" onClick={() => openMore(true)} />
        </div>
      </nav>
      {moreOpen && <MoreSheet />}
    </>
  )
}

function MoreSheet() {
  const { openMore, setView, smartActive } = useStore(
    useShallow((s) => ({ openMore: s.openMore, setView: s.setView, smartActive: s.view === 'smart' })),
  )
  useModal(() => openMore(false))
  const run = (action: ToolAction) => () => {
    openMore(false)
    ;(useStore.getState()[action] as (o: boolean) => void)(true)
  }
  const goSmart = () => {
    openMore(false)
    setView('smart')
  }
  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm lg:hidden" onClick={() => openMore(false)}>
      <div className="animate-sheet pb-safe w-full max-w-md rounded-t-3xl border-t border-white/10 bg-[var(--menu)] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" />

        {/* Smart Money — promoted to the top of the sheet (a primary insight view). */}
        <button
          onClick={goSmart}
          className={`mb-2 flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-colors ${
            smartActive ? 'border-indigo-400/40 bg-indigo-500/[0.12]' : 'border-white/10 bg-white/[0.04] active:bg-white/[0.08]'
          }`}
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.06] text-xl">🐋</span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-slate-100">Smart Money</span>
            <span className="block truncate text-[11px] text-slate-500">Whale flows, notable moves & emerging coins</span>
          </span>
          <span className="ml-auto text-slate-500">›</span>
        </button>

        <div className="mb-2 flex items-center justify-between rounded-2xl bg-white/[0.03] px-3 py-2.5">
          <span className="text-sm font-semibold text-slate-100">Appearance</span>
          <ThemeToggle />
        </div>

        <div className="space-y-1">
          {TOOL_ITEMS.map((it) => (
            <button
              key={it.action}
              onClick={run(it.action)}
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
