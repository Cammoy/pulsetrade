import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { useStore } from '../store'
import type { BacktestResult, RiskReport } from '../types'
import { fmtPct, fmtUsd, DAY_NAMES } from '../format'
import Sparkline from './Sparkline'
import WalletButton from './WalletButton'
import RiskReportPanel from './RiskReport'

const STEPS = ['Wallet', 'Network', 'Coin', 'Strategy', 'Risk & budget', 'Schedule & launch']

async function runBacktest(payload: object): Promise<BacktestResult> {
  const r = await fetch('/api/backtest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return r.json()
}

function BacktestCard({ bt }: { bt: BacktestResult }) {
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

export default function Wizard() {
  const { meta, openWizard, createBot, mode } = useStore()
  const { isConnected } = useAccount()
  const [step, setStep] = useState(0)
  const [network, setNetwork] = useState('base')
  const [token, setToken] = useState('')
  const [strategy, setStrategy] = useState('meanrev')
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

  const canNext = useMemo(() => {
    if (step === 1) return !!net
    if (step === 2) return !!tok
    if (step === 4) return Number(budget) >= 10
    if (step === 5) return always || days.length > 0
    return true
  }, [step, net, tok, budget, always, days])

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onClick={() => openWizard(false)}>
      <div className="glass w-full max-w-2xl border-white/10 bg-[#0b0f1a]/95 p-5" onClick={(e) => e.stopPropagation()}>
        {/* progress */}
        <div className="mb-5 flex items-center gap-1">
          {STEPS.map((s, i) => (
            <div key={s} className="flex flex-1 flex-col gap-1">
              <div className={`h-1 rounded-full ${i <= step ? 'bg-gradient-to-r from-indigo-500 to-cyan-400' : 'bg-white/10'}`} />
              <span className={`hidden text-[10px] sm:block ${i === step ? 'text-slate-300' : 'text-slate-600'}`}>{s}</span>
            </div>
          ))}
        </div>

        <div className="min-h-72">
          {step === 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-white">Welcome 👋 Let's set up a trading bot</h2>
              <p className="text-sm leading-relaxed text-slate-400">
                Connect a wallet to track balances and (later) trade live on-chain. You can also skip this —{' '}
                <strong className="text-slate-200">paper mode</strong> trades with real market data and simulated money, which is the
                recommended way to prove a strategy before risking funds.
              </p>
              <div className="flex items-center gap-3">
                <WalletButton />
                {isConnected && <span className="text-xs text-emerald-400">✓ wallet connected</span>}
              </div>
              <div className="rounded-xl bg-indigo-500/10 p-3 text-xs leading-relaxed text-indigo-200">
                Current engine mode: <strong className="uppercase">{mode}</strong>. Every profitable exit is automatically swept into the
                chain's native coin (ETH / BNB / POL) — the bot never leaves you holding an illiquid token.
              </div>
            </div>
          )}

          {step === 1 && (
            <div>
              <h2 className="mb-3 text-lg font-bold text-white">Pick a network</h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {meta.networks.filter((n) => n.tokens.length > 0).map((n) => (
                  <button
                    key={n.id}
                    onClick={() => setNetwork(n.id)}
                    className={`cursor-pointer rounded-xl border p-3 text-left transition-all ${
                      network === n.id ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'
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
          )}

          {step === 2 && (
            <div>
              <h2 className="mb-3 text-lg font-bold text-white">Pick a coin on {net?.name}</h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {net?.tokens.map((t) => (
                  <button
                    key={t.symbol}
                    onClick={() => setToken(t.symbol)}
                    className={`cursor-pointer rounded-xl border p-3 text-left transition-all ${
                      token === t.symbol ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'
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
          )}

          {step === 3 && (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-bold text-white">Choose a strategy</h2>
                <button
                  className="btn-ghost !py-1.5 text-xs"
                  disabled={comparing || !tok}
                  onClick={async () => {
                    if (!tok) return
                    setComparing(true)
                    const out: Record<string, BacktestResult> = {}
                    for (const s of meta.strategies) {
                      out[s.id] = await runBacktest({ network, tokenCg: tok.cg, strategy: s.id, risk, budgetUsd: Number(budget) || 1000 })
                    }
                    setCompare(out)
                    setComparing(false)
                  }}
                >
                  {comparing ? 'Backtesting…' : `📊 Backtest all on ${token || 'coin'}`}
                </button>
              </div>
              <div className="space-y-2">
                {meta.strategies.map((s) => {
                  const bt = compare?.[s.id]
                  return (
                    <button
                      key={s.id}
                      onClick={() => setStrategy(s.id)}
                      className={`w-full cursor-pointer rounded-xl border p-3 text-left transition-all ${
                        strategy === s.id ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'
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
          )}

          {step === 4 && (
            <div>
              <h2 className="mb-3 text-lg font-bold text-white">Risk tolerance & budget</h2>
              <div className="grid gap-2 sm:grid-cols-3">
                {(Object.entries(meta.risk) as [typeof risk, (typeof meta.risk)[string]][]).map(([id, r]) => (
                  <button
                    key={id}
                    onClick={() => setRisk(id)}
                    className={`cursor-pointer rounded-xl border p-3 text-left transition-all ${
                      risk === id ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'
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
                  <input className="input" type="number" min={10} value={budget} onChange={(e) => setBudget(e.target.value)} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-400">Bot name (optional)</span>
                  <input className="input" placeholder={`${token || 'COIN'} bot`} value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-xs font-medium text-slate-400">Auto-sell profits to</span>
                  <select className="input" value={sweepTo} onChange={(e) => setSweepTo(e.target.value as 'native' | 'usdt')}>
                    <option value="native">Native coin ({net?.native.symbol ?? 'ETH'}) — default</option>
                    <option value="usdt">USDT (stable) — profits & stop-sweeps land in dollars</option>
                  </select>
                </label>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                Tip: launch the same coin & strategy at two tolerances and compare their P&L side by side on the dashboard.
              </p>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-white">Trading hours & launch</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setAlways(!always)}
                  className={`relative h-6 w-11 cursor-pointer rounded-full transition-colors ${always ? 'bg-indigo-500' : 'bg-white/15'}`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${always ? 'left-5.5' : 'left-0.5'}`} />
                </button>
                <span className="text-sm text-slate-300">{always ? 'Trade 24/7' : 'Custom schedule'}</span>
              </div>
              {!always && (
                <div className="space-y-3 rounded-xl bg-white/[0.03] p-3">
                  <div className="flex flex-wrap gap-1.5">
                    {DAY_NAMES.map((d, i) => (
                      <button
                        key={d}
                        onClick={() => setDays((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort()))}
                        className={`chip cursor-pointer border transition-colors ${
                          days.includes(i) ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-200' : 'border-white/10 text-slate-500'
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-slate-400">
                    from
                    <select className="input !w-24" value={startHour} onChange={(e) => setStartHour(+e.target.value)}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>{h}:00</option>
                      ))}
                    </select>
                    to
                    <select className="input !w-24" value={endHour} onChange={(e) => setEndHour(+e.target.value)}>
                      {Array.from({ length: 25 }, (_, h) => (
                        <option key={h} value={h}>{h}:00</option>
                      ))}
                    </select>
                    <span className="text-[11px] text-slate-600">(overnight windows OK)</span>
                  </div>
                </div>
              )}

              <div className="rounded-xl bg-white/[0.03] p-3 text-xs text-slate-300">
                <span className="font-semibold text-white">{name || `${token} ${meta.strategies.find((s) => s.id === strategy)?.name} · ${meta.risk[risk].label}`}</span>
                {' — '}{token} on {net?.name}, {meta.strategies.find((s) => s.id === strategy)?.name}, {meta.risk[risk].label.toLowerCase()} risk, {fmtUsd(Number(budget) || 0)} budget,{' '}
                {always ? '24/7' : `${days.map((d) => DAY_NAMES[d]).join('/')} ${startHour}:00–${endHour}:00`} · {mode} mode
              </div>

              {finalBt ? <BacktestCard bt={finalBt} /> : <div className="text-xs text-slate-500">Running 30-day backtest of this exact configuration…</div>}
              {screen && (
                <div>
                  <RiskReportPanel report={screen} compact />
                  {!screen.tradeable && (
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
              {err && <div className="rounded-xl bg-rose-500/10 p-2.5 text-xs text-rose-300">{err}</div>}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-white/[0.06] pt-4">
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
