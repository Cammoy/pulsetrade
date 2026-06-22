import { useCallback, useEffect, useRef, useState } from 'react'

/** A saved coin — we store identity (not just the id) so a watchlist card can
 *  render instantly even when the coin has fallen out of the top-250 payload. */
export interface SavedCoin {
  id: string
  symbol: string
  name: string
}

const KEY = 'pulse.watchlist.v1'

function readLocal(): SavedCoin[] {
  if (typeof window === 'undefined') return []
  try {
    const arr = JSON.parse(window.localStorage.getItem(KEY) || '[]')
    return Array.isArray(arr) ? arr.filter((c) => c && typeof c.id === 'string') : []
  } catch {
    return []
  }
}

function writeLocal(items: SavedCoin[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    /* quota / private mode — keep the in-memory copy */
  }
}

/** Lossless union by id (a first, then b's extras) — used to reconcile the local
 *  cache with the server without dropping either side's saves. */
function union(a: SavedCoin[], b: SavedCoin[]): SavedCoin[] {
  const ids = new Set(a.map((c) => c.id))
  return [...a, ...b.filter((c) => !ids.has(c.id))]
}

function pushToServer(items: SavedCoin[]) {
  fetch('/api/prefs/watchlist', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ watchlist: items }),
  }).catch(() => {
    /* offline — localStorage still holds it; next change re-syncs */
  })
}

/**
 * Watchlist persistence strategy (free + open-source, no external DB):
 *  • The engine's crash-safe state.json is the cross-device source of truth
 *    (GET/PUT /api/prefs/watchlist).
 *  • localStorage is an offline cache for instant first paint.
 *  • On mount we UNION local + server (lossless) so neither side's saves are lost,
 *    and seed the server if it was empty. A 'storage' listener keeps tabs in sync.
 */
export function useWatchlist() {
  const [items, setItems] = useState<SavedCoin[]>(readLocal)
  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    let cancelled = false
    fetch('/api/prefs')
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (cancelled) return
        const server: SavedCoin[] = Array.isArray(p?.watchlist) ? p.watchlist : []
        const merged = union(server, itemsRef.current)
        setItems(merged)
        writeLocal(merged)
        // Seed/converge the server when it differs from the merged set.
        if (merged.length !== server.length) pushToServer(merged)
      })
      .catch(() => {
        /* engine unreachable — run from the localStorage cache */
      })

    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setItems(readLocal())
    }
    window.addEventListener('storage', onStorage)
    return () => {
      cancelled = true
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const persist = useCallback((next: SavedCoin[]) => {
    setItems(next)
    writeLocal(next) // instant local cache
    pushToServer(next) // durable, cross-device
  }, [])

  const has = useCallback((id: string) => items.some((c) => c.id === id), [items])

  /** Save if absent, remove if present. Returns the new saved-state (true=saved). */
  const toggle = useCallback(
    (coin: SavedCoin) => {
      const list = itemsRef.current
      const exists = list.some((c) => c.id === coin.id)
      persist(exists ? list.filter((c) => c.id !== coin.id) : [...list, { id: coin.id, symbol: coin.symbol, name: coin.name }])
      return !exists
    },
    [persist],
  )

  const remove = useCallback((id: string) => persist(itemsRef.current.filter((c) => c.id !== id)), [persist])

  return { items, has, toggle, remove }
}
