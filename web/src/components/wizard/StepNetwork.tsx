import type { WizardCtx } from './shared'

export default function StepNetwork({ w }: { w: WizardCtx }) {
  return (
    <div>
      <h2 className="mb-3 text-lg font-bold text-white">Pick a network</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {w.meta.networks.filter((n) => n.tokens.length > 0 && n.tradeable !== false).map((n) => (
          <button
            key={n.id}
            onClick={() => w.setNetwork(n.id)}
            className={`cursor-pointer rounded-xl border p-3 text-left transition-all ${
              w.network === n.id ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full" style={{ background: n.color }} />
              <span className="text-sm font-semibold text-white">{n.name}</span>
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              ~${n.avgGasUsd.toFixed(2)}/swap · profits in {n.native.symbol}
            </div>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-slate-500">All five are among the cheapest liquid networks — gas never eats your edge.</p>
    </div>
  )
}
