/** Store actions that open a tool panel/modal — every tool maps to one. */
export type ToolAction = 'openFinder' | 'openAi' | 'openTournament' | 'openSniper' | 'openSwap' | 'openCalc' | 'openDocs' | 'openTour'

export interface ToolItem {
  /** Stable key, also used to filter (e.g. drop Sniper from the mobile sheet). */
  action: ToolAction
  icon: string
  label: string
  sub: string
  /** 'feature' tools sit above the 'help' group, separated by a divider. */
  group: 'feature' | 'help'
}

/**
 * Single source of truth for the secondary tools surfaced in both the desktop
 * "Tools" menu (Header) and the mobile "More" sheet (BottomNav). Keeping one
 * list means a new tool shows up everywhere by adding a single entry.
 */
export const TOOL_ITEMS: ToolItem[] = [
  { action: 'openSwap', icon: '🔄', label: 'Swap', sub: 'Swap any token instantly, on-chain via 0x', group: 'feature' },
  { action: 'openCalc', icon: '🧮', label: 'Profit Calculator', sub: 'See your profit at any exit price — instant, visual', group: 'feature' },
  { action: 'openFinder', icon: '💡', label: 'Profit Finder', sub: 'Backtest every strategy and rank by profit', group: 'feature' },
  { action: 'openSniper', icon: '🎯', label: 'Sniper', sub: 'Snipe new tokens, auto-screened for rugs', group: 'feature' },
  { action: 'openAi', icon: '🤖', label: 'AI Trader', sub: 'Let Gemini call buy / sell / hold', group: 'feature' },
  { action: 'openTournament', icon: '🏆', label: 'Tournament', sub: 'Bots compete for the best return', group: 'feature' },
  { action: 'openDocs', icon: '📖', label: 'Documentation', sub: 'How everything works', group: 'help' },
  { action: 'openTour', icon: '✨', label: 'Welcome tour', sub: 'Replay the onboarding', group: 'help' },
]
