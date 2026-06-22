import { parseAmount } from '../../format'
import type { WizardCtx } from './shared'

export default function StepRiskBudget({ w }: { w: WizardCtx }) {
  return (
    <div>
      <h2 className="mb-3 text-lg font-bold text-white">Risk tolerance & budget</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.entries(w.meta.risk) as [typeof w.risk, (typeof w.meta.risk)[string]][]).map(([id, r]) => (
          <button
            key={id}
            onClick={() => w.setRisk(id)}
            className={`cursor-pointer rounded-xl border p-3 text-left transition-all ${
              w.risk === id ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'
            }`}
          >
            <div className="text-sm font-semibold text-white">{r.label}</div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{r.blurb}</p>
            <div className="mt-2 space-y-0.5 text-[10px] text-slate-400">
              <div>entry {r.positionPct}% · stop −{r.stopLossPct}%</div>
              <div>target +{r.takeProfitPct}%</div>
            </div>
          </button>
        ))}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Budget (USD)</span>
          <input className="input" type="number" min={w.minBudget} value={w.budget} onChange={(e) => w.setBudget(e.target.value)} />
          {w.strategy === 'dca' && (parseAmount(w.budget) ?? 0) <= w.dcaSlices && (
            <p className="mt-1 text-[11px] text-amber-300">Smart DCA splits the budget into {w.dcaSlices} slices — use at least ${w.dcaSlices + 1} so each clears $1.</p>
          )}
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Bot name (optional)</span>
          <input className="input" placeholder={`${w.token || 'COIN'} bot`} value={w.name} onChange={(e) => w.setName(e.target.value)} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-slate-400">Auto-sell profits to</span>
          <select className="input" value={w.sweepTo} onChange={(e) => w.setSweepTo(e.target.value as 'native' | 'usdt')}>
            <option value="native">Native coin ({w.net?.native.symbol ?? 'ETH'}) — default</option>
            <option value="usdt">USDT (stable) — profits & stop-sweeps land in dollars</option>
          </select>
        </label>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Tip: launch the same coin & strategy at two tolerances and compare their P&L side by side on the dashboard.
      </p>
    </div>
  )
}
