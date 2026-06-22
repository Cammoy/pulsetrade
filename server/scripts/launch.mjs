// Run the engine under a Node that supports node:sqlite (>=22.5) so the trade
// ledger is active. The npm/tsx launch chain otherwise resolves the system
// default Node (often 18 via nvm), which has no node:sqlite. This wrapper finds
// the newest installed Node >=22.5 and runs `node --import tsx [--watch] index.ts`
// under it; if none is found it falls back to the local tsx binary on the ambient
// Node (the engine still runs — only the unbounded SQLite history stays off).
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')
const entry = path.join('src', 'index.ts')

const atLeast225 = (v) => v[0] > 22 || (v[0] === 22 && v[1] >= 5)
const parse = (s) => s.replace(/^v/, '').split('.').map(Number)

/** Newest Node >=22.5: the current one if it qualifies, else scan nvm installs. */
function pickNode() {
  if (atLeast225(parse(process.versions.node))) return { bin: process.execPath, modern: true }
  const nvm = path.join(os.homedir(), '.nvm', 'versions', 'node')
  if (existsSync(nvm)) {
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
} else {
  // No SQLite-capable Node found — run the original tsx binary on ambient Node.
  console.warn('[launch] no Node >=22.5 found — SQLite trade ledger will be disabled (engine still runs)')
  cmd = path.join(serverDir, 'node_modules', '.bin', 'tsx')
  args = [...(watch ? ['watch'] : []), entry]
}

const child = spawn(cmd, args, { cwd: serverDir, stdio: 'inherit', env: process.env })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
