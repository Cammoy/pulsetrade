// Turnkey-backed signing for live trades. The spending key lives in Turnkey's
// secure infrastructure (TEE) and every signature goes through their API,
// governed by Turnkey Policies — so NO raw private key sits in .env. Activates
// when the TURNKEY_* env vars are set; otherwise live.ts / live-solana.ts fall
// back to the existing raw-key path. The SDKs are dynamically imported so paper
// mode (and the test suite) never load them.
//
// Required env (set in server/.env):
//   TURNKEY_API_PUBLIC_KEY   – API key public key (P-256)
//   TURNKEY_API_PRIVATE_KEY  – API key private key (an API credential, NOT a
//                              spending key — the signing key never leaves Turnkey)
//   TURNKEY_ORGANIZATION_ID  – your org (or sub-org) id
//   TURNKEY_EVM_ADDRESS      – the wallet account address used to sign EVM (0x) txs
//   TURNKEY_SOLANA_ADDRESS   – the wallet account address used to sign Solana txs
//   TURNKEY_API_BASE_URL     – optional, defaults to https://api.turnkey.com

import type { LocalAccount } from 'viem'
import type { VersionedTransaction } from '@solana/web3.js'
import type { TurnkeyApiClient } from '@turnkey/sdk-server'
import type { TurnkeySigner as TkSigner } from '@turnkey/solana'
import { EVM_ADDR, SOL_ADDR } from './validators.js'

const ORG = () => process.env.TURNKEY_ORGANIZATION_ID || ''
const BASE_URL = () => process.env.TURNKEY_API_BASE_URL || 'https://api.turnkey.com'

/** Turnkey API credentials present (org + API keypair). */
export const turnkeyConfigured = () =>
  Boolean(process.env.TURNKEY_API_PUBLIC_KEY && process.env.TURNKEY_API_PRIVATE_KEY && process.env.TURNKEY_ORGANIZATION_ID)
// "ready" must mean a signature can ACTUALLY be produced — validate the address FORMAT,
// not just its presence, so /api/meta never reports ready:true for a typo'd address that
// would then fail at the first signature.
/** Ready to sign EVM (0x) txs via Turnkey — also needs a VALID EVM signing address. */
export const turnkeyEvmReady = () => turnkeyConfigured() && EVM_ADDR.test(process.env.TURNKEY_EVM_ADDRESS ?? '')
/** Ready to sign Solana (Jupiter) txs via Turnkey — also needs a VALID Solana address. */
export const turnkeySolReady = () => turnkeyConfigured() && SOL_ADDR.test(process.env.TURNKEY_SOLANA_ADDRESS ?? '')

export const turnkeyEvmAddress = () => process.env.TURNKEY_EVM_ADDRESS || null
export const turnkeySolAddress = () => process.env.TURNKEY_SOLANA_ADDRESS || null

// Lazily-built Turnkey API client (the dynamic import keeps the SDK out of the
// paper-mode module graph and the test suite).
let _apiClient: TurnkeyApiClient | null = null
async function apiClient(): Promise<TurnkeyApiClient> {
  if (_apiClient) return _apiClient
  const { Turnkey } = await import('@turnkey/sdk-server')
  _apiClient = new Turnkey({
    apiBaseUrl: BASE_URL(),
    apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
    apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
    defaultOrganizationId: ORG(),
  }).apiClient()
  return _apiClient
}

let _evmAccount: LocalAccount | null = null
let _evmKey = ''
/** A viem account backed by Turnkey — a drop-in replacement for
 *  privateKeyToAccount(): signing happens via Turnkey's API. Cached per (org,addr). */
export async function turnkeyEvmAccount(): Promise<LocalAccount> {
  const signWith = process.env.TURNKEY_EVM_ADDRESS!
  const key = `${ORG()}:${signWith}`
  if (_evmAccount && _evmKey === key) return _evmAccount
  const { createAccount } = await import('@turnkey/viem')
  _evmAccount = await createAccount({ client: await apiClient(), organizationId: ORG(), signWith })
  _evmKey = key
  return _evmAccount
}

let _solSigner: TkSigner | null = null
async function solSigner(): Promise<TkSigner> {
  if (_solSigner) return _solSigner
  const { TurnkeySigner } = await import('@turnkey/solana')
  _solSigner = new TurnkeySigner({ organizationId: ORG(), client: await apiClient() })
  return _solSigner
}

/** Sign a Solana VersionedTransaction IN PLACE via Turnkey (replaces tx.sign([kp])). */
export async function turnkeySignSolana(tx: VersionedTransaction): Promise<void> {
  await (await solSigner()).addSignature(tx, process.env.TURNKEY_SOLANA_ADDRESS!)
}
