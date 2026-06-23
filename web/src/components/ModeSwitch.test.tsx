import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ModeSwitch from './ModeSwitch'
import { useStore } from '../store'
import type { Meta } from '../types'

// The single most important front-end guard: a user must NEVER end up in live
// trading by accident. Arming live requires a ready signer AND an explicit confirm.
// Confirmation now goes through the in-app dialog (store.confirm → ConfirmDialog),
// not the blocking native window.confirm — so the tests mock store.confirm.
describe('ModeSwitch — live-arming guard', () => {
  beforeEach(() => {
    useStore.setState({ mode: 'paper', meta: { live: { ready: true } } as Meta })
  })

  test('cancelling the confirm leaves the app in PAPER (no accidental real trading)', async () => {
    const setMode = vi.fn()
    const confirm = vi.fn().mockResolvedValue(false) // user clicks Cancel
    useStore.setState({ setMode, confirm })
    render(<ModeSwitch />)

    await userEvent.click(screen.getByRole('button', { name: /Live/i }))

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(setMode).not.toHaveBeenCalled() // never armed live
  })

  test('accepting the confirm arms live', async () => {
    const setMode = vi.fn().mockResolvedValue({})
    const confirm = vi.fn().mockResolvedValue(true)
    useStore.setState({ setMode, confirm })
    render(<ModeSwitch />)

    await userEvent.click(screen.getByRole('button', { name: /Live/i }))

    await waitFor(() => expect(setMode).toHaveBeenCalledWith('live'))
  })

  test('with no signer ready, live is locked: it notifies and never switches', async () => {
    const setMode = vi.fn()
    const notify = vi.fn()
    const confirm = vi.fn().mockResolvedValue(true)
    useStore.setState({ setMode, notify, confirm, meta: { live: { ready: false } } as Meta })
    render(<ModeSwitch />)

    await userEvent.click(screen.getByRole('button', { name: /Live/i }))

    await waitFor(() => expect(notify).toHaveBeenCalled()) // tells the user which keys to add
    expect(confirm).not.toHaveBeenCalled() // never even prompts
    expect(setMode).not.toHaveBeenCalled()
  })

  test('clicking Paper while already in paper is a no-op', async () => {
    const setMode = vi.fn()
    useStore.setState({ setMode, mode: 'paper' })
    render(<ModeSwitch />)
    await userEvent.click(screen.getByRole('button', { name: /Paper/i }))
    expect(setMode).not.toHaveBeenCalled()
  })
})
