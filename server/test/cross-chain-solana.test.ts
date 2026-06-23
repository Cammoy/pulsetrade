// Solana-SOURCE cross-chain (LI.FI) coverage. A Solana source is special: LI.FI's
// /quote returns ONLY a base64-encoded Solana transaction (no EVM `to`/chainId), and
// we sign+send it with the bot's Solana signer. These tests drive the REAL functions
// with a stubbed fetch (LI.FI) + an injected fake RPC connection — no cluster touched.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, VersionedTransaction, TransactionMessage, type Connection } from '@solana/web3.js'
import bs58 from 'bs58'

const { lifiQuote, LIFI_SOLANA_CHAIN } = await import('../src/live.js')
const { executeCrossChainSolana, solanaLiveReady, __test: solTest } = await import('../src/live-solana.js')

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  solTest.reset()
  delete process.env.SOLANA_WALLET_KEY
})

// A Solana-source LI.FI response: estimate + transactionRequest with ONLY `data`
// (a base64 Solana tx). No `to`, no `chainId` — those are EVM-source only.
const lifiSolJson = (b64: string, extra = {}) =>
  JSON.stringify({
    estimate: { toAmount: '1990000', toAmountMin: '1985000', approvalAddress: '', executionDuration: 30, gasCosts: [{ amountUSD: '0.002' }], feeCosts: [{ amountUSD: '0.30' }] },
    transactionRequest: { data: b64 },
    toolDetails: { name: 'Mayan' },
    ...extra,
  })

// Build a real (unsigned) v0 transaction whose fee payer is `kp` — exactly the shape
// LI.FI hands back for a Solana source — and base64 it, so deserialize+sign exercise
// the genuine @solana/web3.js path rather than a hand-rolled stub.
function unsignedSolTxB64(kp: Keypair): string {
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: bs58.encode(new Uint8Array(32).fill(7)), instructions: [] }).compileToV0Message()
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64')
}

const fakeConn = (over: Partial<Record<'send' | 'confirmErr', unknown>> & { onSend?: (raw: Uint8Array) => void } = {}): Connection =>
  ({
    sendRawTransaction: async (raw: Uint8Array) => { over.onSend?.(raw); return 'SOLBRIDGESIG' },
    getLatestBlockhash: async () => ({ blockhash: bs58.encode(new Uint8Array(32).fill(9)), lastValidBlockHeight: 1 }),
    confirmTransaction: async () => ({ value: { err: over.confirmErr ?? null } }),
  }) as unknown as Connection

// ── lifiQuote: Solana-source parsing ─────────────────────────────────────────
test('lifiQuote parses a Solana-SOURCE quote — base64 data, NO EVM `to`', async () => {
  globalThis.fetch = (async () => new Response(lifiSolJson('YWJj'), { status: 200 })) as typeof fetch
  const q = await lifiQuote({ fromChainId: LIFI_SOLANA_CHAIN, toChainId: 8453, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: 2_000_000n, fromAddress: 'SoLfromAddr', toAddress: '0xdest' })
  assert.equal(q.tx.to, undefined, 'a Solana source yields NO EVM `to`')
  assert.equal(q.tx.data, 'YWJj', 'the base64 Solana tx is carried through')
  assert.equal(q.toAmount, '1990000')
  assert.equal(q.toolName, 'Mayan')
  assert.equal(q.durationSec, 30)
  assert.equal(q.feeUsd, '0.30')
})

test('lifiQuote maps a native Solana source to the Solana sentinel + targets the dest wallet', async () => {
  let url = ''
  globalThis.fetch = (async (u: string) => { url = String(u); return new Response(lifiSolJson('YWJj'), { status: 200 }) }) as typeof fetch
  await lifiQuote({ fromChainId: LIFI_SOLANA_CHAIN, toChainId: 8453, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: 2_000_000n, fromAddress: 'SoLfromAddr', toAddress: '0xdest' })
  const p = new URL(url).searchParams
  assert.equal(p.get('fromToken'), '11111111111111111111111111111111', 'Solana native sentinel — NOT the EVM zero address')
  assert.equal(p.get('toToken'), '0xToken')
  assert.equal(p.get('fromChain'), String(LIFI_SOLANA_CHAIN))
  assert.equal(p.get('toChain'), '8453')
  assert.equal(p.get('toAddress'), '0xdest', 'delivery goes to the user wallet on the destination chain')
})

// ── executeCrossChainSolana: full deserialize → sign → send → confirm ─────────
test('executeCrossChainSolana signs the LI.FI base64 Solana tx and sends it', async () => {
  const kp = Keypair.generate()
  process.env.SOLANA_WALLET_KEY = bs58.encode(kp.secretKey)
  globalThis.fetch = (async () => new Response(lifiSolJson(unsignedSolTxB64(kp)), { status: 200 })) as typeof fetch
  let sent: Uint8Array | null = null
  solTest.setConnection(() => fakeConn({ onSend: (raw) => { sent = raw } }))

  const r = await executeCrossChainSolana({ toChainId: 8453, sellToken: 'native', buyToken: '0xToken', amountBaseUnits: 2_000_000n, toAddress: '0x000000000000000000000000000000000000dEaD' })
  assert.equal(r.sig, 'SOLBRIDGESIG')
  assert.equal(r.toolName, 'Mayan')
  assert.equal(r.durationSec, 30)
  assert.equal(r.toAmount, '1990000')
  assert.ok(sent && (sent as Uint8Array).length > 0, 'a signed raw tx was actually broadcast')
})

test('executeCrossChainSolana throws when the bridge tx fails to confirm (never reported as success)', async () => {
  const kp = Keypair.generate()
  process.env.SOLANA_WALLET_KEY = bs58.encode(kp.secretKey)
  globalThis.fetch = (async () => new Response(lifiSolJson(unsignedSolTxB64(kp)), { status: 200 })) as typeof fetch
  solTest.setConnection(() => fakeConn({ confirmErr: { InstructionError: [0, 'Custom'] } }))
  await assert.rejects(
    executeCrossChainSolana({ toChainId: 8453, sellToken: 'native', buyToken: '0xToken', amountBaseUnits: 2_000_000n, toAddress: '0x000000000000000000000000000000000000dEaD' }),
    /solana bridge tx failed/,
  )
})

// ── Gating: no false positives ───────────────────────────────────────────────
test('executeCrossChainSolana refuses with NO signer configured (fail-closed)', async () => {
  delete process.env.SOLANA_WALLET_KEY
  assert.equal(solanaLiveReady(), false)
  await assert.rejects(
    executeCrossChainSolana({ toChainId: 8453, sellToken: 'native', buyToken: '0xT', amountBaseUnits: 1n, toAddress: '0xd' }),
    /signer not configured/,
  )
})

test('executeCrossChainSolana refuses a non-positive amount BEFORE any network call', async () => {
  const kp = Keypair.generate()
  process.env.SOLANA_WALLET_KEY = bs58.encode(kp.secretKey)
  let fetched = false
  globalThis.fetch = (async () => { fetched = true; return new Response('{}', { status: 200 }) }) as typeof fetch
  await assert.rejects(
    executeCrossChainSolana({ toChainId: 8453, sellToken: 'native', buyToken: '0xT', amountBaseUnits: 0n, toAddress: '0xd' }),
    /positive/,
  )
  assert.equal(fetched, false, 'no quote fetched for a zero amount')
})
