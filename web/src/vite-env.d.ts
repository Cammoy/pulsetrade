/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string
  /** Shared secret sent on mutating /api calls; must equal the engine's ENGINE_TOKEN. */
  readonly VITE_ENGINE_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
