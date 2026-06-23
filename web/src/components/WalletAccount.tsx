import { useEffect, useState } from 'react'
import { useStore, jpost } from '../store'
import type { WalletProfile } from '../types'
import { fmtUsd, fmtSign, pnlColor, timeAgo, parseAmount } from '../format'
import { useModal } from '../useModal'
import Sparkline from './Sparkline'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * Per-wallet smart-money account view: net-flow chart, per-token flows, recent
 * trades, and the controls to trade WITH this wallet — manually (one token) or
 * automatically (a budget that mirrors every buy it makes).
 */
export default function WalletAccount({ address, onClose }: { address: string; onClose: () => void }) {
  const { meta, follows, refresh, confirm, notify } = useStore()
  const [profile, setProfile] = useState<WalletProfile | null>(null)
  const [loading, setLoading] = useState(true)

  // auto-follow form
  const [budget, setBudget] = useState('300')
  const [perTrade, setPerTrade] = useState('100')
  const [risk, setRisk] = useState('balanced')
  const [sweepTo, setSweepTo] = useState<'native' | 'usdt'>('native')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useModal(onClose)

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

  const budgetNum = parseAmount(budget)
  const perTradeNum = parseAmount(perTrade)
  const startFollow = async () => {
    if (budgetNum === null || perTradeNum === null) { setErr('Enter valid amounts'); return }
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/follows', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, label: profile?.label, totalBudgetUsd: budgetNum, perTradeUsd: perTradeNum, risk, sweepTo }),
      })
      const data = await r.json()
      if (data.error) setErr(data.error)
      else await refresh()
    } catch { setErr('Engine unreachable') }
    setBusy(false)
  }
  // Money-moving (stop & liquidate sells real positions) — surface any server error instead
  // of swallowing it; always refresh so the UI reflects the true server state on failure.
  const stopFollow = async (id: string, liquidate: boolean) => {
    const out = await jpost<{ error?: string }>(`/api/follows/${id}/stop`, { liquidate })
    if (out.error) notify(out.error, 'error')
    await refresh()
  }
  const deleteFollow = async (id: string) => {
    const out = await jpost<{ error?: string }>(`/api/follows/${id}`, undefined, 'DELETE')
    if (out.error) notify(out.error, 'error')
    await refresh()
  }

  if (!meta) return null
  const s = profile?.stats
  const maxConcurrent = Math.max(1, Math.floor((budgetNum ?? 0) / (perTradeNum || 1)))

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

      {profile?.note && (
        <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/[0.05] px-3 py-2 text-xs text-indigo-100">
          {profile.category && <span className="chip mr-2 bg-white/[0.08] capitalize text-slate-300">{profile.category.replace('-', ' ')}</span>}
          {profile.note}
        </div>
      )}

      {profile?.score && profile.score.tier !== 'thin' && (
        <div
          className={`rounded-xl border px-3 py-2 text-[11px] leading-relaxed ${
            profile.score.tier === 'proven'
              ? 'border-emerald-400/30 bg-emerald-500/[0.06] text-emerald-300'
              : profile.score.tier === 'promising'
                ? 'border-sky-400/30 bg-sky-500/[0.06] text-sky-300'
                : 'border-white/[0.08] bg-white/[0.02] text-slate-400'
          }`}
          title={profile.score.caveat}
        >
          <span className="font-semibold uppercase tracking-wide">Copy-worthiness {profile.score.score}/100 · {profile.score.tier}</span>{' '}
          — {profile.score.roundTrips} closed position{profile.score.roundTrips === 1 ? '' : 's'}, {fmtSign(profile.score.realizedFlowUsd)} net realized flow
          {profile.score.recencyDays != null ? `, last active ${Math.round(profile.score.recencyDays)}d ago` : ''}.
          <span className="mt-1 block text-[10px] opacity-80">Flow heuristic from on-chain transfers, not verified PnL — hover for the caveat. Copy-trading is only as good as the wallet you mirror.</span>
        </div>
      )}

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

          <div className="rounded-xl border border-white/[0.08] p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">Cumulative net flow (curated tokens)</span>
              {s.lastTs && <span className="text-[10px] text-slate-500">last activity {timeAgo(s.lastTs)}</span>}
            </div>
            {s.series.length >= 2
              ? <div className="max-w-full overflow-hidden"><Sparkline points={s.series.map((p) => p.v)} baseline={0} width={320} height={70} /></div>
              : <div className="py-4 text-center text-[11px] text-slate-600">{profile?.tracking ? 'No curated-token activity recorded for this wallet yet.' : 'Enable tracking to chart this account.'}</div>}
          </div>

          {/* ── Comprehensive holdings (all tokens, est. from on-chain activity) ── */}
          {profile?.holdings && profile.holdings.some((h) => !h.suspicious) && (() => {
            const real = profile.holdings.filter((h) => !h.suspicious)
            const spamCount = profile.holdings.length - real.length
            const priced = real.filter((h) => h.usd !== null && h.usd > 0)
            const totalUsd = priced.reduce((sum, h) => sum + (h.usd ?? 0), 0)
            const COLORS = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f43f5e']
            return (
              <div className="rounded-xl border border-white/[0.08] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">💼 Holdings <span className="font-normal text-slate-600">· {real.length} tokens · est. from activity</span></span>
                  {totalUsd > 0 && <span className="text-sm font-bold text-white tabular-nums">{fmtUsd(totalUsd)}</span>}
                </div>
                {/* Allocation bar — portfolio breakdown by USD value */}
                {totalUsd > 0 && (
                  <div className="mb-2.5 flex h-2.5 overflow-hidden rounded-full bg-white/[0.04]">
                    {priced.slice(0, 8).map((h, i) => (
                      <div key={`${h.network}:${h.token}`} style={{ width: `${(h.usd! / totalUsd) * 100}%`, background: COLORS[i % COLORS.length] }} title={`${h.token} · ${fmtUsd(h.usd!)} (${((h.usd! / totalUsd) * 100).toFixed(1)}%)`} />
                    ))}
                  </div>
                )}
                <div className="max-h-56 overflow-y-auto overflow-x-auto">
                  <table className="w-full min-w-[420px] text-xs">
                    <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
                      <tr>{['Token', 'Holding', 'Value', 'Allocation', 'Last'].map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {real.map((h) => (
                        <tr key={`${h.network}:${h.tokenAddress}`} className="border-t border-white/[0.04] tabular-nums">
                          <td className="px-2 py-1.5">
                            <span className="font-medium text-slate-200">{h.token}</span>
                            <span className="text-slate-600"> · {h.network}</span>
                            {!h.curated && <span className="ml-1 text-[9px] text-slate-600">(unpriced)</span>}
                          </td>
                          <td className="px-2 py-1.5 text-slate-300">{h.qty >= 1000 ? h.qty.toLocaleString('en-US', { maximumFractionDigits: 0 }) : h.qty.toPrecision(4)}</td>
                          <td className="px-2 py-1.5 text-slate-200">{h.usd !== null ? fmtUsd(h.usd) : '—'}</td>
                          <td className="px-2 py-1.5 text-slate-500">{h.usd !== null && totalUsd > 0 ? `${((h.usd / totalUsd) * 100).toFixed(1)}%` : '—'}</td>
                          <td className="px-2 py-1.5 text-slate-500">
                            <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: h.usd ? COLORS[priced.indexOf(h) % COLORS.length] : 'transparent' }} />
                            {timeAgo(h.lastTs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-[10px] text-slate-600">
                  Holdings are netted from this wallet's tracked transfer history — an on-chain estimate, not a live balance call.
                  {spamCount > 0 && <> {spamCount} likely airdrop/scam token{spamCount === 1 ? '' : 's'} hidden.</>}
                </p>
              </div>
            )
          })()}

          {s.tokens.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
              <div className="px-3 pt-2 text-[10px] uppercase tracking-wider text-slate-500">Trading flow (curated tokens)</div>
              <table className="w-full min-w-[440px] text-xs">
                <thead className="bg-white/[0.02] text-left text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>{['Token', 'Net', 'Buys', 'Sells', 'Volume', 'Last'].map((h) => <th key={h} className="px-3 py-1.5 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {s.tokens.map((t) => (
                    <tr key={`${t.network}:${t.token}`} className="border-t border-white/[0.04] tabular-nums">
                      <td className="px-3 py-1.5 font-medium text-slate-200">{t.token} <span className="text-slate-600">· {t.network}</span></td>
                      <td className={`px-3 py-1.5 ${pnlColor(t.netFlowUsd)}`}>{fmtSign(t.netFlowUsd)}</td>
                      <td className="px-3 py-1.5 text-emerald-300">{t.buys}</td>
                      <td className="px-3 py-1.5 text-rose-300">{t.sells}</td>
                      <td className="px-3 py-1.5 text-slate-400">{fmtUsd(t.volumeUsd)}</td>
                      <td className="px-3 py-1.5 text-slate-500">{timeAgo(t.lastTs)}</td>
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
            <button className="btn-ghost flex-1 !py-1.5 text-xs text-amber-300" onClick={async () => { if (await confirm({ message: 'Stop and sell all open mirror positions?', confirmLabel: 'Stop & liquidate', tone: 'danger' })) stopFollow(existingFollow.id, true) }}>⏹ Stop & liquidate</button>
            <button className="btn-ghost !py-1.5 text-xs text-rose-300" onClick={async () => { if (await confirm({ message: 'Delete this follow and all its mirror bots?', confirmLabel: 'Delete', tone: 'danger' })) deleteFollow(existingFollow.id) }}>🗑</button>
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
          <p className="mt-1.5 text-[11px] text-slate-500">Up to <strong className="text-slate-200">{maxConcurrent}</strong> concurrent mirrors of {fmtUsd(perTradeNum ?? 0)} each.</p>
          {err && <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}
          <button className="btn-primary mt-2 w-full" disabled={busy || budgetNum === null || budgetNum < 10 || perTradeNum === null || perTradeNum < 10} onClick={startFollow}>{busy ? 'Starting…' : `🤖 Auto-follow with ${fmtUsd(budgetNum ?? 0)}`}</button>
        </div>
      )}
    </div>
  )
}
