import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAccount } from '../wallet'
import type { Portfolio as PortfolioT } from '../types'
import { fmtUsd, fmtQty, fmtPrice, ASSET_COLORS } from '../format'
import { useStore } from '../store'
import WithdrawPanel from './WithdrawPanel'
import HoldingsTracker from './HoldingsTracker'
import AddressBook from './AddressBook'
import DonutCard from './DonutCard'
import StakingSection from './StakingSection'
import EarnSection from './EarnSection'
import ErrorBoundary from './ErrorBoundary'

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

type AddrState = { status: 'loading' | 'ok' | 'error'; data?: PortfolioT; error?: string }

const addrKind = (a: string): 'EVM' | 'Solana' | 'ICP' | '?' => {
  if (/^0x[a-fA-F0-9]{40}$/.test(a)) return 'EVM'
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return 'Solana'
  if (/^[a-z0-9]{5}(-[a-z0-9]{3,5})+$/.test(a)) return 'ICP'
  return '?'
}

export default function Portfolio() {
  const { address: connected } = useAccount()
  const { meta, tab, setTab } = useStore(
    useShallow((s) => ({ meta: s.meta, tab: s.portfolioTab, setTab: s.setPortfolioTab })),
  )
  const [input, setInput] = useState('')
  const [addrs, setAddrs] = useState<string[]>([])
  const [byAddr, setByAddr] = useState<Record<string, AddrState>>({})

  const load = async (raw: string) => {
    const a = raw.trim()
    if (!a) return
    setByAddr((m) => ({ ...m, [a]: { status: 'loading' } }))
    try {
      const r = await fetch(`/api/wallet/${a}`)
      const j = await r.json()
      if (j.error) setByAddr((m) => ({ ...m, [a]: { status: 'error', error: j.error } }))
      else setByAddr((m) => ({ ...m, [a]: { status: 'ok', data: j } }))
    } catch {
      setByAddr((m) => ({ ...m, [a]: { status: 'error', error: 'Engine unreachable' } }))
    }
  }

  const add = (raw: string) => {
    const a = raw.trim()
    if (!a) return
    setInput('')
    setAddrs((prev) => (prev.some((x) => x.toLowerCase() === a.toLowerCase()) ? prev : [...prev, a]))
    load(a)
  }
  const remove = (a: string) => {
    setAddrs((prev) => prev.filter((x) => x !== a))
    setByAddr((m) => {
      const n = { ...m }
      delete n[a]
      return n
    })
  }

  // Auto-add the connected wallet + the BOT wallet's EVM & Solana addresses, so the
  // Wallet tab shows holdings across all the main networks (EVM chains via the EVM
  // address, plus Solana) out of the box — without the user pasting anything.
  useEffect(() => {
    const seed = [connected, meta?.live?.evm?.wallet ?? meta?.live?.botWallet, meta?.live?.solana?.wallet].filter(Boolean) as string[]
    for (const a of seed) if (!addrs.some((x) => x.toLowerCase() === a.toLowerCase())) add(a)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, meta?.live?.botWallet, meta?.live?.evm?.wallet, meta?.live?.solana?.wallet])

  // Live-refresh on-chain balances every 30s while the Wallet tab is open and visible —
  // otherwise the value silently freezes at first read for the whole session.
  useEffect(() => {
    if (tab !== 'wallet' || addrs.length === 0) return
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') addrs.forEach(load)
    }, 30_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, addrs])

  // Merge every successfully-read address into one combined portfolio (so EVM +
  // Solana holdings show together; same asset on the same network is summed).
  const data = useMemo<PortfolioT | null>(() => {
    const ports = addrs.map((a) => byAddr[a]).filter((s): s is AddrState => !!s && s.status === 'ok' && !!s.data).map((s) => s.data!)
    if (ports.length === 0) return null
    const hmap = new Map<string, PortfolioT['holdings'][number]>()
    for (const p of ports)
      for (const h of p.holdings) {
        const k = `${h.network}:${h.symbol}`
        const e = hmap.get(k)
        if (e) { e.balance += h.balance; e.usd += h.usd } else hmap.set(k, { ...h })
      }
    const holdings = [...hmap.values()].sort((a, b) => b.usd - a.usd)
    const nmap = new Map<string, PortfolioT['byNetwork'][number]>()
    for (const p of ports)
      for (const n of p.byNetwork) {
        const e = nmap.get(n.id)
        if (e) e.usd += n.usd
        else nmap.set(n.id, { ...n })
      }
    return {
      address: addrs.join(', '),
      totalUsd: +holdings.reduce((s, h) => s + h.usd, 0).toFixed(2),
      holdings,
      byNetwork: [...nmap.values()].sort((a, b) => b.usd - a.usd),
      errors: [...new Set(ports.flatMap((p) => p.errors))],
    }
  }, [addrs, byAddr])

  const anyLoading = addrs.some((a) => byAddr[a]?.status === 'loading')
  const addrErrors = addrs.map((a) => ({ a, e: byAddr[a]?.status === 'error' ? byAddr[a]?.error : null })).filter((x): x is { a: string; e: string } => !!x.e)

  const assetSegments = useMemo(() => {
    if (!data) return []
    const bySymbol = new Map<string, number>()
    // Keep $0 assets too (native coins of empty networks) so the by-asset view is
    // comprehensive — zero entries sort to the bottom and render muted. [comprehensive]
    for (const h of data.holdings) bySymbol.set(h.symbol, (bySymbol.get(h.symbol) ?? 0) + h.usd)
    const sorted = [...bySymbol.entries()].sort((a, b) => b[1] - a[1])
    const top = sorted.slice(0, 9)
    const otherUsd = sorted.slice(9).reduce((s, [, v]) => s + v, 0)
    const segs = top.map(([label, value], i) => ({ label, value, color: ASSET_COLORS[i % ASSET_COLORS.length] }))
    if (otherUsd > 0) segs.push({ label: 'Other', value: otherUsd, color: '#475569' })
    return segs
  }, [data])

  const networkSegments = useMemo(() => (data ? data.byNetwork.map((n) => ({ label: n.name, value: n.usd, color: n.color })) : []), [data])

  // An always-visible input to add an address of any ecosystem (EVM / Solana / ICP).
  const addBar = (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="input min-w-0 flex-1 font-mono text-xs"
        placeholder="Add an address — EVM 0x…, Solana, or ICP principal"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add(input)}
      />
      <button className="btn-primary shrink-0" onClick={() => add(input)} disabled={!input.trim()}>
        + Add
      </button>
    </div>
  )

  // Chips for each tracked address with its read status + a remove button.
  const chips = addrs.length > 0 && (
    <div className="flex flex-wrap gap-2">
      {addrs.map((a) => {
        const st = byAddr[a]
        return (
          <span key={a} className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.03] px-2.5 py-1 text-[11px]">
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">{addrKind(a)}</span>
            <span className="font-mono text-slate-300">{short(a)}</span>
            {st?.status === 'loading' && <span className="text-slate-500">…</span>}
            {st?.status === 'ok' && <span className="tabular-nums text-emerald-300">{fmtUsd(st.data?.totalUsd ?? 0)}</span>}
            {st?.status === 'error' && <span className="text-rose-300" title={st.error}>!</span>}
            <button className="text-slate-600 hover:text-rose-300" onClick={() => remove(a)} aria-label="Remove address">✕</button>
          </span>
        )
      })}
    </div>
  )

  // ── On-chain wallet reader — rendered inside the "Wallet" tab ───────────────
  const walletContent =
    !data && !anyLoading ? (
      <div className="glass animate-in mx-auto max-w-lg p-8 text-center">
        <div className="text-5xl">💼</div>
        <h2 className="mt-3 text-xl font-bold text-white">Your wallet, visualised</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-slate-400">
          Connect your wallet (top right) for your EVM holdings across Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain — then add a Solana address or an ICP principal to see those too, all in one place.
        </p>
        <p className="mt-4 text-[11px] uppercase tracking-wide text-slate-500">…or inspect any address</p>
        <div className="mx-auto mt-2 max-w-sm">{addBar}</div>
        {chips && <div className="mx-auto mt-3 max-w-sm">{chips}</div>}
        {addrErrors.map(({ a, e }) => (
          <div key={a} className="mx-auto mt-2 max-w-sm rounded-xl bg-rose-500/10 p-2.5 text-left text-xs text-rose-300">{short(a)}: {e}</div>
        ))}
      </div>
    ) : (
      <>
        {/* Header — total value + tracked addresses */}
        <div className="glass space-y-3 p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">🔗 On-chain wallet value</div>
              <div className="text-4xl font-extrabold tabular-nums text-slate-900 dark:bg-gradient-to-r dark:from-indigo-300 dark:to-cyan-300 dark:bg-clip-text dark:text-transparent">
                {/* Don't show a fake $0.00 while the first read is still in flight. */}
                {!data && anyLoading ? <span className="text-slate-500">Reading…</span> : fmtUsd(data?.totalUsd ?? 0)}
              </div>
              {data && (
                <div className="mt-1 truncate text-[11px] text-slate-500">
                  {data.holdings.length} {data.holdings.length === 1 ? 'asset' : 'assets'} · {data.byNetwork.length} {data.byNetwork.length === 1 ? 'network' : 'networks'} · {addrs.length} {addrs.length === 1 ? 'address' : 'addresses'}
                </div>
              )}
            </div>
            <button className="btn-ghost" disabled={anyLoading} onClick={() => addrs.forEach(load)}>
              {anyLoading ? 'Reading…' : '↻ Refresh'}
            </button>
          </div>
          {chips}
          {addBar}
          {addrErrors.map(({ a, e }) => (
            <div key={a} className="rounded-xl bg-rose-500/10 p-2 text-xs text-rose-300">{short(a)}: {e}</div>
          ))}
        </div>

        {anyLoading && !data && <div className="glass animate-pulse p-8 text-center text-sm text-slate-500">Reading on-chain balances…</div>}

        {data && (
          <>
          <div className="grid gap-4 lg:grid-cols-2">
            <DonutCard title="By network" segments={networkSegments} total={data.totalUsd} />
            <DonutCard title="By asset" segments={assetSegments} total={data.totalUsd} />
          </div>

          {/* Holdings */}
          <div className="glass overflow-hidden">
            <div className="border-b border-white/[0.08] px-5 py-3 text-sm font-bold text-white">Holdings</div>
            <div className="max-h-[26rem] overflow-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="sticky top-0 bg-[var(--head)] text-left text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    {['Asset', 'Network', 'Balance', 'Price', 'Value', '%'].map((h) => (
                      <th key={h} className="px-5 py-2 font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.holdings.map((h) => (
                    <tr key={`${h.network}:${h.symbol}`} className="border-t border-white/[0.04] tabular-nums hover:bg-white/[0.02]">
                      <td className="px-5 py-2">
                        <div className="flex items-center gap-2">
                          <span className="token-avatar flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-[var(--ink)]" style={{ '--tok': h.color } as CSSProperties}>
                            {h.symbol.slice(0, 4)}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-medium text-slate-100">{h.symbol}</div>
                            <div className="truncate text-[10px] text-slate-500">{h.name}{h.kind === 'native' ? ' · native' : ''}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-2">
                        <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                          <span className="h-2 w-2 rounded-full" style={{ background: h.color }} />
                          {h.networkName}
                        </span>
                      </td>
                      <td className="px-5 py-2 text-slate-300">{fmtQty(h.balance)}</td>
                      <td className="px-5 py-2 text-slate-400">{h.priceUsd ? fmtPrice(h.priceUsd) : '—'}</td>
                      <td className="px-5 py-2 font-semibold text-slate-100">{h.priceUsd ? fmtUsd(h.usd) : '—'}</td>
                      <td className="px-5 py-2 text-slate-500">{data.totalUsd > 0 && h.usd > 0 ? `${((h.usd / data.totalUsd) * 100).toFixed(1)}%` : '—'}</td>
                    </tr>
                  ))}
                  {data.holdings.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-500">No holdings found on the supported networks.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {data.errors.length > 0 && (
            <p className="text-[11px] text-amber-300">⚠ Couldn't read {data.errors.join('; ')} — the public RPC may be rate-limited. Refresh in a moment for full coverage.</p>
          )}
          <p className="text-[10px] leading-relaxed text-slate-600">
            Balances are read live from each chain's public RPC (and the IC ledger canisters for ICP) and priced from CoinGecko — native coins + the curated tokens PulseTrade supports on EVM chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB), Solana, and the Internet Computer (ICP, ckBTC, ckUSDT). Add a Solana address or an ICP principal above to include it. Staking, LP positions and non-curated tokens aren't shown.
          </p>
        </>
      )}
      </>
    )

  return (
    <div className="animate-in space-y-4">
      {/* Tabs — keep the Portfolio compact instead of one long scroll; isolating each
          section also means a hiccup in one can't take the others down. */}
      <div role="tablist" aria-label="Portfolio sections" className="flex items-center gap-1 seg-track p-1 text-sm">
        {([['holdings', '📊 Holdings'], ['wallet', '🔗 Wallet'], ['staking', '🔒 Staking'], ['earn', '🌱 Earn'], ['withdraw', '💸 Withdraw']] as const).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`flex-1 cursor-pointer rounded-lg px-3 py-2 font-semibold transition-colors ${tab === k ? 'seg-active' : 'text-slate-400 hover:text-slate-200'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* One boundary per tab content — a render fault in one section degrades to a notice
          instead of blanking the whole Portfolio; resetKey={tab} clears it on tab switch. */}
      <ErrorBoundary
        resetKey={tab}
        fallback={<div className="glass p-6 text-center text-sm text-rose-300">This section hit an error. Switch tabs and back, or reload the app.</div>}
      >
        {tab === 'holdings' && <HoldingsTracker />}
        {tab === 'wallet' && <div className="space-y-4">{walletContent}</div>}
        {tab === 'staking' && <StakingSection />}
        {tab === 'earn' && <EarnSection />}
        {tab === 'withdraw' && (
          <div className="space-y-4">
            <WithdrawPanel />
            <AddressBook />
          </div>
        )}
      </ErrorBoundary>
    </div>
  )
}
