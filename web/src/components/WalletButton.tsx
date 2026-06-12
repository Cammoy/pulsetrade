import { useState } from 'react'
import { useAccount, useBalance, useConnect, useDisconnect, type Connector } from 'wagmi'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export default function WalletButton() {
  const { address, isConnected, chain } = useAccount()
  const { connectors, connectAsync, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { data: bal } = useBalance({ address })
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  if (isConnected && address) {
    return (
      <button onClick={() => disconnect()} title="Click to disconnect" className="btn-ghost group">
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
        <span className="font-mono text-xs">{short(address)}</span>
        {bal && (
          <span className="text-xs text-slate-400">
            {Number(bal.formatted).toFixed(4)} {bal.symbol}
          </span>
        )}
        {chain && <span className="chip bg-white/10 text-slate-300">{chain.name}</span>}
        <span className="hidden text-xs text-rose-300 group-hover:inline">×</span>
      </button>
    )
  }

  // De-duplicate connectors by name (EIP-6963 discovery + our explicit list can overlap).
  const seen = new Set<string>()
  const options = connectors.filter((c) => {
    const key = c.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const connect = async (connector: Connector) => {
    setErr(null)
    setPendingId(connector.uid)
    try {
      await connectAsync({ connector })
      setOpen(false)
    } catch (e: any) {
      const msg = e?.shortMessage ?? e?.message ?? 'Connection failed'
      setErr(/rejected|denied/i.test(msg) ? 'Connection cancelled' : msg)
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="relative">
      <button className="btn-ghost" disabled={isPending} onClick={() => setOpen((o) => !o)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="6" width="20" height="14" rx="3" />
          <path d="M16 12h4M2 10h20" />
        </svg>
        Connect Wallet
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-white/10 bg-[#0d1320] p-2 shadow-xl">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Choose a wallet</div>
            {options.map((c) => (
              <button
                key={c.uid}
                onClick={() => connect(c)}
                disabled={pendingId !== null}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
              >
                {c.icon ? (
                  <img src={c.icon} alt="" className="h-5 w-5 rounded" />
                ) : (
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-white/10 text-[10px]">{c.name[0]}</span>
                )}
                <span className="flex-1">{c.name}</span>
                {pendingId === c.uid && <span className="text-[11px] text-slate-500">connecting…</span>}
              </button>
            ))}
            {err && <div className="mt-1 rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">{err}</div>}
            <p className="mt-1 px-2 py-1 text-[10px] leading-relaxed text-slate-600">
              No wallet? Install MetaMask or Rabby, or pick a mobile wallet. Connecting is read-only — bots trade in paper mode unless live keys are configured server-side.
            </p>
          </div>
        </>
      )}
    </div>
  )
}
