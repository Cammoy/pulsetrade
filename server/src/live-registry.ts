import { liveReady, evmSigner, executeSwap, tokenBalanceBaseUnits, nativeBalanceWei, sendNative, sendErc20, tokenInfo } from './live.js'
import { solanaLiveReady, executeSolanaSwap, splTokenBalanceBaseUnits, sendSolNative, sendSplToken } from './live-solana.js'

// Live executors are indirected through this object so the reconciliation logic
// (engine.ts) and the live-withdrawal path (vault.ts) can be unit-tested with
// injected fakes (no real on-chain round-trips) — both import this SAME object, and
// the test seam (__test.live.sendNative = fake) overwrites the one shared instance.
// In production these are the real 0x / Jupiter executors and balance readers.
export const live = {
  liveReady,
  evmSigner,
  executeSwap,
  tokenBalanceBaseUnits,
  nativeBalanceWei,
  sendNative,
  sendErc20,
  tokenInfo,
  solanaLiveReady,
  executeSolanaSwap,
  splTokenBalanceBaseUnits,
  sendSolNative,
  sendSplToken,
}
