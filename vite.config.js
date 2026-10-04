import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// Loading it validates config/outputs.json: a mistake fails the build, not the page (#65).
import './src/utils/outputs.js'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
})
