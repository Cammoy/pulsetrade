import type { Dispatch, SetStateAction } from 'react'
import type { BacktestResult, RiskReport, Meta, Network, Token } from '../../types'
import { fmtPct, fmtUsd } from '../../format'
import Sparkline from '../Sparkline'

export type RiskId = 'conservative' | 'balanced' | 'aggressive'

/**
 * All wizard state + setters + derived values, passed as one `w` prop to each step.
 * The six steps share ~18 fields, so a single bag beats drilling 18 individual props
 * (and beats a context here — the provider/consumer churn isn't worth it for a modal).
 * Wizard.tsx owns the useState; the steps are purely presentational.
 */
export interface WizardCtx {
  meta: Meta
  mode: 'paper' | 'live'
  isConnected: boolean
  net: Network | undefined
  tok: Token | undefined
  network: string
  setNetwork: (v: string) => void
  token: string
  setToken: (v: string) => void
  strategy: string
  setStrategy: (v: string) => void
  risk: RiskId
  setRisk: (v: RiskId) => void
  budget: string
  setBudget: (v: string) => void
  name: string
  setName: (v: string) => void
  sweepTo: 'native' | 'usdt'
  setSweepTo: (v: 'native' | 'usdt') => void
  always: boolean
  setAlways: (v: boolean) => void
  days: number[]
  setDays: Dispatch<SetStateAction<number[]>>
  startHour: number
  setStartHour: (v: number) => void
  endHour: number
  setEndHour: (v: number) => void
  compare: Record<string, BacktestResult> | null
  setCompare: (v: Record<string, BacktestResult> | null) => void
  comparing: boolean
  setComparing: (v: boolean) => void
  finalBt: BacktestResult | null
  screen: RiskReport | null
  err: string | null
  dcaSlices: number
  minBudget: number
}

export async function runBacktest(payload: object): Promise<BacktestResult> {
  const r = await fetch('/api/backtest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return r.json()
}

export function BacktestCard({ bt }: { bt: BacktestResult }) {
  if (bt.error) return <div className="rounded-xl bg-amber-500/10 p-3 text-xs text-amber-300">⚠ {bt.error}</div>
  const winRate = bt.wins + bt.losses > 0 ? ((bt.wins / (bt.wins + bt.losses)) * 100).toFixed(0) : '—'
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-300">Backtest · last {bt.days} days · real market data</div>
        <Sparkline points={bt.equity.map((e) => e.v)} width={120} height={32} baseline={bt.equity[0]?.v} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
        {[
          { l: 'Strategy', v: fmtPct(bt.returnPct), c: bt.returnPct >= 0 ? 'text-emerald-400' : 'text-rose-400' },
          { l: 'Buy & hold', v: fmtPct(bt.buyHoldPct), c: 'text-slate-300' },
          { l: 'Trades', v: String(bt.trades), c: 'text-slate-300' },
          { l: 'Win rate', v: `${winRate}%`, c: 'text-slate-300' },
          { l: 'Max DD', v: `−${bt.maxDrawdownPct}%`, c: 'text-amber-300' },
          { l: 'Fees', v: fmtUsd(bt.feesUsd), c: 'text-slate-400' },
        ].map((s) => (
          <div key={s.l} className="rounded-lg bg-white/[0.03] px-1 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-slate-500">{s.l}</div>
            <div className={`text-xs font-bold tabular-nums ${s.c}`}>{s.v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
