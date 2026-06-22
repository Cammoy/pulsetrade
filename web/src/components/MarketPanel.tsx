import { useEffect, useState } from 'react'
import { fmtPct, pnlColor, timeAgo, fmtCompactUsd as big } from '../format'
import type { MarketOverview } from '../types'
import MarketDeck from './MarketDeck'

const STATUS_META = {
  'risk-on': { label: 'Risk-on · Bullish', dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'border-emerald-400/40 bg-emerald-500/[0.07]' },
  neutral: { label: 'Neutral · Mixed', dot: 'bg-amber-400', text: 'text-amber-300', ring: 'border-amber-400/40 bg-amber-500/[0.06]' },
  'risk-off': { label: 'Risk-off · Bearish', dot: 'bg-rose-400', text: 'text-rose-300', ring: 'border-rose-400/40 bg-rose-500/[0.07]' },
} as const

/** Fear & Greed dial: a gradient meter with a needle. */
function FearGreedMeter({ value, classification }: { value: number; classification: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Fear &amp; Greed</span>
        <span className={`text-sm font-bold tabular-nums ${value >= 60 ? 'text-emerald-300' : value <= 40 ? 'text-rose-300' : 'text-amber-300'}`}>
          {value} <span className="text-[10px] font-medium text-slate-400">{classification}</span>
        </span>
      </div>
      <div className="fg-meter relative mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400 opacity-80">
        <div className="fg-needle absolute top-1/2 h-3.5 w-1 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: `calc(${Math.min(99, Math.max(1, value))}% - 2px)` }} />
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-slate-600"><span>Extreme fear</span><span>Extreme greed</span></div>
    </div>
  )
}

export default function MarketPanel() {
  const [data, setData] = useState<MarketOverview | null>(null)
  const [err, setErr] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [heroOpen, setHeroOpen] = useState(false)

  const load = async () => {
    setRefreshing(true)
    try {
      const r = await fetch('/api/market')
      const d = await r.json()
      if (d?.coins) {
        setData(d)
        setErr(false)
      } else if (!data) setErr(true)
    } catch {
      if (!data) setErr(true)
    }
    setRefreshing(false)
  }
  useEffect(() => {
    load()
    const t = setInterval(load, 180_000)
    return () => clearInterval(t)
  }, [])

  if (err && !data)
    return <div className="glass animate-in p-6 text-center text-sm text-slate-500">Market data is unavailable right now — it retries automatically.</div>
  if (!data)
    return (
      <div className="space-y-3">
        <div className="glass shimmer h-20" />
        <div className="flex gap-3 overflow-hidden">
          {[0, 1, 2, 3].map((i) => <div key={i} className="glass shimmer h-96 w-[300px] shrink-0" />)}
        </div>
      </div>
    )

  const st = STATUS_META[data.status.label]
  const buys = data.coins.filter((c) => c.signal.action === 'buy').length
  const sells = data.coins.filter((c) => c.signal.action === 'sell').length
  const delayed = data.backoffMs > 0

  return (
    <div className="space-y-3">
      {/* ── Market pulse hero (full on desktop, collapsible on mobile) ── */}
      <section className={`market-hero animate-in rounded-2xl border ${st.ring}`}>
        <div className="flex items-center gap-2 p-3">
          <button onClick={() => setHeroOpen((o) => !o)} aria-label="Toggle market overview details" className="flex min-w-0 flex-1 items-center gap-2 text-left lg:cursor-default" aria-expanded={heroOpen}>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.dot} pulse-dot`} />
            <h2 className={`text-base font-bold ${st.text}`}>{st.label}</h2>
            <span className="hidden text-xs tabular-nums text-slate-500 sm:inline">pulse {data.status.composite}/100</span>
            {delayed && <span className="chip bg-amber-500/10 text-amber-300" title="CoinGecko rate limit — prices may lag">prices ~{Math.ceil(data.backoffMs / 60000) || 1}m delayed</span>}
          </button>
          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <span className="hidden sm:inline">updated {timeAgo(data.at)}</span>
            <button onClick={load} disabled={refreshing} className="btn-ghost !px-2 !py-1 text-[11px]" aria-label="Refresh market data">{refreshing ? '…' : '↻'}</button>
            <button onClick={() => setHeroOpen((o) => !o)} aria-label={heroOpen ? 'Collapse' : 'Expand'} className="grid h-6 w-6 place-items-center rounded-md text-slate-500 hover:bg-white/[0.06] lg:hidden">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${heroOpen ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </div>
        </div>

        <div className={`${heroOpen ? 'block' : 'hidden'} px-3 pb-3 lg:block`}>
          <p className="mb-3 max-w-3xl text-xs leading-relaxed text-slate-400">{data.status.blurb}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { l: 'Total market cap', v: big(data.global.marketCapUsd), sub: data.global.marketCapChange24hPct !== null ? fmtPct(data.global.marketCapChange24hPct) + ' 24h' : '', subColor: pnlColor(data.global.marketCapChange24hPct ?? 0) },
              { l: '24h volume', v: big(data.global.volume24hUsd), sub: '' },
              { l: 'BTC dominance', v: data.global.btcDominancePct !== null ? `${data.global.btcDominancePct.toFixed(1)}%` : '—', sub: data.global.ethDominancePct !== null ? `ETH ${data.global.ethDominancePct.toFixed(1)}%` : '' },
              { l: 'Signal breadth', v: `${buys} buy · ${sells} sell`, sub: `of ${data.coins.length} coins` },
            ].map((x) => (
              <div key={x.l} className="rounded-xl tile-sunken px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{x.l}</div>
                <div className="text-sm font-bold tabular-nums text-white">{x.v}</div>
                {x.sub && <div className={`text-[10px] tabular-nums ${x.subColor ?? 'text-slate-500'}`}>{x.sub}</div>}
              </div>
            ))}
            <div className="col-span-2 rounded-xl tile-sunken px-3 py-2 sm:col-span-1">
              {data.fearGreed ? <FearGreedMeter value={data.fearGreed.value} classification={data.fearGreed.classification} /> : <div className="text-[11px] text-slate-600">Sentiment unavailable</div>}
            </div>
          </div>
        </div>
      </section>

      {/* ── The Market Deck ── */}
      <MarketDeck data={data} />

      <p className="px-1 text-[10px] leading-relaxed text-slate-600">
        Swipe sideways across lanes; each lane scrolls its own coins. Tap a coin to expand it · ★ saves to your watchlist · BUY/SELL chips are technical reads (hover for reasons), not advice · data: CoinGecko, GeckoTerminal &amp; alternative.me.
      </p>
    </div>
  )
}
