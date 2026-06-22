// Swept profit (native coin or USDT) banks per chain+asset in state.vault and can
// be withdrawn to an external address. PAPER withdrawals are simulated (no funds
// move); LIVE withdrawals on the supported EVM chains are REAL on-chain transfers,
// serialized on the same per-chain lane as swaps (one wallet ⇒ one nonce). The
// reserve-then-send order means a crash mid-transfer can never double-spend the
// same profit, and a failed live send refunds the vault.
//
// Extracted from engine.ts: this block only depends on the shared execution
// primitives (live registry / lane FIFO / broadcast / gas reserve) and leaf
// modules — never on engine internals — so there is no import cycle. engine.ts
// re-exports profitVault/listWithdrawals/requestWithdrawal for app.ts, and imports
// creditVault/vaultBalance for the execSell sweep + the __test seam.

import { parseUnits, getAddress } from 'viem'
import { state, flushNow, uid, type Withdrawal } from './store.js'
import { networkById, type Network } from './networks.js'
import { spot, spotStale } from './prices.js'
import { EVM_ADDR, SOL_ADDR } from './validators.js'
import { lamportsForUsd, SOL_MINT } from './live-solana.js'
import { live } from './live-registry.js'
import { runExclusive } from './lanes.js'
import { broadcast } from './broadcast.js'
import { gasReserveMult } from './costs.js'

export type VaultAsset = 'native' | 'usdt'
// Keyed by WORKSPACE too: a paper bot's simulated sweep and a live bot's real sweep
// bank into SEPARATE entries, so paper "profit" can never be paid out as real funds in
// the live workspace (and a live withdrawal only ever debits live-earned balance).
const vaultKey = (network: string, asset: VaultAsset, mode: 'paper' | 'live') => `${network}:${asset}:${mode}`
const VAULT_DUST = 1e-9 // zero out sub-dust qty so float noise never lingers as "withdrawable"

// EVM chains with a live transfer executor (mirrors live.ts CHAINS). Ethereum
// mainnet (chainId 1) is intentionally absent — holdings-only, no executor.
const EVM_LIVE_CHAINS = new Set([8453, 42161, 10, 137, 56])

/** Bank swept profit into the BOT's workspace vault. Internal — the single credit
 *  point is execSell's sweep, which passes bot.mode explicitly. `mode` defaults to the
 *  active workspace (the sensible default for an ad-hoc credit/read). */
export function creditVault(network: string, asset: VaultAsset, qty: number, mode: 'paper' | 'live' = state.settings.mode): void {
  if (!(qty > 0)) return
  const k = vaultKey(network, asset, mode)
  state.vault[k] = (state.vault[k] ?? 0) + qty
}

export const vaultBalance = (network: string, asset: VaultAsset, mode: 'paper' | 'live' = state.settings.mode): number => state.vault[vaultKey(network, asset, mode)] ?? 0

/** CoinGecko id + display symbol + on-chain decimals/address for a vault asset. */
function vaultAssetMeta(net: Network, asset: VaultAsset) {
  return asset === 'usdt'
    ? { cg: net.usdt.cg, symbol: net.usdt.symbol, decimals: net.usdt.decimals, address: net.usdt.address }
    : { cg: net.native.cg, symbol: net.native.symbol, decimals: 18, address: '' } // EVM native is always 18-dp
}

/** Can this chain+asset be withdrawn as a REAL on-chain transfer right now? The
 *  EVM chains with the 0x executor armed, plus Solana once its signer is armed;
 *  everything else is paper-simulated. */
const liveWithdrawable = (net: Network, _asset: VaultAsset): boolean => {
  if (net.tradeable === false) return false
  // A withdrawal is a plain transfer (native/ERC-20), NOT a 0x swap — so it only
  // needs a SIGNER (Turnkey or a raw key), not ZEROX_API_KEY/liveReady(). Gating on
  // liveReady() wrongly marked EVM chains "paper-only" when a Turnkey signer (no 0x
  // trading key) was configured. [withdraw live fix]
  if (net.evm === true) return EVM_LIVE_CHAINS.has(net.chainId) && live.evmSigner() !== null
  if (net.id === 'solana') return live.solanaLiveReady()
  return false
}

function validAddressFor(net: Network, addr: string): boolean {
  // EVM: a MIXED-CASE address must match its EIP-55 checksum exactly, so a live
  // withdrawal can't be sent to a mistyped address (one flipped character → reject).
  // All-lowercase / all-uppercase carry no checksum and are accepted as-is.
  if (net.evm === true) {
    if (!EVM_ADDR.test(addr)) return false
    const body = addr.slice(2)
    if (/[A-F]/.test(body) && /[a-f]/.test(body)) {
      try {
        return getAddress(addr) === addr
      } catch {
        return false
      }
    }
    return true
  }
  if (net.id === 'solana') return SOL_ADDR.test(addr)
  return addr.length > 0 && addr.length <= 200 // paper pseudo-chains (market/icp): any non-empty label
}

/** Banked-profit snapshot for the UI — one row per non-empty vault balance, priced
 *  at the current spot, flagged for whether a live payout is possible. */
export function profitVault() {
  const mode = state.settings.mode // show only the ACTIVE workspace's banked profit
  const rows: { network: string; networkName: string; asset: VaultAsset; symbol: string; qty: number; usdValue: number; liveWithdrawable: boolean }[] = []
  for (const [k, qty] of Object.entries(state.vault)) {
    if (!(qty > VAULT_DUST)) continue
    const [network, asset, kMode] = k.split(':') as [string, VaultAsset, 'paper' | 'live']
    if (kMode !== mode) continue
    const net = networkById(network)
    if (!net || (asset !== 'native' && asset !== 'usdt')) continue
    const m = vaultAssetMeta(net, asset)
    const price = spot(m.cg) ?? (asset === 'usdt' ? 1 : 0)
    rows.push({
      network, networkName: net.name, asset, symbol: m.symbol,
      qty: +qty.toFixed(8), usdValue: +(qty * price).toFixed(2),
      // Only the LIVE workspace can pay out on-chain; paper rows are always simulated.
      liveWithdrawable: mode === 'live' && liveWithdrawable(net, asset),
    })
  }
  return rows.sort((a, b) => b.usdValue - a.usdValue)
}

/** Most-recent withdrawals first (capped) for the history panel — scoped to the ACTIVE
 *  workspace so the live view shows only real payouts and paper only simulations. */
export const listWithdrawals = (): Withdrawal[] =>
  state.withdrawals.filter((w) => w.mode === state.settings.mode).slice(-100).reverse()

/**
 * Withdraw banked profit to an external address. Validates the asset, address and
 * amount against the vault; PAPER (or any non-EVM chain) records a simulation,
 * LIVE on a supported EVM chain executes a real transfer. Returns `{error}` on a
 * validation failure, else the Withdrawal record (its `status` reflects the
 * outcome — `simulated`, `confirmed`, or `failed` with the vault refunded).
 */
export async function requestWithdrawal(input: {
  network?: string
  asset?: string
  amountQty?: number | string
  toAddress?: string
}): Promise<{ error: string } | Withdrawal> {
  const network = String(input.network ?? '')
  const asset: VaultAsset | null = input.asset === 'usdt' ? 'usdt' : input.asset === 'native' ? 'native' : null
  const toAddress = String(input.toAddress ?? '').trim()
  const amountQty = Number(input.amountQty)
  const net = networkById(network)
  if (!net) return { error: 'unknown network' }
  if (!asset) return { error: "asset must be 'native' or 'usdt'" }
  if (!Number.isFinite(amountQty) || amountQty <= 0) return { error: 'amount must be a positive number' }
  if (!validAddressFor(net, toAddress)) return { error: `that doesn't look like a valid ${net.name} address` }

  // A withdrawal only ever touches the ACTIVE workspace's vault — a live payout can
  // never debit (or be inflated by) paper-simulated profit. [vault mode-segregation]
  const mode = state.settings.mode
  const meta = vaultAssetMeta(net, asset)
  const available = vaultBalance(network, asset, mode)
  if (amountQty > available + VAULT_DUST)
    return { error: `only ${+available.toFixed(8)} ${meta.symbol} of banked profit is available to withdraw on ${net.name}` }

  const isLive = mode === 'live'
  const goLive = isLive && liveWithdrawable(net, asset)
  // In LIVE mode never "simulate" moving real money on a chain we can't actually
  // transfer on — refuse instead, leaving the banked profit where it is.
  if (isLive && !goLive)
    return { error: `live profit payouts are supported on the EVM chains (Base, Arbitrum, Optimism, Polygon, BNB) and Solana (once its signer is configured) — ${net.name} isn't available yet. Your banked profit there stays put.` }

  const price = spot(meta.cg) ?? (asset === 'usdt' ? 1 : 0)
  const rec: Withdrawal = {
    id: uid(), ts: Date.now(), network, asset, symbol: meta.symbol,
    amountQty: +amountQty.toFixed(8), amountUsd: +(amountQty * price).toFixed(2),
    toAddress, mode: goLive ? 'live' : 'paper', status: goLive ? 'pending' : 'simulated',
  }

  // Reserve first: debit the vault and record intent BEFORE any send so a crash
  // mid-transfer can never withdraw the same profit twice. A failed live send
  // refunds below.
  const k = vaultKey(network, asset, mode)
  const remaining = Math.max(0, available - amountQty)
  if (remaining <= VAULT_DUST) delete state.vault[k]
  else state.vault[k] = remaining
  state.withdrawals.push(rec)
  if (state.withdrawals.length > 500) state.withdrawals.splice(0, state.withdrawals.length - 500)
  flushNow() // durability: the reservation must survive a crash before we send
  broadcast({ type: 'withdrawal', withdrawal: rec })

  if (!goLive) return rec

  // LIVE: real transfer, serialized on the chain's swap lane (shared wallet/nonce):
  // each EVM chain has its own lane; Solana rides the single 'solana' swap lane.
  const lane = net.id === 'solana' ? 'solana' : `evm:${net.chainId}`
  try {
    const hash = await runExclusive<string>(lane, async () => {
      if (net.id === 'solana') {
        if (asset === 'native') {
          const nativePrice = spot(net.native.cg)
          if (!nativePrice || spotStale()) throw new Error('native price unavailable/stale — refusing to size a live withdrawal')
          const lamports = parseUnits(amountQty.toFixed(9), 9) // SOL = 9 dp
          // Always leave a SOL gas reserve so open positions can still be exited.
          const reserveLamports = lamportsForUsd(gasReserveMult() * net.avgGasUsd, nativePrice)
          const bal = await live.splTokenBalanceBaseUnits(SOL_MINT)
          if (bal < lamports + reserveLamports)
            throw new Error(`insufficient on-chain ${net.native.symbol}: need to keep ~$${(gasReserveMult() * net.avgGasUsd).toFixed(2)} for gas`)
          return live.sendSolNative(toAddress, lamports)
        }
        const amountBaseUnits = parseUnits(amountQty.toFixed(meta.decimals), meta.decimals)
        const bal = await live.splTokenBalanceBaseUnits(meta.address)
        if (bal < amountBaseUnits) throw new Error(`insufficient on-chain ${meta.symbol} balance`)
        return live.sendSplToken(meta.address, toAddress, amountBaseUnits)
      }
      if (asset === 'native') {
        const nativePrice = spot(net.native.cg)
        if (!nativePrice || spotStale()) throw new Error('native price unavailable/stale — refusing to size a live withdrawal')
        const amountWei = parseUnits(amountQty.toFixed(18), 18)
        // Always leave the gas reserve so open positions can still be exited.
        const reserveWei = parseUnits(((gasReserveMult() * net.avgGasUsd) / nativePrice).toFixed(18), 18)
        const bal = await live.nativeBalanceWei(net.chainId)
        if (bal < amountWei + reserveWei)
          throw new Error(`insufficient on-chain ${net.native.symbol}: need to keep ~$${(gasReserveMult() * net.avgGasUsd).toFixed(2)} for gas`)
        return live.sendNative(net.chainId, toAddress, amountWei)
      }
      const amountBaseUnits = parseUnits(amountQty.toFixed(meta.decimals), meta.decimals)
      const bal = await live.tokenBalanceBaseUnits(net.chainId, meta.address)
      if (bal < amountBaseUnits) throw new Error(`insufficient on-chain ${meta.symbol} balance`)
      return live.sendErc20(net.chainId, meta.address, toAddress, amountBaseUnits)
    })
    rec.status = 'confirmed'
    rec.txHash = hash
    flushNow()
    broadcast({ type: 'withdrawal', withdrawal: rec })
    return rec
  } catch (e) {
    // Refund the reservation — the funds never left the wallet.
    state.vault[k] = (state.vault[k] ?? 0) + amountQty
    rec.status = 'failed'
    rec.error = e instanceof Error ? e.message : String(e)
    flushNow()
    broadcast({ type: 'withdrawal', withdrawal: rec })
    return rec
  }
}
