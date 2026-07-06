import { describe, test, expect } from 'vitest'
import { hashForState, parseHash } from './routing'

const base = { portfolioTab: 'holdings' as const, selectedBotId: null }

describe('routing', () => {
  test('hashForState maps channels, the portfolio sub-tab, and an open bot', () => {
    expect(hashForState({ ...base, view: 'home' })).toBe('')
    expect(hashForState({ ...base, view: 'copy' })).toBe('copy-trade')
    expect(hashForState({ ...base, view: 'smart' })).toBe('smart-money')
    expect(hashForState({ ...base, view: 'portfolio', portfolioTab: 'wallet' })).toBe('portfolio/wallet')
    expect(hashForState({ ...base, view: 'copy', selectedBotId: 'b1' })).toBe('bot/b1') // an open bot wins
  })

  test('parseHash reads channels, sub-tabs, bot ids, and ignores junk', () => {
    expect(parseHash('#copy-trade')).toEqual({ view: 'copy', botId: null })
    expect(parseHash('')).toEqual({ view: 'home', botId: null })
    expect(parseHash('#bots')).toEqual({ view: 'home', botId: null })
    expect(parseHash('#portfolio/withdraw')).toEqual({ view: 'portfolio', portfolioTab: 'withdraw', botId: null })
    expect(parseHash('#portfolio/earn')).toEqual({ view: 'portfolio', portfolioTab: 'earn', botId: null })
    expect(parseHash('#portfolio')).toEqual({ view: 'portfolio', portfolioTab: undefined, botId: null })
    expect(parseHash('#bot/abc')).toEqual({ botId: 'abc' })
    expect(parseHash('#nonsense')).toEqual({}) // unknown → leave state untouched
  })

  test('round-trips every channel', () => {
    for (const view of ['home', 'market', 'smart', 'copy', 'signals', 'trade', 'docs'] as const)
      expect(parseHash(`#${hashForState({ ...base, view })}`).view).toBe(view)
    expect(parseHash(`#${hashForState({ ...base, view: 'portfolio', portfolioTab: 'staking' })}`)).toMatchObject({ view: 'portfolio', portfolioTab: 'staking' })
    expect(parseHash(`#${hashForState({ ...base, view: 'portfolio', portfolioTab: 'earn' })}`)).toMatchObject({ view: 'portfolio', portfolioTab: 'earn' })
  })
})
