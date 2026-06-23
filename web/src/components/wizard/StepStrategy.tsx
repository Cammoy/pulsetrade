import { fmtPct } from '../../format'
import { runBacktest, type WizardCtx } from './shared'
import type { BacktestResult } from '../../types'

export default function StepStrategy({ w }: { w: WizardCtx }) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">Choose a strategy</h2>
        <button
          className="btn-ghost !py-1.5 text-xs"
          disabled={w.comparing || !w.tok}
          onClick={async () => {
            if (!w.tok) return
            w.setComparing(true)
            const out: Record<string, BacktestResult> = {}
            for (const s of w.meta.strategies) {
              out[s.id] = await runBacktest({ network: w.network, tokenCg: w.tok.cg, strategy: s.id, risk: w.risk, budgetUsd: Number(w.budget) || 1000 })
            }
            w.setCompare(out)
            w.setComparing(false)
          }}
        >
          {w.comparing ? 'Backtesting…' : `📊 Backtest all on ${w.token || 'coin'}`}
        </button>
      </div>
      <div className="space-y-2">
        {w.meta.strategies.map((s) => {
          const bt = w.compare?.[s.id]
          return (
            <button
              key={s.id}
              onClick={() => w.setStrategy(s.id)}
              className={`w-full cursor-pointer rounded-xl border p-3 text-left transition-all ${
                w.strategy === s.id ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-semibold text-white">{s.name}</span>
                  <span className="ml-2 text-[11px] text-cyan-300">{s.tagline}</span>
                </div>
                {bt && !bt.error && (
                  <span className={`text-sm font-bold tabular-nums ${bt.returnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {fmtPct(bt.returnPct)} <span className="text-[10px] font-normal text-slate-500">30d</span>
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{s.description}</p>
            </button>
          )
        })}
      </div>
    </div>
  )
}
