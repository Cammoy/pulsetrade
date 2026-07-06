import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { fmtPrice, fmtPct, fmtUsd, parseAmount, pnlColor } from '../format'
import { seedLevels } from '../signalMath'
import CandleChart from './CandleChart'
import type { CoinHit, Ohlc, OrderSide, AlertKind } from '../types'

/**
 * The Trade channel — one coin, one terminal. Consolidates the coin-centric apps (Chart, Perps,
 * Limit Orders, Price Alerts, what-if Calc): pick a coin once, see its candles, and act on it
 * from a single order ticket, with that coin's open positions / orders / alerts right below.
 * Reuses every underlying engine via the store actions — this is composition, not new logic.
 */

const COIN_KEY = 'pulsetrade.trade.coin'
type Coin = { symbol: string; name: string; cg: string }
const readCoin = (): Coin => {
  try {
    const s = JSON.parse(localStorage.getItem(COIN_KEY) || '')
    if (s && s.cg && s.symbol) return s
  } catch {
    /* ignore */
  }
  return { symbol: 'BTC', name: 'Bitcoin', cg: 'bitcoin' }
}

const TIMEFRAMES = [
  { label: '1D', days: 1 },
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
] as const
type TicketTab = 'perp' | 'limit' | 'alert' | 'calc'

export default function Trade() {
  const { perps, limitOrders, alerts, prices, tradeFocus, clearTradeFocus, openPerp, closePerp, dismissPerp, addLimitOrder, cancelLimitOrder, addAlert, deleteAlert, toggleAlert, rearmAlert, openSwap } = useStore(
    useShallow((s) => ({
      perps: s.perps, limitOrders: s.limitOrders, alerts: s.alerts, prices: s.prices, tradeFocus: s.tradeFocus, clearTradeFocus: s.clearTradeFocus,
      openPerp: s.openPerp, closePerp: s.closePerp, dismissPerp: s.dismissPerp, addLimitOrder: s.addLimitOrder, cancelLimitOrder: s.cancelLimitOrder, addAlert: s.addAlert, deleteAlert: s.deleteAlert, toggleAlert: s.toggleAlert, rearmAlert: s.rearmAlert, openSwap: s.openSwap,
    })),
  )

  const [coin, setCoinState] = useState<Coin>(readCoin)
  const [days, setDays] = useState(7)
  const [candles, setCandles] = useState<Ohlc[]>([])
  const [price, setPrice] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TicketTab>('perp')
  const [scope, setScope] = useState<'coin' | 'all'>('coin')

  const setCoin = (c: Coin) => {
    setCoinState(c)
    try {
      localStorage.setItem(COIN_KEY, JSON.stringify(c))
    } catch {
      /* ignore */
    }
  }

  // Another surface (e.g. Market) handed us a coin to focus — adopt it, then clear the
  // one-shot focus so navigating back to Trade later doesn't re-trigger it.
  useEffect(() => {
    if (tradeFocus) {
      setCoin({ symbol: tradeFocus.symbol, name: tradeFocus.name, cg: tradeFocus.cg })
      clearTradeFocus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeFocus])

  // coin search
  const [q, setQ] = useState('')
  const [results, setResults] = useState<CoinHit[]>([])
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const j = await fetch(`/api/coins/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json())
        setResults(Array.isArray(j.coins) ? j.coins : [])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  // candles + price on coin / timeframe change. `chartErr` distinguishes a failed fetch
  // (engine unreachable) from a coin that simply has no candle data.
  const [chartErr, setChartErr] = useState(false)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setCandles([])
    setChartErr(false)
    fetch(`/api/ohlc/${encodeURIComponent(coin.cg)}?days=${days}`).then((r) => r.json()).then((j) => { if (alive) setCandles(Array.isArray(j.candles) ? j.candles : []) }).catch(() => { if (alive) setChartErr(true) }).finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [coin.cg, days])
  // Live-price seed — keyed on the COIN only (not the timeframe), and RESET to null first so a
  // coin switch never renders the previous coin's price. `livePrice` falls back to this fetched
  // `price` whenever the WS feed doesn't carry the coin, so a stale value would otherwise show
  // under the new symbol (and persist if the fetch fails). [stale-price]
  useEffect(() => {
    let alive = true
    setPrice(null)
    fetch(`/api/coin/${encodeURIComponent(coin.cg)}`).then((r) => r.json()).then((m) => { if (alive) setPrice(Number.isFinite(Number(m?.priceUsd)) ? Number(m.priceUsd) : null) }).catch(() => {})
    return () => {
      alive = false
    }
  }, [coin.cg])

  const periodChange = candles.length >= 2 && candles[0].o > 0 ? ((candles[candles.length - 1].c - candles[0].o) / candles[0].o) * 100 : null
  // Header price tracks the LIVE store feed (refreshed every WS snapshot); the per-coin
  // fetch is only a seed/fallback. The forms keep the stable fetched `price` for their
  // one-time SL/TP seeding so a live tick never overwrites what the user typed.
  const livePrice = prices[coin.cg] ?? price

  // activity — scoped to this coin or all coins (full management surface).
  const inScope = (cg: string) => scope === 'all' || cg === coin.cg
  const positions = perps.open.filter((p) => inScope(p.cgId))
  const closedPositions = perps.closed.filter((p) => inScope(p.cgId))
  const orders = limitOrders.filter((o) => inScope(o.cg))
  const myAlerts = alerts.filter((a) => inScope(a.cg))
  const realizedScoped = closedPositions.reduce((s, p) => s + (p.realizedPnlUsd ?? 0), 0)
  const nothing = !positions.length && !closedPositions.length && !orders.length && !myAlerts.length

  return (
    <div className="space-y-3">
      {/* ── coin header ── (relative z-30 lifts this whole card — and its search dropdown —
            above the chart/ticket below; .glass uses backdrop-blur, which makes each card its
            own stacking context, so the dropdown's own z-index alone can't escape this card) */}
      <div className="glass relative z-30 flex flex-wrap items-center gap-2 p-3">
        <span className="text-base font-bold text-white">{coin.symbol}/USD</span>
        {livePrice !== null && <span className="text-sm font-semibold tabular-nums text-slate-200">{fmtPrice(livePrice)}</span>}
        {periodChange !== null && <span className={`text-[12px] font-semibold tabular-nums ${periodChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtPct(periodChange)} · {days}d</span>}
        <div className="relative ml-auto">
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 focus-within:border-indigo-400/60">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search coin…" aria-label="Search coin" className="w-28 bg-transparent text-[12px] text-slate-100 outline-none placeholder:text-slate-600" />
          </div>
          {q.trim().length >= 2 && (
            <div className="absolute right-0 top-full z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded-lg border border-white/10 bg-[var(--menu)] p-1 shadow-2xl">
              {results.length === 0 ? (
                <div className="px-2 py-2 text-[12px] text-slate-500">{searching ? 'Searching…' : 'No coins match'}</div>
              ) : (
                results.map((c) => (
                  <button key={c.id} onClick={() => { setCoin({ symbol: c.symbol, name: c.name, cg: c.id }); setQ(''); setResults([]) }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]">
                    {c.thumb ? <img src={c.thumb} alt="" className="h-4 w-4 rounded-full" /> : <span className="h-4 w-4 rounded-full bg-white/[0.06]" />}
                    <span className="text-[12px] font-semibold text-slate-100">{c.symbol}</span>
                    <span className="truncate text-[11px] text-slate-500">{c.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        {/* ── chart ── */}
        <div className="glass p-3">
          <div className="mb-2 flex items-center gap-1.5">
            {TIMEFRAMES.map((tf) => (
              <button key={tf.days} onClick={() => setDays(tf.days)} className={`rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors ${days === tf.days ? 'bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-500/40' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'}`}>{tf.label}</button>
            ))}
            <span className="ml-auto text-[10px] text-slate-600">candles + SMA(20)</span>
          </div>
          {loading && candles.length === 0 ? (
            <div className="shimmer h-72 rounded-xl" />
          ) : chartErr && candles.length === 0 ? (
            <div className="flex h-72 items-center justify-center text-[12px] text-rose-300/80">Couldn’t load the chart — the engine may be unreachable. Retry by switching timeframe.</div>
          ) : candles.length === 0 ? (
            <div className="flex h-72 items-center justify-center text-[12px] text-slate-600">No candle data for {coin.symbol}.</div>
          ) : (
            <CandleChart candles={candles} height={300} />
          )}
        </div>

        {/* ── order ticket ── */}
        <div className="glass flex flex-col p-3">
          <div role="tablist" aria-label="Order ticket" className="mb-3 flex gap-1 text-[12px]">
            {(['perp', 'limit', 'alert', 'calc'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`flex-1 rounded-md py-1.5 font-semibold capitalize transition-colors ${tab === t ? 'bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-500/40' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'}`}>{t === 'calc' ? 'Calc' : t}</button>
            ))}
          </div>
          {tab === 'perp' && <PerpForm coin={coin} price={price} onOpen={openPerp} />}
          {tab === 'limit' && <LimitForm coin={coin} price={price} onPlace={addLimitOrder} />}
          {tab === 'alert' && <AlertForm coin={coin} price={price} onAdd={addAlert} />}
          {tab === 'calc' && <CalcForm price={price} />}
          <button onClick={() => openSwap(true)} className="btn-ghost mt-3 !py-1.5 text-[11px] text-slate-400">⇄ Swap any token (full panel)</button>
        </div>
      </div>

      {/* ── activity (positions, orders, alerts) — this coin or all ── */}
      <div className="glass p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-bold text-white">{scope === 'all' ? 'Your activity' : `${coin.symbol} — your activity`}</span>
          {realizedScoped !== 0 && <span className={`text-[11px] tabular-nums ${pnlColor(realizedScoped)}`}>realized {realizedScoped >= 0 ? '+' : ''}{fmtUsd(realizedScoped)}</span>}
          <div className="ml-auto flex gap-1 text-[11px]">
            {(['coin', 'all'] as const).map((s) => (
              <button key={s} onClick={() => setScope(s)} className={`rounded-md px-2 py-0.5 font-semibold transition-colors ${scope === s ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-500 hover:text-slate-300'}`}>{s === 'coin' ? 'This coin' : 'All'}</button>
            ))}
          </div>
        </div>
        {nothing ? (
          <p className="py-3 text-center text-[12px] text-slate-600">No positions, orders or alerts {scope === 'coin' ? `on ${coin.symbol}` : 'yet'} — place one above.</p>
        ) : (
          <div className="space-y-1.5">
            {positions.map((p) => (
              <Row key={p.id} icon="🧾" left={`${p.side === 'long' ? 'Long' : 'Short'} ${p.leverage}×${scope === 'all' ? ' · ' + p.symbol : ''}`} mid={`entry ${fmtPrice(p.entryPrice)} · liq ${fmtPrice(p.liqPrice)}`} right={`${p.unrealizedPnlUsd >= 0 ? '+' : ''}${fmtUsd(p.unrealizedPnlUsd)}`} rightCls={pnlColor(p.unrealizedPnlUsd)} actions={[{ label: 'Close', onClick: () => closePerp(p.id) }]} />
            ))}
            {closedPositions.map((p) => (
              <Row key={p.id} icon="🧾" muted left={`${p.side === 'long' ? 'Long' : 'Short'} ${p.leverage}×${scope === 'all' ? ' · ' + p.symbol : ''}`} mid={`closed ${p.closeReason ?? ''}`} right={`${(p.realizedPnlUsd ?? 0) >= 0 ? '+' : ''}${fmtUsd(p.realizedPnlUsd ?? 0)}`} rightCls={pnlColor(p.realizedPnlUsd ?? 0)} actions={[{ label: 'Dismiss', onClick: () => dismissPerp(p.id) }]} />
            ))}
            {orders.map((o) => (
              <Row
                key={o.id}
                icon="📋"
                muted={o.status !== 'open'}
                left={`${o.side === 'buy' ? 'Buy' : 'Sell'} ${fmtUsd(o.amountUsd)}${scope === 'all' ? ' · ' + o.symbol : ''}`}
                mid={o.status === 'filled' ? `filled at ${fmtPrice(o.fillPrice ?? 0)}` : `${o.side === 'buy' ? '↘' : '↗'} ${fmtPrice(o.triggerPrice)}`}
                right={o.status}
                rightCls={o.status === 'filled' ? 'text-emerald-400' : 'text-slate-400'}
                actions={[{ label: o.status === 'open' ? 'Cancel' : 'Dismiss', onClick: () => cancelLimitOrder(o.id) }]}
              />
            ))}
            {myAlerts.map((a) => {
              const triggered = a.status === 'triggered'
              const paused = !a.enabled && a.status === 'armed'
              return (
                <Row
                  key={a.id}
                  icon="🔔"
                  muted={triggered || paused}
                  left={`${a.kind === 'above' ? 'Above' : a.kind === 'below' ? 'Below' : `±${a.value}%`}${scope === 'all' ? ' · ' + a.symbol : ''}`}
                  mid={a.kind === 'move' ? `from ${fmtPrice(a.armedPrice)}` : fmtPrice(a.value)}
                  right={triggered ? 'triggered' : paused ? 'paused' : 'armed'}
                  rightCls={triggered ? 'text-emerald-400' : 'text-slate-400'}
                  actions={
                    triggered
                      ? [{ label: 'Re-arm', onClick: () => rearmAlert(a.id) }, { label: 'Delete', onClick: () => deleteAlert(a.id) }]
                      : [{ label: paused ? 'Resume' : 'Pause', onClick: () => toggleAlert(a.id, paused) }, { label: 'Delete', onClick: () => deleteAlert(a.id) }]
                  }
                />
              )
            })}
          </div>
        )}
      </div>

      <p className="px-0.5 text-[10px] leading-relaxed text-slate-600">Paper trading — perps, limit fills and alerts are simulated against real prices; no funds move. Not financial advice.</p>
    </div>
  )
}

// ── ticket forms ──────────────────────────────────────────────────────────────

function Field({ label, value, onChange, prefix }: { label: string; value: string; onChange: (v: string) => void; prefix?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-slate-400">{label}</span>
      <span className="flex items-center rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 focus-within:border-indigo-400/60">
        {prefix && <span className="text-slate-500">{prefix}</span>}
        <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="w-full bg-transparent text-right text-[13px] tabular-nums text-slate-100 outline-none" />
      </span>
    </label>
  )
}

function PerpForm({ coin, price, onOpen }: { coin: Coin; price: number | null; onOpen: (d: { symbol: string; cgId: string; side: 'long' | 'short'; leverage: number; marginUsd: number; stopLoss?: number; takeProfit?: number }) => Promise<{ error?: string }> }) {
  const [side, setSide] = useState<'long' | 'short'>('long')
  const [leverage, setLeverage] = useState(5)
  const [margin, setMargin] = useState('100')
  const [sl, setSl] = useState('')
  const [tp, setTp] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Seed SL/TP from the live price when it arrives (or the coin changes).
  useEffect(() => {
    if (!price) return
    const s = seedLevels(side === 'long' ? 'LONG' : 'SHORT', price)
    setSl(String(s.stopLoss))
    setTp(String(s.tp1))
  }, [price, side, coin.cg])

  const m = parseAmount(margin) ?? 0
  const liq = price ? (side === 'long' ? price * (1 - 1 / leverage + 0.005) : price * (1 + 1 / leverage - 0.005)) : 0

  // Client-side guard: a stop/target on the wrong side of the price is a mistake — catch it
  // before the round-trip (long: stop below, target above; short: the reverse).
  const validate = (): string | null => {
    const slV = parseAmount(sl)
    const tpV = parseAmount(tp)
    if (price) {
      if (slV !== null && (side === 'long' ? slV >= price : slV <= price)) return `Stop-loss must be ${side === 'long' ? 'below' : 'above'} the price`
      if (tpV !== null && (side === 'long' ? tpV <= price : tpV >= price)) return `Take-profit must be ${side === 'long' ? 'above' : 'below'} the price`
    }
    return null
  }

  const submit = async () => {
    if (busy || !(m > 0)) return
    const v = validate()
    if (v) { setErr(v); return }
    setErr(null)
    setBusy(true)
    const out = await onOpen({ symbol: coin.symbol, cgId: coin.cg, side, leverage, marginUsd: m, stopLoss: parseAmount(sl) ?? undefined, takeProfit: parseAmount(tp) ?? undefined })
    setBusy(false)
    if (out.error) setErr(out.error)
    else setMargin('100')
  }

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        {(['long', 'short'] as const).map((s) => (
          <button key={s} onClick={() => { setSide(s); setErr(null) }} className={`rounded-lg py-1.5 text-[13px] font-bold capitalize transition-colors ${side === s ? (s === 'long' ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40' : 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/40') : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'}`}>{s}</button>
        ))}
      </div>
      <div>
        <div className="mb-1 flex justify-between text-[11px] text-slate-400"><span>Leverage</span><span className="font-bold text-slate-200">{leverage}×</span></div>
        <input type="range" min={1} max={50} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="h-7 w-full accent-indigo-400" aria-label="Leverage" />
      </div>
      <Field label="Margin (USD)" value={margin} onChange={(v) => { setMargin(v); setErr(null) }} prefix="$" />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Stop-loss" value={sl} onChange={(v) => { setSl(v); setErr(null) }} prefix="$" />
        <Field label="Take-profit" value={tp} onChange={(v) => { setTp(v); setErr(null) }} prefix="$" />
      </div>
      <div className="flex justify-between text-[10.5px] text-slate-500">
        <span>Notional {fmtUsd(m * leverage)}</span>
        {liq > 0 && <span>est. liq {fmtPrice(liq)}</span>}
      </div>
      {err && <div className="rounded-lg bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-300">{err}</div>}
      <button onClick={submit} disabled={busy || !(m > 0)} className="btn-primary w-full !py-2 text-[13px]">{busy ? 'Opening…' : `Open ${side} (paper)`}</button>
    </div>
  )
}

function LimitForm({ coin, price, onPlace }: { coin: Coin; price: number | null; onPlace: (d: { cg: string; symbol: string; name: string; side: OrderSide; amountUsd: number; triggerPrice: number }) => Promise<{ error?: string }> }) {
  const [side, setSide] = useState<OrderSide>('buy')
  const [amount, setAmount] = useState('500')
  const [trigger, setTrigger] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (price) setTrigger(String(+(side === 'buy' ? price * 0.9 : price * 1.1).toPrecision(6)))
  }, [price, side, coin.cg])

  const submit = async () => {
    const amt = parseAmount(amount)
    const trg = parseAmount(trigger)
    if (busy || amt === null || trg === null) return
    setBusy(true)
    const out = await onPlace({ cg: coin.cg, symbol: coin.symbol, name: coin.name, side, amountUsd: amt, triggerPrice: trg })
    setBusy(false)
    if (!out.error) setAmount('500')
  }
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        {(['buy', 'sell'] as const).map((s) => (
          <button key={s} onClick={() => setSide(s)} className={`rounded-lg py-1.5 text-[12px] font-bold transition-colors ${side === s ? (s === 'buy' ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40' : 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/40') : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'}`}>{s === 'buy' ? 'Buy the dip' : 'Sell the rip'}</button>
        ))}
      </div>
      <Field label={side === 'buy' ? 'Spend (USD)' : 'Sell (USD worth)'} value={amount} onChange={setAmount} prefix="$" />
      <Field label={side === 'buy' ? 'When price drops to' : 'When price rises to'} value={trigger} onChange={setTrigger} prefix="$" />
      <button onClick={submit} disabled={busy || !(parseAmount(amount)! > 0) || !(parseAmount(trigger)! > 0)} className="btn-primary w-full !py-2 text-[13px]">{busy ? 'Placing…' : 'Place limit order'}</button>
    </div>
  )
}

function AlertForm({ coin, price, onAdd }: { coin: Coin; price: number | null; onAdd: (d: { cg: string; symbol: string; name: string; kind: AlertKind; value: number }) => Promise<{ error?: string }> }) {
  const [kind, setKind] = useState<AlertKind>('above')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!price) return
    setValue(kind === 'above' ? String(+(price * 1.1).toPrecision(6)) : kind === 'below' ? String(+(price * 0.9).toPrecision(6)) : '10')
  }, [price, kind, coin.cg])

  const submit = async () => {
    const v = parseAmount(value)
    if (busy || v === null) return
    setBusy(true)
    const out = await onAdd({ cg: coin.cg, symbol: coin.symbol, name: coin.name, kind, value: v })
    setBusy(false)
  }
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-3 gap-1.5">
        {([['above', '↑ Above'], ['below', '↓ Below'], ['move', '± Move']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setKind(k)} className={`rounded-lg py-1.5 text-[11px] font-semibold transition-colors ${kind === k ? 'bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-500/40' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'}`}>{label}</button>
        ))}
      </div>
      <Field label={kind === 'move' ? 'Percent move' : kind === 'above' ? 'Notify at / above' : 'Notify at / below'} value={value} onChange={setValue} prefix={kind === 'move' ? undefined : '$'} />
      <button onClick={submit} disabled={busy || !(parseAmount(value)! > 0)} className="btn-primary w-full !py-2 text-[13px]">{busy ? 'Adding…' : 'Add alert'}</button>
    </div>
  )
}

function CalcForm({ price }: { price: number | null }) {
  const [entry, setEntry] = useState('')
  const [exit, setExit] = useState('')
  const [amount, setAmount] = useState('1000')
  useEffect(() => {
    if (price) {
      setEntry(String(+price.toPrecision(6)))
      setExit(String(+(price * 1.5).toPrecision(6)))
    }
  }, [price])

  const { profit, pct } = useMemo(() => {
    const e = parseAmount(entry) ?? 0
    const x = parseAmount(exit) ?? 0
    const a = parseAmount(amount) ?? 0
    if (!(e > 0) || !(x > 0) || !(a > 0)) return { profit: 0, pct: 0 }
    const qty = a / e
    return { profit: qty * (x - e), pct: ((x - e) / e) * 100 }
  }, [entry, exit, amount])

  return (
    <div className="space-y-2.5">
      <Field label="Entry" value={entry} onChange={setEntry} prefix="$" />
      <Field label="Exit" value={exit} onChange={setExit} prefix="$" />
      <Field label="Amount (USD)" value={amount} onChange={setAmount} prefix="$" />
      <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-2.5 text-center">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">Profit</div>
        <div className={`text-[18px] font-bold tabular-nums ${pnlColor(profit)}`}>{profit >= 0 ? '+' : ''}{fmtUsd(profit)}</div>
        <div className={`text-[11px] tabular-nums ${pnlColor(pct)}`}>{fmtPct(pct)}</div>
      </div>
    </div>
  )
}

function Row({ icon, left, mid, right, rightCls, actions, muted }: { icon: string; left: string; mid: string; right: string; rightCls: string; actions: { label: string; onClick: () => void }[]; muted?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[12px] ${muted ? 'opacity-60' : ''}`}>
      <span className="text-[13px]">{icon}</span>
      <span className="font-semibold text-slate-200">{left}</span>
      <span className="truncate text-[10.5px] text-slate-500">{mid}</span>
      <span className={`ml-auto shrink-0 font-semibold tabular-nums ${rightCls}`}>{right}</span>
      {actions.map((a) => (
        <button key={a.label} onClick={a.onClick} className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-white/[0.06] hover:text-slate-200">{a.label}</button>
      ))}
    </div>
  )
}
