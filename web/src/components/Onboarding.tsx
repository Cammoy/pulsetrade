import { useState } from 'react'
import { useStore } from '../store'

const STEPS = [
  {
    icon: '⚡',
    title: 'Welcome to PulseTrade',
    body: 'Automated crypto trading bots on 7 networks — five cheap EVM chains plus Solana and the Internet Computer. Bots buy and sell around the clock and take profit in the chain’s native coin or in USDT — your choice — so you’re never left holding a token you can’t sell.',
  },
  {
    icon: '📝',
    title: 'Start in Paper mode',
    body: 'You’re in Paper mode: bots trade with real live prices but simulated money. Prove a strategy is profitable here before risking a cent. Live mode (per-chain wallet keys) executes real swaps via 0x on EVM chains and Jupiter on Solana.',
  },
  {
    icon: '🧙',
    title: 'Launch a bot in under a minute',
    body: 'Click “New Bot” for the guided wizard: pick a network, a coin, a proven strategy (Grid, RSI Mean-Reversion, EMA Momentum or Smart DCA) and a risk tolerance. Run several bots on the same coin at different tolerances and compare their P&L side by side.',
  },
  {
    icon: '💡',
    title: 'Not sure what to trade?',
    body: 'Profit Finder backtests strategies across three scopes — your network’s curated coins, the top-100 market movers, or safety-screened trending pools — and ranks them by profit. One click launches any candidate and opens the bot immediately, already trading.',
  },
  {
    icon: '🐋',
    title: 'Trade with the smart money',
    body: 'Smart Money tracks documented whale wallets (and any you add). Browse each account’s trades and net-flow chart, copy a single position manually, or auto-follow with a budget — every buy the wallet makes spawns a mirror bot that exits when it sells.',
  },
  {
    icon: '🎯',
    title: 'Snipe, compete, and let AI decide',
    body: 'The Sniper shows only verified, sellable, well-distributed new tokens (one-shot or fully automatic). Tournaments pit bots head-to-head for the best return. And the AI Trader lets Gemini call buy/sell/hold, sized by its confidence.',
  },
  {
    icon: '🛡️',
    title: 'Safety first, always',
    body: 'Every bot has stop-losses, every snipe passes a no-override honeypot/rug screen, profits sweep to native or USDT, and the persisted monthly ledger records every trade. Full docs live behind the 📖 button. Crypto is volatile — never trade more than you can afford to lose.',
  },
]

export default function Onboarding() {
  const { openTour, openWizard, openDocs } = useStore()
  const [i, setI] = useState(0)
  const step = STEPS[i]
  const last = i === STEPS.length - 1

  const finish = () => {
    localStorage.setItem('pulsetrade.onboarded', '1')
    openTour(false)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="glass w-full max-w-md border-white/10 bg-[#0b0f1a]/95 p-6 text-center">
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-3xl shadow-lg shadow-indigo-500/30">
          {step.icon}
        </div>
        <h2 className="text-xl font-bold text-white">{step.title}</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-400">{step.body}</p>

        <div className="mt-5 flex items-center justify-center gap-1.5">
          {STEPS.map((_, k) => (
            <button key={k} onClick={() => setI(k)} className={`h-1.5 rounded-full transition-all ${k === i ? 'w-6 bg-indigo-400' : 'w-1.5 bg-white/15'}`} />
          ))}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button className="btn-ghost text-xs" onClick={finish}>Skip</button>
          <div className="flex gap-2">
            {i > 0 && <button className="btn-ghost" onClick={() => setI(i - 1)}>← Back</button>}
            {!last ? (
              <button className="btn-primary" onClick={() => setI(i + 1)}>Next →</button>
            ) : (
              <button className="btn-primary" onClick={() => { finish(); openWizard(true) }}>🚀 Create my first bot</button>
            )}
          </div>
        </div>
        {last && (
          <button className="mt-3 text-[11px] text-slate-500 hover:text-slate-300" onClick={() => { finish(); openDocs(true) }}>
            …or read the full documentation first
          </button>
        )}
      </div>
    </div>
  )
}
