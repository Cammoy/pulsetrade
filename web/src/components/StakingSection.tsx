import { useEffect, useMemo, useState } from 'react'
import { useAccount } from '../wallet'
import { fmtUsd, fmtQty } from '../format'
import DonutCard from './DonutCard'

interface StakingPos {
  source: 'icp' | 'solana' | 'evm-liquid'
  network: string
  networkName: string
  color: string
  symbol: string
  label: string
  detail: string
  status: string
  amount: number
  priceUsd: number | null
  usd: number
  dissolveDays: number | null
  unlockDate: string | null
  apy: number | null
  rewardPerYearAsset?: number | null
  rewardPerYearUsd?: number | null
  rewardUntilUnlockUsd?: number | null
}
interface StakingResp { totalUsd: number; positions: StakingPos[]; byNetwork: { id: string; name: string; color: string; usd: number }[]; errors: string[] }

/** A precise dissolve/deactivation window: days when short, years when long — always exact. */
const fmtDuration = (days: number): string => {
  if (days >= 365) return `${(days / 365).toFixed(days >= 365 * 10 ? 0 : 1)} yr`
  if (days >= 1) return `${days.toFixed(1)} days`
  const hrs = days * 24
  if (hrs >= 1) return `${hrs.toFixed(1)} hr`
  return `${Math.max(1, Math.round(hrs * 60))} min`
}
/** The exact calendar date a position becomes liquid, e.g. "Jun 24, 2026". */
const fmtDate = (iso: string): string => {
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return iso }
}

const LS = 'pulsetrade.staking'
const loadSaved = (): { evm?: string; solana?: string; neurons?: string } => {
  try { return JSON.parse(localStorage.getItem(LS) || '{}') } catch { return {} }
}
const SOURCE_LABEL: Record<StakingPos['source'], string> = { icp: 'ICP neuron', solana: 'Solana stake', 'evm-liquid': 'Liquid (ETH)' }

/** Staking lives inside the Portfolio (a tab), not a modal — read-only, visual:
 *  a donut by network + a total hero + per-position value bars. ICP neurons by ID,
 *  Solana native stake auto-detected, EVM liquid-staking tokens. No keys, no txns. */
export default function StakingSection() {
  const { address } = useAccount()
  const saved = loadSaved()
  const hasSaved = !!(saved.evm || saved.solana || saved.neurons)
  const [evm, setEvm] = useState(saved.evm ?? address ?? '')
  const [solana, setSolana] = useState(saved.solana ?? '')
  const [neurons, setNeurons] = useState(saved.neurons ?? '')
  const [data, setData] = useState<StakingResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Once sources are saved, tuck the form away so the charts lead; expand to edit.
  const [editing, setEditing] = useState(!hasSaved)

  const view = async () => {
    setLoading(true)
    setErr(null)
    try {
      localStorage.setItem(LS, JSON.stringify({ evm, solana, neurons }))
      const qs = new URLSearchParams()
      if (evm.trim()) qs.set('evm', evm.trim())
      if (solana.trim()) qs.set('solana', solana.trim())
      const ids = neurons.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
      if (ids.length) qs.set('neurons', ids.join(','))
      if (![...qs].length) { setData(null); setErr('Add a wallet or neuron ID first.'); return }
      const r = await fetch('/api/staking?' + qs.toString())
      if (!r.ok) throw new Error('Couldn’t load staking')
      setData((await r.json()) as StakingResp)
      setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Couldn’t load staking')
    } finally {
      setLoading(false)
    }
  }

  // Auto-load once if the user already saved sources.
  useEffect(() => {
    if (hasSaved) void view()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const networkSegments = useMemo(() => (data ? data.byNetwork.map((n) => ({ label: n.name, value: n.usd, color: n.color })) : []), [data])
  const positions = useMemo(() => (data ? [...data.positions].sort((a, b) => b.usd - a.usd) : []), [data])
  const maxPos = positions[0]?.usd ?? 0

  return (
    <div className="space-y-4">
      {/* Sources form — collapsible so the charts lead once it's set up */}
      <div className="glass p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white">🔒 Staked assets</h3>
            <p className="mt-0.5 text-[12px] text-slate-500">Read-only across chains — ICP neurons by ID, Solana stake auto-detected, plus liquid-staking tokens on Ethereum.</p>
          </div>
          {hasSaved && !editing && (
            <button className="btn-ghost shrink-0 !px-2.5 !py-1 text-[12px]" onClick={() => setEditing(true)}>Edit sources</button>
          )}
        </div>

        {editing && (
          <div className="mt-4 space-y-2.5">
            <Field label="Ethereum wallet" hint="liquid staking: stETH · wstETH · rETH · cbETH">
              <input className="input !py-2 font-mono text-[12px]" value={evm} onChange={(e) => setEvm(e.target.value)} placeholder="0x…" spellCheck={false} />
            </Field>
            <Field label="Solana wallet" hint="native stake accounts (auto-detected)">
              <input className="input !py-2 font-mono text-[12px]" value={solana} onChange={(e) => setSolana(e.target.value)} placeholder="So1…" spellCheck={false} />
            </Field>
            <Field label="ICP neuron IDs" hint="from the NNS dapp — one per line or comma-separated">
              <textarea className="input !py-2 font-mono text-[12px]" rows={2} value={neurons} onChange={(e) => setNeurons(e.target.value)} placeholder="16808551343083222111, …" spellCheck={false} />
            </Field>
            <button className="btn-primary w-full" onClick={view} disabled={loading}>
              {loading ? 'Reading the chains…' : data ? 'Refresh staking' : 'View my staking'}
            </button>
          </div>
        )}
        {err && <div className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">{err}</div>}
      </div>

      {/* Empty state */}
      {!data && !loading && (
        <div className="glass p-8 text-center">
          <div className="text-5xl">🔒</div>
          <h2 className="mt-3 text-xl font-bold text-white">See your staking, charted</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-slate-400">Add an Ethereum wallet, a Solana wallet, or your ICP neuron IDs above to see everything you have staked — valued live and broken down by network.</p>
        </div>
      )}

      {loading && !data && <div className="glass animate-pulse p-8 text-center text-sm text-slate-500">Reading the chains…</div>}

      {/* Results — total hero + donut + position bars */}
      {data && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="glass flex flex-col justify-between p-5">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Total staked value</div>
                <div className="mt-0.5 text-4xl font-extrabold tabular-nums text-slate-900 dark:bg-gradient-to-r dark:from-indigo-300 dark:to-cyan-300 dark:bg-clip-text dark:text-transparent">{fmtUsd(data.totalUsd)}</div>
                <div className="mt-1 text-[11px] text-slate-500">{positions.length} {positions.length === 1 ? 'position' : 'positions'} · {data.byNetwork.length} {data.byNetwork.length === 1 ? 'network' : 'networks'}</div>
              </div>
              {data.byNetwork.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {data.byNetwork.map((n) => (
                    <span key={n.id} className="chip bg-[var(--surface-sunken)] text-slate-300 dark:bg-white/[0.06]">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: n.color }} />
                      {n.name} <span className="tabular-nums text-slate-500">{fmtUsd(n.usd)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <DonutCard title="By network" segments={networkSegments} total={data.totalUsd} />
          </div>

          {/* Positions with value bars */}
          <div className="glass overflow-hidden">
            <div className="border-b border-white/[0.08] px-5 py-3 text-sm font-bold text-white">Positions</div>
            {positions.length === 0 ? (
              <p className="px-5 py-8 text-center text-[13px] text-slate-500">No staking found for the sources you entered.</p>
            ) : (
              <div className="divide-y divide-white/[0.04]">
                {positions.map((p, i) => (
                  <div key={i} className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white" style={{ backgroundColor: p.color }}>{p.symbol.slice(0, 4)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-200">
                          <span className="truncate">{p.label}</span>
                          <span className="chip shrink-0 bg-[var(--surface-sunken)] text-[10px] text-slate-500 dark:bg-white/[0.06]">{SOURCE_LABEL[p.source]}</span>
                        </div>
                        <div className="truncate text-[11px] text-slate-500">{p.detail}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[13px] font-bold tabular-nums text-slate-100">{p.usd > 0 ? fmtUsd(p.usd) : '—'}</div>
                        <div className="text-[11px] tabular-nums text-slate-500">{fmtQty(p.amount)} {p.symbol}</div>
                      </div>
                    </div>
                    {/* Share-of-total bar */}
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)] dark:bg-white/[0.06]">
                      <div className="h-full rounded-full" style={{ width: `${maxPos > 0 ? Math.max(2, (p.usd / maxPos) * 100) : 0}%`, backgroundColor: p.color }} />
                    </div>
                    {/* Exact unlock timeline + estimated staking rewards */}
                    {(p.apy || (p.dissolveDays != null && p.unlockDate)) && (
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                        {p.dissolveDays != null && p.unlockDate && (
                          <span className="chip bg-amber-500/10 text-amber-700 dark:text-amber-300">⏳ Unlocks in {fmtDuration(p.dissolveDays)} · {fmtDate(p.unlockDate)}</span>
                        )}
                        {p.apy ? (
                          <span className="tabular-nums text-slate-500">
                            ≈ {(p.apy * 100).toFixed(1)}% APY
                            {p.rewardPerYearUsd != null ? (
                              <> · <span className="font-semibold text-emerald-700 dark:text-emerald-400">+{fmtUsd(p.rewardPerYearUsd)}/yr</span></>
                            ) : p.rewardPerYearAsset ? (
                              <> · <span className="font-semibold text-emerald-700 dark:text-emerald-400">+{fmtQty(p.rewardPerYearAsset)} {p.symbol}/yr</span></>
                            ) : null}
                            {p.rewardUntilUnlockUsd != null ? <> · <span className="text-amber-700 dark:text-amber-300">+{fmtUsd(p.rewardUntilUnlockUsd)} by unlock</span></> : null}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {data.errors.length > 0 && (
            <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">Couldn’t read: {data.errors.join(' · ')}</div>
          )}
        </>
      )}

      <p className="text-[10px] leading-relaxed text-slate-500">Read-only — no keys, no transactions. ICP neuron data is the public on-chain info from the governance canister; Solana stake accounts and EVM liquid-staking balances are read live and priced from CoinGecko. Unlock dates are exact from on-chain dissolve/deactivation state; <span className="font-medium">APY & reward figures are estimates</span> (network rates drift) — not a guarantee.</p>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-medium text-slate-400">{label}</span>
        {hint && <span className="text-[10px] text-slate-600">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
