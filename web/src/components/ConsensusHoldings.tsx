import { useEffect, useState } from 'react'
import { fmtCompactUsd as compact } from '../format'
import type { ConsensusHolding } from '../types'
import CoinLinks from './CoinLinks'

const firstName = (label: string) => label.split(/[(—·]/)[0].trim().split(' ').slice(0, 2).join(' ')

interface Payload {
  holdings: ConsensusHolding[]
  needsKey: boolean
  totalWallets: number
}

const LIMIT = 12 // default to the top N, with a "show all" toggle for the long tail

/**
 * Consensus Holdings — tokens 2+ tracked whales are CURRENTLY holding (a conviction
 * signal, distinct from recent flow). Rendered as a DENSE ranked table (sorted by how
 * many whales hold, then by priced value) so 30+ tokens stay scannable instead of
 * sprawling across a card grid: each row is the token, a conviction meter, its combined
 * value, who holds it, and compact research links.
 */
export default function ConsensusHoldings({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<Payload | null>(null)
  const [open, setOpen] = useState(true)
  const [all, setAll] = useState(false)

  // Re-fetches when the parent's "↻ Refresh" bumps refreshKey (and on mount).
  useEffect(() => {
    fetch('/api/smart-money/consensus-holdings')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
  }, [refreshKey])

  if (!data || data.needsKey || data.holdings.length === 0) return null

  // Conviction first (most whales), then real money (priced value), then name.
  const sorted = [...data.holdings].sort((a, b) => b.holders - a.holders || (b.totalUsd ?? -1) - (a.totalUsd ?? -1) || a.token.localeCompare(b.token))
  const shown = all ? sorted : sorted.slice(0, LIMIT)

  return (
    <div className="glass overflow-hidden">
      <button className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="text-sm font-bold text-white">🤝 Consensus Holdings</span>
        <span className="hidden text-[11px] text-slate-500 sm:inline">tokens 2+ of {data.totalWallets} tracked whales hold right now</span>
        <span className="ml-auto rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold tabular-nums text-slate-400">{data.holdings.length}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-white/[0.06]">
          <table className="w-full min-w-[620px] text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="py-2 pl-4 pr-3 font-medium">Token</th>
                <th className="px-3 py-2 font-medium">Conviction</th>
                <th className="px-3 py-2 text-right font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Held by</th>
                <th className="py-2 pl-3 pr-4 font-medium" />
              </tr>
            </thead>
            <tbody>
              {shown.map((h, i) => (
                <Row key={`${h.network}:${h.tokenAddress}`} h={h} rank={i + 1} />
              ))}
            </tbody>
          </table>

          {sorted.length > LIMIT && (
            <button onClick={() => setAll((a) => !a)} className="w-full border-t border-white/[0.06] py-2 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.03] hover:text-slate-200">
              {all ? `Show top ${LIMIT}` : `Show all ${sorted.length} →`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ h, rank }: { h: ConsensusHolding; rank: number }) {
  const pct = h.pctOfWhales
  // Grade the conviction so a 5/8 reads stronger than a 2/8 at a glance.
  const bar = pct >= 60 ? 'from-emerald-400 to-cyan-400' : pct >= 38 ? 'from-indigo-500 to-cyan-400' : 'from-slate-500 to-slate-400'
  return (
    <tr className="border-t border-white/[0.04] tabular-nums transition-colors hover:bg-white/[0.02]">
      <td className="py-2 pl-4 pr-3">
        <div className="flex items-center gap-2">
          <span className="w-4 shrink-0 text-right text-[10px] text-slate-600">{rank}</span>
          <span className="max-w-[130px] truncate font-bold text-white" title={h.token}>{h.token}</span>
          <span className="shrink-0 rounded bg-white/[0.06] px-1 py-0.5 text-[9px] uppercase tracking-wide text-slate-500">{h.network.slice(0, 3)}</span>
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-bold text-indigo-200">🐋 {h.holders}/{h.totalWallets}</span>
          <span className="hidden h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-white/[0.06] sm:block">
            <span className={`block h-full rounded-full bg-gradient-to-r ${bar}`} style={{ width: `${Math.max(6, pct)}%` }} />
          </span>
          <span className="shrink-0 text-[11px] text-slate-500">{pct}%</span>
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        {h.totalUsd !== null ? <span className="font-semibold text-emerald-400">{compact(h.totalUsd)}</span> : <span className="text-slate-600">—</span>}
      </td>
      <td className="max-w-[200px] px-3 py-2">
        <span className="block truncate text-[11px] text-slate-400" title={h.wallets.map((w) => w.label).join(', ')}>
          {h.wallets.map((w) => firstName(w.label)).join(', ')}
        </span>
      </td>
      <td className="py-2 pl-3 pr-4">
        <CoinLinks network={h.network} address={h.tokenAddress} />
      </td>
    </tr>
  )
}
