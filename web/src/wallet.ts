// Minimal EIP-1193 + EIP-6963 wallet connect — replaces wagmi (and its vulnerable
// @wagmi/connectors → walletconnect/coinbase/metamask/reown dependency tree + a large
// bundle). The browser NEVER signs or sends transactions here: all trading is server-side
// via the bot wallet. This only DISCOVERS installed wallets, connects to read the user's
// ADDRESS (portfolio auto-fill / "connected" badge) and shows a native balance — read-only.
//
// It exposes the same hook shapes the components consumed from wagmi (useAccount /
// useConnect / useDisconnect / useBalance + a Connector type), so the migration is just an
// import swap. State lives in a tiny module store read via useSyncExternalStore — no React
// context provider needed.
import { useSyncExternalStore, useState, useCallback, useEffect } from 'react'
import { formatEther } from 'viem'

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, handler: (...args: never[]) => void): void
  removeListener?(event: string, handler: (...args: never[]) => void): void
  isMetaMask?: boolean
}
export interface Connector { uid: string; name: string; icon?: string; provider: Eip1193 }

const CHAINS: Record<number, { name: string; symbol: string }> = {
  1: { name: 'Ethereum', symbol: 'ETH' },
  8453: { name: 'Base', symbol: 'ETH' },
  42161: { name: 'Arbitrum', symbol: 'ETH' },
  10: { name: 'Optimism', symbol: 'ETH' },
  137: { name: 'Polygon', symbol: 'POL' },
  56: { name: 'BNB Chain', symbol: 'BNB' },
}
const LS_KEY = 'pulsetrade.wallet.rdns'

// ── Connection store ─────────────────────────────────────────────────────────
type WState = { address?: `0x${string}`; chainId?: number; rdns?: string }
let wstate: WState = {}
const wsubs = new Set<() => void>()
const setW = (s: WState) => { wstate = s; wsubs.forEach((f) => f()) }

// ── EIP-6963 discovery (every installed wallet announces itself) ──────────────
const providers = new Map<string, Connector>()
const psubs = new Set<() => void>()
let psnapshot: Connector[] = []
const refreshConnectors = () => { psnapshot = [...providers.values()]; psubs.forEach((f) => f()) }

function attach(conn: Connector) {
  conn.provider.on?.('accountsChanged', (accts: string[]) =>
    setW(accts?.length ? { ...wstate, address: accts[0] as `0x${string}` } : {}),
  )
  conn.provider.on?.('chainChanged', (cid: string) => setW({ ...wstate, chainId: Number(cid) }))
  conn.provider.on?.('disconnect', () => setW({}))
}

async function eagerReconnect() {
  const rdns = localStorage.getItem(LS_KEY)
  if (!rdns) return
  const conn = providers.get(rdns)
  if (!conn) return
  try {
    // eth_accounts is SILENT (no prompt) — restores a prior session without nagging.
    const accts = (await conn.provider.request({ method: 'eth_accounts' })) as string[]
    if (accts?.length) {
      const cid = Number(await conn.provider.request({ method: 'eth_chainId' }))
      setW({ address: accts[0] as `0x${string}`, chainId: cid, rdns })
      attach(conn)
    }
  } catch {
    /* extension locked / unavailable — stay disconnected */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e: Event) => {
    const d = (e as CustomEvent).detail as { info?: { name: string; icon?: string; rdns: string }; provider: Eip1193 }
    if (!d?.info?.rdns) return
    providers.set(d.info.rdns, { uid: d.info.rdns, name: d.info.name, icon: d.info.icon, provider: d.provider })
    refreshConnectors()
    void eagerReconnect() // a late-announcing wallet may be the one we were connected to
  })
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  // Legacy fallback: a bare window.ethereum that never announced via EIP-6963.
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum
  if (eth && providers.size === 0) {
    providers.set('injected', { uid: 'injected', name: eth.isMetaMask ? 'MetaMask' : 'Browser Wallet', provider: eth })
    refreshConnectors()
  }
  void eagerReconnect()
}

export async function connect(conn: Connector): Promise<void> {
  const accts = (await conn.provider.request({ method: 'eth_requestAccounts' })) as string[]
  if (!accts?.length) throw new Error('No account returned')
  const cid = Number(await conn.provider.request({ method: 'eth_chainId' }))
  localStorage.setItem(LS_KEY, conn.uid)
  setW({ address: accts[0] as `0x${string}`, chainId: cid, rdns: conn.uid })
  attach(conn)
}
export function disconnect(): void {
  localStorage.removeItem(LS_KEY)
  setW({})
}

// ── React hooks (mirror the wagmi API the components already use) ─────────────
export function useAccount() {
  const s = useSyncExternalStore(
    (cb) => { wsubs.add(cb); return () => wsubs.delete(cb) },
    () => wstate,
    () => wstate,
  )
  const c = s.chainId ? CHAINS[s.chainId] : undefined
  return {
    address: s.address,
    isConnected: !!s.address,
    chain: s.chainId ? { id: s.chainId, name: c?.name ?? `Chain ${s.chainId}` } : undefined,
  }
}

export function useConnect() {
  const connectors = useSyncExternalStore(
    (cb) => { psubs.add(cb); return () => psubs.delete(cb) },
    () => psnapshot,
    () => psnapshot,
  )
  const [isPending, setPending] = useState(false)
  const connectAsync = useCallback(async ({ connector }: { connector: Connector }) => {
    setPending(true)
    try { await connect(connector) } finally { setPending(false) }
  }, [])
  return { connectors, connectAsync, isPending }
}

export function useDisconnect() {
  return { disconnect }
}

/** Native balance of `address` on the connected chain — display only. */
export function useBalance({ address }: { address?: string }) {
  const { chain } = useAccount()
  const [data, setData] = useState<{ formatted: string; symbol: string } | undefined>()
  useEffect(() => {
    const conn = wstate.rdns ? providers.get(wstate.rdns) : undefined
    if (!address || !conn) { setData(undefined); return }
    let alive = true
    conn.provider
      .request({ method: 'eth_getBalance', params: [address, 'latest'] })
      .then((hex) => { if (alive) setData({ formatted: formatEther(BigInt(hex as string)), symbol: (chain && CHAINS[chain.id]?.symbol) || 'ETH' }) })
      .catch(() => { if (alive) setData(undefined) })
    return () => { alive = false }
  }, [address, chain?.id])
  return { data }
}
