import { memo, useEffect, useRef } from 'react'
import { createChart, ColorType, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import type { Ohlc } from '../types'
import { toCandleSeries, smaLine } from '../candleMath'

/**
 * A real candlestick chart (TradingView lightweight-charts) over OHLC data, with an SMA(20)
 * overlay. Mirrors PriceChart's setup (transparent theme, auto-resize, rebuild only when the
 * data changes). Canvas-rendered, so it's not asserted in jsdom — the pure data prep
 * (candleMath.ts) is unit-tested instead.
 */
function CandleChart({ candles, height = 320 }: { candles: Ohlc[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!ref.current || candles.length === 0) return
    const chart = createChart(ref.current, {
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#64748b', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(148,163,184,0.06)' }, horzLines: { color: 'rgba(148,163,184,0.06)' } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart

    const data = toCandleSeries(candles)
    const series = chart.addCandlestickSeries({
      upColor: '#34d399',
      downColor: '#fb7185',
      borderUpColor: '#34d399',
      borderDownColor: '#fb7185',
      wickUpColor: '#34d399',
      wickDownColor: '#fb7185',
    })
    series.setData(data.map((d) => ({ ...d, time: d.time as UTCTimestamp })))

    const sma = smaLine(data, 20)
    if (sma.length) {
      const ma = chart.addLineSeries({ color: '#818cf8', lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
      ma.setData(sma.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })))
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
  }, [candles, height])

  if (candles.length === 0) return <div className="flex items-center justify-center text-xs text-slate-600" style={{ height }}>loading candles…</div>
  return <div ref={ref} className="w-full" />
}

// Only rebuild when the candle array identity actually changes (parent may re-render often).
export default memo(CandleChart, (a, b) => a.height === b.height && a.candles === b.candles)
