// Auth for state-changing engine calls. When VITE_ENGINE_TOKEN is set (and the
// engine has the matching ENGINE_TOKEN), every mutating /api request must carry
// it. We wrap fetch once here rather than threading a header through ~18 call
// sites — impossible to miss one, and read-only GETs / the WS feed are untouched.
const TOKEN = import.meta.env.VITE_ENGINE_TOKEN as string | undefined

export function installApiAuth() {
  if (!TOKEN) return
  const orig = window.fetch.bind(window)
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        const headers = new Headers(init?.headers)
        headers.set('authorization', `Bearer ${TOKEN}`)
        return orig(input, { ...init, headers })
      }
    }
    return orig(input, init)
  }
}
