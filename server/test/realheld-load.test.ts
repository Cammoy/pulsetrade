// load() must backfill + normalize Bot.realHeld for pre-existing/corrupt state.
// Uses an isolated DATA_DIR seeded with a hand-written state.json BEFORE the
// dynamic import, so the module-level load() runs against it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-realheld-'))
process.env.DATA_DIR = DIR

// One bot with NO realHeld (pre-upgrade state), one with a corrupt value.
const seed = {
  bots: [
    { id: 'a', name: 'A', network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 100, cashUsd: 100, status: 'running', schedule: { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 }, position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null }, state: {}, stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 }, equityHistory: [], log: [], createdAt: 1, lastTickAt: 0 },
    { id: 'b', name: 'B', network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 100, cashUsd: 100, status: 'running', schedule: { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 }, realHeld: '12.5', position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null }, state: {}, stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 }, equityHistory: [], log: [], createdAt: 1, lastTickAt: 0 },
    { id: 'c', name: 'C', network: 'arbitrum', token: 'LINK', strategy: 'meanrev', risk: 'balanced', budgetUsd: 100, cashUsd: 100, status: 'running', schedule: { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 }, realHeld: '4096', position: { qty: 0, avgCostUsd: 0, costUsd: 0, openedAt: null }, state: {}, stats: { realizedUsd: 0, feesUsd: 0, wins: 0, losses: 0, nativeTakenQty: 0, nativeTakenUsd: 0 }, equityHistory: [], log: [], createdAt: 1, lastTickAt: 0 },
  ],
  trades: [], monthly: {}, autoSniper: null, tournaments: [], wallets: [], follows: [], settings: { mode: 'paper' },
}
fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify(seed))

const { state } = await import('../src/store.js')

test('load() backfills absent realHeld to "0"', () => {
  assert.equal(state.bots.find((b) => b.id === 'a')!.realHeld, '0')
})

test('load() normalizes a corrupt realHeld to "0"', () => {
  assert.equal(state.bots.find((b) => b.id === 'b')!.realHeld, '0')
})

test('load() preserves a well-formed realHeld', () => {
  assert.equal(state.bots.find((b) => b.id === 'c')!.realHeld, '4096')
})
