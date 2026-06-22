import type { RiskReport } from '../types'

const VERDICT: Record<RiskReport['verdict'], { label: string; ring: string; text: string; bar: string }> = {
  safe: { label: 'Safe', ring: 'border-emerald-400/40 bg-emerald-500/[0.08]', text: 'text-emerald-300', bar: 'bg-emerald-400' },
  caution: { label: 'Caution', ring: 'border-amber-400/40 bg-amber-500/[0.08]', text: 'text-amber-300', bar: 'bg-amber-400' },
  danger: { label: 'Danger', ring: 'border-rose-400/40 bg-rose-500/[0.08]', text: 'text-rose-300', bar: 'bg-rose-400' },
}

const SEV: Record<string, string> = {
  critical: 'text-rose-300 bg-rose-500/10',
  warn: 'text-amber-300 bg-amber-500/10',
  info: 'text-slate-400 bg-white/[0.05]',
}

/** Compact one-line badge — used in the wizard and lists. */
export function RiskBadge({ report }: { report: RiskReport }) {
  const v = VERDICT[report.verdict]
  return (
    <span className={`chip border ${v.ring} ${v.text}`} title={report.flags.map((f) => f.label).join(', ') || 'No issues found'}>
      {report.verdict === 'safe' ? '🛡️' : report.verdict === 'caution' ? '⚠️' : '⛔'} {v.label} · {report.score}/100
    </span>
  )
}

/** Full safety report panel. */
export default function RiskReportPanel({ report, compact }: { report: RiskReport; compact?: boolean }) {
  const v = VERDICT[report.verdict]
  return (
    <div className={`rounded-xl border p-3 ${v.ring}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{report.verdict === 'safe' ? '🛡️' : report.verdict === 'caution' ? '⚠️' : '⛔'}</span>
          <div>
            <div className={`text-sm font-bold ${v.text}`}>Safety screen: {v.label}</div>
            <div className="text-[11px] text-slate-500">
              {report.sources.length ? `via ${report.sources.join(' + ')}` : 'no data'}
              {report.buyTaxPct !== null && ` · buy tax ${report.buyTaxPct.toFixed(1)}%`}
              {report.sellTaxPct !== null && ` · sell tax ${report.sellTaxPct.toFixed(1)}%`}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className={`text-xl font-bold tabular-nums ${v.text}`}>{report.score}</div>
          <div className="text-[10px] text-slate-500">/ 100</div>
        </div>
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--border-strong)] dark:bg-white/10">
        <div className={`h-full rounded-full ${v.bar}`} style={{ width: `${report.score}%` }} />
      </div>

      {!report.tradeable && (
        <div className="mt-2 rounded-lg bg-rose-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-rose-200">
          ⛔ Blocked from trading — a critical risk was detected. This cannot be overridden.
        </div>
      )}

      {!compact && report.flags.length > 0 && (
        <ul className="mt-2 space-y-1">
          {report.flags.map((f) => (
            <li key={f.id} className="flex items-start gap-2 text-[11px]">
              <span className={`chip shrink-0 ${SEV[f.severity]}`}>{f.severity}</span>
              <span className="text-slate-300">
                <strong className="text-slate-100">{f.label}.</strong> {f.detail}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!compact && report.positives.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {report.positives.map((p) => (
            <span key={p} className="chip bg-emerald-500/10 text-emerald-300">✓ {p}</span>
          ))}
        </div>
      )}
    </div>
  )
}
