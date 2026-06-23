import { coinLinks } from '../coinLinks'

/**
 * Compact, ICON-ONLY external-research links (GeckoTerminal, DexScreener, Explorer).
 * Used wherever a token is listed (consensus holdings, the buying/selling board, the
 * new-coins radar) — icon-only keeps dense lists scannable instead of each row carrying
 * wordy buttons. Labels show on hover.
 */
export default function CoinLinks({ network, address, className = '' }: { network: string; address: string; className?: string }) {
  const links = coinLinks(network, address)
  if (links.length === 0) return null
  return (
    <div className={`flex items-center gap-0.5 ${className}`}>
      {links.map((l) => (
        <a
          key={l.label}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          title={l.label}
          aria-label={l.label}
          onClick={(e) => e.stopPropagation()}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs text-slate-400 transition-colors hover:bg-white/[0.1] hover:text-white"
        >
          {l.icon}
        </a>
      ))}
    </div>
  )
}
