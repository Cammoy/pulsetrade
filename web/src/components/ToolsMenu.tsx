import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { TOOL_ITEMS, type ToolAction } from './tools'

/**
 * Desktop "Tools" dropdown. Collapses the formerly-scattered emoji header
 * buttons (AI, Smart Money, Tournament, Sniper, Profit Finder, Docs, Tour)
 * into one discoverable menu where every entry has a label and a description.
 */
export default function ToolsMenu() {
  const store = useStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on Escape — matches the wallet/modal dismissal affordance.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const run = (action: ToolAction) => {
    setOpen(false)
    ;(store[action] as (o: boolean) => void)(true)
  }

  const features = TOOL_ITEMS.filter((t) => t.group === 'feature')
  const help = TOOL_ITEMS.filter((t) => t.group === 'help')

  const Row = ({ action, icon, label, sub }: (typeof TOOL_ITEMS)[number]) => (
    <button
      key={action}
      onClick={() => run(action)}
      className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/[0.07]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-lg">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-slate-100">{label}</span>
        <span className="block truncate text-[11px] text-slate-500">{sub}</span>
      </span>
    </button>
  )

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Profit Finder, AI Trader, Smart Money, Tournament, Sniper & more"
        className={`btn-ghost shrink-0 whitespace-nowrap ${open ? 'bg-white/[0.09] text-white' : ''}`}
      >
        <span>🧰</span>
        <span className="hidden sm:inline">Tools</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="menu" className="animate-in absolute right-0 z-50 mt-2 w-72 rounded-2xl border border-white/10 bg-[var(--menu)] p-2 shadow-2xl shadow-black/50">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Features</div>
            {features.map(Row)}
            <div className="my-1.5 border-t border-white/[0.08]" />
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Help</div>
            {help.map(Row)}
          </div>
        </>
      )}
    </div>
  )
}
