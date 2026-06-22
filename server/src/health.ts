// Observability: a provider heartbeat registry + a single env-gated outbound notifier.
// Powers GET /health (a dead-man check the operator or a monitor can poll) and fires an
// alert on the events that mean an unattended live account needs a human: a bot halted,
// the circuit breaker tripped, the tick loop stalled, an untrusted ledger, and process
// start/stop. Pure/no engine deps so it imports cleanly from anywhere. [P1-14]

// ── Provider heartbeat ───────────────────────────────────────────────────────
// Money-path fetch wrappers call markProvider() so /health can show a degraded
// dependency (e.g. CoinGecko 429-storming, 0x down) before it silently stalls trading.
export interface ProviderStat { lastOkAt: number; lastErrAt: number; lastError?: string }
const providers = new Map<string, ProviderStat>()

export function markProvider(name: string, ok: boolean, error?: string): void {
  const s = providers.get(name) ?? { lastOkAt: 0, lastErrAt: 0 }
  if (ok) s.lastOkAt = Date.now()
  else {
    s.lastErrAt = Date.now()
    s.lastError = error ? String(error).slice(0, 200) : undefined
  }
  providers.set(name, s)
}

export function providerHealth(now = Date.now()): Array<{ name: string; lastOkAgoMs: number | null; lastErrAgoMs: number | null; lastError?: string }> {
  return [...providers.entries()].map(([name, s]) => ({
    name,
    lastOkAgoMs: s.lastOkAt ? now - s.lastOkAt : null,
    lastErrAgoMs: s.lastErrAt ? now - s.lastErrAt : null,
    lastError: s.lastError,
  }))
}

/** Test seam — clear the registry between cases. */
export function __resetProviders(): void {
  providers.clear()
}

// ── Outbound notifier ────────────────────────────────────────────────────────
// Two optional transports: a generic JSON webhook (ALERT_WEBHOOK_URL) and/or Telegram
// (ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID). Fire-and-forget, timeout-bounded,
// never throws — alerting must never break the engine. Duplicate events are throttled so
// a flapping dependency can't spam the channel.
const lastSent = new Map<string, number>()
const THROTTLE_MS = 60_000

export function alertConfigured(): boolean {
  return Boolean(process.env.ALERT_WEBHOOK_URL || (process.env.ALERT_TELEGRAM_BOT_TOKEN && process.env.ALERT_TELEGRAM_CHAT_ID))
}

export async function notify(event: string, detail: string): Promise<void> {
  if (!alertConfigured()) return
  const now = Date.now()
  if (now - (lastSent.get(event) ?? 0) < THROTTLE_MS) return // suppress a burst of the same event
  lastSent.set(event, now)
  const text = `[PulseTrade] ${event}: ${detail}`
  const tasks: Promise<unknown>[] = []
  const webhook = process.env.ALERT_WEBHOOK_URL
  if (webhook)
    tasks.push(
      fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, detail, text, ts: now }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {}),
    )
  const tgToken = process.env.ALERT_TELEGRAM_BOT_TOKEN
  const tgChat = process.env.ALERT_TELEGRAM_CHAT_ID
  if (tgToken && tgChat)
    tasks.push(
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {}),
    )
  await Promise.all(tasks).catch(() => {})
}

/** Fire-and-forget wrapper for engine hot paths that must not await the network. */
export function notifyAsync(event: string, detail: string): void {
  void notify(event, detail).catch(() => {})
}

/** Test seam — reset the throttle so a test isn't suppressed by a prior one. */
export function __resetThrottle(): void {
  lastSent.clear()
}
