// Per-lane FIFO. Bots tick concurrently, but every live swap is signed by the
// SAME wallet — two sends racing on one chain collide on the nonce, and two
// sells racing would both read the full balance and double-spend it. Each lane
// (one EVM chain, or Solana) runs its swaps strictly in order. A lane is never
// poisoned by a failed swap: the stored tail swallows rejections while the
// caller still sees the real result. Shared by the engine's swap mirror and the
// vault's live withdrawals (a withdrawal rides the same chain lane as swaps).

const lanes = new Map<string, Promise<unknown>>()

export function runExclusive<T>(lane: string, fn: () => Promise<T>): Promise<T> {
  const prev = lanes.get(lane) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  lanes.set(
    lane,
    next.then(
      () => {},
      () => {},
    ),
  )
  return next
}

/** Await every lane's current tail so a graceful shutdown can let an in-flight swap
 *  (or withdrawal) finish broadcasting/confirming before the process exits, instead of
 *  abandoning a tx that already moved real funds. Rejections are swallowed (a failed swap
 *  still "settles" the lane). Bound this with a timeout race at the call site. [P1-12] */
export function drainLanes(): Promise<void> {
  return Promise.allSettled([...lanes.values()]).then(() => {})
}
