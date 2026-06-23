import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, jpost } from '../store'
import { useModal } from '../useModal'
import type { AssetMetrics, CoinHit, TrackerValuation } from '../types'
import { fmtUsd, fmtSign, fmtPct, fmtQty, fmtPrice, pnlColor, ASSET_COLORS } from '../format'
import Sparkline from './Sparkline'
import Donut from './Donut'

const RANGES = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: 'All', days: 365 },
] as const
const todayStr = () => new Date().toISOString().slice(0, 10)
const reduceMin = (xs: number[]) => xs.reduce((m, x) => (x < m ? x : m), Infinity)
const reduceMax = (xs: number[]) => xs.reduce((m, x) => (x > m ? x : m), -Infinity)

// ── value-over-time line chart (dependency-free SVG) ─────────────────────────
function ValueChart({ series }: { series: { t: number; v: number }[] }) {
  if (series.length < 2) return <div className="flex h-40 items-center justify-center text-xs text-slate-600">Not enough price history yet — check back shortly.</div>
  const vs = series.map((s) => s.v)
  const min = reduceMin(vs)
  const max = reduceMax(vs)
  const W = 600
  const H = 150
  const pad = 4
  const span = max - min || 1
  const pts = series.map((s, i) => [pad + (i / (series.length - 1)) * (W - 2 * pad), pad + (1 - (s.v - min) / span) * (H - 2 * pad)] as [number, number])
  const up = vs[vs.length - 1] >= vs[0]
  const color = up ? '#34d399' : '#fb7185'
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H - pad} L${pts[0][0].toFixed(1)},${H - pad} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="trk-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#trk-grad)" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

type SortKey = 'value' | 'pnlPct' | 'pnl' | 'allocation' | 'symbol'

export default function HoldingsTracker() {
  const { notify, lastTradeId } = useStore()
  const [data, setData] = useState<TrackerValuation | null>(null)
  const [series, setSeries] = useState<{ t: number; v: number }[]>([])
  const [range, setRange] = useState(7)
  const [sortKey, setSortKey] = useState<SortKey>('value')
  const [sortAsc, setSortAsc] = useState(false)
  const [hideEmpty, setHideEmpty] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [sellFor, setSellFor] = useState<AssetMetrics | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/tracker')
      if (!r.ok) return // 404/500 (engine restarting / route missing) → keep last good data
      const j = await r.json()
      // Only accept a real valuation payload — never let a {error} body (or anything
      // without an assets array) become `data`, or the rest of the component crashes.
      if (j && Array.isArray(j.assets)) setData(j)
    } catch {
      /* engine momentarily unreachable — keep last */
    }
  }, [])
  const loadHistory = useCallback(async (days: number) => {
    try {
      const r = await fetch(`/api/tracker/history?days=${days}`)
      const j = await r.json()
      setSeries(Array.isArray(j.series) ? j.series : [])
    } catch {
      /* keep last */
    }
  }, [])

  // Initial + poll (prices move) + refetch on a new trade / range change.
  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load, lastTradeId])
  useEffect(() => {
    loadHistory(range)
  }, [range, loadHistory, data?.assets?.length])

  const refresh = () => {
    load()
    loadHistory(range)
  }

  const assets = data?.assets ?? []
  const shown = useMemo(() => {
    const list = assets.filter((a) => (hideEmpty ? a.qty > 0 : true))
    const dir = sortAsc ? 1 : -1
    const key = (a: AssetMetrics) =>
      sortKey === 'symbol' ? 0 : sortKey === 'value' ? a.valueUsd : sortKey === 'pnlPct' ? a.unrealizedPnlPct : sortKey === 'pnl' ? a.unrealizedPnlUsd : a.allocationPct
    return [...list].sort((a, b) => (sortKey === 'symbol' ? a.symbol.localeCompare(b.symbol) * dir : (key(a) - key(b)) * dir))
  }, [assets, hideEmpty, sortKey, sortAsc])

  const donutSegments = useMemo(
    () => assets.filter((a) => a.valueUsd > 0).slice(0, 11).map((a, i) => ({ color: ASSET_COLORS[i % ASSET_COLORS.length], value: a.valueUsd })),
    [assets],
  )

  const t = data?.totals
  const del = async (url: string) => {
    const out = await jpost<{ error?: string }>(url, undefined, 'DELETE')
    if (out.error) notify(out.error, 'error')
    refresh()
  }

  const sortBtn = (key: SortKey, label: string) => (
    <button
      onClick={() => (sortKey === key ? setSortAsc((s) => !s) : (setSortKey(key), setSortAsc(false)))}
      className={`font-medium ${sortKey === key ? 'text-slate-200' : 'text-slate-500 hover:text-slate-300'}`}
    >
      {label}
      {sortKey === key && <span className="ml-0.5">{sortAsc ? '↑' : '↓'}</span>}
    </button>
  )

  return (
    <div className="space-y-4">
      {/* ── Summary header ── (relative z-20 so the add-coin dropdown can paint
          above the cards below it — each .glass card is its own blur stacking context) */}
      <div className="glass relative z-20 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">📊 My holdings · total value</div>
            <div className="text-4xl font-extrabold tabular-nums text-slate-900 dark:bg-gradient-to-r dark:from-indigo-300 dark:to-cyan-300 dark:bg-clip-text dark:text-transparent">{fmtUsd(t?.valueUsd ?? 0)}</div>
            {t && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                <span className={`font-semibold tabular-nums ${pnlColor(t.unrealizedPnlUsd)}`}>{fmtSign(t.unrealizedPnlUsd)} ({fmtPct(t.unrealizedPnlPct)})</span>
                <span className="text-slate-500">invested {fmtUsd(t.investedUsd)}</span>
                {t.realizedPnlUsd !== 0 && <span className="text-slate-500">realised <span className={pnlColor(t.realizedPnlUsd)}>{fmtSign(t.realizedPnlUsd)}</span></span>}
                {assets.some((a) => a.qty > 0 && a.priceUsd === null) && <span className="text-amber-300">· pricing live…</span>}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-ghost !py-1.5 text-xs" onClick={refresh}>↻</button>
            <button className="btn-primary" onClick={() => setAdding((s) => !s)}>{adding ? '✕ Close' : '+ Add position'}</button>
          </div>
        </div>

        {/* best / worst */}
        {(data?.best || data?.worst) && (
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            {data?.best && <span className="chip bg-emerald-500/10 text-emerald-300">▲ Best: {data.best.symbol} {fmtPct(data.best.pct)}</span>}
            {data?.worst && data.worst.symbol !== data.best?.symbol && <span className="chip bg-rose-500/10 text-rose-300">▼ Worst: {data.worst.symbol} {fmtPct(data.worst.pct)}</span>}
          </div>
        )}

        {adding && <AddPosition onDone={() => { setAdding(false); refresh() }} notify={notify} />}
      </div>

      {assets.length === 0 ? (
        adding ? null : (
          <div className="glass p-8 text-center">
            <div className="text-4xl">📈</div>
            <h3 className="mt-2 text-lg font-bold text-white">Track your crypto, with real P/L</h3>
            <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">Add what you hold and what you paid — PulseTrade values it live from CoinGecko and shows your gain/loss per coin and overall.</p>
            <button className="btn-primary mt-4" onClick={() => setAdding(true)}>+ Add your first position</button>
          </div>
        )
      ) : (
        <>
          {/* ── Value over time + allocation ── */}
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="glass p-5 lg:col-span-2">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-bold text-white">Portfolio value</h3>
                <div className="flex items-center gap-1 seg-track p-0.5 text-[11px]">
                  {RANGES.map((r) => (
                    <button key={r.label} onClick={() => setRange(r.days)} className={`cursor-pointer rounded-md px-2 py-0.5 font-medium ${range === r.days ? 'seg-active' : 'text-slate-500 hover:text-slate-300'}`}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
              <ValueChart series={series} />
            </div>
            <div className="glass p-5">
              <h3 className="text-sm font-bold text-white">Allocation</h3>
              <div className="mt-3 flex items-center gap-4">
                <div className="shrink-0"><Donut segments={donutSegments} size={132} thickness={18} className="h-32 w-32 -rotate-90" linecap="butt" gap={1.5} /></div>
                <div className="min-w-0 flex-1 space-y-1">
                  {assets.filter((a) => a.valueUsd > 0).slice(0, 6).map((a, i) => (
                    <div key={a.id} className="flex items-center gap-1.5 text-[11px]">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: ASSET_COLORS[i % ASSET_COLORS.length] }} />
                      <span className="min-w-0 flex-1 truncate text-slate-300">{a.symbol}</span>
                      <span className="tabular-nums text-slate-500">{a.allocationPct.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ── Holdings table ── */}
          <div className="glass overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-3">
              <h3 className="text-sm font-bold text-white">Holdings</h3>
              <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <input type="checkbox" className="h-3.5 w-3.5 accent-indigo-500" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
                hide sold-out
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-[var(--head)] text-left text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2">{sortBtn('symbol', 'Asset')}</th>
                    <th className="px-4 py-2 text-right">Qty</th>
                    <th className="px-4 py-2 text-right">Avg cost</th>
                    <th className="px-4 py-2 text-right">Price</th>
                    <th className="px-4 py-2 text-right">{sortBtn('value', 'Value')}</th>
                    <th className="px-4 py-2 text-right">{sortBtn('pnl', 'P/L')}</th>
                    <th className="px-4 py-2 text-right">{sortBtn('pnlPct', 'P/L %')}</th>
                    <th className="px-4 py-2 text-right">{sortBtn('allocation', 'Alloc')}</th>
                    <th className="px-4 py-2 text-center">7d</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((a) => (
                    <Row key={a.id} a={a} expanded={expanded === a.id} onToggle={() => setExpanded(expanded === a.id ? null : a.id)} onSell={() => setSellFor(a)} onDel={del} onChanged={refresh} notify={notify} />
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-4 py-8 text-center text-sm text-slate-500">All positions sold. Untick "hide sold-out" to see realised P/L.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-[10px] leading-relaxed text-slate-600">Valued live from CoinGecko. Cost basis is the average of your buy lots (fees included). Not financial advice.</p>
        </>
      )}

      {sellFor && <SellModal asset={sellFor} onClose={() => setSellFor(null)} onDone={() => { setSellFor(null); refresh() }} notify={notify} />}
    </div>
  )
}

// ── one holdings row (+ expandable lots/sells) ───────────────────────────────
function Row({ a, expanded, onToggle, onSell, onDel, onChanged, notify }: { a: AssetMetrics; expanded: boolean; onToggle: () => void; onSell: () => void; onDel: (url: string) => void; onChanged: () => void; notify: (m: string, t?: 'error' | 'success' | 'info') => void }) {
  const confirm = useStore((s) => s.confirm)
  return (
    <>
      <tr className="border-t border-white/[0.04] tabular-nums hover:bg-white/[0.02]">
        <td className="px-4 py-2.5">
          <button onClick={onToggle} className="flex items-center gap-2 text-left">
            <span className="text-slate-500">{expanded ? '▾' : '▸'}</span>
            <div className="min-w-0">
              <div className="font-semibold text-slate-100">{a.symbol}</div>
              <div className="truncate text-[10px] text-slate-500">{a.name}</div>
            </div>
          </button>
        </td>
        <td className="px-4 py-2.5 text-right text-slate-300">{fmtQty(a.qty)}</td>
        <td className="px-4 py-2.5 text-right text-slate-400">{a.avgCostUsd ? fmtPrice(a.avgCostUsd) : '—'}</td>
        <td className="px-4 py-2.5 text-right text-slate-300">{a.priceUsd != null ? fmtPrice(a.priceUsd) : '—'}</td>
        {/* An unpriced coin (CoinGecko momentarily throttled) shows "pricing…" — never a misleading $0.00. */}
        <td className="px-4 py-2.5 text-right font-semibold text-slate-100">{a.priceUsd != null ? fmtUsd(a.valueUsd) : <span className="text-[11px] font-normal text-amber-300">pricing…</span>}</td>
        <td className={`px-4 py-2.5 text-right ${a.priceUsd != null ? pnlColor(a.unrealizedPnlUsd) : 'text-slate-600'}`}>{a.priceUsd != null ? fmtSign(a.unrealizedPnlUsd) : '—'}</td>
        <td className={`px-4 py-2.5 text-right font-semibold ${a.priceUsd != null ? pnlColor(a.unrealizedPnlPct) : 'text-slate-600'}`}>{a.priceUsd != null ? fmtPct(a.unrealizedPnlPct) : '—'}</td>
        <td className="px-4 py-2.5 text-right text-slate-400">{a.allocationPct.toFixed(1)}%</td>
        <td className="px-4 py-2.5"><div className="mx-auto w-[72px]">{a.spark.length > 1 ? <Sparkline points={a.spark} width={72} height={22} /> : <span className="text-[10px] text-slate-600">—</span>}</div></td>
        <td className="px-4 py-2.5">
          <div className="flex justify-end gap-1">
            <button className="btn-ghost !px-2 !py-1 text-[11px]" onClick={onSell} disabled={a.qty <= 0}>Sell</button>
            <button className="btn-ghost !px-2 !py-1 text-[11px] text-rose-300" onClick={async () => { if (await confirm({ message: `Remove ${a.symbol} and all its lots?`, confirmLabel: 'Remove', tone: 'danger' })) onDel(`/api/tracker/asset/${a.id}`) }}>🗑</button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-white/[0.015]">
          <td colSpan={10} className="px-4 py-3">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Buy lots</div>
                <div className="space-y-1">
                  {a.lots.map((l) => (
                    <div key={l.id} className="flex items-center gap-2 text-[11px] tabular-nums">
                      <span className="text-slate-300">{fmtQty(l.qty)} @ {fmtPrice(l.priceUsd)}</span>
                      <span className="text-slate-600">{new Date(l.ts).toISOString().slice(0, 10)}</span>
                      {l.feeUsd ? <span className="text-slate-600">fee {fmtUsd(l.feeUsd)}</span> : null}
                      <button className="ml-auto text-slate-600 hover:text-rose-300" onClick={() => onDel(`/api/tracker/lot/${l.id}`)}>✕</button>
                    </div>
                  ))}
                  <AddLot cg={a.cg} symbol={a.symbol} name={a.name} onDone={onChanged} notify={notify} />
                </div>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Sells {a.realizedPnlUsd !== 0 && <span className={pnlColor(a.realizedPnlUsd)}>· realised {fmtSign(a.realizedPnlUsd)}</span>}</div>
                {a.sells.length === 0 ? (
                  <div className="text-[11px] text-slate-600">No sells yet.</div>
                ) : (
                  <div className="space-y-1">
                    {a.sells.map((s) => (
                      <div key={s.id} className="flex items-center gap-2 text-[11px] tabular-nums">
                        <span className="text-slate-300">{fmtQty(s.qty)} @ {fmtPrice(s.priceUsd)}</span>
                        <span className="text-slate-600">{new Date(s.ts).toISOString().slice(0, 10)}</span>
                        <button className="ml-auto text-slate-600 hover:text-rose-300" onClick={() => onDel(`/api/tracker/sell/${s.id}`)}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── inline "buy more" form for an existing coin ──────────────────────────────
function AddLot({ cg, symbol, name, onDone, notify }: { cg: string; symbol: string; name: string; onDone: () => void; notify: (m: string, t?: 'error' | 'success' | 'info') => void }) {
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [date, setDate] = useState(todayStr())
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    const r = await fetch('/api/tracker/lot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cg, symbol, name, qty: Number(qty), priceUsd: Number(price), ts: new Date(date).getTime() }) })
    const j = await r.json()
    setBusy(false)
    if (j.error) notify(j.error, 'error')
    else { setQty(''); setPrice(''); onDone() }
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <input className="input !w-20 !py-1 text-[11px]" type="number" placeholder="qty" value={qty} onChange={(e) => setQty(e.target.value)} />
      <input className="input !w-24 !py-1 text-[11px]" type="number" placeholder="$ price" value={price} onChange={(e) => setPrice(e.target.value)} />
      <input className="input !w-32 !py-1 text-[11px]" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <button className="btn-ghost !px-2 !py-1 text-[11px]" disabled={busy || !(Number(qty) > 0) || !(Number(price) >= 0)} onClick={submit}>+ Buy more</button>
    </div>
  )
}

// ── sell modal ───────────────────────────────────────────────────────────────
function SellModal({ asset, onClose, onDone, notify }: { asset: AssetMetrics; onClose: () => void; onDone: () => void; notify: (m: string, t?: 'error' | 'success' | 'info') => void }) {
  useModal(onClose) // Escape-to-close + reference-counted body scroll-lock, matching the other modals
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState(asset.priceUsd ? String(asset.priceUsd) : '')
  const [date, setDate] = useState(todayStr())
  const [fee, setFee] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setErr(null)
    const r = await fetch('/api/tracker/sell', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cg: asset.cg, qty: Number(qty), priceUsd: Number(price), feeUsd: fee ? Number(fee) : undefined, ts: new Date(date).getTime() }) })
    const j = await r.json()
    setBusy(false)
    if (j.error) setErr(j.error)
    else { notify(`Recorded sale of ${fmtQty(Number(qty))} ${asset.symbol}`, 'success'); onDone() }
  }
  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onClick={onClose}>
      <div className="glass animate-sheet w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-white">Sell {asset.symbol}</h2>
        <p className="mt-0.5 text-xs text-slate-400">You hold {fmtQty(asset.qty)} {asset.symbol} · avg cost {fmtPrice(asset.avgCostUsd)}</p>
        <div className="mt-3 space-y-2">
          <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Quantity sold</span><input className="input" type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={`up to ${fmtQty(asset.qty)}`} /></label>
          <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Sale price (USD / unit)</span><input className="input" type="number" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Date</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Fee (opt)</span><input className="input" type="number" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" /></label>
          </div>
          {Number(qty) > 0 && Number(price) >= 0 && <div className="text-[11px] text-slate-400">Realised P/L ≈ <span className={pnlColor((Number(price) - asset.avgCostUsd) * Number(qty))}>{fmtSign((Number(price) - asset.avgCostUsd) * Number(qty) - (Number(fee) || 0))}</span></div>}
          {err && <div className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}
        </div>
        <div className="mt-4 flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy || !(Number(qty) > 0) || !(Number(price) >= 0) || Number(qty) > asset.qty + 1e-9} onClick={submit}>Record sale</button>
        </div>
      </div>
    </div>
  )
}

// ── add a brand-new position (coin search) ───────────────────────────────────
function AddPosition({ onDone, notify }: { onDone: () => void; notify: (m: string, t?: 'error' | 'success' | 'info') => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<CoinHit[]>([])
  const [picked, setPicked] = useState<CoinHit | null>(null)
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [date, setDate] = useState(todayStr())
  const [fee, setFee] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (picked || q.trim().length < 2) { setHits([]); return }
    if (tRef.current) clearTimeout(tRef.current)
    tRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/coins/search?q=${encodeURIComponent(q.trim())}`)
        const j = await r.json()
        setHits(Array.isArray(j.coins) ? j.coins : [])
      } catch {
        /* ignore */
      }
    }, 300)
    return () => {
      if (tRef.current) clearTimeout(tRef.current)
    }
  }, [q, picked])

  const submit = async () => {
    if (!picked) return
    setBusy(true)
    setErr(null)
    const r = await fetch('/api/tracker/lot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cg: picked.id, symbol: picked.symbol, name: picked.name, qty: Number(qty), priceUsd: Number(price), feeUsd: fee ? Number(fee) : undefined, ts: new Date(date).getTime() }),
    })
    const j = await r.json()
    setBusy(false)
    if (j.error) setErr(j.error)
    else { notify(`Added ${qty} ${picked.symbol}`, 'success'); onDone() }
  }

  return (
    <div className="animate-in mt-4 rounded-xl border border-white/[0.08] p-3">
      {!picked ? (
        <div className="relative">
          <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Search a coin</span>
            <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Bitcoin, ETH, Solana…" />
          </label>
          {hits.length > 0 && (
            <div className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-white/10 bg-[var(--modal)] p-1 shadow-xl">
              {hits.map((c) => (
                <button key={c.id} onClick={() => { setPicked(c); setHits([]) }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06]">
                  {c.thumb && <img src={c.thumb} alt="" className="h-5 w-5 rounded-full" />}
                  <span className="font-medium text-slate-200">{c.symbol}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{c.name}</span>
                  {c.rank && <span className="text-[10px] text-slate-600">#{c.rank}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {picked.thumb && <img src={picked.thumb} alt="" className="h-5 w-5 rounded-full" />}
            <span className="text-sm font-semibold text-slate-100">{picked.symbol}</span>
            <span className="text-xs text-slate-500">{picked.name}</span>
            <button className="ml-auto text-[11px] text-indigo-300 hover:underline" onClick={() => setPicked(null)}>change</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Quantity</span><input className="input" type="number" autoFocus value={qty} onChange={(e) => setQty(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Buy price (USD)</span><input className="input" type="number" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Date</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] text-slate-400">Fee (opt)</span><input className="input" type="number" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" /></label>
          </div>
          {err && <div className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}
          <button className="btn-primary w-full" disabled={busy || !(Number(qty) > 0) || !(Number(price) >= 0)} onClick={submit}>{busy ? 'Adding…' : `Add ${qty || ''} ${picked.symbol}`}</button>
        </div>
      )}
    </div>
  )
}
