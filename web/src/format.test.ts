import { describe, test, expect } from 'vitest'
import { fmtUsd, fmtSign, fmtPct, fmtPrice, parseAmount, pnlColor } from './format'

// The formatters defend the UI from the schema-less WebSocket feed: a single NaN
// field must never throw inside a card and take down the tree via the ErrorBoundary.
describe('money formatters coerce bad input instead of throwing', () => {
  test('fmtUsd renders non-finite input as $0.00', () => {
    expect(fmtUsd(NaN)).toBe('$0.00')
    expect(fmtUsd(Infinity)).toBe('$0.00')
    expect(fmtUsd(undefined as unknown as number)).toBe('$0.00')
    expect(fmtUsd(1234)).toBe('$1,234') // >= 1000 → whole dollars
    expect(fmtUsd(12.5)).toBe('$12.50')
  })

  test('fmtSign always carries a sign and survives NaN', () => {
    expect(fmtSign(10)).toBe('+$10.00')
    expect(fmtSign(-10)).toBe('-$10.00')
    expect(fmtSign(0)).toBe('+$0.00')
    expect(fmtSign(NaN)).toBe('+$0.00')
  })

  test('fmtPct signs and fixes to 2dp', () => {
    expect(fmtPct(5)).toBe('+5.00%')
    expect(fmtPct(-3.2)).toBe('-3.20%')
    expect(fmtPct(NaN)).toBe('+0.00%')
  })

  test('fmtPrice scales precision by magnitude', () => {
    expect(fmtPrice(1500)).toBe('$1,500')
    expect(fmtPrice(12.34)).toBe('$12.34')
    expect(fmtPrice(0.001234)).toBe('$0.001234')
  })
})

describe('parseAmount stops NaN from slipping past min-guards', () => {
  test('returns a finite number for usable input, null otherwise', () => {
    expect(parseAmount('100')).toBe(100)
    expect(parseAmount('  12.5 ')).toBe(12.5)
    expect(parseAmount(50)).toBe(50)
    expect(parseAmount('')).toBe(null)
    expect(parseAmount('abc')).toBe(null)
    expect(parseAmount(NaN)).toBe(null)
  })
})

describe('pnlColor thresholds', () => {
  test('emerald up, rose down, slate within the dead-band', () => {
    expect(pnlColor(1)).toMatch(/emerald/)
    expect(pnlColor(-1)).toMatch(/rose/)
    expect(pnlColor(0)).toMatch(/slate/)
    expect(pnlColor(0.001)).toMatch(/slate/) // tiny noise reads as flat
  })
})
