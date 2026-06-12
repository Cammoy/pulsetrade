import { memo, useEffect, useRef } from 'react'
import { createChart, ColorType, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import type { Trade } from '../types'

function PriceChart({
  candles,
  trades,
  height = 280,
}: {
  candles: { t: number; c: number }[]
  trades?: Trade[]
  height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!ref.current || candles.length === 0) return
    const chart = createChart(ref.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#64748b',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(148,163,184,0.06)' },
        horzLines: { color: 'rgba(148,163,184,0.06)' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { labelBackgroundColor: '#334155' }, horzLine: { labelBackgroundColor: '#334155' } },
    })
    chartRef.current = chart
    const series = chart.addAreaSeries({
      lineColor: '#818cf8',
      topColor: 'rgba(129,140,248,0.25)',
      bottomColor: 'rgba(129,140,248,0)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
    })
    // De-dupe & sort timestamps (lightweight-charts requires strict ascending)
    const seen = new Set<number>()
    const data = candles
      .map((c) => ({ time: Math.floor(c.t / 1000) as UTCTimestamp, value: c.c }))
      .filter((d) => (seen.has(d.time) ? false : (seen.add(d.time), true)))
      .sort((a, b) => (a.time as number) - (b.time as number))
    series.setData(data)

    if (trades?.length) {
      const t0 = data[0].time as number
      series.setMarkers(
        trades
          .filter((t) => Math.floor(t.ts / 1000) >= t0)
          .sort((a, b) => a.ts - b.ts)
          .map((t) => ({
            time: Math.floor(t.ts / 1000) as UTCTimestamp,
            position: t.side === 'buy' ? ('belowBar' as const) : ('aboveBar' as const),
            color: t.side === 'buy' ? '#34d399' : '#fb7185',
            shape: t.side === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const),
            text: t.side === 'buy' ? 'B' : 'S',
          })),
      )
    }
    chart.timeScale().fitContent()

    const onResize = () => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth })
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
    }
  }, [candles, trades, height])

  if (candles.length === 0)
    return <div className="flex h-40 items-center justify-center text-xs text-slate-600">loading market data…</div>
  return <div ref={ref} className="w-full" />
}

// The parent re-renders every engine tick with fresh array identities; only
// rebuild the chart when the data actually changed, not on every snapshot.
export default memo(PriceChart, (a, b) => {
  if (a.height !== b.height || a.candles !== b.candles) return false
  const at = a.trades ?? []
  const bt = b.trades ?? []
  return at.length === bt.length && at[0]?.id === bt[0]?.id
})
