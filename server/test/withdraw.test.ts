// #46 — profit withdrawals. Banked profit (swept native/USDT) accrues in the vault
// and can be withdrawn to an external address: PAPER records a simulation, LIVE on a
// supported EVM chain or Solana executes a real transfer through the injectable live
// seam. These tests cover: the vault is credited by a profitable sell; paper withdrawals
// debit the vault and validate input; live EVM + Solana (SOL/SPL) withdrawals send-and-
// confirm; a failed live send refunds the vault; and real money is never "simulated" on
// a live chain whose signer isn't configured.
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-withdraw-'))
process.env.ZEROX_API_KEY = 'test-key'
process.env.BOT_WALLET_KEY = '0x' + '1'.repeat(64) // ⇒ liveReady() is true

const PRICES: Record<string, number> = { ethereum: 2000, chainlink: 10, tether: 1, solana: 150 }

const { state } = await import('../src/store.js')
const { createBot, requestWithdrawal, profitVault, listWithdrawals, __test } = await import('../src/engine.js')
const { getSpotPrices } = await import('../src/prices.js')
const { execBuy, execSell, creditVault, vaultBalance, live } = __test

const realLive = { ...live }
const EVM_ADDR = '0x' + 'a'.repeat(40)
const SOL_ADDR = 'So11111111111111111111111111111111111111112'

before(async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { usd: v }]))), { status: 200 })) as typeof fetch
  await getSpotPrices(Object.keys(PRICES))
})

beforeEach(() => {
  state.bots.length = 0
  state.trades.length = 0
  state.withdrawals.length = 0
  for (const k of Object.keys(state.vault)) delete state.vault[k]
  state.settings.mode = 'paper'
  Object.assign(live, realLive)
  live.nativeBalanceWei = (async () => 10n ** 30n) as typeof live.nativeBalanceWei
  live.tokenBalanceBaseUnits = (async () => 10n ** 30n) as typeof live.tokenBalanceBaseUnits
})
afterEach(() => Object.assign(live, realLive))

function freshBot() {
  const b = createBot({ network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 1000 })
  assert.ok(!('error' in b))
  return b as Exclude<ReturnType<typeof createBot>, { error: string }>
}

test('a profitable sell banks the swept profit in the vault (native)', () => {
  const b = freshBot()
  execBuy(b, 10, 500, 'seed') // open a LINK position at $10
  assert.equal(vaultBalance('arbitrum', 'native'), 0)
  execSell(b, 12, 1, 'take-profit', true) // sell the lot at $12 → profit swept to ETH
  const banked = vaultBalance('arbitrum', 'native')
  assert.ok(banked > 0, 'profit banked to the vault')
  // The vault qty equals the bot's swept native qty (single bot, single chain/asset).
  assert.ok(Math.abs(banked - b.stats.nativeTakenQty) < 1e-12)
  // And it surfaces in the snapshot, priced at the current ETH spot.
  const row = profitVault().find((r) => r.network === 'arbitrum' && r.asset === 'native')
  assert.ok(row && row.qty > 0 && row.usdValue > 0)
})

test('a paper withdrawal debits the vault and records a simulation', async () => {
  creditVault('arbitrum', 'native', 1)
  const out = await requestWithdrawal({ network: 'arbitrum', asset: 'native', amountQty: 0.4, toAddress: EVM_ADDR })
  assert.ok(!('error' in out))
  const w = out as Exclude<typeof out, { error: string }>
  assert.equal(w.status, 'simulated')
  assert.equal(w.mode, 'paper')
  assert.equal(w.amountUsd, 800) // 0.4 ETH × $2000
  assert.ok(Math.abs(vaultBalance('arbitrum', 'native') - 0.6) < 1e-12)
  assert.equal(listWithdrawals().length, 1)
})

test('withdrawal input is validated', async () => {
  creditVault('arbitrum', 'native', 1)
  assert.ok('error' in (await requestWithdrawal({ network: 'nope', asset: 'native', amountQty: 1, toAddress: EVM_ADDR })))
  assert.ok('error' in (await requestWithdrawal({ network: 'arbitrum', asset: 'gold', amountQty: 1, toAddress: EVM_ADDR })))
  assert.ok('error' in (await requestWithdrawal({ network: 'arbitrum', asset: 'native', amountQty: 0, toAddress: EVM_ADDR })))
  assert.ok('error' in (await requestWithdrawal({ network: 'arbitrum', asset: 'native', amountQty: 1, toAddress: 'not-an-address' })))
  // mixed-case address with a BAD EIP-55 checksum is rejected (typo protection)
  assert.ok('error' in (await requestWithdrawal({ network: 'arbitrum', asset: 'native', amountQty: 1, toAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa' })))
  // over-withdraw past the banked balance
  assert.ok('error' in (await requestWithdrawal({ network: 'arbitrum', asset: 'native', amountQty: 1.5, toAddress: EVM_ADDR })))
  // none of the rejects moved the vault
  assert.equal(vaultBalance('arbitrum', 'native'), 1)
})

test('a live EVM withdrawal sends a real transfer and confirms', async () => {
  state.settings.mode = 'live'
  let sent: { chainId: number; to: string; wei: bigint } | null = null
  live.sendNative = (async (chainId: number, to: string, wei: bigint) => {
    sent = { chainId, to, wei }
    return '0xdeadbeef'
  }) as typeof live.sendNative
  creditVault('arbitrum', 'native', 1)
  const out = await requestWithdrawal({ network: 'arbitrum', asset: 'native', amountQty: 0.25, toAddress: EVM_ADDR })
  const w = out as Exclude<typeof out, { error: string }>
  assert.equal(w.status, 'confirmed')
  assert.equal(w.mode, 'live')
  assert.equal(w.txHash, '0xdeadbeef')
  assert.ok(sent && sent!.chainId === 42161 && sent!.to === EVM_ADDR)
  assert.equal(sent!.wei, 250000000000000000n) // 0.25 ETH in wei
  assert.ok(Math.abs(vaultBalance('arbitrum', 'native') - 0.75) < 1e-12)
})

test('a live EVM withdrawal works with a SIGNER even when ZEROX_API_KEY (the 0x trading key) is absent', async () => {
  // A withdrawal is a plain transfer, not a 0x swap — it must not require the trading
  // API key. Before the fix, liveWithdrawable gated on liveReady() (which needs
  // ZEROX_API_KEY) and wrongly marked EVM chains "paper-only" with only a signer.
  state.settings.mode = 'live'
  const savedZerox = process.env.ZEROX_API_KEY
  delete process.env.ZEROX_API_KEY
  try {
    live.sendNative = (async () => '0xnozerox') as typeof live.sendNative
    creditVault('base', 'native', 1)
    const out = await requestWithdrawal({ network: 'base', asset: 'native', amountQty: 0.1, toAddress: EVM_ADDR })
    const w = out as Exclude<typeof out, { error: string }>
    assert.equal(w.status, 'confirmed') // NOT refused as "live not available on Base"
    assert.equal(w.txHash, '0xnozerox')
  } finally {
    if (savedZerox !== undefined) process.env.ZEROX_API_KEY = savedZerox
  }
})

test('a live USDT withdrawal routes through the ERC-20 transfer at the chain decimals', async () => {
  state.settings.mode = 'live'
  let sent: { token: string; to: string; units: bigint } | null = null
  live.sendErc20 = (async (_chainId: number, token: string, to: string, units: bigint) => {
    sent = { token, to, units }
    return '0xusdt'
  }) as typeof live.sendErc20
  creditVault('arbitrum', 'usdt', 100)
  const out = await requestWithdrawal({ network: 'arbitrum', asset: 'usdt', amountQty: 40, toAddress: EVM_ADDR })
  const w = out as Exclude<typeof out, { error: string }>
  assert.equal(w.status, 'confirmed')
  assert.ok(sent && sent!.to === EVM_ADDR)
  assert.equal(sent!.units, 40_000_000n) // 40 USDT @ 6 decimals on Arbitrum
  assert.equal(vaultBalance('arbitrum', 'usdt'), 60)
})

test('a failed live send refunds the vault and marks the withdrawal failed', async () => {
  state.settings.mode = 'live'
  live.sendNative = (async () => {
    throw new Error('rpc exploded')
  }) as typeof live.sendNative
  creditVault('arbitrum', 'native', 1)
  const out = await requestWithdrawal({ network: 'arbitrum', asset: 'native', amountQty: 0.3, toAddress: EVM_ADDR })
  const w = out as Exclude<typeof out, { error: string }>
  assert.equal(w.status, 'failed')
  assert.match(w.error ?? '', /rpc exploded/)
  // funds never left the wallet → the reservation is refunded in full
  assert.equal(vaultBalance('arbitrum', 'native'), 1)
})

test('a live Solana native withdrawal sends a real SOL transfer and confirms', async () => {
  state.settings.mode = 'live'
  live.solanaLiveReady = (() => true) as typeof live.solanaLiveReady // arm the Solana signer
  live.splTokenBalanceBaseUnits = (async () => 10n ** 18n) as typeof live.splTokenBalanceBaseUnits // ample SOL on-chain
  let sent: { to: string; lamports: bigint } | null = null
  live.sendSolNative = (async (to: string, lamports: bigint) => {
    sent = { to, lamports }
    return 'solsig111'
  }) as typeof live.sendSolNative
  creditVault('solana', 'native', 2)
  const out = await requestWithdrawal({ network: 'solana', asset: 'native', amountQty: 1.5, toAddress: SOL_ADDR })
  const w = out as Exclude<typeof out, { error: string }>
  assert.equal(w.status, 'confirmed')
  assert.equal(w.mode, 'live')
  assert.equal(w.txHash, 'solsig111')
  assert.ok(sent && sent!.to === SOL_ADDR)
  assert.equal(sent!.lamports, 1_500_000_000n) // 1.5 SOL @ 9 dp
  assert.ok(Math.abs(vaultBalance('solana', 'native') - 0.5) < 1e-12)
})

test('a live Solana USDT withdrawal routes through the SPL transfer at the mint decimals', async () => {
  state.settings.mode = 'live'
  live.solanaLiveReady = (() => true) as typeof live.solanaLiveReady
  live.splTokenBalanceBaseUnits = (async () => 10n ** 18n) as typeof live.splTokenBalanceBaseUnits
  let sent: { mint: string; to: string; units: bigint } | null = null
  live.sendSplToken = (async (mint: string, to: string, units: bigint) => {
    sent = { mint, to, units }
    return 'solusdt'
  }) as typeof live.sendSplToken
  creditVault('solana', 'usdt', 100)
  const out = await requestWithdrawal({ network: 'solana', asset: 'usdt', amountQty: 40, toAddress: SOL_ADDR })
  const w = out as Exclude<typeof out, { error: string }>
  assert.equal(w.status, 'confirmed')
  assert.ok(sent && sent!.to === SOL_ADDR)
  assert.equal(sent!.units, 40_000_000n) // 40 USDT @ 6 dp on Solana
  assert.equal(sent!.mint, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') // the Solana USDT mint
  assert.equal(vaultBalance('solana', 'usdt'), 60)
})

test('a failed live Solana send refunds the vault and marks the withdrawal failed', async () => {
  state.settings.mode = 'live'
  live.solanaLiveReady = (() => true) as typeof live.solanaLiveReady
  live.splTokenBalanceBaseUnits = (async () => 10n ** 18n) as typeof live.splTokenBalanceBaseUnits
  live.sendSolNative = (async () => {
    throw new Error('solana rpc exploded')
  }) as typeof live.sendSolNative
  creditVault('solana', 'native', 2)
  const out = await requestWithdrawal({ network: 'solana', asset: 'native', amountQty: 1, toAddress: SOL_ADDR })
  const w = out as Exclude<typeof out, { error: string }>
  assert.equal(w.status, 'failed')
  assert.match(w.error ?? '', /solana rpc exploded/)
  assert.equal(vaultBalance('solana', 'native'), 2) // funds never left → refunded in full
})

test('live mode refuses a Solana payout when its signer is NOT configured', async () => {
  state.settings.mode = 'live'
  // solanaLiveReady() is false here (no SOLANA_WALLET_KEY / Turnkey in the test env),
  // so a live Solana payout must refuse rather than simulate moving real money.
  creditVault('solana', 'native', 2)
  const out = await requestWithdrawal({ network: 'solana', asset: 'native', amountQty: 1, toAddress: SOL_ADDR })
  assert.ok('error' in out)
  assert.match((out as { error: string }).error, /Solana/)
  assert.equal(vaultBalance('solana', 'native'), 2) // untouched
})

test('paper mode CAN simulate a withdrawal on a non-EVM chain', async () => {
  state.settings.mode = 'paper'
  creditVault('solana', 'native', 2)
  const out = await requestWithdrawal({ network: 'solana', asset: 'native', amountQty: 1, toAddress: SOL_ADDR })
  const w = out as Exclude<typeof out, { error: string }>
  assert.equal(w.status, 'simulated')
  assert.equal(vaultBalance('solana', 'native'), 1)
})
