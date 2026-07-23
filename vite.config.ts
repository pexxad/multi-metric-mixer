import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/artifacts': 'http://localhost:3000',
    },
  },
})
