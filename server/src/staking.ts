// Read-only STAKING positions across ecosystems, for the portfolio's Staking view:
//  · ICP   — NNS neurons, by neuron ID (get_neuron_info on the governance canister — PUBLIC,
//            no identity needed; listing a principal's neurons would require auth, hence IDs).
//  · Solana — native stake accounts delegated to validators, auto-detected from the wallet
//            address (the withdrawer authority), read straight from the chain.
//  · EVM   — liquid-staking tokens held on Ethereum (stETH / wstETH / rETH / cbETH).
// Everything is priced via getSpotPrices and aggregated. No keys, no writes — pure reads.
import { createPublicClient, http, erc20Abi, isAddress, type Hex } from 'viem'
import { mainnet } from 'viem/chains'
import { Connection, PublicKey, StakeProgram } from '@solana/web3.js'
import { getSpotPrices } from './prices.js'
import { rpcUrlFor } from './live.js'
import { networkById } from './networks.js'

export interface StakingPosition {
  source: 'icp' | 'solana' | 'evm-liquid'
  network: string
  networkName: string
  color: string
  symbol: string
  label: string // "Neuron 1234…", "Validator 7x…", "Lido stETH"
  detail: string // "Not dissolving · 8.0y delay", "Active · 12.3 SOL", "Liquid · Lido"
  status: string // the state word on its own: "Dissolving" | "Active" | "Deactivating" | "Liquid" | …
  amount: number // staked amount in the asset
  cg: string // CoinGecko id for pricing
  priceUsd: number | null
  usd: number
  // Unlock timeline — set ONLY for positions actively counting down to liquid
  // (ICP dissolving neurons, Solana deactivating stake). null otherwise.
  dissolveDays: number | null // exact remaining time until liquid, in days (fractional)
  unlockDate: string | null // ISO date it becomes liquid
  // Estimated staking yield. apy is a fraction (0.069 = 6.9%); rewards are filled after pricing.
  apy: number | null
  rewardPerYearAsset?: number | null // amount × apy
  rewardPerYearUsd?: number | null // usd × apy
  rewardUntilUnlockUsd?: number | null // usd × apy × (dissolveDays/365) — only when there's an unlock window
}
export interface Staking {
  totalUsd: number
  positions: StakingPosition[]
  byNetwork: { id: string; name: string; color: string; usd: number }[]
  errors: string[]
}

const colorOf = (id: string) => networkById(id)?.color ?? '#64748b'
const nameOf = (id: string) => networkById(id)?.name ?? id
const SOL_SENTINEL_MAX = '18446744073709551615' // u64::MAX = "no deactivation epoch" (stake is active)

const DAY_SEC = 86_400
const YEAR_SEC = 365 * DAY_SEC
// Estimated nominal staking yields (clearly surfaced as "est." in the UI). Network rates drift;
// these are reasonable current-era figures used only to PROJECT rewards, never a guarantee.
export const SOLANA_STAKING_APY = 0.069 // ~6.9% nominal SOL staking
const ICP_NNS_BASE_APY = 0.06 // base NNS voting-reward rate before the dissolve-delay bonus
const ICP_MIN_VOTING_DELAY_SEC = 182 * DAY_SEC // a neuron must keep ≥6mo dissolve delay to earn
const SOL_SLOT_SEC_FALLBACK = 0.45 // used only if a live perf sample isn't available

/** Estimated NNS APY: voting rewards scale with the dissolve delay (1× at the 6-month
 *  minimum up to 2× at the 8-year maximum). Below the voting minimum a neuron earns nothing. */
export function icpApy(dissolveDelaySec: number): number {
  if (!(dissolveDelaySec >= ICP_MIN_VOTING_DELAY_SEC)) return 0
  const bonus = 1 + Math.min(dissolveDelaySec / (8 * YEAR_SEC), 1) // 1.0 … 2.0
  return ICP_NNS_BASE_APY * bonus
}

/** Seconds until a deactivating Solana stake becomes inactive: it stays active through the END
 *  of its deactivation epoch. Uses the live slot time so the estimate tracks current network speed. */
export function solanaUnlockSeconds(
  epoch: number, slotIndex: number, slotsInEpoch: number, deactivationEpoch: number, slotSec: number,
): number {
  const slotsLeftThisEpoch = Math.max(0, slotsInEpoch - slotIndex)
  const fullEpochsAfter = Math.max(0, deactivationEpoch - epoch)
  return (slotsLeftThisEpoch + fullEpochsAfter * slotsInEpoch) * slotSec
}

/** Projected staking rewards for a position from its APY + value (+ unlock window if any). */
export function stakingRewards(amount: number, usd: number, apy: number | null, dissolveDays: number | null) {
  if (apy == null) return { rewardPerYearAsset: null, rewardPerYearUsd: null, rewardUntilUnlockUsd: null }
  const rewardPerYearAsset = +(amount * apy).toFixed(6)
  const rewardPerYearUsd = usd > 0 ? +(usd * apy).toFixed(2) : null
  const rewardUntilUnlockUsd = usd > 0 && dissolveDays != null ? +(usd * apy * (dissolveDays / 365)).toFixed(2) : null
  return { rewardPerYearAsset, rewardPerYearUsd, rewardUntilUnlockUsd }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => { const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms); t.unref?.() })])
}

// Ethereum liquid-staking tokens (the staked value is balance × the token's own price). These
// are LIQUID (no unlock window) but accrue yield continuously — `apy` is a current-era estimate.
const LSTS = [
  { symbol: 'stETH', label: 'Lido stETH', address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', cg: 'staked-ether', decimals: 18, provider: 'Lido', apy: 0.029 },
  { symbol: 'wstETH', label: 'Lido wstETH', address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', cg: 'wrapped-steth', decimals: 18, provider: 'Lido', apy: 0.029 },
  { symbol: 'rETH', label: 'Rocket Pool rETH', address: '0xae78736Cd615f374D3085123A210448E74Fc6393', cg: 'rocket-pool-eth', decimals: 18, provider: 'Rocket Pool', apy: 0.027 },
  { symbol: 'cbETH', label: 'Coinbase cbETH', address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', cg: 'coinbase-wrapped-staked-eth', decimals: 18, provider: 'Coinbase', apy: 0.027 },
] as const

const NEURON_STATE: Record<number, string> = { 1: 'Not dissolving', 2: 'Dissolving', 3: 'Dissolved', 4: 'Spawning' }

/** ICP NNS neurons by id — public `get_neuron_info` on the governance canister. */
async function readIcpNeurons(neuronIds: string[]): Promise<StakingPosition[]> {
  const out: StakingPosition[] = []
  const { HttpAgent, Actor } = await import('@dfinity/agent')
  const agent = await HttpAgent.create({ host: process.env.ICP_GATEWAY_URL || 'https://icp-api.io' })
  // Minimal candid: just the fields we surface. Candid skips the record fields we omit.
  const idl = ({ IDL }: { IDL: any }) => {
    const NeuronInfo = IDL.Record({ dissolve_delay_seconds: IDL.Nat64, state: IDL.Int32, stake_e8s: IDL.Nat64, age_seconds: IDL.Nat64, voting_power: IDL.Nat64 })
    const GovernanceError = IDL.Record({ error_message: IDL.Text, error_type: IDL.Int32 })
    return IDL.Service({ get_neuron_info: IDL.Func([IDL.Nat64], [IDL.Variant({ Ok: NeuronInfo, Err: GovernanceError })], ['query']) })
  }
  const actor = Actor.createActor(idl, { agent, canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai' })
  await Promise.all(
    neuronIds.map(async (raw) => {
      const id = raw.trim()
      if (!/^\d+$/.test(id)) return
      try {
        const res = (await withTimeout(actor.get_neuron_info(BigInt(id)) as Promise<{ Ok?: { dissolve_delay_seconds: bigint; state: number; stake_e8s: bigint; voting_power: bigint } }>, 12_000, `ICP neuron ${id}`))
        if (!('Ok' in res) || !res.Ok) return // Err (e.g. neuron not found) — silently skip
        const n = res.Ok
        const amount = Number(n.stake_e8s) / 1e8
        const delaySec = Number(n.dissolve_delay_seconds)
        const delayY = delaySec / YEAR_SEC
        const status = NEURON_STATE[n.state] ?? 'Neuron'
        // A DISSOLVING neuron's dissolve_delay_seconds counts down to liquid → real unlock date.
        // A locked (Not dissolving) neuron's delay only starts counting once you begin dissolving.
        const dissolving = n.state === 2
        const dissolveDays = dissolving ? delaySec / DAY_SEC : null
        const unlockDate = dissolving ? new Date(Date.now() + delaySec * 1000).toISOString() : null
        out.push({
          source: 'icp', network: 'icp', networkName: nameOf('icp'), color: colorOf('icp'),
          symbol: 'ICP', label: `Neuron ${id.slice(0, 6)}…${id.slice(-4)}`,
          detail: `${status} · ${delayY.toFixed(1)}y delay`,
          status, dissolveDays, unlockDate, apy: icpApy(delaySec),
          amount, cg: 'internet-computer', priceUsd: null, usd: 0,
        })
      } catch {
        /* unreadable neuron — skip rather than fail the whole view */
      }
    }),
  )
  return out
}

/** Solana native stake accounts the wallet can withdraw (delegated to a validator). */
async function readSolanaStaking(address: string): Promise<StakingPosition[]> {
  const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed')
  const owner = new PublicKey(address)
  // Authorized.withdrawer sits at byte offset 44 in the stake account (4 enum + 8 rent +
  // 32 staker). Filter by it to find every stake account this wallet controls.
  const [accts, epochInfo, perf] = await withTimeout(
    Promise.all([
      conn.getParsedProgramAccounts(StakeProgram.programId, { filters: [{ memcmp: { offset: 44, bytes: owner.toBase58() } }] }),
      conn.getEpochInfo('confirmed'),
      conn.getRecentPerformanceSamples(1).catch(() => []), // live slot time for an accurate unlock estimate
    ]),
    18_000,
    'Solana staking',
  )
  const epoch = epochInfo.epoch
  // Real slot time from a recent sample (samplePeriodSecs ÷ numSlots), else a sane fallback.
  const sample = perf[0]
  const slotSec = sample && sample.numSlots > 0 ? sample.samplePeriodSecs / sample.numSlots : SOL_SLOT_SEC_FALLBACK
  const out: StakingPosition[] = []
  for (const { account } of accts) {
    const info = (account.data as { parsed?: { info?: { stake?: { delegation?: { stake?: string; voter?: string; activationEpoch?: string; deactivationEpoch?: string } } } } }).parsed?.info
    const del = info?.stake?.delegation
    if (!del?.stake) continue
    const amount = Number(del.stake) / 1e9
    if (!(amount > 0)) continue
    const deact = del.deactivationEpoch ?? SOL_SENTINEL_MAX
    const act = Number(del.activationEpoch ?? '0')
    const deactivating = deact !== SOL_SENTINEL_MAX
    const state = deactivating ? 'Deactivating' : act >= epoch ? 'Activating' : 'Active'
    // A deactivating stake stays active through the END of its deactivation epoch → real unlock date.
    let dissolveDays: number | null = null
    let unlockDate: string | null = null
    if (deactivating) {
      const secs = solanaUnlockSeconds(epoch, epochInfo.slotIndex, epochInfo.slotsInEpoch, Number(deact), slotSec)
      dissolveDays = secs / DAY_SEC
      unlockDate = new Date(Date.now() + secs * 1000).toISOString()
    }
    const voter = del.voter ?? ''
    out.push({
      source: 'solana', network: 'solana', networkName: nameOf('solana'), color: colorOf('solana'),
      symbol: 'SOL', label: voter ? `Validator ${voter.slice(0, 4)}…${voter.slice(-4)}` : 'Stake account',
      detail: `${state} · ${amount.toFixed(2)} SOL`, status: state, dissolveDays, unlockDate,
      // Activating stake isn't earning yet; active + deactivating both earn until inactive.
      apy: state === 'Activating' ? null : SOLANA_STAKING_APY,
      amount, cg: 'solana', priceUsd: null, usd: 0,
    })
  }
  return out
}

/** Ethereum liquid-staking-token balances (stETH / wstETH / rETH / cbETH). */
async function readEvmLiquidStaking(address: string): Promise<StakingPosition[]> {
  // Same dependable default the portfolio reader uses (viem's cloudflare default is rate-limited).
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrlFor(1) ?? 'https://ethereum-rpc.publicnode.com') })
  const balances = await withTimeout(
    client.multicall({ contracts: LSTS.map((t) => ({ address: t.address as Hex, abi: erc20Abi, functionName: 'balanceOf' as const, args: [address as Hex] })), allowFailure: true }),
    12_000,
    'EVM liquid staking',
  )
  const out: StakingPosition[] = []
  LSTS.forEach((t, i) => {
    const r = balances[i]
    if (r.status === 'success' && typeof r.result === 'bigint' && r.result > 0n) {
      out.push({
        source: 'evm-liquid', network: 'ethereum', networkName: nameOf('ethereum'), color: colorOf('ethereum'),
        symbol: t.symbol, label: t.label, detail: `Liquid · ${t.provider}`,
        status: 'Liquid', dissolveDays: null, unlockDate: null, apy: t.apy,
        amount: Number(r.result) / 10 ** t.decimals, cg: t.cg, priceUsd: null, usd: 0,
      })
    }
  })
  return out
}

/** Aggregate all requested staking sources into a single priced, read-only view. */
export async function readStaking(input: { evm?: string; solana?: string; neuronIds?: string[] }): Promise<Staking> {
  const errors: string[] = []
  const positions: StakingPosition[] = []

  const tasks: Promise<void>[] = []
  if (input.neuronIds?.length) tasks.push(readIcpNeurons(input.neuronIds).then((p) => { positions.push(...p) }).catch((e) => { errors.push(`ICP: ${msg(e)}`) }))
  if (input.solana) tasks.push(readSolanaStaking(input.solana).then((p) => { positions.push(...p) }).catch((e) => { errors.push(`Solana: ${msg(e)}`) }))
  if (input.evm && isAddress(input.evm)) tasks.push(readEvmLiquidStaking(input.evm).then((p) => { positions.push(...p) }).catch((e) => { errors.push(`Ethereum: ${msg(e)}`) }))
  await Promise.all(tasks)

  // Price once, then total + per-network rollup.
  const ids = [...new Set(positions.map((p) => p.cg))]
  let prices = new Map<string, number>()
  if (ids.length) { try { prices = await getSpotPrices(ids) } catch { /* unpriced → $0 */ } }
  for (const p of positions) {
    p.priceUsd = prices.get(p.cg) ?? null
    p.usd = p.priceUsd ? +(p.amount * p.priceUsd).toFixed(2) : 0
    Object.assign(p, stakingRewards(p.amount, p.usd, p.apy, p.dissolveDays))
  }
  positions.sort((a, b) => b.usd - a.usd)

  const byNetwork = new Map<string, { id: string; name: string; color: string; usd: number }>()
  for (const p of positions) {
    const e = byNetwork.get(p.network) ?? { id: p.network, name: p.networkName, color: p.color, usd: 0 }
    e.usd += p.usd
    byNetwork.set(p.network, e)
  }
  return {
    totalUsd: +positions.reduce((s, p) => s + p.usd, 0).toFixed(2),
    positions,
    byNetwork: [...byNetwork.values()].sort((a, b) => b.usd - a.usd),
    errors,
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message.slice(0, 80) : 'read failed')
