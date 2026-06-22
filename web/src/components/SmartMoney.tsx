import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { SmartMoneyEvent, TrackedWallet } from '../types'
import { fmtUsd, timeAgo, parseAmount } from '../format'
import WalletAccount from './WalletAccount'
import SmartInsights from './SmartInsights'
import ConsensusHoldings from './ConsensusHoldings'
import NetworkSelect from './NetworkSelect'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * Smart Money — a top-level view (a tab beside Bots & Market). Surfaces what
 * tracked "smart money" wallets are doing: a CONSENSUS panel (the tokens the
 * most independent wallets are accumulating — the actionable signal), a raw
 * activity feed, per-wallet accounts, a watchlist, and one-click copy-trading.
 */
export default function SmartMoney() {
  const { meta, refresh, mode, follows, notify } = useStore()
  const [tab, setTab] = useState<'feed' | 'accounts' | 'watchlist'>('feed')
  const [account, setAccount] = useState<string | null>(null)
  const [network, setNetwork] = useState('base')
  const [events, setEvents] = useState<SmartMoneyEvent[]>([])
  const [needsKey, setNeedsKey] = useState(false)
  const [loading, setLoading] = useState(false)
  const [wallets, setWallets] = useState<TrackedWallet[]>([])

  const [addr, setAddr] = useState('')
  const [label, setLabel] = useState('')
  const [addErr, setAddErr] = useState<string | null>(null)

  const [copyWallet, setCopyWallet] = useState<SmartMoneyEvent | TrackedWallet | null>(null)
  const [copyToken, setCopyToken] = useState('')
  const [copyRisk, setCopyRisk] = useState('balanced')
  const [copyBudget, setCopyBudget] = useState('200')
  const [copySweep, setCopySweep] = useState<'native' | 'usdt'>('native')
  const [copyErr, setCopyErr] = useState<string | null>(null)

  const net = meta?.networks.find((n) => n.id === network)

  const loadFeed = async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/smart-money/${network}`)
      const data = await r.json()
      setEvents(data.events ?? [])
      setNeedsKey(!!data.needsKey)
    } catch {
      /* ignore */
    }
    setLoading(false)
  }
  const loadWallets = async () => {
    const r = await fetch('/api/wallets')
    const data = await r.json()
    setWallets(data.wallets ?? [])
  }

  useEffect(() => {
    loadFeed()
  }, [network])
  useEffect(() => {
    loadWallets()
  }, [])

  const addr_ok = /^0x[a-fA-F0-9]{40}$/.test(addr)
  const add = async () => {
    setAddErr(null)
    const r = await fetch('/api/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: addr, label }) })
    const data = await r.json()
    if (data.error) setAddErr(data.error)
    else {
      setAddr('')
      setLabel('')
      loadWallets()
    }
  }
  const removeW = async (a: string) => {
    await fetch(`/api/wallets/${a}`, { method: 'DELETE' })
    loadWallets()
  }

  const copyBudgetNum = parseAmount(copyBudget)
  const launchCopy = async () => {
    if (!copyWallet || copyBudgetNum === null) return
    setCopyErr(null)
    const walletAddress = (copyWallet as { address?: string; wallet?: string }).address ?? (copyWallet as { wallet?: string }).wallet
    const r = await fetch('/api/copy-bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ network, token: copyToken || net?.tokens[0]?.symbol, risk: copyRisk, budgetUsd: copyBudgetNum, walletAddress, walletLabel: copyWallet.label, sweepTo: copySweep }),
    })
    const data = await r.json()
    if (data.error) setCopyErr(data.error)
    else {
      await refresh()
      setCopyWallet(null)
      notify('Copy-trade bot launched', 'success')
    }
  }

  if (!meta) return null
  const copyAddress = (copyWallet as { address?: string; wallet?: string } | null)?.address ?? (copyWallet as { wallet?: string } | null)?.wallet

  return (
    <div className="animate-in space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-white">🐋 Smart Money</h1>
          <p className="mt-0.5 text-sm text-slate-400">See what tracked whale wallets are accumulating, then copy or follow their moves.</p>
        </div>
        <div className="flex items-center gap-2">
          <NetworkSelect className="input !w-36 !py-1.5 text-xs" value={network} onChange={setNetwork} networks={meta.networks.filter((n) => n.evm !== false && n.tradeable !== false)} />
          <button className="btn-ghost !py-1.5 text-xs" onClick={loadFeed} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {needsKey && (
        <div className="rounded-xl bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
          Live wallet activity needs an Etherscan API key. Add <code className="rounded code-block px-1">ETHERSCAN_API_KEY</code> to <code className="rounded code-block px-1">server/.env</code> (free at etherscan.io) and restart. You can still
          manage your watchlist and launch copy/follow bots — they act once tracking is enabled.
        </div>
      )}

      {/* ── AI intelligence: the headline of the dashboard ── */}
      {!needsKey && <SmartInsights />}

      {/* ── Consensus holdings: what 2+ whales actually hold ── */}
      {!needsKey && <ConsensusHoldings />}

      <div className="glass p-4">
        <div className="mb-3 flex items-center gap-1 seg-track p-0.5 text-xs">
          {(['feed', 'accounts', 'watchlist'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t)
                setAccount(null)
              }}
              className={`cursor-pointer rounded-lg px-3 py-1.5 font-semibold ${tab === t ? 'seg-active' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {t === 'feed' ? '📡 Activity' : t === 'accounts' ? '👤 Accounts' : '⭐ Watchlist'}
            </button>
          ))}
        </div>

        {tab === 'accounts' ? (
          account ? (
            <WalletAccount address={account} onClose={() => setAccount(null)} />
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-slate-500">Tap an account to see its trading history, charts, and to follow it — manually or automatically.</p>
              {wallets.map((w) => {
                const f = follows.find((x) => x.walletAddress.toLowerCase() === w.address.toLowerCase() && x.enabled)
                return (
                  <button key={w.address} onClick={() => setAccount(w.address)} className="flex w-full items-center gap-3 rounded-xl border border-white/[0.08] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500/40 to-cyan-500/30 text-sm">👤</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-200">{w.label}</div>
                      {w.note ? <div className="truncate text-[11px] text-slate-500">{w.note}</div> : <div className="font-mono text-[10px] text-slate-600">{short(w.address)}</div>}
                    </div>
                    {f && <span className="chip shrink-0 bg-emerald-500/10 text-emerald-300">🤖 following · {fmtUsd(f.totalBudgetUsd)}</span>}
                    <span className="shrink-0 text-xs text-slate-500">view →</span>
                  </button>
                )
              })}
            </div>
          )
        ) : tab === 'feed' ? (
          <div className="max-h-[55vh] overflow-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead className="sticky top-0 bg-[var(--head)] text-left text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  {['When', 'Wallet', 'Action', 'Token', 'Value', ''].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-600">
                      {loading ? 'Loading activity…' : needsKey ? 'Enable tracking to see live activity.' : 'No recent activity for tracked wallets on this network.'}
                    </td>
                  </tr>
                )}
                {events.map((e, i) => (
                  <tr key={e.txHash + i} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                    <td className="px-3 py-2 text-slate-500">{timeAgo(e.ts)}</td>
                    <td className="px-3 py-2 text-slate-300">{e.label}</td>
                    <td className="px-3 py-2">
                      <span className={`chip ${e.side === 'buy' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>{e.side.toUpperCase()}</span>
                    </td>
                    <td className="px-3 py-2 text-slate-200">{e.token}</td>
                    <td className="px-3 py-2 text-slate-400">{e.usd !== null ? fmtUsd(e.usd) : '—'}</td>
                    <td className="px-3 py-2">
                      <button
                        className="btn-ghost !px-2 !py-1 text-[11px]"
                        onClick={() => {
                          setCopyWallet(e)
                          setCopyToken(e.token)
                        }}
                      >
                        Copy 🐋
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-2 rounded-xl bg-white/[0.03] p-3">
              <label className="block flex-1">
                <span className="mb-1 block text-[11px] text-slate-400">Wallet address (0x…)</span>
                <input className="input !py-2 font-mono text-xs" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-slate-400">Label</span>
                <input className="input !py-2 text-xs" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" />
              </label>
              <button className="btn-primary !py-2" disabled={!addr_ok} onClick={add}>
                + Track
              </button>
            </div>
            {addErr && <div className="rounded-xl bg-rose-500/10 p-2 text-xs text-rose-300">{addErr}</div>}
            {wallets.map((w) => (
              <div key={w.address} className="flex items-center gap-2 rounded-xl border border-white/[0.08] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-200">{w.label}</div>
                  {w.note && <div className="truncate text-[11px] text-slate-500">{w.note}</div>}
                  <div className="font-mono text-[10px] text-slate-600">{short(w.address)}</div>
                </div>
                <div className="ml-auto flex gap-1.5">
                  <button
                    className="btn-ghost !px-2 !py-1 text-[11px]"
                    onClick={() => {
                      setCopyWallet(w)
                      setCopyToken('')
                    }}
                  >
                    Copy 🐋
                  </button>
                  <button className="btn-ghost !px-2 !py-1 text-[11px] text-rose-300" onClick={() => removeW(w.address)}>
                    🗑
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {copyWallet && (
        <div className="glass border-indigo-400/30 bg-indigo-500/[0.06] p-4">
          <div className="mb-2 text-xs font-semibold text-indigo-200">
            Copy-trade {copyWallet.label} <span className="font-mono text-[10px] text-slate-500">{copyAddress ? short(copyAddress) : ''}</span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-400">Token</span>
              <select className="input !py-1.5 text-xs" value={copyToken} onChange={(e) => setCopyToken(e.target.value)}>
                {net?.tokens.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-400">Risk</span>
              <select className="input !py-1.5 text-xs" value={copyRisk} onChange={(e) => setCopyRisk(e.target.value)}>
                {Object.keys(meta.risk).map((r) => (
                  <option key={r} value={r}>
                    {meta.risk[r].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-400">Budget ($)</span>
              <input className="input !w-24 !py-1.5 text-xs" type="number" min={10} value={copyBudget} onChange={(e) => setCopyBudget(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-400">Profits to</span>
              <select className="input !py-1.5 text-xs" value={copySweep} onChange={(e) => setCopySweep(e.target.value as 'native' | 'usdt')}>
                <option value="native">Native</option>
                <option value="usdt">USDT</option>
              </select>
            </label>
            <button className="btn-primary !py-1.5" disabled={copyBudgetNum === null || copyBudgetNum < 10} onClick={launchCopy}>
              🐋 Launch copy bot
            </button>
            <button className="btn-ghost !py-1.5 text-xs" onClick={() => setCopyWallet(null)}>
              cancel
            </button>
          </div>
          {copyErr && <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{copyErr}</div>}
          <p className="mt-2 text-[10px] text-slate-600">When this wallet buys the token, your bot buys; when it sells, your bot sells — sized to your budget and risk. {mode} mode.</p>
        </div>
      )}
    </div>
  )
}
