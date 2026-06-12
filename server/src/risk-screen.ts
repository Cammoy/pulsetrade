// Pre-trade risk assessment. Screens an on-chain token for rug pulls,
// honeypots, non-sellable contracts and related exploits BEFORE any buy.
//
// Two free public data sources, used together so one being down or blind to a
// token does not silently pass it:
//   - GoPlus Security token_security  (contract abilities, taxes, LP, holders)
//   - honeypot.is                     (simulated buy/sell — catches honeypots)
//
// The scoring core (assess()) is a PURE function of the provider payloads, so
// it is fully unit-tested without network access. Fetching is a thin wrapper.

export type Severity = 'safe' | 'caution' | 'danger'

export interface RiskFlag {
  id: string
  label: string
  detail: string
  severity: 'info' | 'warn' | 'critical'
}

export interface RiskReport {
  network: string
  chainId: number
  token: string
  score: number // 0 (lethal) … 100 (clean)
  verdict: Severity
  tradeable: boolean // false ⇒ buys are blocked outright
  flags: RiskFlag[]
  positives: string[]
  buyTaxPct: number | null
  sellTaxPct: number | null
  sources: string[] // which providers actually answered
  checkedAt: number
  error?: string
}

const GP = (v: unknown) => v === '1'
const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Pure scoring over already-fetched provider payloads.
 * @param gp   GoPlus result object for the token (or null if unavailable)
 * @param hp   honeypot.is response (or null if unavailable)
 */
export function assess(
  ctx: { network: string; chainId: number; token: string },
  gp: Record<string, any> | null,
  hp: Record<string, any> | null,
): RiskReport {
  const flags: RiskFlag[] = []
  const positives: string[] = []
  const sources: string[] = []
  let score = 100

  const cut = (n: number, flag: RiskFlag) => {
    score -= n
    flags.push(flag)
  }

  // ── honeypot.is: the single most important check — can you actually sell? ──
  let hpSaysHoneypot = false
  if (hp && (hp.honeypotResult || hp.simulationResult || hp.simulationSuccess !== undefined)) {
    sources.push('honeypot.is')
    const isHp = hp.honeypotResult?.isHoneypot === true
    if (isHp) {
      hpSaysHoneypot = true
      cut(100, {
        id: 'honeypot',
        label: 'Honeypot — cannot sell',
        detail: hp.honeypotResult?.honeypotReason || 'Sell simulation failed: you could buy but not sell this token.',
        severity: 'critical',
      })
    } else if (hp.simulationSuccess === true || hp.simulationResult) {
      positives.push('Sell simulation succeeded (not a honeypot)')
    }
    const bt = num(hp.simulationResult?.buyTax)
    const st = num(hp.simulationResult?.sellTax)
    if (st !== null && st >= 50) cut(60, { id: 'sell-tax-extreme', label: `Extreme sell tax ${st.toFixed(0)}%`, detail: 'A sell tax this high is a soft honeypot — most of your proceeds are confiscated on exit.', severity: 'critical' })
    else if (st !== null && st >= 15) cut(25, { id: 'sell-tax-high', label: `High sell tax ${st.toFixed(1)}%`, detail: 'A large cut is taken when you sell.', severity: 'warn' })
    if (bt !== null && bt >= 15) cut(12, { id: 'buy-tax-high', label: `High buy tax ${bt.toFixed(1)}%`, detail: 'A large cut is taken when you buy in.', severity: 'warn' })
  }

  // ── GoPlus: contract abilities, taxes, liquidity, holders ──────────────────
  let gpBuyTax: number | null = null
  let gpSellTax: number | null = null
  if (gp && Object.keys(gp).length) {
    sources.push('GoPlus')

    if (GP(gp.is_honeypot) && !hpSaysHoneypot)
      cut(100, { id: 'honeypot-gp', label: 'Flagged as honeypot', detail: 'GoPlus classifies this contract as a honeypot — selling is likely blocked.', severity: 'critical' })

    if (GP(gp.cannot_sell_all))
      cut(70, { id: 'cannot-sell-all', label: 'Cannot sell entire balance', detail: 'The contract prevents selling 100% of your holding — a partial-honeypot pattern.', severity: 'critical' })

    if (GP(gp.transfer_pausable))
      cut(35, { id: 'pausable', label: 'Transfers can be paused', detail: 'The owner can freeze all transfers, trapping your funds at will.', severity: 'critical' })

    if (GP(gp.is_blacklisted) || GP(gp.is_whitelisted))
      cut(30, { id: 'allowlist', label: 'Address allow/deny list', detail: 'The contract can blacklist (or selectively whitelist) addresses, i.e. block your wallet from selling.', severity: 'critical' })

    if (GP(gp.is_mintable))
      cut(22, { id: 'mintable', label: 'Supply is mintable', detail: 'The owner can mint new tokens and dilute holders to zero.', severity: 'warn' })

    if (GP(gp.selfdestruct))
      cut(40, { id: 'selfdestruct', label: 'Self-destructible contract', detail: 'The contract can be destroyed, which can render the token worthless instantly.', severity: 'critical' })

    if (GP(gp.hidden_owner))
      cut(30, { id: 'hidden-owner', label: 'Hidden owner', detail: 'Ownership is obscured — "renounced" may be cosmetic while real control is retained.', severity: 'critical' })

    if (GP(gp.can_take_back_ownership))
      cut(25, { id: 'reclaim-owner', label: 'Ownership can be reclaimed', detail: 'Even if renounced, the owner can take control back later.', severity: 'warn' })

    if (GP(gp.owner_change_balance))
      cut(45, { id: 'owner-balance', label: 'Owner can edit balances', detail: 'The owner can change any holder\'s balance — they can zero out yours.', severity: 'critical' })

    if (GP(gp.is_proxy))
      cut(12, { id: 'proxy', label: 'Upgradeable proxy', detail: 'Contract logic can be swapped after launch — audited code is not a guarantee.', severity: 'warn' })

    if (GP(gp.trading_cooldown))
      cut(8, { id: 'cooldown', label: 'Trading cooldown', detail: 'Enforced delay between trades can interfere with timely exits.', severity: 'warn' })

    if (GP(gp.is_anti_whale) && GP(gp.anti_whale_modifiable))
      cut(10, { id: 'antiwhale', label: 'Modifiable max-tx limit', detail: 'The owner can shrink the max sell amount to throttle exits.', severity: 'warn' })

    gpBuyTax = num(gp.buy_tax) !== null ? num(gp.buy_tax)! * 100 : null
    gpSellTax = num(gp.sell_tax) !== null ? num(gp.sell_tax)! * 100 : null
    if (gpSellTax !== null && gpSellTax >= 50 && !flags.some((f) => f.id.startsWith('sell-tax')))
      cut(60, { id: 'sell-tax-extreme-gp', label: `Extreme sell tax ${gpSellTax.toFixed(0)}%`, detail: 'Most proceeds are taken on exit — effectively a honeypot.', severity: 'critical' })
    else if (gpSellTax !== null && gpSellTax >= 15 && !flags.some((f) => f.id.startsWith('sell-tax')))
      cut(20, { id: 'sell-tax-high-gp', label: `High sell tax ${gpSellTax.toFixed(1)}%`, detail: 'A large cut is taken when you sell.', severity: 'warn' })

    // Liquidity / rug-pull signals
    const open = GP(gp.is_open_source)
    if (gp.is_open_source !== undefined && !open)
      cut(20, { id: 'closed-source', label: 'Unverified contract', detail: 'Source code is not published — its behaviour cannot be reviewed.', severity: 'warn' })
    else if (open) positives.push('Verified open-source contract')

    const lpLocked = num(gp.lp_holder_count) !== null ? lpLockedPct(gp) : null
    if (lpLocked !== null) {
      if (lpLocked >= 95) positives.push(`${lpLocked.toFixed(0)}% of LP locked/burned`)
      else if (lpLocked < 50) cut(30, { id: 'lp-unlocked', label: `Only ${lpLocked.toFixed(0)}% of LP locked`, detail: 'Most liquidity is removable — classic rug-pull setup; the team can pull the pool.', severity: 'critical' })
      else cut(12, { id: 'lp-partial', label: `${lpLocked.toFixed(0)}% of LP locked`, detail: 'A meaningful share of liquidity can still be withdrawn.', severity: 'warn' })
    }

    const topPct = num(gp.holder_count) !== null ? topHolderPct(gp) : null
    if (topPct !== null && topPct >= 50)
      cut(18, { id: 'concentrated', label: `Top holder owns ${topPct.toFixed(0)}%`, detail: 'A single wallet holds enough to crash the price by dumping.', severity: 'warn' })

    if (num(gp.holder_count) !== null && num(gp.holder_count)! < 25)
      cut(10, { id: 'few-holders', label: `Only ${gp.holder_count} holders`, detail: 'Very few holders — illiquid and easy to manipulate.', severity: 'warn' })

    if (GP(gp.is_in_dex)) positives.push('Listed on a DEX with a live pool')
  }

  const buyTaxPct = gpBuyTax ?? num(hp?.simulationResult?.buyTax)
  const sellTaxPct = gpSellTax ?? num(hp?.simulationResult?.sellTax)

  if (sources.length === 0) {
    return {
      network: ctx.network, chainId: ctx.chainId, token: ctx.token,
      score: 0, verdict: 'danger', tradeable: false, flags: [
        { id: 'no-data', label: 'No safety data available', detail: 'Neither security provider returned data for this token. Treating as unsafe — do not trade blind.', severity: 'critical' },
      ], positives: [], buyTaxPct: null, sellTaxPct: null, sources, checkedAt: Date.now(),
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const hasCritical = flags.some((f) => f.severity === 'critical')
  const verdict: Severity = hasCritical || score < 40 ? 'danger' : score < 75 ? 'caution' : 'safe'
  // Anything with a critical flag is non-tradeable, full stop.
  const tradeable = !hasCritical && score >= 40

  return {
    network: ctx.network, chainId: ctx.chainId, token: ctx.token,
    score, verdict, tradeable, flags, positives, buyTaxPct, sellTaxPct, sources, checkedAt: Date.now(),
  }
}

function lpLockedPct(gp: Record<string, any>): number | null {
  const holders = gp.lp_holders
  if (!Array.isArray(holders) || holders.length === 0) return null
  let locked = 0
  let total = 0
  for (const h of holders) {
    const pct = Number(h.percent)
    if (!Number.isFinite(pct)) continue
    total += pct
    if (h.is_locked === 1 || h.is_locked === '1' || /0x0{40}|dead/i.test(String(h.address))) locked += pct
  }
  return total > 0 ? (locked / total) * 100 : null
}

function topHolderPct(gp: Record<string, any>): number | null {
  const holders = gp.holders
  if (!Array.isArray(holders) || holders.length === 0) return null
  const pct = Number(holders[0]?.percent)
  return Number.isFinite(pct) ? pct * 100 : null
}
