import { Component, type ReactNode } from 'react'

/**
 * Catches render errors. By default shows a full-screen fallback (the app root). Pass a
 * `fallback` to scope it (e.g. one tab/section degrades while the rest of the page lives),
 * and a `resetKey` so the boundary clears its error when that key changes (e.g. the user
 * switches to a different tab).
 */
export default class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode; resetKey?: unknown }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="text-3xl">💥</div>
          <h1 className="text-lg font-bold text-white">Something broke in the UI</h1>
          <p className="max-w-md text-xs text-slate-500">
            Your bots and trades are safe — the engine keeps running and all P&L is persisted server-side.
          </p>
          <pre className="max-w-xl overflow-auto rounded-xl bg-black/40 p-3 text-left text-[11px] text-rose-300">
            {String(this.state.error)}
          </pre>
          <button className="btn-primary" onClick={() => location.reload()}>
            Reload app
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
