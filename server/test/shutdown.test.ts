// P1-12 graceful shutdown: stopEngine() must DRAIN any in-flight swap lane before resolving,
// so a deploy/reboot can't abandon a broadcast on-chain tx. Isolated file — stopEngine flips a
// module-level `draining` flag, so it must not bleed into other engine tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-shutdown-'))

const { stopEngine, __test } = await import('../src/engine.js')
const { runExclusive } = __test

test('stopEngine drains in-flight lane work before resolving (no abandoned swap)', async () => {
  let done = false
  void runExclusive('evm:8453', () => new Promise<void>((r) => setTimeout(() => { done = true; r() }, 30)))
  await stopEngine(2000)
  assert.equal(done, true, 'awaited the in-flight swap before exiting')
})
