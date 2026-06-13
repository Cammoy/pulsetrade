import { useState } from 'react'
import { useStore } from '../store'
import { fmtSign, fmtUsd, fmtPct, pnlColor } from '../format'

const MEDAL = ['🥇', '🥈', '🥉']
const RISK_CLS: Record<string, string> = {
  conservative: 'bg-teal-500/10 text-teal-300',
  balanced: 'bg-indigo-500/10 text-indigo-300',
  aggressive: 'bg-rose-500/10 text-rose-300',
}

/** Dashboard panel listing running/ended tournaments with live leaderboards. */
export function TournamentPanel() {
  const { tournaments, meta, openTournament, selectBot } = useStore()
  if (tournaments.length === 0) return null
  const stratName = (id: string) => meta?.strategies.find((s) => s.id === id)?.name ?? id

  const end = (id: string) => fetch(`/api/tournaments/${id}/end`, { method: 'POST' })
  const remove = (id: string) => fetch(`/api/tournaments/${id}`, { method: 'DELETE' })

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-sm font-semibold text-white">🏆 Tournaments</h2>
        <button className="btn-ghost !py-1 text-xs" onClick={() => openTournament(true)}>+ New</button>
      </div>
      {tournaments.map((t) => (
        <div key={t.id} className="glass overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.05] px-4 py-2.5">
            <span className="text-sm font-semibold text-white">{t.name}</span>
            <span className="chip bg-white/[0.06] text-slate-300">{t.token}</span>
            <span className={`chip ${t.status === 'running' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-slate-500/10 text-slate-400'}`}>
              {t.status === 'running' ? '● live' : 'ended'}
            </span>
            <span className="text-[11px] text-slate-500">{fmtUsd(t.budgetUsd)} each · {t.standings.length} bots</span>
            {t.sweepTo === 'usdt' && <span className="chip bg-emerald-500/10 text-emerald-300">ends → USDT</span>}
            {t.endsAt && t.status === 'running' && (
              <span className="text-[11px] text-slate-500">auto-ends {new Date(t.endsAt).toLocaleString()}</span>
            )}
            <div className="ml-auto flex gap-1.5">
              {t.status === 'running' && (
                <button className="btn-ghost !py-1 text-xs text-amber-300" onClick={() => { if (confirm(`End tournament and liquidate all contestants to ${t.sweepTo === 'usdt' ? 'USDT' : 'native'}?`)) end(t.id) }}>
                  End now
                </button>
              )}
              <button className="btn-ghost !py-1 text-xs text-rose-300" onClick={() => { if (confirm('Delete tournament and all its bots?')) remove(t.id) }}>🗑</button>
            </div>
          </div>
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <tr>{['#', 'Bot', 'Strategy', 'Risk', 'Return', 'P&L', 'W/L', 'Trades'].map((h) => <th key={h} className="px-3 py-1.5 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {t.standings.map((s, i) => {
                const winner = t.status === 'ended' && t.winnerBotId === s.botId
                return (
                  <tr
                    key={s.botId}
                    onClick={() => selectBot(s.botId)}
                    className={`cursor-pointer border-t border-white/[0.04] tabular-nums hover:bg-white/[0.03] ${winner ? 'bg-amber-500/[0.06]' : ''}`}
                  >
                    <td className="px-3 py-2 text-base">{MEDAL[i] ?? <span className="text-slate-600">{i + 1}</span>}</td>
                    <td className="px-3 py-2 max-w-40 truncate text-slate-200">{s.name}</td>
                    <td className="px-3 py-2 text-slate-300">{stratName(s.strategy)}</td>
                    <td className="px-3 py-2"><span className={`chip capitalize ${RISK_CLS[s.risk]}`}>{s.risk}</span></td>
                    <td className={`px-3 py-2 font-bold ${pnlColor(s.returnPct)}`}>{fmtPct(s.returnPct)}</td>
                    <td className={`px-3 py-2 ${pnlColor(s.totalPnlUsd)}`}>{fmtSign(s.totalPnlUsd)}</td>
                    <td className="px-3 py-2 text-slate-400">{s.wins}/{s.losses}</td>
                    <td className="px-3 py-2 text-slate-400">{s.trades}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  )
}

const ALL_RISKS = ['conservative', 'balanced', 'aggressive'] as const

export function TournamentModal() {
  const { meta, openTournament, refresh } = useStore()
  const [network, setNetwork] = useState('base')
  const [token, setToken] = useState('')
  const [budget, setBudget] = useState('500')
  const [duration, setDuration] = useState('')
  const [sweepTo, setSweepTo] = useState<'native' | 'usdt'>('native')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const net = meta?.networks.find((n) => n.id === network)
  if (!meta) return null
  const strategies = meta.strategies // the 4 backtestable strategies

  const key = (s: string, r: string) => `${s}:${r}`
  const toggle = (s: string, r: string) => setPicked((p) => ({ ...p, [key(s, r)]: !p[key(s, r)] }))
  const contestants = Object.entries(picked).filter(([, v]) => v).map(([k]) => { const [strategy, risk] = k.split(':'); return { strategy, risk } })

  const start = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/tournaments', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network, token: token || net?.tokens[0]?.symbol, budgetUsd: Number(budget), contestants, durationHours: duration ? Number(duration) : undefined, sweepTo }),
      })
      const data = await r.json()
      if (data.error) setErr(data.error)
      else { await refresh(); openTournament(false) }
    } catch { setErr('Engine unreachable') }
    setBusy(false)
  }

  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-3" onClick={() => openTournament(false)}>
      <div className="glass animate-sheet pb-safe max-h-[94vh] w-full max-w-2xl overflow-auto !rounded-b-none border-white/10 bg-[#0b0f1a]/95 p-5 sm:!rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">🏆 New tournament</h2>
            <p className="mt-1 text-xs text-slate-400">Pick contestants — each runs the same coin with an equal budget. They compete to be the most profitable; the leaderboard ranks them live by return %.</p>
          </div>
          <button className="btn-ghost !px-2.5 !py-1" onClick={() => openTournament(false)}>✕</button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <label className="block sm:col-span-1"><span className="mb-1 block text-xs text-slate-400">Network</span>
            <select className="input !py-2" value={network} onChange={(e) => { setNetwork(e.target.value); setToken('') }}>
              {meta.networks.filter((n) => n.tokens.length > 0).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </label>
          <label className="block"><span className="mb-1 block text-xs text-slate-400">Coin</span>
            <select className="input !py-2" value={token} onChange={(e) => setToken(e.target.value)}>
              {net?.tokens.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
            </select>
          </label>
          <label className="block"><span className="mb-1 block text-xs text-slate-400">Budget each ($)</span>
            <input className="input !py-2" type="number" min={10} value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
          <label className="block"><span className="mb-1 block text-xs text-slate-400">Auto-end (hrs)</span>
            <input className="input !py-2" type="number" placeholder="open" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </label>
          <label className="block sm:col-span-2"><span className="mb-1 block text-xs text-slate-400">On end, sell everything to</span>
            <select className="input !py-2" value={sweepTo} onChange={(e) => setSweepTo(e.target.value as 'native' | 'usdt')}>
              <option value="native">Native coin ({net?.native.symbol ?? 'ETH'})</option>
              <option value="usdt">USDT (stable)</option>
            </select>
          </label>
        </div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">Contestants ({contestants.length})</span>
            <button className="text-[11px] text-indigo-300 hover:underline" onClick={() => {
              const all: Record<string, boolean> = {}; for (const s of strategies) all[key(s.id, 'balanced')] = true; setPicked(all)
            }}>quick: all strategies @ balanced</button>
          </div>
          <div className="overflow-hidden rounded-xl border border-white/[0.06]">
            <table className="w-full text-xs">
              <thead className="bg-white/[0.02] text-left text-[10px] uppercase tracking-wider text-slate-500">
                <tr><th className="px-3 py-1.5">Strategy</th>{ALL_RISKS.map((r) => <th key={r} className="px-3 py-1.5 capitalize">{r}</th>)}</tr>
              </thead>
              <tbody>
                {strategies.map((s) => (
                  <tr key={s.id} className="border-t border-white/[0.04]">
                    <td className="px-3 py-2 text-slate-200">{s.name}</td>
                    {ALL_RISKS.map((r) => (
                      <td key={r} className="px-3 py-2">
                        <input type="checkbox" className="h-4 w-4 accent-indigo-500" checked={!!picked[key(s.id, r)]} onChange={() => toggle(s.id, r)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Tip: pit the same strategy at all three risk tiers, or all four strategies head-to-head. 2–12 contestants.</p>
        </div>

        {err && <div className="mt-3 rounded-xl bg-rose-500/10 p-2.5 text-xs text-rose-300">{err}</div>}
        <button className="btn-primary mt-4 w-full" disabled={busy || contestants.length < 2 || Number(budget) < 10} onClick={start}>
          {busy ? 'Starting…' : `🏆 Start tournament (${contestants.length} bots · ${fmtUsd((Number(budget) || 0) * contestants.length)} total)`}
        </button>
      </div>
    </div>
  )
}
