import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { SmartIntelligence, TokenFlow, NotableMove, EmergingCoin } from '../types'
import { timeAgo, fmtCompactUsd as compact } from '../format'
import CoinLinks from './CoinLinks'

const SENTIMENT: Record<string, { label: string; cls: string }> = {
  'risk-on': { label: '🟢 Risk-on', cls: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300' },
  neutral: { label: '🟡 Neutral', cls: 'border-amber-400/30 bg-amber-500/10 text-amber-300' },
  'risk-off': { label: '🔴 Risk-off', cls: 'border-rose-400/30 bg-rose-500/10 text-rose-300' },
}

const firstName = (label: string) => label.split(/[(—·]/)[0].trim().split(' ').slice(0, 2).join(' ')

/**
 * Smart Money Intelligence dashboard: a collapsible Gemini brief, key metrics,
 * a "new coins" radar (what whales are buying, with research links), the
 * buying/selling board, and a cumulative-flow chart.
 */
export default function SmartInsights({ refreshKey = 0 }: { refreshKey?: number }) {
  const { createBot, notify, setView, mode } = useStore()
  const [data, setData] = useState<SmartIntelligence | null>(null)
  const [loading, setLoading] = useState(true)
  const [launching, setLaunching] = useState('')
  const [briefOpen, setBriefOpen] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/smart-money/insights')
      setData(await r.json())
    } catch {
      /* ignore */
    }
    setLoading(false)
  }
  // Reloads when the parent's "↻ Refresh" bumps refreshKey (and on mount).
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const trade = async (network: string, token: string) => {
    setLaunching(`${network}:${token}`)
    const out = await createBot({ network, token, strategy: 'adaptive', risk: 'balanced', budgetUsd: 200, sweepTo: 'native' })
    setLaunching('')
    if (out.error) notify(out.error, 'error')
    else {
      notify(`🌤️ All-Weather bot launched on ${token} (${mode} mode)`, 'success')
      setView('home')
    }
  }

  if (data?.needsTracking) return null

  const insight = data?.insight
  const ov = data?.overview
  const derived = ov ? (ov.stableNetUsd > 250_000 ? 'risk-off' : ov.stableNetUsd < -250_000 ? 'risk-on' : 'neutral') : null
  const sentiment = SENTIMENT[insight?.sentiment ?? derived ?? ''] ?? null

  return (
    <div className="space-y-4">
      {/* ── AI brief (collapsible) ── */}
      <div className="glass relative overflow-hidden p-4">
        <div className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="relative">
          <div className="flex items-center gap-2">
            <button className="flex min-w-0 items-center gap-2 text-left" onClick={() => setBriefOpen((o) => !o)} aria-expanded={briefOpen}>
              <span className="text-sm font-bold text-white">🧠 Smart Money Intelligence</span>
              {sentiment && <span className={`chip border ${sentiment.cls}`}>{sentiment.label}</span>}
            </button>
            <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">
              {data?.generatedAt && <span className="hidden sm:inline">updated {timeAgo(data.generatedAt)}</span>}
              <button className="btn-ghost !px-2 !py-1 text-[11px]" onClick={load} disabled={loading}>{loading ? '…' : '↻'}</button>
              <button onClick={() => setBriefOpen((o) => !o)} aria-label={briefOpen ? 'Collapse' : 'Expand'} className="grid h-6 w-6 place-items-center rounded-md text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${briefOpen ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
              </button>
            </div>
          </div>

          {loading && !data && <div className="shimmer mt-3 h-20 rounded-xl" />}

          {/* collapsed peek: one-line headline */}
          {!briefOpen && insight && <div className="mt-2 truncate text-sm text-slate-300">{insight.headline}</div>}

          {briefOpen &&
            (insight ? (
              <div className="mt-3 space-y-3">
                <div>
                  <div className="text-lg font-bold leading-snug text-white">{insight.headline}</div>
                  <p className="mt-1 text-sm leading-relaxed text-slate-300">{insight.summary}</p>
                  {insight.rotation?.trim() && (
                    <div className="mt-2 inline-flex items-start gap-1.5 rounded-lg border border-indigo-400/20 bg-indigo-500/[0.07] px-2.5 py-1 text-xs text-indigo-200">
                      <span>🔄</span>
                      <span>{insight.rotation}</span>
                    </div>
                  )}
                </div>
                {insight.highlights.length > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {insight.highlights.map((h, i) => (
                      <div key={i} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-2.5">
                        <div className="text-xs font-semibold text-slate-100">{h.title}</div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{h.detail}</div>
                      </div>
                    ))}
                  </div>
                )}
                {insight.watch.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-slate-500">👀 Watch:</span>
                    {insight.watch.map((w) => (
                      <span key={w} className="chip bg-indigo-500/10 font-semibold text-indigo-300">{w}</span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              !loading && (
                <div className="mt-3 rounded-xl bg-white/[0.03] p-3 text-xs leading-relaxed text-slate-400">
                  {data?.needsAi ? (
                    <>Add <code className="rounded code-block px-1">GEMINI_API_KEY</code> to <code className="rounded code-block px-1">server/.env</code> (free at aistudio.google.com) for an AI brief. The board &amp; charts below work without it.</>
                  ) : (
                    'Building the intelligence brief from recent on-chain flow…'
                  )}
                </div>
              )
            ))}
        </div>
      </div>

      {/* ── Metrics ── */}
      {ov && ov.totalBuyUsd + ov.totalSellUsd > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Bought" value={compact(ov.totalBuyUsd)} cls="text-emerald-400" />
          <Stat label="Sold" value={compact(ov.totalSellUsd)} cls="text-rose-400" />
          <Stat label="Net flow" value={`${ov.netUsd >= 0 ? '+' : ''}${compact(ov.netUsd)}`} cls={ov.netUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
          <Stat label={ov.stableNetUsd >= 0 ? 'Into stables' : 'Out of stables'} value={compact(Math.abs(ov.stableNetUsd))} cls="text-slate-200" sub={ov.stableNetUsd >= 0 ? 'de-risking' : 'deploying'} />
        </div>
      )}

      {/* ── 🆕 New coins radar ── */}
      {ov && (
        <div className="glass p-4">
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-sm font-bold text-white">🆕 New coins on the radar</span>
            <span className="text-[11px] text-slate-500">unlisted tokens ≥2 whales are accumulating</span>
          </div>
          {ov.emerging.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ov.emerging.map((c) => (
                <EmergingCard key={`${c.network}:${c.tokenAddress}`} c={c} />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-5 text-center text-[11px] leading-relaxed text-slate-500">
              No multi-whale accumulation in unlisted tokens right now.<br />
              We only surface coins <span className="text-slate-400">2+ tracked wallets are repeatedly buying</span> — one-off airdrops &amp; spam are filtered out. Smart money is currently concentrated in the majors above.
            </div>
          )}
        </div>
      )}

      {/* ── Buying vs Selling board ── */}
      {ov && (ov.accumulating.length > 0 || ov.distributing.length > 0) && (
        <div className="grid gap-3 lg:grid-cols-2">
          <HotColumn title="🟢 Buying" subtitle="net accumulation (priced)" rows={ov.accumulating} positive launching={launching} onTrade={trade} />
          <HotColumn title="🔴 Selling" subtitle="net distribution (priced)" rows={ov.distributing} positive={false} launching={launching} onTrade={trade} />
        </div>
      )}

      {/* ── Flow trajectory + notable trades ── */}
      {ov && ov.flowSeries.length >= 2 && (
        <div className="glass p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">Cumulative net flow ({ov.windowDays}d)</span>
            <span className="flex items-center gap-2 text-[10px]">
              <span className="flex items-center gap-1 text-emerald-300"><span className="h-1.5 w-3 rounded bg-emerald-400" />risk assets</span>
              <span className="flex items-center gap-1 text-amber-300"><span className="h-1.5 w-3 rounded bg-amber-400" />stablecoins</span>
            </span>
          </div>
          <FlowChart series={ov.flowSeries} />
          {ov.notable.length > 0 && (
            <div className="mt-3 border-t border-white/[0.08] pt-3">
              <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">Notable trades</div>
              <div className="flex flex-wrap gap-1.5">
                {ov.notable.slice(0, 10).map((n: NotableMove, i) => (
                  <span key={i} className={`chip border ${n.side === 'buy' ? 'border-emerald-400/20 bg-emerald-500/[0.07] text-emerald-200' : 'border-rose-400/20 bg-rose-500/[0.07] text-rose-200'}`} title={`${n.network} · ${timeAgo(n.ts)}`}>
                    {firstName(n.wallet)} {n.side === 'buy' ? '▲' : '▼'} {compact(n.usd)} {n.token}
                  </span>
                ))}
              </div>
            </div>
          )}
          <p className="mt-2 text-[10px] text-slate-600">AI &amp; data derived from on-chain flow across mainnet + L2s — not financial advice.</p>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, cls, sub }: { label: string; value: string; cls: string; sub?: string }) {
  return (
    <div className="glass px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-base font-bold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[9px] text-slate-600">{sub}</div>}
    </div>
  )
}

function EmergingCard({ c }: { c: EmergingCoin }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 transition-colors hover:border-indigo-400/30">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-bold text-white" title={c.token}>{c.token}</span>
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">{c.network}</span>
        {c.buyers >= 2 && <span className="chip ml-auto bg-emerald-500/10 text-[10px] text-emerald-300">🔥 {c.buyers} whales</span>}
        {c.buyers < 2 && c.usd && <span className="ml-auto text-xs font-semibold tabular-nums text-emerald-400">{compact(c.usd)}</span>}
      </div>
      <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400">
        <span className="text-slate-500">🐋</span>
        <span className="truncate">{c.wallets.map(firstName).join(', ')}</span>
        <span className="ml-auto shrink-0 text-slate-600">{c.buys} buys · {timeAgo(c.lastTs)}</span>
      </div>
      <div className="mt-2">
        <CoinLinks network={c.network} address={c.tokenAddress} />
      </div>
    </div>
  )
}

function HotColumn({ title, subtitle, rows, positive, launching, onTrade }: { title: string; subtitle: string; rows: TokenFlow[]; positive: boolean; launching: string; onTrade: (network: string, token: string) => void }) {
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.netUsd)))
  return (
    <div className="glass p-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-sm font-bold text-white">{title}</span>
        <span className="text-[11px] text-slate-500">{subtitle}</span>
      </div>
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-slate-600">No net {positive ? 'buying' : 'selling'} of priced assets in the window.</div>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 6).map((f) => (
            <HotCard key={`${f.network}:${f.tokenAddress}`} f={f} positive={positive} intensity={Math.abs(f.netUsd) / maxAbs} launching={launching === `${f.network}:${f.token}`} onTrade={onTrade} />
          ))}
        </div>
      )}
    </div>
  )
}

function HotCard({ f, positive, intensity, launching, onTrade }: { f: TokenFlow; positive: boolean; intensity: number; launching: boolean; onTrade: (network: string, token: string) => void }) {
  const whales = positive ? f.buyers : f.sellers
  return (
    <div className={`relative overflow-hidden rounded-xl border bg-white/[0.02] p-3 transition-colors ${positive ? 'border-emerald-500/15 hover:border-emerald-500/30' : 'border-rose-500/15 hover:border-rose-500/30'}`}>
      <div className={`absolute inset-y-0 left-0 ${positive ? 'bg-emerald-500/[0.06]' : 'bg-rose-500/[0.06]'}`} style={{ width: `${Math.max(8, intensity * 100)}%` }} />
      <div className="relative">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">{f.token}</span>
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">{f.network}</span>
          {whales >= 2 && <span className={`chip text-[10px] ${positive ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>🔥 {whales} whales</span>}
          <span className={`ml-auto text-base font-bold tabular-nums ${positive ? 'text-emerald-400' : 'text-rose-400'}`}>{f.netUsd >= 0 ? '+' : ''}{compact(f.netUsd)}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-slate-400">
          <span className="text-slate-500">{positive ? '🐋 buying:' : '🐋 selling:'}</span>
          <span className="truncate">{f.wallets.length ? f.wallets.map(firstName).join(', ') : `${whales} wallet(s)`}</span>
          <span className="ml-auto shrink-0 text-slate-600">{timeAgo(f.lastTs)}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {f.curated && (
            <button className="btn-primary !py-1 text-[11px]" disabled={launching} onClick={() => onTrade(f.network, f.token)}>
              {launching ? 'Launching…' : '🌤️ Trade'}
            </button>
          )}
          <CoinLinks network={f.network} address={f.tokenAddress} />
        </div>
      </div>
    </div>
  )
}

function FlowChart({ series }: { series: { t: number; risk: number; stable: number }[] }) {
  const W = 680
  const H = 90
  const PAD = 4
  const vals = series.flatMap((p) => [p.risk, p.stable, 0])
  let min = Math.min(...vals)
  let max = Math.max(...vals)
  if (min === max) {
    min -= 1
    max += 1
  }
  const x = (i: number) => PAD + (i / (series.length - 1)) * (W - 2 * PAD)
  const y = (v: number) => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD)
  const path = (key: 'risk' | 'stable') => series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ')
  const zeroY = y(0)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} preserveAspectRatio="none">
      <line x1={PAD} x2={W - PAD} y1={zeroY} y2={zeroY} stroke="#475569" strokeDasharray="3 3" strokeWidth="0.75" />
      <path d={path('stable')} fill="none" stroke="#f59e0b" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" opacity="0.85" />
      <path d={path('risk')} fill="none" stroke="#34d399" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
