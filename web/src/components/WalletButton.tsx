import { useState } from 'react'
import { useAccount, useBalance, useConnect, useDisconnect } from 'wagmi'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export default function WalletButton() {
  const { address, isConnected, chain } = useAccount()
  const { connectors, connectAsync, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { data: bal } = useBalance({ address })
  const [err, setErr] = useState<string | null>(null)

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        title="Click to disconnect"
        className="btn-ghost group"
      >
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

  return (
    <div className="flex items-center gap-2">
      {err && <span className="max-w-44 truncate text-xs text-amber-400">{err}</span>}
      <button
        className="btn-ghost"
        disabled={isPending}
        onClick={async () => {
          setErr(null)
          const injected = connectors[0]
          if (!injected) return setErr('No wallet extension found')
          try {
            await connectAsync({ connector: injected })
          } catch (e: any) {
            setErr(e?.shortMessage ?? 'No browser wallet found — install MetaMask/Rabby')
          }
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="6" width="20" height="14" rx="3" />
          <path d="M16 12h4M2 10h20" />
        </svg>
        {isPending ? 'Connecting…' : 'Connect Wallet'}
      </button>
    </div>
  )
}
