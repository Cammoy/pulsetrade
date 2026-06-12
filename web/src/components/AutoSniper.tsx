import { useState } from 'react'
import { useStore } from '../store'
import { fmtUsd, fmtSign, pnlColor } from '../format'

export default function AutoSniperPanel() {
  const { meta, autoSniper, refresh } = useStore()
  const [network, setNetwork] = useState('base')
  const [feed, setFeed] = useState<'new' | 'trending'>('new')
  const [total, setTotal] = useState('300')
  const [per, setPer] = useState('50')
  const [tp, setTp] = useState('60')
  const [sl, setSl] = useState('25')
  const [hold, setHold] = useState('45')
  const [minLiq, setMinLiq] = useState('10000')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const running = autoSniper?.enabled

  const start = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch('/api/auto-sniper', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          network, mode: feed,
          totalBudgetUsd: Number(total),
          perSnipeUsd: Number(per),
          minLiquidityUsd: Number(minLiq),
          config: { takeProfitPct: Number(tp), stopLossPct: Number(sl), maxHoldMin: Number(hold) },
        }),
      })
      const data = await r.json()
      if (data.error) setErr(data.error)
      else await refresh()
    } catch {
      setErr('Engine unreachable')
    }
    setBusy(false)
  }

  const stop = async (liquidate: boolean) => {
    setBusy(true)
    await fetch('/api/auto-sniper/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ liquidate }),
    })
    await refresh()
    setBusy(false)
  }

  if (!meta) return null

  if (running && autoSniper) {
    const s = autoSniper.stats
    const allocated = autoSniper.totalBudgetUsd - autoSniper.poolUsd
    return (
      <div className="mt-3 space-y-3">
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/[0.06] p-3">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400 pulse-dot" />
            <span className="text-sm font-bold text-emerald-200">Auto-Sniper running</span>
            <span className="ml-auto text-[11px] text-slate-400 capitalize">{autoSniper.network} · {autoSniper.mode} pools</span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            Scanning the safe-only feed every ~90s, sniping vetted coins at {fmtUsd(autoSniper.perSnipeUsd)} each (up to {autoSniper.maxConcurrent} at once),
            taking profit and recycling returns into new snipes.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { l: 'Total P&L', v: fmtSign(s.realizedUsd), c: pnlColor(s.realizedUsd) },
            { l: 'Profit in native', v: fmtUsd(s.nativeTakenUsd), c: 'text-cyan-300' },
            { l: 'Active snipes', v: `${s.active}/${autoSniper.maxConcurrent}`, c: 'text-white' },
            { l: 'Win rate', v: s.wins + s.losses ? `${Math.round((s.wins / (s.wins + s.losses)) * 100)}%` : '—', c: 'text-slate-200' },
          ].map((x) => (
            <div key={x.l} className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{x.l}</div>
              <div className={`text-sm font-bold tabular-nums ${x.c}`}>{x.v}</div>
            </div>
          ))}
        </div>

        <div className="rounded-xl bg-white/[0.03] p-3">
          <div className="mb-1 flex justify-between text-[11px] text-slate-400">
            <span>Budget deployed</span>
            <span className="tabular-nums">{fmtUsd(allocated)} of {fmtUsd(autoSniper.totalBudgetUsd)} · {fmtUsd(autoSniper.poolUsd)} idle</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400" style={{ width: `${Math.min(100, (allocated / autoSniper.totalBudgetUsd) * 100)}%` }} />
          </div>
          <div className="mt-1 text-[10px] text-slate-600">{s.completed} snipe(s) completed · {s.wins}W / {s.losses}L</div>
        </div>

        <div className="flex gap-2">
          <button className="btn-ghost flex-1" disabled={busy} onClick={() => stop(false)} title="Stop scanning; let open snipes finish on their own exits">
            ⏸ Stop scanning
          </button>
          <button className="btn-ghost flex-1 text-amber-300" disabled={busy} onClick={() => { if (confirm('Stop and immediately sell all open auto-snipes to native?')) stop(true) }}>
            ⏹ Stop & liquidate all
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-3 space-y-3">
      <div className="rounded-xl bg-indigo-500/10 p-3 text-xs leading-relaxed text-indigo-200">
        Hand the Auto-Sniper a budget. It continuously scans the <strong>safe-only</strong> feed and snipes vetted coins on its own —
        taking profit and recycling returns into the next snipe. Every token still passes the full honeypot / rug / holder screen.
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Total budget (USD)</span>
          <input className="input" type="number" min={10} value={total} onChange={(e) => setTotal(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Per snipe (USD)</span>
          <input className="input" type="number" min={10} value={per} onChange={(e) => setPer(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Network</span>
          <select className="input" value={network} onChange={(e) => setNetwork(e.target.value)}>
            {meta.networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Feed</span>
          <select className="input" value={feed} onChange={(e) => setFeed(e.target.value as 'new' | 'trending')}>
            <option value="new">🆕 New pools</option>
            <option value="trending">🔥 Trending pools</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Take-profit %</span><input className="input !py-2 text-sm" type="number" value={tp} onChange={(e) => setTp(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Stop-loss %</span><input className="input !py-2 text-sm" type="number" value={sl} onChange={(e) => setSl(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Max hold (min)</span><input className="input !py-2 text-sm" type="number" value={hold} onChange={(e) => setHold(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Min liquidity $</span><input className="input !py-2 text-sm" type="number" value={minLiq} onChange={(e) => setMinLiq(e.target.value)} /></label>
      </div>

      <div className="rounded-xl bg-white/[0.03] p-2.5 text-[11px] text-slate-400">
        Will run up to <strong className="text-slate-200">{Math.max(1, Math.floor((Number(total) || 0) / (Number(per) || 1)))}</strong> concurrent snipes
        of {fmtUsd(Number(per) || 0)} each, taking profit at +{tp || 0}% and cutting losses at −{sl || 0}%.
      </div>

      {err && <div className="rounded-xl bg-rose-500/10 p-2.5 text-xs text-rose-300">{err}</div>}
      <button className="btn-primary w-full" disabled={busy || Number(total) < 10 || Number(per) < 10} onClick={start}>
        {busy ? 'Starting…' : `🤖 Start Auto-Sniper with ${fmtUsd(Number(total) || 0)}`}
      </button>
      <p className="text-[10px] leading-relaxed text-slate-600">
        Auto-trading new tokens is high-risk even with screening. Use a budget you can afford to lose; you can stop (and liquidate to native) any time.
      </p>
    </div>
  )
}
