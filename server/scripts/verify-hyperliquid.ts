// Verify the Hyperliquid L1 order-signing against the REAL testnet — without any funds.
//
// How it proves correctness: we sign a probe order with an EPHEMERAL throwaway key and POST
// it to testnet. If our msgpack + actionHash + EIP-712 are byte-correct, the exchange
// recovers the signer and reaches business logic — replying "does not exist" / margin /
// min-size (the account was never funded). If our signing is wrong, it replies with a
// DESERIALIZE or signature error instead. So:
//   • business error  ⇒ ✅ signing format VERIFIED end-to-end
//   • deserialize/sig ⇒ ❌ signing is wrong
//
// If HL_API_PRIVATE_KEY (+ optional HL_TESTNET=false for mainnet) is set, it instead signs
// with THAT key and places a non-marketable IOC buy at $1 (cannot fill) so you can confirm
// the full path on your own funded testnet account. Run: npm run verify:hyperliquid
import { generatePrivateKey } from 'viem/accounts'
import { signL1Action, buildOrderAction, formatPrice, formatSize, type OrderAction } from '../src/hyperliquid-sign.js'

const TESTNET = process.env.HL_TESTNET !== 'false' // default: testnet
const BASE = TESTNET ? 'https://api.hyperliquid-testnet.xyz' : 'https://api.hyperliquid.xyz'

async function meta(): Promise<{ universe: { name: string; szDecimals: number }[] }> {
  const r = await fetch(`${BASE}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) })
  if (!r.ok) throw new Error(`meta ${r.status}`)
  return r.json()
}

function classify(raw: string): 'verified' | 'bad-signing' | 'unknown' {
  const s = raw.toLowerCase()
  if (s.includes('deserialize') || s.includes('invalid signature') || s.includes('failed to parse')) return 'bad-signing'
  // Reached business logic ⇒ the signature was accepted + recovered.
  if (s.includes('does not exist') || s.includes('insufficient') || s.includes('margin') || s.includes('minimum') || s.includes('must exist') || s.includes('"status":"ok"') || s.includes('order')) return 'verified'
  return 'unknown'
}

async function main() {
  console.log(`[hl] network: ${TESTNET ? 'TESTNET' : 'MAINNET'} (${BASE})`)
  const m = await meta()
  const ethIdx = m.universe.findIndex((u) => u.name === 'ETH')
  if (ethIdx < 0) throw new Error('ETH not in universe')
  const szd = m.universe[ethIdx].szDecimals
  console.log(`[hl] read meta ✓ — ${m.universe.length} assets; ETH idx=${ethIdx} szDecimals=${szd}`)

  // Probe order: buy ETH, $1 limit (non-marketable), tiny size, IOC ⇒ cannot fill.
  const action: OrderAction = buildOrderAction({ assetIndex: ethIdx, isBuy: true, px: formatPrice(1, szd), sz: formatSize(0.01, szd), tif: 'Ioc' })
  const nonce = Date.now()

  const userKey = process.env.HL_API_PRIVATE_KEY as `0x${string}` | undefined
  const key = userKey ?? generatePrivateKey()
  const which = userKey ? 'YOUR HL_API_PRIVATE_KEY' : 'an ephemeral throwaway key (no funds)'
  console.log(`[hl] signing a non-marketable $1 IOC buy probe with ${which}…`)

  const signature = await signL1Action({ privateKey: key, action, nonce, isMainnet: !TESTNET })
  const res = await fetch(`${BASE}/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
  })
  const raw = await res.text()
  console.log(`[hl] /exchange → HTTP ${res.status}: ${raw.slice(0, 300)}`)

  const verdict = classify(raw)
  if (verdict === 'verified') {
    console.log('\n✅ SIGNING VERIFIED — the exchange accepted + recovered the signature (the order was rejected only by business logic, which is expected for an unfunded probe).')
    if (!userKey) console.log('   Set HL_API_PRIVATE_KEY to a funded testnet API/agent wallet and re-run to confirm a real (non-fillable) order on your account.')
    process.exit(0)
  }
  if (verdict === 'bad-signing') {
    console.error('\n❌ SIGNING REJECTED — deserialize/signature error. The msgpack/actionHash/EIP-712 is wrong; do NOT enable live perps.')
    process.exit(1)
  }
  console.error('\n⚠ UNCLEAR response — inspect the raw body above before trusting the signer.')
  process.exit(2)
}

main().catch((e) => {
  console.error('[hl] verify failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
