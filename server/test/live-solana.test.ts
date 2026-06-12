// Solana live executor: keypair handling, amount math, readiness gating.
// (The Jupiter/RPC round trip itself is exercised only with keys configured.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

const { solanaLiveReady, solanaWalletAddress, executeSolanaSwap, lamportsForUsd, baseUnitsForQty, SOL_MINT } = await import('../src/live-solana.js')

test('lamportsForUsd converts USD at the SOL price (floor, never negative)', () => {
  assert.equal(lamportsForUsd(100, 200), 500_000_000n) // $100 at $200/SOL = 0.5 SOL
  assert.equal(lamportsForUsd(1, 150), BigInt(Math.floor((1 / 150) * 1e9)))
  assert.equal(lamportsForUsd(0, 200), 0n)
  assert.equal(lamportsForUsd(100, 0), 0n)
  assert.equal(lamportsForUsd(-5, 200), 0n)
})

test('baseUnitsForQty respects mint decimals', () => {
  assert.equal(baseUnitsForQty(1.5, 6), 1_500_000n)
  assert.equal(baseUnitsForQty(0.00001, 5), 1n)
  assert.equal(baseUnitsForQty(0, 9), 0n)
})

test('SOL mint constant is the canonical wrapped-SOL mint', () => {
  assert.equal(SOL_MINT, 'So11111111111111111111111111111111111111112')
})

test('readiness gating: no key → not ready, swap refuses, address null', async () => {
  delete process.env.SOLANA_WALLET_KEY
  assert.equal(solanaLiveReady(), false)
  assert.equal(solanaWalletAddress(), null)
  await assert.rejects(
    executeSolanaSwap({ inputMint: SOL_MINT, outputMint: 'X', amountBaseUnits: 1n }),
    /SOLANA_WALLET_KEY/,
  )
})

test('a configured key resolves to its own public address', () => {
  const kp = Keypair.generate()
  process.env.SOLANA_WALLET_KEY = bs58.encode(kp.secretKey)
  assert.equal(solanaLiveReady(), true)
  assert.equal(solanaWalletAddress(), kp.publicKey.toBase58())
  delete process.env.SOLANA_WALLET_KEY
})

test('zero-amount swaps are refused before any network call', async () => {
  const kp = Keypair.generate()
  process.env.SOLANA_WALLET_KEY = bs58.encode(kp.secretKey)
  await assert.rejects(executeSolanaSwap({ inputMint: SOL_MINT, outputMint: 'X', amountBaseUnits: 0n }), /positive/)
  delete process.env.SOLANA_WALLET_KEY
})
