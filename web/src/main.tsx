import React from 'react'
import ReactDOM from 'react-dom/client'
import { installApiAuth } from './api'
import { watchSystem } from './theme'
import App from './App'
import './index.css'

installApiAuth() // attach the engine token to mutating /api calls (no-op if unset)
watchSystem() // follow OS light/dark changes while the theme is set to 'system'

// Wallet connect is a self-contained module store (src/wallet.ts) read via
// useSyncExternalStore — no provider wrapper needed (dropped wagmi + react-query).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
