import { useState } from 'react'
import { useStore } from '../store'
import { fmtUsd } from '../format'

export default function AiBot() {
  const { meta, openAi, refresh, mode } = useStore()
  const [network, setNetwork] = useState('base')
  const [token, setToken] = useState('')
  const [risk, setRisk] = useState('balanced')
  const [budget, setBudget] = useState('500')
  const [sweepTo, setSweepTo] = useState<'native' | 'usdt'>('native')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const net = meta?.networks.find((n) => n.id === network)
  if (!meta) return null
  const aiReady = meta.features?.ai

  const launch = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/ai-bot', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network, token: token || net?.tokens[0]?.symbol, risk, budgetUsd: Number(budget), sweepTo }),
      })
      const data = await r.json()
      if (data.error) setErr(data.error)
      else { await refresh(); openAi(false) }
    } catch { setErr('Engine unreachable') }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onClick={() => openAi(false)}>
      <div className="glass w-full max-w-lg border-white/10 bg-[#0b0f1a]/95 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">🤖 AI Trader</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Google Gemini analyses recent price action, RSI and moving averages and decides BUY / SELL / HOLD. Position size scales with the model's confidence and your risk tier.
            </p>
          </div>
          <button className="btn-ghost !px-2.5 !py-1" onClick={() => openAi(false)}>✕</button>
        </div>

        <div className={`mt-3 rounded-xl p-3 text-xs leading-relaxed ${aiReady ? 'bg-emerald-500/10 text-emerald-200' : 'bg-amber-500/10 text-amber-200'}`}>
          {aiReady
            ? '✓ Gemini API key detected — AI decisions are live (refreshed about every 10 minutes per coin, powered by gemini-2.5-flash; the free tier covers this).'
            : 'AI decisions need a Gemini API key (free at aistudio.google.com). Add GEMINI_API_KEY to server/.env and restart. Until then an AI bot will hold.'}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="mb-1 block text-xs text-slate-400">Network</span>
            <select className="input" value={network} onChange={(e) => { setNetwork(e.target.value); setToken('') }}>
              {meta.networks.filter((n) => n.tokens.length > 0).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </label>
          <label className="block"><span className="mb-1 block text-xs text-slate-400">Coin</span>
            <select className="input" value={token} onChange={(e) => setToken(e.target.value)}>
              {net?.tokens.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
            </select>
          </label>
          <label className="block"><span className="mb-1 block text-xs text-slate-400">Risk tolerance</span>
            <select className="input" value={risk} onChange={(e) => setRisk(e.target.value)}>
              {Object.keys(meta.risk).map((r) => <option key={r} value={r}>{meta.risk[r].label}</option>)}
            </select>
          </label>
          <label className="block"><span className="mb-1 block text-xs text-slate-400">Budget ($)</span>
            <input className="input" type="number" min={10} value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
          <label className="block sm:col-span-2"><span className="mb-1 block text-xs text-slate-400">Auto-sell profits to</span>
            <select className="input" value={sweepTo} onChange={(e) => setSweepTo(e.target.value as 'native' | 'usdt')}>
              <option value="native">Native coin ({net?.native.symbol ?? 'ETH'})</option>
              <option value="usdt">USDT (stable)</option>
            </select>
          </label>
        </div>

        {err && <div className="mt-3 rounded-xl bg-rose-500/10 p-2.5 text-xs text-rose-300">{err}</div>}
        <button className="btn-primary mt-4 w-full" disabled={busy || Number(budget) < 10} onClick={launch}>
          {busy ? 'Launching…' : `🤖 Launch AI bot with ${fmtUsd(Number(budget) || 0)}`}
        </button>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
          AI decisions still pass through stop-losses and take profit in {sweepTo === 'usdt' ? 'USDT' : 'the native coin'}. Not financial advice — {mode} mode.
        </p>
      </div>
    </div>
  )
}
