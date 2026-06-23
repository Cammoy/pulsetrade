import { useState } from 'react'
import { useStore } from '../store'
import type { Bot } from '../types'
import { fmtSign, pnlColor } from '../format'
import BotCard from './BotCard'

/**
 * Retired bots (status 'stopped' — a completed snipe, a finished copy/follow round
 * trip, a manual stop, or a tournament that ended) are ARCHIVED here: kept with their
 * final P&L but tucked out of the active grid, collapsed by default. Resuming a bot
 * moves it back to the active list automatically.
 */
export default function ArchivedBots({ bots }: { bots: Bot[] }) {
  const { remove, confirm } = useStore()
  const [open, setOpen] = useState(false)
  if (bots.length === 0) return null

  // Most-recently-retired first (last log entry ≈ the retirement event).
  const sorted = [...bots].sort((a, b) => (b.log[b.log.length - 1]?.ts ?? b.createdAt) - (a.log[a.log.length - 1]?.ts ?? a.createdAt))
  const totalPnl = bots.reduce((s, b) => s + b.totalPnlUsd, 0)

  const clearAll = async () => {
    if (await confirm({ message: `Delete all ${bots.length} archived bot(s) and their trade history? Your monthly P&L totals are kept.`, confirmLabel: 'Delete all', tone: 'danger' }))
      for (const b of bots) remove(b.id)
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 items-center gap-2 text-left">
          <span className="text-slate-500">{open ? '▾' : '▸'}</span>
          <span className="text-sm font-semibold text-slate-300">📦 Archived</span>
          <span className="chip bg-white/[0.06] text-slate-400">{bots.length}</span>
          <span className={`text-xs font-semibold tabular-nums ${pnlColor(totalPnl)}`}>{fmtSign(totalPnl)}</span>
        </button>
        {open && (
          <button onClick={clearAll} className="btn-ghost ml-auto !py-1 text-[11px] text-rose-300">
            Clear archived
          </button>
        )}
      </div>
      {open ? (
        <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {sorted.map((b) => (
            <BotCard key={b.id} bot={b} />
          ))}
        </div>
      ) : (
        <p className="-mt-1 text-[11px] text-slate-600">{bots.length} retired bot{bots.length === 1 ? '' : 's'} — click to expand. Resuming one brings it back to your active bots.</p>
      )}
    </section>
  )
}
