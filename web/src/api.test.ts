import { describe, test, expect, vi, afterEach } from 'vitest'

// installApiAuth wraps window.fetch to attach the engine token on MUTATING /api calls only.
// A regression here silently breaks every authenticated POST/PATCH/DELETE, so it's worth a guard.
describe('installApiAuth', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('attaches Bearer on mutating /api requests; leaves GET, and non-/api URLs, untouched', async () => {
    vi.stubEnv('VITE_ENGINE_TOKEN', 'secret-tok')
    vi.resetModules()
    const { installApiAuth } = await import('./api')

    const calls: { url: string; init?: RequestInit }[] = []
    const spy = vi.fn((input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return Promise.resolve(new Response('{}'))
    })
    window.fetch = spy as unknown as typeof fetch
    installApiAuth()

    await window.fetch('/api/mode', { method: 'POST' })
    await window.fetch('/api/state') // GET — no auth
    await window.fetch('https://evil.example/api/mode', { method: 'POST' }) // not a same-origin /api path

    const auth = (i?: RequestInit) => new Headers(i?.headers).get('authorization')
    expect(auth(calls[0].init)).toBe('Bearer secret-tok')
    expect(auth(calls[1].init)).toBeNull()
    expect(auth(calls[2].init)).toBeNull()
  })

  test('no token configured → fetch is left completely untouched', async () => {
    vi.stubEnv('VITE_ENGINE_TOKEN', '')
    vi.resetModules()
    const { installApiAuth } = await import('./api')
    const spy = vi.fn(() => Promise.resolve(new Response('{}')))
    window.fetch = spy as unknown as typeof fetch
    installApiAuth()
    expect(window.fetch).toBe(spy) // returned early, did not wrap
  })
})
