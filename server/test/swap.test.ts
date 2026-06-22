// Manual-swap executor coverage: the user-facing tokenA→tokenB 0x swap. Drives the
// real functions with a stubbed fetch (0x) + a fake wallet client — no chain touched.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.ZEROX_API_KEY = 'test-key' // headers only; fetch is stubbed
const { swapPrice0x, executeSwapGeneral, lifiQuote, executeCrossChainEvm, LIFI_SOLANA_CHAIN, resolveSlippageBps, SLIPPAGE_BPS_CEILING, __test: liveTest } = await import('../src/live.js')
const { jupiterQuote } = await import('../src/live-solana.js')

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  liveTest.reset()
})

function fakeClient({ receiptStatus = 'success' } = {}) {
  const calls = { writeContract: 0, sendTransaction: 0 }
  return {
    calls,
    wc: {
      account: { address: '0x0000000000000000000000000000000000000abc' },
      chain: { id: 42161 },
      async writeContract() { calls.writeContract++; return '0xapprove' },
      async sendTransaction() { calls.sendTransaction++; return '0xswaptx' },
      async waitForTransactionReceipt() { return { status: receiptStatus } },
    },
  }
}

// The 0x v2 allowance-holder router: both the swap target and the approval spender are
// this one AllowanceHolder address (the executor pins + validates against it). [P1-4]
const AH = '0x0000000000001fF3684f28c67538d4D072C22734'
const priceJson = (extra = {}) => JSON.stringify({ liquidityAvailable: true, buyAmount: '950', minBuyAmount: '940', gas: '210000', totalNetworkFee: '5000', ...extra })
const quoteJson = (extra = {}) => JSON.stringify({ liquidityAvailable: true, buyAmount: '950', transaction: { to: AH, data: '0xdead', value: '0', gas: '210000' }, ...extra })
const AMT = 10n ** 16n

// ── swapPrice0x (indicative preview) ─────────────────────────────────────────
test('swapPrice0x parses the indicative quote (buy/min amounts, gas, allowance flag)', async () => {
  globalThis.fetch = (async () => new Response(priceJson({ issues: { allowance: { spender: '0xS' } } }), { status: 200 })) as typeof fetch
  const q = await swapPrice0x(42161, 'native', '0xToken', AMT)
  assert.equal(q.buyAmount, '950')
  assert.equal(q.minBuyAmount, '940')
  assert.equal(q.gas, '210000')
  assert.equal(q.needsAllowance, true)
})

test('swapPrice0x throws when there is no route / liquidity', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ liquidityAvailable: false }), { status: 200 })) as typeof fetch
  await assert.rejects(swapPrice0x(42161, 'native', '0xToken', AMT), /no liquidity/)
})

// ── executeSwapGeneral (firm execution) ──────────────────────────────────────
test('a NATIVE sell swaps with NO ERC-20 approval (even if the quote lists an allowance issue)', async () => {
  globalThis.fetch = (async () => new Response(quoteJson({ issues: { allowance: { spender: '0xS' } } }), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  const r = await executeSwapGeneral({ chainId: 42161, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: AMT })
  assert.equal(r.hash, '0xswaptx')
  assert.equal(r.buyAmount, '950')
  assert.equal(fake.calls.writeContract, 0, 'native input never approves')
  assert.equal(fake.calls.sendTransaction, 1)
})

test('an ERC-20 sell approves the spender first, then swaps', async () => {
  globalThis.fetch = (async () => new Response(quoteJson({ issues: { allowance: { spender: AH } } }), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  const r = await executeSwapGeneral({ chainId: 42161, sellToken: '0xToken', buyToken: 'native', sellAmountBaseUnits: AMT })
  assert.equal(r.hash, '0xswaptx')
  assert.equal(fake.calls.writeContract, 1, 'one approve before the ERC-20 sell')
  assert.equal(fake.calls.sendTransaction, 1)
})

test('no liquidity throws before any transaction is sent', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ liquidityAvailable: false }), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  await assert.rejects(executeSwapGeneral({ chainId: 42161, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: AMT }), /no liquidity/)
  assert.equal(fake.calls.sendTransaction, 0)
})

test('a reverted receipt throws (a failed swap is never reported as success)', async () => {
  globalThis.fetch = (async () => new Response(quoteJson(), { status: 200 })) as typeof fetch
  liveTest.setClient(async () => fakeClient({ receiptStatus: 'reverted' }).wc)
  await assert.rejects(executeSwapGeneral({ chainId: 42161, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: AMT }), /reverted/)
})

// ── Solana (Jupiter) quote ───────────────────────────────────────────────────
test('jupiterQuote parses out/min amounts + price impact', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ outAmount: '870000', otherAmountThreshold: '861300', priceImpactPct: '0.0023' }), { status: 200 })) as typeof fetch
  const q = await jupiterQuote('So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', AMT)
  assert.equal(q.outAmount, '870000')
  assert.equal(q.minAmount, '861300')
  assert.equal(q.priceImpactPct, '0.0023')
})

test('jupiterQuote throws when there is no route', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'No routes found' }), { status: 200 })) as typeof fetch
  await assert.rejects(jupiterQuote('So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', AMT), /jupiter|no route/i)
})

// ── Cross-chain (LI.FI) quote + execute ──────────────────────────────────────
const lifiJson = (extra = {}) =>
  JSON.stringify({
    estimate: { toAmount: '997500', toAmountMin: '997000', approvalAddress: '0xSpender', executionDuration: 7, gasCosts: [{ amountUSD: '0.0065' }], feeCosts: [{ amountUSD: '0.25' }] },
    transactionRequest: { to: '0xrouter', data: '0xdead', value: '0x0', gasLimit: '0x12762c', chainId: 8453 },
    toolDetails: { name: 'Eco' },
    ...extra,
  })

test('lifiQuote parses the cross-chain estimate + transactionRequest', async () => {
  globalThis.fetch = (async () => new Response(lifiJson(), { status: 200 })) as typeof fetch
  const q = await lifiQuote({ fromChainId: 8453, toChainId: 42161, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: AMT, fromAddress: '0xabc' })
  assert.equal(q.toAmount, '997500')
  assert.equal(q.toAmountMin, '997000')
  assert.equal(q.approvalAddress, '0xSpender')
  assert.equal(q.durationSec, 7)
  assert.equal(q.toolName, 'Eco')
  assert.equal(q.feeUsd, '0.25')
  assert.equal(q.tx.to, '0xrouter')
})

test('lifiQuote throws when no bridge route exists', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'no quote' }), { status: 200 })) as typeof fetch
  await assert.rejects(lifiQuote({ fromChainId: 8453, toChainId: 42161, sellToken: 'native', buyToken: '0xT', sellAmountBaseUnits: AMT, fromAddress: '0xabc' }), /no bridge route/)
})

test('executeCrossChainEvm (native source) bridges with NO approval', async () => {
  globalThis.fetch = (async () => new Response(lifiJson(), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  const r = await executeCrossChainEvm({ fromChainId: 8453, toChainId: 42161, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: AMT })
  assert.equal(r.hash, '0xswaptx')
  assert.equal(r.toolName, 'Eco')
  assert.equal(fake.calls.writeContract, 0, 'native source never approves')
  assert.equal(fake.calls.sendTransaction, 1)
})

test('executeCrossChainEvm (ERC-20 source) approves the bridge spender first', async () => {
  globalThis.fetch = (async () => new Response(lifiJson(), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  await executeCrossChainEvm({ fromChainId: 8453, toChainId: 42161, sellToken: '0xUSDC', buyToken: 'native', sellAmountBaseUnits: AMT })
  assert.equal(fake.calls.writeContract, 1, 'one approve to the bridge spender before the source tx')
  assert.equal(fake.calls.sendTransaction, 1)
})

test('executeCrossChainEvm throws on a reverted source tx (never reported as success)', async () => {
  globalThis.fetch = (async () => new Response(lifiJson(), { status: 200 })) as typeof fetch
  liveTest.setClient(async () => fakeClient({ receiptStatus: 'reverted' }).wc)
  await assert.rejects(executeCrossChainEvm({ fromChainId: 8453, toChainId: 42161, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: AMT }), /reverted/)
})

// ── Slippage hard cap (a user-supplied bps can never authorise a near-total-loss fill) ──
test('SLIPPAGE-CAP: resolveSlippageBps floors invalid/zero to the default and caps at the ceiling', () => {
  assert.equal(SLIPPAGE_BPS_CEILING, 5000)
  assert.equal(resolveSlippageBps(1_000_000), 5000, 'an absurd value is capped at 50%')
  assert.equal(resolveSlippageBps(250), 250, 'a sane value passes through')
  assert.equal(resolveSlippageBps(SLIPPAGE_BPS_CEILING + 1), SLIPPAGE_BPS_CEILING)
  assert.equal(resolveSlippageBps(0), 100, 'zero/invalid → default 1% (env unset in tests)')
  assert.equal(resolveSlippageBps(undefined), 100)
})

test('SLIPPAGE-CAP: an absurd slippageBps is CLAMPED before the live swap (the 0x quote requests the ceiling)', async () => {
  let url = ''
  globalThis.fetch = (async (u: string) => { url = String(u); return new Response(quoteJson(), { status: 200 }) }) as typeof fetch
  liveTest.setClient(async () => fakeClient().wc)
  await executeSwapGeneral({ chainId: 42161, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: AMT, slippageBps: 1_000_000 })
  assert.equal(new URL(url).searchParams.get('slippageBps'), '5000', 'clamped to the 5000-bps ceiling, never 1,000,000')
})

// ── Manual-swap price-impact backstop (thin-pool fill aborts, like the bot path) ──
test('IMPACT-GUARD: a manual EVM swap ABORTS when the quoted output implies impact beyond the ceiling', async () => {
  globalThis.fetch = (async () => new Response(quoteJson(), { status: 200 })) as typeof fetch // buyAmount 950
  liveTest.setClient(async () => fakeClient().wc)
  // fair output 2000, got 950 = 52.5% below fair → well over the 10% default ceiling → abort
  await assert.rejects(
    executeSwapGeneral({ chainId: 42161, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: AMT, fairBuyBaseUnits: 2000n }),
    /price impact .* exceeds/,
  )
})

test('IMPACT-GUARD: a fair fill (got >= fair) passes — no false abort on a liquid pair, and no guard without a fair ref', async () => {
  globalThis.fetch = (async () => new Response(quoteJson(), { status: 200 })) as typeof fetch // buyAmount 950
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  const r = await executeSwapGeneral({ chainId: 42161, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: AMT, fairBuyBaseUnits: 900n }) // 950 >= 900 → 0% impact
  assert.equal(r.hash, '0xswaptx')
  // No fairBuyBaseUnits (a pasted/unpriceable token) → guard is skipped, swap proceeds on slippage alone
  const r2 = await executeSwapGeneral({ chainId: 42161, sellToken: 'native', buyToken: '0xToken', sellAmountBaseUnits: AMT })
  assert.equal(r2.hash, '0xswaptx')
})

test('executeCrossChainEvm bridges an EVM source to a SOLANA destination — the EVM tx still has a `to`, no false guard-trip', async () => {
  // Verified against the live LI.FI API: an EVM SOURCE → Solana DEST quote returns a normal
  // EVM transactionRequest (to = the bridge router on the source chain), NOT a base64 Solana
  // tx. So the `if (!q.tx.to) throw` guard must NOT fire — the source tx signs+sends as usual.
  // (The base64-Solana-tx-no-`to` shape is a Solana-SOURCE thing → executeCrossChainSolana.)
  globalThis.fetch = (async () => new Response(lifiJson(), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  const r = await executeCrossChainEvm({ fromChainId: 8453, toChainId: LIFI_SOLANA_CHAIN, sellToken: 'native', buyToken: '11111111111111111111111111111111', sellAmountBaseUnits: AMT, toAddress: 'GCYdK6nVjjYFD89Gs88QBqjQSFsNB7U51fPbkxYTeWRx' })
  assert.equal(r.hash, '0xswaptx')
  assert.equal(fake.calls.sendTransaction, 1, 'the EVM source tx is sent for an EVM→Solana bridge')
})

test('lifiQuote rejects a non-integer amount (never surfaces a misleading 0 to the UI)', async () => {
  globalThis.fetch = (async () => new Response(lifiJson({ estimate: { toAmount: '1.23e-5', toAmountMin: '1.2e-5', approvalAddress: '0xS', executionDuration: 5, gasCosts: [], feeCosts: [] } }), { status: 200 })) as typeof fetch
  await assert.rejects(lifiQuote({ fromChainId: 8453, toChainId: 42161, sellToken: 'native', buyToken: '0xT', sellAmountBaseUnits: AMT, fromAddress: '0xabc' }), /non-integer amount/)
})
