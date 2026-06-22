// Shared address-shape validators. Single source of truth so the engine and the
// portfolio reader agree on what a well-formed address looks like (a drifting copy
// could accept an address one path rejects). Shape-only — these do NOT verify an
// EVM checksum or that a Solana key is on-curve; callers that need that do it separately.

/** A 20-byte EVM address: `0x` + 40 hex chars. */
export const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/
/** A base58 Solana address (32–44 chars, no 0/O/I/l). */
export const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** An ICP principal: 5-char groups joined by dashes (e.g. `aaaaa-aa`). */
export const ICP_PRINCIPAL = /^[a-z0-9]{5}(-[a-z0-9]{3,5})+$/
/** A CoinGecko coin id / safe token symbol that gets interpolated into an outbound URL.
 *  Strict allowlist (alnum + . _ -) so a path-param can't break out of the path/query
 *  (no `/`, `?`, `#`, `:` or spaces) — validation at the route boundary, not escaping. */
export const CG_ID = /^[a-zA-Z0-9._-]{1,100}$/
/** True when `a` is a well-formed address on ANY supported chain (EVM / Solana / ICP). */
export const isKnownAddress = (a: string): boolean => EVM_ADDR.test(a) || SOL_ADDR.test(a) || ICP_PRINCIPAL.test(a)
