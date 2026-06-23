// H3 (LIVE-2): the on-chain executors are the literal money-movers, yet the 29
// existing live tests inject fakes at the ENGINE seam — the executor internals
// (0x quote handling, allowance, revert guard; Jupiter's entry-only price-impact
// guard) had zero direct coverage. These drive the real executors with a fake
// wallet client (0x) and a stubbed fetch (Jupiter), so no chain is touched.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

process.env.ZEROX_API_KEY = 'test-key' // headers only; fetch is stubbed
const { executeSwap, tokenBalanceBaseUnits, rpcUrlFor, __test: liveTest } = await import('../src/live.js')
const { executeSolanaSwap, SOL_MINT } = await import('../src/live-solana.js')

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  liveTest.reset()
  delete process.env.SOLANA_WALLET_KEY
  delete process.env.MAX_PRICE_IMPACT_PCT
})

// ── 0x (EVM) executor ────────────────────────────────────────────────────────

/** A fake viem wallet client that records the calls (and their args) the executor makes. */
function fakeClient({ receiptStatus = 'success', balance = 0n } = {}) {
  const calls = { writeContract: 0, sendTransaction: 0, waits: 0, readContract: 0 }
  const args: { approve?: any; send?: any } = {}
  const wc = {
    account: { address: '0x0000000000000000000000000000000000000abc' },
    chain: { id: 42161 },
    async readContract() { calls.readContract++; return balance },
    async writeContract(a: any) { calls.writeContract++; args.approve = a; return '0xapprove' },
    async sendTransaction(a: any) { calls.sendTransaction++; args.send = a; return '0xswap' },
    async waitForTransactionReceipt() { calls.waits++; return { status: receiptStatus } },
  }
  return { wc, calls, args }
}

// 0x v2 allowance-holder router — both swap target and approval spender are this one
// AllowanceHolder address (executeSwap pins + validates against it). [P1-4]
const AH = '0x0000000000001fF3684f28c67538d4D072C22734'
const okQuote = (extra = {}) =>
  JSON.stringify({ liquidityAvailable: true, transaction: { to: AH, data: '0xdead', value: '0', gas: '210000' }, ...extra })

const buy = { chainId: 42161, tokenAddress: '0xToken', side: 'buy' as const, sellAmountBaseUnits: 10n ** 16n }
const sell = { chainId: 42161, tokenAddress: '0xToken', side: 'sell' as const, sellAmountBaseUnits: 10n ** 16n }

test('0x: a non-OK quote response throws (never sends a tx blind)', async () => {
  globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch
  liveTest.setClient(async () => fakeClient().wc)
  await assert.rejects(executeSwap(buy), /0x quote failed/)
})

test('0x: liquidityAvailable=false throws before any transaction', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ liquidityAvailable: false }), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  await assert.rejects(executeSwap(buy), /no liquidity/)
  assert.equal(fake.calls.sendTransaction, 0, 'no swap attempted')
})

test('0x: a BUY sends the swap with NO token approval', async () => {
  globalThis.fetch = (async () => new Response(okQuote(), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  const hash = await executeSwap(buy)
  assert.equal(hash, '0xswap')
  assert.equal(fake.calls.writeContract, 0, 'buys spend native — no ERC-20 approve')
  assert.equal(fake.calls.sendTransaction, 1)
})

test('0x: a SELL needing allowance approves the spender first, then swaps', async () => {
  globalThis.fetch = (async () => new Response(okQuote({ issues: { allowance: { spender: AH } } }), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  const hash = await executeSwap(sell)
  assert.equal(hash, '0xswap')
  assert.equal(fake.calls.writeContract, 1, 'one approve before the sell')
  assert.equal(fake.calls.sendTransaction, 1)
})

test('0x: a reverted receipt throws (never reports a failed swap as success)', async () => {
  globalThis.fetch = (async () => new Response(okQuote(), { status: 200 })) as typeof fetch
  liveTest.setClient(async () => fakeClient({ receiptStatus: 'reverted' }).wc)
  await assert.rejects(executeSwap(buy), /reverted/)
})

test('0x: tokenBalanceBaseUnits reads the on-chain balance via the client', async () => {
  liveTest.setClient(async () => fakeClient({ balance: 123_456n }).wc)
  assert.equal(await tokenBalanceBaseUnits(42161, '0xToken'), 123_456n)
})

test('0x: a BUY whose quoted out is far below fair is ABORTED (thin-route impact guard)', async () => {
  // fair expects 1000 tokens; the route only offers 700 → 30% impact > 10% ceiling.
  globalThis.fetch = (async () => new Response(okQuote({ buyAmount: '700' }), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  await assert.rejects(executeSwap({ ...buy, fairBuyBaseUnits: 1000n }), /price impact .*exceeds/)
  assert.equal(fake.calls.sendTransaction, 0, 'no swap on a thin route')
})

test('0x: a BUY within the impact ceiling PASSES', async () => {
  globalThis.fetch = (async () => new Response(okQuote({ buyAmount: '960' }), { status: 200 })) as typeof fetch // 4% impact
  liveTest.setClient(async () => fakeClient().wc)
  assert.equal(await executeSwap({ ...buy, fairBuyBaseUnits: 1000n }), '0xswap')
})

test('0x: a favorable BUY (more out than fair) always passes the impact guard', async () => {
  globalThis.fetch = (async () => new Response(okQuote({ buyAmount: '1200' }), { status: 200 })) as typeof fetch
  liveTest.setClient(async () => fakeClient().wc)
  assert.equal(await executeSwap({ ...buy, fairBuyBaseUnits: 1000n }), '0xswap')
})

test('0x: the impact guard is BUY-only — a SELL with a terrible quote still executes', async () => {
  globalThis.fetch = (async () => new Response(okQuote({ buyAmount: '1', issues: { allowance: { spender: AH } } }), { status: 200 })) as typeof fetch
  liveTest.setClient(async () => fakeClient().wc)
  assert.equal(await executeSwap(sell), '0xswap') // sells never set fairBuyBaseUnits; guard gated on side==='buy'
})

// ── P1-4: 0x router allowlist + bounded (exact-amount) approval (drain protection) ──

test('P1-4: a SELL is REFUSED when the approval spender is not the known AllowanceHolder', async () => {
  // A spoofed/compromised quote names a draining spender → reject before any approve.
  globalThis.fetch = (async () => new Response(okQuote({ transaction: { to: AH, data: '0xdead', value: '0', gas: '210000' }, issues: { allowance: { spender: '0xBADbADBadBadBadBaDbadbADBADBADbadBADbAd0' } } }), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  await assert.rejects(executeSwap(sell), /not the known AllowanceHolder|spoofed/i)
  assert.equal(fake.calls.writeContract, 0, 'never approves a rogue spender')
  assert.equal(fake.calls.sendTransaction, 0, 'never sends')
})

test('P1-4: a SELL is REFUSED when transaction.to ≠ the approval spender (allowance-holder invariant)', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ liquidityAvailable: true, transaction: { to: AH, data: '0xdead', value: '0', gas: '210000' }, issues: { allowance: { spender: '0x0000000000005E88410CcDFaDe4a5EfaE4b49562' } } }), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  // spender is a real 0x address but ≠ to → mismatch (a spoof that approves real AH but routes calldata elsewhere would be the reverse, caught the same way)
  await assert.rejects(executeSwap(sell), /≠ swap target|not the known AllowanceHolder/i)
  assert.equal(fake.calls.sendTransaction, 0)
})

test('P1-4: a BUY is REFUSED when transaction.to is not the known AllowanceHolder', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ liquidityAvailable: true, transaction: { to: '0xDeaDDeAddeAddEAddEAdDeAddEAddeAddeAd0000', data: '0xdead', value: '0', gas: '210000' } }), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  await assert.rejects(executeSwap(buy), /not the known AllowanceHolder/i)
  assert.equal(fake.calls.sendTransaction, 0, 'a buy to an unknown target never sends native value')
})

test('P1-4: a SELL approves the EXACT sell amount — never an unbounded maxUint256', async () => {
  globalThis.fetch = (async () => new Response(okQuote({ issues: { allowance: { spender: AH } } }), { status: 200 })) as typeof fetch
  const fake = fakeClient()
  liveTest.setClient(async () => fake.wc)
  await executeSwap(sell)
  assert.equal(fake.calls.writeContract, 1)
  assert.equal(fake.args.approve.functionName, 'approve')
  assert.deepEqual(fake.args.approve.args, [AH, sell.sellAmountBaseUnits], 'spender = AllowanceHolder, amount = exact sell amount')
  assert.notEqual(fake.args.approve.args[1], 2n ** 256n - 1n, 'NOT maxUint256')
})

test('P1-4: ZEROX_ALLOWANCE_HOLDER env EXTENDS the allowlist (redeploy escape hatch)', async () => {
  const custom = '0x1111111111111111111111111111111111111111'
  process.env.ZEROX_ALLOWANCE_HOLDER = custom
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ liquidityAvailable: true, transaction: { to: custom, data: '0xdead', value: '0', gas: '210000' }, issues: { allowance: { spender: custom } } }), { status: 200 })) as typeof fetch
    const fake = fakeClient()
    liveTest.setClient(async () => fake.wc)
    assert.equal(await executeSwap(sell), '0xswap', 'a whitelisted custom router is accepted')
    // the built-in AllowanceHolder still works alongside it
    globalThis.fetch = (async () => new Response(okQuote(), { status: 200 })) as typeof fetch
    assert.equal(await executeSwap(buy), '0xswap')
  } finally {
    delete process.env.ZEROX_ALLOWANCE_HOLDER
  }
})

test('INC-2: rpcUrlFor resolves PER-CHAIN — a shared URL can never bleed across chains', () => {
  for (const k of ['EVM_RPC_URL_8453', 'EVM_RPC_URL_42161']) delete process.env[k]
  assert.equal(rpcUrlFor(42161), undefined, 'unset → viem chain default')
  process.env.EVM_RPC_URL_8453 = 'https://base.example'
  process.env.EVM_RPC_URL_42161 = 'https://arb.example'
  assert.equal(rpcUrlFor(8453), 'https://base.example', 'Base resolves its own URL')
  assert.equal(rpcUrlFor(42161), 'https://arb.example', 'Arbitrum resolves its OWN url, not Base’s')
  for (const k of ['EVM_RPC_URL_8453', 'EVM_RPC_URL_42161']) delete process.env[k]
})

// ── Jupiter (Solana) entry-only price-impact guard ───────────────────────────

/** Stub the Jupiter endpoints with a given quote object; the swap-build returns
 *  no transaction so anything that gets PAST the guard fails with a distinct error. */
function stubJupiterQuote(quote: Record<string, unknown>) {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('/quote?')) return new Response(JSON.stringify(quote), { status: 200 })
    return new Response(JSON.stringify({}), { status: 200 }) // /swap → no swapTransaction
  }) as typeof fetch
}
const stubJupiter = (priceImpactPct: string) => stubJupiterQuote({ priceImpactPct, outAmount: '1', inAmount: '1', routePlan: [] })

const armSolana = () => {
  process.env.SOLANA_WALLET_KEY = bs58.encode(Keypair.generate().secretKey)
}
const TOKEN_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

test('Jupiter: a BUY with price impact over the ceiling is ABORTED (bad entry blocked)', async () => {
  armSolana()
  stubJupiter('0.5') // 50% impact, default ceiling 10%
  await assert.rejects(
    executeSolanaSwap({ inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountBaseUnits: 1_000_000n }),
    /price impact .*exceeds/,
  )
})

test('Jupiter: a BUY within the ceiling PASSES the guard (reaches the swap build)', async () => {
  armSolana()
  stubJupiter('0.01') // 1% impact — acceptable
  await assert.rejects(
    executeSolanaSwap({ inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountBaseUnits: 1_000_000n }),
    /jupiter returned no transaction/, // got past the guard, failed later (as designed by the stub)
  )
})

test('Jupiter: a SELL skips the impact guard entirely (a position can always be exited)', async () => {
  armSolana()
  stubJupiter('0.9') // 90% impact, but this is a SELL (inputMint != SOL)
  await assert.rejects(
    executeSolanaSwap({ inputMint: TOKEN_MINT, outputMint: SOL_MINT, amountBaseUnits: 1_000_000n }),
    /jupiter returned no transaction/, // reached the swap build → guard was skipped
  )
})

test('Jupiter: the ceiling honors MAX_PRICE_IMPACT_PCT', async () => {
  armSolana()
  process.env.MAX_PRICE_IMPACT_PCT = '5'
  stubJupiter('0.08') // 8% > the lowered 5% ceiling
  await assert.rejects(
    executeSolanaSwap({ inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountBaseUnits: 1_000_000n }),
    /price impact .*exceeds the 5%/,
  )
})

// MONEY-2: the guard must FAIL CLOSED on a missing / null / garbled impact —
// a buy must never proceed on an unknown price impact (a thin-pool quote could
// otherwise sneak through as "0%").
test('Jupiter: a BUY is ABORTED when the quote OMITS priceImpactPct (fail closed)', async () => {
  armSolana()
  stubJupiterQuote({ outAmount: '1', inAmount: '1', routePlan: [] }) // no priceImpactPct field
  await assert.rejects(
    executeSolanaSwap({ inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountBaseUnits: 1_000_000n }),
    /price impact unavailable/,
  )
})

test('Jupiter: a BUY is ABORTED when priceImpactPct is null (not treated as 0%)', async () => {
  armSolana()
  stubJupiterQuote({ priceImpactPct: null, outAmount: '1', inAmount: '1', routePlan: [] })
  await assert.rejects(
    executeSolanaSwap({ inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountBaseUnits: 1_000_000n }),
    /price impact unavailable/,
  )
})

test('Jupiter: a BUY is ABORTED when priceImpactPct is non-numeric garbage', async () => {
  armSolana()
  stubJupiterQuote({ priceImpactPct: 'N/A', outAmount: '1', inAmount: '1', routePlan: [] })
  await assert.rejects(
    executeSolanaSwap({ inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountBaseUnits: 1_000_000n }),
    /price impact unavailable/,
  )
})
