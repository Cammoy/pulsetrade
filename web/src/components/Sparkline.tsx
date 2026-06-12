export default function Sparkline({
  points,
  width = 160,
  height = 40,
  baseline,
}: {
  points: number[]
  width?: number
  height?: number
  baseline?: number
}) {
  if (points.length < 2)
    return (
      <div className="flex items-center text-[11px] text-slate-600" style={{ width, height }}>
        gathering data…
      </div>
    )
  const min = Math.min(...points, baseline ?? Infinity)
  const max = Math.max(...points, baseline ?? -Infinity)
  const span = max - min || 1
  const x = (i: number) => (i / (points.length - 1)) * width
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ')
  const up = points[points.length - 1] >= (baseline ?? points[0])
  const color = up ? '#34d399' : '#fb7185'
  const id = `g${Math.abs(Math.round(points[0] * 100 + points.length))}`
  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {baseline !== undefined && (
        <line x1={0} x2={width} y1={y(baseline)} y2={y(baseline)} stroke="#475569" strokeDasharray="3 3" strokeWidth="1" />
      )}
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
