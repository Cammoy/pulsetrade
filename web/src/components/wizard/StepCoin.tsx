import type { WizardCtx } from './shared'

export default function StepCoin({ w }: { w: WizardCtx }) {
  return (
    <div>
      <h2 className="mb-3 text-lg font-bold text-white">Pick a coin on {w.net?.name}</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {w.net?.tokens.map((t) => (
          <button
            key={t.symbol}
            onClick={() => w.setToken(t.symbol)}
            className={`cursor-pointer rounded-xl border p-3 text-left transition-all ${
              w.token === t.symbol ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'
            }`}
          >
            <div className="text-sm font-semibold text-white">{t.symbol}</div>
            <div className="text-[11px] text-slate-500">{t.name}</div>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-slate-500">
        Curated, deep-liquidity tokens only — you can run several bots on the same coin with different tolerances.
      </p>
    </div>
  )
}
