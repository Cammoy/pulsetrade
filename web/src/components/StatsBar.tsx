import { useStore } from '../store'
import { fmtSign, fmtUsd, pnlColor } from '../format'

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="glass flex-1 px-4 py-3">
      <div className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</div>
      <div className={`mt-0.5 text-xl font-bold tabular-nums ${color ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}

export default function StatsBar() {
  const { bots } = useStore()
  const active = bots.filter((b) => b.status === 'running' || b.status === 'scheduled')
  const totalPnl = bots.reduce((s, b) => s + b.totalPnlUsd, 0)
  const realized = bots.reduce((s, b) => s + b.stats.realizedUsd, 0)
  const native = bots.reduce((s, b) => s + b.stats.nativeTakenUsd, 0)
  const wins = bots.reduce((s, b) => s + b.stats.wins, 0)
  const losses = bots.reduce((s, b) => s + b.stats.losses, 0)
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : null

  const byRisk = (['conservative', 'balanced', 'aggressive'] as const).map((r) => ({
    r,
    pnl: bots.filter((b) => b.risk === r).reduce((s, b) => s + b.totalPnlUsd, 0),
    n: bots.filter((b) => b.risk === r).length,
  }))

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Stat label="Total P&L" value={fmtSign(totalPnl)} color={pnlColor(totalPnl)} sub={`realized ${fmtSign(realized)}`} />
        <Stat label="Profit taken" value={fmtUsd(native)} sub="swept to ETH / BNB / POL / USDT" color="text-cyan-300" />
        <Stat label="Active bots" value={`${active.length}/${bots.length}`} sub="running or scheduled" />
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
