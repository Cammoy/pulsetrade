import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useModal } from '../useModal'
import { computeProfit, priceFromMarketCap, type AmountMode } from '../calc'
import { fmtUsd, fmtSign, fmtPct, fmtPrice, fmtQty, fmtCompactUsd, pnlColor, parseAmount } from '../format'
import { iconUrl } from '../icon'

const num = (s: string) => parseAmount(s) ?? 0
const cleanNum = (n: number) => (Number.isFinite(n) ? String(Number(n.toPrecision(8))) : '0')
const MULTIPLES = [0.5, 2, 3, 5, 10] // quick what-if multiples (of the entry price OR the current market cap)

interface CoinHit { id: string; symbol: string; name: string; thumb: string | null; rank: number | null }
interface CoinMarket { id: string; symbol: string; name: string; image: string | null; priceUsd: number; marketCapUsd: number | null; circulatingSupply: number | null }

export default function ProfitCalculator() {
  const openCalc = useStore((s) => s.openCalc)
  useModal(() => openCalc(false))

  const [entry, setEntry] = useState('1')
  const [exit, setExit] = useState('2')
  const [amount, setAmount] = useState('100')
  const [mode, setMode] = useState<AmountMode>('usd')
  const [fee, setFee] = useState('0')

  // Coin search → autofill price + market cap + circulating supply (for market-cap targeting).
  const [coin, setCoin] = useState<CoinMarket | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<CoinHit[]>([])
  const [openList, setOpenList] = useState(false)
  const [exitMode, setExitMode] = useState<'price' | 'mcap'>('price')
  const [targetMcap, setTargetMcap] = useState('')

  // Debounced coin search.
  const searchReq = useRef(0)
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setHits([]); return }
    const id = ++searchReq.current
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/api/coins/search?q=' + encodeURIComponent(q))
        const d = await r.json()
        if (id === searchReq.current) setHits(Array.isArray(d.coins) ? d.coins : [])
      } catch { /* ignore */ }
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  const pickCoin = async (hit: CoinHit) => {
    setOpenList(false)
    setQuery(hit.name)
    try {
      const r = await fetch('/api/coin/' + encodeURIComponent(hit.id))
      if (!r.ok) throw new Error('market data unavailable')
      const m = (await r.json()) as CoinMarket
      setCoin(m)
      // Seed BOTH exit fields off the live data so either mode is sensible immediately
      // (no stale default left dangling against the new entry price).
      if (m.priceUsd > 0) { setEntry(cleanNum(m.priceUsd)); setExit(cleanNum(m.priceUsd * 2)) }
      if (m.marketCapUsd && m.circulatingSupply) { setTargetMcap(cleanNum(m.marketCapUsd * 2)); setExitMode('mcap') }
      else setExitMode('price')
    } catch {
      setCoin(null)
    }
  }
  const clearCoin = () => { setCoin(null); setQuery(''); setHits([]); setExitMode('price') }

  const entryPrice = num(entry)
  const supply = coin?.circulatingSupply ?? 0
  const canMcap = exitMode === 'mcap' && supply > 0
  // The exit price the math runs on: derived from the target market cap when in mcap mode.
  const exitPrice = canMcap ? priceFromMarketCap(num(targetMcap), supply) : num(exit)
  const currentMcap = coin?.marketCapUsd ?? (supply > 0 ? supply * entryPrice : 0)

  // Toggle price↔mcap, seeding the destination field from the current value so the
  // result stays continuous across the switch (no jump to a stale default).
  const switchExitMode = (m: 'price' | 'mcap') => {
    if (m === exitMode) return
    if (m === 'price' && supply > 0 && num(targetMcap) > 0) setExit(cleanNum(priceFromMarketCap(num(targetMcap), supply)))
    if (m === 'mcap' && supply > 0) setTargetMcap(cleanNum(num(exit) * supply))
    setExitMode(m)
  }

  const r = useMemo(
    () => computeProfit({ entryPrice, exitPrice, amount: num(amount), amountMode: mode, feePct: num(fee) }),
    [entryPrice, exitPrice, amount, mode, fee],
  )
  const mult = entryPrice > 0 ? exitPrice / entryPrice : 0
  // A multiplier chip sets EITHER the exit price (price mode) OR the target market cap (mcap mode).
  const setMultiple = (m: number) => {
    if (canMcap) setTargetMcap(cleanNum(currentMcap * m))
    else setExit(cleanNum(entryPrice * m))
  }
  const multMax = Math.max(10, Math.ceil(mult || 0))

  // ── Profit curve: profit($) across exit prices 0 → entry×multMax ──────────────
  const curve = useMemo(() => {
    if (!r.valid || entryPrice <= 0) return null
    const W = 600, H = 170, PAD = 6
    const xMax = entryPrice * multMax
    const N = 80
    const pts: { x: number; p: number }[] = []
    for (let i = 0; i <= N; i++) {
      const ex = (i / N) * xMax
      pts.push({ x: ex, p: computeProfit({ entryPrice, exitPrice: ex, amount: num(amount), amountMode: mode, feePct: num(fee) }).profitUsd })
    }
    const ps = pts.map((d) => d.p)
    const pMin = Math.min(0, ...ps), pMax = Math.max(0, ...ps)
    const span = pMax - pMin || 1
    const mapX = (ex: number) => (ex / xMax) * (W - PAD * 2) + PAD
    const mapY = (p: number) => H - PAD - ((p - pMin) / span) * (H - PAD * 2)
    const zeroY = mapY(0)
    const line = pts.map((d, i) => `${i === 0 ? 'M' : 'L'} ${mapX(d.x).toFixed(2)} ${mapY(d.p).toFixed(2)}`).join(' ')
    const area = `M ${mapX(0).toFixed(2)} ${zeroY.toFixed(2)} ` + pts.map((d) => `L ${mapX(d.x).toFixed(2)} ${mapY(d.p).toFixed(2)}`).join(' ') + ` L ${mapX(xMax).toFixed(2)} ${zeroY.toFixed(2)} Z`
    return { W, H, zeroY, line, area, xMax, curX: mapX(Math.min(exitPrice, xMax)), curY: mapY(r.profitUsd), beX: mapX(Math.min(r.breakEvenPrice, xMax)) }
  }, [r, entryPrice, exitPrice, amount, mode, fee, multMax])

  const up = r.profitUsd >= 0
  const targetMcapNum = num(targetMcap)

  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-3" onClick={() => openCalc(false)}>
      <div className="glass animate-sheet pb-safe max-h-[94vh] w-full max-w-2xl overflow-auto !rounded-b-none border-white/10 bg-[var(--modal)] p-5 sm:!rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-100">🧮 Profit Calculator</h2>
          <button className="btn-ghost !px-2.5 !py-1" onClick={() => openCalc(false)}>✕</button>
        </div>
        <p className="mb-3 text-[12px] text-slate-500">Search a coin to use its live price + market cap, then see exactly what you’d make at a target price — or a target market cap. A planning tool, not a forecast.</p>

        {/* Coin search */}
        <div className="relative mb-3">
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-2 focus-within:border-indigo-400/60">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input className="w-full bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-600" value={query} onChange={(e) => { setQuery(e.target.value); setOpenList(true) }} onFocus={() => setOpenList(true)} placeholder="Search a coin (optional) — e.g. bitcoin, pepe…" />
            {coin && <button onClick={clearCoin} className="shrink-0 text-slate-500 hover:text-slate-300" aria-label="Clear coin">✕</button>}
          </div>
          {openList && hits.length > 0 && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpenList(false)} />
              <div className="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-auto rounded-xl border border-white/10 bg-[var(--menu)] p-1 shadow-xl">
                {hits.map((h) => (
                  <button key={h.id} onClick={() => pickCoin(h)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-slate-200 hover:bg-white/[0.06]">
                    {h.thumb ? <img src={iconUrl(h.thumb)} alt="" loading="lazy" className="h-5 w-5 rounded-full" /> : <span className="h-5 w-5 rounded-full bg-[var(--surface-sunken)] dark:bg-white/10" />}
                    <span className="font-semibold">{h.symbol}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-500">{h.name}</span>
                    {h.rank && <span className="shrink-0 text-[10px] text-slate-600">#{h.rank}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
          {coin && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-0.5 text-[11px] text-slate-500">
              <span className="font-semibold text-slate-300">{coin.symbol}</span>
              <span className="tabular-nums">price {fmtPrice(coin.priceUsd)}</span>
              {coin.marketCapUsd ? <span className="tabular-nums">MC {fmtCompactUsd(coin.marketCapUsd)}</span> : null}
              {coin.circulatingSupply ? <span className="tabular-nums">{fmtCompactUsd(coin.circulatingSupply).replace('$', '')} supply</span> : <span className="text-amber-300">no supply data — market-cap mode off</span>}
            </div>
          )}
        </div>

        {/* Inputs */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Field label="Entry price"><PriceInput value={entry} onChange={setEntry} /></Field>
          <Field label={mode === 'usd' ? 'You invest' : 'You hold'}>
            <div className="flex items-center gap-1.5">
              <input className="input !py-2 tabular-nums" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <div className="seg-track flex shrink-0 p-0.5 text-[11px] font-semibold">
                {(['usd', 'qty'] as AmountMode[]).map((m) => (
                  <button key={m} onClick={() => setMode(m)} className={`rounded-lg px-2 py-1 transition-colors ${mode === m ? 'seg-active' : 'text-slate-400'}`}>{m === 'usd' ? '$' : 'coins'}</button>
                ))}
              </div>
            </div>
          </Field>
          {/* Exit: by price OR by market cap */}
          <Field label={canMcap ? 'Target market cap' : 'Exit price'}>
            {canMcap ? (
              <div className="flex items-center rounded-xl border border-white/10 bg-white/[0.04] pl-2.5 focus-within:border-indigo-400/60">
                <span className="text-[12px] text-slate-500">$</span>
                <input className="w-full bg-transparent px-1.5 py-2 text-sm tabular-nums text-slate-100 outline-none" inputMode="decimal" value={targetMcap} onChange={(e) => setTargetMcap(e.target.value)} placeholder="market cap" />
              </div>
            ) : (
              <PriceInput value={exit} onChange={setExit} />
            )}
          </Field>
          <Field label="Fee % (per side)"><input className="input !py-2 tabular-nums" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" /></Field>
        </div>

        {/* Exit-mode toggle (only when a coin with supply is selected) + multiplier chips */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {coin && coin.circulatingSupply ? (
            <div className="seg-track mr-1 flex p-0.5 text-[11px] font-semibold">
              {(['price', 'mcap'] as const).map((m) => (
                <button key={m} onClick={() => switchExitMode(m)} className={`rounded-lg px-2 py-1 transition-colors ${exitMode === m ? 'seg-active' : 'text-slate-400'}`}>{m === 'price' ? 'by price' : 'by mkt cap'}</button>
              ))}
            </div>
          ) : null}
          <span className="text-[11px] text-slate-500">{canMcap ? 'Hits:' : 'Exit at:'}</span>
          {MULTIPLES.map((m) => {
            const active = Math.abs(mult - m) < 1e-6
            return (
              <button key={m} onClick={() => setMultiple(m)} className={`chip tabular-nums transition-colors ${active ? 'bg-indigo-500/20 text-indigo-300 ring-1 ring-indigo-400/40' : 'bg-[var(--surface-sunken)] text-slate-400 hover:text-slate-200 dark:bg-white/[0.06]'}`}>
                {canMcap ? fmtCompactUsd(currentMcap * m) : m < 1 ? `${Math.round((m - 1) * 100)}%` : `${m}×`}
              </button>
            )
          })}
          <span className="ml-auto text-[11px] tabular-nums text-slate-500">{mult > 0 ? `${mult >= 1 ? mult.toFixed(2) + '× · ' : ''}${fmtPct(r.priceChangePct)}` : ''}</span>
        </div>

        {/* Slider */}
        <input type="range" min={0} max={multMax} step={multMax / 240} value={Math.min(mult, multMax)} onChange={(e) => setMultiple(Number(e.target.value))} className="mt-2 w-full accent-indigo-500" aria-label="Exit multiple" />

        {/* Result hero */}
        <div className="mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">
            {up ? 'Profit' : 'Loss'} if {coin && canMcap ? `${coin.symbol} hits ${fmtCompactUsd(targetMcapNum)} market cap` : `you sell at ${fmtPrice(exitPrice)}`}
          </div>
          <div className={`mt-0.5 text-[34px] font-extrabold leading-none tabular-nums ${pnlColor(r.profitUsd)}`}>{fmtSign(r.profitUsd)}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span className={`font-bold tabular-nums ${pnlColor(r.profitUsd)}`}>{fmtPct(r.profitPct)}</span>
            <span className="tabular-nums text-slate-400">{r.roi >= 1 ? `${r.roi.toFixed(2)}× your money` : `${r.roi.toFixed(2)}×`}</span>
            <span className="text-slate-600">·</span>
            <span className="tabular-nums text-slate-400">{canMcap ? `implied price ${fmtPrice(exitPrice)}` : `sell value ${fmtUsd(r.exitValueUsd)}`}</span>
          </div>
        </div>

        {/* Profit curve */}
        {curve && (
          <div className="mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
              <span>Profit across exit price</span>
              <span className="tabular-nums">break-even {fmtPrice(r.breakEvenPrice)}</span>
            </div>
            <svg viewBox={`0 0 ${curve.W} ${curve.H}`} className="h-[170px] w-full" preserveAspectRatio="none">
              <defs>
                <clipPath id="profitAbove"><rect x="0" y="0" width={curve.W} height={curve.zeroY} /></clipPath>
                <clipPath id="profitBelow"><rect x="0" y={curve.zeroY} width={curve.W} height={curve.H - curve.zeroY} /></clipPath>
              </defs>
              <path d={curve.area} fill="rgb(16 185 129 / 0.18)" clipPath="url(#profitAbove)" />
              <path d={curve.area} fill="rgb(244 63 94 / 0.16)" clipPath="url(#profitBelow)" />
              <line x1="0" y1={curve.zeroY} x2={curve.W} y2={curve.zeroY} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="4 4" />
              <line x1={curve.beX} y1="0" x2={curve.beX} y2={curve.H} stroke="var(--color-amber-400)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
              <path d={curve.line} fill="none" stroke={up ? 'var(--spark-up)' : 'var(--spark-down)'} strokeWidth="2.5" strokeLinejoin="round" />
              <line x1={curve.curX} y1="0" x2={curve.curX} y2={curve.H} stroke="var(--color-indigo-400)" strokeWidth="1.5" opacity="0.5" />
              <circle cx={curve.curX} cy={curve.curY} r="4.5" fill={up ? 'var(--spark-up)' : 'var(--spark-down)'} stroke="var(--modal)" strokeWidth="2" />
            </svg>
            <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-slate-600">
              <span>$0</span>
              <span>{fmtPrice(curve.xMax)}{canMcap ? ` · ${fmtCompactUsd(curve.xMax * supply)} MC` : ''}</span>
            </div>
          </div>
        )}

        {/* Scenario cards */}
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
          {MULTIPLES.map((m) => {
            const ex = canMcap ? priceFromMarketCap(currentMcap * m, supply) : entryPrice * m
            const s = computeProfit({ entryPrice, exitPrice: ex, amount: num(amount), amountMode: mode, feePct: num(fee) })
            return (
              <button key={m} onClick={() => setMultiple(m)} className="tile-sunken rounded-xl p-2 text-left transition-colors hover:ring-1 hover:ring-indigo-400/40">
                <div className="text-[11px] font-bold tabular-nums text-slate-400">{canMcap ? fmtCompactUsd(currentMcap * m) : m < 1 ? `${Math.round((m - 1) * 100)}%` : `${m}×`}</div>
                <div className={`text-[13px] font-bold tabular-nums ${pnlColor(s.profitUsd)}`}>{fmtSign(s.profitUsd)}</div>
                <div className="text-[10px] tabular-nums text-slate-500">{fmtPrice(ex)}</div>
              </button>
            )
          })}
        </div>

        <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
          You’d hold <span className="tabular-nums text-slate-400">{fmtQty(r.quantity)}</span> coins · cost <span className="tabular-nums text-slate-400">{fmtUsd(r.costUsd)}</span> · break-even at <span className="tabular-nums text-slate-400">{fmtPrice(r.breakEvenPrice)}</span>. {canMcap ? 'Market-cap targets use live circulating supply (price = market cap ÷ supply).' : 'Long spot only; fees applied to each leg.'}
        </p>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-slate-500">{label}</span>
      {children}
    </label>
  )
}

function PriceInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center rounded-xl border border-white/10 bg-white/[0.04] pl-2.5 focus-within:border-indigo-400/60">
      <span className="text-[12px] text-slate-500">$</span>
      <input className="w-full bg-transparent px-1.5 py-2 text-sm tabular-nums text-slate-100 outline-none" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00" />
    </div>
  )
}
