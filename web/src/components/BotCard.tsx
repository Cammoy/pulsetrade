import { useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useStore } from '../store'
import type { Bot, RiskReport } from '../types'
import { fmtSign, fmtUsd, fmtPrice, pnlColor } from '../format'
import CountUp from '../useCountUp'
import { RiskBadge } from './RiskReport'

export const STATUS: Record<Bot['status'], { label: string; cls: string; dot: string }> = {
  running: { label: 'Running', cls: 'text-emerald-300 bg-emerald-500/10', dot: 'bg-emerald-400 pulse-dot' },
  scheduled: { label: 'Sleeping', cls: 'text-sky-300 bg-sky-500/10', dot: 'bg-sky-400' },
  paused: { label: 'Paused', cls: 'text-amber-300 bg-amber-500/10', dot: 'bg-amber-400' },
  stopped: { label: 'Stopped', cls: 'text-slate-400 bg-slate-500/10', dot: 'bg-slate-500' },
}

const RISK_ORDER = ['conservative', 'balanced', 'aggressive'] as const
const RISK_BAR: Record<string, string> = { conservative: 'bg-teal-400', balanced: 'bg-indigo-400', aggressive: 'bg-rose-400' }
const RISK_TEXT: Record<string, string> = { conservative: 'text-teal-300', balanced: 'text-indigo-300', aggressive: 'text-rose-300' }

/** Compact duration since a timestamp: 45s / 6m / 2h / 3d. */
function since(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const PauseIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]"><rect x="6.5" y="5" width="4" height="14" rx="1.5" /><rect x="13.5" y="5" width="4" height="14" rx="1.5" /></svg>
)
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]"><path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5Z" /></svg>
)
const Spinner = ({ className = 'h-[18px] w-[18px]' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={`animate-spin ${className}`} aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
    <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
)

/** 3-segment risk meter, the active tier lit in its colour. */
function RiskMeter({ risk }: { risk: Bot['risk'] }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className="flex items-center gap-1">
        {RISK_ORDER.map((r) => <span key={r} className={`h-1.5 w-3 rounded-full ${r === risk ? RISK_BAR[r] : 'bg-white/10'}`} />)}
      </div>
      <span className={`text-[13px] font-semibold capitalize ${RISK_TEXT[risk]}`}>{risk}</span>
    </div>
  )
}

/** One labelled cell in the position/price/profit grid. */
function Cell({ label, value, valueCls }: { label: string; value: ReactNode; valueCls?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 truncate text-sm font-semibold tabular-nums ${valueCls ?? 'text-slate-100'}`}>{value}</div>
    </div>
  )
}

export default function BotCard({ bot, index = 0 }: { bot: Bot; index?: number }) {
  const { meta, control, archive, remove, selectBot, confirm, pendingByBot } = useStore()
  const [expanded, setExpanded] = useState(false)
  const net = meta?.networks.find((n) => n.id === bot.network)
  const strat = meta?.strategies.find((s) => s.id === bot.strategy)
  const st = STATUS[bot.status]
  const inPos = bot.position.qty > 0
  const pausable = bot.status === 'running' || bot.status === 'scheduled'
  // A lifecycle action is in flight for this bot — block its controls until it lands.
  const pending = pendingByBot[bot.id]
  const stopping = pending === 'stop'
  const toggling = pending === 'pause' || pending === 'resume'
  const busy = !!pending
  const paused = bot.status === 'paused'

  const typeLabel = bot.sniper ? '🎯 Sniper' : bot.copy ? '🐋 Copy' : bot.ai ? '🤖 AI' : strat?.name ?? bot.strategy
  const deployed = Math.max(0, bot.position.costUsd)
  const deployPct = bot.budgetUsd > 0 ? Math.max(0, Math.min(100, (deployed / bot.budgetUsd) * 100)) : 0
  const phase =
    bot.status === 'paused' ? 'Paused — not trading'
    : bot.status === 'stopped' ? 'Stopped'
    : bot.status === 'scheduled' ? 'Sleeping — outside its schedule'
    : inPos ? 'In position — managing the exit'
    : 'Flat — waiting for an entry signal'

  const stop = (e: ReactMouseEvent) => {
    e.stopPropagation()
    confirm({ message: `Stop "${bot.name}"? Any open position is sold and swept to ${bot.sweepTo === 'usdt' ? 'USDT' : net?.native.symbol}.`, confirmLabel: 'Stop & sweep', tone: 'danger' }).then((ok) => {
      if (ok) control(bot.id, 'stop')
    })
  }
  const del = (e: ReactMouseEvent) => {
    e.stopPropagation()
    confirm({ message: `Delete "${bot.name}" and its trade history?`, confirmLabel: 'Delete', tone: 'danger' }).then((ok) => {
      if (ok) remove(bot.id)
    })
  }
  const stopProp = (fn: () => void) => (e: ReactMouseEvent) => { e.stopPropagation(); fn() }

  return (
    <div
      className={`glass glass-hover card-lift animate-in group relative min-w-0 overflow-hidden ${stopping ? 'cursor-default' : 'cursor-pointer'} ${paused ? 'ring-1 ring-amber-400/40' : ''}`}
      style={index ? { animationDelay: `${Math.min(index, 12) * 45}ms` } : undefined}
      onClick={() => { if (!stopping) selectBot(bot.id) }}
      aria-busy={busy}
    >
      {/* Paused bots wear an unmistakable amber spine + ring (set above) so a stopped-trading
          bot never hides in a grid of running ones. */}
      {paused && <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-1 bg-amber-400/80" aria-hidden="true" />}

      {/* Stop & sweep is a real liquidation (on-chain in live mode) — cover the whole card
          with a blocking, spinner-lit overlay so it's obviously working and can't be
          double-clicked or navigated into mid-flight. */}
      {stopping && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-[var(--modal)]/85 backdrop-blur-[2px]" role="status" aria-live="polite">
          <Spinner className="h-7 w-7 text-amber-300" />
          <span className="text-sm font-semibold text-amber-200">Stopping &amp; sweeping…</span>
          <span className="text-[11px] text-slate-400">Selling the position and banking proceeds</span>
        </div>
      )}

      {/* Header — always visible */}
      <div className="flex items-center justify-between gap-2 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="token-avatar flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-lg font-bold text-[var(--ink)] shadow-md transition-transform duration-200 ease-out group-hover:scale-[1.06]" style={{ '--tok': net?.color ?? '#64748b' } as CSSProperties}>
            {(bot.token || '?').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold text-white">{bot.token || bot.name}</div>
            <div className="truncate text-[12px] text-slate-500">{net?.name ?? bot.network} · {bot.mode ?? 'paper'}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium ${st.cls}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
            {st.label}
          </span>
          <button
            onClick={stopProp(() => setExpanded((x) => !x))}
            aria-label={expanded ? 'Collapse card' : 'Expand card'}
            aria-expanded={expanded}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          >
            <svg viewBox="0 0 24 24" className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>
      </div>

      {!expanded ? (
        /* ── MINIMIZED ─────────────────────────────────────────────── */
        <div className="animate-in flex items-center justify-between gap-3 border-t border-white/[0.06] p-4">
          <div className="min-w-0">
            <div className={`text-[32px] font-bold leading-none tabular-nums ${pnlColor(bot.totalPnlUsd)}`}><CountUp value={bot.totalPnlUsd} format={fmtSign} /></div>
            <div className="mt-2 truncate text-[12px] text-slate-500">
              {inPos ? 'In position' : 'Flat'} · {bot.priceUsd ? fmtPrice(bot.priceUsd) : '—'} · {since(bot.createdAt)} · <span className="capitalize">{bot.risk}</span>
            </div>
          </div>
          <button
            onClick={stopProp(() => { if (!busy) control(bot.id, pausable ? 'pause' : 'resume') })}
            disabled={busy}
            title={pausable ? 'Pause' : 'Resume'}
            aria-label={pausable ? 'Pause' : 'Resume'}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-indigo-500/90 text-[var(--ink)] shadow transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-60 disabled:active:scale-100"
          >
            {toggling ? <Spinner /> : pausable ? <PauseIcon /> : <PlayIcon />}
          </button>
        </div>
      ) : (
        /* ── EXPANDED ──────────────────────────────────────────────── */
        <div className="animate-in space-y-3 border-t border-white/[0.06] p-4 pt-3">
          {/* Tags + risk meter */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="chip bg-white/[0.06] text-slate-300">{net?.name ?? bot.network} ({bot.mode ?? 'paper'})</span>
              <span className="chip bg-white/[0.06] text-slate-300">{typeLabel}</span>
              {bot.tournamentId && <span className="chip bg-amber-500/10 text-amber-300">🏆 tournament</span>}
              {bot.sniper && bot.riskReport && <RiskBadge report={bot.riskReport as RiskReport} />}
            </div>
            {!bot.sniper && <RiskMeter risk={bot.risk} />}
          </div>

          {/* Total P&L · Uptime */}
          <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-white/[0.06]">
            <div className="p-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Total P&L</div>
              <div className={`mt-1 text-[28px] font-bold leading-none tabular-nums ${pnlColor(bot.totalPnlUsd)}`}><CountUp value={bot.totalPnlUsd} format={fmtSign} /></div>
              <div className="mt-1.5 text-[11px] tabular-nums text-slate-500">R {fmtSign(bot.stats.realizedUsd)} · U {fmtSign(bot.unrealizedUsd)}</div>
            </div>
            <div className="border-l border-white/[0.06] p-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Uptime</div>
              <div className="mt-1 text-[28px] font-bold leading-none tabular-nums text-slate-100">{since(bot.createdAt)}</div>
              <div className="mt-1.5 text-[11px] text-slate-500">since launch</div>
            </div>
          </div>

          {/* Capital deployed + position grid */}
          <div className="rounded-xl border border-white/[0.06] p-3.5">
            <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide">
              <span className="text-slate-500">Capital deployed</span>
              <span className="tabular-nums text-emerald-300">{fmtUsd(deployed)} <span className="text-slate-600">/ {fmtUsd(bot.budgetUsd)}</span></span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/20 dark:bg-white/10">
              <div className="h-full rounded-full bg-emerald-400" style={{ width: `${deployPct}%` }} />
            </div>
            <div className="mt-2 text-[12px] text-slate-400">{phase}</div>
            <div className="mt-3 grid grid-cols-3 gap-3 border-t border-white/[0.06] pt-3">
              <Cell label="Position" value={inPos ? fmtUsd(bot.positionValueUsd) : 'Flat'} />
              <Cell label="Price" value={bot.priceUsd ? fmtPrice(bot.priceUsd) : '—'} />
              <Cell label="Profit taken" value={fmtUsd(bot.stats.nativeTakenUsd)} valueCls="text-cyan-300" />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={stopProp(() => { if (!busy) control(bot.id, pausable ? 'pause' : 'resume') })}
              disabled={busy}
              className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-500/90 px-4 text-sm font-semibold text-[var(--ink)] shadow transition-all hover:bg-indigo-500 active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100"
            >
              {toggling ? <Spinner /> : pausable ? <PauseIcon /> : <PlayIcon />} {toggling ? (pausable ? 'Pausing…' : 'Resuming…') : pausable ? 'Pause' : 'Resume'}
            </button>
            {bot.status !== 'stopped' && !bot.archived && (
              <button onClick={stop} disabled={busy} title="Sell everything and stop" className="btn-ghost min-h-11 flex-1 text-sm text-amber-300 disabled:opacity-60">
                <span className="flex items-center gap-1.5">{stopping ? <Spinner className="h-4 w-4" /> : <span className="h-3 w-3 rounded-[3px] bg-current" />} {stopping ? 'Stopping…' : 'Stop & sweep'}</span>
              </button>
            )}
            {bot.archived ? (
              <button onClick={stopProp(() => { if (!busy) archive(bot.id, false) })} disabled={busy} title="Bring back to active bots (stays paused)" className="btn-ghost min-h-11 shrink-0 !px-3 text-sm disabled:opacity-60">📤</button>
            ) : bot.status !== 'stopped' ? (
              <button onClick={stopProp(() => { if (!busy) archive(bot.id, true) })} disabled={busy} title="Archive — pause and tuck out of the active list" aria-label="Archive" className="btn-ghost min-h-11 shrink-0 !px-3 disabled:opacity-60">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></svg>
              </button>
            ) : null}
            <button onClick={del} disabled={busy} title="Delete bot and its history" aria-label="Delete" className="btn-ghost min-h-11 shrink-0 !px-3 text-rose-300 disabled:opacity-60">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
