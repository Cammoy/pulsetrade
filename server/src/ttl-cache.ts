/**
 * A keyed time-to-live cache for the "serve fresh → else refetch → else serve the last value on
 * failure" pattern repeated across the data-fetch modules (CoinGecko / Etherscan are rate-limited,
 * so a failed refetch must fall back to stale rather than returning nothing).
 *
 *  • `fresh(key)`  → the value only while still within TTL, else undefined.
 *  • `stale(key)`  → the last value at any age — the on-error fallback (`?? []` / `?? null`).
 *  • `set(key, v)` → stamps and RETURNS v, so call sites can `return cache.set(key, v)`.
 *
 * `now` is injectable per call (defaults to Date.now()) so freshness/expiry stays unit-testable.
 * Single-value and bespoke caches (per-id 404 caching, dual fresh/stale thresholds) intentionally
 * keep their own logic — this only abstracts the keyed TTL-with-stale-fallback shape.
 */
export function ttlCache<V>(ttlMs: number) {
  const store = new Map<string, { at: number; v: V }>()
  return {
    fresh(key: string, now = Date.now()): V | undefined {
      const hit = store.get(key)
      return hit && now - hit.at < ttlMs ? hit.v : undefined
    },
    stale(key: string): V | undefined {
      return store.get(key)?.v
    },
    set<T extends V>(key: string, value: T, now = Date.now()): T {
      store.set(key, { at: now, v: value })
      return value
    },
  }
}
