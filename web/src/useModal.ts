import { useEffect } from 'react'

/**
 * Shared chrome for every overlay (modals, sheets, dropdowns):
 *  - locks body scroll while open so the page behind doesn't move on mobile,
 *  - closes on Escape.
 *
 * Call once near the top of a modal component: `useModal(onClose)`.
 * Scroll-lock is reference-counted so nested/stacked overlays don't unlock
 * the page until the last one closes.
 */
export function useModal(onClose?: () => void) {
  useEffect(() => {
    lock()
    return unlock
  }, [])

  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

let openCount = 0
let prevOverflow = ''

function lock() {
  if (openCount === 0) {
    prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  openCount++
}

function unlock() {
  openCount = Math.max(0, openCount - 1)
  if (openCount === 0) document.body.style.overflow = prevOverflow
}
