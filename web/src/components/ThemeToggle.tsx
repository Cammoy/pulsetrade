import { useStore } from '../store'
import type { ThemePref } from '../theme'

/**
 * Light / Dark / Auto segmented toggle — shared by the mobile Header and the
 * desktop ChannelHeader. Uses the shared `.seg-track` shell with a static
 * `.seg-active` highlight on the selected option (ModeSwitch, by contrast, slides
 * a measured pill between its two segments). "Auto" follows the OS scheme
 * (re-applied live by watchSystem()). Icon-only to stay compact on the phone top bar.
 */
const OPTS: { v: ThemePref; label: string; icon: JSX.Element }[] = [
  {
    v: 'light',
    label: 'Light',
    icon: (
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    ),
  },
  {
    v: 'dark',
    label: 'Dark',
    icon: (
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" stroke="none">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
      </svg>
    ),
  },
  {
    v: 'system',
    label: 'Auto',
    icon: (
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="4" width="19" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    ),
  },
]

export default function ThemeToggle() {
  const { theme, setTheme } = useStore()
  return (
    <div className="seg-track flex items-center p-0.5" role="group" aria-label="Theme">
      {OPTS.map((o) => {
        const active = theme === o.v
        return (
          <button
            key={o.v}
            onClick={() => setTheme(o.v)}
            aria-pressed={active}
            title={`${o.label} theme`}
            className={`tap flex h-7 w-7 cursor-pointer items-center justify-center rounded-[10px] transition-all ${
              active ? 'seg-active' : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            {o.icon}
          </button>
        )
      })}
    </div>
  )
}
