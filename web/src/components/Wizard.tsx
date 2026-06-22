import { useEffect, useMemo, useState } from 'react'
import { useAccount } from '../wallet'
import { useStore } from '../store'
import type { BacktestResult, RiskReport } from '../types'
import { parseAmount } from '../format'
import { useModal } from '../useModal'
import { runBacktest, type WizardCtx } from './wizard/shared'
import StepWelcome from './wizard/StepWelcome'
import StepNetwork from './wizard/StepNetwork'
import StepCoin from './wizard/StepCoin'
import StepStrategy from './wizard/StepStrategy'
import StepRiskBudget from './wizard/StepRiskBudget'
import StepSchedule from './wizard/StepSchedule'

const STEPS = ['Wallet', 'Network', 'Coin', 'Strategy', 'Risk & budget', 'Schedule & launch']

export default function Wizard() {
  const { meta, openWizard, createBot, mode } = useStore()
  const { isConnected } = useAccount()
  const [step, setStep] = useState(0)
  const [network, setNetwork] = useState('base')
  const [token, setToken] = useState('')
  const [strategy, setStrategy] = useState('adaptive')
  const [risk, setRisk] = useState<'conservative' | 'balanced' | 'aggressive'>('balanced')
  const [budget, setBudget] = useState('1000')
  const [name, setName] = useState('')
  const [sweepTo, setSweepTo] = useState<'native' | 'usdt'>('native')
  const [always, setAlways] = useState(true)
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [startHour, setStartHour] = useState(8)
  const [endHour, setEndHour] = useState(22)
  const [compare, setCompare] = useState<Record<string, BacktestResult> | null>(null)
  const [comparing, setComparing] = useState(false)
  const [finalBt, setFinalBt] = useState<BacktestResult | null>(null)
  const [screen, setScreen] = useState<RiskReport | null>(null)
  const [launching, setLaunching] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useModal(() => openWizard(false))

  const net = meta?.networks.find((n) => n.id === network)
  const tok = net?.tokens.find((t) => t.symbol === token)

  useEffect(() => {
    setToken('')
    setCompare(null)
  }, [network])

  // Auto-backtest the final configuration AND run an advisory safety screen
  // when the review step opens.
  useEffect(() => {
    if (step !== 5 || !tok) return
    setFinalBt(null)
    setScreen(null)
    runBacktest({ network, tokenCg: tok.cg, strategy, risk, budgetUsd: Number(budget) }).then(setFinalBt)
    fetch(`/api/screen/${network}/${token}`)
      .then((r) => r.json())
      .then(setScreen)
      .catch(() => {})
  }, [step])

  // Smart DCA splits the budget into per-risk slices; the server rejects if each would
  // be ≤ $1 (dust), so the wizard must require budget > slices for a DCA bot. [audit]
  const dcaSlices = meta?.risk[risk]?.dcaSlices ?? 1
  const minBudget = strategy === 'dca' ? dcaSlices + 1 : 10
  const canNext = useMemo(() => {
    if (step === 1) return !!net
    if (step === 2) return !!tok
    if (step === 4) return (parseAmount(budget) ?? -1) >= minBudget
    // A custom schedule with equal start/end hours is rejected server-side — block it here.
    if (step === 5) return (always || days.length > 0) && !(!always && startHour === endHour)
    return true
  }, [step, net, tok, budget, minBudget, always, days, startHour, endHour])

  if (!meta) return null

  const launch = async () => {
    setLaunching(true)
    setErr(null)
    const out = await createBot({
      name: name || undefined,
      network,
      token,
      strategy,
      risk,
      budgetUsd: Number(budget),
      schedule: { enabled: !always, days, startHour, endHour },
      sweepTo,
    })
    setLaunching(false)
    if (out.error) return setErr(out.error)
    openWizard(false)
  }

  const w: WizardCtx = {
    meta, mode, isConnected, net, tok,
    network, setNetwork, token, setToken, strategy, setStrategy, risk, setRisk,
    budget, setBudget, name, setName, sweepTo, setSweepTo, always, setAlways,
    days, setDays, startHour, setStartHour, endHour, setEndHour,
    compare, setCompare, comparing, setComparing, finalBt, screen, err, dcaSlices, minBudget,
  }

  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-3" onClick={() => openWizard(false)}>
      <div className="glass animate-sheet pb-safe max-h-[94vh] w-full max-w-2xl overflow-auto !rounded-b-none border-white/10 bg-[var(--modal)] p-5 sm:!rounded-2xl" onClick={(e) => e.stopPropagation()}>
        {/* progress */}
        <div className="mb-5 flex items-center gap-1">
          {STEPS.map((s, i) => (
            <div key={s} className="flex flex-1 flex-col gap-1">
              <div className={`h-1 rounded-full ${i <= step ? 'bg-gradient-to-r from-indigo-500 to-cyan-400' : 'bg-[var(--border-strong)] dark:bg-white/10'}`} />
              <span className={`hidden text-[10px] sm:block ${i === step ? 'text-slate-300' : 'text-slate-600'}`}>{s}</span>
            </div>
          ))}
        </div>

        <div className="min-h-72">
          {step === 0 && <StepWelcome w={w} />}
          {step === 1 && <StepNetwork w={w} />}
          {step === 2 && <StepCoin w={w} />}
          {step === 3 && <StepStrategy w={w} />}
          {step === 4 && <StepRiskBudget w={w} />}
          {step === 5 && <StepSchedule w={w} />}
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-white/[0.08] pt-4">
          <button className="btn-ghost" onClick={() => (step === 0 ? openWizard(false) : setStep(step - 1))}>
            {step === 0 ? 'Cancel' : '← Back'}
          </button>
          {step < 5 ? (
            <button className="btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              Continue →
            </button>
          ) : (
            <button className="btn-primary" disabled={launching || !canNext} onClick={launch}>
              {launching ? 'Launching…' : '🚀 Launch bot'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
