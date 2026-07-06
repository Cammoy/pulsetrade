import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import type { TradeSignal, SignalStats, RadarEntry } from '../types'
import { fmtPrice, fmtUsd, fmtPct, timeAgo, parseAmount } from '../format'
import { seedLevels } from '../signalMath'
import SignalTicket, { blankInit, type TicketInit } from './SignalTicket'

/** Seed a ticket from a radar candidate: its coin + bias + default levels around its price. */
function radarToInit(r: RadarEntry): TicketInit {
  const s = seedLevels(r.bias, r.price)
  return { symbol: r.symbol, cgId: r.cgId, direction: r.bias, leverage: 5, refPrice: r.price, ...s }
}

/** Map a signal (or tracked trade) into the ticket's editable shape. */
function toTicketInit(s: TradeSignal, editingId?: string): TicketInit {
  return {
    editingId,
    symbol: s.symbol,
    cgId: s.cgId,
    direction: s.direction,
    entryLow: s.entryLow,
    entryHigh: s.entryHigh,
    stopLoss: s.stopLoss,
    tp1: s.tp1,
    tp2: s.tp2,
    tp3: s.tp3,
    leverage: s.leverageMax,
    refPrice: s.refPrice,
    confidence: s.confidence,
    sentimentScore: s.sentimentScore,
    rationale: s.rationale,
  }
}

/**
 * The Signal Channel: an exemplary, visual feed of AI-validated trade calls. Each card is
 * the standardized signal — direction, entry zone, advisory leverage, TP1/2/3, hard stop,
 * confidence, R:R, news sentiment and the one-line AI rationale — drawn as a left-to-right
 * risk ladder (stop → entry → targets) that fills as targets print. Up top, the channel's
 * OWN forward-test accuracy (win rate, avg R, hit rate) so the track record is never hidden,
 * plus a position-size helper that turns the stop distance into a 1–2% risk-sized order.
 *
 * State is live from the store (boot fetch of /api/signals + the WS `signals` frames).
 */

const ACCOUNT_KEY = 'pulsetrade.signals.account'
const RISK_KEY = 'pulsetrade.signals.riskPct'
const readNum = (key: string, def: number) => {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : def
  } catch {
    return def
  }
}

export default function SignalChannel() {
  const { signals } = useStore(useShallow((s) => ({ signals: s.signals })))
  const [account, setAccount] = useState(() => readNum(ACCOUNT_KEY, 1000))
  const [riskPct, setRiskPct] = useState(() => readNum(RISK_KEY, 1))
  const [histOpen, setHistOpen] = useState(false)
  const [ticket, setTicket] = useState<TicketInit | null>(null)

  const setAcct = (v: number) => {
    setAccount(v)
    try {
      localStorage.setItem(ACCOUNT_KEY, String(v))
    } catch {
      /* ignore */
    }
  }
  const setRisk = (v: number) => {
    setRiskPct(v)
    try {
      localStorage.setItem(RISK_KEY, String(v))
    } catch {
      /* ignore */
    }
  }

  const active = signals.active
  const tracked = signals.tracked
  const stats = signals.stats

  return (
    <div className="space-y-4">
      {/* ── Hero ── */}
      <div className="glass relative overflow-hidden p-4">
        <div className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-white">📡 Signal Channel</span>
              <StatusChip enabled={signals.enabled} needsAi={signals.needsAi} aiThrottled={!!signals.aiThrottled} />
            </div>
            <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-slate-400">
              A scanner finds coins in play, Gemini cross-checks the chart and live news, and only setups that clear the
              R:R, confidence and sentiment filters are posted — each with a hard invalidation. Probabilities, not guarantees.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button className="btn-primary !py-1.5 text-xs" onClick={() => setTicket(blankInit())}>📍 Set up a trade</button>
            <div className="text-right text-[11px] text-slate-500">
              {signals.generatedAt ? <>last scan {timeAgo(signals.generatedAt)}</> : 'no scan yet'}
              <span className="ml-1 tabular-nums text-slate-600">· {active.length} live</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── AI quota notice — honest about WHY no new signals are posting ── */}
      {!signals.needsAi && signals.aiThrottled && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
          <span className="shrink-0">⏳</span>
          <span>
            <span className="font-semibold">AI validation is paused</span> — the Gemini provider is rate-limited (quota). New signals
            won't post until it recovers, and the radar shows live candidates without an AI verdict. The radar and your own{' '}
            <span className="font-semibold">tracked setups</span> below keep working normally.
          </span>
        </div>
      )}

      {/* ── Forward-test track record ── */}
      <TrackRecord stats={stats} />

      {/* ── Position-size helper ── */}
      <div className="glass flex flex-wrap items-center gap-x-5 gap-y-2 p-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Position sizing</span>
        <label className="flex items-center gap-1.5 text-[12px] text-slate-400">
          Account
          <span className="flex items-center rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 focus-within:border-indigo-400/60">
            <span className="text-slate-500">$</span>
            <input
              inputMode="decimal"
              value={account}
              onChange={(e) => setAcct(parseAmount(e.target.value) ?? 0)}
              className="w-20 bg-transparent text-right text-[13px] tabular-nums text-slate-200 outline-none"
              aria-label="Account size in USD"
            />
          </span>
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-slate-400">
          Risk / trade
          <select
            value={riskPct}
            onChange={(e) => setRisk(Number(e.target.value))}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[13px] text-slate-200 outline-none focus:border-indigo-400/60"
            aria-label="Risk percent per trade"
          >
            <option value={0.5}>0.5%</option>
            <option value={1}>1%</option>
            <option value={1.5}>1.5%</option>
            <option value={2}>2%</option>
          </select>
        </label>
        <span className="text-[11px] text-slate-500">
          ≈ <span className="font-semibold tabular-nums text-slate-300">{fmtUsd((account * riskPct) / 100)}</span> at risk per trade
        </span>
      </div>

      {/* ── Disclaimer ── */}
      <div className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
        <span className="shrink-0">⚠️</span>
        <span>
          Signals are <span className="font-semibold">probabilities, not guarantees</span>. The stop-loss is the invalidation level — never
          widen it. Size so a single trade risks no more than 1–2% of your account. Leverage shown is an advisory cap. Not financial advice.
        </span>
      </div>

      {/* ── My setups (always available — tracking your own trade never needs AI) ── */}
      {tracked.length > 0 && (
        <div className="space-y-2">
          <SectionLabel title="My setups" sub={`${tracked.length} trade${tracked.length === 1 ? '' : 's'} you're tracking`} />
          <div className="grid gap-3 lg:grid-cols-2">
            {tracked.map((t) => (
              <TrackedCard key={t.id} t={t} account={account} riskPct={riskPct} onEdit={() => setTicket(toTicketInit(t, t.id))} onClose={() => useStore.getState().closeTracked(t.id)} />
            ))}
          </div>
        </div>
      )}

      {/* ── AI signals + radar (these need a Gemini key) ── */}
      {signals.needsAi ? (
        <NeedsKey />
      ) : (
        <>
          {active.length > 0 && (
            <div className="space-y-2">
              <SectionLabel title="Live signals" sub={`${active.length} validated — cleared every filter`} />
              <div className="grid gap-3 lg:grid-cols-2">
                {active.map((s) => (
                  <SignalCard key={s.id} s={s} account={account} riskPct={riskPct} onSetup={() => setTicket(toTicketInit(s))} />
                ))}
              </div>
            </div>
          )}
          <Radar entries={signals.radar} hasActive={active.length > 0 || tracked.length > 0} enabled={signals.enabled} onPick={(r) => setTicket(radarToInit(r))} />
        </>
      )}

      {ticket && <SignalTicket init={ticket} account={account} riskPct={riskPct} onClose={() => setTicket(null)} />}

      {/* ── History ── */}
      {signals.history.length > 0 && (
        <div className="glass p-3">
          <button className="flex w-full items-center gap-2 text-left" onClick={() => setHistOpen((o) => !o)} aria-expanded={histOpen}>
            <span className="text-sm font-bold text-white">📜 Closed signals</span>
            <span className="text-[11px] text-slate-500">{signals.history.length} settled · forward-test record</span>
            <svg viewBox="0 0 24 24" className={`ml-auto h-4 w-4 text-slate-400 transition-transform ${histOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {histOpen && (
            <div className="mt-3 space-y-1.5">
              {signals.history.slice(0, 30).map((s) => (
                <HistoryRow key={s.id} s={s} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Track record ─────────────────────────────────────────────────────────────

function TrackRecord({ stats }: { stats: SignalStats }) {
  const wr = stats.winRatePct
  const wrColor = wr === null ? 'text-slate-300' : wr >= 55 ? 'text-emerald-400' : wr >= 45 ? 'text-amber-300' : 'text-rose-400'
  const rColor = (v: number | null) => (v === null ? 'text-slate-300' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-300')
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      <StatTile label="Win rate" value={wr === null ? '—' : `${wr}%`} cls={wrColor} sub={`${stats.wins}W · ${stats.losses}L`} />
      <StatTile label="Avg R" value={stats.avgR === null ? '—' : `${stats.avgR > 0 ? '+' : ''}${stats.avgR}R`} cls={rColor(stats.avgR)} />
      <StatTile label="Total R" value={`${stats.totalR > 0 ? '+' : ''}${stats.totalR}R`} cls={rColor(stats.totalR)} />
      <StatTile label="TP1 hit" value={stats.tp1HitRatePct === null ? '—' : `${stats.tp1HitRatePct}%`} cls="text-slate-200" />
      <StatTile label="Closed" value={String(stats.closed)} cls="text-slate-200" sub={`${stats.active} active`} />
      <StatTile label="Best · worst" value={stats.bestR === null ? '—' : `${stats.bestR! > 0 ? '+' : ''}${stats.bestR}R`} cls={rColor(stats.bestR)} sub={stats.worstR === null ? undefined : `${stats.worstR}R worst`} />
    </div>
  )
}

function StatTile({ label, value, cls, sub }: { label: string; value: string; cls: string; sub?: string }) {
  return (
    <div className="glass px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-base font-bold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[9px] tabular-nums text-slate-600">{sub}</div>}
    </div>
  )
}

// ── Signal card ───────────────────────────────────────────────────────────────

const STATUS_PILL: Record<TradeSignal['status'], { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-indigo-500/15 text-indigo-300' },
  tp1: { label: 'TP1 hit', cls: 'bg-emerald-500/15 text-emerald-300' },
  tp2: { label: 'TP2 hit', cls: 'bg-emerald-500/20 text-emerald-300' },
  tp3: { label: 'TP3 ✓', cls: 'bg-emerald-500/25 text-emerald-200' },
  stopped: { label: 'Stopped', cls: 'bg-rose-500/15 text-rose-300' },
  expired: { label: 'Expired', cls: 'bg-slate-500/15 text-slate-400' },
}

function SignalCard({ s, account, riskPct, onSetup }: { s: TradeSignal; account: number; riskPct: number; onSetup: () => void }) {
  const long = s.direction === 'LONG'
  const dirCls = long ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' : 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
  const pill = STATUS_PILL[s.status]

  // Position sizing from the stop distance: risk $ ÷ stop% = notional; ÷ leverage = margin.
  const stopPct = Math.abs((s.entryMid - s.stopLoss) / s.entryMid) * 100
  const dollarRisk = (account * riskPct) / 100
  const notional = stopPct > 0 ? dollarRisk / (stopPct / 100) : 0
  const margin = notional / Math.max(1, s.leverageMax)

  return (
    <div className={`glass relative overflow-hidden p-4 ring-1 ring-inset ${long ? 'ring-emerald-500/10' : 'ring-rose-500/10'}`}>
      {/* header row */}
      <div className="flex items-center gap-2">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[15px] font-extrabold ring-1 ${dirCls}`}>{long ? '↗' : '↘'}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-bold text-white">{s.asset}</span>
            <span className={`chip text-[10px] font-bold uppercase ${long ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>{s.direction}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-slate-500">
            <span>Isolated {s.leverageMin}–{s.leverageMax}×</span>
            <span>·</span>
            <span>R:R {s.riskReward}</span>
            <span>·</span>
            <span>{timeAgo(s.createdAt)}</span>
          </div>
        </div>
        <span className={`chip ml-auto shrink-0 text-[10px] font-semibold ${pill.cls}`}>{pill.label}</span>
      </div>

      {/* confidence + sentiment */}
      <div className="mt-3 flex items-center gap-3">
        <ConfidenceMeter value={s.confidence} />
        <SentimentBadge score={s.sentimentScore} />
      </div>

      {/* risk ladder */}
      <div className="mt-3">
        <RiskLadder s={s} />
      </div>

      {/* levels grid */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-3">
        <Level label="Entry zone" value={`${fmtPrice(s.entryLow)}–${fmtPrice(s.entryHigh)}`} tone="entry" />
        <Level label="Stop loss" value={fmtPrice(s.stopLoss)} tone="stop" sub={`−${stopPct.toFixed(1)}%`} />
        <Level label="Take 1" value={fmtPrice(s.tp1)} tone="tp" hit={s.hitTp1At !== undefined} />
        <Level label="Take 2" value={fmtPrice(s.tp2)} tone="tp" hit={s.hitTp2At !== undefined} />
        <Level label="Take 3" value={fmtPrice(s.tp3)} tone="tp" hit={s.hitTp3At !== undefined} sub="runner" />
        <Level label="Volatility" value={`${s.technicals.volatilityPct}%/h`} tone="muted" />
      </div>

      {/* rationale */}
      <p className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[12px] leading-relaxed text-slate-300">
        <span className="text-slate-500">🤖 </span>
        {s.rationale}
      </p>

      {/* position sizing + actions */}
      <div className="mt-3 border-t border-white/[0.06] pt-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-slate-400">
            Size{' '}
            <span className="font-semibold tabular-nums text-slate-200">{fmtUsd(notional)}</span>
            <span className="text-slate-600"> (margin {fmtUsd(margin)} @ {s.leverageMax}×)</span>
            <span className="text-slate-600"> · risks {fmtUsd(dollarRisk)}</span>
          </div>
          <a
            href={`https://www.coingecko.com/en/coins/${s.cgId}`}
            target="_blank"
            rel="noreferrer"
            title="View chart on CoinGecko"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs text-slate-400 transition-colors hover:bg-white/[0.1] hover:text-white"
          >
            📈
          </a>
        </div>
        <button onClick={onSetup} className="btn-primary mt-2 w-full !py-2 text-[13px]">⚙ Set up &amp; track this trade</button>
      </div>

      {s.closedAt !== undefined && (
        <div className={`mt-2 rounded-lg px-2.5 py-1.5 text-center text-[12px] font-semibold tabular-nums ${(s.realizedR ?? 0) >= 0 ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>
          Closed {pill.label} · {(s.realizedR ?? 0) >= 0 ? '+' : ''}{s.realizedR}R
        </div>
      )}
    </div>
  )
}

function Level({ label, value, tone, sub, hit }: { label: string; value: string; tone: 'entry' | 'stop' | 'tp' | 'muted'; sub?: string; hit?: boolean }) {
  const cls = tone === 'stop' ? 'text-rose-300' : tone === 'tp' ? (hit ? 'text-emerald-300' : 'text-slate-200') : tone === 'entry' ? 'text-indigo-200' : 'text-slate-400'
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500">
        {label}
        {hit && <span className="text-emerald-400">✓</span>}
      </div>
      <div className={`font-semibold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[9px] tabular-nums text-slate-600">{sub}</div>}
    </div>
  )
}

function ConfidenceMeter({ value }: { value: number }) {
  const cls = value >= 75 ? 'bg-emerald-400' : value >= 60 ? 'bg-lime-400' : value >= 50 ? 'bg-amber-400' : 'bg-orange-400'
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-0.5 flex items-baseline justify-between text-[10px]">
        <span className="uppercase tracking-wide text-slate-500">Confidence</span>
        <span className="font-bold tabular-nums text-slate-200">{value}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
        <div className={`h-full rounded-full transition-all ${cls}`} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </div>
    </div>
  )
}

function SentimentBadge({ score }: { score: number }) {
  const label = score > 0.15 ? 'Bullish' : score < -0.15 ? 'Bearish' : 'Neutral'
  const cls = score > 0.15 ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300' : score < -0.15 ? 'border-rose-400/30 bg-rose-500/10 text-rose-300' : 'border-slate-400/20 bg-slate-500/10 text-slate-300'
  return (
    <div className="shrink-0 text-center" title="News & social sentiment (−1 to +1)">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">Sentiment</div>
      <span className={`chip mt-0.5 border text-[10px] font-semibold tabular-nums ${cls}`}>
        {label} {score >= 0 ? '+' : ''}{score.toFixed(2)}
      </span>
    </div>
  )
}

/** Left-to-right risk ladder: stop (−1R) → entry (0) → TP1/2/3, placed by favorability so
 *  it reads the same for LONG and SHORT. Printed targets fill green. */
function RiskLadder({ s }: { s: TradeSignal }) {
  const risk = Math.abs(s.entryMid - s.stopLoss) || 1
  const favor = (p: number) => (s.direction === 'LONG' ? (p - s.entryMid) / risk : (s.entryMid - p) / risk)
  const lo = -1 // stop
  const hi = Math.max(favor(s.tp3), 0.01)
  const pos = (p: number) => `${Math.max(0, Math.min(100, ((favor(p) - lo) / (hi - lo)) * 100))}%`
  const entryPos = ((0 - lo) / (hi - lo)) * 100

  const tps = [
    { p: s.tp1, hit: s.hitTp1At !== undefined },
    { p: s.tp2, hit: s.hitTp2At !== undefined },
    { p: s.tp3, hit: s.hitTp3At !== undefined },
  ]
  const maxHitFavor = Math.max(0, ...tps.filter((t) => t.hit).map((t) => favor(t.p)))
  const progressW = ((maxHitFavor - lo) / (hi - lo)) * 100

  return (
    <div className="relative h-9">
      {/* track */}
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/[0.07]">
        {/* loss zone (stop→entry) */}
        <div className="absolute inset-y-0 left-0 bg-rose-500/25" style={{ width: `${entryPos}%` }} />
        {/* realized progress past entry */}
        {progressW > entryPos && <div className="absolute inset-y-0 bg-emerald-500/40" style={{ left: `${entryPos}%`, width: `${progressW - entryPos}%` }} />}
      </div>
      {/* stop marker */}
      <Marker pos="0%" cls="bg-rose-400" title={`Stop ${fmtPrice(s.stopLoss)}`} />
      {/* entry marker */}
      <Marker pos={`${entryPos}%`} cls="bg-indigo-300 h-3.5 w-3.5" title={`Entry ${fmtPrice(s.entryMid)}`} />
      {/* tp markers */}
      {tps.map((t, i) => (
        <Marker key={i} pos={pos(t.p)} cls={t.hit ? 'bg-emerald-400' : 'bg-slate-500'} title={`TP${i + 1} ${fmtPrice(t.p)}`} />
      ))}
    </div>
  )
}

function Marker({ pos, cls, title }: { pos: string; cls: string; title: string }) {
  return (
    <span
      title={title}
      className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--bg-2)] ${cls}`}
      style={{ left: pos }}
    />
  )
}

// ── Tracked trade card (operator's own plan) ─────────────────────────────────

function TrackedCard({ t, account, riskPct, onEdit, onClose }: { t: TradeSignal; account: number; riskPct: number; onEdit: () => void; onClose: () => void }) {
  const long = t.direction === 'LONG'
  const pill = STATUS_PILL[t.status]
  const closed = t.closedAt !== undefined
  const stopPct = Math.abs((t.entryMid - t.stopLoss) / t.entryMid) * 100
  const dollarRisk = (account * riskPct) / 100
  const notional = stopPct > 0 ? dollarRisk / (stopPct / 100) : 0

  return (
    <div className={`glass relative overflow-hidden p-4 ring-1 ring-inset ${long ? 'ring-emerald-500/10' : 'ring-rose-500/10'}`}>
      <div className="flex items-center gap-2">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[15px] font-extrabold ring-1 ${long ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' : 'bg-rose-500/15 text-rose-300 ring-rose-500/30'}`}>{long ? '↗' : '↘'}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-bold text-white">{t.asset}</span>
            <span className="chip bg-indigo-500/15 text-[9px] font-bold uppercase text-indigo-300">yours</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-slate-500">
            <span>Isolated {t.leverageMin === t.leverageMax ? `${t.leverageMax}×` : `${t.leverageMin}–${t.leverageMax}×`}</span>
            <span>·</span>
            <span>R:R {t.riskReward}</span>
          </div>
        </div>
        <span className={`chip ml-auto shrink-0 text-[10px] font-semibold ${pill.cls}`}>{pill.label}</span>
      </div>

      <div className="mt-3">
        <RiskLadder s={t} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-3">
        <Level label="Entry" value={`${fmtPrice(t.entryLow)}–${fmtPrice(t.entryHigh)}`} tone="entry" />
        <Level label="Stop loss" value={fmtPrice(t.stopLoss)} tone="stop" sub={`−${stopPct.toFixed(1)}%`} />
        <Level label="Take 1" value={fmtPrice(t.tp1)} tone="tp" hit={t.hitTp1At !== undefined} />
        <Level label="Take 2" value={fmtPrice(t.tp2)} tone="tp" hit={t.hitTp2At !== undefined} />
        <Level label="Take 3" value={fmtPrice(t.tp3)} tone="tp" hit={t.hitTp3At !== undefined} sub="runner" />
        <Level label="Position" value={fmtUsd(notional)} tone="muted" />
      </div>

      {closed ? (
        <div className={`mt-3 rounded-lg px-2.5 py-1.5 text-center text-[12px] font-semibold tabular-nums ${(t.realizedR ?? 0) >= 0 ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>
          Closed {pill.label} · {(t.realizedR ?? 0) >= 0 ? '+' : ''}{t.realizedR}R
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2 border-t border-white/[0.06] pt-2.5">
        {!closed && (
          <button onClick={onEdit} className="btn-ghost !py-1.5 text-[12px]">✎ Edit levels</button>
        )}
        <button onClick={onClose} className="btn-ghost ml-auto !py-1.5 text-[12px] text-slate-400 hover:text-rose-300">{closed ? 'Dismiss' : 'Stop tracking'}</button>
      </div>
    </div>
  )
}

// ── History row ────────────────────────────────────────────────────────────────

function HistoryRow({ s }: { s: TradeSignal }) {
  const won = (s.realizedR ?? 0) >= 0
  const pill = STATUS_PILL[s.status]
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-1.5 text-[12px]">
      <span className={`chip text-[9px] font-bold uppercase ${s.direction === 'LONG' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>{s.direction}</span>
      <span className="font-semibold text-slate-200">{s.asset}</span>
      <span className={`chip text-[9px] ${pill.cls}`}>{pill.label}</span>
      <span className="ml-auto shrink-0 text-[10px] text-slate-600">{timeAgo(s.closedAt ?? s.createdAt)}</span>
      <span className={`w-12 shrink-0 text-right font-bold tabular-nums ${won ? 'text-emerald-400' : 'text-rose-400'}`}>{won ? '+' : ''}{s.realizedR}R</span>
    </div>
  )
}

// ── Radar (always-on watchlist) ───────────────────────────────────────────────

function SectionLabel({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-end justify-between gap-3 px-0.5">
      <h2 className="text-sm font-bold tracking-tight text-white">{title}</h2>
      {sub && <p className="truncate text-[11px] text-slate-500">{sub}</p>}
    </div>
  )
}

function Radar({ entries, hasActive, enabled, onPick }: { entries: RadarEntry[]; hasActive: boolean; enabled: boolean; onPick: (r: RadarEntry) => void }) {
  // Nothing in play — only fall back to the bare empty state if there are no live signals either.
  if (entries.length === 0) return hasActive ? null : <EmptyState enabled={enabled} />
  const longs = entries.filter((e) => e.bias === 'LONG')
  const shorts = entries.filter((e) => e.bias === 'SHORT')
  return (
    <div className="space-y-2">
      <SectionLabel title="On the radar" sub="tap any coin to set up a trade — long & short" />
      <div className="grid gap-3 lg:grid-cols-2">
        <RadarColumn
          title="📈 Long setups"
          side="long"
          rows={longs}
          onPick={onPick}
          info="Potential LONG (buy) ideas — coins the scanner reads as turning up. Each must clear AI validation, reward:risk ≥ 1.5 and news sentiment before it's posted as a signal; until then it shows “Watching” with the reason it hasn't qualified yet. Tap one to set up & track your own trade on it."
        />
        <RadarColumn
          title="📉 Short setups"
          side="short"
          rows={shorts}
          onPick={onPick}
          info="Potential SHORT (sell) ideas — coins the scanner reads as turning down. The same checks (AI validation, reward:risk ≥ 1.5, sentiment) apply before any is posted as a signal; “Watching” shows why one hasn't qualified yet. Tap one to set up & track your own trade on it."
        />
      </div>
      <p className="px-0.5 text-[10px] leading-relaxed text-slate-600">
        Radar coins are <span className="text-slate-500">candidates being evaluated</span>, not calls — a row only becomes a signal once it clears AI validation, R:R and sentiment. Tap any row to <span className="text-slate-500">set up &amp; track your own trade</span> on it.
      </p>
    </div>
  )
}

function RadarColumn({ title, side, rows, info, onPick }: { title: string; side: 'long' | 'short'; rows: RadarEntry[]; info: string; onPick: (r: RadarEntry) => void }) {
  return (
    <div className="glass p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-sm font-bold text-white">{title}</span>
        <InfoTip label={`What are ${side} setups?`} text={info} />
        <span className="ml-auto text-[11px] tabular-nums text-slate-500">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-slate-600">Nothing leaning {side} right now.</div>
      ) : (
        // Scrollable — the radar can carry many candidates without stretching the page.
        <div className="no-scrollbar max-h-80 space-y-1.5 overflow-y-auto pr-0.5">
          {rows.map((r) => (
            <RadarRow key={r.cgId} r={r} side={side} onPick={() => onPick(r)} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Small accessible info affordance: a bordered “i” that reveals a concise explanation on
 *  hover OR keyboard focus (the button is focusable; group-focus-within shows the tip). */
function InfoTip({ text, label }: { text: string; label: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={label}
        className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-white/20 text-[9px] font-bold leading-none text-slate-400 transition-colors hover:border-white/40 hover:text-slate-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400/70"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-40 mt-1.5 w-60 rounded-lg border border-white/10 bg-[var(--menu)] px-2.5 py-2 text-[11px] leading-relaxed text-slate-300 opacity-0 shadow-xl shadow-black/50 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  )
}

function RadarRow({ r, side, onPick }: { r: RadarEntry; side: 'long' | 'short'; onPick: () => void }) {
  const isSignal = r.status === 'signal'
  return (
    <button
      type="button"
      onClick={onPick}
      title={`Set up a ${r.bias} trade on ${r.symbol}`}
      className={`group block w-full rounded-xl border bg-white/[0.02] p-2.5 text-left transition-colors ${side === 'long' ? 'border-emerald-500/[0.12] hover:border-emerald-500/30' : 'border-rose-500/[0.12] hover:border-rose-500/30'} hover:bg-white/[0.04]`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold text-white">{r.symbol}</span>
        {/* 24h is neutral context here — the column already states the trade bias, so a green
            number in the Short column never reads as a contradiction. */}
        <span className="text-[10px] tabular-nums text-slate-500">{fmtPct(r.change24hPct)} 24h</span>
        {r.rsi !== null && <span className="text-[10px] tabular-nums text-slate-500">RSI {r.rsi}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[9px] font-semibold text-indigo-300 opacity-0 transition-opacity group-hover:opacity-100">Set up →</span>
          <span className={`chip text-[9px] font-semibold ${isSignal ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/[0.06] text-slate-400'}`}>{isSignal ? '✓ Signal' : 'Watching'}</span>
        </span>
      </div>
      <div className="mt-1 text-[10.5px] leading-snug text-slate-500">
        <span className={isSignal ? 'text-emerald-300/80' : ''}>{r.reason}</span>
        {r.triggers.length > 0 && <span className="text-slate-600"> · {r.triggers[0]}</span>}
      </div>
    </button>
  )
}

// ── States ───────────────────────────────────────────────────────────────────

function StatusChip({ enabled, needsAi, aiThrottled }: { enabled: boolean; needsAi: boolean; aiThrottled: boolean }) {
  if (needsAi) return <span className="chip border border-amber-400/30 bg-amber-500/10 text-[10px] font-semibold text-amber-300">⚙ needs Gemini key</span>
  if (!enabled) return <span className="chip border border-slate-400/20 bg-slate-500/10 text-[10px] font-semibold text-slate-400">paused</span>
  if (aiThrottled) return <span className="chip border border-amber-400/30 bg-amber-500/10 text-[10px] font-semibold text-amber-300">⏳ AI rate-limited</span>
  return (
    <span className="chip inline-flex items-center gap-1 border border-emerald-400/30 bg-emerald-500/10 text-[10px] font-semibold text-emerald-300">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-dot" /> live
    </span>
  )
}

function NeedsKey() {
  return (
    <div className="glass p-6 text-center">
      <div className="text-3xl">📡</div>
      <h3 className="mt-2 text-base font-bold text-white">AI signals need Gemini</h3>
      <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-slate-400">
        Posted signals and the radar are AI-validated against the chart and live news, so they need a Gemini key. Add{' '}
        <code className="code-block rounded px-1">GEMINI_API_KEY</code> to <code className="code-block rounded px-1">server/.env</code>{' '}
        (free at aistudio.google.com) and restart — signals start posting within a few minutes. You can still{' '}
        <span className="text-slate-300">set up &amp; track your own trades</span> above without it.
      </p>
    </div>
  )
}

function EmptyState({ enabled }: { enabled: boolean }) {
  return (
    <div className="glass p-8 text-center">
      <div className="text-3xl">🛰️</div>
      <h3 className="mt-2 text-base font-bold text-white">{enabled ? 'Scanning the market…' : 'Channel paused'}</h3>
      <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-slate-400">
        {enabled
          ? 'No setup currently clears every filter. A signal posts only when the scanner, AI validation, R:R (≥1.5) and sentiment checks all agree — quality over noise.'
          : 'The channel is turned off. Set SIGNALS_DISABLED=false (or remove it) and restart to resume scanning.'}
      </p>
    </div>
  )
}
