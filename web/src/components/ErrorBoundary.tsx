import { Component, type ReactNode } from 'react'

export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
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
