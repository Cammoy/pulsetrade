import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { PoolCandidate, RiskReport } from '../types'
import { fmtUsd, fmtPct } from '../format'
import RiskReportPanel from './RiskReport'

const fmtLiq = (v: number | null) => (v === null ? '—' : v >= 1000 ? fmtUsd(v) : `$${v.toFixed(0)}`)
const fmtAge = (m: number | null) => (m === null ? '—' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`)

export default function Sniper() {
  const { meta, openSniper, mode, refresh } = useStore()
  const [network, setNetwork] = useState('base')
  const [feed, setFeed] = useState<'new' | 'trending'>('new')
  const [pools, setPools] = useState<PoolCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [feedErr, setFeedErr] = useState<string | null>(null)

  const [selected, setSelected] = useState<PoolCandidate | null>(null)
  const [report, setReport] = useState<RiskReport | null>(null)
  const [screening, setScreening] = useState(false)

  const [budget, setBudget] = useState('50')
  const [tp, setTp] = useState('50')
  const [sl, setSl] = useState('25')
  const [hold, setHold] = useState('30')
  const [trailing, setTrailing] = useState('')
  const [arming, setArming] = useState(false)
  const [armErr, setArmErr] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setFeedErr(null)
    try {
      const r = await fetch(`/api/sniper/pools?network=${network}&mode=${feed}`)
      const data = await r.json()
      if (data.error) setFeedErr(data.error)
      setPools(data.pools ?? [])
    } catch {
      setFeedErr('Discovery feed unreachable')
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    setSelected(null)
    setReport(null)
  }, [network, feed])

  const select = async (p: PoolCandidate) => {
    setSelected(p)
    setReport(null)
    setArmErr(null)
    setScreening(true)
    try {
      const r = await fetch('/api/screen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network: p.network, address: p.tokenAddress, symbol: p.tokenSymbol }),
      })
      setReport(await r.json())
    } catch {
      setArmErr('Screening failed — cannot snipe without a safety check')
    }
    setScreening(false)
  }

  const arm = async () => {
    if (!selected) return
    setArming(true)
    setArmErr(null)
    try {
      const r = await fetch('/api/sniper', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          network: selected.network,
          poolAddress: selected.poolAddress,
          tokenAddress: selected.tokenAddress,
          tokenSymbol: selected.tokenSymbol,
          tokenName: selected.tokenName,
          budgetUsd: Number(budget),
          sniper: {
            takeProfitPct: Number(tp),
            stopLossPct: Number(sl),
            maxHoldMin: Number(hold),
            ...(trailing ? { trailingPct: Number(trailing) } : {}),
          },
        }),
      })
      const data = await r.json()
      if (data.error) {
        setArmErr(data.error)
        if (data.riskReport) setReport(data.riskReport)
      } else {
        await refresh()
        openSniper(false)
      }
    } catch {
      setArmErr('Engine unreachable')
    }
    setArming(false)
  }

  if (!meta) return null
  const canArm = report?.tradeable && Number(budget) >= 10 && Number(tp) > 0 && Number(sl) > 0 && Number(hold) > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onClick={() => openSniper(false)}>
      <div className="glass flex max-h-[92vh] w-full max-w-4xl flex-col border-white/10 bg-[#0b0f1a]/95 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">🎯 Sniper</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Catch freshly launched tokens. Every pick is <strong className="text-slate-200">automatically screened for honeypots, non-sellable
              contracts and rug-pull setups</strong> before you can snipe — unsafe tokens are blocked outright.
            </p>
          </div>
          <button className="btn-ghost !px-2.5 !py-1" onClick={() => openSniper(false)}>✕</button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select className="input !w-36 !py-1.5 text-xs" value={network} onChange={(e) => setNetwork(e.target.value)}>
            {meta.networks.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </select>
          <div className="flex items-center rounded-xl border border-white/10 bg-white/[0.03] p-0.5 text-xs">
            {(['new', 'trending'] as const).map((f) => (
              <button key={f} onClick={() => setFeed(f)} className={`cursor-pointer rounded-lg px-3 py-1 font-medium capitalize ${feed === f ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}>
                {f === 'new' ? '🆕 New pools' : '🔥 Trending'}
              </button>
            ))}
          </div>
          <button className="btn-ghost !py-1.5 text-xs" onClick={load} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button>
          <span className="text-[11px] text-slate-600">{mode} mode</span>
        </div>

        <div className="mt-3 grid flex-1 grid-cols-1 gap-3 overflow-hidden md:grid-cols-2">
          {/* Pool feed */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/[0.06]">
            <div className="border-b border-white/[0.06] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {feed === 'new' ? 'Newest pools' : 'Trending pools'} {pools.length ? `· ${pools.length}` : ''}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {feedErr && <div className="p-3 text-xs text-amber-400">{feedErr}</div>}
              {!feedErr && pools.length === 0 && !loading && <div className="p-3 text-xs text-slate-600">No pools found right now.</div>}
              {pools.map((p) => (
                <button
                  key={p.poolAddress}
                  onClick={() => select(p)}
                  className={`flex w-full items-center justify-between gap-2 border-b border-white/[0.04] px-3 py-2 text-left transition-colors hover:bg-white/[0.03] ${selected?.poolAddress === p.poolAddress ? 'bg-indigo-500/10' : ''}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-white">{p.tokenSymbol}</span>
                      {p.ageMinutes !== null && p.ageMinutes < 15 && <span className="chip bg-emerald-500/15 text-emerald-300">fresh</span>}
                    </div>
                    <div className="truncate text-[11px] text-slate-500">{p.tokenName}</div>
                  </div>
                  <div className="shrink-0 text-right text-[11px]">
                    <div className="text-slate-300">{fmtLiq(p.liquidityUsd)} liq</div>
                    <div className="text-slate-500">
                      {fmtAge(p.ageMinutes)}
                      {p.priceChange1hPct !== null && <span className={p.priceChange1hPct >= 0 ? ' text-emerald-400' : ' text-rose-400'}> · {fmtPct(p.priceChange1hPct)}</span>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Screen + arm */}
          <div className="flex min-h-0 flex-col overflow-auto rounded-xl border border-white/[0.06] p-3">
            {!selected && <div className="flex h-full items-center justify-center text-center text-xs text-slate-600">Select a pool to run its safety screen.</div>}
            {selected && (
              <>
                <div className="mb-2">
                  <div className="text-sm font-semibold text-white">{selected.tokenSymbol} <span className="text-slate-500">· {selected.tokenName}</span></div>
                  <div className="font-mono text-[10px] break-all text-slate-600">{selected.tokenAddress}</div>
                </div>

                {screening && <div className="animate-pulse rounded-xl bg-white/[0.03] p-4 text-center text-xs text-slate-500">🛡️ Screening for honeypots, sell-blocks & rug setups…</div>}
                {report && <RiskReportPanel report={report} />}

                {report?.tradeable && (
                  <div className="mt-3 space-y-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Snipe settings</div>
                    <label className="block">
                      <span className="text-[11px] text-slate-400">Budget (USD)</span>
                      <input className="input !py-1.5 text-xs" type="number" min={10} value={budget} onChange={(e) => setBudget(e.target.value)} />
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="block">
                        <span className="text-[11px] text-slate-400">Take-profit %</span>
                        <input className="input !py-1.5 text-xs" type="number" value={tp} onChange={(e) => setTp(e.target.value)} />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-400">Stop-loss %</span>
                        <input className="input !py-1.5 text-xs" type="number" value={sl} onChange={(e) => setSl(e.target.value)} />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-400">Max hold (min)</span>
                        <input className="input !py-1.5 text-xs" type="number" value={hold} onChange={(e) => setHold(e.target.value)} />
                      </label>
                    </div>
                    <label className="block">
                      <span className="text-[11px] text-slate-400">Trailing stop % from peak (optional)</span>
                      <input className="input !py-1.5 text-xs" type="number" placeholder="off" value={trailing} onChange={(e) => setTrailing(e.target.value)} />
                    </label>
                  </div>
                )}

                {armErr && <div className="mt-2 rounded-xl bg-rose-500/10 p-2.5 text-xs text-rose-300">{armErr}</div>}

                <button className="btn-primary mt-3" disabled={!canArm || arming} onClick={arm}>
                  {arming ? 'Arming…' : report?.tradeable ? `🎯 Snipe ${selected.tokenSymbol} with ${fmtUsd(Number(budget) || 0)}` : '⛔ Token blocked by safety screen'}
                </button>
                <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
                  Sniping buys immediately, then auto-exits on the first of take-profit, stop-loss, trailing stop, or max-hold — sweeping
                  proceeds to the native coin. New tokens are extremely volatile; the screen reduces but cannot eliminate risk. {mode === 'live' ? 'LIVE mode will execute on-chain.' : 'Paper mode simulates the fill.'}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
