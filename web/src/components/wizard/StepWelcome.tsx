import type { WizardCtx } from './shared'
import WalletButton from '../WalletButton'

export default function StepWelcome({ w }: { w: WizardCtx }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-white">Welcome 👋 Let's set up a trading bot</h2>
      <p className="text-sm leading-relaxed text-slate-400">
        Connect a wallet to track balances and (later) trade live on-chain. You can also skip this —{' '}
        <strong className="text-slate-200">paper mode</strong> trades with real market data and simulated money, which is the
        recommended way to prove a strategy before risking funds.
      </p>
      <div className="flex items-center gap-3">
        <WalletButton />
        {w.isConnected && <span className="text-xs text-emerald-400">✓ wallet connected</span>}
      </div>
      <div className="rounded-xl bg-indigo-500/10 p-3 text-xs leading-relaxed text-indigo-200">
        Current engine mode: <strong className="uppercase">{w.mode}</strong>. Every profitable exit is automatically swept into the
        chain's native coin (ETH / BNB / POL) — the bot never leaves you holding an illiquid token.
      </div>
    </div>
  )
}
