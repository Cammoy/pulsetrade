import { useEffect, useMemo, useState } from 'react'
import { useStore, jpost } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { useModal } from '../useModal'
import { botsForMode } from '../stats'
import { fmtUsd, fmtCompactUsd, fmtSign, pnlColor, shortAddr, timeAgo } from '../format'
import Sparkline from './Sparkline'
import WalletAccount from './WalletAccount'
import type { Bot, Follow, LeaderboardRow } from '../types'

/**
 * Copy Trading — the hub for borrowing other wallets' edge. Three stacked surfaces:
 *  1. Active copies — your auto-follow pools + standalone copy bots, source whale → mirror.
 *  2. Leaderboard — every tracked wallet ranked by copy-worthiness (flow-based score).
 *  3. Activity — a live timeline of what your copies just mirrored.
 * The "+ New copy" / per-row "Copy" buttons open a guided setup with a live preview.
 */

const TIER: Record<LeaderboardRow['tier'], { label: string; chip: string; bar: string }> = {
  proven: { label: 'Proven', chip: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/25', bar: 'from-emerald-400 to-cyan-400' },
  promising: { label: 'Promising', chip: 'bg-sky-500/15 text-sky-300 ring-sky-500/25', bar: 'from-sky-400 to-indigo-400' },
  unproven: { label: 'Unproven', chip: 'bg-slate-500/15 text-slate-300 ring-slate-500/25', bar: 'from-slate-500 to-slate-400' },
  thin: { label: 'Thin history', chip: 'bg-slate-500/10 text-slate-500 ring-slate-500/20', bar: 'from-slate-600 to-slate-500' },
}

type SetupTarget = { address: string; label: string } | null

function Card({ title, sub, right, children }: { title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="glass p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-white">{title}</h2>
          {sub && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

const Avatar = ({ seed }: { seed: string }) => (
  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/40 to-cyan-500/30 text-sm font-bold text-white">
    {seed.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '🐋'}
  </span>
)

export default function CopyTrading() {
  const { meta, follows, bots, mode, notify, refresh, control, remove } = useStore(
    useShallow((s) => ({ meta: s.meta, follows: s.follows, bots: s.bots, mode: s.mode, notify: s.notify, refresh: s.refresh, control: s.control, remove: s.remove })),
  )
  const [rows, setRows] = useState<LeaderboardRow[]>([])
  const [needsKey, setNeedsKey] = useState(false)
  const [caveat, setCaveat] = useState('')
  const [loading, setLoading] = useState(true)
  const [setup, setSetup] = useState<{ open: boolean; wallet: SetupTarget }>({ open: false, wallet: null })
  const [detail, setDetail] = useState<string | null>(null)

  const loadBoard = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/smart-money/leaderboard')
      const d = await r.json()
      setRows(d.rows ?? [])
      setNeedsKey(!!d.needsKey)
      setCaveat(d.caveat ?? '')
    } catch {
      /* offline — leave whatever we have */
    }
    setLoading(false)
  }
  useEffect(() => {
    loadBoard()
  }, [])

  const copyBots = useMemo(() => botsForMode(bots, mode).filter((b) => b.copy), [bots, mode])
  const standalone = copyBots.filter((b) => !b.followId && b.status !== 'stopped')

  if (!meta) return null

  // Clicking a wallet opens the full analysis view (net-flow chart, holdings/allocation,
  // per-token flows, recent trades) so you can vet a wallet yourself before copying.
  if (detail) return <WalletAccount address={detail} onClose={() => setDetail(null)} />

  return (
    <div className="animate-in space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-white">🔁 Copy Trading</h1>
          <p className="mt-0.5 text-sm text-slate-400">Find the wallets worth copying, then mirror their trades automatically — your budget, your sizing, your exits.</p>
        </div>
        <button className="btn-primary" onClick={() => setSetup({ open: true, wallet: null })}>+ New copy</button>
      </div>

      {needsKey && (
        <div className="rounded-xl bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
          Wallet tracking needs an Etherscan API key. Add <code className="rounded code-block px-1">ETHERSCAN_API_KEY</code> to <code className="rounded code-block px-1">server/.env</code> (free at etherscan.io) and restart to rank wallets and run copies live.
        </div>
      )}

      <ActiveCopies follows={follows} standalone={standalone} all={copyBots} mode={mode} notify={notify} refresh={refresh} control={control} remove={remove} onSelect={setDetail} />

      <Leaderboard rows={rows} loading={loading} caveat={caveat} onCopy={(w) => setSetup({ open: true, wallet: w })} onSelect={setDetail} />

      <Timeline bots={copyBots} />

      {setup.open && (
        <CopySetup
          wallet={setup.wallet}
          onClose={() => setSetup({ open: false, wallet: null })}
          onLaunched={() => {
            setSetup({ open: false, wallet: null })
            refresh()
          }}
        />
      )}
    </div>
  )
}

// ── Active copies ────────────────────────────────────────────────────────────
function ActiveCopies({
  follows, standalone, all, mode, notify, refresh, control, remove, onSelect,
}: {
  follows: Follow[]; standalone: Bot[]; all: Bot[]; mode: string
  notify: (m: string, t?: 'error' | 'success' | 'info') => void; refresh: () => void
  control: (id: string, a: 'pause' | 'resume' | 'stop') => Promise<void>; remove: (id: string) => Promise<void>
  onSelect: (address: string) => void
}) {
  if (follows.length === 0 && standalone.length === 0)
    return (
      <Card title="Your copies" sub="Active auto-follows and copy bots show here">
        <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
          No active copies yet — pick a copy-worthy wallet from the leaderboard below and hit <span className="font-semibold text-slate-300">Copy</span>.
        </div>
      </Card>
    )

  return (
    <Card title="Your copies" sub={`${follows.length} auto-follow${follows.length === 1 ? '' : 's'} · ${standalone.length} copy bot${standalone.length === 1 ? '' : 's'}`}>
      <div className="grid gap-3 lg:grid-cols-2">
        {follows.map((f) => (
          <FollowCard key={f.id} f={f} mirrors={all.filter((b) => b.followId === f.id)} notify={notify} refresh={refresh} onSelect={onSelect} />
        ))}
        {standalone.map((b) => (
          <CopyBotCard key={b.id} b={b} control={control} remove={remove} onSelect={onSelect} />
        ))}
      </div>
      {follows.length > 0 && mode === 'paper' && (
        <p className="mt-2 text-[11px] text-slate-600">Auto-follow scans run about every 90s; mirrors return their cash to the pool when they exit.</p>
      )}
    </Card>
  )
}

function FollowCard({ f, mirrors, notify, refresh, onSelect }: { f: Follow; mirrors: Bot[]; notify: (m: string, t?: 'error' | 'success' | 'info') => void; refresh: () => void; onSelect: (address: string) => void }) {
  const [busy, setBusy] = useState(false)
  const deployed = f.totalBudgetUsd - f.poolUsd
  const act = async (fn: () => Promise<{ error?: string }>, ok: string) => {
    setBusy(true)
    const out = await fn()
    if (out.error) notify(out.error, 'error')
    else notify(ok, 'success')
    setBusy(false)
    refresh()
  }
  return (
    <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.04] p-3">
      <div className="flex items-center gap-2.5">
        <button onClick={() => onSelect(f.walletAddress)} title="Analyse this wallet" className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
          <Avatar seed={f.label} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-white hover:underline">{f.label}</span>
              <span className="chip bg-emerald-500/10 text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-dot" />Auto-following</span>
            </div>
            <div className="font-mono text-[11px] text-slate-500">{shortAddr(f.walletAddress)}</div>
          </div>
        </button>
        <span className={`text-sm font-bold tabular-nums ${pnlColor(f.stats.realizedUsd)}`}>{fmtSign(f.stats.realizedUsd)}</span>
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-1.5 text-center">
        <Stat label="Pool" value={fmtUsd(f.poolUsd)} />
        <Stat label="Deployed" value={fmtUsd(deployed)} />
        <Stat label="Mirrors" value={`${mirrors.filter((b) => b.status !== 'stopped').length}/${f.maxConcurrent}`} />
        <Stat label="W/L" value={`${f.stats.wins}/${f.stats.losses}`} />
      </div>
      <div className="mt-2 text-[11px] text-slate-500">{fmtUsd(f.perTradeUsd)} per mirror · {f.risk}{f.stopLossPct ? ` · SL ${f.stopLossPct}%` : ''}{f.takeProfitPct ? ` · TP ${f.takeProfitPct}%` : ''}</div>
      <div className="mt-2.5 flex gap-2">
        <button disabled={busy} className="btn-ghost flex-1 !py-1.5 text-xs" onClick={() => act(() => jpost(`/api/follows/${f.id}/stop`, undefined), 'Stopped following')}>Stop</button>
        <button disabled={busy} className="btn-ghost flex-1 !py-1.5 text-xs text-amber-300" onClick={() => act(() => jpost(`/api/follows/${f.id}/stop`, { liquidate: true }), 'Stopped & liquidated')}>Stop & liquidate</button>
        <button disabled={busy} className="btn-ghost !py-1.5 text-xs text-rose-300" onClick={() => act(() => jpost(`/api/follows/${f.id}`, undefined, 'DELETE'), 'Deleted')}>Delete</button>
      </div>
    </div>
  )
}

function CopyBotCard({ b, control, remove, onSelect }: { b: Bot; control: (id: string, a: 'pause' | 'resume' | 'stop') => Promise<void>; remove: (id: string) => Promise<void>; onSelect: (address: string) => void }) {
  const holding = b.position.qty > 0
  const addr = b.copy?.walletAddress
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex items-center gap-2.5">
        <button onClick={() => addr && onSelect(addr)} disabled={!addr} title="Analyse this wallet" className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default">
          <Avatar seed={b.copy?.walletLabel ?? b.token} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-white hover:underline">{b.copy?.walletLabel} · {b.token}</div>
            <div className="text-[11px] capitalize text-slate-500">{b.network} · {b.status}{holding ? ' · in position' : ' · waiting for a buy'}</div>
          </div>
        </button>
        <span className={`text-sm font-bold tabular-nums ${pnlColor(b.totalPnlUsd)}`}>{fmtSign(b.totalPnlUsd)}</span>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-1.5 text-center">
        <Stat label="Budget" value={fmtUsd(b.budgetUsd)} />
        <Stat label="Per trade" value={b.copy?.perTradeUsd ? fmtUsd(b.copy.perTradeUsd) : 'tier %'} />
        <Stat label="Position" value={fmtUsd(b.positionValueUsd)} />
      </div>
      <div className="mt-2.5 flex gap-2">
        {b.status === 'paused' ? (
          <button className="btn-ghost flex-1 !py-1.5 text-xs" onClick={() => control(b.id, 'resume')}>Resume</button>
        ) : (
          <button className="btn-ghost flex-1 !py-1.5 text-xs" onClick={() => control(b.id, 'pause')}>Pause</button>
        )}
        <button className="btn-ghost flex-1 !py-1.5 text-xs text-amber-300" onClick={() => control(b.id, 'stop')}>Stop & sweep</button>
        <button className="btn-ghost !py-1.5 text-xs text-rose-300" onClick={() => remove(b.id)}>Delete</button>
      </div>
    </div>
  )
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg bg-white/[0.03] px-2 py-1.5">
    <div className="text-[9px] uppercase tracking-wide text-slate-500">{label}</div>
    <div className="text-xs font-semibold tabular-nums text-slate-200">{value}</div>
  </div>
)

const Spinner = ({ label }: { label: string }) => (
  <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-indigo-400" />
    {label}
  </span>
)

// ── Leaderboard ──────────────────────────────────────────────────────────────
function Leaderboard({ rows, loading, caveat, onCopy, onSelect }: { rows: LeaderboardRow[]; loading: boolean; caveat: string; onCopy: (w: { address: string; label: string }) => void; onSelect: (address: string) => void }) {
  return (
    <Card
      title="🏆 Copy-worthiness leaderboard"
      sub="Tracked wallets ranked by realized P&L (cost-basis) — a research starting point, not a guarantee"
      right={loading ? <Spinner label={rows.length ? 'Refreshing…' : 'Scoring wallets…'} /> : undefined}
    >
      {loading && rows.length === 0 ? (
        <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-white/[0.03]" />)}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">No ranked wallets yet.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const tier = TIER[r.tier]
            const profit = r.realizedPnlUsd ?? r.realizedFlowUsd
            return (
              <div key={r.address} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 transition-colors hover:bg-white/[0.04]">
                <span className="w-5 shrink-0 text-center text-sm font-bold tabular-nums text-slate-500">{i + 1}</span>
                <button onClick={() => onSelect(r.address)} title="Analyse this wallet" className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <Avatar seed={r.label} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-white hover:underline">{r.label}</span>
                      <span className={`chip ring-1 ${tier.chip}`}>{tier.label}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/[0.06]">
                        <div className={`h-full rounded-full bg-gradient-to-r ${tier.bar}`} style={{ width: `${Math.max(3, r.score)}%` }} />
                      </div>
                      <span className="text-[11px] font-semibold tabular-nums text-slate-400">{r.score}/100</span>
                      <span className="hidden text-[11px] text-slate-600 sm:inline">·</span>
                      <span className="hidden text-[11px] text-slate-500 sm:inline">{r.roundTrips} round trips · {r.recencyDays == null ? 'no activity' : r.recencyDays < 1 ? 'today' : `${Math.round(r.recencyDays)}d ago`}</span>
                    </div>
                  </div>
                </button>
                <div className="hidden shrink-0 text-right sm:block">
                  <div className={`text-xs font-semibold tabular-nums ${pnlColor(profit)}`}>{fmtCompactUsd(profit, { signed: true })}</div>
                  <div className="text-[10px] text-slate-500">{r.basis === 'realized-pnl' ? 'realized P&L' : 'net flow'}</div>
                </div>
                {r.series.length >= 2 && (
                  <div className="hidden shrink-0 md:block">
                    <Sparkline points={r.series} width={64} height={28} baseline={r.series[0]} />
                  </div>
                )}
                <button className="btn-primary shrink-0 !px-3 !py-1.5 text-xs" onClick={() => onCopy({ address: r.address, label: r.label })}>Copy</button>
              </div>
            )
          })}
        </div>
      )}
      {caveat && <p className="mt-3 text-[10.5px] leading-relaxed text-slate-600">⚠️ {caveat}</p>}
    </Card>
  )
}

// ── Activity timeline ────────────────────────────────────────────────────────
function Timeline({ bots }: { bots: Bot[] }) {
  const events = useMemo(() => {
    const out: { ts: number; whale: string; token: string; msg: string; kind: 'buy' | 'sell' }[] = []
    for (const b of bots)
      for (const l of b.log)
        if (l.kind === 'buy' || l.kind === 'sell') out.push({ ts: l.ts, whale: b.copy?.walletLabel ?? b.name, token: b.token, msg: l.msg, kind: l.kind })
    return out.sort((a, b) => b.ts - a.ts).slice(0, 20)
  }, [bots])

  return (
    <Card title="⚡ Copy activity" sub="What your copies have mirrored, newest first">
      {events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">No mirrored trades yet — activity appears here once a copied wallet trades.</div>
      ) : (
        <ul className="space-y-1.5">
          {events.map((e, i) => (
            <li key={i} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs hover:bg-white/[0.02]">
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] ${e.kind === 'buy' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>{e.kind === 'buy' ? '↑' : '↓'}</span>
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-slate-200">🐋 {e.whale} · {e.token}</span>
                <span className="ml-1.5 text-slate-500">{e.msg}</span>
              </span>
              <span className="shrink-0 tabular-nums text-slate-600">{timeAgo(e.ts)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ── Guided setup + live preview ──────────────────────────────────────────────
function CopySetup({ wallet, onClose, onLaunched }: { wallet: SetupTarget; onClose: () => void; onLaunched: () => void }) {
  const { meta, mode } = useStore(useShallow((s) => ({ meta: s.meta, mode: s.mode })))
  useModal(onClose)
  const nets = meta?.copyTokens ?? []
  const riskKeys = Object.keys(meta?.risk ?? {})

  const [kind, setKind] = useState<'follow' | 'single'>('follow')
  const [address, setAddress] = useState(wallet?.address ?? '')
  const [label, setLabel] = useState(wallet?.label ?? '')
  const [networkId, setNetworkId] = useState(nets[0]?.network ?? 'base')
  const net = nets.find((n) => n.network === networkId) ?? nets[0]
  const [token, setToken] = useState(net?.tokens[0] ?? '')
  const [budget, setBudget] = useState('300')
  const [perTrade, setPerTrade] = useState('100')
  const [risk, setRisk] = useState(riskKeys.includes('balanced') ? 'balanced' : riskKeys[0] ?? 'balanced')
  const [sweep, setSweep] = useState<'native' | 'usdt'>('native')
  const [advanced, setAdvanced] = useState(false)
  const [sl, setSl] = useState('')
  const [tp, setTp] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const budgetN = Number(budget)
  const perN = Number(perTrade)
  const slN = sl.trim() ? Number(sl) : null
  const tpN = tp.trim() ? Number(tp) : null
  const maxConcurrent = Math.max(1, Math.min(10, Math.floor((budgetN || 0) / (perN || 1)) || 1))
  const evmOk = /^0x[a-fA-F0-9]{40}$/.test(address.trim())
  // Copy = mirror: the exit is the wallet's sell. A stop-loss / take-profit is an opt-in safety net,
  // NOT a tier default — so we never claim a +4.5% cap the bot won't actually apply.
  const safety =
    (slN && slN > 0) || (tpN && tpN > 0)
      ? ` Safety net: also exits on ${[slN && slN > 0 ? `a −${slN}% stop-loss` : '', tpN && tpN > 0 ? `a +${tpN}% take-profit` : ''].filter(Boolean).join(' or ')}.`
      : ' No stop-loss or take-profit — you ride their full move (add one in Advanced for a safety net).'

  // Mirror the server bounds so the preview/button reflect what will actually be accepted.
  const valid =
    evmOk && label.trim().length > 0 && Number.isFinite(budgetN) && budgetN >= 10 &&
    Number.isFinite(perN) && perN >= (kind === 'follow' ? 10 : 1) && perN <= budgetN &&
    (!sl.trim() || (Number(sl) > 0 && Number(sl) <= 90)) &&
    (!tp.trim() || (Number(tp) > 0 && Number(tp) <= 1000)) &&
    (kind === 'follow' || !!token)

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setErr(null)
    const overrides = { ...(sl.trim() && { stopLossPct: Number(sl) }), ...(tp.trim() && { takeProfitPct: Number(tp) }) }
    const out =
      kind === 'follow'
        ? await jpost<{ error?: string }>('/api/follows', { walletAddress: address.trim(), label: label.trim(), totalBudgetUsd: budgetN, perTradeUsd: perN, maxConcurrent, risk, sweepTo: sweep, ...overrides })
        : await jpost<{ error?: string }>('/api/copy-bot', { network: networkId, token, risk, budgetUsd: budgetN, walletAddress: address.trim(), walletLabel: label.trim(), sweepTo: sweep, perTradeUsd: perN, ...overrides })
    setBusy(false)
    if (out.error) {
      setErr(out.error)
      return
    }
    useStore.getState().notify(kind === 'follow' ? `Now auto-following ${label.trim()}` : `Copy bot launched for ${label.trim()}`, 'success')
    onLaunched()
  }

  const caps = meta?.live
  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="animate-in max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-[var(--modal)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-white">🔁 {wallet ? `Copy ${wallet.label}` : 'New copy'}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300" aria-label="Close">✕</button>
        </div>

        {/* Mode toggle */}
        <div className="seg-track mb-3 grid grid-cols-2">
          {(['follow', 'single'] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold ${kind === k ? 'seg-active' : 'text-slate-400 hover:text-slate-200'}`}>
              {k === 'follow' ? '🤖 Auto-follow all buys' : '🎯 Copy one token'}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          {/* Wallet */}
          {wallet ? (
            <div className="flex items-center gap-2.5 rounded-xl bg-white/[0.03] px-3 py-2">
              <Avatar seed={wallet.label} />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white">{wallet.label}</div>
                <div className="font-mono text-[11px] text-slate-500">{shortAddr(wallet.address)}</div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Wallet address">
                <input className="input !py-2 text-xs" placeholder="0x…" value={address} onChange={(e) => setAddress(e.target.value)} />
              </Field>
              <Field label="Label">
                <input className="input !py-2 text-xs" placeholder="e.g. GCR" value={label} onChange={(e) => setLabel(e.target.value)} />
              </Field>
            </div>
          )}

          {/* Network + token (single) / network only (follow scans all curated) */}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Network">
              <select className="input !py-2 text-xs" value={networkId} onChange={(e) => { setNetworkId(e.target.value); const n = nets.find((x) => x.network === e.target.value); setToken(n?.tokens[0] ?? '') }}>
                {nets.map((n) => <option key={n.network} value={n.network}>{n.name}</option>)}
              </select>
            </Field>
            {kind === 'single' ? (
              <Field label="Token">
                <select className="input !py-2 text-xs" value={token} onChange={(e) => setToken(e.target.value)}>
                  {(net?.tokens ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="Risk tier">
                <select className="input !py-2 text-xs capitalize" value={risk} onChange={(e) => setRisk(e.target.value)}>
                  {riskKeys.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </Field>
            )}
          </div>

          {/* Budget + per-trade */}
          <div className="grid grid-cols-2 gap-2">
            <Field label={kind === 'follow' ? 'Total budget (USD)' : 'Budget (USD)'}>
              <input className="input !py-2 text-xs" type="number" min={10} value={budget} onChange={(e) => setBudget(e.target.value)} />
            </Field>
            <Field label={kind === 'follow' ? 'Per mirror (USD)' : 'Per trade (USD)'}>
              <input className="input !py-2 text-xs" type="number" min={1} value={perTrade} onChange={(e) => setPerTrade(e.target.value)} />
            </Field>
          </div>

          {kind === 'single' && (
            <Field label="Risk tier">
              <select className="input !py-2 text-xs capitalize" value={risk} onChange={(e) => setRisk(e.target.value)}>
                {riskKeys.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </Field>
          )}

          {/* Advanced: SL/TP overrides + sweep */}
          <button className="flex items-center gap-1 text-[11px] font-semibold text-slate-400 hover:text-slate-200" onClick={() => setAdvanced((a) => !a)}>
            <span className={`transition-transform ${advanced ? 'rotate-90' : ''}`}>›</span> Advanced controls
          </button>
          {advanced && (
            <div className="grid grid-cols-3 gap-2 rounded-xl bg-white/[0.02] p-2.5">
              <Field label="Stop-loss % (optional)">
                <input className="input !py-2 text-xs" type="number" placeholder="off" value={sl} onChange={(e) => setSl(e.target.value)} />
              </Field>
              <Field label="Take-profit % (optional)">
                <input className="input !py-2 text-xs" type="number" placeholder="off" value={tp} onChange={(e) => setTp(e.target.value)} />
              </Field>
              <Field label="Sweep to">
                <select className="input !py-2 text-xs" value={sweep} onChange={(e) => setSweep(e.target.value as 'native' | 'usdt')}>
                  <option value="native">Native</option>
                  <option value="usdt">USDT</option>
                </select>
              </Field>
            </div>
          )}

          {/* Live preview */}
          <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/[0.06] p-3 text-[12px] leading-relaxed text-slate-300">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-indigo-300">Preview</div>
            {kind === 'follow' ? (
              <>When <b className="text-white">{label.trim() || 'this wallet'}</b> buys any curated token{net ? ` on ${net.name}` : ''}, a mirror deploys <b className="text-white">{fmtUsd(perN || 0)}</b> — up to <b className="text-white">{maxConcurrent}</b> at once from a <b className="text-white">{fmtUsd(budgetN || 0)}</b> pool. Each mirror exits when they sell.{safety}</>
            ) : (
              <>When <b className="text-white">{label.trim() || 'this wallet'}</b> buys <b className="text-white">{token || '—'}</b>{net ? ` on ${net.name}` : ''}, your bot deploys <b className="text-white">{fmtUsd(perN || 0)}</b> ({budgetN > 0 ? Math.round(((perN || 0) / budgetN) * 100) : 0}% of <b className="text-white">{fmtUsd(budgetN || 0)}</b>). It exits when they sell {token || 'it'}.{safety}</>
            )}
            <div className="mt-1.5 text-[11px] text-slate-500">
              {mode === 'live'
                ? `Live workspace — real funds. Caps apply: ${caps?.maxUsdPerDay ? `${fmtUsd(caps.maxUsdPerDay)}/day, ` : ''}circuit breaker & gas reserve.`
                : 'Paper workspace — simulated fills, no real funds.'}
            </div>
          </div>

          {err && <div className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}

          <div className="flex gap-2">
            <button className="btn-primary flex-1" disabled={!valid || busy} onClick={submit}>
              {busy ? 'Launching…' : kind === 'follow' ? `🤖 Auto-follow with ${fmtUsd(budgetN || 0)}` : `🎯 Copy with ${fmtUsd(budgetN || 0)}`}
            </button>
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  )
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
    {children}
  </label>
)
