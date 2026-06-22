// WS broadcast indirection. The engine wires the real emitter once at startup
// (setBroadcast); every other module imports the stable `broadcast` wrapper and
// calls it. Living here — not in engine.ts — lets the vault module emit withdrawal
// frames without a back-import into the money-path file (which would form a cycle).

export type Broadcast = (msg: object) => void

let emit: Broadcast = () => {}

/** Wire the real WS emitter (called once from startEngine). */
export const setBroadcast = (b: Broadcast): void => {
  emit = b
}

/** Stable wrapper — always dispatches to the currently-wired emitter. */
export const broadcast: Broadcast = (msg) => emit(msg)
