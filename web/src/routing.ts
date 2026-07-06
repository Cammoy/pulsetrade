import { useEffect } from 'react'
import { useStore } from './store'

// Bookmarkable URLs via the location hash, two-way synced with the store. Pick a channel (or the
// portfolio sub-tab, or an open bot) and the URL updates; load/refresh/back-forward restore it.
//   #              or #bots      → bots (home)
//   #market #smart-money #copy-trade #docs
//   #portfolio/holdings | wallet | staking | earn | withdraw
//   #bot/<id>                    → that bot's detail overlay

export type View = 'home' | 'market' | 'smart' | 'copy' | 'signals' | 'trade' | 'portfolio' | 'docs'
export type PortfolioTab = 'holdings' | 'wallet' | 'staking' | 'earn' | 'withdraw'

const VIEW_SLUG: Record<Exclude<View, 'home'>, string> = { market: 'market', smart: 'smart-money', copy: 'copy-trade', signals: 'signals', trade: 'trade', portfolio: 'portfolio', docs: 'docs' }
const SLUG_VIEW: Record<string, View> = { '': 'home', bots: 'home', market: 'market', 'smart-money': 'smart', 'copy-trade': 'copy', signals: 'signals', trade: 'trade', portfolio: 'portfolio', docs: 'docs' }
const PORT_TABS = new Set<PortfolioTab>(['holdings', 'wallet', 'staking', 'earn', 'withdraw'])

export interface RouteState { view: View; portfolioTab: PortfolioTab; selectedBotId: string | null }

/** The hash slug (no leading '#') for the current routable state. */
export function hashForState(s: RouteState): string {
  if (s.selectedBotId) return `bot/${s.selectedBotId}`
  if (s.view === 'portfolio') return `portfolio/${s.portfolioTab}`
  if (s.view === 'home') return ''
  return VIEW_SLUG[s.view]
}

export interface ParsedRoute { view?: View; portfolioTab?: PortfolioTab; botId?: string | null }

/** Parse a location hash into the state it should drive. `botId: null` ⇒ close any open detail;
 *  an empty object ⇒ unrecognised, leave everything as-is. */
export function parseHash(hash: string): ParsedRoute {
  const [head, sub] = hash.replace(/^#/, '').split('/')
  if (head === 'bot') return { botId: sub || null }
  const view = SLUG_VIEW[head]
  if (!view) return {}
  if (view === 'portfolio') return { view, portfolioTab: sub && PORT_TABS.has(sub as PortfolioTab) ? (sub as PortfolioTab) : undefined, botId: null }
  return { view, botId: null }
}

/** Two-way bind the hash ↔ store. Runs once the app is `ready` (so bots exist for #bot/<id>). */
export function useHashRoute(ready: boolean): void {
  useEffect(() => {
    if (!ready) return
    // URL → store (initial load + back/forward).
    const apply = () => {
      const r = parseHash(window.location.hash)
      const st = useStore.getState()
      if (r.view && r.view !== st.view) st.setView(r.view)
      if (r.portfolioTab && r.portfolioTab !== st.portfolioTab) st.setPortfolioTab(r.portfolioTab)
      if (r.botId !== undefined) {
        const target = r.botId && st.bots.some((b) => b.id === r.botId) ? r.botId : null
        if (st.selectedBotId !== target) st.selectBot(target)
      }
    }
    apply()
    window.addEventListener('popstate', apply)
    // store → URL (pushState makes back/forward work; it doesn't fire popstate, so no echo loop).
    const sync = () => {
      const s = useStore.getState()
      const slug = hashForState({ view: s.view, portfolioTab: s.portfolioTab, selectedBotId: s.selectedBotId })
      const want = slug ? `#${slug}` : ''
      if (window.location.hash !== want) window.history.pushState(null, '', want || window.location.pathname + window.location.search)
    }
    const unsub = useStore.subscribe(sync)
    return () => {
      window.removeEventListener('popstate', apply)
      unsub()
    }
  }, [ready])
}
