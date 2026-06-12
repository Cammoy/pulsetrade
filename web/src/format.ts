export const fmtUsd = (v: number, digits?: number) => {
  const d = digits ?? (Math.abs(v) >= 1000 ? 0 : 2)
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

export const fmtSign = (v: number) => (v >= 0 ? '+' : '') + fmtUsd(v)

export const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`

export const fmtQty = (v: number) =>
  v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v.toPrecision(5)

export const fmtPrice = (v: number) =>
  '$' +
  (v >= 1000
    ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : v >= 1
      ? v.toFixed(2)
      : v.toPrecision(4))

export const timeAgo = (ts: number) => {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const hhmm = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export const pnlColor = (v: number) => (v > 0.005 ? 'text-emerald-400' : v < -0.005 ? 'text-rose-400' : 'text-slate-400')

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
