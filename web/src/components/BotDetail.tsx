import { useEffect, useState } from 'react'
import type { Bot } from '../types'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { fmtSign, fmtUsd, fmtPrice, fmtQty, pnlColor, hhmm, DAY_NAMES } from '../format'
import { useModal } from '../useModal'
import PriceChart from './PriceChart'
import { STATUS } from './BotCard'

/** Labelled row of parameter chips — shared by the copy/AI/risk panels. */
function ParamPanel({ title, chips }: { title: string; chips: string[] }) {
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-sm font-semibold text-white">{title}</h3>
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {chips.map((p) => (
          <span key={p} className="chip border border-white/10 bg-white/[0.03] text-slate-400">
            {p}
          </span>
        ))}
      </div>
    </div>
  )
}

/** A small labelled numeric input. Hoisted to module scope so it isn't redefined
 *  every render (an inline component would remount and drop input focus per keystroke). */
function NumberField({ label, value, onChange, suffix, placeholder }: { label: string; value: string; onChange: (v: string) => void; suffix: string; placeholder?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2">
        <input
          type="number"
          min={0}
          step="any"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent py-1.5 text-sm tabular-nums text-slate-100 outline-none"
        />
        <span className="shrink-0 text-[11px] text-slate-500">{suffix}</span>
      </div>
    </label>
  )
}

/**
 * Editable snipe parameters. Adjust TP / SL / max-hold / trailing / budget on an
 * existing sniper — changes apply live to a running bot, and on a RETIRED one
 * "Resume & re-snipe" saves the edits then re-arms it for a fresh entry (a retired
 * sniper is flat + one-shot, so plain resume alone would just re-retire). Empty
 * trailing clears the optional trailing stop. A re-snipe uses the bot's remaining
 * working cash — raise the budget to top it up first.
 */
function SniperEditor({ bot }: { bot: Bot }) {
  const { editBot, control } = useStore(useShallow((s) => ({ editBot: s.editBot, control: s.control })))
  const s = bot.sniper!
  const [tp, setTp] = useState(String(s.takeProfitPct))
  const [sl, setSl] = useState(String(s.stopLossPct))
  const [hold, setHold] = useState(String(s.maxHoldMin))
  const [trail, setTrail] = useState(s.trailingPct != null ? String(s.trailingPct) : '')
  const [budget, setBudget] = useState(String(bot.budgetUsd))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const retired = bot.status === 'stopped'

  // Only send fields the user actually changed (so a no-op save is a no-op).
  const buildPatch = () => {
    const p: { takeProfitPct?: number; stopLossPct?: number; maxHoldMin?: number; trailingPct?: number | null; budgetUsd?: number } = {}
    if (Number(tp) !== s.takeProfitPct) p.takeProfitPct = Number(tp)
    if (Number(sl) !== s.stopLossPct) p.stopLossPct = Number(sl)
    if (Number(hold) !== s.maxHoldMin) p.maxHoldMin = Number(hold)
    const trailVal = trail.trim() === '' ? null : Number(trail)
    if ((trailVal ?? null) !== (s.trailingPct ?? null)) p.trailingPct = trailVal
    if (Number(budget) !== bot.budgetUsd) p.budgetUsd = Number(budget)
    return p
  }
  const dirty = Object.keys(buildPatch()).length > 0

  const run = async (thenResume: boolean) => {
    setBusy(true)
    setErr(null)
    setSaved(false)
    const patch = buildPatch()
    if (Object.keys(patch).length > 0) {
      const out = await editBot(bot.id, patch)
      if (out.error) {
        setErr(out.error)
        setBusy(false)
        return
      }
    }
    if (thenResume) await control(bot.id, 'resume')
    else setSaved(true)
    setBusy(false)
  }

  // Wrap each setter so editing also clears the transient "Saved ✓" flag.
  const edit = (set: (v: string) => void) => (v: string) => { set(v); setSaved(false) }

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">Snipe parameters</h3>
        <span className="text-[11px] text-slate-500">{retired ? 'edit & re-snipe' : 'edit — applies on the next tick'}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <NumberField label="Take-profit" value={tp} onChange={edit(setTp)} suffix="%" />
        <NumberField label="Stop-loss" value={sl} onChange={edit(setSl)} suffix="%" />
        <NumberField label="Max hold" value={hold} onChange={edit(setHold)} suffix="min" />
        <NumberField label="Trailing" value={trail} onChange={edit(setTrail)} suffix="%" placeholder="off" />
        <NumberField label="Budget" value={budget} onChange={edit(setBudget)} suffix="$" />
        <div className="flex flex-col justify-end">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Working cash</span>
          <span className="py-1.5 text-sm font-semibold tabular-nums text-slate-300">{fmtUsd(bot.cashUsd)}</span>
        </div>
      </div>

      {err && <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}
      {retired && bot.cashUsd <= 1 && <p className="mt-2 text-[11px] text-amber-300">Working cash is ~$0 — raise the budget above to re-snipe.</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {retired ? (
          <>
            <button className="btn-primary !py-1.5 text-sm" disabled={busy} onClick={() => run(true)}>
              {busy ? 'Working…' : '▶ Resume & re-snipe'}
            </button>
            <button className="btn-ghost !py-1.5 text-sm" disabled={busy || !dirty} onClick={() => run(false)}>
              Save only
            </button>
          </>
        ) : (
          <button className="btn-primary !py-1.5 text-sm" disabled={busy || !dirty} onClick={() => run(false)}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        )}
        {saved && <span className="text-xs text-emerald-300">✓ Saved</span>}
      </div>

      <p className="mt-2 text-[11px] text-slate-600">
        Enters a full position on entry, then exits on the first of take-profit, stop-loss, trailing stop or max hold.
        {bot.riskReport ? ` · safety ${bot.riskReport.score}/100 at creation` : ''}
      </p>
    </div>
  )
}

/**
 * Exit + budget editor for strategy / AI bots. Take-profit & stop-loss default to the risk
 * tier but can be OVERRIDDEN per bot — the engine swaps them into the decide() path (see
 * `bot.overrides`). Budget tops up / pulls back working cash. (Snipers use SniperEditor;
 * copy bots set their exits in the copy config and get the budget-only BudgetEditor.)
 */
function StrategyEditor({ bot, tierTp, tierSl, tierLabel }: { bot: Bot; tierTp?: number; tierSl?: number; tierLabel?: string }) {
  const editBot = useStore((s) => s.editBot)
  const effTp = bot.overrides?.takeProfitPct ?? tierTp
  const effSl = bot.overrides?.stopLossPct ?? tierSl
  const [tp, setTp] = useState(effTp != null ? String(effTp) : '')
  const [sl, setSl] = useState(effSl != null ? String(effSl) : '')
  const [budget, setBudget] = useState(String(bot.budgetUsd))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const overridden = bot.overrides?.takeProfitPct != null || bot.overrides?.stopLossPct != null

  // Only send fields the user actually changed from the effective current value.
  const buildPatch = () => {
    const p: { takeProfitPct?: number; stopLossPct?: number; budgetUsd?: number } = {}
    if (tp.trim() !== '' && Number(tp) !== effTp) p.takeProfitPct = Number(tp)
    if (sl.trim() !== '' && Number(sl) !== effSl) p.stopLossPct = Number(sl)
    if (budget.trim() !== '' && Number(budget) !== bot.budgetUsd) p.budgetUsd = Number(budget)
    return p
  }
  const dirty = Object.keys(buildPatch()).length > 0

  const save = async () => {
    setBusy(true)
    setErr(null)
    setSaved(false)
    const out = await editBot(bot.id, buildPatch())
    if (out.error) setErr(out.error)
    else setSaved(true)
    setBusy(false)
  }
  const edit = (set: (v: string) => void) => (v: string) => { set(v); setSaved(false) }

  return (
    <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-[12px] font-semibold text-slate-200">Exit &amp; budget</h4>
        {overridden && <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-300">custom</span>}
        <span className="ml-auto text-[11px] text-slate-500">free cash {fmtUsd(bot.cashUsd)}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Take-profit" value={tp} onChange={edit(setTp)} suffix="%" placeholder={tierTp != null ? String(tierTp) : ''} />
        <NumberField label="Stop-loss" value={sl} onChange={edit(setSl)} suffix="%" placeholder={tierSl != null ? String(tierSl) : ''} />
        <NumberField label="Budget" value={budget} onChange={edit(setBudget)} suffix="$" />
      </div>
      {err && <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}
      <div className="mt-2 flex items-center gap-2">
        <button className="btn-primary !py-1.5 text-sm" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
        {saved && <span className="text-xs text-emerald-300">✓ Saved</span>}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        Take-profit / stop-loss override the {tierLabel ?? bot.risk} tier for THIS bot (applies on the next tick); budget tops up or pulls back free cash.
      </p>
    </div>
  )
}

/**
 * Budget-only editor for COPY bots — they mirror the wallet and set their exits in the copy
 * config, so only budget is editable here.
 */
function BudgetEditor({ bot }: { bot: Bot }) {
  const editBot = useStore((s) => s.editBot)
  const [budget, setBudget] = useState(String(bot.budgetUsd))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const dirty = budget.trim() !== '' && Number(budget) !== bot.budgetUsd

  const save = async () => {
    setBusy(true)
    setErr(null)
    setSaved(false)
    const out = await editBot(bot.id, { budgetUsd: Number(budget) })
    if (out.error) setErr(out.error)
    else setSaved(true)
    setBusy(false)
  }

  return (
    <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-[12px] font-semibold text-slate-200">Budget</h4>
        <span className="text-[11px] text-slate-500">free cash {fmtUsd(bot.cashUsd)}</span>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <NumberField label="Budget" value={budget} onChange={(v) => { setBudget(v); setSaved(false) }} suffix="$" />
        </div>
        <button className="btn-primary !py-1.5 text-sm" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        {saved && <span className="pb-2 text-xs text-emerald-300">✓</span>}
      </div>
      {err && <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">Top up to deploy more capital, or reduce to pull back free cash. This bot exits when the tracked wallet sells; its safety-net stop/target are set in the copy configuration.</p>
    </div>
  )
}

export default function BotDetail() {
  const { selectedBotId, selectBot, bots, trades, meta } = useStore(
    useShallow((s) => ({ selectedBotId: s.selectedBotId, selectBot: s.selectBot, bots: s.bots, trades: s.trades, meta: s.meta })),
  )
  const bot = bots.find((b) => b.id === selectedBotId)
  const [candles, setCandles] = useState<{ t: number; c: number }[]>([])

  useModal(() => selectBot(null))

  const net = meta?.networks.find((n) => n.id === bot?.network)
  const token = net?.tokens.find((t) => t.symbol === bot?.token)
  const risk = bot && meta?.risk[bot.risk]
  const strat = meta?.strategies.find((s) => s.id === bot?.strategy)
  // Market bots carry their CoinGecko id directly; curated bots resolve it.
  const chartCg = bot?.cg ?? token?.cg

  useEffect(() => {
    if (!chartCg) return
    let alive = true // ignore a resolve after the modal closes / coin changes (no setState-after-unmount)
    setCandles([])
    fetch(`/api/candles/${chartCg}?days=7`)
      .then((r) => r.json())
      .then((c) => { if (alive) setCandles(c) })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [chartCg])

  if (!bot) return null
  const botTrades = trades.filter((t) => t.botId === bot.id)
  const sched = bot.schedule

  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6" onClick={() => selectBot(null)}>
      <div
        className="glass max-h-[92vh] w-full max-w-3xl overflow-auto !rounded-b-none border-white/10 bg-[var(--modal)] p-5 sm:!rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">{bot.name}</h2>
            <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
              <span className={`chip inline-flex items-center gap-1.5 ${STATUS[bot.status].cls}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${STATUS[bot.status].dot}`} />
                {STATUS[bot.status].label}
              </span>
              <span className="chip bg-white/[0.06] text-slate-300">{net?.name}</span>
              <span className="chip bg-white/[0.06] text-slate-300">
                {bot.sniper ? '🎯 Sniper' : bot.copy ? '🐋 Copy' : bot.ai ? '🤖 AI' : strat?.name ?? bot.strategy}
              </span>
              <span className="chip bg-white/[0.06] capitalize text-slate-300">{bot.risk}</span>
              <span className="chip bg-white/[0.06] text-slate-300">
                {sched.enabled
                  ? `${sched.days.map((d) => DAY_NAMES[d]).join(' ')} · ${sched.startHour}:00–${sched.endHour}:00`
                  : '24/7'}
              </span>
            </div>
          </div>
          <button className="btn-ghost !px-2.5 !py-1" onClick={() => selectBot(null)}>
            ✕
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { l: 'Total P&L', v: fmtSign(bot.totalPnlUsd), c: pnlColor(bot.totalPnlUsd) },
            { l: 'Realized', v: fmtSign(bot.stats.realizedUsd), c: pnlColor(bot.stats.realizedUsd) },
            { l: 'Unrealized', v: fmtSign(bot.unrealizedUsd), c: pnlColor(bot.unrealizedUsd) },
            { l: 'Fees paid', v: fmtUsd(bot.stats.feesUsd), c: 'text-slate-300' },
            { l: 'Working cash', v: fmtUsd(bot.cashUsd), c: 'text-slate-200' },
            {
              l: 'Position',
              v: bot.position.qty > 0 ? `${fmtQty(bot.position.qty)} ${bot.token}` : 'flat',
              c: 'text-slate-200',
            },
            {
              l: 'Avg cost',
              v: bot.position.qty > 0 ? fmtPrice(bot.position.avgCostUsd) : '—',
              c: 'text-slate-200',
            },
            {
              l: `Profit taken (${bot.sweepTo === 'usdt' ? 'USDT' : net?.native.symbol})`,
              v: bot.stats.nativeTakenQty > 0 ? bot.stats.nativeTakenQty.toPrecision(4) : '0',
              c: 'text-cyan-300',
            },
          ].map((s) => (
            <div key={s.l} className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{s.l}</div>
              <div className={`text-sm font-semibold tabular-nums ${s.c}`}>{s.v}</div>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <div className="mb-1 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-white">
              {bot.token} · 7 days {bot.priceUsd ? <span className="ml-2 text-slate-400">{fmtPrice(bot.priceUsd)}</span> : null}
            </h3>
            <span className="text-[11px] text-slate-500">▲ buys · ▼ sells</span>
          </div>
          {chartCg ? (
            <PriceChart candles={candles} trades={botTrades} />
          ) : (
            <div className="flex h-40 items-center justify-center rounded-xl bg-white/[0.02] px-6 text-center text-xs leading-relaxed text-slate-500">
              No price chart for {bot.token} — sniped / new-DEX tokens aren’t tracked by CoinGecko. Every fill is in the activity log below.
            </div>
          )}
        </div>

        {/* Parameters that ACTUALLY governed this bot — snipers/copies don't grid-trade,
            so showing the generic grid/RSI template for them is misleading. */}
        {bot.sniper ? (
          <SniperEditor bot={bot} />
        ) : bot.copy ? (
          <>
            <ParamPanel
              title="Copy parameters"
              chips={[`mirroring ${bot.copy.walletLabel}`, 'exits when the wallet sells', ...(risk ? [`sizing · ${risk.label}`] : [])]}
            />
            <BudgetEditor bot={bot} />
          </>
        ) : bot.ai && risk ? (
          <>
            <ParamPanel
              title="AI Trader parameters"
              chips={['Gemini calls buy / sell / hold', `entry ${risk.positionPct}% of budget`, `stop −${bot.overrides?.stopLossPct ?? risk.stopLossPct}%`, `target +${bot.overrides?.takeProfitPct ?? risk.takeProfitPct}%`]}
            />
            <StrategyEditor bot={bot} tierTp={risk.takeProfitPct} tierSl={risk.stopLossPct} tierLabel={risk.label} />
          </>
        ) : risk ? (
          <>
            <ParamPanel
              title={`Risk parameters · ${risk.label}`}
              chips={[
                `entry ${risk.positionPct}% of budget`,
                `stop −${bot.overrides?.stopLossPct ?? risk.stopLossPct}%`,
                `target +${bot.overrides?.takeProfitPct ?? risk.takeProfitPct}%`,
                `grid ${risk.gridLevels} × ${risk.gridSpacingPct}%`,
                `RSI ${risk.rsiBuy}/${risk.rsiSell}`,
                `cooldown ${risk.cooldownMin}m`,
              ]}
            />
            <StrategyEditor bot={bot} tierTp={risk.takeProfitPct} tierSl={risk.stopLossPct} tierLabel={risk.label} />
          </>
        ) : null}

        <div className="mt-4">
          <h3 className="mb-1.5 text-sm font-semibold text-white">Bot activity</h3>
          <div className="code-block max-h-48 space-y-1 overflow-auto rounded-xl p-3 font-mono text-[11px]">
            {bot.log.length === 0 && <div className="text-slate-600">No activity yet.</div>}
            {[...bot.log].reverse().map((l, i) => (
              <div key={`${l.ts}-${i}`} className="flex gap-2">
                <span className="shrink-0 text-slate-600">{hhmm(l.ts)}</span>
                <span
                  className={
                    l.kind === 'buy'
                      ? 'text-emerald-300'
                      : l.kind === 'sell'
                        ? 'text-rose-300'
                        : l.kind === 'warn'
                          ? 'text-amber-300'
                          : 'text-slate-400'
                  }
                >
                  {l.msg}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
