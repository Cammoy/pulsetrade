import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BottomNav from './BottomNav'
import { useStore } from '../store'

describe('BottomNav (mobile)', () => {
  const setView = vi.fn()
  const openNewBot = vi.fn()
  const openMore = vi.fn()
  beforeEach(() => {
    setView.mockReset(); openNewBot.mockReset(); openMore.mockReset()
    useStore.setState({ view: 'home', moreOpen: false, setView, openNewBot, openMore })
  })

  test('renders the tabs + center New-bot action and marks the active view', () => {
    render(<BottomNav />)
    for (const name of ['Bots', 'Wallet', 'Market', 'More', 'New bot'])
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bots' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Market' })).not.toHaveAttribute('aria-current')
  })

  test('tabs route, + opens the New-bot hub, More opens the sheet', async () => {
    const user = userEvent.setup()
    render(<BottomNav />)
    await user.click(screen.getByRole('button', { name: 'Market' }))
    expect(setView).toHaveBeenCalledWith('market')
    await user.click(screen.getByRole('button', { name: 'New bot' }))
    expect(openNewBot).toHaveBeenCalledWith(true)
    await user.click(screen.getByRole('button', { name: 'More' }))
    expect(openMore).toHaveBeenCalledWith(true)
  })
})
