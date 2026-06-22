import { describe, test, expect, beforeEach } from 'vitest'
import { addrKind, isLikelyAddress, saveAddress, removeAddress, loadAddresses } from './addressBook'

const EVM = '0x' + 'a'.repeat(40)
const SOL = 'So11111111111111111111111111111111111111112' // base58, 43 chars

describe('address book', () => {
  beforeEach(() => localStorage.clear())

  test('infers the address kind from the format', () => {
    expect(addrKind(EVM)).toBe('evm')
    expect(addrKind(SOL)).toBe('solana')
    expect(addrKind('definitely not an address')).toBe('other')
  })

  test('isLikelyAddress accepts EVM + Solana, rejects junk', () => {
    expect(isLikelyAddress(EVM)).toBe(true)
    expect(isLikelyAddress(SOL)).toBe(true)
    expect(isLikelyAddress('0x123')).toBe(false) // too short
    expect(isLikelyAddress('')).toBe(false)
  })

  test('saveAddress validates label + address, dedups, prepends newest', () => {
    expect(saveAddress('', EVM).error).toBeTruthy() // missing label
    expect(saveAddress('Junk', '0xnope').error).toBeTruthy() // not an address
    const r1 = saveAddress('Ledger', EVM)
    expect(r1.list).toHaveLength(1)
    expect(r1.list![0]).toMatchObject({ label: 'Ledger', address: EVM, kind: 'evm' })
    expect(saveAddress('Dup', EVM.toUpperCase().replace('0X', '0x')).error).toMatch(/already saved/i) // case-insensitive dedup
    const r2 = saveAddress('Phantom', SOL)
    expect(r2.list![0].label).toBe('Phantom') // newest first
    expect(loadAddresses()).toHaveLength(2)
  })

  test('removeAddress drops the entry by id', () => {
    const id = saveAddress('A', EVM).list![0].id
    expect(removeAddress(id)).toHaveLength(0)
    expect(loadAddresses()).toHaveLength(0)
  })

  test('loadAddresses tolerates corrupt storage (never throws)', () => {
    localStorage.setItem('pulsetrade.addresses', '{ not json')
    expect(loadAddresses()).toEqual([])
  })
})
