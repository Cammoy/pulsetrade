// One-time vault backfill: a state saved before the withdrawal vault existed must
// reconstruct each bot's already-banked profit (stats.nativeTakenQty) into the vault
// — keyed by chain + sweep asset — so existing profit is immediately withdrawable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-vault-backfill-'))
process.env.DATA_DIR = dir

const bot = (over: Record<string, unknown>) => ({
  id: 'b', name: 'x', network: 'base', token: 'LINK', strategy: 'grid', risk: 'balanced',
  budgetUsd: 100, cashUsd: 100, status: 'running',
  schedule: { enabled: false, days: [], startHour: 0, endHour: 24 },
  position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null },
  state: {}, stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 },
  equityHistory: [], log: [], createdAt: 0, lastTickAt: 0,
  ...over,
})

// NO `vault` key ⇒ the backfill runs.
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
  settings: { mode: 'paper' },
  bots: [
    bot({ id: 'a', network: 'arbitrum', stats: { realizedUsd: 5, feesUsd: 0, wins: 1, losses: 0, nativeTakenQty: 0.3, nativeTakenUsd: 600 } }),
    bot({ id: 'b', network: 'arbitrum', stats: { realizedUsd: 2, feesUsd: 0, wins: 1, losses: 0, nativeTakenQty: 0.2, nativeTakenUsd: 400 } }),
    bot({ id: 'c', network: 'base', sweepTo: 'usdt', stats: { realizedUsd: 9, feesUsd: 0, wins: 1, losses: 0, nativeTakenQty: 50, nativeTakenUsd: 50 } }),
    bot({ id: 'd', network: 'polygon', stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 } }),
  ],
}))

const { state } = await import('../src/store.js')

test('vault is backfilled from existing bots, summed per chain+asset, into the PAPER workspace', () => {
  // The legacy bots have no mode → backfilled to 'paper', so the vault keys carry :paper
  // (their banked profit is paper-withdrawable, never live).
  // two arbitrum native-sweep bots aggregate into one balance
  assert.ok(Math.abs((state.vault['arbitrum:native:paper'] ?? 0) - 0.5) < 1e-12)
  // a usdt-sweep bot lands under the usdt asset
  assert.equal(state.vault['base:usdt:paper'], 50)
  // a bot that never banked profit creates no entry
  assert.equal(state.vault['polygon:native:paper'], undefined)
})
