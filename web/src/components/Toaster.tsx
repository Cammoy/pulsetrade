import { useEffect } from 'react'
import { useStore, type Toast } from '../store'

/** Auto-dismissing toast stack — replaces blocking native alert() calls. */
export default function Toaster() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[68px] z-[70] flex flex-col items-center gap-2 px-3 sm:inset-x-auto sm:right-4 sm:items-end" aria-live="polite" role="status">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  )
}

const TONE: Record<Toast['type'], string> = {
  error: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/15 dark:text-rose-100',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-100',
  info: 'border-slate-200 bg-[var(--menu)] text-slate-700 dark:border-white/10 dark:bg-white/[0.08] dark:text-slate-100',
}
const ICON: Record<Toast['type'], string> = { error: '⚠️', success: '✅', info: 'ℹ️' }

function ToastRow({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast)
  useEffect(() => {
    const id = setTimeout(() => dismiss(toast.id), toast.type === 'error' ? 6000 : 3500)
    return () => clearTimeout(id)
  }, [toast.id, toast.type, dismiss])
  return (
    <button
      onClick={() => dismiss(toast.id)}
      className={`animate-sheet pointer-events-auto flex max-w-md items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm font-medium shadow-xl backdrop-blur-md ${TONE[toast.type]}`}
    >
      <span aria-hidden>{ICON[toast.type]}</span>
      <span className="text-left">{toast.msg}</span>
    </button>
  )
}
