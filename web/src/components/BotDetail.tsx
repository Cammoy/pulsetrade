import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { fmtSign, fmtUsd, fmtPrice, fmtQty, pnlColor, hhmm, DAY_NAMES } from '../format'
import PriceChart from './PriceChart'

export default function BotDetail() {
  const { selectedBotId, selectBot, bots, trades, meta } = useStore()
  const bot = bots.find((b) => b.id === selectedBotId)
  const [candles, setCandles] = useState<{ t: number; c: number }[]>([])

  const net = meta?.networks.find((n) => n.id === bot?.network)
  const token = net?.tokens.find((t) => t.symbol === bot?.token)
  const risk = bot && meta?.risk[bot.risk]
  const strat = meta?.strategies.find((s) => s.id === bot?.strategy)

  useEffect(() => {
    if (!token) return
    setCandles([])
    fetch(`/api/candles/${token.cg}?days=7`)
      .then((r) => r.json())
      .then(setCandles)
      .catch(() => {})
  }, [token?.cg])

  if (!bot) return null
  const botTrades = trades.filter((t) => t.botId === bot.id)
  const sched = bot.schedule

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6" onClick={() => selectBot(null)}>
      <div
        className="glass max-h-[92vh] w-full max-w-3xl overflow-auto !rounded-b-none border-white/10 bg-[#0b0f1a]/95 p-5 sm:!rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">{bot.name}</h2>
            <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
              <span className="chip bg-white/[0.06] text-slate-300">{net?.name}</span>
              <span className="chip bg-white/[0.06] text-slate-300">{strat?.name}</span>
              <span className="chip bg-white/[0.06] capitalize text-slate-300">{bot.risk}</span>
              <span className="chip bg-white/[0.06] text-slate-300">
                {sched.enabled
                  ? `${sched.days.map((d) => DAY_NAMES[d]).join(' ')} · ${sched.startHour}:00–${sched.endHour}:00`
                  : '24/7'}
              </span>
            </div>
          </div>
          <button className="btn-ghost !px-2.5 !py-1" onClick={() => selectBot(null)}>
            ✕
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { l: 'Total P&L', v: fmtSign(bot.totalPnlUsd), c: pnlColor(bot.totalPnlUsd) },
            { l: 'Realized', v: fmtSign(bot.stats.realizedUsd), c: pnlColor(bot.stats.realizedUsd) },
            { l: 'Unrealized', v: fmtSign(bot.unrealizedUsd), c: pnlColor(bot.unrealizedUsd) },
            { l: 'Fees paid', v: fmtUsd(bot.stats.feesUsd), c: 'text-slate-300' },
            { l: 'Working cash', v: fmtUsd(bot.cashUsd), c: 'text-slate-200' },
            {
              l: 'Position',
              v: bot.position.qty > 0 ? `${fmtQty(bot.position.qty)} ${bot.token}` : 'flat',
              c: 'text-slate-200',
            },
            {
              l: 'Avg cost',
              v: bot.position.qty > 0 ? fmtPrice(bot.position.avgCostUsd) : '—',
              c: 'text-slate-200',
            },
            {
              l: `Profit taken (${bot.sweepTo === 'usdt' ? 'USDT' : net?.native.symbol})`,
              v: bot.stats.nativeTakenQty > 0 ? bot.stats.nativeTakenQty.toPrecision(4) : '0',
              c: 'text-cyan-300',
            },
          ].map((s) => (
            <div key={s.l} className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{s.l}</div>
              <div className={`text-sm font-semibold tabular-nums ${s.c}`}>{s.v}</div>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <div className="mb-1 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-white">
              {bot.token} · 7 days {bot.priceUsd ? <span className="ml-2 text-slate-400">{fmtPrice(bot.priceUsd)}</span> : null}
            </h3>
            <span className="text-[11px] text-slate-500">▲ buys · ▼ sells</span>
          </div>
          <PriceChart candles={candles} trades={botTrades} />
        </div>

        {risk && (
          <div className="mt-4">
            <h3 className="mb-1.5 text-sm font-semibold text-white">Risk parameters · {risk.label}</h3>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {[
                `entry ${risk.positionPct}% of budget`,
                `stop −${risk.stopLossPct}%`,
                `target +${risk.takeProfitPct}%`,
                `grid ${risk.gridLevels} × ${risk.gridSpacingPct}%`,
                `RSI ${risk.rsiBuy}/${risk.rsiSell}`,
                `cooldown ${risk.cooldownMin}m`,
              ].map((p) => (
                <span key={p} className="chip border border-white/10 bg-white/[0.03] text-slate-400">
                  {p}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4">
          <h3 className="mb-1.5 text-sm font-semibold text-white">Bot activity</h3>
          <div className="max-h-48 space-y-1 overflow-auto rounded-xl bg-black/30 p-3 font-mono text-[11px]">
            {bot.log.length === 0 && <div className="text-slate-600">No activity yet.</div>}
            {[...bot.log].reverse().map((l, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-slate-600">{hhmm(l.ts)}</span>
                <span
                  className={
                    l.kind === 'buy'
                      ? 'text-emerald-300'
                      : l.kind === 'sell'
                        ? 'text-rose-300'
                        : l.kind === 'warn'
                          ? 'text-amber-300'
                          : 'text-slate-400'
                  }
                >
                  {l.msg}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
