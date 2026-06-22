import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCountUp } from './useCountUp'

// Drive requestAnimationFrame manually so the tween is deterministic, and force
// reduce-motion OFF so the rAF path (where the NaN-latch bug lived) actually runs.
let rafCbs: FrameRequestCallback[]
beforeEach(() => {
  rafCbs = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (rafCbs.push(cb), rafCbs.length))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => vi.unstubAllGlobals())

const flush = (ts: number) => {
  const cbs = rafCbs
  rafCbs = []
  cbs.forEach((cb) => cb(ts))
}

describe('useCountUp', () => {
  test('mounts at its value without animating', () => {
    const { result } = renderHook(() => useCountUp(42))
    expect(result.current).toBe(42)
  })

  test('animates toward a changed target and lands exactly on it', () => {
    const { result, rerender } = renderHook(({ v }) => useCountUp(v, 100), { initialProps: { v: 0 } })
    act(() => rerender({ v: 100 }))
    act(() => { flush(0); flush(1000) }) // start frame, then a frame well past the duration
    expect(result.current).toBe(100)
  })

  test('a non-finite target NEVER latches — it stays finite and a later value still converges', () => {
    const { result, rerender } = renderHook(({ v }) => useCountUp(v, 100), { initialProps: { v: 50 } })
    expect(result.current).toBe(50)
    act(() => rerender({ v: NaN })) // schema-less feed hands us a NaN
    expect(Number.isFinite(result.current)).toBe(true) // must not poison the display
    act(() => rerender({ v: 80 }))
    act(() => { flush(0); flush(1000) })
    expect(result.current).toBe(80) // self-healed and converged to the real number
  })
})
