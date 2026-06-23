import { useEffect, useRef, useState, type CSSProperties, type MouseEventHandler, type ReactNode } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { aggregateStats, botsForMode } from '../stats'
import { fmtSign, pnlColor } from '../format'
import { TOOL_ITEMS } from './tools'
import ModeSwitch from './ModeSwitch'
import Sparkline from './Sparkline'
import CountUp from '../useCountUp'
import type { Bot } from '../types'

/**
 * Desktop-only workspace sidebar (hidden below lg; mobile keeps Header + BottomNav).
 *
 * Two faces, toggled by one persisted flag and ⌘\ :
 *   · Expanded — a thin workspace rail (brand + compose/docs/mode) beside a 264px
 *     channel list: workspace switcher, ⌘K bot finder, a workspace-P&L strip, and
 *     collapsible "Channels", "Apps" and "Your bots" sections (presence + ledger P&L,
 *     with a reveal-on-hover equity sparkline on the focused bot).
 *   · Collapsed — a single 72px icon rail: brand, the four views, the apps and a
 *     network-coloured avatar per bot, each with a native tooltip.
 *
 * Aligned to a 4px baseline: 32px rows, a fixed 16px leading column, a flush inset
 * active bar + 12% accent fill, and a right-aligned tabular P&L ledger column.
 * The whole aside animates its width, so collapsing wipes cleanly to the rail.
 */

const VIEWS = [
  { v: 'home', label: 'bots', icon: '🤖' },
  { v: 'portfolio', label: 'portfolio', icon: '💼' },
  { v: 'market', label: 'market', icon: '📈' },
  { v: 'smart', label: 'smart-money', icon: '🐋' },
  { v: 'copy', label: 'copy-trade', icon: '🔁' },
] as const

const COLLAPSE_KEY = 'pulsetrade.sidebar.collapsed'

/** Hover handlers a collapsed-rail item forwards to its button so the parent can
 *  position the floating tooltip from the element's rect. */
type Hover = { onMouseEnter?: MouseEventHandler<HTMLButtonElement>; onMouseLeave?: () => void }

/** localStorage-backed boolean — survives reloads, degrades gracefully in private mode. */
function usePersistedFlag(key: string, initial: boolean): [boolean, (v: boolean | ((p: boolean) => boolean)) => void] {
  const [val, setVal] = useState<boolean>(() => {
    try {
      const s = localStorage.getItem(key)
      return s === null ? initial : s === '1'
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, val ? '1' : '0')
    } catch {
      /* ignore — non-persistent is fine */
    }
  }, [key, val])
  return [val, setVal]
}

/** Filled status colour, shared by the expanded dot and the collapsed avatar badge. */
const presenceCls = (status: Bot['status']) =>
  status === 'running' ? 'bg-emerald-400' : status === 'scheduled' ? 'bg-sky-400' : status === 'paused' ? 'bg-amber-400' : 'bg-slate-500'

/** Bot ordering: live first, then by P&L — the most relevant rows surface at the top. */
const STATUS_ORDER: Record<Bot['status'], number> = { running: 0, scheduled: 1, paused: 2, stopped: 3 }
const byRelevance = (a: Bot, b: Bot) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.totalPnlUsd - a.totalPnlUsd

/** Slack-style presence indicator mapped to bot status (hollow = idle). */
function Presence({ status }: { status: Bot['status'] }) {
  if (status === 'running') return <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 pulse-dot" />
  if (status === 'scheduled') return <span className="h-2 w-2 shrink-0 rounded-full bg-sky-400" />
  if (status === 'paused') return <span className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-amber-400" />
  return <span className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-slate-500" />
}

/** One emerald running-count pill — used wherever the "live" count appears. */
function CountBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-bold tabular-nums text-emerald-300 ring-1 ring-emerald-500/25">
      {children}
    </span>
  )
}

/**
 * A single nav row in the expanded list — 32px tall, three clear states, a flush
 * inset active bar. `noTruncate` lets the bots row overlay a sparkline below its
 * name without the content box clipping it.
 */
function NavRow({
  active,
  onClick,
  title,
  leading,
  trailing,
  children,
  noTruncate,
}: {
  active: boolean
  onClick: () => void
  title?: string
  leading: ReactNode
  trailing?: ReactNode
  children: ReactNode
  noTruncate?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-current={active ? 'page' : undefined}
      className={`group relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13.5px] transition-colors ${
        active ? 'nav-active font-semibold text-slate-100' : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-100'
      }`}
    >
      {active && <span className="absolute inset-y-1 left-0 w-[2px] rounded-r-full bg-indigo-400" />}
      {leading}
      <span className={`min-w-0 flex-1 ${noTruncate ? '' : 'truncate'}`}>{children}</span>
      {trailing}
    </button>
  )
}

/** Collapsible section: persisted caret + uppercase header, optional count pill and hover "+". */
function Section({ id, title, count, onAdd, addTitle, children }: { id: string; title: string; count?: ReactNode; onAdd?: () => void; addTitle?: string; children: ReactNode }) {
  const [open, setOpen] = usePersistedFlag(`pulsetrade.sidebar.section.${id}`, true)
  return (
    <div className="mt-4 first:mt-1">
      <div className="flex items-center gap-1 px-1.5 pb-1">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-slate-500 hover:text-slate-300">
          <svg viewBox="0 0 24 24" className={`h-3 w-3 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M6 9l6 6 6-6" />
          </svg>
          <span className="truncate">{title}</span>
          {count && <span className="ml-1.5 shrink-0">{count}</span>}
        </button>
        {onAdd && (
          <button onClick={onAdd} title={addTitle} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 opacity-0 transition hover:bg-white/10 hover:text-slate-200 focus:opacity-100 group-hover/list:opacity-100">
            +
          </button>
        )}
      </div>
      {open && <div className="space-y-px">{children}</div>}
    </div>
  )
}

/** Compose / docs action button on the collapsed rail. */
function RailButton({ icon, label, onClick, accent, onMouseEnter, onMouseLeave }: { icon: ReactNode; label: string; onClick: () => void; accent?: boolean } & Hover) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`flex h-10 w-10 items-center justify-center rounded-xl text-lg transition-all active:scale-90 ${
        accent ? 'brand-gradient text-[var(--ink)] shadow-lg dark:shadow-fuchsia-500/30 hover:brightness-110' : 'text-slate-400 hover:bg-white/[0.07] hover:text-slate-100'
      }`}
    >
      {icon}
    </button>
  )
}

/** Collapsed-rail icon button — a view/app/action, with an optional active bar + badge. */
function RailIcon({ icon, label, active, accent, badge, onClick, onMouseEnter, onMouseLeave }: { icon: ReactNode; label: string; active?: boolean; accent?: boolean; badge?: ReactNode; onClick: () => void } & Hover) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`relative flex h-10 w-10 items-center justify-center rounded-xl text-[18px] transition-all active:scale-90 ${
        accent
          ? 'brand-gradient text-[var(--ink)] shadow-lg dark:shadow-fuchsia-500/30 hover:brightness-110'
          : active
            ? 'bg-indigo-500/20 text-slate-100'
            : 'text-slate-400 hover:bg-white/[0.07] hover:text-slate-100'
      }`}
    >
      {active && <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-indigo-400" />}
      {icon}
      {badge ? <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-bold text-emerald-950 ring-2 ring-[var(--bg-2)]">{badge}</span> : null}
    </button>
  )
}

/** Collapsed-rail bot avatar — network-coloured tile, status dot, selected ring. */
function BotAvatar({ bot, color, active, onClick, onMouseEnter, onMouseLeave }: { bot: Bot; color: string; active: boolean; onClick: () => void } & Hover) {
  return (
    <button
      onClick={onClick}
      aria-label={bot.name}
      aria-current={active ? 'page' : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`relative flex h-9 w-9 items-center justify-center rounded-lg text-[10px] font-bold uppercase text-[var(--ink)] ring-2 transition-all hover:scale-105 active:scale-90 ${
        active ? 'ring-indigo-400' : 'ring-transparent hover:ring-white/20'
      }`}
    >
      {active && <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-indigo-400" />}
      <span className="token-avatar flex h-full w-full items-center justify-center rounded-lg" style={{ '--tok': color } as CSSProperties}>
        {bot.token?.slice(0, 2) || '🤖'}
      </span>
      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--bg-2)] ${presenceCls(bot.status)} ${bot.status === 'running' ? 'pulse-dot' : ''}`} />
    </button>
  )
}

export default function Sidebar() {
  const { bots, view, setView, selectBot, selectedBotId, wsOk, mode, meta, openWizard } = useStore(
    useShallow((s) => ({
      bots: s.bots, view: s.view, setView: s.setView, selectBot: s.selectBot, selectedBotId: s.selectedBotId,
      wsOk: s.wsOk, mode: s.mode, meta: s.meta, openWizard: s.openWizard,
    })),
  )
  const [q, setQ] = useState('')
  const [wsMenu, setWsMenu] = useState(false)
  const [collapsed, setCollapsed] = usePersistedFlag(COLLAPSE_KEY, false)
  // Floating tooltip for the collapsed rail (richer + instant vs native title).
  const [tip, setTip] = useState<{ top: number; label: string; sub?: string; subClass?: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // ⌘K focuses the bot finder; ⌘\ toggles the rail — both classic workspace shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        setCollapsed(false)
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === '\\') {
        e.preventDefault()
        setCollapsed((c) => !c)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCollapsed])

  // Scope to the ACTIVE workspace — the sidebar never mixes paper and live bots.
  const byMode = botsForMode(bots, mode)
  const running = byMode.filter((b) => b.status === 'running').length
  // Aggregate the workspace exactly like the main Overview (aggregateStats over byMode),
  // so the strip's total P&L always matches the dashboard — never a phantom mismatch.
  const agg = aggregateStats(byMode)
  // ACTIVE bots only — archived (manual) and retired ('stopped') bots live in the
  // Archived section on the bots view, not here. (Deleted bots are already gone.)
  const activeBots = byMode.filter((b) => !(b.archived === true || b.status === 'stopped'))
  const filtered = (q ? activeBots.filter((b) => `${b.name} ${b.token}`.toLowerCase().includes(q.toLowerCase())) : activeBots).slice().sort(byRelevance)
  const railBots = activeBots.slice().sort(byRelevance)

  const netColor = (id: string) => meta?.networks.find((n) => n.id === id)?.color ?? '#64748b'
  const modePill = mode === 'live' ? 'bg-rose-500/15 text-rose-300' : 'bg-indigo-500/15 text-indigo-300'

  // ── Collapsed: a single icon rail ─────────────────────────────────────────
  if (collapsed) {
    // Position the floating tooltip from the hovered item's rect (rich + instant,
    // and it escapes the rail's overflow-y clip that a native title can't).
    const tipFor = (content: { label: string; sub?: string; subClass?: string }): Hover => ({
      onMouseEnter: (e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setTip({ top: r.top + r.height / 2, ...content })
      },
      onMouseLeave: () => setTip(null),
    })
    return (
      <aside className="app-sidebar hidden h-screen w-[72px] shrink-0 flex-col items-center border-r border-black/50 bg-[var(--bg-2)] py-3 transition-[width] duration-200 motion-reduce:transition-none lg:flex">
        <button
          onClick={() => setCollapsed(false)}
          aria-label="Expand sidebar"
          {...tipFor({ label: 'PulseTrade', sub: wsOk ? 'engine live' : 'reconnecting…' })}
          className={`brand-gradient flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-xl shadow-lg ring-[1.5px] ring-offset-2 ring-offset-[var(--bg-2)] transition hover:brightness-110 dark:shadow-fuchsia-500/30 ${
            wsOk ? 'ring-emerald-400/70' : 'ring-rose-400/70'
          }`}
        >
          ⚡
        </button>

        <div className="no-scrollbar mt-2 flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-1">
          {VIEWS.map(({ v, label, icon }) => (
            <RailIcon
              key={v}
              icon={icon}
              label={label}
              active={view === v}
              badge={v === 'home' && running > 0 ? running : undefined}
              onClick={() => setView(v)}
              {...tipFor({ label, sub: v === 'home' && running > 0 ? `${running} running` : undefined })}
            />
          ))}

          <div className="my-1 h-px w-6 bg-white/[0.07]" />

          {TOOL_ITEMS.map((t) => (
            <RailIcon key={t.action} icon={t.icon} label={t.label} onClick={() => (useStore.getState()[t.action] as (o: boolean) => void)(true)} {...tipFor({ label: t.label, sub: t.sub })} />
          ))}

          {railBots.length > 0 && (
            <>
              <div className="my-1 h-px w-6 bg-white/[0.07]" />
              <div className="flex flex-col items-center gap-1.5 pb-1">
                {railBots.map((b) => (
                  <BotAvatar
                    key={b.id}
                    bot={b}
                    color={netColor(b.network)}
                    active={selectedBotId === b.id}
                    onClick={() => selectBot(b.id)}
                    {...tipFor({ label: b.name, sub: fmtSign(b.totalPnlUsd), subClass: pnlColor(b.totalPnlUsd) })}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="mt-2 flex shrink-0 flex-col items-center gap-2 border-t border-white/[0.08] pt-3">
          <RailButton icon="+" label="New bot" accent onClick={() => openWizard(true)} {...tipFor({ label: 'New bot' })} />
          <button
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
            {...tipFor({ label: 'Expand sidebar', sub: '⌘\\' })}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 transition-all hover:bg-white/[0.07] hover:text-slate-100 active:scale-90"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M13 7l5 5-5 5M6 7l5 5-5 5" /></svg>
          </button>
          <div className={`h-2.5 w-2.5 rounded-full ${mode === 'live' ? 'bg-rose-400' : 'bg-indigo-400'}`} title={mode === 'live' ? 'Live trading' : 'Paper trading'} />
        </div>

        {/* Floating tooltip — fixed so it isn't clipped by the rail's scroll area. */}
        {tip && (
          <div style={{ position: 'fixed', left: 78, top: tip.top, transform: 'translateY(-50%)' }} className="pointer-events-none z-[70]">
            <div className="relative flex items-center gap-2 whitespace-nowrap rounded-lg border border-white/10 bg-[var(--menu)] py-1.5 pl-2.5 pr-3 shadow-xl shadow-black/50">
              <span className="absolute -left-[5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45 border-b border-l border-white/10 bg-[var(--menu)]" />
              <span className="text-[12px] font-semibold text-slate-100">{tip.label}</span>
              {tip.sub && <span className={`text-[11px] tabular-nums ${tip.subClass ?? 'text-slate-400'}`}>{tip.sub}</span>}
            </div>
          </div>
        )}
      </aside>
    )
  }

  // ── Expanded: a single channel list ───────────────────────────────────────
  // No separate workspace rail: brand (wordmark + footer), New bot (ChannelHeader +
  // "Your bots"), Documentation (Apps) and the Paper/Live mode (header pill) all live
  // inside the list, so a rail strip only duplicated them.
  return (
    <aside className="hidden h-screen w-[264px] shrink-0 transition-[width] duration-200 motion-reduce:transition-none lg:flex">
      {/* Channel list */}
      <div className="app-sidebar group/list flex w-[264px] flex-col border-r border-white/[0.08] bg-[var(--sidebar)]">
        {/* Workspace header — switcher menu + active mode + collapse */}
        <div className="relative border-b border-white/[0.08]">
          <div className="flex items-center">
            <button
              onClick={() => setWsMenu((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={wsMenu}
              className="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.03]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-gradient truncate text-[15px] font-extrabold tracking-tight">PulseTrade</span>
                  <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${wsMenu ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                  <span className={`rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wide ${modePill}`}>{mode === 'live' ? 'Live' : 'Paper'}</span>
                  <span className="text-slate-600">·</span>
                  <span className={`h-1.5 w-1.5 rounded-full ${wsOk ? 'bg-emerald-400 pulse-dot' : 'bg-rose-400'}`} />
                  <span className="truncate text-slate-500">{wsOk ? 'engine live' : 'reconnecting…'}</span>
                </div>
              </div>
            </button>
            <button
              onClick={() => setCollapsed(true)}
              title="Collapse sidebar (⌘\)"
              aria-label="Collapse sidebar"
              className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white/[0.07] hover:text-slate-200"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 7l-5 5 5 5M18 7l-5 5 5 5" /></svg>
            </button>
          </div>
          {wsMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setWsMenu(false)} />
              {/* Workspace switcher — paper vs live. (Compose / Docs / Tour all live on the
                  rail + Apps section, so they're not repeated here.) */}
              <div role="menu" className="animate-in absolute left-2 right-2 top-full z-50 mt-1 rounded-xl border border-white/10 bg-[var(--menu)] p-2.5 shadow-2xl shadow-black/60">
                <div className="px-0.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Workspace</div>
                <ModeSwitch />
                <p className="mt-2 px-0.5 text-[10px] leading-relaxed text-slate-500">Paper simulates fills; Live trades real funds. Each bot runs in the workspace it was created in.</p>
              </div>
            </>
          )}
        </div>

        {/* Bot finder (⌘K) */}
        <div className="px-3 pb-1 pt-2.5">
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 focus-within:border-indigo-400/60">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (setQ(''), e.currentTarget.blur())}
              placeholder="Find a bot…"
              aria-label="Find a bot"
              className="w-full bg-transparent text-[13px] text-slate-200 outline-none placeholder:text-slate-600"
            />
            {q ? (
              <button onClick={() => setQ('')} className="shrink-0 text-slate-500 hover:text-slate-300" aria-label="Clear search">✕</button>
            ) : (
              <kbd className="shrink-0 rounded border border-white/10 bg-white/[0.04] px-1 py-px text-[10px] font-medium text-slate-500">⌘K</kbd>
            )}
          </div>
        </div>

        {/* Workspace P&L strip — the one number a trader wants on open; matches the Overview total */}
        {byMode.length > 0 && (
          <div className="px-3 pb-2 pt-1.5">
            <div className="tile-sunken flex items-baseline justify-between rounded-lg px-2.5 py-2">
              <CountUp value={agg.totalPnl} format={fmtSign} title="Total workspace P&L" className={`text-[17px] font-bold tabular-nums tracking-tight ${pnlColor(agg.totalPnl)}`} />
              <span className="text-[10.5px] tabular-nums text-slate-400">
                {agg.winRate != null ? `${agg.winRate.toFixed(0)}% win · ` : ''}
                {agg.activeCount}/{agg.total} active
              </span>
            </div>
          </div>
        )}

        {/* Nav */}
        <nav className="no-scrollbar flex-1 overflow-y-auto px-2 pb-3">
          <Section id="channels" title="Channels">
            {VIEWS.map(({ v, label }) => {
              const active = view === v
              return (
                <NavRow
                  key={v}
                  active={active}
                  onClick={() => setView(v)}
                  leading={<span className={`w-4 shrink-0 text-center ${active ? 'text-indigo-300' : 'text-slate-500'}`}>#</span>}
                  trailing={
                    v === 'home' && running > 0 ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        <span className="text-[10px] font-bold tabular-nums text-emerald-300">{running}</span>
                      </span>
                    ) : undefined
                  }
                >
                  {label}
                </NavRow>
              )
            })}
          </Section>

          <Section id="apps" title="Apps">
            {TOOL_ITEMS.map((t) => (
              <NavRow key={t.action} active={false} onClick={() => (useStore.getState()[t.action] as (o: boolean) => void)(true)} title={t.sub} leading={<span className="w-4 shrink-0 text-center text-[13px]">{t.icon}</span>}>
                {t.label}
              </NavRow>
            ))}
          </Section>

          <Section
            id="bots"
            title="Your bots"
            count={running > 0 ? <CountBadge>{running} live</CountBadge> : undefined}
            onAdd={() => openWizard(true)}
            addTitle="New bot"
          >
            {byMode.length === 0 && <p className="px-2 py-1 text-[12px] leading-relaxed text-slate-600">No {mode === 'live' ? 'live ' : ''}bots yet. Hit ＋ to launch one.</p>}
            {byMode.length > 0 && activeBots.length === 0 && !q && <p className="px-2 py-1 text-[12px] leading-relaxed text-slate-600">No active bots — retired ones are in the Archived section.</p>}
            {q && filtered.length === 0 && <p className="px-2 py-1 text-[12px] text-slate-600">No bots match “{q}”.</p>}
            {filtered.map((b) => {
              const active = selectedBotId === b.id
              return (
                <NavRow
                  key={b.id}
                  active={active}
                  noTruncate
                  onClick={() => selectBot(b.id)}
                  title={`${b.name} — ${b.status}`}
                  leading={<span className="flex w-4 shrink-0 justify-center"><Presence status={b.status} /></span>}
                  trailing={
                    <span className="flex w-[56px] shrink-0 justify-end">
                      <span className={`text-[11px] font-semibold tabular-nums ${active ? 'text-slate-100' : pnlColor(b.totalPnlUsd)}`}>{fmtSign(b.totalPnlUsd)}</span>
                    </span>
                  }
                >
                  <span className="block truncate leading-4">{b.name}</span>
                  {/* Reveal-on-hover (or when selected) equity spark — anchored to the row's
                      bottom-left so it sits clear under the name and never grows or bleeds the 32px row. */}
                  <span
                    className={`pointer-events-none absolute bottom-0 left-8 transition-opacity duration-150 ${
                      active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    {b.equityHistory.length >= 2 && (
                      <Sparkline points={b.equityHistory.map((p) => p.v)} width={44} height={8} baseline={b.equityHistory[0]?.v} />
                    )}
                  </span>
                </NavRow>
              )
            })}
            <button onClick={() => openWizard(true)} className="mt-0.5 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200">
              <span className="flex h-4 w-4 items-center justify-center rounded bg-white/[0.06] text-[11px]">+</span>
              Add a bot
            </button>
          </Section>
        </nav>
      </div>
    </aside>
  )
}
