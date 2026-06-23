import { useEffect, useState } from 'react'
import { useStore } from '../store'

/** Compact countdown for the strip. */
function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Persistent "Auto-Sniper is running" banner. Because launching a campaign closes the
 * Sniper modal, a backgrounded campaign would otherwise be invisible — this is shown on
 * every view (only while a campaign runs) so the user always knows, and one tap reopens
 * the live panel. Renders nothing when no campaign is running.
 */
export default function AutoSniperStrip() {
  const autoSniper = useStore((s) => s.autoSniper)
  const openSniperAuto = useStore((s) => s.openSniperAuto)
  const [now, setNow] = useState(() => Date.now())
  const running = autoSniper?.enabled

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  if (!running || !autoSniper) return null
  const a = autoSniper
  const live = a.workspace === 'live'
  const target = a.targetSnipes && a.targetSnipes > 0 ? a.targetSnipes : Math.max(1, Math.floor(a.totalBudgetUsd / a.perSnipeUsd))
  const opened = a.openedCount ?? 0
  const interval = a.entryIntervalMs && a.entryIntervalMs > 0 ? a.entryIntervalMs : 2 * 60 * 60_000
  const lastEntry = a.lastEntryAt ?? 0
  const remaining = lastEntry > 0 ? Math.max(0, lastEntry + interval - now) : 0
  const blocked = a.stats.active >= a.maxConcurrent || a.poolUsd < a.perSnipeUsd
  const due = lastEntry === 0 || remaining <= 0
  const status = blocked ? 'all slots working' : due ? 'hunting now' : `next snipe in ${fmt(remaining)}`

  return (
    <button
      onClick={openSniperAuto}
      className="sniper-strip animate-in flex w-full items-center gap-2.5 rounded-xl border border-emerald-400/25 bg-gradient-to-r from-emerald-500/[0.08] to-indigo-500/[0.05] px-3.5 py-2.5 text-left transition-colors hover:border-emerald-400/40"
      title="Open the Auto-Sniper"
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
      </span>
      <span className="shrink-0 text-sm font-bold text-emerald-200">🤖 Auto-Sniper running</span>
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${live ? 'bg-rose-500/20 text-rose-300' : 'bg-slate-500/20 text-slate-300'}`}>{live ? '🔴 Live' : '📝 Paper'}</span>
      <span className="hidden min-w-0 truncate text-xs text-slate-400 sm:inline">
        <span className="capitalize">{a.network}</span> · snipe {opened} of {target} · {status}
      </span>
      <span className="ml-auto shrink-0 text-xs font-semibold text-indigo-300">Open →</span>
    </button>
  )
}
