// Hyperliquid L1-action signing (place/cancel orders) — the exact scheme the exchange
// expects, isolated + unit-tested so the live perp executor can be verified on TESTNET
// before it ever touches real funds. Pure crypto + serialization; no network here.
//
// Scheme (from Hyperliquid's signing spec):
//   1. msgpack-encode the action (maps keep insertion order — @msgpack/msgpack matches the
//      Python SDK's packb), then append the nonce as 8-byte big-endian and a vault byte
//      (0x00 = none, or 0x01 ++ 20-byte address). keccak256 of that = the connectionId.
//   2. EIP-712 sign a "phantom agent" { source, connectionId } under the Exchange domain
//      (chainId 1337, zero verifyingContract). source = 'a' on mainnet, 'b' on testnet.
import { keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { encode as msgpackEncode } from '@msgpack/msgpack'

export type Tif = 'Alo' | 'Ioc' | 'Gtc'
export interface OrderWire { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: Tif } } }
export interface OrderAction { type: 'order'; orders: OrderWire[]; grouping: 'na' }

/** nonce → 8-byte big-endian, as Hyperliquid appends it before hashing. */
function nonceBytes(nonce: number): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(nonce), false) // big-endian
  return b
}

/** The action hash (a.k.a. connectionId): keccak256(msgpack(action) ++ nonce ++ vaultByte). */
export function actionHash(action: unknown, nonce: number, vaultAddress?: string | null): `0x${string}` {
  const packed = msgpackEncode(action)
  const nb = nonceBytes(nonce)
  let vault: Uint8Array
  if (vaultAddress) {
    const addr = vaultAddress.toLowerCase().replace(/^0x/, '')
    if (addr.length !== 40) throw new Error('vaultAddress must be a 20-byte hex address')
    vault = new Uint8Array(21)
    vault[0] = 0x01
    for (let i = 0; i < 20; i++) vault[i + 1] = parseInt(addr.slice(i * 2, i * 2 + 2), 16)
  } else {
    vault = new Uint8Array([0x00])
  }
  const all = new Uint8Array(packed.length + nb.length + vault.length)
  all.set(packed, 0)
  all.set(nb, packed.length)
  all.set(vault, packed.length + nb.length)
  return keccak256(all)
}

export interface Signature { r: `0x${string}`; s: `0x${string}`; v: number }

/** EIP-712 sign an L1 action with the agent/API private key. Returns the {r,s,v} the
 *  /exchange endpoint expects. */
export async function signL1Action(opts: {
  privateKey: `0x${string}`
  action: unknown
  nonce: number
  isMainnet: boolean
  vaultAddress?: string | null
}): Promise<Signature> {
  const connectionId = actionHash(opts.action, opts.nonce, opts.vaultAddress)
  const account = privateKeyToAccount(opts.privateKey)
  const sig = await account.signTypedData({
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source: opts.isMainnet ? 'a' : 'b', connectionId },
  })
  return { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16) }
}

/** Drop trailing zeros / decimal point from a fixed-decimals string (Hyperliquid wire form). */
function trim(x: number, decimals: number): string {
  let s = x.toFixed(Math.max(0, decimals))
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

/** Size → wire string: rounded to the asset's szDecimals, no trailing zeros. */
export function formatSize(sz: number, szDecimals: number): string {
  return trim(sz, szDecimals)
}

/** Price → wire string: ≤5 significant figures AND ≤(maxDecimals − szDecimals) decimals
 *  (maxDecimals = 6 for perps, 8 for spot). Integers are always allowed as-is. */
export function formatPrice(px: number, szDecimals: number, isSpot = false): string {
  if (!(px > 0)) throw new Error('price must be positive')
  if (Number.isInteger(px)) return String(px)
  const maxDecimals = (isSpot ? 8 : 6) - szDecimals
  const sigFig = Number(px.toPrecision(5)) // ≤5 significant figures
  const out = trim(sigFig, Math.max(0, maxDecimals))
  // A sub-cent price on a high-szDecimals market can round to "0" here — never post a p:"0" order
  // (the venue would reject it, or worse). Fail fast with a clear message instead. [px-zero]
  if (!(Number(out) > 0)) throw new Error(`price ${px} rounds to 0 at ${Math.max(0, maxDecimals)} decimals — too small for this market`)
  return out
}

/** Build the order action for a single market-ish order (IOC at an aggressive limit). */
export function buildOrderAction(o: { assetIndex: number; isBuy: boolean; px: string; sz: string; reduceOnly?: boolean; tif?: Tif }): OrderAction {
  return {
    type: 'order',
    orders: [{ a: o.assetIndex, b: o.isBuy, p: o.px, s: o.sz, r: o.reduceOnly ?? false, t: { limit: { tif: o.tif ?? 'Ioc' } } }],
    grouping: 'na',
  }
}
