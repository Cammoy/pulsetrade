import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { WalletProfile } from '../types'
import { fmtUsd, fmtSign, pnlColor, timeAgo } from '../format'
import Sparkline from './Sparkline'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * Per-wallet smart-money account view: net-flow chart, per-token flows, recent
 * trades, and the controls to trade WITH this wallet — manually (one token) or
 * automatically (a budget that mirrors every buy it makes).
 */
export default function WalletAccount({ address, onClose }: { address: string; onClose: () => void }) {
  const { meta, follows, refresh } = useStore()
  const [profile, setProfile] = useState<WalletProfile | null>(null)
  const [loading, setLoading] = useState(true)

  // auto-follow form
  const [budget, setBudget] = useState('300')
  const [perTrade, setPerTrade] = useState('100')
  const [risk, setRisk] = useState('balanced')
  const [sweepTo, setSweepTo] = useState<'native' | 'usdt'>('native')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/smart-money/wallet/${address}`)
      setProfile(await r.json())
    } catch { /* ignore */ }
    setLoading(false)
  }
  useEffect(() => { load() }, [address])

  const existingFollow = follows.find((f) => f.walletAddress.toLowerCase() === address.toLowerCase() && f.enabled)

  const startFollow = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/follows', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, label: profile?.label, totalBudgetUsd: Number(budget), perTradeUsd: Number(perTrade), risk, sweepTo }),
      })
      const data = await r.json()
      if (data.error) setErr(data.error)
      else await refresh()
    } catch { setErr('Engine unreachable') }
    setBusy(false)
  }
  const stopFollow = async (id: string, liquidate: boolean) => { await fetch(`/api/follows/${id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ liquidate }) }); await refresh() }
  const deleteFollow = async (id: string) => { await fetch(`/api/follows/${id}`, { method: 'DELETE' }); await refresh() }

  if (!meta) return null
  const s = profile?.stats
  const maxConcurrent = Math.max(1, Math.floor((Number(budget) || 0) / (Number(perTrade) || 1)))

  return (
    <div className="space-y-3">
      <button className="text-xs text-indigo-300 hover:underline" onClick={onClose}>← back to accounts</button>

      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-base font-bold text-white">{profile?.label ?? short(address)}</div>
          <div className="font-mono text-[10px] text-slate-600">{address}</div>
        </div>
        {!profile?.tracking && (
          <span className="chip bg-amber-500/10 text-amber-300">needs ETHERSCAN_API_KEY for live data</span>
        )}
      </div>

      {loading && <div className="py-8 text-center text-xs text-slate-500">Loading on-chain activity across all chains…</div>}

      {!loading && s && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { l: 'Trades', v: String(s.trades), c: 'text-white' },
              { l: 'Buys / Sells', v: `${s.buys} / ${s.sells}`, c: 'text-slate-200' },
              { l: 'Volume', v: fmtUsd(s.volumeUsd), c: 'text-slate-200' },
              { l: 'Net flow', v: fmtSign(s.netFlowUsd), c: pnlColor(s.netFlowUsd) },
            ].map((x) => (
              <div key={x.l} className="rounded-xl bg-white/[0.03] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{x.l}</div>
                <div className={`text-sm font-bold tabular-nums ${x.c}`}>{x.v}</div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-white/[0.06] p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">Cumulative net flow (curated tokens)</span>
              {s.lastTs && <span className="text-[10px] text-slate-500">last activity {timeAgo(s.lastTs)}</span>}
            </div>
            {s.series.length >= 2
              ? <Sparkline points={s.series.map((p) => p.v)} baseline={0} width={620} height={70} />
              : <div className="py-4 text-center text-[11px] text-slate-600">{profile?.tracking ? 'No curated-token activity recorded for this wallet yet.' : 'Enable tracking to chart this account.'}</div>}
          </div>

          {s.tokens.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-white/[0.06]">
              <table className="w-full text-xs">
                <thead className="bg-white/[0.02] text-left text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>{['Token', 'Net', 'Buys', 'Sells', 'Volume', 'Last', ''].map((h) => <th key={h} className="px-3 py-1.5 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {s.tokens.map((t) => (
                    <tr key={`${t.network}:${t.token}`} className="border-t border-white/[0.04] tabular-nums">
                      <td className="px-3 py-1.5 font-medium text-slate-200">{t.token} <span className="text-slate-600">· {t.network}</span></td>
                      <td className={`px-3 py-1.5 ${pnlColor(t.netFlowUsd)}`}>{fmtSign(t.netFlowUsd)}</td>
                      <td className="px-3 py-1.5 text-emerald-300/80">{t.buys}</td>
                      <td className="px-3 py-1.5 text-rose-300/80">{t.sells}</td>
                      <td className="px-3 py-1.5 text-slate-400">{fmtUsd(t.volumeUsd)}</td>
                      <td className="px-3 py-1.5 text-slate-500">{timeAgo(t.lastTs)}</td>
                      <td className="px-3 py-1.5">
                        <button className="btn-ghost !px-2 !py-0.5 text-[10px]" onClick={() => useStore.setState({ smartMoneyOpen: true })} title="Use the Copy button on the Activity tab for one-token manual copy">🐋</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Auto-follow controls */}
      {existingFollow ? (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/[0.06] p-3">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400 pulse-dot" />
            <span className="text-sm font-bold text-emerald-200">Auto-following this wallet</span>
            <span className="ml-auto text-[11px] text-slate-400">{fmtUsd(existingFollow.totalBudgetUsd)} budget · {fmtUsd(existingFollow.perTradeUsd)}/trade</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { l: 'Total P&L', v: fmtSign(existingFollow.stats.realizedUsd), c: pnlColor(existingFollow.stats.realizedUsd) },
              { l: 'Active mirrors', v: `${existingFollow.stats.active}/${existingFollow.maxConcurrent}`, c: 'text-white' },
              { l: 'Idle budget', v: fmtUsd(existingFollow.poolUsd), c: 'text-slate-200' },
              { l: 'W / L', v: `${existingFollow.stats.wins} / ${existingFollow.stats.losses}`, c: 'text-slate-200' },
            ].map((x) => (
              <div key={x.l} className="rounded-lg bg-white/[0.03] px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{x.l}</div>
                <div className={`text-sm font-bold tabular-nums ${x.c}`}>{x.v}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button className="btn-ghost flex-1 !py-1.5 text-xs" onClick={() => stopFollow(existingFollow.id, false)}>⏸ Stop following</button>
            <button className="btn-ghost flex-1 !py-1.5 text-xs text-amber-300" onClick={() => { if (confirm('Stop and sell all open mirror positions?')) stopFollow(existingFollow.id, true) }}>⏹ Stop & liquidate</button>
            <button className="btn-ghost !py-1.5 text-xs text-rose-300" onClick={() => { if (confirm('Delete this follow and all its mirror bots?')) deleteFollow(existingFollow.id) }}>🗑</button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-indigo-400/30 bg-indigo-500/[0.06] p-3">
          <div className="text-sm font-bold text-indigo-200">🤖 Trade automatically with this wallet</div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            Give it a budget. Whenever this wallet buys a curated token, a mirror bot enters with your per-trade size and exits when the wallet sells (plus your risk-tier stops). Returns recycle into the next mirror.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Budget ($)</span><input className="input !py-1.5 text-xs" type="number" min={10} value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Per trade ($)</span><input className="input !py-1.5 text-xs" type="number" min={10} value={perTrade} onChange={(e) => setPerTrade(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Risk</span>
              <select className="input !py-1.5 text-xs" value={risk} onChange={(e) => setRisk(e.target.value)}>{Object.keys(meta.risk).map((r) => <option key={r} value={r}>{meta.risk[r].label}</option>)}</select>
            </label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Profits to</span>
              <select className="input !py-1.5 text-xs" value={sweepTo} onChange={(e) => setSweepTo(e.target.value as 'native' | 'usdt')}><option value="native">Native</option><option value="usdt">USDT</option></select>
            </label>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">Up to <strong className="text-slate-200">{maxConcurrent}</strong> concurrent mirrors of {fmtUsd(Number(perTrade) || 0)} each.</p>
          {err && <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}
          <button className="btn-primary mt-2 w-full" disabled={busy || Number(budget) < 10} onClick={startFollow}>{busy ? 'Starting…' : `🤖 Auto-follow with ${fmtUsd(Number(budget) || 0)}`}</button>
        </div>
      )}
    </div>
  )
}
