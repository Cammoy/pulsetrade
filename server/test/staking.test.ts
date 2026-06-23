import { test } from 'node:test'
import assert from 'node:assert/strict'
import { icpApy, solanaUnlockSeconds, stakingRewards, SOLANA_STAKING_APY } from '../src/staking.ts'

const DAY = 86_400
const YEAR = 365 * DAY
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

test('icpApy: scales with the dissolve delay (1× at 6mo … 2× at 8y), zero below the voting minimum', () => {
  assert.equal(icpApy(0), 0) // can't vote → no rewards
  assert.equal(icpApy(30 * DAY), 0) // still below the ~6-month minimum
  near(icpApy(182 * DAY), 0.06 * (1 + (182 * DAY) / (8 * YEAR))) // just past the minimum ≈ base × ~1.06
  near(icpApy(8 * YEAR), 0.12) // 8-year max → base 0.06 × 2.0
  near(icpApy(20 * YEAR), 0.12) // bonus caps at 8 years
})

test('solanaUnlockSeconds: time to the END of the deactivation epoch, scaled by live slot time', () => {
  const slotsInEpoch = 432_000
  const slotSec = 0.4
  // Deactivating THIS epoch, 100k slots already elapsed → 332k slots left.
  near(solanaUnlockSeconds(500, 100_000, slotsInEpoch, 500, slotSec), (432_000 - 100_000) * 0.4)
  // Deactivating NEXT epoch → rest of this epoch + one full epoch.
  near(solanaUnlockSeconds(500, 100_000, slotsInEpoch, 501, slotSec), ((432_000 - 100_000) + 432_000) * 0.4)
  // A faster network (smaller slotSec) unlocks sooner.
  assert.ok(solanaUnlockSeconds(500, 0, slotsInEpoch, 500, 0.3) < solanaUnlockSeconds(500, 0, slotsInEpoch, 500, 0.5))
})

test('stakingRewards: per-year asset + USD, and the until-unlock window only when dissolving', () => {
  // 10 SOL @ $150 = $1500, 6.9% APY, no unlock window.
  const r = stakingRewards(10, 1500, SOLANA_STAKING_APY, null)
  near(r.rewardPerYearAsset!, 10 * SOLANA_STAKING_APY)
  near(r.rewardPerYearUsd!, +(1500 * SOLANA_STAKING_APY).toFixed(2))
  assert.equal(r.rewardUntilUnlockUsd, null) // no window → no by-unlock figure

  // Same position deactivating with ~2.5 days to unlock → a small pro-rated reward.
  const d = stakingRewards(10, 1500, SOLANA_STAKING_APY, 2.5)
  near(d.rewardUntilUnlockUsd!, +(1500 * SOLANA_STAKING_APY * (2.5 / 365)).toFixed(2))

  // No APY (e.g. activating stake) → all nulls, never NaN.
  const none = stakingRewards(5, 1000, null, null)
  assert.equal(none.rewardPerYearAsset, null)
  assert.equal(none.rewardPerYearUsd, null)
  assert.equal(none.rewardUntilUnlockUsd, null)

  // Unpriced position ($0) → no USD rewards, but the per-year ASSET estimate still holds.
  const unpriced = stakingRewards(10, 0, SOLANA_STAKING_APY, null)
  near(unpriced.rewardPerYearAsset!, 10 * SOLANA_STAKING_APY)
  assert.equal(unpriced.rewardPerYearUsd, null)
})
