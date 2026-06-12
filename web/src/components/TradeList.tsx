import { useState } from 'react'
import { useStore } from '../store'
import { fmtUsd, fmtSign, fmtQty, fmtPrice, hhmm, pnlColor } from '../format'

export default function TradeList() {
  const { trades, bots, showTrades, toggleTrades, lastTradeId } = useStore()
  const [botFilter, setBotFilter] = useState('all')
  const [sideFilter, setSideFilter] = useState<'all' | 'buy' | 'sell'>('all')

  const filtered = trades.filter(
    (t) => (botFilter === 'all' || t.botId === botFilter) && (sideFilter === 'all' || t.side === sideFilter),
  )
  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? '(deleted)'

  return (
    <section className="glass overflow-hidden">
      <button
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
        onClick={toggleTrades}
      >
        <span className="text-sm font-semibold text-white">Trade history</span>
        <span className="chip bg-white/[0.06] text-slate-400">{trades.length}</span>
        <span className="ml-auto text-xs text-slate-500">{showTrades ? '▲ hide' : '▼ show'}</span>
      </button>

      {showTrades && (
        <div>
          <div className="flex flex-wrap gap-2 border-t border-white/[0.05] px-4 py-2.5">
            <select className="input !w-auto !py-1.5 text-xs" value={botFilter} onChange={(e) => setBotFilter(e.target.value)}>
              <option value="all">All bots</option>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <div className="flex items-center rounded-xl border border-white/10 bg-white/[0.03] p-0.5 text-xs">
              {(['all', 'buy', 'sell'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSideFilter(s)}
                  className={`cursor-pointer rounded-lg px-3 py-1 font-medium capitalize transition-colors ${
                    sideFilter === s ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#0c101c] text-left text-[10px] uppercase tracking-wider text-slate-500">
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
