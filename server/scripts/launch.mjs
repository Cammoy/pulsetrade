// Run the engine under a Node that supports node:sqlite (>=22.5) so the durable trade
// ledger is active. The npm/tsx launch chain otherwise resolves the system default Node
// (often 18 via nvm), which has no node:sqlite. This wrapper finds the newest installed
// Node >=22.5 (preferring the .nvmrc-pinned version) and runs `node --import tsx
// [--watch] index.ts` under it. If none is found it EXITS NON-ZERO rather than silently
// running on ambient Node with the durable ledger off (audit P1-13/P2-13) — override with
// PULSETRADE_ALLOW_LEGACY_NODE=1 to run anyway (ledger disabled).
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(serverDir, '..')
const watch = process.argv.includes('--watch')
const entry = path.join('src', 'index.ts')

const atLeast225 = (v) => v[0] > 22 || (v[0] === 22 && v[1] >= 5)
const parse = (s) => s.replace(/^v/, '').split('.').map(Number)

/** The version pinned in .nvmrc (repo root or server/), or null. Preferred when installed. */
function pinnedVersion() {
  for (const p of [path.join(repoRoot, '.nvmrc'), path.join(serverDir, '.nvmrc')]) {
    try {
      const v = readFileSync(p, 'utf8').trim().replace(/^v/, '')
      if (/^\d+\.\d+\.\d+$/.test(v)) return v
    } catch { /* no .nvmrc here */ }
  }
  return null
}

/** Newest Node >=22.5: current if it qualifies, else the .nvmrc-pinned install, else the
 *  newest qualifying nvm install. */
function pickNode() {
  if (atLeast225(parse(process.versions.node))) return { bin: process.execPath, modern: true }
  const nvm = path.join(os.homedir(), '.nvm', 'versions', 'node')
  if (existsSync(nvm)) {
    const pinned = pinnedVersion()
    if (pinned && atLeast225(parse(pinned))) {
      const bin = path.join(nvm, 'v' + pinned, 'bin', 'node')
      if (existsSync(bin)) return { bin, modern: true }
    }
    const best = readdirSync(nvm)
      .filter((d) => /^v\d/.test(d))
      .map(parse)
      .filter(atLeast225)
      .sort((a, b) => b[0] - a[0] || b[1] - a[1] || (b[2] || 0) - (a[2] || 0))[0]
    if (best) {
      const bin = path.join(nvm, 'v' + best.join('.'), 'bin', 'node')
      if (existsSync(bin)) return { bin, modern: true }
    }
  }
  return { bin: process.execPath, modern: false }
}

const { bin, modern } = pickNode()
let cmd, args
if (modern) {
  // Node >=22.5 with tsx as the loader (handles the .js→.ts import resolution).
  args = [...(watch ? ['--watch'] : []), '--import', 'tsx', entry]
  cmd = bin
} else if (process.env.PULSETRADE_ALLOW_LEGACY_NODE === '1') {
  // Explicit override — run on ambient Node with the durable ledger disabled.
  console.warn('[launch] PULSETRADE_ALLOW_LEGACY_NODE=1 — running on legacy Node; SQLite trade ledger DISABLED')
  cmd = path.join(serverDir, 'node_modules', '.bin', 'tsx')
  args = [...(watch ? ['watch'] : []), entry]
} else {
  // FAIL LOUD: no SQLite-capable Node → the durable audit/tax ledger would be silently off.
  console.error(
    `[launch] FATAL: no Node >=22.5 found (need ${pinnedVersion() ?? '>=22.5'} per .nvmrc) — the durable SQLite trade ledger requires it.\n` +
      '  → Install/select it (e.g. `nvm install` then `nvm use`), or set PULSETRADE_ALLOW_LEGACY_NODE=1 to run without the ledger.',
  )
  process.exit(1)
}

const child = spawn(cmd, args, { cwd: serverDir, stdio: 'inherit', env: process.env })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
