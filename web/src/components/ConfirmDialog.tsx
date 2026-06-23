import { useEffect, useRef } from 'react'
import { useStore } from '../store'

/**
 * App-wide confirmation dialog — the in-app replacement for blocking native
 * window.confirm(). Built on the HTML5 <dialog> element via showModal(), so it
 * gets focus-trapping, Esc-to-cancel, the top layer and a ::backdrop for free
 * (styled in index.css as `.app-dialog`). Driven by the promise-based
 * store.confirm() API; resolves true on confirm, false on cancel/Esc.
 */
export default function ConfirmDialog() {
  const c = useStore((s) => s.confirmState)
  const resolveConfirm = useStore((s) => s.resolveConfirm)
  const ref = useRef<HTMLDialogElement>(null)

  // Open/close the native dialog in lock-step with the store state.
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (c && !d.open) d.showModal()
    else if (!c && d.open) d.close()
  }, [c])

  const danger = c?.tone === 'danger'

  return (
    <dialog
      ref={ref}
      className="app-dialog"
      // Any close (Esc / programmatic) resolves false; resolveConfirm is idempotent,
      // so a button that already resolved makes this a no-op.
      onClose={() => resolveConfirm(false)}
      onCancel={() => resolveConfirm(false)}
    >
      {c && (
        <div className="animate-sheet w-[min(92vw,27rem)] rounded-2xl border border-white/10 bg-[var(--modal)] p-5 shadow-2xl shadow-black/60 backdrop-blur-xl">
          {c.title && <h2 className="text-[15px] font-bold tracking-tight text-slate-100">{c.title}</h2>}
          {c.body ? (
            <div className={c.title ? 'mt-3' : ''}>{c.body}</div>
          ) : (
            <p className={`whitespace-pre-line text-[13px] leading-relaxed text-slate-400 ${c.title ? 'mt-1.5' : ''}`}>{c.message}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => resolveConfirm(false)} autoFocus={danger} className="btn-ghost !py-2 text-sm">
              {c.cancelLabel}
            </button>
            <button onClick={() => resolveConfirm(true)} autoFocus={!danger} className={`!py-2 text-sm ${danger ? 'btn-danger' : 'btn-primary'}`}>
              {c.confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  )
}
