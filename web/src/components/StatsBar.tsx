import type { ReactNode } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { fmtSign, fmtUsd, pnlColor } from '../format'
import { aggregateStats, botsForMode } from '../stats'
import CountUp from '../useCountUp'

function Stat({ label, value, sub, color, title }: { label: string; value: ReactNode; sub?: string; color?: string; title?: string }) {
  return (
    <div className="glass min-w-0 px-4 py-3">
      <div className="truncate text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</div>
      <div className={`mt-0.5 truncate text-xl font-bold tabular-nums ${color ?? 'text-white'}`} title={title}>{value}</div>
      {sub && <div className="truncate text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}

export default function StatsBar() {
  const { bots, mode } = useStore(useShallow((s) => ({ bots: s.bots, mode: s.mode })))
  // Overview is scoped to the ACTIVE workspace — paper and live totals never mix.
  const { totalPnl, realized, native, wins, losses, winRate, activeCount, total, byRisk } = aggregateStats(botsForMode(bots, mode))

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Total P&L" value={<CountUp value={totalPnl} format={fmtSign} />} title={fmtSign(totalPnl)} color={pnlColor(totalPnl)} sub={`realized ${fmtSign(realized)}`} />
        <Stat label="Profit taken" value={<CountUp value={native} format={fmtUsd} />} title={fmtUsd(native)} sub="swept to native / USDT" color="text-cyan-300" />
        <Stat label="Active bots" value={`${activeCount}/${total}`} sub="running or scheduled" />
        <Stat
          label="Win rate"
          value={winRate === null ? '—' : `${winRate.toFixed(0)}%`}
          sub={`${wins}W · ${losses}L closed`}
          color={winRate === null ? undefined : winRate >= 50 ? 'text-emerald-400' : 'text-amber-400'}
        />
      </div>
      {bots.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-slate-500">
          <span className="font-medium uppercase tracking-wide text-[10px]">P&L by tolerance</span>
          {byRisk.map(({ r, pnl, n }) => (
            <span key={r} className="chip border border-white/10 bg-white/[0.03]">
              <span className="capitalize text-slate-400">{r}</span>
              <span className={`tabular-nums font-semibold ${pnlColor(pnl)}`}>{n ? fmtSign(pnl) : '—'}</span>
              <span className="text-slate-600">×{n}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
