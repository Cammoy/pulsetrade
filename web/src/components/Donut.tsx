/**
 * Dependency-free SVG donut: each segment is an arc drawn with stroke-dasharray.
 * Shared by the Portfolio allocation cards (defaults) and the HoldingsTracker
 * allocation donut (passes its own size/thickness/cap/gap), so the two render
 * identically to their previous inline copies — just from one source.
 */
export default function Donut({
  segments,
  size = 176,
  thickness = 22,
  className = 'h-full w-full -rotate-90',
  linecap = 'round',
  gap = 2,
  label = 'Allocation breakdown',
}: {
  segments: { color: string; value: number }[]
  size?: number
  thickness?: number
  className?: string
  linecap?: 'round' | 'butt'
  gap?: number
  /** Accessible name for the chart (screen readers) — the legend carries the detail. */
  label?: string
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = (size - thickness) / 2
  const circ = 2 * Math.PI * r
  let acc = 0
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={className} role="img" aria-label={label}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(100,116,139,0.18)" strokeWidth={thickness} />
      {total > 0 &&
        segments
          .filter((s) => s.value > 0)
          .map((s, i) => {
            const len = (s.value / total) * circ
            const dash = Math.max(0.5, len - gap) // small gap between slices
            const node = (
              <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness} strokeLinecap={linecap} strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={-acc} />
            )
            acc += len
            return node
          })}
    </svg>
  )
}
