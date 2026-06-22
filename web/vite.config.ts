import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Force a SINGLE React instance. In this workspace + wagmi setup, Vite's dep
  // pre-bundle can otherwise grab a SECOND React copy → "Invalid hook call / Cannot
  // read properties of null (reading 'useState')" at runtime. `dedupe` makes every
  // import resolve to the one hoisted copy, and pinning React in `optimizeDeps.include`
  // forces it to be pre-bundled ONCE and shared by the CJS deps (wagmi/react-query),
  // which keeps the optimize hash stable across restarts (no more cache mixing).
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: { include: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
  server: {
    proxy: {
      // 127.0.0.1 (not 'localhost') to match the engine's IPv4 loopback bind —
      // 'localhost' can resolve to IPv6 ::1, which the engine doesn't listen on.
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Split only the self-contained leaf vendors (charting + React runtime)
        // so they cache-bust independently of the app and each other. The
        // wagmi/viem/reown/ox web3 stack is deliberately left in the default
        // vendor chunk — separating it produces a circular chunk (vendor↔web3)
        // that risks runtime init-order errors.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/[\\/]lightweight-charts[\\/]/.test(id)) return 'charts'
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
        },
      },
    },
  },
})
