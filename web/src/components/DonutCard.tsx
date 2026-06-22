import { fmtUsd } from '../format'
import Donut from './Donut'

/** A donut chart + legend in a glass card. Shows EVERY segment — including $0 ones —
 *  so the breakdown is comprehensive: non-zero first (largest first), then any
 *  zero-value entries muted at the bottom. Shared by the Portfolio + Staking views. */
export default function DonutCard({ title, segments, total }: { title: string; segments: { label: string; value: number; color: string }[]; total: number }) {
  const ordered = [...segments].sort((a, b) => b.value - a.value)
  return (
    <div className="glass p-5">
      <h3 className="text-sm font-bold text-white">{title}</h3>
      <div className="mt-3 flex items-center gap-5">
        <div className="relative h-40 w-40 shrink-0">
          <Donut segments={segments} />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">Total</span>
            <span className="text-base font-bold tabular-nums text-white">{fmtUsd(total)}</span>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          {ordered.slice(0, 9).map((s) => {
            const zero = !(s.value > 0)
            return (
              <div key={s.label} className="flex items-center gap-2 text-xs">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: zero ? 'rgba(100,116,139,0.35)' : s.color }} />
                <span className={`min-w-0 flex-1 truncate ${zero ? 'text-slate-500' : 'text-slate-300'}`}>{s.label}</span>
                <span className="shrink-0 tabular-nums text-slate-600">{total > 0 && s.value > 0 ? ((s.value / total) * 100).toFixed(0) : '0'}%</span>
                <span className={`w-16 shrink-0 text-right tabular-nums ${zero ? 'text-slate-600' : 'text-slate-200'}`}>{fmtUsd(s.value)}</span>
              </div>
            )
          })}
          {ordered.length === 0 && <p className="text-xs text-slate-500">Nothing tracked yet.</p>}
        </div>
      </div>
    </div>
  )
}
