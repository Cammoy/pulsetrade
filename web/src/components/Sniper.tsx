import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { SafePool, RiskReport } from '../types'
import { fmtUsd, fmtPct } from '../format'
import RiskReportPanel from './RiskReport'
import AutoSniperPanel from './AutoSniper'

const fmtLiq = (v: number | null) => (v === null ? '—' : v >= 1000 ? fmtUsd(v) : `$${v.toFixed(0)}`)
const fmtAge = (m: number | null) => (m === null ? '—' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`)

export default function Sniper() {
  const { meta, openSniper, mode, refresh, autoSniper } = useStore()
  const [tab, setTab] = useState<'manual' | 'auto'>('manual')
  const [network, setNetwork] = useState('base')
  const [feed, setFeed] = useState<'new' | 'trending'>('new')
  const [pools, setPools] = useState<SafePool[]>([])
  const [scanned, setScanned] = useState(0)
  const [loading, setLoading] = useState(false)
  const [feedErr, setFeedErr] = useState<string | null>(null)

  const [selected, setSelected] = useState<SafePool | null>(null)
  const [budget, setBudget] = useState('50')
  const [tp, setTp] = useState('50')
  const [sl, setSl] = useState('25')
  const [hold, setHold] = useState('30')
  const [trailing, setTrailing] = useState('')
  const [sweepTo, setSweepTo] = useState<'native' | 'usdt'>('native')
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
      setScanned(data.scanned ?? 0)
    } catch {
      setFeedErr('Discovery feed unreachable')
    }
    setLoading(false)
  }

  useEffect(() => {
    if (tab === 'manual') load()
    setSelected(null)
  }, [network, feed, tab])

  const report: RiskReport | null = selected?.report ?? null

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
          sweepTo,
          sniper: {
            takeProfitPct: Number(tp),
            stopLossPct: Number(sl),
            maxHoldMin: Number(hold),
            ...(trailing ? { trailingPct: Number(trailing) } : {}),
          },
        }),
      })
      const data = await r.json()
      if (data.error) setArmErr(data.error)
      else {
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
              Only <strong className="text-emerald-300">safe coins</strong> are shown — each is <strong className="text-slate-200">verified,
              proven sellable, and held by many distinct wallets</strong> (no whale dominance). Everything else is filtered out before you
              ever see it.
            </p>
          </div>
          <button className="btn-ghost !px-2.5 !py-1" onClick={() => openSniper(false)}>✕</button>
        </div>

        <div className="mt-3 flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-0.5 text-xs">
          {(['manual', 'auto'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 cursor-pointer rounded-lg px-3 py-1.5 font-semibold transition-colors ${tab === t ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {t === 'manual' ? '🎯 Pick a coin' : '🤖 Auto-Sniper'}
              {t === 'auto' && autoSniper?.enabled && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle" />}
            </button>
          ))}
        </div>

        {tab === 'auto' ? (
          <AutoSniperPanel />
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select className="input !w-36 !py-1.5 text-xs" value={network} onChange={(e) => setNetwork(e.target.value)}>
                {meta.networks.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
              <div className="flex items-center rounded-xl border border-white/10 bg-white/[0.03] p-0.5 text-xs">
                {(['new', 'trending'] as const).map((f) => (
                  <button key={f} onClick={() => setFeed(f)} className={`cursor-pointer rounded-lg px-3 py-1 font-medium capitalize ${feed === f ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}>
                    {f === 'new' ? '🆕 New' : '🔥 Trending'}
                  </button>
                ))}
              </div>
              <button className="btn-ghost !py-1.5 text-xs" onClick={load} disabled={loading}>{loading ? 'Screening…' : '↻ Rescan'}</button>
              {scanned > 0 && <span className="text-[11px] text-slate-600">{pools.length} safe of {scanned} scanned</span>}
            </div>

            <div className="mt-3 grid flex-1 grid-cols-1 gap-3 overflow-hidden md:grid-cols-2">
              {/* Safe pool feed */}
              <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/[0.06]">
                <div className="border-b border-white/[0.06] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-400/80">
                  🛡️ Safe coins only
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {loading && <div className="p-3 text-xs text-slate-500">Screening fresh pools for honeypots, sell-blocks & whale dominance…</div>}
                  {feedErr && <div className="p-3 text-xs text-amber-400">{feedErr}</div>}
                  {!loading && !feedErr && pools.length === 0 && (
                    <div className="p-4 text-xs leading-relaxed text-slate-500">
                      No coins pass the safety gate right now — that’s normal; most new launches are unsafe. Try Trending, switch network, or rescan in a minute.
                    </div>
                  )}
                  {pools.map((p) => (
                    <button
                      key={p.poolAddress}
                      onClick={() => setSelected(p)}
                      className={`flex w-full items-center justify-between gap-2 border-b border-white/[0.04] px-3 py-2 text-left transition-colors hover:bg-white/[0.03] ${selected?.poolAddress === p.poolAddress ? 'bg-indigo-500/10' : ''}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-white">{p.tokenSymbol}</span>
                          <span className="chip bg-emerald-500/15 text-emerald-300">🛡️ {p.report.score}</span>
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

              {/* Detail + arm */}
              <div className="flex min-h-0 flex-col overflow-auto rounded-xl border border-white/[0.06] p-3">
                {!selected && <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-600">Select a safe coin to review its full screen and snipe it.</div>}
                {selected && report && (
                  <>
                    <div className="mb-2">
                      <div className="text-sm font-semibold text-white">{selected.tokenSymbol} <span className="text-slate-500">· {selected.tokenName}</span></div>
                      <div className="font-mono text-[10px] break-all text-slate-600">{selected.tokenAddress}</div>
                    </div>
                    <RiskReportPanel report={report} />

                    <div className="mt-3 space-y-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Snipe settings</div>
                      <label className="block">
                        <span className="text-[11px] text-slate-400">Budget (USD)</span>
                        <input className="input !py-1.5 text-xs" type="number" min={10} value={budget} onChange={(e) => setBudget(e.target.value)} />
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        <label className="block"><span className="text-[11px] text-slate-400">Take-profit %</span><input className="input !py-1.5 text-xs" type="number" value={tp} onChange={(e) => setTp(e.target.value)} /></label>
                        <label className="block"><span className="text-[11px] text-slate-400">Stop-loss %</span><input className="input !py-1.5 text-xs" type="number" value={sl} onChange={(e) => setSl(e.target.value)} /></label>
                        <label className="block"><span className="text-[11px] text-slate-400">Max hold (min)</span><input className="input !py-1.5 text-xs" type="number" value={hold} onChange={(e) => setHold(e.target.value)} /></label>
                      </div>
                      <label className="block"><span className="text-[11px] text-slate-400">Trailing stop % from peak (optional)</span><input className="input !py-1.5 text-xs" type="number" placeholder="off" value={trailing} onChange={(e) => setTrailing(e.target.value)} /></label>
                      <label className="block"><span className="text-[11px] text-slate-400">Auto-sell proceeds to</span>
                        <select className="input !py-1.5 text-xs" value={sweepTo} onChange={(e) => setSweepTo(e.target.value as 'native' | 'usdt')}>
                          <option value="native">Native coin</option>
                          <option value="usdt">USDT (stable)</option>
                        </select>
                      </label>
                    </div>

                    {armErr && <div className="mt-2 rounded-xl bg-rose-500/10 p-2.5 text-xs text-rose-300">{armErr}</div>}
                    <button className="btn-primary mt-3" disabled={!canArm || arming} onClick={arm}>
                      {arming ? 'Arming…' : `🎯 Snipe ${selected.tokenSymbol} with ${fmtUsd(Number(budget) || 0)}`}
                    </button>
                    <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
                      Buys immediately, then auto-exits on take-profit, stop-loss, trailing stop or max-hold — sweeping proceeds to the native coin.
                      Even screened tokens are volatile; size small. {mode === 'live' ? 'LIVE mode executes on-chain.' : 'Paper mode simulates the fill.'}
                    </p>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
