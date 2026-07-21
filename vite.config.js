import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The `server` block only affects `vite dev` (ignored by `vite build`).
// In Docker, /api is proxied to the `api` service; VITE_API_TARGET lets you
// point it elsewhere (e.g. http://localhost:3001) when running outside Docker.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': process.env.VITE_API_TARGET || 'http://api:3001',
    },
  },
})
