import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import NewBotHub from './NewBotHub'
import { useStore } from '../store'

describe('NewBotHub', () => {
  beforeEach(() => {
    useStore.setState({
      newBotOpen: true,
      openNewBot: vi.fn(),
      openWizard: vi.fn(),
      openAi: vi.fn(),
      openFinder: vi.fn(),
      openSniper: vi.fn(),
      openTournament: vi.fn(),
    })
  })

  test('lists all five creation methods', () => {
    render(<NewBotHub />)
    expect(screen.getByText('Build from scratch')).toBeInTheDocument()
    expect(screen.getByText('AI Trader')).toBeInTheDocument()
    expect(screen.getByText('Profit Finder')).toBeInTheDocument()
    expect(screen.getByText('Sniper')).toBeInTheDocument()
    expect(screen.getByText('Tournament')).toBeInTheDocument()
  })

  // Each card closes the hub, then opens exactly its target modal — and no other.
  const cases = [
    { label: 'Build from scratch', action: 'openWizard' },
    { label: 'AI Trader', action: 'openAi' },
    { label: 'Profit Finder', action: 'openFinder' },
    { label: 'Sniper', action: 'openSniper' },
    { label: 'Tournament', action: 'openTournament' },
  ] as const

  for (const { label, action } of cases) {
    test(`"${label}" routes to ${action} and closes the hub`, () => {
      render(<NewBotHub />)
      fireEvent.click(screen.getByText(label))
      const s = useStore.getState()
      expect((s[action] as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(true)
      expect(s.openNewBot).toHaveBeenCalledWith(false)
      // none of the *other* creation modals were opened
      for (const other of cases) {
        if (other.action !== action) expect((s[other.action] as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
      }
    })
  }

  test('the ✕ button closes the hub', () => {
    render(<NewBotHub />)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(useStore.getState().openNewBot).toHaveBeenCalledWith(false)
  })
})
