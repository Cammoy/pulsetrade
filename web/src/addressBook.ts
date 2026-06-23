import { useEffect, useState } from 'react'

/**
 * A small labelled address book, persisted in localStorage. It's pure UI convenience
 * (pre-fill a withdrawal destination or a tracked address) — never money-critical — so
 * it lives client-side, no server round-trip. A module-level subscriber keeps every
 * useAddressBook() consumer (the manager + the withdraw picker) in sync within the tab.
 */
export type AddrKind = 'evm' | 'solana' | 'other'
export interface SavedAddress {
  id: string
  label: string
  address: string
  kind: AddrKind
}

const KEY = 'pulsetrade.addresses'
const EVM = /^0x[0-9a-fA-F]{40}$/
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ // base58 (no 0/O/I/l)

/** Best-effort address-type sniff so the withdraw picker can offer only compatible ones. */
export const addrKind = (a: string): AddrKind => (EVM.test(a.trim()) ? 'evm' : SOL.test(a.trim()) ? 'solana' : 'other')
export const isLikelyAddress = (a: string) => EVM.test(a.trim()) || SOL.test(a.trim())

export function loadAddresses(): SavedAddress[] {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.address === 'string' && typeof x.label === 'string') : []
  } catch {
    return []
  }
}

const subs = new Set<() => void>()
function persist(list: SavedAddress[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* private mode / quota — the in-memory list still works for this session */
  }
  subs.forEach((f) => f())
}

export function saveAddress(label: string, address: string): { list?: SavedAddress[]; error?: string } {
  const lbl = label.trim()
  const adr = address.trim()
  if (!lbl) return { error: 'Give the address a label (e.g. “My Ledger”).' }
  if (!isLikelyAddress(adr)) return { error: 'That doesn’t look like an EVM (0x…) or Solana address.' }
  const list = loadAddresses()
  if (list.some((x) => x.address.toLowerCase() === adr.toLowerCase())) return { error: 'That address is already saved.' }
  const next = [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, label: lbl, address: adr, kind: addrKind(adr) }, ...list]
  persist(next)
  return { list: next }
}

export function removeAddress(id: string): SavedAddress[] {
  const next = loadAddresses().filter((x) => x.id !== id)
  persist(next)
  return next
}

/** React binding — re-renders whenever the book changes from any consumer. */
export function useAddressBook() {
  const [addresses, setAddresses] = useState<SavedAddress[]>(loadAddresses)
  useEffect(() => {
    const refresh = () => setAddresses(loadAddresses())
    subs.add(refresh)
    // also follow edits from OTHER tabs
    window.addEventListener('storage', refresh)
    return () => {
      subs.delete(refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])
  return {
    addresses,
    save: (label: string, address: string) => saveAddress(label, address),
    remove: (id: string) => removeAddress(id),
  }
}
