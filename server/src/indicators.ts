export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN
  let s = 0
  for (let i = values.length - period; i < values.length; i++) s += values[i]
  return s / period
}

/** Full EMA series (same length as input, NaN until warm). */
export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = NaN
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      let s = 0
      for (let j = 0; j < period; j++) s += values[j]
      prev = s / period
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k)
    }
    out.push(i >= period - 1 ? prev : NaN)
  }
  return out
}

export const ema = (values: number[], period: number) =>
  values.length >= period ? emaSeries(values, period)[values.length - 1] : NaN

/** Wilder's RSI of the last value. */
export function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return NaN
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgG = gain / period
  let avgL = loss / period
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period
  }
  if (avgL === 0) return 100
  return 100 - 100 / (1 + avgG / avgL)
}

/** Stdev of the last `period` period-over-period returns, in % — a realized-volatility
 *  proxy used to size positions inversely to volatility (risk-targeting). */
export function stdevReturnsPct(values: number[], period: number): number {
  if (values.length < period + 1) return NaN
  const rets: number[] = []
  for (let i = values.length - period; i < values.length; i++) {
    const prev = values[i - 1]
    if (prev > 0) rets.push((values[i] - prev) / prev)
  }
  if (rets.length < 2) return NaN
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1)
  return Math.sqrt(variance) * 100
}

/** Return over the last `period` bars, in % (time-series momentum). NaN until warm. */
export function trailingReturnPct(values: number[], period: number): number {
  if (values.length < period + 1) return NaN
  const past = values[values.length - 1 - period]
  const now = values[values.length - 1]
  return past > 0 ? ((now - past) / past) * 100 : NaN
}
