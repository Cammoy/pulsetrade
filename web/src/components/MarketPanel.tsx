import { useEffect, useState } from 'react'
import { fmtPct, pnlColor } from '../format'
import Sparkline from './Sparkline'

interface MarketCoin {
  id: string
  symbol: string
  name: string
  priceUsd: number | null
  change24h: number | null
  change7d: number | null
  marketCapUsd: number | null
  volume24hUsd: number | null
  sparkline7d: number[]
  signal: { action: 'buy' | 'sell' | 'hold'; score: number; reasons: string[] }
}

interface Overview {
  at: number
  global: {
    marketCapUsd: number | null
    marketCapChange24hPct: number | null
    volume24hUsd: number | null
    btcDominancePct: number | null
    ethDominancePct: number | null
    activeCryptocurrencies: number | null
  }
  fearGreed: { value: number; classification: string } | null
  status: { label: 'risk-on' | 'neutral' | 'risk-off'; composite: number; blurb: string }
  coins: MarketCoin[]
}

const big = (v: number | null) => {
  if (v === null) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
  return `$${v.toLocaleString()}`
}

const price = (v: number | null) =>
  v === null ? '—' : v >= 1000 ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(3)}`

const STATUS_META = {
  'risk-on': { label: 'Risk-on · Bullish', dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'border-emerald-400/40 bg-emerald-500/[0.07]' },
  neutral: { label: 'Neutral · Mixed', dot: 'bg-amber-400', text: 'text-amber-300', ring: 'border-amber-400/40 bg-amber-500/[0.06]' },
  'risk-off': { label: 'Risk-off · Bearish', dot: 'bg-rose-400', text: 'text-rose-300', ring: 'border-rose-400/40 bg-rose-500/[0.07]' },
} as const

const SIGNAL_CHIP = {
  buy: 'bg-emerald-500/15 text-emerald-300',
  sell: 'bg-rose-500/15 text-rose-300',
  hold: 'bg-slate-500/15 text-slate-400',
} as const

/** Fear & Greed dial: a simple gradient meter with a needle position. */
function FearGreedMeter({ value, classification }: { value: number; classification: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Fear &amp; Greed</span>
        <span className={`text-sm font-bold tabular-nums ${value >= 60 ? 'text-emerald-300' : value <= 40 ? 'text-rose-300' : 'text-amber-300'}`}>
          {value} <span className="text-[10px] font-medium text-slate-400">{classification}</span>
        </span>
      </div>
      <div className="relative mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400 opacity-80">
        <div className="absolute top-1/2 h-3.5 w-1 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: `calc(${Math.min(99, Math.max(1, value))}% - 2px)` }} />
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-slate-600"><span>Extreme fear</span><span>Extreme greed</span></div>
    </div>
  )
}

export default function MarketPanel() {
  const [data, setData] = useState<Overview | null>(null)
  const [err, setErr] = useState(false)

  const load = async () => {
    try {
      const r = await fetch('/api/market')
      const d = await r.json()
      if (d?.coins) setData(d)
      else setErr(true)
    } catch {
      setErr(true)
    }
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
        <div className="glass shimmer h-32" />
        <div className="glass shimmer h-72" />
      </div>
    )

  const st = STATUS_META[data.status.label]
  const buys = data.coins.filter((c) => c.signal.action === 'buy').length
  const sells = data.coins.filter((c) => c.signal.action === 'sell').length

  return (
    <div className="space-y-3">
      {/* ── Market pulse hero ── */}
      <section className={`animate-in rounded-2xl border p-4 ${st.ring}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`h-2.5 w-2.5 rounded-full ${st.dot} pulse-dot`} />
          <h2 className={`text-lg font-bold ${st.text}`}>{st.label}</h2>
          <span className="text-xs tabular-nums text-slate-500">pulse {data.status.composite}/100</span>
          <span className="ml-auto text-[10px] text-slate-600">updates every 3 min</span>
        </div>
        <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-slate-300">{data.status.blurb}</p>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { l: 'Total market cap', v: big(data.global.marketCapUsd), sub: data.global.marketCapChange24hPct !== null ? fmtPct(data.global.marketCapChange24hPct) + ' 24h' : '', subColor: pnlColor(data.global.marketCapChange24hPct ?? 0) },
            { l: '24h volume', v: big(data.global.volume24hUsd), sub: '' },
            { l: 'BTC dominance', v: data.global.btcDominancePct !== null ? `${data.global.btcDominancePct.toFixed(1)}%` : '—', sub: data.global.ethDominancePct !== null ? `ETH ${data.global.ethDominancePct.toFixed(1)}%` : '' },
            { l: 'Signal breadth', v: `${buys} buy · ${sells} sell`, sub: `of top ${data.coins.length} coins` },
          ].map((x) => (
            <div key={x.l} className="rounded-xl bg-black/20 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{x.l}</div>
              <div className="text-sm font-bold tabular-nums text-white">{x.v}</div>
              {x.sub && <div className={`text-[10px] tabular-nums ${x.subColor ?? 'text-slate-500'}`}>{x.sub}</div>}
            </div>
          ))}
          <div className="col-span-2 rounded-xl bg-black/20 px-3 py-2 sm:col-span-1">
            {data.fearGreed ? <FearGreedMeter value={data.fearGreed.value} classification={data.fearGreed.classification} /> : <div className="text-[11px] text-slate-600">Sentiment unavailable</div>}
          </div>
        </div>
      </section>

      {/* ── Top coins ── */}
      <section className="glass animate-in overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Top coins · 7d</h3>
          <span className="text-[10px] text-slate-600">technical signals from RSI · EMA trend · momentum — evidence, not advice</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                {['#', 'Coin', 'Price', '24h', '7d chart', 'Signal', 'Mkt cap'].map((h) => (
                  <th key={h} className="px-3 py-1.5 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.coins.map((c, i) => (
                <tr key={c.id} className="border-t border-white/[0.04] tabular-nums transition-colors hover:bg-white/[0.03]">
                  <td className="px-3 py-2 text-slate-600">{i + 1}</td>
                  <td className="px-3 py-2">
                    <span className="font-semibold text-slate-100">{c.symbol}</span>
                    <span className="ml-1.5 hidden text-slate-500 sm:inline">{c.name}</span>
                  </td>
                  <td className="px-3 py-2 font-medium text-slate-200">{price(c.priceUsd)}</td>
                  <td className={`px-3 py-2 font-semibold ${pnlColor(c.change24h ?? 0)}`}>{c.change24h !== null ? fmtPct(c.change24h) : '—'}</td>
                  <td className="px-3 py-2">
                    {c.sparkline7d.length > 2 ? <Sparkline points={c.sparkline7d} width={96} height={26} /> : <span className="text-slate-700">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`chip cursor-help font-bold uppercase ${SIGNAL_CHIP[c.signal.action]}`}
                      title={`Score ${c.signal.score > 0 ? '+' : ''}${c.signal.score}\n• ${c.signal.reasons.join('\n• ')}`}
                    >
                      {c.signal.action}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{big(c.marketCapUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-white/[0.05] px-4 py-2 text-[10px] leading-relaxed text-slate-600">
          BUY/SELL chips are technical reads (hover for the reasons). They power your judgement — they are not financial advice. Data: CoinGecko &amp; alternative.me.
        </p>
      </section>
    </div>
  )
}
