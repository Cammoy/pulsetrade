import { useEffect, useState } from 'react'
import { fmtUsd, fmtCompactUsd, parseAmount, timeAgo } from '../format'
import type { EarnPayload, YieldPool } from '../types'

/**
 * Earn: where to park idle stablecoins for yield. Shows a live, safety-filtered shortlist of
 * single-asset stablecoin lending pools (DefiLlama, free) across the supported chains, with an
 * amount projector so you can see the $/yr at each rate. Informational — no funds move (live
 * auto-deposit is a gated follow-up). Lives as a tab inside the Portfolio (next to Staking),
 * self-fetching like the other intelligence surfaces.
 */
const AMT_KEY = 'pulsetrade.earn.amount'

export default function EarnSection() {
  const [data, setData] = useState<EarnPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState(() => {
    try {
      const v = Number(localStorage.getItem(AMT_KEY))
      return Number.isFinite(v) && v > 0 ? v : 10_000
    } catch {
      return 10_000
    }
  })

  const setAmt = (v: number) => {
    setAmount(v)
    try {
      localStorage.setItem(AMT_KEY, String(v))
    } catch {
      /* ignore */
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      setData(await fetch('/api/earn').then((r) => r.json()))
    } catch {
      setData({ pools: [], at: null, error: 'Network error' })
    }
    setLoading(false)
  }
  useEffect(() => {
    load()
  }, [])

  const pools = data?.pools ?? []
  const best = pools[0]

  return (
    <div className="animate-in space-y-4">
      {/* header */}
      <div className="glass flex items-center gap-2 p-4">
        <span className="text-base font-bold text-white">🌱 Earn</span>
        <span className="text-[12px] text-slate-500">park idle stablecoins for yield</span>
        <button onClick={load} disabled={loading} className="btn-ghost ml-auto !px-2 !py-1 text-[11px]" aria-label="Refresh">{loading ? '…' : '↻ Refresh'}</button>
      </div>

      {/* projector */}
      <div className="glass flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <label className="flex items-center gap-1.5 text-[12px] text-slate-400">
          If I park
          <span className="flex items-center rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 focus-within:border-emerald-400/60">
            <span className="text-slate-500">$</span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmt(parseAmount(e.target.value) ?? 0)} aria-label="Amount to park" className="w-24 bg-transparent text-right text-[13px] tabular-nums text-slate-100 outline-none" />
          </span>
        </label>
        {best && (
          <span className="text-[12px] text-slate-400">
            at the top rate ({best.apy}% on {best.project}) ≈{' '}
            <span className="font-bold tabular-nums text-emerald-400">{fmtUsd((amount * best.apy) / 100)}/yr</span>
          </span>
        )}
      </div>

      {/* list */}
      <div className="glass overflow-hidden">
        <div className="max-h-[30rem] overflow-y-auto p-3">
          {loading && !data ? (
            <div className="shimmer h-40 rounded-xl" />
          ) : pools.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-slate-600">
              {data?.error ? `Couldn't load yields (${data.error}).` : 'No qualifying stablecoin pools right now.'}
            </div>
          ) : (
            <div className="space-y-1.5">
              {pools.map((p) => (
                <PoolRow key={p.poolId || `${p.project}-${p.symbol}-${p.chain}`} p={p} amount={amount} />
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-slate-600">
        {data?.at ? `Rates from DefiLlama, updated ${timeAgo(data.at)}. ` : ''}Single-asset stablecoin pools ≥ $5M TVL on supported chains. APYs vary and DeFi carries smart-contract risk — not financial advice. Depositing is done on the protocol directly; in-app auto-deposit is a gated follow-up.
      </p>
    </div>
  )
}

function PoolRow({ p, amount }: { p: YieldPool; amount: number }) {
  return (
    <a
      href={p.poolId ? `https://defillama.com/yields/pool/${p.poolId}` : 'https://defillama.com/yields'}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 transition-colors hover:border-emerald-500/30 hover:bg-white/[0.04]"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-bold text-white">{p.symbol}</span>
          <span className="truncate text-[11px] text-slate-400">{p.project}</span>
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">{p.chain}</span>
        </div>
        <div className="mt-0.5 text-[10px] tabular-nums text-slate-500">
          {fmtCompactUsd(p.tvlUsd)} TVL
          {p.apyReward ? ` · ${p.apyBase ?? 0}% base + ${p.apyReward}% rewards` : ''}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[15px] font-bold tabular-nums text-emerald-400">{p.apy}%</div>
        <div className="text-[10px] tabular-nums text-slate-500">≈ {fmtUsd((amount * p.apy) / 100)}/yr</div>
      </div>
    </a>
  )
}
