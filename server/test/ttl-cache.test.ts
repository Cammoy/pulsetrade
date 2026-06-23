import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ttlCache } from '../src/ttl-cache.js'

describe('ttlCache', () => {
  test('fresh() returns a value only within the TTL window', () => {
    const c = ttlCache<number>(1000)
    c.set('k', 7, 0)
    assert.equal(c.fresh('k', 500), 7) // inside TTL
    assert.equal(c.fresh('k', 999), 7) // boundary-1
    assert.equal(c.fresh('k', 1000), undefined) // exactly TTL → expired (strict <)
    assert.equal(c.fresh('k', 5000), undefined) // well past
    assert.equal(c.fresh('missing', 0), undefined)
  })

  test('stale() returns the last value at ANY age — the serve-on-error fallback', () => {
    const c = ttlCache<string>(100)
    assert.equal(c.stale('k'), undefined) // nothing cached yet → callers `?? []`
    c.set('k', 'last-good', 0)
    assert.equal(c.fresh('k', 10_000), undefined) // expired for fresh()
    assert.equal(c.stale('k'), 'last-good') // …but still available as fallback
  })

  test('set() stamps and RETURNS the value so call sites can `return cache.set(...)`', () => {
    const c = ttlCache<number[]>(1000)
    const rows = [1, 2, 3]
    assert.equal(c.set('k', rows, 0), rows) // identity returned
    assert.deepEqual(c.fresh('k', 1), rows)
  })

  test('a later set() refreshes the timestamp (overwrites the prior entry)', () => {
    const c = ttlCache<number>(1000)
    c.set('k', 1, 0)
    assert.equal(c.fresh('k', 1500), undefined) // first entry expired
    c.set('k', 2, 1400)
    assert.equal(c.fresh('k', 1500), 2) // new entry is fresh again
  })
})
