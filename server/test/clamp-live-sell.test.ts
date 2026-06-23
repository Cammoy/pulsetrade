// The pure live-exit clamp shared by the EVM and Solana mirror branches [MP-2].
// All cases proven against the original inline ladder so this locks behaviour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampLiveSell } from '../src/safety-math.js'

test('non-full TRUSTED exit clamps to attributed `mine` and flags the overshoot', () => {
  // want 100, have 200, mine 50 → cap=min(100,200)=100, then mine(50)<100 ⇒ 50; 50<want ⇒ warn
  assert.deepEqual(clampLiveSell(100n, 200n, 50n, false, false), { sell: 50n, exceedsAttributed: true })
})

test('non-full TRUSTED exit with ample `mine` does not clamp or warn', () => {
  assert.deepEqual(clampLiveSell(100n, 200n, 150n, false, false), { sell: 100n, exceedsAttributed: false })
})

test('non-full exit is hard-capped by wallet `have`', () => {
  // want 100 but wallet only has 80 → 80, then mine(50)<80 ⇒ 50
  assert.deepEqual(clampLiveSell(100n, 80n, 50n, false, false), { sell: 50n, exceedsAttributed: true })
})

test('UNTRUSTED ignores `mine` (degrades to want-vs-have, never warns)', () => {
  assert.deepEqual(clampLiveSell(100n, 200n, 50n, true, false), { sell: 100n, exceedsAttributed: false })
})

test('mine=0 is treated as untrusted (degrades to want-vs-have)', () => {
  assert.deepEqual(clampLiveSell(100n, 200n, 0n, false, false), { sell: 100n, exceedsAttributed: false })
})

test('FULL TRUSTED exit liquidates `mine`, capped to the wallet', () => {
  assert.deepEqual(clampLiveSell(100n, 200n, 50n, false, true), { sell: 50n, exceedsAttributed: false }) // mine<have
  assert.deepEqual(clampLiveSell(100n, 40n, 50n, false, true), { sell: 40n, exceedsAttributed: false }) // have<mine
})

test('FULL UNTRUSTED exit falls back to paper `want`, NEVER the whole shared wallet', () => {
  // have is 200 (a co-tenant's tokens too) — must sell only want(100), not 200
  assert.deepEqual(clampLiveSell(100n, 200n, 50n, true, true), { sell: 100n, exceedsAttributed: false })
})

test('nothing sellable returns 0n', () => {
  assert.deepEqual(clampLiveSell(0n, 200n, 50n, false, false), { sell: 0n, exceedsAttributed: false })
})
