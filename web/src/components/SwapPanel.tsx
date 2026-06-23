import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useModal } from '../useModal'
import { parseAmount, timeAgo } from '../format'
import { explorerTxUrl } from '../explorer'
import { iconUrl } from '../icon'
import NetworkSelect from './NetworkSelect'
import type { Network } from '../types'

interface SwapToken { symbol: string; address: string; decimals: number; name?: string; logoURI?: string; custom?: boolean }
const nativeDecimals = (net: Network) => (net.id === 'solana' ? 9 : 18) // SOL = 9, EVM = 18

// The "popular" set always shown first: native, USDT, the curated majors.
const tokensFor = (net: Network): SwapToken[] => [
  { symbol: net.native.symbol, address: 'native', decimals: nativeDecimals(net) },
  ...(net.usdt ? [{ symbol: net.usdt.symbol, address: net.usdt.address, decimals: net.usdt.decimals }] : []),
  ...net.tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals })),
]

// Comprehensive per-network token list (server → CoinGecko), fetched once + cached.
const listCache: Record<string, SwapToken[]> = {}
async function loadTokenList(networkId: string): Promise<SwapToken[]> {
  if (listCache[networkId]) return listCache[networkId]
  try {
    const d = await (await fetch(`/api/swap/tokens/${networkId}`)).json()
    const list: SwapToken[] = (d.tokens ?? []).map((t: { symbol: string; address: string; decimals: number; name?: string; logoURI?: string }) => ({
      symbol: t.symbol, address: t.address, decimals: t.decimals, name: t.name, logoURI: t.logoURI,
    }))
    listCache[networkId] = list
    return list
  } catch {
    return []
  }
}

const truncAddr = (a: string) => (a === 'native' ? '' : a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

// human ⇄ base units (decimal-string math — token amounts overflow Number)
const toBaseUnits = (human: string, decimals: number): bigint | null => {
  const n = human.trim()
  if (n === '' || n === '.' || !/^\d*\.?\d*$/.test(n)) return null
  const [int, frac = ''] = n.split('.')
  const f = (frac + '0'.repeat(decimals)).slice(0, decimals)
  try { return BigInt(int || '0') * 10n ** BigInt(decimals) + BigInt(f || '0') } catch { return null }
}
const fromBaseUnits = (base: string, decimals: number, dp = 6): string => {
  try {
    const b = BigInt(base)
    const d = 10n ** BigInt(decimals)
    const frac = (b % d).toString().padStart(decimals, '0').slice(0, dp).replace(/0+$/, '')
    return frac ? `${b / d}.${frac}` : `${b / d}`
  } catch { return '0' }
}

/** Round token logo with a letter fallback. */
function TokenLogo({ tok, size = 20 }: { tok: SwapToken; size?: number }) {
  const [bad, setBad] = useState(false)
  if (tok.logoURI && !bad) return <img src={iconUrl(tok.logoURI)} alt="" width={size} height={size} loading="lazy" className="shrink-0 rounded-full" onError={() => setBad(true)} />
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-slate-300" style={{ width: size, height: size }}>
      {(tok.symbol || '?').charAt(0).toUpperCase()}
    </span>
  )
}

export default function SwapPanel() {
  const { meta, notify, confirm, openSwap, swaps, refresh } = useStore()
  useModal(() => openSwap(false))

  const [tab, setTab] = useState<'swap' | 'history'>('swap')
  // EVM chains (0x) + Solana (Jupiter); holdings-only chains are excluded.
  const swapNets = useMemo(() => (meta?.networks ?? []).filter((n) => n.tradeable !== false && (n.evm !== false || n.id === 'solana')), [meta])
  const [network, setNetwork] = useState('base') // source (you pay)
  const [buyNetwork, setBuyNetwork] = useState('base') // destination (you receive)
  const net = swapNets.find((n) => n.id === network) ?? swapNets[0]
  const buyNet = swapNets.find((n) => n.id === buyNetwork) ?? net

  const isSolana = net?.id === 'solana'
  const crossChain = !!net && !!buyNet && net.id !== buyNet.id
  // Any network → any network: same chain = 0x/Jupiter; different = a LI.FI cross-chain
  // bridge (EVM↔EVM, EVM↔Solana, Solana↔EVM all supported).
  const buyNetOptions = swapNets

  const [sellTok, setSellTok] = useState<SwapToken | null>(null)
  const [buyTok, setBuyTok] = useState<SwapToken | null>(null)
  const [custom, setCustom] = useState<(SwapToken & { net: string })[]>([])

  const [amount, setAmount] = useState('')
  const [slip, setSlip] = useState('1')
  const [bal, setBal] = useState<string | null>(null)
  const [quote, setQuote] = useState<{ buyAmount: string; minBuyAmount: string; totalNetworkFeeWei?: string | null; priceImpactPct?: string; crossChain?: boolean; durationSec?: number; toolName?: string; gasUsd?: string | null; feeUsd?: string | null } | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  // Token-picker overlay
  const [picking, setPicking] = useState<null | 'sell' | 'buy'>(null)
  const [tokenQuery, setTokenQuery] = useState('')
  const [pickerList, setPickerList] = useState<SwapToken[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteAddr, setPasteAddr] = useState('')
  const [pasteBusy, setPasteBusy] = useState(false)

  // Same-chain needs the source signer; cross-chain needs the source signer AND a configured
  // wallet on the DESTINATION chain to receive into — so we never offer a swap that can't land.
  const chainReady = (id?: string) => ((id === 'solana' ? meta?.live?.solana?.ready : meta?.live?.evm?.ready) ?? false)
  const liveOk = crossChain ? chainReady(net?.id) && chainReady(buyNet?.id) : chainReady(net?.id)
  const sellBase = sellTok ? toBaseUnits(amount, sellTok.decimals) : null
  const insufficient = bal !== null && sellBase !== null && sellBase > BigInt(bal)
  const samePair = !crossChain && !!sellTok && !!buyTok && sellTok.address === buyTok.address

  // A flip() swaps both networks + tokens at once. The network-change reset effects below
  // would otherwise clobber the swapped tokens back to defaults — these flags let flip()
  // tell them "the tokens are already correct, skip this one reset".
  const skipReset = useRef({ sell: false, buy: false })
  const pickReq = useRef(0) // request id so a superseded async token-list load is dropped
  // Default the sell/buy tokens when the source/destination network changes.
  useEffect(() => {
    if (skipReset.current.sell) { skipReset.current.sell = false; return }
    if (net) setSellTok({ symbol: net.native.symbol, address: 'native', decimals: nativeDecimals(net) })
  }, [network]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (skipReset.current.buy) { skipReset.current.buy = false; return }
    if (buyNet) setBuyTok(buyNet.usdt ? { symbol: buyNet.usdt.symbol, address: buyNet.usdt.address, decimals: buyNet.usdt.decimals } : { symbol: buyNet.native.symbol, address: 'native', decimals: nativeDecimals(buyNet) })
  }, [buyNetwork]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!net || !sellTok) return setBal(null)
    let off = false
    setBal(null)
    fetch(`/api/swap/balance/${net.id}/${sellTok.address}`)
      .then((r) => r.json())
      .then((d) => { if (!off && d.balanceBaseUnits) setBal(d.balanceBaseUnits) })
      .catch(() => {})
    return () => { off = true }
  }, [network, sellTok?.address]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setQuote(null)
    setErr(null)
    setDone(null)
    if (!net || !buyNet || !sellTok || !buyTok || !sellBase || sellBase <= 0n || samePair) return
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      setQuoting(true)
      try {
        const qs = new URLSearchParams({ network: net.id, sellToken: sellTok.address, buyToken: buyTok.address, sellAmount: sellBase.toString(), slippageBps: String(Math.round((parseAmount(slip) ?? 1) * 100)) })
        if (crossChain) qs.set('toNetwork', buyNet.id)
        const d = await (await fetch(`/api/swap/quote?${qs}`, { signal: ctl.signal })).json()
        if (d.error) setErr(d.error)
        else setQuote(d)
      } catch {
        if (!ctl.signal.aborted) setErr('quote failed')
      }
      setQuoting(false)
    }, 400)
    return () => { clearTimeout(t); ctl.abort() }
  }, [network, buyNetwork, sellTok?.address, buyTok?.address, amount, slip]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!meta || !net || !buyNet) return null

  const recv = quote && buyTok ? fromBaseUnits(quote.buyAmount, buyTok.decimals) : ''
  const minRecv = quote && buyTok ? fromBaseUnits(quote.minBuyAmount, buyTok.decimals) : ''
  const fee = quote?.totalNetworkFeeWei ? fromBaseUnits(quote.totalNetworkFeeWei, nativeDecimals(net), 6) : null
  const impact = quote?.priceImpactPct != null && Number.isFinite(Number(quote.priceImpactPct)) ? (Number(quote.priceImpactPct) * 100).toFixed(2) : null
  const rate = quote && amount && Number(amount) > 0 ? (Number(recv) / Number(amount)).toPrecision(6) : null

  const flip = () => {
    if (crossChain) {
      // Swapping the networks fires the reset effects — tell them to keep our swapped tokens.
      skipReset.current = { sell: true, buy: true }
      setNetwork(buyNetwork); setBuyNetwork(network)
    }
    const s = sellTok, b = buyTok
    setSellTok(b); setBuyTok(s); setAmount('')
  }
  const setMax = () => { if (bal && sellTok) setAmount(fromBaseUnits(bal, sellTok.decimals, sellTok.decimals)) }

  const openPicker = async (which: 'sell' | 'buy') => {
    const n = which === 'sell' ? net : buyNet
    const req = ++pickReq.current // monotonic id so a superseded (re-opened on another net) load is dropped
    setPicking(which); setTokenQuery(''); setPasteMode(false); setPasteAddr('')
    const popular = [...tokensFor(n), ...custom.filter((c) => c.net === n.id)]
    setPickerList(popular)
    setPickerLoading(true)
    const full = await loadTokenList(n.id)
    if (pickReq.current !== req) return // a newer openPicker (different side/network) superseded this one
    const seen = new Set(popular.map((t) => t.address.toLowerCase()))
    setPickerList([...popular, ...full.filter((t) => !seen.has(t.address.toLowerCase()))])
    setPickerLoading(false)
  }

  const selectToken = (tok: SwapToken) => {
    if (picking === 'sell') setSellTok(tok)
    else setBuyTok(tok)
    setPicking(null)
  }

  const addCustom = async () => {
    if (!picking) return
    const n = picking === 'sell' ? net : buyNet
    const addr = pasteAddr.trim()
    const re = n.id === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/
    if (!re.test(addr)) return setErr(`that is not a valid ${n.id === 'solana' ? 'Solana mint' : 'token'} address`)
    setPasteBusy(true)
    setErr(null)
    try {
      const d = await (await fetch(`/api/swap/token/${n.id}/${addr}`)).json()
      if (d.error) { setErr(d.error); setPasteBusy(false); return }
      if (!d.tradeable) { setErr(`⚠ ${d.symbol || 'that token'} failed the safety screen (${d.riskReport?.verdict ?? 'unsafe'}) — not added`); setPasteBusy(false); return }
      const tk: SwapToken & { net: string } = { symbol: d.symbol, address: d.address, decimals: d.decimals, custom: true, net: n.id }
      setCustom((c) => [...c.filter((x) => !(x.net === n.id && x.address.toLowerCase() === addr.toLowerCase())), tk])
      selectToken(tk)
    } catch {
      setErr('could not read that token on-chain')
    }
    setPasteBusy(false)
  }

  const execute = async () => {
    if (!sellTok || !buyTok || !sellBase) return
    const ok = await confirm({
      title: crossChain ? 'Confirm cross-chain swap' : 'Confirm swap',
      body: (
        <div className="mt-1 space-y-2 text-[13px] text-slate-300">
          <p>This sends a <strong className="text-rose-300">real on-chain swap</strong> from your wallet — it is <strong>not</strong> paper-simulated.{crossChain && <> It <strong>bridges across chains</strong> and settles in ~{Math.max(1, Math.round((quote?.durationSec ?? 60) / 60))} min.</>}</p>
          <div className="space-y-1 rounded-lg bg-white/[0.04] p-2.5">
            <div className="flex justify-between"><span className="text-slate-500">You pay</span><strong>{amount} {sellTok.symbol} <span className="font-normal capitalize text-slate-500">on {net.id}</span></strong></div>
            <div className="flex justify-between"><span className="text-slate-500">You receive ≈</span><strong className="text-emerald-300">{recv} {buyTok.symbol} <span className="font-normal capitalize text-emerald-300">on {buyNet.id}</span></strong></div>
            <div className="flex justify-between"><span className="text-slate-500">Minimum ({slip || 1}% slippage)</span><span>{minRecv} {buyTok.symbol}</span></div>
            {crossChain && quote?.toolName && <div className="flex justify-between"><span className="text-slate-500">Bridge</span><span>{quote.toolName}</span></div>}
          </div>
        </div>
      ),
      confirmLabel: crossChain ? 'Bridge & swap' : 'Swap',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    setErr(null)
    try {
      const d = await (
        await fetch('/api/swap/execute', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            network: net.id, toNetwork: crossChain ? buyNet.id : undefined,
            sellToken: sellTok.address, buyToken: buyTok.address, sellAmount: sellBase.toString(), slippageBps: Math.round((parseAmount(slip) ?? 1) * 100),
            sellSymbol: sellTok.symbol, buySymbol: buyTok.symbol, sellDisplay: amount, buyDisplay: recv,
          }),
        })
      ).json()
      if (d.error) setErr(d.error)
      else { setDone(d.txHash); notify(crossChain ? 'Bridge swap submitted — settling on the destination chain' : 'Swap confirmed on-chain', 'success'); refresh().catch(() => {}) }
    } catch {
      setErr('swap failed — engine unreachable')
    }
    setBusy(false)
  }

  // Compact token-select button (opens the searchable picker).
  const tokenButton = (which: 'sell' | 'buy', tok: SwapToken | null) => (
    <button onClick={() => openPicker(which)} className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.06] py-1.5 pl-2 pr-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/[0.1]">
      {tok && <TokenLogo tok={tok} />}
      {tok?.symbol ?? 'Select'}
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
    </button>
  )

  const canSwap = liveOk && !!sellBase && sellBase > 0n && !samePair && !!quote && !insufficient && !busy

  const q = tokenQuery.trim().toLowerCase()
  const filtered = (q
    ? pickerList.filter((t) => t.symbol.toLowerCase().includes(q) || (t.name ?? '').toLowerCase().includes(q) || t.address.toLowerCase().includes(q))
    : pickerList
  ).slice(0, 80)

  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-3" onClick={() => openSwap(false)}>
      <div className="glass animate-sheet pb-safe max-h-[94vh] w-full max-w-md overflow-auto !rounded-b-none border-white/10 bg-[var(--modal)] p-5 sm:!rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">{picking ? `Select token · ${(picking === 'sell' ? net : buyNet).id}` : '🔄 Swap'}</h2>
          <button className="text-slate-400 hover:text-white" onClick={() => (picking ? setPicking(null) : openSwap(false))} aria-label="Close">{picking ? '←' : '✕'}</button>
        </div>

        {picking ? (
          /* ── Searchable token picker ──────────────────────────────────── */
          <div>
            {pasteMode ? (
              <div className="rounded-xl border border-indigo-400/30 bg-indigo-500/[0.06] p-3">
                <div className="mb-1 text-[11px] font-semibold text-indigo-200">Paste a {(picking === 'sell' ? net : buyNet).id === 'solana' ? 'mint' : 'token'} address</div>
                <input className="input text-sm" placeholder={(picking === 'sell' ? net : buyNet).id === 'solana' ? 'Solana mint…' : '0x…'} value={pasteAddr} onChange={(e) => setPasteAddr(e.target.value)} autoFocus />
                {err && <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{err}</div>}
                <div className="mt-2 flex gap-2">
                  <button className="btn-ghost flex-1 !py-1.5 text-xs" onClick={() => { setPasteMode(false); setErr(null) }}>Back</button>
                  <button className="btn-primary flex-1 !py-1.5 text-xs" disabled={pasteBusy} onClick={addCustom}>{pasteBusy ? 'Screening…' : 'Add token'}</button>
                </div>
              </div>
            ) : (
              <>
                <input className="input mb-2 text-sm" placeholder="Search name, symbol or paste address…" value={tokenQuery} onChange={(e) => setTokenQuery(e.target.value)} autoFocus />
                <button className="mb-2 w-full rounded-lg border border-dashed border-white/15 py-2 text-xs font-medium text-indigo-300 hover:bg-white/[0.03]" onClick={() => { setPasteMode(true); setErr(null) }}>＋ Paste a custom address</button>
                <div className="max-h-[52vh] space-y-0.5 overflow-auto">
                  {filtered.map((t) => (
                    <button key={t.address} onClick={() => selectToken(t)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.05]">
                      <TokenLogo tok={t} size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm font-semibold text-white">{t.symbol}{t.custom && <span className="rounded bg-amber-500/15 px-1 text-[9px] font-bold text-amber-300">CUSTOM</span>}</div>
                        <div className="truncate text-[11px] text-slate-500">{t.name ?? t.symbol}{truncAddr(t.address) && <span className="ml-1 font-mono text-slate-600">{truncAddr(t.address)}</span>}</div>
                      </div>
                    </button>
                  ))}
                  {pickerLoading && <div className="px-2 py-3 text-xs text-slate-500">Loading the full token list…</div>}
                  {!pickerLoading && filtered.length === 0 && <div className="px-2 py-3 text-xs text-slate-500">No match. Paste the token address above to add it.</div>}
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            {/* tabs */}
            <div className="seg-track mb-4 flex p-0.5">
              {(['swap', 'history'] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-lg py-1.5 text-xs font-semibold capitalize transition-colors ${tab === t ? 'seg-active' : 'text-slate-400'}`}>
                  {t === 'history' ? `History${swaps.length ? ` · ${swaps.length}` : ''}` : 'Swap'}
                </button>
              ))}
            </div>

            {tab === 'history' ? (
              swaps.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">No swaps yet. Your completed swaps will appear here.</p>
              ) : (
                <div className="space-y-2">
                  {swaps.map((s) => (
                    <div key={s.id} className="rounded-xl bg-white/[0.03] p-3 text-[13px]">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-100">{s.sellAmount} {s.sellSymbol} <span className="text-slate-500">→</span> {s.buyAmount} {s.buySymbol}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${s.mode === 'live' ? 'bg-rose-500/20 text-rose-300' : 'bg-slate-500/20 text-slate-400'}`}>{s.mode}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                        <span className="capitalize">{s.toNetwork ? `${s.network} → ${s.toNetwork}${s.bridge ? ` · ${s.bridge}` : ''}` : s.network} · {timeAgo(s.ts)}</span>
                        {s.txHash && explorerTxUrl(s.network, s.txHash) && <a className="text-indigo-300 hover:underline" href={explorerTxUrl(s.network, s.txHash)!} target="_blank" rel="noopener noreferrer">tx ↗</a>}
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <>
                <p className="mb-3 text-xs leading-relaxed text-slate-400">
                  Swap any token — same chain via <strong className="text-slate-200">0x</strong> / <strong className="text-slate-200">Jupiter</strong>, or <strong className="text-slate-200">cross-chain</strong> (EVM↔EVM, EVM↔Solana) via <strong className="text-slate-200">LI.FI</strong>, signed by your wallet. A <strong className="text-rose-300">real swap</strong> (not paper). Any token is reachable — search the full list or paste an address.
                </p>

                {!liveOk && (() => {
                  // Name exactly the chain(s) that aren't armed. Cross-chain needs BOTH the source
                  // signer and a destination wallet, so list whichever side(s) are missing.
                  const notReady = [...new Set((crossChain ? [net, buyNet] : [net])
                    .filter((n) => !chainReady(n?.id))
                    .map((n) => (n?.id === 'solana' ? 'Solana' : 'EVM')))]
                  const needsZerox = notReady.includes('EVM')
                  return (
                    <div className="mb-3 rounded-xl border border-amber-400/40 bg-amber-500/[0.08] p-2.5 text-xs text-amber-200">
                      {notReady.join(' + ')} live execution isn’t configured — add the signer{needsZerox ? ' + ZEROX_API_KEY' : ''}{crossChain ? ' (both chains must be live to bridge)' : ''} to enable swaps. Quotes still work.
                    </div>
                  )
                })()}

                <div className="relative space-y-1">
                  {/* You pay */}
                  <div className="rounded-xl bg-white/[0.03] p-3">
                    <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-400">
                      <span className="flex items-center gap-1.5">From
                        <NetworkSelect className="input !w-auto !py-0.5 !px-1.5 text-[11px]" value={network} onChange={setNetwork} networks={swapNets} label="From network" />
                      </span>
                      <span>
                        Balance: {bal !== null && sellTok ? fromBaseUnits(bal, sellTok.decimals, 4) : '—'}{' '}
                        {bal !== null && <button className="font-semibold text-indigo-300 hover:underline" onClick={setMax}>Max</button>}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input className="input flex-1 !border-0 !bg-transparent !px-0 text-xl font-bold tabular-nums" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} />
                      {tokenButton('sell', sellTok)}
                    </div>
                  </div>
                  <button onClick={flip} className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/10 bg-[var(--bg-2)] p-1.5 text-slate-300 transition-transform active:rotate-180" aria-label="Flip">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 4v13M7 17l-3-3M17 20V7M17 7l3 3" /></svg>
                  </button>
                  {/* You receive */}
                  <div className="rounded-xl bg-white/[0.03] p-3">
                    <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-400">
                      <span className="flex items-center gap-1.5">To
                        <NetworkSelect className="input !w-auto !py-0.5 !px-1.5 text-[11px]" value={buyNetwork} onChange={setBuyNetwork} networks={buyNetOptions} label="To network" />
                      </span>
                      {crossChain && <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-bold text-indigo-300">CROSS-CHAIN</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 truncate text-xl font-bold tabular-nums text-slate-100">{quoting ? '…' : recv || '0.0'}</div>
                      {tokenButton('buy', buyTok)}
                    </div>
                  </div>
                </div>

                {quote && (
                  <div className="mt-3 space-y-1 rounded-xl bg-white/[0.03] p-3 text-[12px] text-slate-400">
                    {rate && <div className="flex justify-between"><span>Rate</span><span className="tabular-nums text-slate-200">1 {sellTok?.symbol} ≈ {rate} {buyTok?.symbol}</span></div>}
                    <div className="flex justify-between"><span>Min received</span><span className="tabular-nums text-slate-200">{minRecv} {buyTok?.symbol}</span></div>
                    {crossChain ? (
                      <>
                        {quote.toolName && <div className="flex justify-between"><span>Bridge</span><span className="text-slate-200">{quote.toolName}</span></div>}
                        {quote.durationSec != null && <div className="flex justify-between"><span>Est. time</span><span className="tabular-nums text-slate-200">~{quote.durationSec < 90 ? `${quote.durationSec}s` : `${Math.round(quote.durationSec / 60)} min`}</span></div>}
                        {(quote.gasUsd || quote.feeUsd) && <div className="flex justify-between"><span>Bridge + gas fee ≈</span><span className="tabular-nums text-slate-200">${(Number(quote.gasUsd ?? 0) + Number(quote.feeUsd ?? 0)).toFixed(2)}</span></div>}
                      </>
                    ) : (
                      <>
                        {impact && <div className="flex justify-between"><span>Price impact</span><span className={`tabular-nums ${Number(impact) > 3 ? 'text-amber-300' : 'text-slate-200'}`}>{impact}%</span></div>}
                        {fee && <div className="flex justify-between"><span>Network fee ≈</span><span className="tabular-nums text-slate-200">{fee} {net.native.symbol}</span></div>}
                      </>
                    )}
                  </div>
                )}

                <label className="mt-3 flex items-center justify-between text-[12px] text-slate-400">
                  <span>Max slippage</span>
                  <span className="flex items-center gap-1">
                    <input className="input !w-16 !py-1 text-right text-sm" inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} />%
                  </span>
                </label>

                {samePair && <div className="mt-3 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-300">Pick two different tokens.</div>}
                {insufficient && <div className="mt-3 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">Insufficient {sellTok?.symbol} balance.</div>}
                {err && <div className="mt-3 rounded-lg bg-rose-500/10 p-2.5 text-xs text-rose-300">{err}</div>}

                {done ? (
                  <div className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.07] p-3 text-sm text-emerald-200">
                    ✓ {crossChain ? 'Bridge swap submitted — settling on the destination chain.' : 'Swap confirmed.'}{' '}
                    {done && explorerTxUrl(net.id, done) && <a className="font-semibold underline" href={explorerTxUrl(net.id, done)!} target="_blank" rel="noopener noreferrer">View source tx →</a>}
                    <button className="btn-ghost mt-2 w-full !py-1.5 text-xs" onClick={() => { setDone(null); setAmount('') }}>Swap again</button>
                  </div>
                ) : (
                  <button className="btn-primary mt-3 w-full" disabled={!canSwap} onClick={execute}>
                    {busy ? (crossChain ? 'Bridging…' : 'Swapping…') : samePair ? 'Pick two different tokens' : !sellBase || sellBase <= 0n ? 'Enter an amount' : !liveOk ? 'Live swaps not configured' : quoting ? 'Quoting…' : !quote ? 'No quote' : crossChain ? `Bridge ${sellTok?.symbol} → ${buyTok?.symbol}` : `Swap ${sellTok?.symbol} → ${buyTok?.symbol}`}
                  </button>
                )}
                <p className="mt-2 text-[10px] leading-relaxed text-slate-600">Real on-chain swaps move funds immediately and can’t be undone.{crossChain && ' Cross-chain swaps bridge across networks and settle in seconds–minutes.'} Double-check the amount and the “minimum received”.</p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
