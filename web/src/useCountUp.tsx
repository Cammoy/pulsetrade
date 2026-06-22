import { useEffect, useRef, useState } from 'react'

/** True when the user asked for reduced motion (safe in any environment). */
function reduceMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Coerce to a finite number — the engine feed is schema-less, so a NaN/Infinity must
 *  never reach the tween (it would latch the displayed value forever). */
const finite = (n: number) => (Number.isFinite(n) ? n : 0)

/**
 * Tween a number from its current displayed value to `target` with an ease-out, via
 * requestAnimationFrame. Interrupt-safe — a new target animates from wherever it is now —
 * never stores a non-finite value (so it can't wedge at $0.00), reacts to a live
 * prefers-reduced-motion toggle, and does NOT animate on first mount (so live data
 * doesn't count up from 0 on every page load); only on changes.
 */
export function useCountUp(target: number, duration = 650): number {
  const safe = finite(target)
  const [val, setVal] = useState(safe)
  const valRef = useRef(safe)
  valRef.current = val
  const targetRef = useRef(safe)
  targetRef.current = safe
  const raf = useRef<number | null>(null)

  useEffect(() => {
    if (reduceMotion() || !Number.isFinite(target)) {
      setVal(safe) // snap to the finite target; NEVER write NaN/Infinity into state
      return
    }
    const from = finite(valRef.current) // self-heal if a prior frame ever poisoned the ref
    if (Math.abs(from - target) < 1e-9) {
      setVal(target) // already there — land exactly (and heal a previously-wedged value)
      return
    }
    let start: number | null = null
    const ease = (t: number) => 1 - Math.pow(1 - t, 3) // ease-out cubic
    const tick = (ts: number) => {
      if (start === null) start = ts
      const p = Math.min(1, (ts - start) / duration)
      setVal(from + (target - from) * ease(p))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [target, duration, safe])

  // Live-react to an OS reduce-motion toggle: stop any in-flight tween and snap to the value.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => {
      if (mq.matches) {
        if (raf.current) {
          cancelAnimationFrame(raf.current)
          raf.current = null
        }
        setVal(targetRef.current)
      }
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return val
}

/** A number that smoothly counts to its value, formatted with `format`. */
export default function CountUp({ value, format, className, title }: { value: number; format: (n: number) => string; className?: string; title?: string }) {
  const v = useCountUp(value)
  return (
    <span className={className} title={title}>
      {format(v)}
    </span>
  )
}
