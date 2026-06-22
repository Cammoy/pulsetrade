import { useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { fmtUsd } from '../format'

const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/** One spend-limit tile: a remaining/cap readout + a colour-coded headroom bar. */
function LimitTile({ label, remaining, cap, envVar }: { label: string; remaining: number; cap: number; envVar: string }) {
  const pct = cap > 0 ? Math.max(0, Math.min(100, (remaining / cap) * 100)) : 0
  const bar = pct > 50 ? 'bg-emerald-400' : pct > 15 ? 'bg-amber-400' : 'bg-rose-400'
  return (
    <div className="tile-sunken rounded-lg px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      {cap > 0 ? (
        <>
          <div className="mt-0.5 tabular-nums">
            <span className="text-[15px] font-bold text-slate-100">{fmtUsd(remaining)}</span>
            <span className="text-[10px] text-slate-500"> / {fmtUsd(cap)}</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/20 dark:bg-white/10">
            <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
          </div>
        </>
      ) : (
        <div className="mt-0.5 text-[12px] font-semibold text-amber-300" title={`No cap set — set ${envVar} to limit spend`}>⚠ No limit set</div>
      )}
    </div>
  )
}

/** Visual body for the switch-to-Live confirm: balance + spend limits at a glance. */
function LiveSwitchBody({ wallet, balanceUsd, dayCap, dayRemaining, totalCap, totalRemaining, turnkey }: {
  wallet: string | null
  balanceUsd: number | null
  dayCap: number
  dayRemaining: number
  totalCap: number
  totalRemaining: number
  turnkey: boolean
}) {
  return (
    <div className="space-y-3 text-left">
      <div className="flex items-start gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-[12px] leading-snug text-rose-700 dark:text-rose-200">
        <span aria-hidden className="mt-px">⚠️</span>
        <span>New bots here trade <strong className="font-semibold">real funds</strong> on-chain — not a simulation. Your paper bots keep running untouched.</span>
      </div>

      <div className="tile-sunken rounded-lg px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Live wallet</span>
          {wallet && <span className="font-mono text-[10px] text-slate-500">{shortAddr(wallet)}</span>}
        </div>
        <div className="mt-0.5 text-[22px] font-bold tabular-nums tracking-tight text-slate-100">{balanceUsd != null ? fmtUsd(balanceUsd) : '—'}</div>
        <div className="text-[10px] text-slate-500">{balanceUsd != null ? 'balance across all chains' : 'balance unavailable right now'}</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <LimitTile label="Daily limit" remaining={dayRemaining} cap={dayCap} envVar="MAX_LIVE_USD_PER_DAY" />
        <LimitTile label="Total budget" remaining={totalRemaining} cap={totalCap} envVar="MAX_LIVE_USD_TOTAL" />
      </div>

      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="chip bg-violet-500/15 text-violet-300">🔐 {turnkey ? 'Turnkey signer' : 'Local key'}</span>
        <span className="text-slate-500">Fund only what you can risk · start small</span>
      </div>
    </div>
  )
}

/**
 * Paper / Live segmented toggle — the single source of truth for switching
 * trading modes, shared by the mobile Header and the desktop ChannelHeader.
 * Keeps the live-mode confirm guard and the "locked unless a signer exists"
 * messaging in one place so the two chromes can never drift apart.
 */
export default function ModeSwitch({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const { mode, setMode, meta, notify, confirm } = useStore()
  const liveReady = !!meta?.live.ready
  const turnkey = meta?.live.evm?.signer === 'turnkey' || meta?.live.solana?.signer === 'turnkey'

  // Slide a single pill under the active segment (measured, so it tracks the variable-width
  // Paper/Live buttons — and re-measures when the labels show/hide at the sm breakpoint).
  const trackRef = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ left: number; width: number }>({ left: 0, width: 0 })
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const measure = () => {
      const active = track.querySelector(`button[data-mode="${mode}"]`) as HTMLElement | null
      if (active) setPill({ left: active.offsetLeft, width: active.offsetWidth })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    return () => ro.disconnect()
  }, [mode, liveReady, size])

  const switchMode = async (m: 'paper' | 'live') => {
    if (m === mode) return
    if (m === 'live') {
      if (!liveReady) {
        notify(
          '🔒 Live trading is locked. Add a signer to server/.env, then restart the engine: EVM = ZEROX_API_KEY + BOT_WALLET_KEY (or Turnkey: TURNKEY_API_* + TURNKEY_EVM_ADDRESS), Solana = SOLANA_WALLET_KEY (or Turnkey + TURNKEY_SOLANA_ADDRESS). Paper mode needs no keys.',
          'error',
        )
        return
      }
      // Surface the REAL account up front so the user knows exactly what they're arming:
      // the live wallet balance + the spend limits the engine will enforce. The balance is
      // best-effort (a slow multi-chain RPC must never block the switch); the limits come
      // straight from meta and are always shown.
      // Best-effort balance fetch (a slow multi-chain RPC must never block the switch);
      // the limits come straight from meta and always render.
      let balanceUsd: number | null = null
      const w = meta?.live.evm?.wallet ?? null
      if (w) {
        try {
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), 2500)
          const r = await fetch(`/api/wallet/${w}`, { signal: ctrl.signal })
          clearTimeout(t)
          if (r.ok) {
            const p = await r.json()
            if (typeof p?.totalUsd === 'number') balanceUsd = p.totalUsd
          }
        } catch {
          /* balance is best-effort */
        }
      }
      const dayCap = meta?.live.maxUsdPerDay ?? 0
      const totalCap = meta?.live.maxLiveUsdTotal ?? 0
      const ok = await confirm({
        title: 'Switch to the Live workspace?',
        body: (
          <LiveSwitchBody
            wallet={w}
            balanceUsd={balanceUsd}
            dayCap={dayCap}
            dayRemaining={Math.max(0, dayCap - (meta?.live.spentTodayUsd ?? 0))}
            totalCap={totalCap}
            totalRemaining={Math.max(0, totalCap - (meta?.live.breaker?.spentUsd ?? 0))}
            turnkey={turnkey}
          />
        ),
        confirmLabel: 'Switch to Live',
        cancelLabel: 'Stay on Paper',
        tone: 'danger',
      })
      if (!ok) return
    }
    const out = await setMode(m)
    if (out.error) {
      notify(out.error, 'error')
      return
    }
    notify(m === 'live' ? 'Live workspace — new bots here trade real funds' : 'Paper workspace — simulated fills', m === 'live' ? 'info' : 'success')
  }

  const pad = size === 'sm' ? 'px-2 py-1' : 'px-2.5 py-1.5 sm:px-3'
  return (
    <div ref={trackRef} className="seg-track relative flex items-center p-0.5 text-xs">
      {/* The sliding active indicator — glides + cross-fades its colour between segments. */}
      {pill.width > 0 && (
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-y-0.5 left-0 rounded-[10px] shadow transition-[transform,width,background-color] duration-300 ${mode === 'live' ? 'bg-rose-500/90' : 'bg-indigo-500/90'}`}
          style={{ width: pill.width, transform: `translateX(${pill.left}px)`, transitionTimingFunction: 'var(--ease-out)' }}
        />
      )}
      {(['paper', 'live'] as const).map((m) => {
        const locked = m === 'live' && !liveReady
        return (
          <button
            key={m}
            data-mode={m}
            onClick={() => switchMode(m)}
            aria-pressed={mode === m}
            className={`relative z-10 cursor-pointer whitespace-nowrap rounded-[10px] font-semibold transition-colors ${pad} ${locked ? 'opacity-60' : ''} ${
              mode === m ? 'text-[var(--ink)]' : 'text-slate-400 hover:text-slate-200'
            }`}
            title={locked ? 'Live trading locked — click to see which wallet keys to add to server/.env' : m === 'live' ? 'Arm real on-chain trading' : 'Simulated fills — no real funds'}
          >
            {m === 'paper' ? '📝' : locked ? '🔒' : '🔴'}
            <span className="hidden sm:inline">&nbsp;{m === 'paper' ? 'Paper' : 'Live'}</span>
          </button>
        )
      })}
    </div>
  )
}
