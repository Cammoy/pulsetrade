import { useState } from 'react'
import { useStore } from '../store'
import { botsForMode } from '../stats'
import { fmtUsd, fmtSign, fmtQty, fmtPrice, hhmm, pnlColor } from '../format'

export default function TradeList() {
  const { trades, bots, mode, showTrades, toggleTrades, lastTradeId } = useStore()
  const [botFilter, setBotFilter] = useState('all')
  const [sideFilter, setSideFilter] = useState<'all' | 'buy' | 'sell'>('all')

  // Scope to the ACTIVE workspace — the Live view shows only live trades (and a paper
  // trade never appears in Live), matching the Monthly P&L ledger above it. [paper/live]
  const scoped = trades.filter((t) => (t.mode ?? 'paper') === mode)
  const modeBots = botsForMode(bots, mode)
  const filtered = scoped.filter(
    (t) => (botFilter === 'all' || t.botId === botFilter) && (sideFilter === 'all' || t.side === sideFilter),
  )
  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? '(deleted)'

  return (
    <section className="glass overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <button className="flex flex-1 cursor-pointer items-center gap-2 text-left" onClick={toggleTrades}>
          <span className="text-sm font-semibold text-white">Trade history</span>
          <span className="chip bg-white/[0.06] text-slate-400">{scoped.length}</span>
          <span className="ml-auto text-xs text-slate-500">{showTrades ? '▲ hide' : '▼ show'}</span>
        </button>
        {scoped.length > 0 && (
          <a
            href={`/api/export/trades.csv?mode=${mode}`}
            download
            title={`Download ${mode} trade history as CSV (for accounting / taxes)`}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          >
            ⤓ CSV
          </a>
        )}
      </div>

      {showTrades && (
        <div>
          <div className="flex flex-wrap gap-2 border-t border-white/[0.05] px-4 py-2.5">
            <select className="input !w-auto !py-1.5 text-xs" value={botFilter} onChange={(e) => setBotFilter(e.target.value)}>
              <option value="all">All bots</option>
              {modeBots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <div className="seg-track flex items-center p-0.5 text-xs">
              {(['all', 'buy', 'sell'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSideFilter(s)}
                  className={`cursor-pointer rounded-lg px-3 py-1 font-medium capitalize transition-colors ${
                    sideFilter === s ? 'seg-active' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-80 overflow-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="sticky top-0 bg-[var(--head)] text-left text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  {['Time', 'Bot', 'Side', 'Asset', 'Qty', 'Price', 'Value', 'Fee', 'P&L', 'Swept', 'Reason'].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-4 py-8 text-center text-slate-600">
                      No trades yet — bots trade automatically when their strategy signals fire.
                    </td>
                  </tr>
                )}
                {filtered.map((t) => (
                  <tr
                    key={t.id}
                    className={`border-t border-white/[0.04] tabular-nums hover:bg-white/[0.02] ${t.id === lastTradeId ? 'flash' : ''}`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-slate-400">{hhmm(t.ts)}</td>
                    <td className="max-w-36 truncate px-3 py-2 text-slate-300" title={botName(t.botId)}>
                      {botName(t.botId)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`chip ${t.side === 'buy' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>
                        {t.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-300">
                      {t.token} <span className="text-slate-600">· {t.network}</span>
                    </td>
                    <td className="px-3 py-2 text-slate-400">{fmtQty(t.qty)}</td>
                    <td className="px-3 py-2 text-slate-400">{fmtPrice(t.priceUsd)}</td>
                    <td className="px-3 py-2 text-slate-300">{fmtUsd(t.usd)}</td>
                    <td className="px-3 py-2 text-slate-500">{fmtUsd(t.feeUsd)}</td>
                    <td className={`px-3 py-2 font-semibold ${t.pnlUsd !== undefined ? pnlColor(t.pnlUsd) : 'text-slate-600'}`}>
                      {t.pnlUsd !== undefined ? fmtSign(t.pnlUsd) : '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-cyan-300">
                      {t.sweptNative ? `${t.sweptNative.qty.toPrecision(3)} ${t.sweptNative.symbol}` : '—'}
                    </td>
                    <td className="max-w-72 truncate px-3 py-2 text-slate-500" title={t.reason}>
                      {t.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
