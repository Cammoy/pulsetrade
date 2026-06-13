import { useStore } from '../store'
import type { Bot, RiskReport } from '../types'
import { fmtSign, fmtUsd, fmtPrice, pnlColor, timeAgo } from '../format'
import Sparkline from './Sparkline'
import { RiskBadge } from './RiskReport'

const STATUS: Record<Bot['status'], { label: string; cls: string; dot: string }> = {
  running: { label: 'Running', cls: 'text-emerald-300 bg-emerald-500/10', dot: 'bg-emerald-400 pulse-dot' },
  scheduled: { label: 'Sleeping', cls: 'text-sky-300 bg-sky-500/10', dot: 'bg-sky-400' },
  paused: { label: 'Paused', cls: 'text-amber-300 bg-amber-500/10', dot: 'bg-amber-400' },
  stopped: { label: 'Stopped', cls: 'text-slate-400 bg-slate-500/10', dot: 'bg-slate-500' },
}

const RISK_CLS: Record<string, string> = {
  conservative: 'bg-teal-500/10 text-teal-300',
  balanced: 'bg-indigo-500/10 text-indigo-300',
  aggressive: 'bg-rose-500/10 text-rose-300',
}

export default function BotCard({ bot }: { bot: Bot }) {
  const { meta, control, remove, selectBot } = useStore()
  const net = meta?.networks.find((n) => n.id === bot.network)
  const strat = meta?.strategies.find((s) => s.id === bot.strategy)
  const st = STATUS[bot.status]
  const lastLog = bot.log[bot.log.length - 1]

  return (
    <div className="glass glass-hover card-lift animate-in group min-w-0 cursor-pointer overflow-hidden p-4" onClick={() => selectBot(bot.id)}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[11px] font-bold text-white shadow-md"
            style={{ background: `linear-gradient(135deg, ${net?.color ?? '#555'}, #1e293b)` }}
          >
            {bot.token.slice(0, 5)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">{bot.name}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="chip bg-white/[0.06] text-slate-300">{net?.name}</span>
              <span className="chip bg-white/[0.06] text-slate-300">
                {bot.sniper ? '🎯 Sniper' : bot.copy ? '🐋 Copy' : bot.ai ? '🤖 AI' : strat?.name}
              </span>
              {!bot.sniper && <span className={`chip capitalize ${RISK_CLS[bot.risk]}`}>{bot.risk}</span>}
              {bot.tournamentId && <span className="chip bg-amber-500/10 text-amber-300">🏆</span>}
              {bot.sniper && bot.riskReport && <RiskBadge report={bot.riskReport as RiskReport} />}
            </div>
          </div>
        </div>
        <span className={`chip ${st.cls}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
          {st.label}
        </span>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className={`text-2xl font-bold tabular-nums ${pnlColor(bot.totalPnlUsd)}`}>{fmtSign(bot.totalPnlUsd)}</div>
          <div className="truncate text-[11px] text-slate-500">
            realized {fmtSign(bot.stats.realizedUsd)} · unreal {fmtSign(bot.unrealizedUsd)}
          </div>
        </div>
        <div className="shrink-0">
          <Sparkline points={bot.equityHistory.map((e) => e.v)} baseline={0} width={120} height={44} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div className="min-w-0 rounded-lg bg-white/[0.03] px-2 py-1.5">
          <div className="text-slate-500">Position</div>
          <div className="truncate font-medium text-slate-200 tabular-nums">
            {bot.position.qty > 0 ? fmtUsd(bot.positionValueUsd) : '—'}
          </div>
        </div>
        <div className="min-w-0 rounded-lg bg-white/[0.03] px-2 py-1.5">
          <div className="text-slate-500">Price</div>
          <div className="truncate font-medium text-slate-200 tabular-nums">{bot.priceUsd ? fmtPrice(bot.priceUsd) : '—'}</div>
        </div>
        <div className="min-w-0 rounded-lg bg-white/[0.03] px-2 py-1.5">
          <div className="text-slate-500">Profit taken</div>
          <div className="truncate font-medium text-cyan-300 tabular-nums">
            {bot.stats.nativeTakenQty > 0
              ? `${bot.stats.nativeTakenQty.toPrecision(3)} ${bot.sweepTo === 'usdt' ? 'USDT' : net?.native.symbol}`
              : '—'}
          </div>
        </div>
      </div>

      {lastLog && (
        <div className="mt-2 truncate text-[11px] text-slate-500" title={lastLog.msg}>
          <span className="text-slate-600">{timeAgo(lastLog.ts)}</span> · {lastLog.msg}
        </div>
      )}

      <div className="mt-3 flex gap-1.5 border-t border-white/[0.05] pt-3" onClick={(e) => e.stopPropagation()}>
        {bot.status === 'paused' || bot.status === 'stopped' ? (
          <button className="btn-ghost min-w-0 flex-1 !py-1.5 text-xs" onClick={() => control(bot.id, 'resume')}>
            ▶ Resume
          </button>
        ) : (
          <button className="btn-ghost min-w-0 flex-1 !py-1.5 text-xs" onClick={() => control(bot.id, 'pause')}>
            ⏸ Pause
          </button>
        )}
        {bot.status !== 'stopped' && (
          <button
            className="btn-ghost min-w-0 flex-1 !py-1.5 text-xs text-amber-300"
            title="Sell everything and stop"
            onClick={() => {
              if (confirm(`Stop "${bot.name}"? Any open position is sold and swept to ${bot.sweepTo === 'usdt' ? 'USDT' : net?.native.symbol}.`))
                control(bot.id, 'stop')
            }}
          >
            <span className="truncate">⏹ Stop &amp; sweep</span>
          </button>
        )}
        <button
          className="btn-ghost shrink-0 !py-1.5 text-xs text-rose-300"
          onClick={() => {
            if (confirm(`Delete "${bot.name}" and its trade history?`)) remove(bot.id)
          }}
        >
          🗑
        </button>
      </div>
    </div>
  )
}
