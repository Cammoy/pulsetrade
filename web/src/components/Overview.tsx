import type { ReactNode } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { aggregateStats, botsForMode } from '../stats'
import { fmtUsd, fmtSign, pnlColor, ASSET_COLORS } from '../format'
import Sparkline from './Sparkline'
import DonutCard from './DonutCard'
import CountUp from '../useCountUp'
import StatsBar from './StatsBar'
import type { Bot } from '../types'

/** The whole operation at a glance: headline KPIs, equity trend, live-safety status,
 *  capital allocation, automation, and best/worst performers — scoped to the active
 *  workspace. All from the WebSocket-refreshed store, so it updates in real time. */

function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="glass p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">{title}</h3>
        {right}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  )
}

/** Portfolio equity trend = the sum of each bot's equity history, aligned from the most
 *  recent point back (bots share the engine tick cadence, so this lines up cleanly). */
function aggregateEquity(bots: Bot[]): number[] {
  const hists = bots.map((b) => b.equityHistory).filter((h) => h.length >= 2)
  if (!hists.length) return []
  const k = Math.min(...hists.map((h) => h.length))
  if (k < 2) return []
  const out: number[] = []
  for (let i = 0; i < k; i++) {
    let s = 0
    for (const h of hists) s += h[h.length - k + i].v
    out.push(+s.toFixed(2))
  }
  return out
}

function PerfRow({ b }: { b: Bot }) {
  return (
    <button
      onClick={() => useStore.getState().selectBot(b.id)}
      className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-white/[0.04]"
    >
      <span className="min-w-0 flex-1 truncate text-slate-300">{b.name}</span>
      <span className={`shrink-0 font-semibold tabular-nums ${pnlColor(b.totalPnlUsd)}`}>{fmtSign(b.totalPnlUsd)}</span>
    </button>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-slate-400">{label}</span>
      <span className="tabular-nums text-slate-200">{value}</span>
    </div>
  )
}

export default function Overview() {
  const { bots, mode, meta, breaker, autoSniper, tournaments, follows, wsOk } = useStore(
    useShallow((s) => ({
      bots: s.bots, mode: s.mode, meta: s.meta, breaker: s.breaker,
      autoSniper: s.autoSniper, tournaments: s.tournaments, follows: s.follows, wsOk: s.wsOk,
    })),
  )
  const byMode = botsForMode(bots, mode)
  const agg = aggregateStats(byMode)
  const equitySeries = aggregateEquity(byMode)
  const currentEquity = byMode.reduce((s, b) => s + b.cashUsd + b.positionValueUsd + b.stats.nativeTakenUsd, 0)
  const unrealized = byMode.reduce((s, b) => s + b.unrealizedUsd, 0)

  // Capital allocation: open-position value per token + idle cash.
  const byToken = new Map<string, number>()
  for (const b of byMode) if (b.positionValueUsd > 0.01) byToken.set(b.token, (byToken.get(b.token) ?? 0) + b.positionValueUsd)
  const allocSegs = [...byToken.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({ label, value: +value.toFixed(2), color: ASSET_COLORS[i % ASSET_COLORS.length] }))
  const idleCash = +byMode.reduce((s, b) => s + Math.max(0, b.cashUsd), 0).toFixed(2)
  allocSegs.push({ label: 'Idle cash', value: idleCash, color: '#475569' })
  const allocTotal = allocSegs.reduce((s, x) => s + x.value, 0)

  // Best / worst active performers.
  const ranked = byMode.filter((b) => b.status !== 'stopped').sort((a, b) => b.totalPnlUsd - a.totalPnlUsd)
  const best = ranked.slice(0, 3)
  const worst = ranked.length > 4 ? ranked.slice(-2).reverse() : []

  const liveBreaker = breaker ?? meta?.live?.breaker ?? null
  const cap = meta?.live?.maxUsdPerDay ?? 0
  const spent = meta?.live?.spentTodayUsd ?? 0
  const autoActive = autoSniper && autoSniper.stats ? autoSniper.stats.active : 0

  return (
    <div className="space-y-4">
      <StatsBar />

      <div className="grid gap-3 lg:grid-cols-3">
        {/* Portfolio equity + trend */}
        <Card title="Portfolio equity" right={<span className={`text-xs font-semibold tabular-nums ${pnlColor(agg.totalPnl)}`}>{fmtSign(agg.totalPnl)} P&L</span>}>
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="text-2xl font-bold tabular-nums text-white">
                <CountUp value={currentEquity} format={fmtUsd} />
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {fmtSign(unrealized)} unrealized · {fmtUsd(agg.native)} taken
              </div>
            </div>
            {equitySeries.length >= 2 ? (
              <Sparkline points={equitySeries} width={150} height={48} baseline={equitySeries[0]} />
            ) : (
              <span className="self-center text-[11px] text-slate-600">gathering data…</span>
            )}
          </div>
        </Card>

        {/* Live-safety status */}
        <Card
          title="Status"
          right={<span className={`chip ${mode === 'live' ? 'bg-rose-500/15 text-rose-300' : 'bg-indigo-500/15 text-indigo-300'}`}>{mode === 'live' ? 'LIVE' : 'PAPER'}</span>}
        >
          {liveBreaker?.tripped ? (
            <div className="rounded-lg bg-rose-500/[0.12] px-3 py-2 text-xs leading-snug text-rose-200 ring-1 ring-rose-500/25">
              ⛔ HALTED — {liveBreaker.reason || 'circuit breaker tripped'}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <span className={`h-2 w-2 rounded-full ${wsOk ? 'bg-emerald-400 pulse-dot' : 'bg-rose-400'}`} />
              {wsOk ? 'Engine live' : 'Reconnecting…'} · {agg.activeCount}/{agg.total} bots active
            </div>
          )}
          {mode === 'live' && cap > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-[11px] text-slate-500">
                <span>Daily live spend</span>
                <span className="tabular-nums">{fmtUsd(spent)} / {fmtUsd(cap)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div className={`h-full rounded-full ${spent / cap > 0.85 ? 'bg-rose-400' : 'bg-indigo-400'}`} style={{ width: `${Math.min(100, (spent / cap) * 100)}%` }} />
              </div>
            </div>
          )}
        </Card>

        {/* Automation */}
        <Card title="Automation">
          <div className="space-y-1.5">
            {autoSniper ? <StatRow label="🎯 Auto-Sniper" value={`${autoActive} active · ${fmtSign(autoSniper.stats.realizedUsd)}`} /> : null}
            {tournaments.length > 0 ? <StatRow label="🏆 Tournaments" value={`${tournaments.length}`} /> : null}
            {follows.length > 0 ? <StatRow label="🐋 Copy-follows" value={`${follows.length}`} /> : null}
            {!autoSniper && tournaments.length === 0 && follows.length === 0 && <p className="text-xs text-slate-600">Nothing automated yet — start an Auto-Sniper, tournament, or copy-follow.</p>}
          </div>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {allocTotal > 0 ? (
          <DonutCard title="Capital allocation" segments={allocSegs} total={allocTotal} />
        ) : (
          <Card title="Capital allocation"><p className="text-xs text-slate-600">No capital deployed yet.</p></Card>
        )}

        <Card title="Performers">
          {ranked.length === 0 ? (
            <p className="text-xs text-slate-600">No bots in this workspace yet.</p>
          ) : (
            <div className="space-y-1">
              {best.map((b) => <PerfRow key={b.id} b={b} />)}
              {worst.length > 0 && <div className="my-1 h-px bg-white/[0.06]" />}
              {worst.map((b) => <PerfRow key={b.id} b={b} />)}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
