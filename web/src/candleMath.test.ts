import { describe, test, expect } from 'vitest'
import { toCandleSeries, smaLine } from './candleMath'
import type { Ohlc } from './types'

const c = (t: number, o: number, h: number, l: number, cl: number): Ohlc => ({ t, o, h, l, c: cl })

describe('toCandleSeries', () => {
  test('maps ms→seconds, de-dupes, sorts ascending, drops non-finite', () => {
    const out = toCandleSeries([
      c(3000, 3, 4, 2, 3.5),
      c(1000, 1, 2, 0.5, 1.8),
      c(1000, 1, 2, 0.5, 1.9), // duplicate timestamp → dropped (first kept after sort)
      c(2000, 2, 3, 1.5, 2.6),
      { t: 4000, o: NaN, h: 1, l: 1, c: 1 }, // non-finite → dropped
    ])
    expect(out.map((d) => d.time)).toEqual([1, 2, 3])
    expect(out[0]).toEqual({ time: 1, open: 1, high: 2, low: 0.5, close: 1.8 })
    expect(out[2].close).toBe(3.5)
  })

  test('empty input → empty', () => {
    expect(toCandleSeries([])).toEqual([])
  })
})

describe('smaLine', () => {
  test('computes the moving average aligned to candle times, warm after `period`', () => {
    const series = [c(1000, 0, 0, 0, 10), c(2000, 0, 0, 0, 20), c(3000, 0, 0, 0, 30), c(4000, 0, 0, 0, 40)].map((x) => ({ time: Math.floor(x.t / 1000), open: x.o, high: x.h, low: x.l, close: x.c }))
    const out = smaLine(series, 2)
    // first point warm at index 1: (10+20)/2=15, then 25, then 35
    expect(out.map((d) => d.value)).toEqual([15, 25, 35])
    expect(out[0].time).toBe(2)
  })

  test('returns empty when fewer candles than the period', () => {
    expect(smaLine([{ time: 1, open: 1, high: 1, low: 1, close: 1 }], 20)).toEqual([])
  })
})
