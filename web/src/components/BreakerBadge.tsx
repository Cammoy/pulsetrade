import { useStore } from '../store'
import { fmtSign, fmtUsd, pnlColor } from '../format'

/**
 * "⛔ HALTED · reset" badge — renders only when the account circuit breaker
 * (the live-trading safety net) has tripped. Clicking RESETS it (clears the halt +
 * zeroes the loss/spend counters) after an explicit confirm; live bots stay paused
 * until the operator resumes them. Shared by the mobile Header and the desktop chrome.
 */
export default function BreakerBadge({ block = false }: { block?: boolean }) {
  const { meta, breaker: liveBreaker, notify, refresh, confirm } = useStore()
  // Prefer the LIVE breaker from the WS snapshot (kept fresh as it trips / re-arms);
  // fall back to the boot-time meta value for the very first paint before a snapshot.
  const breaker = liveBreaker ?? meta?.live.breaker
  if (!breaker?.tripped) return null

  const reset = async () => {
    const ok = await confirm({
      title: 'Reset the safety breaker?',
      body: (
        <div className="mt-1 space-y-3 text-[13px] leading-relaxed text-slate-300">
          <p>
            The account safety breaker <strong className="text-white">paused every live bot</strong>. It stops live trading the
            moment a hard limit is hit — <em>before</em> an over-spend, or once losses cross your cap — so the account can’t keep
            bleeding. Paper bots keep running normally.
          </p>
          <div className="rounded-lg bg-white/[0.04] p-2.5">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Why it tripped</div>
            <div className="text-slate-300">{breaker?.reason || 'a live safety limit was hit'}</div>
          </div>
          <div className="flex gap-6">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">Live P&amp;L since arming</div>
              <div className={`text-sm font-bold tabular-nums ${pnlColor(breaker?.realizedUsd ?? 0)}`}>{fmtSign(breaker?.realizedUsd ?? 0)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">Real money spent</div>
              <div className="text-sm font-bold tabular-nums text-slate-200">{fmtUsd(breaker?.spentUsd ?? 0)}</div>
            </div>
          </div>
          <p className="text-slate-400">
            Resetting clears the halt and zeroes these two counters.{' '}
            <strong className="text-amber-300">Fix what tripped it first</strong> — shrink or delete the over-budget live bot, or
            raise the spend cap — or it trips straight back. Your live bots stay <strong>paused</strong>; resume the ones you want afterwards.
          </p>
        </div>
      ),
      confirmLabel: 'Reset breaker',
      tone: 'danger',
    })
    if (!ok) return
    const r = await fetch('/api/breaker/reset', { method: 'POST' })
    if (!r.ok) return notify('Reset failed', 'error')
    // Clear immediately (don't wait on the next ~20s snapshot): reset the live breaker
    // and pull fresh meta too, so the badge disappears the moment the reset succeeds.
    useStore.setState({ breaker: { tripped: false, reason: '', trippedAt: null, realizedUsd: 0, spentUsd: 0 } })
    const m = await fetch('/api/meta').then((x) => x.json()).catch(() => null)
    if (m) useStore.setState({ meta: m })
    await refresh().catch(() => {})
    notify('Safety breaker reset — live trading allowed again. Your live bots stay paused; resume the ones you want.', 'success')
  }

  return (
    <button
      onClick={reset}
      title={`Live trading halted: ${breaker.reason}. Click to reset the safety breaker.`}
      className={`inline-flex items-center justify-center gap-1 rounded-lg border border-rose-400/50 bg-rose-500/20 px-2 py-1 text-[11px] font-bold text-rose-300 animate-pulse ${block ? 'w-full' : ''}`}
    >
      ⛔ HALTED · reset
    </button>
  )
}
