import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { fmtUsd, fmtSign, pnlColor, parseAmount } from '../format'
import NetworkSelect from './NetworkSelect'

const INTERVALS = [1, 2, 4, 6, 12] // hours between snipes
// How new a coin must be to be eligible — the whole point of sniping. Values in HOURS.
const AGE_OPTIONS: { h: number; label: string }[] = [
  { h: 6, label: '6 hours' },
  { h: 24, label: '24 hours' },
  { h: 72, label: '3 days' },
  { h: 168, label: '7 days' },
  { h: 720, label: '30 days' },
]
/** Human label for a freshness window given in minutes. */
function fmtAge(min?: number): string {
  if (!min || min <= 0) return '3 days'
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

/** Compact MM:SS / Hh Mm countdown for the scan dial. */
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}:${String(sec).padStart(2, '0')}`
}

/**
 * Animated scan dial: a circular progress ring that fills toward the next snipe, with a
 * radar ping when the bot is actively hunting. `progress` is 0→1 (fraction of the entry
 * interval elapsed); `due` lights the hunting pulse.
 */
function ScanDial({ progress, due, primary, secondary }: { progress: number; due: boolean; primary: string; secondary: string }) {
  const R = 34
  const CIRC = 2 * Math.PI * R
  const p = Math.min(1, Math.max(0, progress))
  return (
    <div className="relative flex h-[92px] w-[92px] shrink-0 items-center justify-center">
      {due && (
        <>
          <span className="absolute inset-1 rounded-full bg-indigo-500/15 animate-ping" aria-hidden="true" />
          <span className="absolute inset-3 rounded-full bg-indigo-500/20 animate-ping [animation-delay:0.6s]" aria-hidden="true" />
        </>
      )}
      <svg viewBox="0 0 80 80" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="40" cy="40" r={R} className="fill-none stroke-white/10" strokeWidth="5" />
        <circle
          cx="40" cy="40" r={R}
          className={`fill-none ${due ? 'stroke-indigo-400' : 'stroke-cyan-300'}`}
          strokeWidth="5" strokeLinecap="round"
          strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - p)}
          style={{ transition: 'stroke-dashoffset 1s linear' }}
        />
      </svg>
      <div className="relative text-center leading-none">
        <div className="text-[13px] font-extrabold tabular-nums text-white">{primary}</div>
        <div className="mt-0.5 text-[8px] font-semibold uppercase tracking-wider text-slate-500">{secondary}</div>
      </div>
    </div>
  )
}

export default function AutoSniperPanel() {
  const { meta, autoSniper, refresh, confirm, mode, openSniper } = useStore()
  const [step, setStep] = useState(0) // setup-wizard step (0…3)
  const [network, setNetwork] = useState('base')
  const [maxAgeH, setMaxAgeH] = useState('72') // only snipe coins newer than this (hours)
  const [total, setTotal] = useState('300')
  const [per, setPer] = useState('50')
  const [intervalH, setIntervalH] = useState('2') // snipe one best coin every N hours
  const [deRisk, setDeRisk] = useState('100') // take the stake back at +this %
  const [runnerTrail, setRunnerTrail] = useState('30') // ride the runner, trail this % off peak
  const [sl, setSl] = useState('35') // catastrophic stop-loss
  const [giveUpH, setGiveUpH] = useState('24') // pre-de-risk: give up if still flat after N hours
  const [minLiq, setMinLiq] = useState('5000')
  const [sweepTo, setSweepTo] = useState<'native' | 'usdt'>('native')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const running = autoSniper?.enabled
  const totalNum = parseAmount(total)
  const perNum = parseAmount(per)
  const inputsValid = totalNum !== null && totalNum >= 10 && perNum !== null && perNum >= 10 && perNum <= totalNum

  // Tick once a second while running so the scan dial counts down smoothly between
  // the (slower) WS snapshots. Idle when stopped — no wasted timers.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  const start = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch('/api/auto-sniper', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          network, mode: 'new', // the auto-sniper always hunts the fresh-launch feed
          totalBudgetUsd: Number(total),
          perSnipeUsd: Number(per),
          minLiquidityUsd: Number(minLiq),
          maxAgeMinutes: Math.max(1, Number(maxAgeH) || 72) * 60, // snipe fresh launches only
          sweepTo,
          entryIntervalMs: Math.max(1, Number(intervalH) || 2) * 60 * 60 * 1000,
          config: {
            // Smart mode: de-risk to recover the stake, then ride the runner off its peak.
            deRiskAtPct: Number(deRisk),
            runnerTrailPct: Number(runnerTrail),
            stopLossPct: Number(sl),
            maxHoldMin: Math.max(1, Number(giveUpH) || 24) * 60, // pre-de-risk backstop
            takeProfitPct: Number(deRisk), // legacy fallback, kept aligned to the de-risk point
          },
        }),
      })
      const data = await r.json()
      if (data.error) {
        setErr(data.error)
        setBusy(false)
        return
      }
      await refresh()
      openSniper(false) // launched → close the modal; the campaign deploys in the background
    } catch {
      setErr('Engine unreachable')
      setBusy(false)
    }
  }

  const stop = async (liquidate: boolean) => {
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch('/api/auto-sniper/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ liquidate }),
      })
      if (!r.ok) throw new Error(`Request failed (${r.status})`)
      await refresh()
    } catch (e) {
      // A silent failure here would leave the auto-sniper running while the UI implies
      // it stopped — surface it instead. [audit]
      setErr(`Couldn't stop the auto-sniper — ${e instanceof Error ? e.message : 'engine unreachable'}. It may still be running; try again.`)
    }
    setBusy(false)
  }

  if (!meta) return null

  if (running && autoSniper) {
    const a = autoSniper
    const s = a.stats
    const allocated = a.totalBudgetUsd - a.poolUsd
    const deployedPct = Math.min(100, Math.max(0, (allocated / (a.totalBudgetUsd || 1)) * 100)) || 0
    const interval = a.entryIntervalMs && a.entryIntervalMs > 0 ? a.entryIntervalMs : 2 * 60 * 60_000
    const everyH = Math.round(interval / 3_600_000)
    const deRiskAt = a.config.deRiskAtPct
    const live = a.workspace === 'live'
    // Campaign progress: how many of the planned snipes have been deployed.
    const target = a.targetSnipes && a.targetSnipes > 0 ? a.targetSnipes : Math.max(1, Math.floor(a.totalBudgetUsd / a.perSnipeUsd))
    const opened = a.openedCount ?? 0
    const campaignPct = Math.min(100, Math.max(0, (opened / target) * 100))

    // Cadence/phase — drives the live dial + headline second-by-second.
    const lastEntry = a.lastEntryAt ?? 0
    const hasEntered = lastEntry > 0 // before the first snipe the bot enters on the very next scan
    const remaining = hasEntered ? Math.max(0, lastEntry + interval - now) : 0
    const slotsFull = s.active >= a.maxConcurrent
    const budgetDry = a.poolUsd < a.perSnipeUsd
    const blocked = slotsFull || budgetDry
    const hunting = (!hasEntered || remaining <= 0) && !blocked // due AND able to act → actively scanning to enter
    const progress = hunting || blocked ? 1 : 1 - remaining / interval
    const dialPrimary = hunting ? 'Now' : blocked ? 'Hold' : fmtCountdown(remaining)
    const dialSub = hunting ? 'hunting' : slotsFull ? 'slots full' : budgetDry ? 'low cash' : 'next snipe'
    const headline = hunting
      ? 'Hunting for the next launch…'
      : slotsFull
        ? `All ${a.maxConcurrent} snipe slots working`
        : budgetDry
          ? 'Budget fully deployed'
          : 'Locked on — next snipe loading'

    return (
      <div className="mt-3 space-y-3">
        {/* Hero: a live scanning radar + a state-aware headline that always says what it's doing. */}
        <div className="sniper-hero overflow-hidden rounded-2xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/[0.08] to-indigo-500/[0.05] p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400 pulse-dot" />
            <span className="text-sm font-bold text-emerald-200">Auto-Sniper running</span>
            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${live ? 'bg-rose-500/20 text-rose-300' : 'bg-slate-500/20 text-slate-300'}`}>
              {live ? '🔴 Live' : '📝 Paper'}
            </span>
            <span className="ml-auto text-[11px] capitalize text-slate-400">{a.network} · {a.mode}</span>
          </div>

          <div className="flex items-center gap-4">
            <ScanDial progress={progress} due={hunting} primary={dialPrimary} secondary={dialSub} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[15px] font-bold text-white">
                {hunting && <span className="inline-flex h-2 w-2 shrink-0 animate-ping rounded-full bg-indigo-400" />}
                <span className="min-w-0 truncate">{headline}</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                Deploying <strong className="text-slate-200">{target}</strong> snipes — one <strong className="text-slate-200">fresh-launch</strong> coin ≤<strong className="text-slate-200">{fmtAge(a.maxAgeMinutes)}</strong> old every <strong className="text-slate-200">{everyH}h</strong> at {fmtUsd(a.perSnipeUsd)} each, then the scan ends.
              </p>
              {deRiskAt ? (
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  Stake back at <strong className="text-slate-300">+{deRiskAt}%</strong>, then rides the runner — trailing {a.config.runnerTrailPct ?? 30}% off the peak.
                </p>
              ) : null}
            </div>
          </div>

          {/* Continuous scanning shimmer — a constant signal that the scanner is alive. */}
          <div className="scan-sweep relative mt-3 h-1 overflow-hidden rounded-full bg-white/10" aria-hidden="true" />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            // Campaign P&L = realized + unrealized mark-to-market on the open runners (matches
            // the single-bot view); falls back to realized for a pre-update server payload.
            { l: 'Campaign P&L', v: fmtSign(s.totalPnlUsd ?? s.realizedUsd), c: pnlColor(s.totalPnlUsd ?? s.realizedUsd) },
            // "Banked to vault" (NOT "profit"): nativeTakenUsd is value swept to the native vault,
            // which on a manual stop includes recovered principal — calling it profit would mislead.
            { l: 'Banked to vault', v: fmtUsd(s.nativeTakenUsd), c: 'text-cyan-300' },
            { l: 'Open runners', v: `${s.active}/${a.maxConcurrent}`, c: 'text-white' },
            { l: 'Coins vetted', v: String(a.triedCount ?? 0), c: 'text-slate-200' },
          ].map((x) => (
            <div key={x.l} className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{x.l}</div>
              <div className={`text-sm font-bold tabular-nums ${x.c}`}>{x.v}</div>
            </div>
          ))}
        </div>

        <div className="rounded-xl bg-white/[0.03] p-3">
          <div className="mb-1 flex justify-between text-[11px] text-slate-400">
            <span>Campaign · <strong className="text-slate-200">snipe {opened} of {target}</strong> deployed</span>
            <span className="tabular-nums">{fmtUsd(allocated)} out · {fmtUsd(a.poolUsd)} idle</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--border-strong)] dark:bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-[width] duration-500" style={{ width: `${campaignPct || deployedPct}%` }} />
          </div>
          <div className="mt-1 text-[10px] text-slate-600">
            {s.completed} closed · {s.wins}W / {s.losses}L{s.wins + s.losses ? ` · ${Math.round((s.wins / (s.wins + s.losses)) * 100)}% win` : ''}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost flex-1" disabled={busy} onClick={() => stop(false)} title="End the campaign — stop opening new snipes; open runners keep riding their own exits">
            ⏸ End campaign
          </button>
          <button className="btn-ghost flex-1 text-amber-300" disabled={busy} onClick={async () => { if (await confirm({ message: 'Stop and immediately sell all open auto-snipes to native?', confirmLabel: 'Stop & sell all', tone: 'danger' })) stop(true) }}>
            ⏹ Stop & sell all
          </button>
        </div>
      </div>
    )
  }

  // ── Not running → the setup WIZARD ─────────────────────────────────────────
  const target = totalNum && perNum && perNum > 0 ? Math.max(1, Math.floor(totalNum / perNum)) : 0
  const runHours = target * Number(intervalH || 2)
  const STEPS = ['Budget', 'Targets', 'Strategy', 'Review']
  const stepValid =
    step === 0 ? inputsValid
    : step === 1 ? Number(minLiq) >= 0
    : step === 2 ? Number(intervalH) > 0 && Number(deRisk) > 0 && Number(sl) > 0 && Number(giveUpH) > 0
    : true
  // A finished/stopped campaign lingers (enabled:false) — recap it above the next setup.
  const lastRun = autoSniper && !autoSniper.enabled ? autoSniper : null
  const lastDone = lastRun ? (lastRun.openedCount ?? 0) >= (lastRun.targetSnipes ?? 1) : false

  return (
    <div className="mt-3 space-y-3">
      {lastRun && (
        <div className="flex items-start gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 text-[11px] leading-relaxed">
          <span className="text-sm">{lastDone ? '✅' : '⏹️'}</span>
          <div className="min-w-0 flex-1 text-slate-400">
            Last campaign {lastDone ? 'complete' : 'stopped'} — deployed <strong className="text-slate-200">{lastRun.openedCount ?? 0}</strong> snipe(s),
            <strong className={pnlColor(lastRun.stats.realizedUsd)}> {fmtSign(lastRun.stats.realizedUsd)}</strong> realized · {fmtUsd(lastRun.stats.nativeTakenUsd)} to vault.
            {lastRun.stats.active > 0 && <> <strong className="text-slate-200">{lastRun.stats.active}</strong> still riding in your bots.</>}
          </div>
        </div>
      )}

      {/* Step indicator */}
      <div className="flex items-center gap-1">
        {STEPS.map((label, i) => (
          <div key={label} className="flex flex-1 items-center gap-1.5">
            <button
              onClick={() => i < step && setStep(i)}
              disabled={i > step}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors ${i < step ? 'bg-emerald-500/20 text-emerald-300' : i === step ? 'bg-indigo-500 text-white' : 'bg-white/[0.06] text-slate-500'}`}
            >
              {i < step ? '✓' : i + 1}
            </button>
            <span className={`whitespace-nowrap text-[11px] font-medium ${i === step ? 'text-white' : 'text-slate-500'}`}>{label}</span>
            {i < STEPS.length - 1 && <div className={`mx-1 hidden h-px flex-1 sm:block ${i < step ? 'bg-emerald-500/40' : 'bg-white/10'}`} />}
          </div>
        ))}
      </div>

      {/* ── Step 0 · Budget ── */}
      {step === 0 && (
        <div className="space-y-3">
          <div className="rounded-xl bg-indigo-500/10 p-3 text-xs leading-relaxed text-indigo-200">
            How much do you want to commit? The Auto-Sniper runs as a <strong>campaign</strong>: it spreads your budget across several snipes, one fresh launch at a time, then stops when it's all deployed.
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Total budget (USD)</span>
              <input className="input" type="number" min={10} value={total} onChange={(e) => setTotal(e.target.value)} autoFocus />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Per snipe (USD)</span>
              <input className="input" type="number" min={10} value={per} onChange={(e) => setPer(e.target.value)} />
            </label>
          </div>
          {inputsValid ? (
            <div className="rounded-xl bg-white/[0.03] p-2.5 text-[11px] text-slate-400">
              Deploys <strong className="text-slate-200">{fmtUsd(totalNum!)}</strong> across <strong className="text-slate-200">{target}</strong> snipe{target === 1 ? '' : 's'} of {fmtUsd(perNum!)} — one every {intervalH || 2}h, so the campaign runs ~<strong className="text-slate-200">{runHours}h</strong> before the scan ends.
            </div>
          ) : (
            <div className="rounded-xl bg-amber-500/10 p-2.5 text-[11px] text-amber-300">Budget must be ≥ $10, and per-snipe between $10 and the total.</div>
          )}
        </div>
      )}

      {/* ── Step 1 · Targets ── */}
      {step === 1 && (
        <div className="space-y-3">
          <div className="rounded-xl bg-indigo-500/10 p-3 text-xs leading-relaxed text-indigo-200">
            Where and what to hunt. Every candidate must pass the full honeypot / rug / holder screen, and only <strong>freshly launched</strong> coins are eligible.
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Network</span>
              <NetworkSelect className="input" value={network} onChange={setNetwork} networks={meta.networks.filter((n) => n.evm !== false && n.tradeable !== false)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Max coin age</span>
              <select className="input" value={maxAgeH} onChange={(e) => setMaxAgeH(e.target.value)}>
                {AGE_OPTIONS.map((o) => <option key={o.h} value={o.h}>{o.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Min liquidity (USD)</span>
              <input className="input" type="number" value={minLiq} onChange={(e) => setMinLiq(e.target.value)} />
            </label>
          </div>
        </div>
      )}

      {/* ── Step 2 · Strategy ── */}
      {step === 2 && (
        <div className="space-y-3">
          <div className="rounded-xl bg-indigo-500/10 p-3 text-xs leading-relaxed text-indigo-200">
            How each snipe is traded. Once a coin is up <strong>+{deRisk || 100}%</strong> it sells enough to take your stake back to safety, then rides the rest — trailing {runnerTrail || 30}% off the peak (no timer).
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-400">Snipe every</span>
              <select className="input !py-2 text-sm" value={intervalH} onChange={(e) => setIntervalH(e.target.value)}>
                {INTERVALS.map((h) => <option key={h} value={h}>{h}h</option>)}
              </select>
            </label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Take stake back at +%</span><input className="input !py-2 text-sm" type="number" value={deRisk} onChange={(e) => setDeRisk(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Runner trail % off peak</span><input className="input !py-2 text-sm" type="number" value={runnerTrail} onChange={(e) => setRunnerTrail(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Stop-loss %</span><input className="input !py-2 text-sm" type="number" value={sl} onChange={(e) => setSl(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Give up if flat (h)</span><input className="input !py-2 text-sm" type="number" value={giveUpH} onChange={(e) => setGiveUpH(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Auto-sell proceeds to</span>
              <select className="input !py-2 text-sm" value={sweepTo} onChange={(e) => setSweepTo(e.target.value as 'native' | 'usdt')}>
                <option value="native">Native coin</option>
                <option value="usdt">USDT (stable)</option>
              </select>
            </label>
          </div>
        </div>
      )}

      {/* ── Step 3 · Review ── */}
      {step === 3 && (
        <div className="space-y-3">
          {mode === 'live' && (
            <div className="rounded-xl border border-rose-400/40 bg-rose-500/[0.08] p-3 text-xs leading-relaxed text-rose-200">
              🔴 <strong>Live workspace</strong> — this campaign trades <strong>real funds on-chain</strong>, bounded by your live-spend caps + the circuit breaker. It stays pinned to live even while you view paper.
            </div>
          )}
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Campaign summary</div>
            <div className="grid grid-cols-1 gap-x-5 gap-y-1.5 text-xs sm:grid-cols-2">
              {([
                ['Budget', `${fmtUsd(totalNum ?? 0)} · ${target} × ${fmtUsd(perNum ?? 0)}`],
                ['Network', `${network} · fresh launches`],
                ['Max coin age', fmtAge(Number(maxAgeH) * 60)],
                ['Cadence', `one every ${intervalH}h · ~${runHours}h total`],
                ['Take stake back', `+${deRisk}%`],
                ['Runner trail', `${runnerTrail}% off peak`],
                ['Stop-loss', `−${sl}%`],
                ['Give up if flat', `${giveUpH}h`],
                ['Proceeds to', sweepTo === 'usdt' ? 'USDT' : 'native coin'],
              ] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 border-b border-white/[0.04] pb-1">
                  <span className="text-slate-500">{k}</span>
                  <span className="text-right font-medium text-slate-200">{v}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500">
            On launch this closes and the campaign runs in the background — one snipe every {intervalH}h until all {target} are deployed, then the scan stops and the runners ride on in your bots. You can stop it any time.
          </p>
        </div>
      )}

      {err && <div className="rounded-xl bg-rose-500/10 p-2.5 text-xs text-rose-300">{err}</div>}

      {/* Wizard nav */}
      <div className="flex items-center gap-2 pt-1">
        {step > 0 && <button className="btn-ghost" disabled={busy} onClick={() => setStep((s) => s - 1)}>← Back</button>}
        {step < STEPS.length - 1 ? (
          <button className="btn-primary ml-auto" disabled={!stepValid} onClick={() => setStep((s) => s + 1)}>Next →</button>
        ) : (
          <button className="btn-primary ml-auto" disabled={busy || !inputsValid} onClick={start}>
            {busy ? 'Launching…' : `🤖 Launch campaign · ${fmtUsd(totalNum ?? 0)}`}
          </button>
        )}
      </div>
      <p className="text-[10px] leading-relaxed text-slate-600">
        Auto-trading new tokens is high-risk even with screening. Use a budget you can afford to lose; you can stop (and liquidate to native) any time.
      </p>
    </div>
  )
}
