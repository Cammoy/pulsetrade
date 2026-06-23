// One-off verification that the Turnkey credentials sign correctly — READ-ONLY,
// signs an arbitrary message (NOT a transaction), so no funds can move. Proves
// the API key + org id + wallet addresses all work end-to-end before going live.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recoverMessageAddress } from 'viem'

// Load server/.env exactly like the engine does.
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}

const EXPECT_EVM = process.env.TURNKEY_EVM_ADDRESS!
const EXPECT_SOL = process.env.TURNKEY_SOLANA_ADDRESS!

async function main() {
  const { turnkeyEvmReady, turnkeySolReady, turnkeyEvmAccount } = await import('../src/live-turnkey.js')
  console.log('turnkeyEvmReady:', turnkeyEvmReady(), '| turnkeySolReady:', turnkeySolReady())

  // ── EVM: build the viem account, confirm address, sign + recover ──
  const account = await turnkeyEvmAccount()
  const addrMatch = account.address.toLowerCase() === EXPECT_EVM.toLowerCase()
  console.log(`\n[EVM] account.address = ${account.address}`)
  console.log(`[EVM] matches expected? ${addrMatch ? '✓' : '✗ MISMATCH'}`)

  const msg = 'pulsetrade-turnkey-verification'
  const sig = await account.signMessage({ message: msg })
  const recovered = await recoverMessageAddress({ message: msg, signature: sig })
  const recMatch = recovered.toLowerCase() === EXPECT_EVM.toLowerCase()
  console.log(`[EVM] signed a message; recovered signer = ${recovered}`)
  console.log(`[EVM] signature valid (recovered == address)? ${recMatch ? '✓' : '✗'}`)

  // ── Solana: sign a message via the Turnkey signer ──
  const { Turnkey } = await import('@turnkey/sdk-server')
  const { TurnkeySigner } = await import('@turnkey/solana')
  const client = new Turnkey({
    apiBaseUrl: process.env.TURNKEY_API_BASE_URL || 'https://api.turnkey.com',
    apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
    apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
    defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID!,
  }).apiClient()
  const solSigner = new TurnkeySigner({ organizationId: process.env.TURNKEY_ORGANIZATION_ID!, client })
  const solSig = await solSigner.signMessage(new TextEncoder().encode('pulsetrade-turnkey-verification'), EXPECT_SOL)
  console.log(`\n[SOL] address = ${EXPECT_SOL}`)
  console.log(`[SOL] signed a message; signature ${solSig.length} bytes ${solSig.length === 64 ? '✓' : '✗'}`)

  const ok = addrMatch && recMatch && solSig.length === 64
  console.log(`\n${ok ? '✅ TURNKEY VERIFIED — EVM + Solana signing both work.' : '❌ verification failed'}`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('\n❌ Turnkey verification error:', e?.message || e)
  process.exit(1)
})
