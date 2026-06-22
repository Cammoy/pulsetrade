import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import type { Withdrawal, WithdrawalsPayload } from '../types'
import { fmtUsd, fmtQty, parseAmount, timeAgo } from '../format'
import { useAddressBook } from '../addressBook'

// Per-chain block explorers for the confirmed-withdrawal tx links (EVM live chains
// + Solana). The link is built as `${base}/tx/${txHash}`, which solscan.io also uses.
const EXPLORER: Record<string, string> = {
  base: 'https://basescan.org',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
  polygon: 'https://polygonscan.com',
  bnb: 'https://bscscan.com', // network id is 'bnb' (not 'bsc') — keep this in sync
  solana: 'https://solscan.io',
}

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a)

const STATUS_CHIP: Record<Withdrawal['status'], string> = {
  simulated: 'bg-slate-500/15 text-slate-300',
  pending: 'bg-amber-500/15 text-amber-300',
  confirmed: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-rose-500/15 text-rose-300',
}

/**
 * Withdraw banked profit (swept native coin / USDT) to an external address. The
 * vault is the profit the bots have taken off the table; this is where it leaves
 * the system. Paper mode simulates; live mode sends a real transfer on the
 * supported EVM chains. Lives in the Portfolio tab.
 */
export default function WithdrawPanel() {
  const { mode, notify, lastTradeId } = useStore()
  const book = useAddressBook()
  const [data, setData] = useState<WithdrawalsPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<string | null>(null) // `${network}:${asset}`
  const [addr, setAddr] = useState('')
  const [amt, setAmt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/withdrawals')
      if (!r.ok) throw new Error(`Request failed (${r.status})`) // don't parse an HTML error page as data
      setData(await r.json())
    } catch {
      /* leave previous data; the engine may be momentarily unreachable */
    }
    setLoading(false)
  }, [])

  // Refetch on mount and whenever a new trade lands (a winning sell banks more
  // profit into the vault).
  useEffect(() => {
    load()
  }, [load, lastTradeId])

  const allVault = data?.vault ?? []
  const history = data?.history ?? []
  const live = mode === 'live'
  // In LIVE mode show ONLY balances that can actually pay out on-chain — paper-only
  // balances (Market profit, or a chain with no signer) are hidden so live mode never
  // offers a "simulated" path. PAPER mode shows everything (all simulated anyway).
  const vault = live ? allVault.filter((v) => v.liveWithdrawable) : allVault
  const bankedUsd = allVault.reduce((s, v) => s + v.usdValue, 0)
  const selected = vault.find((v) => `${v.network}:${v.asset}` === sel) ?? null
  const amtNum = parseAmount(amt)
  const amtValid = selected !== null && amtNum !== null && amtNum > 0 && amtNum <= selected.qty + 1e-9
  const canSubmit = !busy && selected !== null && addr.trim().length > 0 && amtValid

  const submit = async () => {
    if (!selected || amtNum === null) return
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch('/api/withdraw', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network: selected.network, asset: selected.asset, amountQty: amtNum, toAddress: addr.trim() }),
      })
      const out = (await r.json()) as Withdrawal & { error?: string }
      if (out.error) {
        setErr(out.error)
      } else if (out.status === 'failed') {
        setErr(out.error || 'The on-chain transfer failed — your profit was refunded.')
      } else {
        notify(out.status === 'simulated' ? `Simulated withdrawal of ${fmtQty(out.amountQty)} ${out.symbol}` : `Sent ${fmtQty(out.amountQty)} ${out.symbol} — ${short(out.toAddress)}`, 'success')
        setAmt('')
        setSel(null)
      }
      await load()
    } catch {
      setErr('Engine unreachable')
    }
    setBusy(false)
  }

  // Nothing banked and nothing withdrawn yet — show a calm empty state (this is its
  // own tab now, so returning null would leave the tab blank).
  if (!loading && allVault.length === 0 && history.length === 0)
    return (
      <div className="glass p-8 text-center">
        <div className="text-4xl">💸</div>
        <h3 className="mt-2 text-lg font-bold text-white">No profit banked yet</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">When your bots take profit, it's swept here — ready to withdraw to any address (real on-chain in live mode, simulated in paper).</p>
      </div>
    )

  return (
    <div className="glass overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.08] px-5 py-3">
        <h3 className="text-sm font-bold text-white">💸 Withdraw profits</h3>
        <span className="text-[11px] text-slate-500">banked: <span className="font-semibold tabular-nums text-slate-300">{fmtUsd(bankedUsd)}</span></span>
        <button className="btn-ghost ml-auto !py-1 text-xs" disabled={loading} onClick={load}>{loading ? '…' : '↻'}</button>
      </div>

      <div className="space-y-4 p-5">
        <div className={`rounded-xl p-3 text-xs leading-relaxed ${live ? 'bg-amber-500/10 text-amber-200' : 'bg-indigo-500/10 text-indigo-200'}`}>
          {live
            ? 'Live mode — this sends a real on-chain transfer from the bot wallet to the address you specify. Live payouts are supported on Base, Arbitrum, Optimism, Polygon and BNB Chain.'
            : 'Paper mode — withdrawals here are simulated; no funds move. They show how the real payout would work once you go live.'}
        </div>

        {/* Banked balances */}
        {vault.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {vault.map((v) => {
              const key = `${v.network}:${v.asset}`
              const active = key === sel
              return (
                <button
                  key={key}
                  onClick={() => { setSel(active ? null : key); setAmt(''); setErr(null) }}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${active ? 'border-indigo-400/60 bg-indigo-500/[0.08]' : 'border-white/[0.08] hover:bg-white/[0.03]'}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-100">{fmtQty(v.qty)} {v.symbol}</div>
                    <div className="truncate text-[11px] text-slate-500">{v.networkName} · {fmtUsd(v.usdValue)}</div>
                  </div>
                  <span className={`shrink-0 text-xs ${active ? 'text-indigo-300' : 'text-slate-600'}`}>{active ? '✓' : 'select'}</span>
                </button>
              )
            })}
          </div>
        ) : live && allVault.length > 0 ? (
          <p className="text-xs text-slate-400">Your banked profit ({fmtUsd(bankedUsd)}) is on paper-only chains (e.g. Market) — there's nothing to pay out on-chain yet. Switch to <strong>Paper</strong> to simulate a withdrawal.</p>
        ) : (
          <p className="text-xs text-slate-500">No banked profit yet — winning trades sweep profit here as it's realised.</p>
        )}

        {/* Withdraw form */}
        {selected && (
          <div className="animate-in space-y-3 rounded-xl border border-white/[0.08] p-3">
            {(() => {
              const wantKind = selected.network === 'solana' ? 'solana' : 'evm'
              const compatible = book.addresses.filter((a) => a.kind === wantKind)
              return compatible.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-slate-500">Saved:</span>
                  {compatible.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setAddr(a.address)}
                      title={a.address}
                      className={`chip ${addr.trim().toLowerCase() === a.address.toLowerCase() ? 'bg-indigo-500/20 text-indigo-200' : 'bg-white/[0.06] text-slate-300 hover:bg-white/[0.1]'}`}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              ) : null
            })()}
            <div className="flex flex-wrap items-end gap-2">
              <label className="block min-w-0 flex-1">
                <span className="mb-1 block text-[11px] text-slate-400">Destination address</span>
                <input className="input font-mono text-xs" placeholder={selected.network === 'solana' ? 'Solana address…' : '0x…'} value={addr} onChange={(e) => setAddr(e.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-slate-400">Amount ({selected.symbol})</span>
                <div className="flex items-center gap-1.5">
                  <input className="input !w-32 text-sm" type="number" min={0} step="any" value={amt} onChange={(e) => setAmt(e.target.value)} />
                  <button className="btn-ghost !px-2 !py-2 text-[11px]" onClick={() => setAmt(String(selected.qty))}>Max</button>
                </div>
              </label>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-500">
                {amtNum !== null && amtNum > 0 ? `≈ ${fmtUsd(amtNum * (selected.usdValue / (selected.qty || 1)))}` : `up to ${fmtQty(selected.qty)} ${selected.symbol}`}
              </span>
              <button className="btn-primary !py-1.5" disabled={!canSubmit} onClick={submit}>
                {busy ? 'Submitting…' : live && selected.liveWithdrawable ? '💸 Withdraw on-chain' : '💸 Withdraw (simulated)'}
              </button>
            </div>
            {err && <div className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}
          </div>
        )}

        {/* History */}
        {history.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Recent withdrawals</div>
            <div className="max-h-56 space-y-1 overflow-auto">
              {history.map((w) => {
                const link = w.txHash && EXPLORER[w.network] ? `${EXPLORER[w.network]}/tx/${w.txHash}` : null
                return (
                  <div key={w.id} className="flex items-center gap-2 rounded-lg border border-white/[0.05] px-3 py-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-slate-200">
                        {fmtQty(w.amountQty)} {w.symbol} <span className="text-slate-500">→ {short(w.toAddress)}</span>
                      </div>
                      <div className="truncate text-[10px] text-slate-600">{timeAgo(w.ts)} · {fmtUsd(w.amountUsd)} · {w.mode}</div>
                    </div>
                    {link && <a href={link} target="_blank" rel="noreferrer" className="shrink-0 text-slate-500 hover:text-slate-200" title="View transaction">↗</a>}
                    <span className={`chip shrink-0 ${STATUS_CHIP[w.status]}`}>{w.status}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
