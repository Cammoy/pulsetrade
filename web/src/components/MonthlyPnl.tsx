import { useState } from 'react'
import { useStore } from '../store'
import { fmtSign, fmtUsd, pnlColor } from '../format'

const MONTH_LABEL = (key: string) => {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

export default function MonthlyPnl() {
  const { monthly } = useStore()
  const [open, setOpen] = useState(true)
  const months = Object.keys(monthly).sort().reverse()

  return (
    <section className="glass overflow-hidden">
      <button
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
        onClick={() => setOpen(!open)}
      >
        <span className="text-sm font-semibold text-white">Monthly P&L</span>
        <span className="chip bg-white/[0.06] text-slate-400">{months.length} month{months.length === 1 ? '' : 's'}</span>
        <span className="ml-1 text-[11px] text-slate-600">persisted ledger — includes deleted bots</span>
        <span className="ml-auto text-xs text-slate-500">{open ? '▲ hide' : '▼ show'}</span>
      </button>

      {open && (
        <div className="overflow-auto border-t border-white/[0.05]">
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                {['Month', 'Realized P&L', 'Win rate', 'Fees', 'Profit swept out', 'Volume', 'Conservative', 'Balanced', 'Aggressive'].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {months.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-slate-600">
                    No closed trades yet — the ledger fills in as bots realize P&L.
                  </td>
                </tr>
              )}
              {months.map((k) => {
                const m = monthly[k]
                const wr = m.wins + m.losses > 0 ? Math.round((m.wins / (m.wins + m.losses)) * 100) : null
                return (
                  <tr key={k} className="border-t border-white/[0.04] tabular-nums hover:bg-white/[0.02]">
                    <td className="px-3 py-2 font-medium text-slate-200">{MONTH_LABEL(k)}</td>
                    <td className={`px-3 py-2 font-semibold ${pnlColor(m.realizedUsd)}`}>{fmtSign(m.realizedUsd)}</td>
                    <td className="px-3 py-2 text-slate-300">{wr === null ? '—' : `${wr}% (${m.wins}W/${m.losses}L)`}</td>
                    <td className="px-3 py-2 text-slate-500">{fmtUsd(m.feesUsd)}</td>
                    <td className="px-3 py-2 text-cyan-300">{fmtUsd(m.nativeTakenUsd)}</td>
                    <td className="px-3 py-2 text-slate-400">{fmtUsd(m.volumeUsd)}</td>
                    {(['conservative', 'balanced', 'aggressive'] as const).map((r) => (
                      <td key={r} className={`px-3 py-2 ${m.byRisk[r] !== undefined ? pnlColor(m.byRisk[r]) : 'text-slate-600'}`}>
                        {m.byRisk[r] !== undefined ? fmtSign(m.byRisk[r]) : '—'}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
