import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The dashboard only talks to the Spring Boot API; in dev, Vite forwards /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
})
