import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { useWatchlist } from '../useWatchlist'
import { useNewPools } from '../useNewPools'
import { pnlColor, fmtCompactUsd as big } from '../format'
import { iconUrl } from '../icon'
import type { MarketCoin, MarketOverview, SafePool } from '../types'
import Sparkline from './Sparkline'
import NetworkSelect from './NetworkSelect'

// ── formatters ───────────────────────────────────────────────────────────────
const price = (v: number | null) =>
  v === null || !Number.isFinite(v)
    ? '—'
    : v >= 1000
      ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : v >= 1
        ? `$${v.toFixed(2)}`
        : `$${v.toPrecision(3)}`
const ageLabel = (mins: number | null) => {
  if (mins === null || !Number.isFinite(mins)) return 'new'
  if (mins < 60) return `${Math.round(mins)}m`
  if (mins < 1440) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

// ── lane accents (literal classes — Tailwind v4 purges dynamic names) ─────────
type Accent = 'amber' | 'cyan' | 'slate' | 'emerald' | 'rose' | 'indigo' | 'violet'
const ACCENT: Record<Accent, { line: string; text: string; dot: string; glow: string }> = {
  amber: { line: 'bg-amber-400', text: 'text-amber-300', dot: 'bg-amber-400', glow: 'bg-amber-500/10' },
  cyan: { line: 'bg-cyan-400', text: 'text-cyan-300', dot: 'bg-cyan-400', glow: 'bg-cyan-500/10' },
  slate: { line: 'bg-slate-400', text: 'text-slate-300', dot: 'bg-slate-400', glow: 'bg-slate-500/10' },
  emerald: { line: 'bg-emerald-400', text: 'text-emerald-300', dot: 'bg-emerald-400', glow: 'bg-emerald-500/10' },
  rose: { line: 'bg-rose-400', text: 'text-rose-300', dot: 'bg-rose-400', glow: 'bg-rose-500/10' },
  indigo: { line: 'bg-indigo-400', text: 'text-indigo-300', dot: 'bg-indigo-400', glow: 'bg-indigo-500/10' },
  violet: { line: 'bg-violet-400', text: 'text-violet-300', dot: 'bg-violet-400', glow: 'bg-violet-500/10' },
}
const SIGNAL_CHIP = {
  buy: 'bg-emerald-500/15 text-emerald-300',
  sell: 'bg-rose-500/15 text-rose-300',
  hold: 'bg-slate-500/15 text-slate-400',
} as const

interface LaneDef {
  key: string
  title: string
  icon: string
  accent: Accent
  blurb: string
  coins: MarketCoin[]
  emptyText: string
  pulse?: boolean
}

/** A stub coin for a saved watchlist id that fell out of the top-250 payload. */
const stubCoin = (s: { id: string; symbol: string; name: string }): MarketCoin => ({
  id: s.id, symbol: s.symbol, name: s.name, image: null, priceUsd: null, change1h: null, change24h: null,
  change7d: null, marketCapUsd: null, marketCapRank: null, volume24hUsd: null, athChangePct: null,
  volToMcap: null, rsi: null, stable: false, sparkline7d: [], signal: { action: 'hold', score: 0, reasons: ['outside top 250 — live data pending'] },
})

export default function MarketDeck({ data }: { data: MarketOverview }) {
  const { createBot, notify, setView, selectBot, refresh, meta } = useStore(
    useShallow((s) => ({ createBot: s.createBot, notify: s.notify, setView: s.setView, selectBot: s.selectBot, refresh: s.refresh, meta: s.meta })),
  )
  const wl = useWatchlist()
  // Keep a ref so the save callback is STABLE (doesn't change identity when the
  // watchlist updates) — otherwise every save would re-render all ~100 cards.
  const wlRef = useRef(wl)
  wlRef.current = wl
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState(0)
  const [edges, setEdges] = useState({ left: false, right: true })
  const [launching, setLaunching] = useState('')

  // id → coin across the wide pull AND trending (trending may carry coins not in the 250).
  const byId = useMemo(() => {
    const m = new Map<string, MarketCoin>()
    for (const c of data.coins) m.set(c.id, c)
    for (const c of data.trending) if (!m.has(c.id)) m.set(c.id, c)
    return m
  }, [data])

  const pick = useCallback((ids: string[]) => ids.map((id) => byId.get(id)).filter(Boolean) as MarketCoin[], [byId])

  // New(DEX) pools come from a separate GeckoTerminal+GoPlus screen, but it's
  // cached 3min server-side so one fetch on mount is cheap — load it eagerly so
  // the lane is ready by the time the user scrolls to it. The feed is per-chain,
  // so the lane carries its own network picker (defaults to Base).
  const [poolNet, setPoolNet] = useState('base')
  const { pools, loading: poolsLoading, error: poolsError } = useNewPools(poolNet, true)
  // New-launch screening is EVM-only (GeckoTerminal `gt` chains); never offer a
  // holdings-only chain here.
  const poolNetworks = useMemo(
    () => (meta?.networks ?? []).filter((n) => n.evm !== false && n.tradeable !== false),
    [meta],
  )

  const watchCoins = useMemo(() => wl.items.map((s) => byId.get(s.id) ?? stubCoin(s)), [wl.items, byId])

  const lanes: LaneDef[] = useMemo(
    () => [
      { key: 'watchlist', title: 'Watchlist', icon: '⭐', accent: 'amber', blurb: 'your saved coins', coins: watchCoins, emptyText: 'Tap the ☆ on any coin to track it here.' },
      { key: 'trending', title: 'Trending', icon: '🔥', accent: 'cyan', blurb: 'hottest right now', coins: data.trending, emptyText: 'Trending feed unavailable.', pulse: true },
      { key: 'gainers', title: 'Gainers', icon: '📈', accent: 'emerald', blurb: 'biggest 24h winners', coins: pick(data.lanes.gainers ?? []), emptyText: 'No gainers.' },
      { key: 'losers', title: 'Losers', icon: '📉', accent: 'rose', blurb: 'biggest 24h fallers', coins: pick(data.lanes.losers ?? []), emptyText: 'No losers.' },
      { key: 'inplay', title: 'In Play', icon: '⚡', accent: 'cyan', blurb: 'unusual volume vs size', coins: pick(data.lanes.inplay ?? []), emptyText: 'Nothing unusual right now.' },
      { key: 'oversold', title: 'Dips', icon: '🩸', accent: 'indigo', blurb: 'oversold & beaten-down', coins: pick(data.lanes.oversold ?? []), emptyText: 'No oversold dips right now — the tape is strong. Bottom-fishing a rip rarely pays.' },
    ],
    [data, watchCoins, pick],
  )

  // ── deck scroll tracking (active lane + edge masks) ──
  const sync = useCallback(() => {
    const el = trackRef.current
    if (!el) return
    const children = Array.from(el.children) as HTMLElement[]
    let nearest = 0
    let best = Infinity
    children.forEach((c, i) => {
      const d = Math.abs(c.offsetLeft - el.scrollLeft - 8)
      if (d < best) { best = d; nearest = i }
    })
    setActive(nearest)
    setEdges({ left: el.scrollLeft > 8, right: el.scrollLeft < el.scrollWidth - el.clientWidth - 8 })
  }, [])

  useEffect(() => {
    sync()
    const el = trackRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(sync)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', sync)
    return () => {
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', sync)
      cancelAnimationFrame(raf)
    }
  }, [sync, lanes.length])

  const scrollToLane = (i: number) => {
    const el = trackRef.current
    const child = el?.children[i] as HTMLElement | undefined
    if (el && child) el.scrollTo({ left: child.offsetLeft - 8, behavior: 'smooth' })
  }
  const page = (dir: -1 | 1) => scrollToLane(Math.max(0, Math.min(lanes.length, active + dir)))

  // Mouse drag-to-pan (mouse only — touch/trackpad use native scroll-snap).
  const drag = useRef({ on: false, startX: 0, startScroll: 0, moved: false })
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || (e.target as HTMLElement).closest('button, a, input, select')) return
    drag.current = { on: true, startX: e.clientX, startScroll: trackRef.current?.scrollLeft ?? 0, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.on || !trackRef.current) return
    const dx = e.clientX - drag.current.startX
    if (Math.abs(dx) > 5) drag.current.moved = true
    if (drag.current.moved) trackRef.current.scrollLeft = drag.current.startScroll - dx
  }
  const endDrag = () => { drag.current.on = false }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); page(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); page(-1) }
    else if (e.key === 'Home') { e.preventDefault(); scrollToLane(0) }
    else if (e.key === 'End') { e.preventDefault(); scrollToLane(lanes.length) }
  }

  // ── actions (stable identities so memoised cards don't re-render) ──
  const trade = useCallback(async (c: MarketCoin) => {
    setLaunching(c.id)
    const out = await createBot({ network: 'market', token: c.symbol, cg: c.id, name: `${c.symbol} · Market`, strategy: 'adaptive', risk: 'balanced', budgetUsd: 200, sweepTo: 'native' })
    setLaunching('')
    if (out.error) return notify(out.error, 'error')
    notify(`🌤️ All-Weather bot launched on ${c.symbol}`, 'success')
    if (out.id) selectBot(out.id)
    setView('home')
  }, [createBot, notify, selectBot, setView])

  const snipe = useCallback(async (p: SafePool) => {
    setLaunching(p.poolAddress)
    try {
      const r = await fetch('/api/sniper', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network: p.network, poolAddress: p.poolAddress, tokenAddress: p.tokenAddress, tokenSymbol: p.tokenSymbol, tokenName: p.tokenName, budgetUsd: 200, sniper: { takeProfitPct: 50, stopLossPct: 25, maxHoldMin: 120 } }),
      })
      const d = await r.json()
      if (d.error) notify(d.error, 'error')
      else {
        notify(`🎯 Sniping ${p.tokenSymbol}`, 'success')
        await refresh().catch(() => {})
        if (d.id) selectBot(d.id)
        setView('home')
      }
    } catch {
      notify('Engine unreachable', 'error')
    }
    setLaunching('')
  }, [notify, refresh, selectBot, setView])

  // Returns the new saved-state so the card can report it accurately.
  const onSave = useCallback((c: MarketCoin) => wlRef.current.toggle({ id: c.id, symbol: c.symbol, name: c.name }), [])

  const laneTitles = [...lanes.map((l) => l.title), 'New (DEX)'] // dot-rail labels (+ New DEX)

  return (
    <div className="relative">
      {/* edge chevrons (desktop) */}
      {edges.left && (
        <button onClick={() => page(-1)} aria-label="Previous lanes" className="absolute -left-2 top-1/2 z-20 hidden -translate-y-1/2 rounded-full border border-white/10 bg-[var(--surface-card)] dark:bg-slate-900/80 p-2 text-slate-700 shadow-lg backdrop-blur transition hover:bg-[var(--surface-hover)] dark:text-slate-200 dark:hover:bg-slate-800 lg:block">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
      )}
      {edges.right && (
        <button onClick={() => page(1)} aria-label="More lanes" className="absolute -right-2 top-1/2 z-20 hidden -translate-y-1/2 rounded-full border border-white/10 bg-[var(--surface-card)] dark:bg-slate-900/80 p-2 text-slate-700 shadow-lg backdrop-blur transition hover:bg-[var(--surface-hover)] dark:text-slate-200 dark:hover:bg-slate-800 lg:block">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6" /></svg>
        </button>
      )}

      <div
        ref={trackRef}
        tabIndex={0}
        role="region"
        aria-label="Market lanes — scroll sideways"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onKeyDown={onKeyDown}
        className="no-scrollbar deck-fade flex snap-x snap-proximity gap-3 overflow-x-auto scroll-smooth pb-1 outline-none"
        style={{ scrollPaddingLeft: 8, touchAction: 'pan-x' }}
      >
        {lanes.map((lane) => (
          <Lane key={lane.key} lane={lane} has={wl.has} launching={launching} onTrade={trade} onSave={onSave} notify={notify} />
        ))}
        <NewPoolsLane pools={pools} loading={poolsLoading} error={poolsError} launching={launching} onSnipe={snipe} active network={poolNet} onNetwork={setPoolNet} networks={poolNetworks} />
      </div>

      {/* dot-rail */}
      <div className="mt-3 flex items-center justify-center gap-1.5">
        {laneTitles.map((title, i) => (
          <button
            key={i}
            aria-label={`Go to ${title} lane`}
            aria-current={i === active ? 'true' : undefined}
            onClick={() => scrollToLane(i)}
            className={`h-1.5 rounded-full transition-all ${i === active ? 'w-6 bg-indigo-400' : 'w-1.5 bg-[var(--border-strong)] hover:bg-[var(--color-slate-500)] dark:bg-white/15 dark:hover:bg-white/30'}`}
          />
        ))}
      </div>
    </div>
  )
}

// ── Lane ───────────────────────────────────────────────────────────────────
const Lane = memo(function Lane({
  lane, has, launching, onTrade, onSave, notify,
}: {
  lane: LaneDef
  has: (id: string) => boolean
  launching: string
  onTrade: (c: MarketCoin) => void
  onSave: (c: MarketCoin) => boolean
  notify: (m: string, t?: 'error' | 'success' | 'info') => void
}) {
  const a = ACCENT[lane.accent]
  return (
    <section className="flex w-[86vw] shrink-0 snap-start flex-col sm:w-[300px]" aria-label={`${lane.title} — ${lane.blurb}`}>
      <div className="glass relative flex flex-col overflow-hidden" style={{ height: 'min(74vh, 660px)' }}>
        <div className={`lane-bar absolute inset-x-0 top-0 h-0.5 ${a.line}`} />
        <div className={`lane-glow pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full blur-2xl ${a.glow}`} />
        {/* header — pinned (sits outside the scrolling body) */}
        <div className="relative flex shrink-0 items-center gap-2 border-b border-white/[0.08] px-3 py-2.5">
          <span className="text-base" aria-hidden="true">{lane.icon}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className={`text-sm font-bold ${a.text}`}>{lane.title}</h3>
              {lane.pulse && <span className={`h-1.5 w-1.5 rounded-full ${a.dot} pulse-dot`} />}
            </div>
            <div className="truncate text-[10px] text-slate-500">{lane.blurb}</div>
          </div>
          <span className="ml-auto rounded-full bg-[var(--surface-sunken)] px-2 py-0.5 text-[10px] font-semibold tabular-nums text-slate-400 dark:bg-white/[0.06]">{lane.coins.length}</span>
        </div>
        {/* body — the only part that scrolls (pan-y so vertical swipes don't fight the deck's horizontal snap) */}
        <div className="lane-body no-scrollbar relative min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2.5 py-2.5" style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}>
          {lane.coins.length === 0 ? (
            <div className="flex h-full items-center justify-center px-3 text-center text-[11px] leading-relaxed text-slate-600">{lane.emptyText}</div>
          ) : (
            lane.coins.map((c, i) => (
              <CoinCard key={`${lane.key}:${c.id}`} coin={c} laneKey={lane.key} accent={lane.accent} index={i} saved={has(c.id)} launching={launching === c.id} onTrade={onTrade} onSave={onSave} notify={notify} />
            ))
          )}
        </div>
        {lane.key === 'oversold' && lane.coins.length > 0 && (
          <div className="shrink-0 border-t border-white/[0.05] px-3 py-1.5 text-[9px] leading-tight text-slate-600">Technical-oversold (RSI/EMA), not a valuation — coins fall for reasons too.</div>
        )}
      </div>
    </section>
  )
})

// ── Coin card ────────────────────────────────────────────────────────────────
function secondary(coin: MarketCoin, laneKey: string): { label: string; value: string; tone?: string } {
  if (laneKey === 'inplay') return { label: 'turnover', value: coin.volToMcap !== null ? `${(coin.volToMcap * 100).toFixed(0)}%` : '—', tone: 'text-cyan-300' }
  if (laneKey === 'oversold') return { label: 'RSI', value: coin.rsi !== null ? String(coin.rsi) : '—', tone: 'text-indigo-300' }
  if (laneKey === 'gainers' || laneKey === 'losers') return { label: 'vol 24h', value: big(coin.volume24hUsd) }
  return { label: 'mkt cap', value: big(coin.marketCapUsd) }
}

const CoinCard = memo(function CoinCard({
  coin, laneKey, accent, index, saved, launching, onTrade, onSave, notify,
}: {
  coin: MarketCoin
  laneKey: string
  accent: Accent
  index: number
  saved: boolean
  launching: boolean
  onTrade: (c: MarketCoin) => void
  onSave: (c: MarketCoin) => boolean
  notify: (m: string, t?: 'error' | 'success' | 'info') => void
}) {
  const [open, setOpen] = useState(false)
  const a = ACCENT[accent]
  const sec = secondary(coin, laneKey)
  const ch = coin.change24h
  const sig = coin.signal
  const athBadge = laneKey === 'oversold' && coin.athChangePct !== null ? `${coin.athChangePct.toFixed(0)}% vs ATH` : null
  const save = (e: React.MouseEvent) => {
    e.stopPropagation()
    const nowSaved = onSave(coin) // authoritative new state from the watchlist hook
    notify(nowSaved ? `Saved ${coin.symbol} to watchlist` : `Removed ${coin.symbol}`, nowSaved ? 'success' : 'info')
  }
  const toggle = (e: React.MouseEvent) => { e.stopPropagation(); setOpen((o) => !o) }
  return (
    <div className="card-lift glass-hover animate-in glass relative overflow-hidden" style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}>
      <span className={`row-accent absolute inset-x-0 top-0 h-px ${a.line} opacity-50`} />
      {/* collapsed row — click anywhere (or the chevron) to expand */}
      <div onClick={toggle} className="flex cursor-pointer items-center gap-2 px-2.5 py-2.5 transition-colors hover:bg-[var(--surface-hover)] dark:hover:bg-white/[0.02]">
        {coin.image ? (
          <img src={iconUrl(coin.image)} alt="" loading="lazy" className="h-5 w-5 shrink-0 rounded-full bg-white/5" />
        ) : (
          <span className="token-fallback grid h-5 w-5 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500/40 to-cyan-500/40 text-[9px] font-bold text-[var(--ink)]" aria-hidden="true">{coin.symbol.slice(0, 1)}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-slate-100">{coin.symbol}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-slate-300">{price(coin.priceUsd)}</span>
        {ch !== null ? (
          <span className={`w-14 shrink-0 text-right text-[11px] font-bold tabular-nums ${pnlColor(ch)}`}>{ch >= 0 ? '▲' : '▼'}{Math.abs(ch).toFixed(1)}%</span>
        ) : (
          <span className="w-14 shrink-0 text-right text-[10px] text-slate-600">—</span>
        )}
        <button onClick={save} aria-label={saved ? `Remove ${coin.symbol} from watchlist` : `Save ${coin.symbol} to watchlist`} aria-pressed={saved} className={`shrink-0 px-0.5 text-sm leading-none transition-transform ${saved ? 'star-pop text-amber-400' : 'text-slate-600 hover:text-amber-300'}`}>
          {saved ? '★' : '☆'}
        </button>
        <button onClick={toggle} aria-label={`${open ? 'Collapse' : 'Expand'} ${coin.symbol} details`} aria-expanded={open} className="shrink-0 px-0.5 text-slate-500 hover:text-slate-200">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </div>

      {/* expanded detail */}
      {open && (
        <div className="animate-in space-y-1.5 px-2.5 pb-2.5">
          <div className="truncate text-[10px] text-slate-500">
            {coin.marketCapRank && <span className="text-slate-600">#{coin.marketCapRank} · </span>}{coin.name}
          </div>
          <div className="h-[30px]">
            {coin.sparkline7d.length > 2 ? (
              <Sparkline points={coin.sparkline7d} width={264} height={30} />
            ) : (
              <div className="flex h-full items-center text-[10px] text-slate-600">{coin.priceUsd === null ? 'price unavailable' : '7d chart pending'}</div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className={`chip cursor-help font-bold uppercase ${SIGNAL_CHIP[sig.action]}`} title={`Score ${sig.score > 0 ? '+' : ''}${sig.score}\n• ${sig.reasons.join('\n• ')}`}>
              {sig.action}
            </span>
            <span className="truncate text-right text-[10px] text-slate-500">
              {athBadge && <span className="mr-1.5 text-slate-600">{athBadge}</span>}
              {sec.label} <span className={`font-semibold tabular-nums ${sec.tone ?? 'text-slate-300'}`}>{sec.value}</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {/* No live price ⇒ unverified liquidity (e.g. a saved coin that fell out of
                the top-250). Don't offer a one-click trade on a coin we can't confirm. */}
            <button onClick={() => onTrade(coin)} disabled={launching || coin.priceUsd === null} title={coin.priceUsd === null ? 'No live price — liquidity unverified' : undefined} className="btn-primary flex-1 !py-1.5 text-[11px]">
              {launching ? 'Launching…' : coin.priceUsd === null ? 'No live price' : '🌤️ Trade'}
            </button>
            <a href={`https://www.coingecko.com/en/coins/${coin.id}`} target="_blank" rel="noreferrer" title="Open on CoinGecko" className="btn-ghost !px-2 !py-1.5 text-[11px]">↗</a>
          </div>
        </div>
      )}
    </div>
  )
})

// ── New (DEX) lane — pool variant ────────────────────────────────────────────
function NewPoolsLane({
  pools, loading, error, launching, onSnipe, active, network, onNetwork, networks,
}: {
  pools: SafePool[] | null
  loading: boolean
  error: string | null
  launching: string
  onSnipe: (p: SafePool) => void
  active: boolean
  network: string
  onNetwork: (id: string) => void
  networks: { id: string; name: string }[]
}) {
  const a = ACCENT.violet
  return (
    <section className="flex w-[86vw] shrink-0 snap-start flex-col sm:w-[300px]" aria-label="New (DEX) — freshly launched, safety-screened">
      <div className="glass relative flex flex-col overflow-hidden" style={{ height: 'min(74vh, 660px)' }}>
        <div className={`lane-bar absolute inset-x-0 top-0 h-0.5 ${a.line}`} />
        <div className={`lane-glow pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full blur-2xl ${a.glow}`} />
        <div className="relative flex shrink-0 items-center gap-2 border-b border-white/[0.08] px-3 py-2.5">
          <span className="text-base" aria-hidden="true">✨</span>
          <div className="min-w-0">
            <h3 className={`text-sm font-bold ${a.text}`}>New (DEX)</h3>
            <div className="truncate text-[10px] text-slate-500">freshly launched · safety-screened</div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <NetworkSelect className="input !w-24 !py-1 text-[11px]" value={network} onChange={onNetwork} networks={networks} label="New-launch chain" />
            {pools && <span className="rounded-full bg-[var(--surface-sunken)] px-2 py-0.5 text-[10px] font-semibold tabular-nums text-slate-400 dark:bg-white/[0.06]">{pools.length}</span>}
          </div>
        </div>
        <div className="lane-body no-scrollbar min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2.5 py-2.5" style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}>
          {!active || (loading && !pools) ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => <div key={i} className="shimmer h-24 rounded-xl" />)}
            </div>
          ) : pools && pools.length > 0 ? (
            pools.map((p, i) => <PoolCard key={p.poolAddress} pool={p} index={i} launching={launching === p.poolAddress} onSnipe={onSnipe} />)
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-[11px] leading-relaxed text-slate-600">
              <span>{error || 'No screened launches right now.'}</span>
              <span className="text-slate-700">New pools must clear the full safety gate — check back shortly.</span>
            </div>
          )}
        </div>
        <div className="shrink-0 border-t border-white/[0.05] px-3 py-1.5 text-[9px] leading-tight text-slate-600">On-chain launches — high risk. Snipe routes through the screened-snipe engine.</div>
      </div>
    </section>
  )
}

const PoolCard = memo(function PoolCard({ pool, index, launching, onSnipe }: { pool: SafePool; index: number; launching: boolean; onSnipe: (p: SafePool) => void }) {
  const [open, setOpen] = useState(false)
  const ch = pool.priceChange1hPct
  const score = pool.report?.score
  const toggle = (e: React.MouseEvent) => { e.stopPropagation(); setOpen((o) => !o) }
  return (
    <div className="card-lift glass-hover animate-in glass relative overflow-hidden" style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}>
      <span className="row-accent absolute inset-x-0 top-0 h-px bg-violet-400 opacity-50" />
      {/* collapsed row — click anywhere (or the chevron) to expand */}
      <div onClick={toggle} className="flex cursor-pointer items-center gap-2 px-2.5 py-2.5 transition-colors hover:bg-[var(--surface-hover)] dark:hover:bg-white/[0.02]">
        <span className="token-fallback grid h-5 w-5 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500/40 to-fuchsia-500/40 text-[9px] font-bold text-[var(--ink)]" aria-hidden="true">{pool.tokenSymbol.slice(0, 1)}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-slate-100">{pool.tokenSymbol}</span>
        <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-violet-300">{ageLabel(pool.ageMinutes)}</span>
        {ch !== null && <span className={`w-12 shrink-0 text-right text-[11px] font-bold tabular-nums ${pnlColor(ch)}`}>{ch >= 0 ? '▲' : '▼'}{Math.abs(ch).toFixed(0)}%</span>}
        <button onClick={toggle} aria-label={`${open ? 'Collapse' : 'Expand'} ${pool.tokenSymbol} details`} aria-expanded={open} className="shrink-0 px-0.5 text-slate-500 hover:text-slate-200">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </div>

      {/* expanded detail */}
      {open && (
        <div className="animate-in space-y-1.5 px-2.5 pb-2.5">
          <div className="flex items-baseline justify-between">
            <span className="truncate text-[10px] text-slate-500">{pool.dex ?? 'dex'} · {pool.network}</span>
            <span className="text-sm font-semibold tabular-nums text-slate-100">{price(pool.priceUsd)}</span>
          </div>
          <div className="grid grid-cols-3 gap-1 text-center">
            {[{ l: 'liq', v: big(pool.liquidityUsd) }, { l: 'fdv', v: big(pool.fdvUsd) }, { l: 'safe', v: score != null ? `${score}/100` : '—' }].map((s) => (
              <div key={s.l} className="rounded-lg tile-sunken py-1">
                <div className="text-[8px] uppercase tracking-wide text-slate-600">{s.l}</div>
                <div className={`text-[11px] font-semibold tabular-nums ${s.l === 'safe' && score != null && score >= 70 ? 'text-emerald-300' : 'text-slate-200'}`}>{s.v}</div>
              </div>
            ))}
          </div>
          <button onClick={() => onSnipe(pool)} disabled={launching} className="btn-primary w-full !py-1.5 text-[11px]">
            {launching ? 'Sniping…' : '🎯 Snipe'}
          </button>
        </div>
      )}
    </div>
  )
})
