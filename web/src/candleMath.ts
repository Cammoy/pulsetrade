// Pure data prep for the candlestick chart — no lightweight-charts/canvas import, so it's
// unit-testable. CandleChart maps the `time` (seconds) onto the library's UTCTimestamp.
import type { Ohlc } from './types'

export interface CandlePoint {
  time: number // unix seconds
  open: number
  high: number
  low: number
  close: number
}

/** Map OHLC → candlestick points: seconds, finite-only, de-duped, strictly ascending. Pure. */
export function toCandleSeries(candles: Ohlc[]): CandlePoint[] {
  const seen = new Set<number>()
  return candles
    .filter((c) => [c.t, c.o, c.h, c.l, c.c].every((n) => Number.isFinite(n)))
    .map((c) => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c }))
    .filter((d) => (seen.has(d.time) ? false : (seen.add(d.time), true)))
    .sort((a, b) => a.time - b.time)
}

/** Simple moving average of closes, aligned to candle times (empty until warm). Pure. */
export function smaLine(series: CandlePoint[], period: number): { time: number; value: number }[] {
  if (period < 1 || series.length < period) return []
  const out: { time: number; value: number }[] = []
  let sum = 0
  for (let i = 0; i < series.length; i++) {
    sum += series[i].close
    if (i >= period) sum -= series[i - period].close
    if (i >= period - 1) out.push({ time: series[i].time, value: sum / period })
  }
  return out
}
