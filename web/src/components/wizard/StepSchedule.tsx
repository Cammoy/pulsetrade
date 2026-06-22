import { fmtUsd, DAY_NAMES } from '../../format'
import { BacktestCard, type WizardCtx } from './shared'
import RiskReportPanel from '../RiskReport'

export default function StepSchedule({ w }: { w: WizardCtx }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-white">Trading hours & launch</h2>
      <div className="flex items-center gap-3">
        <button
          onClick={() => w.setAlways(!w.always)}
          className={`relative h-6 w-11 cursor-pointer rounded-full transition-colors ${w.always ? 'bg-indigo-500' : 'bg-[var(--border-strong)] dark:bg-white/15'}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${w.always ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
        <span className="text-sm text-slate-300">{w.always ? 'Trade 24/7' : 'Custom schedule'}</span>
      </div>
      {!w.always && (
        <div className="space-y-3 rounded-xl bg-white/[0.03] p-3">
          <div className="flex flex-wrap gap-1.5">
            {DAY_NAMES.map((d, i) => (
              <button
                key={d}
                onClick={() => w.setDays((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort()))}
                className={`chip cursor-pointer border transition-colors ${
                  w.days.includes(i) ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-200' : 'border-white/10 text-slate-500'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 gap-y-2 text-sm text-slate-400">
            from
            <select className="input !w-24" value={w.startHour} onChange={(e) => w.setStartHour(+e.target.value)}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{h}:00</option>
              ))}
            </select>
            to
            <select className="input !w-24" value={w.endHour} onChange={(e) => w.setEndHour(+e.target.value)}>
              {Array.from({ length: 25 }, (_, h) => (
                <option key={h} value={h}>{h}:00</option>
              ))}
            </select>
            <span className="text-[11px] text-slate-600">(overnight windows OK)</span>
          </div>
          {w.startHour === w.endHour && (
            <p className="text-[11px] text-amber-300">⚠ Start and end can't be the same hour — pick different times, or switch to 24/7.</p>
          )}
        </div>
      )}

      <div className="rounded-xl bg-white/[0.03] p-3 text-xs text-slate-300">
        <span className="font-semibold text-white">{w.name || `${w.token} ${w.meta.strategies.find((s) => s.id === w.strategy)?.name} · ${w.meta.risk[w.risk].label}`}</span>
        {' — '}{w.token} on {w.net?.name}, {w.meta.strategies.find((s) => s.id === w.strategy)?.name}, {w.meta.risk[w.risk].label.toLowerCase()} risk, {fmtUsd(Number(w.budget) || 0)} budget,{' '}
        {w.always ? '24/7' : `${w.days.map((d) => DAY_NAMES[d]).join('/')} ${w.startHour}:00–${w.endHour}:00`} · {w.mode} mode
      </div>

      {w.finalBt ? <BacktestCard bt={w.finalBt} /> : <div className="text-xs text-slate-500">Running 30-day backtest of this exact configuration…</div>}
      {w.screen && (
        <div>
          <RiskReportPanel report={w.screen} compact />
          {!w.screen.tradeable && (
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              This is a curated, deep-liquidity token — canonical bridged assets can show mint/LP flags, so this screen is advisory
              here and does not block. (The Sniper applies it as a hard block on unknown tokens.)
            </p>
          )}
        </div>
      )}
      <p className="text-[10px] leading-relaxed text-slate-600">
        Backtests use real historical prices with fees and slippage, but past performance never guarantees future results. Crypto is
        volatile — trade only what you can afford to lose.
      </p>
      {w.err && <div className="rounded-xl bg-rose-500/10 p-2.5 text-xs text-rose-300">{w.err}</div>}
    </div>
  )
}
