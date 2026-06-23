import { useState } from 'react'
import { useAddressBook, addrKind, type AddrKind } from '../addressBook'

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a)
const KIND_CHIP: Record<AddrKind, string> = {
  evm: 'bg-indigo-500/15 text-indigo-300',
  solana: 'bg-violet-500/15 text-violet-300',
  other: 'bg-slate-500/15 text-slate-400',
}
const KIND_LABEL: Record<AddrKind, string> = { evm: 'EVM', solana: 'Solana', other: 'addr' }

/**
 * Labelled address book — save the wallets you send to or track so you never paste a
 * long hex string again. Persisted locally (web/src/addressBook.ts); the Withdraw panel
 * reads the same book to offer one-click destination chips.
 */
export default function AddressBook() {
  const { addresses, save, remove } = useAddressBook()
  const [label, setLabel] = useState('')
  const [address, setAddress] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const kind = address.trim() ? addrKind(address) : null

  const add = () => {
    const r = save(label, address)
    if (r.error) return setErr(r.error)
    setLabel('')
    setAddress('')
    setErr(null)
  }

  return (
    <div className="glass overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/[0.08] px-5 py-3">
        <h3 className="text-sm font-bold text-white">📒 Address book</h3>
        <span className="text-[11px] text-slate-500">{addresses.length} saved</span>
      </div>
      <div className="space-y-3 p-5">
        <p className="text-xs leading-relaxed text-slate-500">Save and label the wallets you send to or track, so you never paste a long address again. Stored locally in your browser.</p>

        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-0 flex-1">
            <span className="mb-1 block text-[11px] text-slate-400">Label</span>
            <input className="input text-sm" placeholder="My Ledger, Cold wallet…" value={label} maxLength={40} onChange={(e) => { setLabel(e.target.value); setErr(null) }} onKeyDown={(e) => e.key === 'Enter' && add()} />
          </label>
          <label className="block min-w-0 flex-[2]">
            <span className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-400">
              Address {kind && <span className={`chip ${KIND_CHIP[kind]}`}>{KIND_LABEL[kind]}</span>}
            </span>
            <input className="input font-mono text-xs" placeholder="0x… or Solana address" value={address} onChange={(e) => { setAddress(e.target.value); setErr(null) }} onKeyDown={(e) => e.key === 'Enter' && add()} />
          </label>
          <button className="btn-primary !py-2" onClick={add} disabled={!label.trim() || !address.trim()}>Save</button>
        </div>
        {err && <div className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}

        {addresses.length > 0 ? (
          <div className="space-y-1">
            {addresses.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded-lg border border-white/[0.05] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-slate-100">{a.label}</span>
                    <span className={`chip shrink-0 ${KIND_CHIP[a.kind]}`}>{KIND_LABEL[a.kind]}</span>
                  </div>
                  <div className="truncate font-mono text-[10px] text-slate-500">{short(a.address)}</div>
                </div>
                <button onClick={() => navigator.clipboard?.writeText(a.address)} className="shrink-0 text-slate-500 hover:text-slate-200" title="Copy address" aria-label="Copy address">⧉</button>
                <button onClick={() => remove(a.id)} className="shrink-0 text-slate-500 hover:text-rose-300" title="Remove" aria-label="Remove address">✕</button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-slate-600">No saved addresses yet.</p>
        )}
      </div>
    </div>
  )
}
