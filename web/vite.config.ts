import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.NODEPILOT_BACKEND ?? 'http://127.0.0.1:7780'
// To serve the panel under a sub-path (e.g. /nodepilot/ behind a reverse proxy), build with NODEPILOT_BASE_PATH=/nodepilot/.
// The proxy must strip the prefix: the backend always serves from the root.
const base = process.env.NODEPILOT_BASE_PATH ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
})
