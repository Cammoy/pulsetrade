import { useState } from 'react'
import { useStore } from '../store'
import type { FinderResult, FinderRow } from '../types'
import { fmtSign, fmtPct, fmtUsd, pnlColor } from '../format'

const RISK_CLS: Record<string, string> = {
  conservative: 'bg-teal-500/10 text-teal-300',
  balanced: 'bg-indigo-500/10 text-indigo-300',
  aggressive: 'bg-rose-500/10 text-rose-300',
}

const SCOPES = [
  { id: 'curated', label: '🛡️ Curated', blurb: 'the vetted coins on one network' },
  { id: 'top100', label: '🚀 Top-100 movers', blurb: 'the strongest 24h gainers of the top-100 by market cap' },
  { id: 'trending', label: '🔥 Trending (safe)', blurb: 'trending pools that pass the full safety screen' },
] as const
type Scope = (typeof SCOPES)[number]['id']

export default function ProfitFinder() {
  const { meta, openFinder, createBot, refresh, selectBot } = useStore()
  const [budget, setBudget] = useState('100')
  const [network, setNetwork] = useState('base')
  const [scope, setScope] = useState<Scope>('curated')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<FinderResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [launching, setLaunching] = useState<string | null>(null)

  if (!meta) return null

  const run = async () => {
    setLoading(true)
    setErr(null)
    setResult(null)
    try {
      const r = await fetch('/api/profit-finder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ budgetUsd: Number(budget), network, scope }),
      })
      const data = await r.json()
      if (data.error) setErr(data.error)
      else setResult(data)
    } catch {
      setErr('Engine unreachable')
    }
    setLoading(false)
  }

  const launch = async (row: FinderRow) => {
    if (!row.launch) return
    const key = `${row.token}/${row.strategy}/${row.risk}`
    setLaunching(key)
    setErr(null)
    if (row.launch.kind === 'bot' || row.launch.kind === 'market') {
      const out = await createBot({
        network: row.launch.kind === 'bot' ? row.launch.network : 'market',
        token: row.launch.token,
        ...(row.launch.kind === 'market' ? { cg: row.launch.cg, name: `${row.launch.token} ${row.strategyName} · market` } : {}),
        strategy: row.strategy,
        risk: row.risk,
        budgetUsd: Number(budget),
      })
      setLaunching(null)
      if (out.error) return setErr(out.error)
      openFinder(false)
      if (out.id) selectBot(out.id) // open the new bot immediately
    } else {
      // Trending row → arm a screened snipe with sensible defaults.
      try {
        const r = await fetch('/api/sniper', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            network: row.launch.network,
            poolAddress: row.launch.poolAddress,
            tokenAddress: row.launch.tokenAddress,
            tokenSymbol: row.launch.token,
            tokenName: row.tokenName,
            budgetUsd: Number(budget),
            sniper: { takeProfitPct: 50, stopLossPct: 25, maxHoldMin: 120 },
          }),
        })
        const data = await r.json()
        setLaunching(null)
        if (data.error) return setErr(data.error)
        await refresh()
        openFinder(false)
        if (data.id) selectBot(data.id) // open the new snipe immediately
      } catch {
        setLaunching(null)
        setErr('Engine unreachable')
      }
    }
  }

  const best = result?.rows[0]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onClick={() => openFinder(false)}>
      <div className="glass max-h-[90vh] w-full max-w-3xl overflow-auto border-white/10 bg-[#0b0f1a]/95 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">💡 Profit Finder</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Give it a stake and it backtests <strong className="text-slate-200">every strategy × risk tolerance × coin</strong> on the
              network over the same real 30-day history, then ranks the outcomes by profit.
            </p>
          </div>
          <button className="btn-ghost !px-2.5 !py-1" onClick={() => openFinder(false)}>✕</button>
        </div>

        <div className="mt-3 flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-0.5 text-xs">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              onClick={() => { setScope(s.id); setResult(null); setErr(null) }}
              title={s.blurb}
              className={`flex-1 cursor-pointer rounded-lg px-3 py-1.5 font-semibold transition-colors ${scope === s.id ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="mt-1 px-1 text-[11px] text-slate-500">Scans {SCOPES.find((s) => s.id === scope)?.blurb}.</p>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Here is…</span>
            <div className="flex items-center gap-1">
              <span className="text-lg font-bold text-white">$</span>
              <input className="input !w-28 text-base font-semibold" type="number" min={10} value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
          </label>
          {scope !== 'top100' && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Network</span>
              <select className="input !w-40" value={network} onChange={(e) => setNetwork(e.target.value)}>
                {meta.networks
                  .filter((n) => n.tokens.length > 0)
                  .filter((n) => scope !== 'trending' || n.evm !== false)
                  .map((n) => (
                    <option key={n.id} value={n.id}>{n.name}</option>
                  ))}
              </select>
            </label>
          )}
          <button className="btn-primary" disabled={loading || Number(budget) < 10} onClick={run}>
            {loading ? 'Backtesting every combination…' : '🔍 Find max profit'}
          </button>
        </div>
        {Number(budget) < 10 && <p className="mt-1 text-[11px] text-amber-400">Minimum stake is $10.</p>}
        {err && <div className="mt-3 rounded-xl bg-rose-500/10 p-2.5 text-xs text-rose-300">{err}</div>}
        {loading && (
          <div className="mt-4 animate-pulse rounded-xl bg-white/[0.03] p-4 text-center text-xs text-slate-500">
            {scope === 'top100'
              ? 'Scanning the top-100 movers on real market history — the free data tier paces this, so it can take 1–2 minutes…'
              : scope === 'trending'
                ? 'Safety-screening trending pools, then backtesting the survivors on their real pool candles…'
                : 'Running up to 60 backtests on real market history — a few seconds…'}
          </div>
        )}

        {result && (
          <div className="mt-4 space-y-3">
            {best && (
              <div className={`rounded-xl border p-3 ${best.profitUsd > 0 ? 'border-emerald-400/40 bg-emerald-500/[0.07]' : 'border-amber-400/40 bg-amber-500/[0.07]'}`}>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  {best.profitUsd > 0 ? 'Max profit, last 30 days' : 'Best result, last 30 days (nothing was profitable — consider waiting)'}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={`text-2xl font-bold tabular-nums ${pnlColor(best.profitUsd)}`}>{fmtSign(best.profitUsd)}</span>
                  <span className="text-sm text-slate-300">
                    {fmtUsd(Number(budget))} → {best.token} · {best.strategyName} · <span className="capitalize">{best.risk}</span>
                  </span>
                </div>
              </div>
            )}

            <div className="max-h-72 overflow-auto rounded-xl border border-white/[0.06]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#0c101c] text-left text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    {['#', 'Coin', scope === 'top100' ? '24h' : 'Net', 'Strategy', 'Risk', `Profit on ${fmtUsd(Number(budget))}`, 'Return', 'Win rate', 'Max DD', 'Trades', ''].map((h) => (
                      <th key={h} className="px-2.5 py-2 font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => {
                    const key = `${row.token}/${row.strategy}/${row.risk}`
                    return (
                      <tr key={key} className={`border-t border-white/[0.04] tabular-nums hover:bg-white/[0.02] ${i === 0 ? 'bg-emerald-500/[0.04]' : ''}`}>
                        <td className="px-2.5 py-1.5 text-slate-600">{i + 1}</td>
                        <td className="px-2.5 py-1.5 font-medium text-slate-200" title={row.tokenName}>{row.token}</td>
                        <td className="px-2.5 py-1.5 text-slate-500">
                          {scope === 'top100'
                            ? (row.change24hPct != null ? <span className={pnlColor(row.change24hPct)}>{fmtPct(row.change24hPct)}</span> : '—')
                            : row.network}
                        </td>
                        <td className="px-2.5 py-1.5 text-slate-300">{row.strategyName}</td>
                        <td className="px-2.5 py-1.5"><span className={`chip capitalize ${RISK_CLS[row.risk]}`}>{row.risk}</span></td>
                        <td className={`px-2.5 py-1.5 font-semibold ${pnlColor(row.profitUsd)}`}>{fmtSign(row.profitUsd)}</td>
                        <td className={`px-2.5 py-1.5 ${pnlColor(row.returnPct)}`}>{fmtPct(row.returnPct)}</td>
                        <td className="px-2.5 py-1.5 text-slate-400">{row.winRate === null ? '—' : `${row.winRate}%`}</td>
                        <td className="px-2.5 py-1.5 text-amber-300/80">−{row.maxDrawdownPct}%</td>
                        <td className="px-2.5 py-1.5 text-slate-400">{row.trades}</td>
                        <td className="px-2.5 py-1.5">
                          {row.launch ? (
                            <button
                              className="btn-ghost !px-2 !py-1 text-[11px]"
                              disabled={launching !== null}
                              title={row.launch.kind === 'market' ? 'Trades in paper, priced live from the market (no on-chain contract needed)' : undefined}
                              onClick={() => launch(row)}
                            >
                              {launching === key ? '…' : row.launch.kind === 'snipe' ? '🎯 Snipe' : row.launch.kind === 'market' ? '📈 Trade' : '🚀 Launch'}
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-600">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {result.skipped.length > 0 && (
              <p className="text-[11px] text-amber-400/80">
                ⚠ No market data right now for: {result.skipped.join(', ')} (rate limited) — run again in a minute for full coverage.
              </p>
            )}
            <p className="text-[10px] leading-relaxed text-slate-600">
              Ranked by realized backtest profit on identical real 30-day history, including gas and slippage. Past performance does not
              guarantee future results — launching starts the bot in {useStore.getState().mode} mode with this exact configuration.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
