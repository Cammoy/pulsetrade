import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useModal } from '../useModal'
import { computeTrade, seedLevels, type Direction } from '../signalMath'
import { fmtPrice, fmtUsd, parseAmount } from '../format'
import type { CoinHit } from '../types'

/**
 * The trade ticket: configure your OWN entry zone, leverage, stop-loss and TP1/2/3 for a
 * trade and track it. Reached three ways — from a posted signal, from a radar candidate, or
 * from scratch via the coin picker (when no coin is preset). Everything recomputes live
 * (R:R, risk-based position size, margin, isolated liquidation estimate, $ at each target),
 * an invalid plan is blocked with the reason, and "Track" hands it to the engine, which
 * monitors the levels and alerts on a hit. Advisory — it never places the order.
 */

export interface TicketInit {
  editingId?: string // set ⇒ editing an existing tracked trade
  symbol: string // empty ⇒ "new" mode: show the coin picker
  cgId: string
  direction: Direction
  entryLow: number
  entryHigh: number
  stopLoss: number
  tp1: number
  tp2: number
  tp3: number
  leverage: number
  refPrice?: number
  confidence?: number
  sentimentScore?: number
  rationale?: string
}

export default function SignalTicket({ init, account, riskPct, onClose }: { init: TicketInit; account: number; riskPct: number; onClose: () => void }) {
  useModal(onClose)
  const trackTrade = useStore((s) => s.trackTrade)
  const updateTracked = useStore((s) => s.updateTracked)
  const openPerp = useStore((s) => s.openPerp)
  const notify = useStore((s) => s.notify)

  const isNew = !init.cgId // no coin preset ⇒ pick one first
  const [coin, setCoin] = useState<{ symbol: string; cgId: string } | null>(init.cgId ? { symbol: init.symbol, cgId: init.cgId } : null)
  const [seedPrice, setSeedPrice] = useState(init.refPrice ?? 0)
  const [direction, setDirection] = useState<Direction>(init.direction)
  const [f, setF] = useState({
    entryLow: numStr(init.entryLow),
    entryHigh: numStr(init.entryHigh),
    stopLoss: numStr(init.stopLoss),
    tp1: numStr(init.tp1),
    tp2: numStr(init.tp2),
    tp3: numStr(init.tp3),
  })
  const [leverage, setLeverage] = useState(init.leverage)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (v: string) => setF((prev) => ({ ...prev, [k]: v }))

  // ── Coin picker (new mode) ──
  const [q, setQ] = useState('')
  const [results, setResults] = useState<CoinHit[]>([])
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    if (coin || q.trim().length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    let alive = true
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/coins/search?q=${encodeURIComponent(q.trim())}`)
        const j = await r.json()
        if (alive) setResults(Array.isArray(j.coins) ? j.coins : [])
      } catch {
        if (alive) setResults([])
      } finally {
        if (alive) setSearching(false)
      }
    }, 250)
    // Cancel the timer AND ignore an in-flight response for a superseded query, so a slow
    // older search can't overwrite the results of a newer one. [search-race]
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, coin])

  const applySeed = (dir: Direction, price: number) => {
    const s = seedLevels(dir, price)
    setF({ entryLow: numStr(s.entryLow), entryHigh: numStr(s.entryHigh), stopLoss: numStr(s.stopLoss), tp1: numStr(s.tp1), tp2: numStr(s.tp2), tp3: numStr(s.tp3) })
  }

  const pickSeq = useRef(0)
  const pickCoin = async (hit: CoinHit) => {
    const seq = ++pickSeq.current // supersede any earlier in-flight pick
    setCoin({ symbol: hit.symbol, cgId: hit.id })
    setResults([])
    setQ('')
    // Fetch the live price to seed sensible default levels around it.
    try {
      const m = await fetch(`/api/coin/${encodeURIComponent(hit.id)}`).then((r) => r.json())
      if (seq !== pickSeq.current) return // a newer pick landed first — don't seed the wrong coin [pick-race]
      const price = Number(m?.priceUsd)
      if (Number.isFinite(price) && price > 0) {
        setSeedPrice(price)
        applySeed(direction, price)
      }
    } catch {
      /* keep zeros — the user can type levels manually */
    }
  }

  const changeDirection = (d: Direction) => {
    setDirection(d)
    if (isNew && seedPrice > 0) applySeed(d, seedPrice) // fresh trade ⇒ re-seed for the new side
  }

  const reset = () => {
    if (isNew && coin && seedPrice > 0) {
      applySeed(direction, seedPrice)
    } else {
      setDirection(init.direction)
      setLeverage(init.leverage)
      setF({ entryLow: numStr(init.entryLow), entryHigh: numStr(init.entryHigh), stopLoss: numStr(init.stopLoss), tp1: numStr(init.tp1), tp2: numStr(init.tp2), tp3: numStr(init.tp3) })
    }
  }

  const plan = {
    direction,
    entryLow: parseAmount(f.entryLow) ?? NaN,
    entryHigh: parseAmount(f.entryHigh) ?? NaN,
    stopLoss: parseAmount(f.stopLoss) ?? NaN,
    tp1: parseAmount(f.tp1) ?? NaN,
    tp2: parseAmount(f.tp2) ?? NaN,
    tp3: parseAmount(f.tp3) ?? NaN,
    leverage,
  }
  const calc = useMemo(() => computeTrade(plan, account, riskPct), [f, direction, leverage, account, riskPct])

  const submit = async () => {
    if (!coin || !calc.valid || busy) return
    setBusy(true)
    const payload = {
      symbol: coin.symbol,
      cgId: coin.cgId,
      direction,
      entryLow: plan.entryLow,
      entryHigh: plan.entryHigh,
      stopLoss: plan.stopLoss,
      tp1: plan.tp1,
      tp2: plan.tp2,
      tp3: plan.tp3,
      leverageMin: leverage,
      leverageMax: leverage,
      refPrice: seedPrice || init.refPrice,
      confidence: init.confidence,
      sentimentScore: init.sentimentScore,
      rationale: init.rationale,
    }
    const out = init.editingId ? await updateTracked(init.editingId, payload) : await trackTrade(payload)
    setBusy(false)
    if (!out.error) {
      if (!init.editingId) notify(`📍 Tracking ${coin.symbol}/USDT ${direction}`, 'success')
      onClose()
    }
  }

  // Open a (paper) perp at market with the ticket's leverage, risk-based margin, stop + TP1.
  const openPosition = async () => {
    if (!coin || !calc.valid || busy) return
    if (!(calc.marginUsd > 0)) {
      notify('Set an account size + risk in the position-sizing bar first', 'error')
      return
    }
    setBusy(true)
    const out = await openPerp({
      symbol: coin.symbol,
      cgId: coin.cgId,
      side: direction === 'LONG' ? 'long' : 'short',
      leverage,
      marginUsd: calc.marginUsd,
      stopLoss: plan.stopLoss,
      takeProfit: plan.tp1,
      reason: init.rationale,
    })
    setBusy(false)
    if (!out.error) onClose()
  }

  const rrColor = calc.riskReward >= 2 ? 'text-emerald-400' : calc.riskReward >= 1.5 ? 'text-lime-400' : 'text-amber-400'

  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onClick={onClose}>
      <div className="animate-in glass max-h-[92vh] w-full max-w-lg overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-white">{init.editingId ? 'Edit trade' : 'Set up a trade'}</span>
          {coin && <span className="text-sm font-semibold text-slate-300">{coin.symbol}/USDT</span>}
          <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-white/[0.06] hover:text-white" aria-label="Close">✕</button>
        </div>

        {/* coin picker (new mode, until a coin is chosen) */}
        {!coin && (
          <div className="mt-3">
            <label className="mb-1 block text-[11px] text-slate-400">Choose a coin</label>
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 focus-within:border-indigo-400/60">
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any coin (e.g. bitcoin, sol, pepe)…" aria-label="Search coin" className="w-full bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-600" />
            </div>
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {searching && <div className="px-1 py-2 text-[12px] text-slate-500">Searching…</div>}
              {!searching && q.trim().length >= 2 && results.length === 0 && <div className="px-1 py-2 text-[12px] text-slate-600">No coins match “{q}”.</div>}
              {results.map((c) => (
                <button key={c.id} onClick={() => pickCoin(c)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]">
                  {c.thumb ? <img src={c.thumb} alt="" className="h-5 w-5 rounded-full" /> : <span className="h-5 w-5 rounded-full bg-white/[0.06]" />}
                  <span className="text-[13px] font-semibold text-slate-100">{c.symbol}</span>
                  <span className="truncate text-[11px] text-slate-500">{c.name}</span>
                  {c.rank && <span className="ml-auto text-[10px] tabular-nums text-slate-600">#{c.rank}</span>}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-600">Pick a coin and we'll seed sensible levels around its live price — then fine-tune everything below.</p>
          </div>
        )}

        {coin && (
          <>
            {/* direction toggle */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              {(['LONG', 'SHORT'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => changeDirection(d)}
                  className={`rounded-lg py-2 text-sm font-bold transition-colors ${
                    direction === d ? (d === 'LONG' ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40' : 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/40') : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'
                  }`}
                >
                  {d === 'LONG' ? '↗ LONG' : '↘ SHORT'}
                </button>
              ))}
            </div>

            {/* level inputs */}
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <Field label="Entry low" value={f.entryLow} onChange={set('entryLow')} />
              <Field label="Entry high" value={f.entryHigh} onChange={set('entryHigh')} />
              <Field label="Stop-loss" value={f.stopLoss} onChange={set('stopLoss')} tone="stop" />
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
                  <span>Leverage (isolated)</span>
                  <span className="font-bold tabular-nums text-slate-200">{leverage}×</span>
                </div>
                <input type="range" min={1} max={50} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="h-8 w-full accent-indigo-400" aria-label="Leverage" />
              </div>
              <Field label="Take-profit 1" value={f.tp1} onChange={set('tp1')} tone="tp" />
              <Field label="Take-profit 2" value={f.tp2} onChange={set('tp2')} tone="tp" />
              <Field label="Take-profit 3" value={f.tp3} onChange={set('tp3')} tone="tp" />
            </div>

            {/* live summary */}
            <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
              {calc.valid ? (
                <>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Metric label="Reward:Risk" value={`${calc.riskReward}`} cls={rrColor} />
                    <Metric label="Stop" value={`−${calc.stopPct}%`} cls="text-rose-300" />
                    <Metric label="Est. liq." value={fmtPrice(calc.liqPrice)} cls="text-amber-300" />
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                    <Metric label="Position" value={fmtUsd(calc.positionUsd)} cls="text-slate-200" />
                    <Metric label="Margin" value={fmtUsd(calc.marginUsd)} cls="text-slate-200" />
                    <Metric label="Risk" value={fmtUsd(calc.dollarRisk)} cls="text-slate-200" sub={`${riskPct}% of ${fmtUsd(account)}`} />
                  </div>
                  <div className="mt-2.5 space-y-1 border-t border-white/[0.06] pt-2.5">
                    {calc.tps.map((t, i) => (
                      <div key={i} className="flex items-center gap-2 text-[12px]">
                        <span className="w-10 text-slate-500">TP{i + 1}</span>
                        <span className="tabular-nums text-slate-300">{fmtPrice(t.price)}</span>
                        <span className="text-[10px] tabular-nums text-slate-500">{t.r}R · +{t.movePct}%</span>
                        <span className="ml-auto font-semibold tabular-nums text-emerald-400">+{fmtUsd(t.profitUsd)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-[12px] text-rose-300">
                  <span>⚠️</span>
                  <span>{calc.error}</span>
                </div>
              )}
            </div>

            <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
              Tracking is advisory — the engine watches your levels and alerts you on a hit; it does <span className="text-slate-500">not</span> place the order. Risk is sized from the position-sizing bar ({riskPct}% of {fmtUsd(account)}). Sizing assumes a fill at the entry mid; liquidation is an estimate (fees/maintenance ignored).
            </p>

            {/* actions */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={reset} className="btn-ghost !py-2 text-[13px]">Reset</button>
              {isNew && <button onClick={() => { setCoin(null); setSeedPrice(0) }} className="btn-ghost !py-2 text-[13px]">Change coin</button>}
              <div className="ml-auto flex items-center gap-2">
                <button onClick={onClose} className="btn-ghost !py-2 text-[13px]">Cancel</button>
                {init.editingId ? (
                  <button onClick={submit} disabled={!calc.valid || busy} className="btn-primary !py-2 text-[13px]">{busy ? 'Saving…' : 'Save changes'}</button>
                ) : (
                  <>
                    <button onClick={submit} disabled={!calc.valid || busy} className="btn-ghost !py-2 text-[13px]" title="Watch these levels and alert me on a hit (no position)">📍 Track</button>
                    <button onClick={openPosition} disabled={!calc.valid || busy} className="btn-primary !py-2 text-[13px]" title="Open a leveraged paper position at market">📈 Open (paper)</button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const numStr = (v: number) => (Number.isFinite(v) && v !== 0 ? String(v) : '')

/** A blank ticket — opens the coin picker first. Shared by the Signals channel + Positions panel. */
export const blankInit = (): TicketInit => ({ symbol: '', cgId: '', direction: 'LONG', entryLow: 0, entryHigh: 0, stopLoss: 0, tp1: 0, tp2: 0, tp3: 0, leverage: 5 })

/** The operator's account size + risk %, from the shared position-sizing localStorage keys. */
export function readSizing(): { account: number; riskPct: number } {
  const num = (k: string, d: number) => {
    try {
      const v = Number(localStorage.getItem(k))
      return Number.isFinite(v) && v > 0 ? v : d
    } catch {
      return d
    }
  }
  return { account: num('pulsetrade.signals.account', 1000), riskPct: num('pulsetrade.signals.riskPct', 1) }
}

function Field({ label, value, onChange, tone }: { label: string; value: string; onChange: (v: string) => void; tone?: 'stop' | 'tp' }) {
  const ring = tone === 'stop' ? 'focus-within:border-rose-400/60' : tone === 'tp' ? 'focus-within:border-emerald-400/60' : 'focus-within:border-indigo-400/60'
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-slate-400">{label}</span>
      <span className={`flex items-center rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 ${ring}`}>
        <span className="text-slate-500">$</span>
        <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} className="w-full bg-transparent text-right text-[13px] tabular-nums text-slate-100 outline-none" aria-label={label} />
      </span>
    </label>
  )
}

function Metric({ label, value, cls, sub }: { label: string; value: string; cls: string; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-[15px] font-bold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[9px] tabular-nums text-slate-600">{sub}</div>}
    </div>
  )
}
