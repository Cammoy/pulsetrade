// Network wrapper around the pure assess() scorer: calls GoPlus + honeypot.is,
// caches reports for 5 minutes, and tolerates either provider being down.
import { assess, type RiskReport } from './risk-screen.js'
import { networkById, tokenOf } from './networks.js'

const cache = new Map<string, { at: number; report: RiskReport }>()
const TTL = 300_000

async function getJson(url: string, ms = 8000): Promise<any | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchGoPlus(chainId: number, address: string): Promise<Record<string, any> | null> {
  const data = await getJson(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`)
  const result = data?.result
  if (!result) return null
  // keys are lowercased addresses
  const key = Object.keys(result).find((k) => k.toLowerCase() === address.toLowerCase())
  return key ? result[key] : null
}

async function fetchHoneypot(chainId: number, address: string): Promise<Record<string, any> | null> {
  return getJson(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${chainId}`)
}

/** Screen an arbitrary token address on a known network. Cached 5 min. */
export async function screenAddress(network: string, address: string, symbol?: string): Promise<RiskReport> {
  const net = networkById(network)
  if (!net) {
    return {
      network, chainId: 0, token: symbol ?? address, score: 0, verdict: 'danger', tradeable: false,
      flags: [{ id: 'bad-network', label: 'Unknown network', detail: 'Network not supported.', severity: 'critical' }],
      positives: [], buyTaxPct: null, sellTaxPct: null, sources: [], checkedAt: Date.now(), error: 'unknown network',
    }
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return {
      network, chainId: net.chainId, token: symbol ?? address, score: 0, verdict: 'danger', tradeable: false,
      flags: [{ id: 'bad-address', label: 'Invalid token address', detail: 'Not a valid contract address.', severity: 'critical' }],
      positives: [], buyTaxPct: null, sellTaxPct: null, sources: [], checkedAt: Date.now(), error: 'invalid address',
    }
  }

  const cacheKey = `${net.chainId}:${address.toLowerCase()}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < TTL) return hit.report

  const [gp, hp] = await Promise.all([fetchGoPlus(net.chainId, address), fetchHoneypot(net.chainId, address)])
  const report = assess({ network: net.id, chainId: net.chainId, token: symbol ?? address }, gp, hp)
  cache.set(cacheKey, { at: Date.now(), report })
  return report
}

/** Screen one of the curated tokens by network + symbol. */
export async function screenToken(network: string, symbol: string): Promise<RiskReport> {
  const tok = tokenOf(network, symbol)
  if (!tok) {
    const net = networkById(network)
    return {
      network, chainId: net?.chainId ?? 0, token: symbol, score: 0, verdict: 'danger', tradeable: false,
      flags: [{ id: 'unknown-token', label: 'Unknown token', detail: 'Token not found on this network.', severity: 'critical' }],
      positives: [], buyTaxPct: null, sellTaxPct: null, sources: [], checkedAt: Date.now(), error: 'unknown token',
    }
  }
  const report = await screenAddress(network, tok.address, symbol)
  return { ...report, token: symbol }
}
