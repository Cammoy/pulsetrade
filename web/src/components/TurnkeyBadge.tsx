import { useStore } from '../store'

/**
 * Violet "🔐 Turnkey" pill shown when live trades are signed by Turnkey (the
 * spending key never leaves their infra). Surfaces the daily spend cap usage
 * when live. Hidden on the smallest widths.
 */
export default function TurnkeyBadge() {
  const { meta, mode } = useStore()
  const turnkey = meta?.live.evm?.signer === 'turnkey' || meta?.live.solana?.signer === 'turnkey'
  if (!turnkey) return null
  const dailyCap = meta?.live.maxUsdPerDay ?? 0
  const spentToday = meta?.live.spentTodayUsd ?? 0

  return (
    <span
      className="hidden items-center gap-1 rounded-lg border border-violet-400/30 bg-violet-500/10 px-2 py-1 text-[11px] font-semibold text-violet-300 sm:inline-flex"
      title={`Live trades are signed by Turnkey — the private key never leaves Turnkey.${dailyCap > 0 ? ` Daily spend cap $${dailyCap} (spent $${Math.round(spentToday)} today).` : ' No daily spend cap set — add MAX_LIVE_USD_PER_DAY to server/.env.'}`}
    >
      🔐 Turnkey{mode === 'live' && dailyCap > 0 ? ` · $${Math.round(spentToday)}/${dailyCap}` : ''}
    </span>
  )
}
