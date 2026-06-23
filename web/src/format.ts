/**
 * Coerce any value the engine sends to a finite number. Data arrives over a
 * WebSocket with no schema guarantee, so a single missing/NaN field must never
 * throw inside a formatter and take down a whole card via the ErrorBoundary.
 */
const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Parse a user-entered amount, returning null when it isn't a usable number.
 * Use for form validation so empty/NaN inputs can't slip past `n < min` guards
 * (`NaN < 10` is `false`, which would otherwise *enable* a submit).
 */
export const parseAmount = (raw: string | number): number | null => {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).trim())
  return Number.isFinite(n) ? n : null
}

export const fmtUsd = (value: number, digits?: number) => {
  const v = finite(value)
  const d = digits ?? (Math.abs(v) >= 1000 ? 0 : 2)
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

/** Truncate an address for display: `0x1234…cdef`. Default always truncates (head 6 / tail 4);
 *  pass `min` to leave short strings intact, or head/tail to change the slice. The single
 *  source of the slice formula — call sites pick the variant via opts. */
export const shortAddr = (a: string, opts: { min?: number; head?: number; tail?: number } = {}): string => {
  const { min = 0, head = 6, tail = 4 } = opts
  return a.length > min ? `${a.slice(0, head)}…${a.slice(-tail)}` : a
}

export const fmtSign = (value: number) => {
  const v = finite(value)
  return (v >= 0 ? '+' : '') + fmtUsd(v)
}

export const fmtPct = (value: number) => {
  const v = finite(value)
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

/**
 * Compact USD for big market figures ("$1.23T" / "$45.6B" / "$2.34M" / "$1.2K").
 * The single canonical compaction (market cap, 24h volume, whale flows, ledger
 * volume) so the tiers don't drift between cards. Always: a finite-guard ('—' for
 * null/NaN), a T-tier, and the sign BEFORE the "$" ("-$2.5K", never "$-2.5K").
 * `signed:true` adds a leading "+" on non-negatives (for signed flow deltas).
 */
export const fmtCompactUsd = (value: number | null | undefined, opts?: { signed?: boolean }) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const v = finite(value)
  const a = Math.abs(v)
  const sign = v < 0 ? '-' : opts?.signed ? '+' : ''
  const body =
    a >= 1e12 ? `${(a / 1e12).toFixed(2)}T`
    : a >= 1e9 ? `${(a / 1e9).toFixed(1)}B`
    : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M`
    : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K`
    : a.toFixed(0)
  return `${sign}$${body}`
}

/** Shared categorical palette for allocation donuts / legends (portfolio + tracker). */
export const ASSET_COLORS = ['#6366f1', '#06b6d4', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f43f5e', '#eab308', '#3b82f6', '#94a3b8']

export const fmtQty = (value: number) => {
  const v = finite(value)
  if (v === 0) return '0'
  return v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v.toPrecision(5)
}

export const fmtPrice = (value: number) => {
  const v = finite(value)
  return (
    '$' +
    (v >= 1000
      ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : v >= 1
        ? v.toFixed(2)
        : v.toPrecision(4))
  )
}

export const timeAgo = (ts: number) => {
  if (!Number.isFinite(ts)) return '—'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const hhmm = (ts: number) =>
  Number.isFinite(ts)
    ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—'

export const pnlColor = (v: number) => (v > 0.005 ? 'text-emerald-400' : v < -0.005 ? 'text-rose-400' : 'text-slate-400')

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
