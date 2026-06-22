// Theme: dark (default identity) / light / system, persisted to localStorage and
// applied as a class on <html>. The no-flash boot script in index.html applies the
// stored choice before paint; this module keeps it in sync at runtime.

export type ThemePref = 'dark' | 'light' | 'system'
const KEY = 'pulsetrade.theme'

export function getStoredTheme(): ThemePref {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' || t === 'system' ? t : 'system'
  } catch {
    return 'system'
  }
}

export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  return pref
}

export function applyTheme(pref: ThemePref) {
  const eff = resolveTheme(pref)
  const root = document.documentElement
  root.classList.toggle('dark', eff === 'dark')
  root.classList.toggle('light', eff === 'light')
  root.style.colorScheme = eff
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', eff === 'light' ? '#eef1f6' : '#070a12')
}

export function setTheme(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref)
  } catch {
    /* private mode — apply for the session anyway */
  }
  applyTheme(pref)
}

/** Re-apply when the OS scheme changes while we're following 'system'. */
export function watchSystem() {
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getStoredTheme() === 'system') applyTheme('system')
  })
}
