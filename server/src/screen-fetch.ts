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
  const map = await batchGoPlus(chainId, [address])
  return map.get(address.toLowerCase()) ?? null
}

// GoPlus's anonymous tier silently returns only ONE result per call even when
// many comma-separated addresses are sent (verified empirically). So "batch"
// means: dedupe, serve from a 1h cache, and fan out single-address requests
// with bounded concurrency for the misses.
const gpCache = new Map<string, { at: number; gp: Record<string, any> }>()
const GP_TTL = 3_600_000
const GP_CONCURRENCY = 3

export async function batchGoPlus(chainId: number, addresses: string[]): Promise<Map<string, Record<string, any>>> {
  const out = new Map<string, Record<string, any>>()
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))]
  const missing: string[] = []
  for (const a of wanted) {
    const hit = gpCache.get(`${chainId}:${a}`)
    if (hit && Date.now() - hit.at < GP_TTL) out.set(a, hit.gp)
    else missing.push(a)
  }
  let i = 0
  const worker = async () => {
    while (i < missing.length) {
      const a = missing[i++]
      const data = await getJson(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${a}`, 12000)
      const result = data?.result
      const key = result && Object.keys(result).find((k) => k.toLowerCase() === a)
      if (key) {
        out.set(a, result[key])
        gpCache.set(`${chainId}:${a}`, { at: Date.now(), gp: result[key] })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(GP_CONCURRENCY, missing.length) }, worker))
  return out
}

async function fetchHoneypot(chainId: number, address: string): Promise<Record<string, any> | null> {
  return getJson(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${chainId}`)
}

/**
 * Non-EVM networks (Solana, ICP): our screening providers are EVM-only, so we
 * return an honest advisory report. Curated coins there are major, established
 * assets, so paper bots may trade them (tradeable: true) — but the report
 * clearly says no contract-level screen ran.
 */
function nonEvmAdvisory(network: string, token: string): RiskReport {
  return {
    network, chainId: 0, token, score: 50, verdict: 'caution', tradeable: true,
    flags: [{
      id: 'screening-unavailable',
      label: 'Contract screening unavailable on this network',
      detail: 'Honeypot/rug screening providers cover EVM chains only. Only the curated, established coins are offered here; sniping arbitrary tokens is disabled.',
      severity: 'warn',
    }],
    positives: [], buyTaxPct: null, sellTaxPct: null, sources: [], checkedAt: Date.now(),
  }
}

/** Screen an arbitrary token address on a known network. Cached 5 min.
 *  `strict` runs the SNIPER-grade screen (both providers required, proxy/reclaim
 *  blocking) — pass it from the live-buy gate, not the informational UI report. */
export async function screenAddress(network: string, address: string, symbol?: string, strict = false): Promise<RiskReport> {
  const net = networkById(network)
  if (net && !net.evm) return nonEvmAdvisory(network, symbol ?? address)
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

  // The strict verdict differs from the lenient one, so they must cache separately —
  // otherwise a UI report could serve a sniper a lenient pass (or vice versa).
  const cacheKey = `${net.chainId}:${address.toLowerCase()}:${strict ? 's' : 'n'}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < TTL) return hit.report

  const [gp, hp] = await Promise.all([fetchGoPlus(net.chainId, address), fetchHoneypot(net.chainId, address)])
  const report = assess({ network: net.id, chainId: net.chainId, token: symbol ?? address }, gp, hp, strict)
  cache.set(cacheKey, { at: Date.now(), report })
  return report
}

/**
 * Screen with an already-fetched GoPlus payload (from a batch call) — only the
 * honeypot.is leg is fetched. Caches into the same report cache so a later
 * screenAddress() (e.g. inside createSniper) is served instantly.
 */
export async function screenPrefetched(
  network: string,
  address: string,
  symbol: string,
  gp: Record<string, any> | null,
): Promise<RiskReport> {
  const net = networkById(network)
  if (!net) return screenAddress(network, address, symbol) // delegates to error path
  // Non-strict (display) report — share the cache slot with screenAddress(strict=false).
  const cacheKey = `${net.chainId}:${address.toLowerCase()}:n`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < TTL) return hit.report
  const hp = await fetchHoneypot(net.chainId, address)
  const report = assess({ network: net.id, chainId: net.chainId, token: symbol }, gp, hp)
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
